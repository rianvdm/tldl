/**
 * Transcription service using OpenAI gpt-4o-mini-transcribe.
 * Handles audio validation and transcription for podcast episodes.
 * Supports chunked transcription for files over 25MB.
 * Automatically falls back to whisper-1 for files gpt-4o-mini-transcribe rejects.
 */

import { AppError } from "../lib/errors";
import { ERROR_CODES, TIMEOUTS, AUDIO_LIMITS, AUDIO_USER_AGENT } from "../lib/constants";
import { withRetry, isTransientError, isRateLimitError, sleep } from "../lib/retry";
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
    const fullBytes = new Uint8Array(buffer);

    if (fullBytes.length < 4) {
        return extensionFromMime(contentType);
    }

    let offset = 0;

    // ID3v2 tag: skip past it to find the actual audio frames.
    // ID3 tags are codec-agnostic — podcast hosts commonly add them to AAC files.
    if (fullBytes[0] === 0x49 && fullBytes[1] === 0x44 && fullBytes[2] === 0x33) {
        if (fullBytes.length >= 10) {
            // Parse ID3v2 tag size (bytes 6-9, syncsafe integer — each byte uses 7 bits)
            const size =
                ((fullBytes[6] & 0x7F) << 21) |
                ((fullBytes[7] & 0x7F) << 14) |
                ((fullBytes[8] & 0x7F) << 7) |
                (fullBytes[9] & 0x7F);
            offset = 10 + size; // 10-byte header + tag body

            console.log(
                JSON.stringify({
                    event: "id3_tag_parsed",
                    id3Version: `2.${fullBytes[3]}`,
                    tagBodySize: size,
                    audioStartOffset: offset,
                })
            );
        }

        // If we can't read past the ID3 tag, fall back to mp3 (most common with ID3)
        if (offset + 2 > fullBytes.length) {
            return "mp3";
        }
    }

    const bytes = fullBytes.subarray(offset, offset + 12);

    // MPEG audio sync word: 0xFF followed by 0xE0+ mask
    // Both MP3 and ADTS AAC use this sync pattern — the layer bits distinguish them:
    //   layer bits ((byte1 >> 1) & 0x03):
    //     00 = ADTS AAC (raw AAC stream, common in podcasts)
    //     01 = MPEG Layer III (MP3)
    //     10 = MPEG Layer II
    //     11 = MPEG Layer I
    if (bytes.length >= 2 && bytes[0] === 0xFF && (bytes[1] & 0xE0) === 0xE0) {
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

    // Fallback to content-type header
    return extensionFromMime(contentType);
}

// ============================================================================
// Provider Configuration
// ============================================================================

interface ProviderConfig {
    baseUrl: string;
    model: string;
    name: "openai";
}

const PROVIDER_CONFIGS = {
    openai: {
        baseUrl: "https://api.openai.com/v1/audio/transcriptions",
        model: "gpt-4o-mini-transcribe",
        name: "openai" as const,
    },
};

/**
 * Returns the OpenAI provider config.
 * Kept for backwards compatibility with call sites that pass an env var string.
 */
export function getProviderConfig(_provider?: string): ProviderConfig {
    return PROVIDER_CONFIGS.openai;
}

export interface TranscriptionResult {
    text: string;
    source: "openai";
    model: string;
}

export interface AudioValidation {
    contentLength: number;
    contentType: string;
}

/**
 * Resolve redirects to get the final audio URL.
 * Many podcast CDNs (e.g. Substack) serve audio via a redirect to a different CDN
 * (e.g. CloudFront). By resolving the redirect first, we can fetch directly from
 * the final CDN and avoid rate limiting on the origin.
 */
export async function resolveAudioUrl(audioUrl: string): Promise<string> {
    try {
        const response = await fetch(audioUrl, {
            method: "HEAD",
            headers: { "User-Agent": AUDIO_USER_AGENT },
            redirect: "manual",
        });

        if (response.status >= 300 && response.status < 400) {
            const location = response.headers.get("Location");
            if (location) {
                console.log(
                    JSON.stringify({
                        event: "audio_url_redirect_resolved",
                        originalHost: new URL(audioUrl).hostname,
                        resolvedHost: new URL(location).hostname,
                    })
                );
                return location;
            }
        }
    } catch {
        // If redirect resolution fails, fall back to original URL
    }
    return audioUrl;
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
            headers: { "User-Agent": AUDIO_USER_AGENT },
            signal: controller.signal,
        });

        clearTimeout(timeoutId);

        if (response.status === 429) {
            const retryAfter = parseInt(response.headers.get("Retry-After") || "0", 10);
            throw new AppError(
                ERROR_CODES.RATE_LIMITED,
                `Audio rate limited: HTTP 429${retryAfter ? ` (retry-after: ${retryAfter}s)` : ""}`,
            );
        }

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
            headers: { "User-Agent": AUDIO_USER_AGENT },
            signal: controller.signal,
        });

        clearTimeout(timeoutId);

        if (response.status === 429) {
            const retryAfter = parseInt(response.headers.get("Retry-After") || "0", 10);
            throw new AppError(
                ERROR_CODES.RATE_LIMITED,
                `Audio rate limited: HTTP 429${retryAfter ? ` (retry-after: ${retryAfter}s)` : ""}`,
            );
        }

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
 * Call OpenAI transcription API.
 * Uses gpt-4o-mini-transcribe as primary model with automatic whisper-1 fallback.
 * 
 * @param audioBuffer - Audio data as ArrayBuffer
 * @param apiKey - OpenAI API key
 * @param provider - Provider config
 * @returns Transcribed text and model used
 * @throws AppError with TRANSCRIPTION_FAILED or RATE_LIMITED
 */
async function callWhisperApi(
    audioBuffer: ArrayBuffer,
    apiKey: string,
    provider: ProviderConfig = PROVIDER_CONFIGS.openai,
    contentType: string = "audio/mpeg",
): Promise<{ text: string; model: string }> {
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

        // Fallback: if gpt-4o-mini-transcribe rejects the file (corrupted/unsupported or input too large), retry with whisper-1
        const isCorruptedError = errorText.includes("corrupted or unsupported");
        const isInputTooLarge = errorText.includes("input_too_large") || errorText.includes("too large for this model");
        const isGpt4oModel = provider.model === "gpt-4o-mini-transcribe";
        if (status === 400 && (isCorruptedError || isInputTooLarge) && isGpt4oModel) {
            const reason = isInputTooLarge
                ? "gpt-4o-mini-transcribe chunk too large, falling back to whisper-1"
                : "gpt-4o-mini-transcribe rejected file, falling back to whisper-1";
            console.log(
                JSON.stringify({
                    event: "whisper_fallback_start",
                    reason,
                    originalModel: provider.model,
                    fallbackModel: "whisper-1",
                })
            );

            // Fallback to whisper-1 with retry for transient errors (5xx, 429).
            // Always uses the OpenAI base URL — whisper-1 is an OpenAI model.
            const fallbackStart = Date.now();
            const attemptWhisper1 = async (): Promise<string> => {
                const fallbackFormData = new FormData();
                fallbackFormData.append("file", new Blob([audioBuffer], { type: blobMime }), `audio.${ext}`);
                fallbackFormData.append("model", "whisper-1");
                fallbackFormData.append("response_format", "text");

                const fallbackController = new AbortController();
                const fallbackTimeoutId = setTimeout(() => fallbackController.abort(), TIMEOUTS.WHISPER_API_MS);

                let fallbackResponse: Response;
                try {
                    fallbackResponse = await fetch(PROVIDER_CONFIGS.openai.baseUrl, {
                        method: "POST",
                        headers: { Authorization: `Bearer ${apiKey}` },
                        body: fallbackFormData,
                        signal: fallbackController.signal,
                    });
                } catch (err) {
                    clearTimeout(fallbackTimeoutId);
                    throw err;
                }
                clearTimeout(fallbackTimeoutId);

                if (fallbackResponse.status === 429) {
                    throw new Error("Rate limited: HTTP 429");
                }
                if (fallbackResponse.status >= 500) {
                    throw new Error(`Server error: HTTP ${fallbackResponse.status}`);
                }

                if (!fallbackResponse.ok) {
                    const fallbackError = await fallbackResponse.text().catch(() => "Unknown");
                    const fallbackElapsed = Date.now() - fallbackStart;
                    console.error(
                        JSON.stringify({
                            event: "whisper_fallback_failed",
                            fallbackModel: "whisper-1",
                            status: fallbackResponse.status,
                            elapsedMs: fallbackElapsed,
                            error: fallbackError,
                        })
                    );
                    // Non-retryable — throw a plain error so withRetry won't retry
                    throw new Error(`whisper-1 error: ${fallbackError}`);
                }

                return fallbackResponse.text();
            };

            try {
                const fallbackText = await withRetry(attemptWhisper1, {
                    maxRetries: 3,
                    baseDelayMs: 1000,
                    shouldRetry: isTransientError,
                });
                const fallbackElapsed = Date.now() - fallbackStart;
                console.log(
                    JSON.stringify({
                        event: "whisper_fallback_success",
                        fallbackModel: "whisper-1",
                        elapsedMs: fallbackElapsed,
                        elapsedSeconds: Math.round(fallbackElapsed / 1000),
                    })
                );
                return { text: fallbackText, model: "whisper-1" };
            } catch (fallbackErr) {
                console.error(
                    JSON.stringify({
                        event: "whisper_fallback_error",
                        fallbackModel: "whisper-1",
                        error: fallbackErr instanceof Error ? fallbackErr.message : "Unknown",
                    })
                );
            }
        }

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
    return { text: await response.text(), model: provider.model };
}

/**
 * Options for configuring the transcription call
 */
export interface TranscribeOptions {
    /** OpenAI API key */
    apiKey: string;
    /** Ignored — kept for backwards compatibility with old call sites */
    provider?: string;
    /** Optional callback for progress updates (chunk number, total chunks) */
    onProgress?: (currentChunk: number, totalChunks: number) => void;
    /** Skip URL validation and redirect resolution (use when caller has already resolved the URL) */
    skipValidation?: boolean;
}

/**
 * Transcribe audio from URL using OpenAI gpt-4o-mini-transcribe.
 * Automatically falls back to whisper-1 for files the primary model rejects.
 * Automatically handles large files by chunking them into smaller segments.
 * 
 * @param audioUrl - URL of the audio file to transcribe
 * @param options - Transcription options (apiKey, onProgress)
 * @returns Transcription result with text and source
 * @throws AppError with AUDIO_UNAVAILABLE, TRANSCRIPTION_FAILED, or RATE_LIMITED
 * 
 * @example
 * ```typescript
 * const result = await transcribeAudio("https://example.com/podcast.mp3", {
 *   apiKey: env.OPENAI_API_KEY,
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

    // Step 1: Validate audio URL and check size (with retry for rate limits)
    // If HEAD request is persistently rate-limited, try resolving redirects to
    // bypass origin rate limiting (e.g. Substack → CloudFront), then fall back
    // to direct fetch with unknown size.
    let validation: AudioValidation;
    if (opts.skipValidation) {
        // Caller has already resolved the URL — skip validation and redirect resolution
        validation = { contentLength: 0, contentType: "audio/mpeg" };
    } else {
        try {
            validation = await withRetry(
                () => validateAudioUrl(audioUrl),
                { maxRetries: 3, baseDelayMs: 5000, shouldRetry: isRateLimitError },
            );
        } catch (error) {
            if (error instanceof AppError && isRateLimitError(error)) {
                // Origin is rate-limiting us — try resolving redirects to hit final CDN directly
                const resolvedUrl = await resolveAudioUrl(audioUrl);
                if (resolvedUrl !== audioUrl) {
                    audioUrl = resolvedUrl;
                    // Try validation again on the resolved URL
                    try {
                        validation = await validateAudioUrl(audioUrl);
                    } catch {
                        // Resolved URL also failed — fall back to direct fetch
                        console.log(
                            JSON.stringify({
                                event: "validation_rate_limited_fallback",
                                message: "Both origin and resolved URL rate-limited, falling back to direct fetch",
                            })
                        );
                        validation = { contentLength: 0, contentType: "audio/mpeg" };
                    }
                } else {
                    console.log(
                        JSON.stringify({
                            event: "validation_rate_limited_fallback",
                            message: "HEAD request rate-limited, falling back to direct fetch",
                        })
                    );
                    validation = { contentLength: 0, contentType: "audio/mpeg" };
                }
            } else {
                throw error;
            }
        }

        // Step 1.5: Resolve redirects to get final CDN URL
        // This avoids rate limiting on the origin (e.g. api.substack.com → substackcdn.com)
        audioUrl = await resolveAudioUrl(audioUrl);
    }

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
    const result = await withRetry(
        () => callWhisperApi(audioBuffer, opts.apiKey, providerConfig, validation.contentType),
        {
            maxRetries: 3,
            baseDelayMs: 1000,
            shouldRetry: isTransientError,
        },
    );

    return {
        text: result.text.trim(),
        source: providerConfig.name,
        model: result.model,
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
 * @param provider - Provider config
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
            const chunkResult = await withRetry(
                () => callWhisperApi(bufferToTranscribe, apiKey, provider, contentType),
                {
                    maxRetries: 3,
                    baseDelayMs: 1000,
                    shouldRetry: isTransientError,
                },
            );

            transcriptions.push({
                text: chunkResult.text.trim(),
                isFirst: chunk.isFirst,
                isLast: chunk.isLast,
                overlapBytes: chunk.overlapBytes,
            });

            console.log(
                JSON.stringify({
                    event: "chunk_completed",
                    chunkIndex: i + 1,
                    totalChunks,
                    textLength: chunkResult.text.length,
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
        model: provider.model,
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
            maxRetries: 4,
            baseDelayMs: 5000, // Aggressive backoff for CDN rate limits (5s/10s/20s/40s)
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
                "User-Agent": AUDIO_USER_AGENT,
                Range: `bytes=${startByte}-${endByte}`,
            },
            signal: controller.signal,
        });

        clearTimeout(timeoutId);

        // Check for rate limiting (429) specifically
        if (response.status === 429) {
            const retryAfter = parseInt(response.headers.get("Retry-After") || "0", 10);
            throw new AppError(
                ERROR_CODES.RATE_LIMITED,
                `CDN rate limited: HTTP 429${retryAfter ? ` (retry-after: ${retryAfter}s)` : ""}`,
            );
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

