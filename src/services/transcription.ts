/**
 * Transcription service using OpenAI gpt-transcribe.
 * Handles audio validation and transcription for podcast episodes.
 * Supports chunked transcription for files over 25MB.
 * An upload the model rejects fails as AUDIO_REJECTED (there is no fallback
 * model), except a small final chunk, which is skipped (#54). An optional
 * chunk cache lets a retried job resume chunked transcription (#48).
 */

import { AppError } from "../lib/errors";
import { ERROR_CODES, TIMEOUTS, AUDIO_LIMITS, AUDIO_USER_AGENT } from "../lib/constants";
import { withRetry, isTransientError, isRateLimitError, sleep } from "../lib/retry";
import {
    CONTAINER_PROBE_BYTES,
    MAX_CHUNK_SECONDS,
    assertWithinTotalSizeLimit,
    TARGET_CHUNK_SIZE_BYTES,
    estimateTranscriptionTime,
    hexBytes,
    id3Length,
    requiresChunking,
} from "../lib/audio";
import { adtsToM4a } from "../lib/adts";
import type { ChunkTranscriptCache } from "../types";
import type { FetchRange } from "./audio-containers";
import {
    CHUNK_PLAN_VERSION,
    detectContainer,
    exactBuffer,
    planChunks,
    type AudioContainer,
    type ChunkPlan,
    type ChunkSizeLimits,
    type PlannedChunk,
} from "./chunk-planning";


// Use centralized constant for Whisper size limit
const MAX_AUDIO_SIZE_BYTES = AUDIO_LIMITS.MAX_SIZE_BYTES;

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
export function mimeFromExtension(ext: string): string {
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

    // ID3v2 tag: skip past it to find the actual audio frames.
    // ID3 tags are codec-agnostic — podcast hosts commonly add them to AAC files.
    const offset = id3Length(fullBytes);
    if (offset > 0) {
        console.log(
            JSON.stringify({
                event: "id3_tag_parsed",
                id3Version: `2.${fullBytes[3]}`,
                tagBodySize: offset - 10,
                audioStartOffset: offset,
            })
        );

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

/**
 * Make a whole file uploadable as-is. OpenAI rejects raw ADTS AAC at any size
 * and under any filename, so ADTS is rewrapped as M4A; everything else, MP4
 * included, is returned unchanged. Chunked uploads rewrap ADTS per chunk in
 * `planChunks`, with the same `adtsToM4a`.
 *
 * @throws AppError(AUDIO_UNSUPPORTED) for ADTS that can't be rewrapped
 */
export function prepareForUpload(buffer: ArrayBuffer): ArrayBuffer {
    const bytes = new Uint8Array(buffer);
    if (detectContainer(bytes) !== "adts") return buffer;

    const m4a = adtsToM4a(bytes);
    console.log(
        JSON.stringify({
            event: "adts_rewrapped",
            inputBytes: bytes.length,
            outputBytes: m4a.length,
        }),
    );
    return exactBuffer(m4a);
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
        model: "gpt-transcribe",
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
    /** True when the final chunk failed transcription but earlier chunks succeeded. */
    partial?: boolean;
    /** Human-readable reason when partial=true. */
    partialReason?: string;
}

export interface AudioValidation {
    contentLength: number;
    contentType: string;
}

/**
 * Follow the whole redirect chain to get the final audio URL.
 *
 * Many podcast feeds point at a tracking prefix that redirects to the publisher
 * origin, which in turn redirects to the actual CDN — e.g.
 * `pscrb.fm` → `api.substack.com` → `substackcdn.com`. Only the CDN at the end
 * is willing to serve us at volume; the hosts in the middle rate-limit
 * server-originated requests. Stopping at the first hop leaves us on a
 * rate-limited host, so follow to the end (bounded) and let callers point their
 * validation and range requests at the CDN.
 *
 * A 429 on a hop is retried rather than treated as the end of the chain — see
 * AUDIO_LIMITS.HOP_RATE_LIMIT_RETRIES for why a throttled hop is a coin flip
 * rather than a verdict.
 *
 * Never throws: on any failure it returns the furthest URL successfully reached,
 * falling back to the original.
 */
/**
 * HEAD a single hop, retrying while the host rate-limits us.
 *
 * The throttle carries no Retry-After header, and successive attempts succeed
 * independently rather than after a cooldown, so back off gently and cheaply
 * instead of waiting the host out.
 */
async function fetchHopFollowingRateLimits(
    url: string,
    rateLimitRetries: number,
    baseDelayMs: number
): Promise<Response> {
    let response = await fetch(url, {
        method: "HEAD",
        headers: { "User-Agent": AUDIO_USER_AGENT },
        redirect: "manual",
    });

    for (let attempt = 0; response.status === 429 && attempt < rateLimitRetries; attempt++) {
        // Without this the throttled hop is silently invisible: the success log
        // below only fires on a hop that resolved, so a chain dying on a 429
        // used to leave no trace at all in Workers Logs.
        console.log(
            JSON.stringify({
                event: "audio_url_hop_rate_limited",
                host: new URL(url).hostname,
                attempt: attempt + 1,
                maxAttempts: rateLimitRetries,
            })
        );

        await sleep(
            Math.min(baseDelayMs * Math.pow(2, attempt), AUDIO_LIMITS.HOP_RATE_LIMIT_MAX_DELAY_MS)
        );

        response = await fetch(url, {
            method: "HEAD",
            headers: { "User-Agent": AUDIO_USER_AGENT },
            redirect: "manual",
        });
    }

    return response;
}

export interface ResolveAudioUrlOptions {
    /** Extra attempts for a hop that comes back 429. */
    rateLimitRetries?: number;
    /** Backoff before the first retry; doubles per attempt, capped. */
    rateLimitBaseDelayMs?: number;
}

export async function resolveAudioUrl(
    audioUrl: string,
    options: ResolveAudioUrlOptions = {}
): Promise<string> {
    const rateLimitRetries = options.rateLimitRetries ?? AUDIO_LIMITS.HOP_RATE_LIMIT_RETRIES;
    const rateLimitBaseDelayMs =
        options.rateLimitBaseDelayMs ?? AUDIO_LIMITS.HOP_RATE_LIMIT_BASE_DELAY_MS;

    let currentUrl = audioUrl;
    const seen = new Set<string>([currentUrl]);

    for (let hop = 0; hop < AUDIO_LIMITS.MAX_REDIRECT_HOPS; hop++) {
        let response: Response;
        try {
            response = await fetchHopFollowingRateLimits(
                currentUrl,
                rateLimitRetries,
                rateLimitBaseDelayMs
            );
        } catch {
            // Network failure — keep the furthest URL we did resolve.
            return currentUrl;
        }

        if (response.status < 300 || response.status >= 400) {
            return currentUrl;
        }

        const location = response.headers.get("Location");
        if (!location) {
            return currentUrl;
        }

        // Location may be relative — resolve it against the URL we just fetched.
        let nextUrl: string;
        try {
            nextUrl = new URL(location, currentUrl).toString();
        } catch {
            return currentUrl;
        }

        // A repeat means the chain is cycling; stop where we are.
        if (seen.has(nextUrl)) {
            return currentUrl;
        }
        seen.add(nextUrl);

        console.log(
            JSON.stringify({
                event: "audio_url_redirect_resolved",
                hop: hop + 1,
                fromHost: new URL(currentUrl).hostname,
                toHost: new URL(nextUrl).hostname,
            })
        );

        currentUrl = nextUrl;
    }

    return currentUrl;
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

        // On 403, try resolving redirect manually and fetching the final CDN URL.
        // Some CDN WAFs (e.g. Podbean behind Cloudflare) block queue consumer requests
        // to the download gateway but allow direct CDN access.
        if (response.status === 403) {
            console.log(JSON.stringify({
                event: "fetch_audio_403_retry",
                url: audioUrl,
                message: "Attempting redirect resolution fallback",
            }));
            const resolvedUrl = await resolveAudioUrl(audioUrl);
            if (resolvedUrl !== audioUrl) {
                console.log(JSON.stringify({
                    event: "fetch_audio_403_resolved",
                    original: audioUrl,
                    resolved: resolvedUrl,
                }));
                const retryController = new AbortController();
                const retryTimeoutId = setTimeout(() => retryController.abort(), TIMEOUTS.AUDIO_FETCH_MS);
                try {
                    const retryResponse = await fetch(resolvedUrl, {
                        headers: { "User-Agent": AUDIO_USER_AGENT },
                        signal: retryController.signal,
                    });
                    clearTimeout(retryTimeoutId);
                    if (retryResponse.ok) {
                        console.log(JSON.stringify({
                            event: "fetch_audio_403_resolved_success",
                            resolvedUrl,
                            status: retryResponse.status,
                        }));
                        return await retryResponse.arrayBuffer();
                    }
                } catch {
                    clearTimeout(retryTimeoutId);
                }
            }

            // Log details of the original 403 for diagnostics
            const respHeaders: Record<string, string> = {};
            response.headers.forEach((v, k) => { respHeaders[k] = v; });
            console.log(JSON.stringify({
                event: "fetch_audio_error_details",
                status: 403,
                url: response.url,
                requestedUrl: audioUrl,
                redirected: response.redirected,
                headers: respHeaders,
            }));
            throw new AppError(
                ERROR_CODES.AUDIO_UNAVAILABLE,
                `Failed to fetch audio: HTTP 403`,
            );
        }

        if (!response.ok) {
            // Capture diagnostic details for non-200 responses
            const respHeaders: Record<string, string> = {};
            response.headers.forEach((v, k) => { respHeaders[k] = v; });
            let respBody: string | null = null;
            try {
                respBody = await response.text();
                if (respBody.length > 1000) respBody = respBody.slice(0, 1000);
            } catch { /* ignore */ }
            console.log(
                JSON.stringify({
                    event: "fetch_audio_error_details",
                    status: response.status,
                    url: response.url,
                    requestedUrl: audioUrl,
                    redirected: response.redirected,
                    headers: respHeaders,
                    body: respBody,
                })
            );
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
 * Call the OpenAI transcription API with gpt-transcribe.
 *
 * @param audioBuffer - Audio data as ArrayBuffer
 * @param apiKey - OpenAI API key
 * @param provider - Provider config
 * @returns Transcribed text
 * @throws AppError with AUDIO_REJECTED when the model refuses the audio (a
 *   400 the same upload would get again: its `cause` carries the OpenAI
 *   response body), TRANSCRIPTION_FAILED on any other 400 or a malformed
 *   response, and a plain Error on 429 or 5xx for `withRetry` to retry
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

    console.log(
        JSON.stringify({
            event: "audio_format_detected",
            detectedExtension: ext,
            blobMime,
            headerContentType: contentType,
            bufferSizeBytes: audioBuffer.byteLength,
            firstBytesHex: hexBytes(new Uint8Array(audioBuffer, 0, Math.min(16, audioBuffer.byteLength))),
        })
    );

    const formData = new FormData();
    const audioBlob = new Blob([audioBuffer], { type: blobMime });
    formData.append("file", audioBlob, `audio.${ext}`);
    formData.append("model", provider.model);
    formData.append("response_format", "json");

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

        // The model refuses this audio, and would refuse the same upload again.
        // "corrupted or unsupported" verified live against gpt-transcribe
        // (2026-08-02 pre-flight). A rejection that slips past these checks
        // fails as TRANSCRIPTION_FAILED, with its body in whisper_api_error.
        const rejected =
            errorText.includes("corrupted or unsupported") ||
            errorText.includes("input_too_large") ||
            errorText.includes("too large for this model");
        if (status === 400 && rejected) {
            throw new AppError(
                ERROR_CODES.AUDIO_REJECTED,
                `${provider.model} rejected the audio`,
                new Error(errorText),
            );
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

    // gpt-transcribe returns JSON: { "text": "...", "languages": [...] } (languages ignored)
    let body: { text?: unknown };
    try {
        body = (await response.json()) as { text?: unknown };
    } catch {
        throw new AppError(
            ERROR_CODES.TRANSCRIPTION_FAILED,
            `Unexpected non-JSON transcription response from ${provider.model}`,
        );
    }
    if (typeof body.text !== "string") {
        throw new AppError(
            ERROR_CODES.TRANSCRIPTION_FAILED,
            `Unexpected transcription response shape from ${provider.model}`,
        );
    }
    return body.text;
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
    /** Override chunk sizing. Production uses the defaults; tests and scripts shrink them. */
    chunkLimits?: TranscribeChunkLimits;
    /**
     * Where chunked transcription keeps each finished chunk's text, so a
     * retried attempt skips chunks an earlier one already paid for (#48).
     * Best effort: read and write errors are logged and ignored.
     */
    chunkCache?: ChunkTranscriptCache;
}

export interface TranscribeChunkLimits extends ChunkSizeLimits {
    /** Files larger than this are chunked. Default: the API's 25 MB upload limit. */
    uploadLimitBytes?: number;
}

const DEFAULT_CHUNK_LIMITS: ChunkSizeLimits = {
    maxBytes: TARGET_CHUNK_SIZE_BYTES,
    maxSeconds: MAX_CHUNK_SECONDS,
};

/**
 * Transcribe audio from URL using OpenAI gpt-transcribe.
 * Chunks any file over the upload limit, or whose audio runs past the
 * per-chunk duration cap (`MAX_CHUNK_SECONDS`), which the model enforces
 * whatever the file size.
 *
 * @param audioUrl - URL of the audio file to transcribe
 * @param options - Transcription options (apiKey, onProgress)
 * @returns Transcription result with text and source
 * @throws AppError with AUDIO_UNAVAILABLE, AUDIO_UNSUPPORTED, AUDIO_REJECTED
 *   (the model refused an upload; logged as `transcription_rejected`),
 *   TRANSCRIPTION_FAILED, or RATE_LIMITED
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
    const uploadLimitBytes = opts.chunkLimits?.uploadLimitBytes ?? MAX_AUDIO_SIZE_BYTES;
    const chunkLimits: ChunkSizeLimits = {
        maxBytes: opts.chunkLimits?.maxBytes ?? DEFAULT_CHUNK_LIMITS.maxBytes,
        maxSeconds: opts.chunkLimits?.maxSeconds ?? DEFAULT_CHUNK_LIMITS.maxSeconds,
    };

    console.log(
        JSON.stringify({
            event: "transcription_start",
            provider: providerConfig.name,
            model: providerConfig.model,
        })
    );

    // Step 1: Resolve redirects BEFORE validating.
    // Podcast trackers and publisher origins (pscrb.fm, api.substack.com)
    // rate-limit server-originated requests; the CDN they redirect to does not.
    // Resolving first means the rate-limited hosts see exactly one cheap HEAD,
    // and validation, retries and range requests all target the CDN. Doing this
    // the other way round aimed four HEADs plus a 90 MB range read at the host
    // most likely to 429 — which is what broke cron episodes on 2026-08-12 and
    // 2026-08-16.
    let validation: AudioValidation;
    if (opts.skipValidation) {
        // Caller has already resolved the URL — skip validation and redirect resolution
        validation = { contentLength: 0, contentType: "audio/mpeg" };
    } else {
        audioUrl = await resolveAudioUrl(audioUrl);

        // Step 2: Validate the resolved URL and check size (retrying rate limits).
        // If the CDN still rate-limits us, bubble up so queue retry handles it
        // after a delay — never fall back to a whole-file fetch, because for
        // large files that turns one 429 into a guaranteed 429 on a 90+ MB read.
        try {
            validation = await withRetry(
                () => validateAudioUrl(audioUrl),
                { maxRetries: 3, baseDelayMs: 5000, shouldRetry: isRateLimitError },
            );
        } catch (error) {
            if (error instanceof AppError && isRateLimitError(error)) {
                console.log(
                    JSON.stringify({
                        event: "validation_rate_limited_throw",
                        host: new URL(audioUrl).hostname,
                        message: "Audio host rate-limited after redirect resolution; bubbling to queue retry",
                    })
                );
            }
            throw error;
        }
    }

    // Called only once the URL has been validated or fetched, so it parses.
    const planContext = (): TranscribePlanContext => ({
        apiKey: opts.apiKey,
        provider: providerConfig,
        contentType: validation.contentType,
        audioHost: new URL(audioUrl).hostname,
        maxChunkSeconds: chunkLimits.maxSeconds,
        onProgress: progressCallback,
        chunkCache: opts.chunkCache,
    });

    // Step 3: Route based on file size
    if (requiresChunking(validation.contentLength, uploadLimitBytes)) {
        // Large file - use chunked transcription
        console.log(
            JSON.stringify({
                event: "chunked_transcription_start",
                provider: providerConfig.name,
                contentLength: validation.contentLength,
                contentLengthMB: Math.round(validation.contentLength / 1024 / 1024),
            })
        );
        const plan = await planRemote(audioUrl, validation.contentLength, validation.contentType, chunkLimits);
        return await transcribePlan(plan, planContext());
    }

    // Small file - fetch it whole
    const audioBuffer = await fetchAudio(audioUrl);
    const ctx = planContext();

    // Double-check actual size (in case Content-Length was inaccurate)
    if (audioBuffer.byteLength > uploadLimitBytes) {
        // If it's bigger than expected, fall back to chunking
        console.log(
            JSON.stringify({
                event: "size_mismatch_chunking",
                expected: validation.contentLength,
                actual: audioBuffer.byteLength,
            })
        );
        const plan = await planRemote(audioUrl, audioBuffer.byteLength, validation.contentType, chunkLimits);
        return await transcribePlan(plan, ctx);
    }

    // Step 4: Plan the file from the bytes in hand. It fits one upload, but a
    // low-bitrate file can still run past the model's duration limit, so it
    // is chunked whenever the plan has more than one chunk (#48).
    const smallFileLimits: ChunkSizeLimits = { maxBytes: uploadLimitBytes, maxSeconds: chunkLimits.maxSeconds };
    const plan = await planSmallFile(audioBuffer, validation.contentType, smallFileLimits, ctx.audioHost);
    if (plan && plan.chunks.length > 1) {
        return await transcribePlan(plan, ctx);
    }

    // Step 5: One upload. MP3 uploads the plan's only chunk, which drops the
    // ID3 tag and any Xing/Info/VBRI frame (or is the whole file when its
    // frames can't be parsed); everything else uploads as it always has.
    const uploadBuffer = plan?.container === "mp3" ? await plan.chunks[0].load() : prepareForUpload(audioBuffer);
    if (plan) {
        console.log(
            JSON.stringify({
                event: "upload_plan",
                ...planLogFields(plan, ctx),
                uploadBytes: uploadBuffer.byteLength,
            })
        );
    }
    try {
        const text = await withRetry(
            () => callWhisperApi(uploadBuffer, opts.apiKey, providerConfig, validation.contentType),
            {
                maxRetries: 3,
                baseDelayMs: 1000,
                shouldRetry: isTransientError,
            },
        );
        return {
            text: text.trim(),
            source: providerConfig.name,
            model: providerConfig.model,
        };
    } catch (error) {
        if (isRejection(error)) {
            logRejection(error, {
                position: { wholeFile: true },
                upload: uploadBuffer,
                container: plan?.container ?? detectContainer(probeOf(audioBuffer)),
                chunk: plan?.chunks[0],
                vbrHeaderDropped: plan?.audio.vbrHeaderDropped ?? false,
                audioHost: ctx.audioHost,
            });
        }
        throw error;
    }
}

/**
 * Plan a file that is already in memory. Returns null when the planner
 * rejects the format (fragmented or truncated MP4, say): such a file fits
 * one upload, which may still work, so it keeps today's whole-file path.
 */
async function planSmallFile(
    buffer: ArrayBuffer,
    contentType: string,
    limits: ChunkSizeLimits,
    audioHost: string,
): Promise<ChunkPlan | null> {
    try {
        return await planChunks({
            probe: probeOf(buffer),
            fileSize: buffer.byteLength,
            contentType,
            limits,
            fetchRange: inMemoryRange(buffer),
        });
    } catch (error) {
        if (!(error instanceof AppError && error.code === ERROR_CODES.AUDIO_UNSUPPORTED)) throw error;
        console.log(
            JSON.stringify({
                event: "upload_plan_unavailable",
                reason: error.message,
                fileBytes: buffer.byteLength,
                audioHost,
            })
        );
        return null;
    }
}

/** The first bytes of a file in memory, as much as container detection reads. */
function probeOf(buffer: ArrayBuffer): Uint8Array {
    return new Uint8Array(buffer, 0, Math.min(CONTAINER_PROBE_BYTES, buffer.byteLength));
}

/** Serve range reads from a buffer, clamping `end` to its length like an HTTP Range request. */
function inMemoryRange(buffer: ArrayBuffer): FetchRange {
    return async (start, end) => buffer.slice(start, Math.min(end, buffer.byteLength - 1) + 1);
}

// ============================================================================
// Chunked Transcription
// ============================================================================

/** What `transcribePlan` needs besides the plan. */
interface TranscribePlanContext {
    apiKey: string;
    provider: ProviderConfig;
    /** Content-type header of the audio file. */
    contentType: string;
    /** Hostname of the audio URL, for logs. Never the full URL: CDN URLs can be signed. */
    audioHost: string;
    /** The per-chunk duration cap the plan was made with, for logs. */
    maxChunkSeconds: number;
    onProgress?: (currentChunk: number, totalChunks: number) => void;
    chunkCache?: ChunkTranscriptCache;
}

/**
 * The cache key for one planned chunk. It holds everything that decides the
 * chunk's audio, so a planner change (a `CHUNK_PLAN_VERSION` bump), a
 * re-encoded file or a different cut misses instead of stitching text from
 * different audio.
 */
export function chunkCacheKey(plan: ChunkPlan, chunk: PlannedChunk): string {
    return `${CHUNK_PLAN_VERSION}:${plan.container}:${plan.fileSize}:${chunk.index}:${chunk.cacheId}`;
}

/** A cached chunk transcript, or null on a miss or a cache error (logged, never thrown). */
async function readCachedChunk(cache: ChunkTranscriptCache, key: string, chunkNumber: number): Promise<string | null> {
    try {
        return (await cache.get(key))?.text ?? null;
    } catch (error) {
        console.warn(
            JSON.stringify({
                event: "chunk_cache_read_failed",
                chunkIndex: chunkNumber,
                error: error instanceof Error ? error.message : String(error),
            })
        );
        return null;
    }
}

/** Cache a chunk transcript; a cache error is logged, never thrown. */
async function writeCachedChunk(cache: ChunkTranscriptCache, key: string, text: string, chunkNumber: number): Promise<void> {
    try {
        await cache.put(key, { text });
    } catch (error) {
        console.warn(
            JSON.stringify({
                event: "chunk_cache_write_failed",
                chunkIndex: chunkNumber,
                error: error instanceof Error ? error.message : String(error),
            })
        );
    }
}

/**
 * The plan's audio summary for `chunking_plan` and `upload_plan`, so a
 * rejected upload can be diagnosed from the logs alone.
 */
function planLogFields(plan: ChunkPlan, ctx: TranscribePlanContext): Record<string, unknown> {
    return {
        container: plan.container,
        ...plan.audio,
        maxChunkSeconds: ctx.maxChunkSeconds,
        audioHost: ctx.audioHost,
    };
}

/** An upload the model refused: `callWhisperApi` throws these, and nothing else does. */
function isRejection(error: unknown): error is AppError {
    return error instanceof AppError && error.code === ERROR_CODES.AUDIO_REJECTED;
}

interface RejectedUpload {
    /** Which chunk of how many, or the whole file in one upload. */
    position: { chunkIndex: number; totalChunks: number } | { wholeFile: true };
    /** The bytes sent to the API. */
    upload: ArrayBuffer;
    container: AudioContainer;
    /** The planned chunk the upload came from; absent when the file couldn't be planned. */
    chunk?: PlannedChunk;
    vbrHeaderDropped: boolean;
    audioHost: string;
}

/**
 * Log `transcription_rejected` with enough to reproduce the rejection from
 * Workers Logs alone: where the upload sat in the file, its first bytes, and
 * the full OpenAI error body. Host only, never the URL: CDN URLs can be signed.
 */
function logRejection(error: AppError, rejected: RejectedUpload): void {
    const { position, upload, container, chunk, vbrHeaderDropped, audioHost } = rejected;
    console.error(
        JSON.stringify({
            event: "transcription_rejected",
            container,
            ...position,
            uploadBytes: upload.byteLength,
            plannedSeconds: chunk?.plannedSeconds,
            ...chunk?.logFields,
            firstBytesHex: hexBytes(new Uint8Array(upload, 0, Math.min(32, upload.byteLength))),
            vbrHeaderDropped,
            openAiError: error.cause?.message,
            audioHost,
        })
    );
}

/**
 * Plan chunks for a remote file too large for one upload: fetch a probe of
 * its first bytes to identify the container, then plan with range reads
 * (see `planChunks`).
 *
 * @param audioUrl - URL of the audio file
 * @param contentLength - Total file size in bytes
 * @param contentType - Content-type header of the audio file
 * @param limits - Per-chunk byte and duration caps
 */
async function planRemote(
    audioUrl: string,
    contentLength: number,
    contentType: string,
    limits: ChunkSizeLimits,
): Promise<ChunkPlan> {
    // Before the probe, so an oversized file costs no audio fetch.
    assertWithinTotalSizeLimit(contentLength);

    const probeBytes = Math.min(CONTAINER_PROBE_BYTES, contentLength);
    console.log(JSON.stringify({ event: "fetching_container_probe", probeBytes }));
    const probe = new Uint8Array(await fetchAudioChunk(audioUrl, 0, probeBytes - 1));

    return planChunks({
        probe,
        fileSize: contentLength,
        contentType,
        limits,
        fetchRange: (start, end) => fetchAudioChunk(audioUrl, start, end),
    });
}

/**
 * Transcribe a chunk plan: load, transcribe and stitch the chunks one at a
 * time so only one is in memory at once. With a chunk cache, a cached chunk
 * is neither fetched nor sent to OpenAI, and each new chunk is cached once
 * transcribed.
 *
 * @returns Combined transcription result
 */
async function transcribePlan(plan: ChunkPlan, ctx: TranscribePlanContext): Promise<TranscriptionResult> {
    const { apiKey, provider, contentType, audioHost, onProgress, chunkCache } = ctx;
    const { totalBytes, chunks } = plan;
    const totalChunks = chunks.length;

    console.log(
        JSON.stringify({
            event: "chunking_plan",
            ...planLogFields(plan, ctx),
            totalChunks,
            contentLengthMB: Math.round(plan.fileSize / 1024 / 1024),
            estimatedTranscriptionSeconds: estimateTranscriptionTime(plan.fileSize, totalChunks),
        })
    );

    // Process chunks sequentially to manage memory
    const transcriptions: ChunkTranscription[] = [];
    let tailChunkSkipped: { chunkIndex: number; error: string; sharePercent: number } | null = null;
    // The inter-chunk sleep spaces out CDN fetches, so it's owed only once a
    // chunk has been fetched: a resumed job's first uncached chunk goes at once.
    let fetchedAChunk = false;

    for (const chunk of chunks) {
        const chunkNumber = chunk.index + 1;

        // Report progress
        onProgress?.(chunkNumber, totalChunks);

        console.log(
            JSON.stringify({
                event: "chunk_processing",
                chunkIndex: chunkNumber,
                totalChunks,
                ...chunk.logFields,
            })
        );

        const cacheKey = chunkCacheKey(plan, chunk);
        const cachedText = chunkCache ? await readCachedChunk(chunkCache, cacheKey, chunkNumber) : null;
        if (cachedText !== null) {
            transcriptions.push({
                text: cachedText,
                isFirst: chunk.isFirst,
                isLast: chunk.isLast,
                overlapBytes: chunk.overlapBytes,
            });
            console.log(JSON.stringify({ event: "chunk_cache_hit", chunkIndex: chunkNumber, totalChunks }));
            continue;
        }

        // Kept outside the try so a rejection can log the bytes it sent.
        let upload: ArrayBuffer | undefined;
        try {
            // Add delay between chunk fetches to avoid CDN rate limits
            if (fetchedAChunk) {
                await sleep(TIMEOUTS.CHUNK_FETCH_DELAY_MS);
            }
            fetchedAChunk = true;

            const bufferToTranscribe = await chunk.load();
            upload = bufferToTranscribe;

            // Transcribe the chunk
            const chunkText = await withRetry(
                () => callWhisperApi(bufferToTranscribe, apiKey, provider, contentType),
                {
                    maxRetries: 3,
                    baseDelayMs: 1000,
                    shouldRetry: isTransientError,
                },
            );

            const text = chunkText.trim();
            transcriptions.push({
                text,
                isFirst: chunk.isFirst,
                isLast: chunk.isLast,
                overlapBytes: chunk.overlapBytes,
            });
            if (chunkCache) {
                await writeCachedChunk(chunkCache, cacheKey, text, chunkNumber);
            }

            console.log(
                JSON.stringify({
                    event: "chunk_completed",
                    chunkIndex: chunkNumber,
                    totalChunks,
                    textLength: chunkText.length,
                })
            );
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : "Unknown error";

            // Log the error with context
            console.error(
                JSON.stringify({
                    event: "chunk_failed",
                    chunkIndex: chunkNumber,
                    totalChunks,
                    error: errorMessage,
                })
            );

            // The file itself can't be chunked: dropping the tail would hide that.
            if (error instanceof AppError && error.code === ERROR_CODES.AUDIO_UNSUPPORTED) {
                throw error;
            }

            if (isRejection(error) && upload) {
                logRejection(error, {
                    position: { chunkIndex: chunkNumber, totalChunks },
                    upload,
                    container: plan.container,
                    chunk,
                    vbrHeaderDropped: plan.audio.vbrHeaderDropped ?? false,
                    audioHost,
                });
            }

            // Tolerate failure of a small trailing chunk: some podcast files end in
            // a non-decodable trailer (ID3v1 footers, ad markers, etc.) that the
            // model rejects. Losing a few minutes of outro beats failing the
            // episode. But the last chunk can hold up to a full chunk of audio
            // (half of a two-chunk file), so a large tail fails like any other
            // chunk rather than silently dropping real content (#54).
            if (chunk.isLast && transcriptions.length > 0 && totalChunks > 1) {
                // Overlap was already transcribed with the previous chunk, so only
                // the chunk's new audio is lost.
                const share = chunk.newBytes / totalBytes;
                const sharePercent = Math.round(share * 1000) / 10;
                const logFields = {
                    chunkIndex: chunkNumber,
                    totalChunks,
                    successfulChunks: transcriptions.length,
                    chunkSizeBytes: chunk.overlapBytes + chunk.newBytes,
                    sharePercent,
                    error: errorMessage,
                };
                if (share <= AUDIO_LIMITS.MAX_SKIPPABLE_TAIL_SHARE) {
                    tailChunkSkipped = { chunkIndex: chunkNumber, error: errorMessage, sharePercent };
                    console.warn(JSON.stringify({ event: "tail_chunk_skipped", ...logFields }));
                    break;
                }
                console.error(JSON.stringify({ event: "tail_chunk_too_large_to_skip", ...logFields }));
            }

            // Re-throw with context
            if (isRejection(error)) {
                throw new AppError(
                    ERROR_CODES.AUDIO_REJECTED,
                    `${provider.model} rejected chunk ${chunkNumber}/${totalChunks} of the audio`,
                    error.cause,
                );
            }
            if (error instanceof AppError) {
                throw error;
            }
            throw new AppError(
                ERROR_CODES.TRANSCRIPTION_FAILED,
                `Failed to transcribe chunk ${chunkNumber}/${totalChunks}: ${errorMessage}`,
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
        ...(tailChunkSkipped && {
            partial: true,
            partialReason: `Final chunk ${tailChunkSkipped.chunkIndex}/${totalChunks} was rejected by ${provider.model} (${tailChunkSkipped.error}). The transcript is missing the last ${tailChunkSkipped.sharePercent}% of the audio.`,
        }),
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
    // Wrap with retry logic for rate limit handling.
    // Substack/CloudFront rate-limit windows commonly outlast short backoffs,
    // so we wait longer here (15s/30s/60s/120s/240s ≈ 7.7 min total) before
    // bubbling up to the queue-level retry. Honors Retry-After when present.
    return withRetry(
        () => fetchAudioChunkOnce(audioUrl, startByte, endByte),
        {
            maxRetries: 5,
            baseDelayMs: 15000,
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

