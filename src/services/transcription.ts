/**
 * Transcription service supporting multiple providers (OpenAI, Groq)
 * Handles audio validation and transcription for podcast episodes
 * Supports chunked transcription for files over 25MB
 *
 * Provider switching is controlled via the TRANSCRIPTION_PROVIDER env var.
 * Groq's API is OpenAI-compatible, so both share the same code path
 * with different base URLs, model names, and API keys.
 */

import { AppError } from "../lib/errors";
import { ERROR_CODES, TIMEOUTS, AUDIO_LIMITS } from "../lib/constants";
import { withRetry, isTransientError, isRateLimitError, sleep } from "../lib/retry";
import {
    calculateChunkRanges,
    requiresChunking,
    estimateTranscriptionTime,
} from "../lib/audio";
import type { TranscriptionProvider } from "../types";

// Use centralized constant for Whisper size limit
const MAX_AUDIO_SIZE_BYTES = AUDIO_LIMITS.MAX_SIZE_BYTES;

/**
 * Size of audio header to prepend to non-first chunks.
 * This ensures Whisper can recognize the audio format.
 * 512 bytes is enough to contain MP3/AAC headers and metadata.
 */
const AUDIO_HEADER_SIZE_BYTES = 512;

// ============================================================================
// MIME Type Handling
// ============================================================================

/** Map content-type to the file extension expected by the transcription API */
const MIME_TO_EXTENSION: Record<string, string> = {
    "audio/mpeg": "mp3",
    "audio/mp3": "mp3",
    "audio/mp4": "m4a",
    "audio/x-m4a": "m4a",
    "audio/aac": "m4a",
    "audio/wav": "wav",
    "audio/x-wav": "wav",
    "audio/webm": "webm",
    "audio/ogg": "ogg",
};

/** Map file extension to MIME type for the Blob constructor */
const EXTENSION_TO_MIME: Record<string, string> = {
    mp3: "audio/mpeg",
    m4a: "audio/mp4",
    wav: "audio/wav",
    webm: "audio/webm",
    ogg: "audio/ogg",
};

/**
 * Derive the correct file extension from a content-type header.
 * Falls back to "mp3" for unknown/generic types (most podcasts are MP3).
 */
export function extensionFromMime(contentType: string): string {
    // Strip parameters like "; charset=utf-8"
    const base = contentType.split(";")[0].trim().toLowerCase();
    return MIME_TO_EXTENSION[base] ?? "mp3";
}

/**
 * Get the correct MIME type for a file extension.
 * Used when constructing the Blob sent to the API.
 */
function mimeFromExtension(ext: string): string {
    return EXTENSION_TO_MIME[ext] ?? "audio/mpeg";
}

/**
 * Detect audio format from the actual binary content (magic bytes).
 * Much more reliable than trusting CDN content-type headers, which
 * often return application/octet-stream for M4A files.
 *
 * Falls back to the content-type header if magic bytes are unrecognized.
 */
export function detectAudioFormat(buffer: ArrayBuffer, contentType: string): string {
    const bytes = new Uint8Array(buffer, 0, Math.min(12, buffer.byteLength));

    if (bytes.length >= 4) {
        // MP3: ID3 tag header (ID3v2)
        if (bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) {
            return "mp3";
        }

        // MPEG audio sync word: 0xFF followed by 0xE0+ mask
        // Both MP3 and ADTS AAC use this sync pattern — the layer bits distinguish them:
        //   layer bits ((byte1 >> 1) & 0x03):
        //     00 = ADTS AAC (raw AAC stream, common in podcasts)
        //     01 = MPEG Layer III (MP3)
        //     10 = MPEG Layer II
        //     11 = MPEG Layer I
        if (bytes[0] === 0xFF && (bytes[1] & 0xE0) === 0xE0) {
            const layerBits = (bytes[1] >> 1) & 0x03;
            if (layerBits === 0x00) {
                return "m4a"; // ADTS AAC — use m4a as the closest supported format
            }
            return "mp3";
        }

        // M4A/MP4: ftyp box — bytes 4-7 are "ftyp" (0x66 0x74 0x79 0x70)
        if (bytes.length >= 8 &&
            bytes[4] === 0x66 && bytes[5] === 0x74 &&
            bytes[6] === 0x79 && bytes[7] === 0x70) {
            return "m4a";
        }

        // WAV: RIFF header
        if (bytes[0] === 0x52 && bytes[1] === 0x49 &&
            bytes[2] === 0x46 && bytes[3] === 0x46) {
            return "wav";
        }

        // OGG: OggS header
        if (bytes[0] === 0x4F && bytes[1] === 0x67 &&
            bytes[2] === 0x67 && bytes[3] === 0x53) {
            return "ogg";
        }

        // WebM/MKV: EBML header
        if (bytes[0] === 0x1A && bytes[1] === 0x45 &&
            bytes[2] === 0xDF && bytes[3] === 0xA3) {
            return "webm";
        }
    }

    // Fallback to content-type header
    return extensionFromMime(contentType);
}

// ============================================================================
// Provider Configuration
// ============================================================================

interface ProviderConfig {
    baseUrl: string;
    model: string;
    name: TranscriptionProvider;
}

const PROVIDER_CONFIGS: Record<TranscriptionProvider, ProviderConfig> = {
    openai: {
        baseUrl: "https://api.openai.com/v1/audio/transcriptions",
        model: "gpt-4o-mini-transcribe",
        name: "openai",
    },
    groq: {
        baseUrl: "https://api.groq.com/openai/v1/audio/transcriptions",
        model: "whisper-large-v3-turbo",
        name: "groq",
    },
};

/**
 * Resolve provider config from env var string.
 * Defaults to "openai" for backwards compatibility.
 */
export function getProviderConfig(provider?: string): ProviderConfig {
    if (provider === "groq") return PROVIDER_CONFIGS.groq;
    return PROVIDER_CONFIGS.openai;
}

export interface TranscriptionResult {
    text: string;
    source: TranscriptionProvider;
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
 * Call Whisper-compatible API to transcribe audio.
 * Works with both OpenAI and Groq (same API shape).
 * 
 * @param audioBuffer - Audio data as ArrayBuffer
 * @param apiKey - API key for the provider
 * @param provider - Provider config (OpenAI or Groq)
 * @returns Transcribed text
 * @throws AppError with TRANSCRIPTION_FAILED or RATE_LIMITED
 */
async function callWhisperApi(
    audioBuffer: ArrayBuffer,
    apiKey: string,
    provider: ProviderConfig = PROVIDER_CONFIGS.openai,
    contentType: string = "audio/mpeg",
): Promise<string> {
    // Detect format from actual bytes (magic bytes), falling back to content-type header
    const ext = detectAudioFormat(audioBuffer, contentType);
    const blobMime = mimeFromExtension(ext);

    // Log first 16 bytes as hex for debugging format detection
    const preview = new Uint8Array(audioBuffer, 0, Math.min(16, audioBuffer.byteLength));
    const hexBytes = Array.from(preview).map(b => b.toString(16).padStart(2, "0")).join(" ");

    console.log(
        JSON.stringify({
            event: "audio_format_detected",
            detectedExtension: ext,
            blobMime,
            headerContentType: contentType,
            bufferSizeBytes: audioBuffer.byteLength,
            firstBytesHex: hexBytes,
        })
    );

    const formData = new FormData();
    const audioBlob = new Blob([audioBuffer], { type: blobMime });
    formData.append("file", audioBlob, `audio.${ext}`);
    formData.append("model", provider.model);
    formData.append("response_format", "text");

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), TIMEOUTS.WHISPER_API_MS);

    const startTime = Date.now();
    console.log(
        JSON.stringify({
            event: "whisper_api_call_start",
            provider: provider.name,
            model: provider.model,
            audioSizeMB: Math.round(audioBuffer.byteLength / 1024 / 1024 * 100) / 100,
        })
    );

    let response: Response;
    try {
        response = await fetch(provider.baseUrl, {
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
                    provider: provider.name,
                    elapsedMs: elapsed,
                    timeoutMs: TIMEOUTS.WHISPER_API_MS,
                })
            );
            throw new AppError(
                ERROR_CODES.TRANSCRIPTION_FAILED,
                `${provider.name} Whisper API timed out after ${Math.round(elapsed / 1000)}s`,
            );
        }

        console.error(
            JSON.stringify({
                event: "whisper_api_network_error",
                provider: provider.name,
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
                provider: provider.name,
                status,
                elapsedMs: elapsed,
                error: errorText,
            })
        );
        throw new AppError(
            ERROR_CODES.TRANSCRIPTION_FAILED,
            `${provider.name} Whisper API error: ${errorText}`,
        );
    }

    console.log(
        JSON.stringify({
            event: "whisper_api_call_complete",
            provider: provider.name,
            elapsedMs: elapsed,
            elapsedSeconds: Math.round(elapsed / 1000),
        })
    );

    // Response format is plain text when response_format=text
    return await response.text();
}

/**
 * Options for configuring the transcription provider
 */
export interface TranscribeOptions {
    /** API key for the transcription provider */
    apiKey: string;
    /** Provider name: "openai" or "groq" (defaults to "openai") */
    provider?: string;
    /** Optional callback for progress updates (chunk number, total chunks) */
    onProgress?: (currentChunk: number, totalChunks: number) => void;
}

/**
 * Transcribe audio from URL using a Whisper-compatible API.
 * Supports OpenAI and Groq as providers (controlled via options.provider).
 * Automatically handles large files by chunking them into smaller segments.
 * 
 * @param audioUrl - URL of the audio file to transcribe
 * @param options - Transcription options (apiKey, provider, onProgress)
 * @returns Transcription result with text and source
 * @throws AppError with AUDIO_UNAVAILABLE, TRANSCRIPTION_FAILED, or RATE_LIMITED
 * 
 * @example
 * ```typescript
 * // Using OpenAI (default)
 * const result = await transcribeAudio("https://example.com/podcast.mp3", {
 *   apiKey: env.OPENAI_API_KEY,
 * });
 *
 * // Using Groq
 * const result = await transcribeAudio("https://example.com/podcast.mp3", {
 *   apiKey: env.GROQ_API_KEY,
 *   provider: "groq",
 * });
 * ```
 */
export async function transcribeAudio(
    audioUrl: string,
    options: TranscribeOptions | string,
    onProgress?: (currentChunk: number, totalChunks: number) => void,
): Promise<TranscriptionResult> {
    // Support legacy call signature: transcribeAudio(url, apiKey, onProgress?)
    const opts: TranscribeOptions = typeof options === "string"
        ? { apiKey: options, provider: "openai", onProgress }
        : options;

    const providerConfig = getProviderConfig(opts.provider);
    const progressCallback = opts.onProgress || onProgress;

    console.log(
        JSON.stringify({
            event: "transcription_start",
            provider: providerConfig.name,
            model: providerConfig.model,
        })
    );

    // Step 1: Validate audio URL and check size
    const validation = await validateAudioUrl(audioUrl);

    // Step 2: Route based on file size
    if (requiresChunking(validation.contentLength)) {
        // Large file - use chunked transcription
        console.log(
            JSON.stringify({
                event: "chunked_transcription_start",
                provider: providerConfig.name,
                contentLength: validation.contentLength,
                contentLengthMB: Math.round(validation.contentLength / 1024 / 1024),
            })
        );
        return await transcribeWithChunking(
            audioUrl,
            validation.contentLength,
            opts.apiKey,
            providerConfig,
            progressCallback,
            validation.contentType,
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
            opts.apiKey,
            providerConfig,
            progressCallback,
            validation.contentType,
        );
    }

    // Step 3: Call transcription API with retry for transient errors
    const text = await withRetry(
        () => callWhisperApi(audioBuffer, opts.apiKey, providerConfig, validation.contentType),
        {
            maxRetries: 3,
            baseDelayMs: 1000,
            shouldRetry: isTransientError,
        },
    );

    return {
        text: text.trim(),
        source: providerConfig.name,
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
 * @param apiKey - API key for the transcription provider
 * @param provider - Provider config (OpenAI or Groq)
 * @param onProgress - Optional progress callback
 * @returns Combined transcription result
 */
async function transcribeWithChunking(
    audioUrl: string,
    contentLength: number,
    apiKey: string,
    provider: ProviderConfig,
    onProgress?: (currentChunk: number, totalChunks: number) => void,
    contentType: string = "audio/mpeg",
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
            // Add delay between chunks to avoid CDN rate limits (skip first chunk)
            if (i > 0) {
                await sleep(TIMEOUTS.CHUNK_FETCH_DELAY_MS);
            }

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
                () => callWhisperApi(bufferToTranscribe, apiKey, provider, contentType),
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
        source: provider.name,
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
    // Wrap with retry logic for rate limit handling
    return withRetry(
        () => fetchAudioChunkOnce(audioUrl, startByte, endByte),
        {
            maxRetries: 3,
            baseDelayMs: 2000, // Longer delay for CDN rate limits
            shouldRetry: isRateLimitError,
        }
    );
}

/**
 * Single attempt to fetch an audio chunk.
 * Separated to enable retry wrapping.
 */
async function fetchAudioChunkOnce(
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

        // Check for rate limiting (429) specifically
        if (response.status === 429) {
            throw new Error(`CDN rate limited: HTTP 429`);
        }

        // Accept both 200 (full content) and 206 (partial content)
        if (!response.ok && response.status !== 206) {
            throw new AppError(
                ERROR_CODES.AUDIO_UNAVAILABLE,
                `Failed to fetch audio chunk: HTTP ${response.status}`,
            );
        }

        const chunkContentType = response.headers.get("content-type") || "unknown";
        const chunkContentLength = response.headers.get("content-length") || "unknown";
        console.log(
            JSON.stringify({
                event: "chunk_fetch_response",
                status: response.status,
                contentType: chunkContentType,
                contentLength: chunkContentLength,
                rangeRequested: `bytes=${startByte}-${endByte}`,
            })
        );

        return await response.arrayBuffer();
    } catch (error) {
        clearTimeout(timeoutId);

        if (error instanceof AppError) {
            throw error;
        }

        // Re-throw rate limit errors for retry handling
        if (error instanceof Error && error.message.includes("429")) {
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

