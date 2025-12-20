/**
 * Transcription service using OpenAI Whisper API
 * Handles audio validation and transcription for podcast episodes
 */

import { AppError } from "../lib/errors";
import { ERROR_CODES } from "../lib/constants";
import { withRetry, isTransientError } from "../lib/retry";

// OpenAI Whisper file size limit
const MAX_AUDIO_SIZE_BYTES = 25 * 1024 * 1024; // 25MB

// Timeout for audio HEAD requests
const AUDIO_HEAD_TIMEOUT_MS = 10000; // 10 seconds

// Timeout for audio fetch (generous for large files)
const AUDIO_FETCH_TIMEOUT_MS = 120000; // 2 minutes

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
    const timeoutId = setTimeout(() => controller.abort(), AUDIO_HEAD_TIMEOUT_MS);

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

        // Validate content type is audio
        if (!contentType.startsWith("audio/")) {
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
    const timeoutId = setTimeout(() => controller.abort(), AUDIO_FETCH_TIMEOUT_MS);

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

    const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
        method: "POST",
        headers: {
            Authorization: `Bearer ${apiKey}`,
        },
        body: formData,
    });

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
        throw new AppError(
            ERROR_CODES.TRANSCRIPTION_FAILED,
            `Whisper API error: ${errorText}`,
        );
    }

    // Response format is plain text when response_format=text
    return await response.text();
}

/**
 * Transcribe audio from URL using OpenAI Whisper API.
 * 
 * @param audioUrl - URL of the audio file to transcribe
 * @param openaiApiKey - OpenAI API key
 * @returns Transcription result with text and source
 * @throws AppError with AUDIO_TOO_LARGE, AUDIO_UNAVAILABLE, TRANSCRIPTION_FAILED, or RATE_LIMITED
 * 
 * @example
 * ```typescript
 * const result = await transcribeAudio(
 *   "https://example.com/podcast.mp3",
 *   process.env.OPENAI_API_KEY
 * );
 * console.log(result.text);
 * ```
 */
export async function transcribeAudio(
    audioUrl: string,
    openaiApiKey: string,
): Promise<TranscriptionResult> {
    // Step 1: Validate audio URL and check size
    const validation = await validateAudioUrl(audioUrl);

    if (validation.contentLength > MAX_AUDIO_SIZE_BYTES) {
        throw new AppError(
            ERROR_CODES.AUDIO_TOO_LARGE,
            `Audio file is ${Math.round(validation.contentLength / 1024 / 1024)}MB, maximum is 25MB. Audio chunking is not yet supported.`,
        );
    }

    // Step 2: Fetch audio
    const audioBuffer = await fetchAudio(audioUrl);

    // Double-check actual size (in case Content-Length was inaccurate)
    if (audioBuffer.byteLength > MAX_AUDIO_SIZE_BYTES) {
        throw new AppError(
            ERROR_CODES.AUDIO_TOO_LARGE,
            `Audio file is ${Math.round(audioBuffer.byteLength / 1024 / 1024)}MB, maximum is 25MB. Audio chunking is not yet supported.`,
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
