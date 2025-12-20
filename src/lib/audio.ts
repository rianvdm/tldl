/**
 * Audio utilities for handling large audio files
 * Provides MP3 frame detection and chunk range calculation for
 * splitting large files for transcription
 */

// ============================================================================
// Constants
// ============================================================================

/**
 * MP3 frame sync word - first 11 bits are all 1s
 * Frame header starts with 0xFF followed by 0xE0-0xFF
 */
const MP3_SYNC_BYTE_1 = 0xff;
const MP3_SYNC_MASK = 0xe0; // First 3 bits of second byte must be 111

/**
 * Target chunk size for transcription (under 25MB Whisper limit)
 */
export const TARGET_CHUNK_SIZE_BYTES = 20 * 1024 * 1024; // 20MB

/**
 * Overlap between chunks to avoid losing words at boundaries
 * ~2 seconds at 128kbps = ~32KB
 */
export const CHUNK_OVERLAP_BYTES = 32 * 1024; // 32KB (~2 seconds at 128kbps)

/**
 * Maximum file size we'll attempt to transcribe (80 min at 192kbps = ~115MB)
 */
export const MAX_TOTAL_SIZE_BYTES = 150 * 1024 * 1024; // 150MB safety limit

// ============================================================================
// Types
// ============================================================================

export interface AudioChunk {
    /** Starting byte position in the original file */
    startByte: number;
    /** Ending byte position (inclusive) */
    endByte: number;
    /** Whether this is the first chunk */
    isFirst: boolean;
    /** Whether this is the last chunk */
    isLast: boolean;
    /** Number of bytes that overlap with the previous chunk */
    overlapBytes: number;
}

// ============================================================================
// MP3 Frame Detection
// ============================================================================

/**
 * Find the nearest MP3 frame boundary at or after the given offset.
 * MP3 frames start with a sync word: 11 bits of 1s (0xFF followed by 0xE0+)
 * 
 * This ensures we don't cut audio mid-frame, which would cause decoding errors.
 * 
 * @param buffer - Audio data to search
 * @param startOffset - Position to start searching from
 * @param maxSearch - Maximum bytes to search (default 4KB, covers ~10 frames)
 * @returns Byte offset of the frame boundary, or startOffset if not found
 */
export function findMp3FrameBoundary(
    buffer: Uint8Array,
    startOffset: number,
    maxSearch: number = 4096
): number {
    const endSearch = Math.min(startOffset + maxSearch, buffer.length - 1);

    for (let i = startOffset; i < endSearch; i++) {
        // Check for MP3 sync word
        if (buffer[i] === MP3_SYNC_BYTE_1 && i + 1 < buffer.length) {
            const secondByte = buffer[i + 1];
            // Verify it's a valid frame header (top 3 bits must be 111)
            if ((secondByte & MP3_SYNC_MASK) === MP3_SYNC_MASK) {
                // Additional validation: MPEG version bits (bits 4-3) shouldn't be 01
                const versionBits = (secondByte >> 3) & 0x03;
                if (versionBits !== 0x01) {
                    return i;
                }
            }
        }
    }

    // If no frame found, return the original offset
    // The decoder should still handle this reasonably
    return startOffset;
}

/**
 * Search backwards from a position to find an MP3 frame boundary.
 * Used when we need to ensure overlap starts at a clean frame.
 * 
 * @param buffer - Audio data to search
 * @param startOffset - Position to start searching backwards from
 * @param maxSearch - Maximum bytes to search backwards
 * @returns Byte offset of the frame boundary
 */
export function findMp3FrameBoundaryReverse(
    buffer: Uint8Array,
    startOffset: number,
    maxSearch: number = 4096
): number {
    const endSearch = Math.max(startOffset - maxSearch, 0);

    for (let i = startOffset; i >= endSearch; i--) {
        if (buffer[i] === MP3_SYNC_BYTE_1 && i + 1 < buffer.length) {
            const secondByte = buffer[i + 1];
            if ((secondByte & MP3_SYNC_MASK) === MP3_SYNC_MASK) {
                const versionBits = (secondByte >> 3) & 0x03;
                if (versionBits !== 0x01) {
                    return i;
                }
            }
        }
    }

    return startOffset;
}

// ============================================================================
// Chunk Calculation
// ============================================================================

/**
 * Calculate byte ranges for splitting a large audio file into chunks.
 * 
 * Each chunk except the first overlaps with the previous chunk by overlapBytes.
 * This overlap ensures words at chunk boundaries aren't lost during transcription.
 * 
 * @param totalBytes - Total size of the audio file
 * @param maxChunkBytes - Maximum size of each chunk (default 20MB)
 * @param overlapBytes - Bytes of overlap between chunks (default 32KB)
 * @returns Array of chunk definitions with byte ranges
 * 
 * @example
 * // 50MB file split into 3 chunks
 * const chunks = calculateChunkRanges(50 * 1024 * 1024);
 * // Returns:
 * // [
 * //   { startByte: 0, endByte: 20MB, isFirst: true, isLast: false, overlapBytes: 0 },
 * //   { startByte: 20MB-32KB, endByte: 40MB, isFirst: false, isLast: false, overlapBytes: 32KB },
 * //   { startByte: 40MB-32KB, endByte: 50MB, isFirst: false, isLast: true, overlapBytes: 32KB }
 * // ]
 */
export function calculateChunkRanges(
    totalBytes: number,
    maxChunkBytes: number = TARGET_CHUNK_SIZE_BYTES,
    overlapBytes: number = CHUNK_OVERLAP_BYTES
): AudioChunk[] {
    // Safety check: don't process absurdly large files
    if (totalBytes > MAX_TOTAL_SIZE_BYTES) {
        throw new Error(
            `Audio file too large: ${Math.round(totalBytes / 1024 / 1024)}MB exceeds ${Math.round(MAX_TOTAL_SIZE_BYTES / 1024 / 1024)}MB limit`
        );
    }

    // If file fits in one chunk, return single chunk
    if (totalBytes <= maxChunkBytes) {
        return [{
            startByte: 0,
            endByte: totalBytes - 1,
            isFirst: true,
            isLast: true,
            overlapBytes: 0,
        }];
    }

    const chunks: AudioChunk[] = [];
    let currentStart = 0;
    let chunkIndex = 0;

    while (currentStart < totalBytes) {
        const isFirst = chunkIndex === 0;
        const overlap = isFirst ? 0 : overlapBytes;

        // Calculate end position for this chunk
        // For non-first chunks, we start earlier due to overlap but still want
        // the chunk to be maxChunkBytes
        const contentBytes = maxChunkBytes;
        let endByte = currentStart + contentBytes - 1;

        // Don't exceed file size
        if (endByte >= totalBytes) {
            endByte = totalBytes - 1;
        }

        const isLast = endByte >= totalBytes - 1;

        chunks.push({
            startByte: currentStart,
            endByte,
            isFirst,
            isLast,
            overlapBytes: overlap,
        });

        if (isLast) {
            break;
        }

        // Next chunk starts at (current end - overlap) to create overlap
        // This means the new chunk will include the last `overlapBytes` of this chunk
        currentStart = endByte + 1 - overlapBytes;
        chunkIndex++;

        // Safety valve to prevent infinite loops
        if (chunkIndex > 100) {
            throw new Error("Too many chunks calculated - possible infinite loop");
        }
    }

    return chunks;
}

/**
 * Estimate transcription time for a chunked file.
 * 
 * @param totalBytes - Total file size in bytes
 * @param chunkCount - Number of chunks
 * @returns Estimated seconds to transcribe
 */
export function estimateTranscriptionTime(
    _totalBytes: number,
    chunkCount: number
): number {
    // Rough estimates based on observed Whisper API performance:
    // - ~30-60 seconds per 20MB chunk
    // - Plus overhead for HTTP requests, processing
    const baseSecondsPerChunk = 45;
    const overheadSeconds = 15;

    return chunkCount * baseSecondsPerChunk + overheadSeconds;
}

/**
 * Check if a file size requires chunking.
 * 
 * @param contentLength - File size in bytes
 * @param whisperLimit - Whisper API limit (default 25MB)
 * @returns true if chunking is required
 */
export function requiresChunking(
    contentLength: number,
    whisperLimit: number = 25 * 1024 * 1024
): boolean {
    return contentLength > whisperLimit;
}
