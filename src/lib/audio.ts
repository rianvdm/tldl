/**
 * Audio utilities for handling large audio files
 * Provides ID3 tag measurement and chunk range calculation for
 * splitting large files for transcription (MP3 frames: see mp3.ts)
 */

// ============================================================================
// Constants
// ============================================================================

/**
 * Target chunk size for transcription (under 25MB Whisper limit)
 */
export const TARGET_CHUNK_SIZE_BYTES = 15 * 1024 * 1024; // 15MB

/**
 * Overlap between chunks to avoid losing words at boundaries
 * ~2 seconds at 128kbps = ~32KB
 */
export const CHUNK_OVERLAP_BYTES = 32 * 1024; // 32KB (~2 seconds at 128kbps)

/**
 * Maximum file size we'll attempt to transcribe (121 min at 256kbps = ~233MB)
 * Increased to 300MB safety limit for higher bitrate files
 */
export const MAX_TOTAL_SIZE_BYTES = 300 * 1024 * 1024; // 300MB safety limit

/**
 * Longest audio a single MP3, MP4/M4A or ADTS transcription chunk may cover.
 * The model's audio token budget scales with duration, so bytes alone are not
 * a safe cap. The `other` byte path (OGG, WAV) can't measure duration and
 * stays byte-capped.
 */
export const MAX_CHUNK_SECONDS = 15 * 60;

/**
 * Overlap between chunks in seconds of audio: cut on sample boundaries for
 * MP4/M4A, converted to bytes at the average byte rate for MP3 and ADTS.
 */
export const CHUNK_OVERLAP_SECONDS = 2;

/** Bytes fetched up front to sniff the container and, usually, locate `moov`. */
export const CONTAINER_PROBE_BYTES = 64 * 1024;

/** Largest `moov` box we will fetch and parse (an hour of AAC needs a few hundred KB). */
export const MAX_MOOV_BYTES = 32 * 1024 * 1024;

/** Samples separated by less than this many bytes are fetched as one range. */
export const RUN_COALESCE_GAP_BYTES = 1024 * 1024;

/**
 * Most an MP4 chunk's range fetches may total, as a multiple of the chunk
 * byte cap. Gaps between audio samples are fetched with them, so audio
 * interleaved with video would pull the video bytes into a 128 MB Worker.
 */
export const MAX_CHUNK_FETCH_FACTOR = 2;

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
// ID3
// ============================================================================

/**
 * Bytes taken by a leading ID3v2 tag (10-byte header plus body), or 0 when
 * `bytes` doesn't start with one. Podcast hosts add ID3 tags to MP3 and raw
 * AAC alike, so format sniffing starts after the tag. The result can exceed
 * `bytes.length` when only part of the tag was read.
 */
export function id3Length(bytes: Uint8Array): number {
    if (bytes.length < 10 || bytes[0] !== 0x49 || bytes[1] !== 0x44 || bytes[2] !== 0x33) {
        return 0;
    }
    // Tag body size: bytes 6-9, a syncsafe integer (7 bits per byte).
    const bodySize =
        ((bytes[6] & 0x7f) << 21) |
        ((bytes[7] & 0x7f) << 14) |
        ((bytes[8] & 0x7f) << 7) |
        (bytes[9] & 0x7f);
    return 10 + bodySize;
}

// ============================================================================
// Chunk Calculation
// ============================================================================

/**
 * Safety check: refuse absurdly large files before fetching any of them.
 * Every chunked transcription calls this, whatever the container.
 *
 * @throws Error when `totalBytes` exceeds MAX_TOTAL_SIZE_BYTES
 */
export function assertWithinTotalSizeLimit(totalBytes: number): void {
    if (totalBytes > MAX_TOTAL_SIZE_BYTES) {
        throw new Error(
            `Audio file too large: ${Math.round(totalBytes / 1024 / 1024)}MB exceeds ${Math.round(MAX_TOTAL_SIZE_BYTES / 1024 / 1024)}MB limit`
        );
    }
}

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
    assertWithinTotalSizeLimit(totalBytes);

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
 * @param whisperLimit - Upload limit (default 25MB, the API's). Production uses the default;
 *   tests lower it to force small fixtures onto the chunked path. The actual chunk size is
 *   controlled by TARGET_CHUNK_SIZE_BYTES (currently 15MB), which is intentionally smaller
 *   than this limit to stay clear of the transcription model's per-request audio budget.
 * @returns true if chunking is required
 */
export function requiresChunking(
    contentLength: number,
    whisperLimit: number = 25 * 1024 * 1024
): boolean {
    return contentLength > whisperLimit;
}
