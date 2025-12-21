/**
 * Transcription service using OpenAI Whisper API
 * Handles audio validation and transcription for podcast episodes
 * Supports chunked transcription for files over 25MB
 */

import { AppError } from "../lib/errors";
import { ERROR_CODES, TIMEOUTS, AUDIO_LIMITS } from "../lib/constants";
import { withRetry, isTransientError } from "../lib/retry";
import {
    calculateChunkRanges,
    requiresChunking,
    estimateTranscriptionTime,
} from "../lib/audio";

// Use centralized constant for Whisper size limit
const MAX_AUDIO_SIZE_BYTES = AUDIO_LIMITS.MAX_SIZE_BYTES;

/**
 * Size of audio header to prepend to non-first chunks.
 * This ensures Whisper can recognize the audio format.
 * 512 bytes is enough to contain MP3/AAC headers and metadata.
 */
const AUDIO_HEADER_SIZE_BYTES = 512;

export interface TranscriptionResult {
    text: string;
    source: "openai";
}

export interface AudioValidation {
    contentLength: number;
    contentType: string;
}

/**
 * Validate audio URL accessibility and size via HEAD request.
 * 
 * @param audioUrl - URL of the audio file to validate
 * @returns Object with content length and type
 * @throws AppError with AUDIO_UNAVAILABLE if audio cannot be accessed
 */
export async function validateAudioUrl(audioUrl: string): Promise<AudioValidation> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), TIMEOUTS.AUDIO_HEAD_MS);

    try {
        const response = await fetch(audioUrl, {
            method: "HEAD",
            signal: controller.signal,
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
            throw new AppError(
                ERROR_CODES.AUDIO_UNAVAILABLE,
                `Audio unavailable: HTTP ${response.status}`,
            );
        }

        const contentLength = parseInt(response.headers.get("content-length") || "0", 10);
        const contentType = response.headers.get("content-type") || "unknown";

        // Validate content type is audio (also accept binary/octet-stream and application/octet-stream)
        const isAudio = contentType.startsWith("audio/") ||
            contentType === "binary/octet-stream" ||
            contentType === "application/octet-stream";
        if (!isAudio) {
            throw new AppError(
                ERROR_CODES.AUDIO_UNAVAILABLE,
                `Invalid content type: expected audio/*, got ${contentType}`,
            );
        }

        return { contentLength, contentType };
    } catch (error) {
        clearTimeout(timeoutId);

        if (error instanceof AppError) {
            throw error;
        }

        // Handle abort/timeout
        if (error instanceof Error && error.name === "AbortError") {
            throw new AppError(
                ERROR_CODES.AUDIO_UNAVAILABLE,
                "Audio validation timed out",
            );
        }

        throw new AppError(
            ERROR_CODES.AUDIO_UNAVAILABLE,
            "Failed to validate audio URL",
            error instanceof Error ? error : undefined,
        );
    }
}

/**
 * Fetch audio file as ArrayBuffer.
 * 
 * @param audioUrl - URL of the audio file
 * @returns Audio data as ArrayBuffer
 * @throws AppError with AUDIO_UNAVAILABLE on failure
 */
async function fetchAudio(audioUrl: string): Promise<ArrayBuffer> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), TIMEOUTS.AUDIO_FETCH_MS);

    try {
        const response = await fetch(audioUrl, {
            signal: controller.signal,
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
            throw new AppError(
                ERROR_CODES.AUDIO_UNAVAILABLE,
                `Failed to fetch audio: HTTP ${response.status}`,
            );
        }

        return await response.arrayBuffer();
    } catch (error) {
        clearTimeout(timeoutId);

        if (error instanceof AppError) {
            throw error;
        }

        if (error instanceof Error && error.name === "AbortError") {
            throw new AppError(
                ERROR_CODES.AUDIO_UNAVAILABLE,
                "Audio fetch timed out",
            );
        }

        throw new AppError(
            ERROR_CODES.AUDIO_UNAVAILABLE,
            "Failed to fetch audio",
            error instanceof Error ? error : undefined,
        );
    }
}

/**
 * Call OpenAI Whisper API to transcribe audio.
 * 
 * @param audioBuffer - Audio data as ArrayBuffer
 * @param apiKey - OpenAI API key
 * @returns Transcribed text
 * @throws AppError with TRANSCRIPTION_FAILED or RATE_LIMITED
 */
async function callWhisperApi(
    audioBuffer: ArrayBuffer,
    apiKey: string,
): Promise<string> {
    // Create form data with audio file
    const formData = new FormData();
    const audioBlob = new Blob([audioBuffer], { type: "audio/mpeg" });
    formData.append("file", audioBlob, "audio.mp3");
    formData.append("model", "whisper-1");
    formData.append("response_format", "text");

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), TIMEOUTS.WHISPER_API_MS);

    const startTime = Date.now();
    console.log(
        JSON.stringify({
            event: "whisper_api_call_start",
            audioSizeMB: Math.round(audioBuffer.byteLength / 1024 / 1024 * 100) / 100,
        })
    );

    let response: Response;
    try {
        response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
            method: "POST",
            headers: {
                Authorization: `Bearer ${apiKey}`,
            },
            body: formData,
            signal: controller.signal,
        });
    } catch (error) {
        clearTimeout(timeoutId);
        const elapsed = Date.now() - startTime;

        if (error instanceof Error && error.name === "AbortError") {
            console.error(
                JSON.stringify({
                    event: "whisper_api_timeout",
                    elapsedMs: elapsed,
                    timeoutMs: TIMEOUTS.WHISPER_API_MS,
                })
            );
            throw new AppError(
                ERROR_CODES.TRANSCRIPTION_FAILED,
                `Whisper API timed out after ${Math.round(elapsed / 1000)}s`,
            );
        }

        console.error(
            JSON.stringify({
                event: "whisper_api_network_error",
                elapsedMs: elapsed,
                error: error instanceof Error ? error.message : "Unknown error",
            })
        );
        throw error;
    }

    clearTimeout(timeoutId);
    const elapsed = Date.now() - startTime;

    if (!response.ok) {
        const status = response.status;

        if (status === 429) {
            throw new Error(`Rate limited: HTTP 429`);
        }

        if (status >= 500) {
            throw new Error(`Server error: HTTP ${status}`);
        }

        // Non-retryable error
        const errorText = await response.text().catch(() => "Unknown error");
        console.error(
            JSON.stringify({
                event: "whisper_api_error",
                status,
                elapsedMs: elapsed,
                error: errorText,
            })
        );
        throw new AppError(
            ERROR_CODES.TRANSCRIPTION_FAILED,
            `Whisper API error: ${errorText}`,
        );
    }

    console.log(
        JSON.stringify({
            event: "whisper_api_call_complete",
            elapsedMs: elapsed,
            elapsedSeconds: Math.round(elapsed / 1000),
        })
    );

    // Response format is plain text when response_format=text
    return await response.text();
}

/**
 * Transcribe audio from URL using OpenAI Whisper API.
 * Automatically handles large files by chunking them into smaller segments.
 * 
 * @param audioUrl - URL of the audio file to transcribe
 * @param openaiApiKey - OpenAI API key
 * @param onProgress - Optional callback for progress updates (chunk number, total chunks)
 * @returns Transcription result with text and source
 * @throws AppError with AUDIO_UNAVAILABLE, TRANSCRIPTION_FAILED, or RATE_LIMITED
 * 
 * @example
 * ```typescript
 * const result = await transcribeAudio(
 *   "https://example.com/podcast.mp3",
 *   process.env.OPENAI_API_KEY,
 *   (current, total) => console.log(`Processing chunk ${current}/${total}`)
 * );
 * console.log(result.text);
 * ```
 */
export async function transcribeAudio(
    audioUrl: string,
    openaiApiKey: string,
    onProgress?: (currentChunk: number, totalChunks: number) => void,
): Promise<TranscriptionResult> {
    // Step 1: Validate audio URL and check size
    const validation = await validateAudioUrl(audioUrl);

    // Step 2: Route based on file size
    if (requiresChunking(validation.contentLength)) {
        // Large file - use chunked transcription
        console.log(
            JSON.stringify({
                event: "chunked_transcription_start",
                contentLength: validation.contentLength,
                contentLengthMB: Math.round(validation.contentLength / 1024 / 1024),
            })
        );
        return await transcribeWithChunking(
            audioUrl,
            validation.contentLength,
            openaiApiKey,
            onProgress
        );
    }

    // Small file - fetch and transcribe directly
    const audioBuffer = await fetchAudio(audioUrl);

    // Double-check actual size (in case Content-Length was inaccurate)
    if (audioBuffer.byteLength > MAX_AUDIO_SIZE_BYTES) {
        // If it's bigger than expected, fall back to chunking
        console.log(
            JSON.stringify({
                event: "size_mismatch_chunking",
                expected: validation.contentLength,
                actual: audioBuffer.byteLength,
            })
        );
        return await transcribeWithChunking(
            audioUrl,
            audioBuffer.byteLength,
            openaiApiKey,
            onProgress
        );
    }

    // Step 3: Call Whisper API with retry for transient errors
    const text = await withRetry(
        () => callWhisperApi(audioBuffer, openaiApiKey),
        {
            maxRetries: 3,
            baseDelayMs: 1000,
            shouldRetry: isTransientError,
        },
    );

    return {
        text: text.trim(),
        source: "openai",
    };
}

// ============================================================================
// Chunked Transcription
// ============================================================================

/**
 * Transcribe a large audio file by splitting it into chunks.
 * 
 * Uses HTTP Range requests to fetch audio in segments, transcribes each
 * independently, and stitches the results together.
 * 
 * @param audioUrl - URL of the audio file
 * @param contentLength - Total file size in bytes
 * @param openaiApiKey - OpenAI API key
 * @param onProgress - Optional progress callback
 * @returns Combined transcription result
 */
async function transcribeWithChunking(
    audioUrl: string,
    contentLength: number,
    openaiApiKey: string,
    onProgress?: (currentChunk: number, totalChunks: number) => void,
): Promise<TranscriptionResult> {
    // Calculate chunk ranges
    const chunks = calculateChunkRanges(contentLength);
    const totalChunks = chunks.length;

    console.log(
        JSON.stringify({
            event: "chunking_plan",
            totalChunks,
            contentLengthMB: Math.round(contentLength / 1024 / 1024),
            estimatedSeconds: estimateTranscriptionTime(contentLength, totalChunks),
        })
    );

    // Fetch audio header (first 512 bytes) to prepend to non-first chunks
    // This ensures Whisper can recognize the audio format for all chunks
    let audioHeader: ArrayBuffer | null = null;
    if (totalChunks > 1) {
        console.log(
            JSON.stringify({
                event: "fetching_audio_header",
                headerSizeBytes: AUDIO_HEADER_SIZE_BYTES,
            })
        );
        audioHeader = await fetchAudioChunk(audioUrl, 0, AUDIO_HEADER_SIZE_BYTES - 1);
    }

    // Process chunks sequentially to manage memory
    const transcriptions: ChunkTranscription[] = [];

    for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];

        // Report progress
        onProgress?.(i + 1, totalChunks);

        console.log(
            JSON.stringify({
                event: "chunk_processing",
                chunkIndex: i + 1,
                totalChunks,
                startByte: chunk.startByte,
                endByte: chunk.endByte,
                sizeMB: Math.round((chunk.endByte - chunk.startByte + 1) / 1024 / 1024),
            })
        );

        try {
            // Fetch this chunk via Range request
            const chunkBuffer = await fetchAudioChunk(
                audioUrl,
                chunk.startByte,
                chunk.endByte
            );

            // For non-first chunks, prepend the audio header so Whisper can recognize the format
            let bufferToTranscribe: ArrayBuffer;
            if (!chunk.isFirst && audioHeader) {
                // Concatenate header + chunk data
                const combined = new Uint8Array(audioHeader.byteLength + chunkBuffer.byteLength);
                combined.set(new Uint8Array(audioHeader), 0);
                combined.set(new Uint8Array(chunkBuffer), audioHeader.byteLength);
                bufferToTranscribe = combined.buffer;

                console.log(
                    JSON.stringify({
                        event: "header_prepended",
                        chunkIndex: i + 1,
                        headerBytes: audioHeader.byteLength,
                        originalChunkBytes: chunkBuffer.byteLength,
                        totalBytes: bufferToTranscribe.byteLength,
                    })
                );
            } else {
                bufferToTranscribe = chunkBuffer;
            }

            // Transcribe the chunk
            const text = await withRetry(
                () => callWhisperApi(bufferToTranscribe, openaiApiKey),
                {
                    maxRetries: 3,
                    baseDelayMs: 1000,
                    shouldRetry: isTransientError,
                },
            );

            transcriptions.push({
                text: text.trim(),
                isFirst: chunk.isFirst,
                isLast: chunk.isLast,
                overlapBytes: chunk.overlapBytes,
            });

            console.log(
                JSON.stringify({
                    event: "chunk_completed",
                    chunkIndex: i + 1,
                    totalChunks,
                    textLength: text.length,
                })
            );
        } catch (error) {
            // Log the error with context
            console.error(
                JSON.stringify({
                    event: "chunk_failed",
                    chunkIndex: i + 1,
                    totalChunks,
                    error: error instanceof Error ? error.message : "Unknown error",
                })
            );

            // Re-throw with context
            if (error instanceof AppError) {
                throw error;
            }
            throw new AppError(
                ERROR_CODES.TRANSCRIPTION_FAILED,
                `Failed to transcribe chunk ${i + 1}/${totalChunks}: ${error instanceof Error ? error.message : "Unknown error"}`,
                error instanceof Error ? error : undefined
            );
        }
    }

    // Stitch transcriptions together
    const combinedText = stitchTranscripts(transcriptions);

    console.log(
        JSON.stringify({
            event: "chunked_transcription_complete",
            totalChunks,
            combinedTextLength: combinedText.length,
        })
    );

    return {
        text: combinedText,
        source: "openai",
    };
}

/**
 * Represents a transcription from a single chunk
 */
interface ChunkTranscription {
    text: string;
    isFirst: boolean;
    isLast: boolean;
    overlapBytes: number;
}

/**
 * Fetch a specific byte range of an audio file.
 * 
 * @param audioUrl - URL of the audio file
 * @param startByte - First byte to fetch (inclusive)
 * @param endByte - Last byte to fetch (inclusive)
 * @returns Audio chunk as ArrayBuffer
 * @throws AppError with AUDIO_UNAVAILABLE on failure
 */
async function fetchAudioChunk(
    audioUrl: string,
    startByte: number,
    endByte: number,
): Promise<ArrayBuffer> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), TIMEOUTS.CHUNK_FETCH_MS);

    try {
        const response = await fetch(audioUrl, {
            headers: {
                Range: `bytes=${startByte}-${endByte}`,
            },
            signal: controller.signal,
        });

        clearTimeout(timeoutId);

        // Accept both 200 (full content) and 206 (partial content)
        if (!response.ok && response.status !== 206) {
            throw new AppError(
                ERROR_CODES.AUDIO_UNAVAILABLE,
                `Failed to fetch audio chunk: HTTP ${response.status}`,
            );
        }

        return await response.arrayBuffer();
    } catch (error) {
        clearTimeout(timeoutId);

        if (error instanceof AppError) {
            throw error;
        }

        if (error instanceof Error && error.name === "AbortError") {
            throw new AppError(
                ERROR_CODES.AUDIO_UNAVAILABLE,
                "Audio chunk fetch timed out",
            );
        }

        throw new AppError(
            ERROR_CODES.AUDIO_UNAVAILABLE,
            "Failed to fetch audio chunk",
            error instanceof Error ? error : undefined,
        );
    }
}

/**
 * Stitch multiple chunk transcriptions into a single coherent transcript.
 * 
 * Handles overlap by identifying and removing duplicate text at chunk boundaries.
 * Uses a simple approach: look for repeated phrases at the end of one chunk
 * and the beginning of the next.
 * 
 * @param chunks - Array of transcription results from each chunk
 * @returns Combined transcript text
 */
function stitchTranscripts(chunks: ChunkTranscription[]): string {
    if (chunks.length === 0) {
        return "";
    }

    if (chunks.length === 1) {
        return chunks[0].text;
    }

    const result: string[] = [];

    for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];

        if (chunk.isFirst) {
            // First chunk: use entire text
            result.push(chunk.text);
        } else {
            // Subsequent chunks: try to remove overlapping text
            const previousText = result[result.length - 1];
            const currentText = chunk.text;

            // Find overlap by looking for common ending in previous and beginning in current
            const deduplicatedText = removeOverlapFromStart(previousText, currentText);
            result.push(deduplicatedText);
        }
    }

    // Join with spaces, cleaning up any double spaces
    return result.join(" ").replace(/\s+/g, " ").trim();
}

/**
 * Remove overlapping text from the start of the current chunk.
 * 
 * Looks for phrases from the end of the previous text that appear
 * at the start of the current text, and removes them.
 * 
 * @param previousText - Text from the previous chunk
 * @param currentText - Text from the current chunk  
 * @returns currentText with overlapping prefix removed
 */
function removeOverlapFromStart(previousText: string, currentText: string): string {
    // Get the last ~50 words from previous text as potential overlap
    const previousWords = previousText.split(/\s+/);
    const overlapWindow = Math.min(50, previousWords.length);

    // Look for this overlap at the start of current text
    const currentWords = currentText.split(/\s+/);

    // Try decreasing window sizes to find the overlap
    for (let windowSize = overlapWindow; windowSize >= 3; windowSize--) {
        const searchPhrase = previousWords.slice(-windowSize).join(" ").toLowerCase();
        const currentStart = currentWords.slice(0, windowSize).join(" ").toLowerCase();

        if (searchPhrase === currentStart) {
            // Found overlap - remove these words from current
            return currentWords.slice(windowSize).join(" ");
        }
    }

    // No exact overlap found - try fuzzy matching on sentence boundaries
    // Look for the last sentence of previous in the start of current
    const lastSentenceMatch = previousText.match(/[.!?]\s*([^.!?]+)$/);
    if (lastSentenceMatch) {
        const lastSentence = lastSentenceMatch[1].toLowerCase().trim();
        if (lastSentence.length > 20) {
            const currentLower = currentText.toLowerCase();
            const overlapIndex = currentLower.indexOf(lastSentence);
            if (overlapIndex >= 0 && overlapIndex < 200) {
                // Found the last sentence repeated - skip past it
                return currentText.slice(overlapIndex + lastSentence.length).trim();
            }
        }
    }

    // No overlap detected - return as-is
    return currentText;
}

