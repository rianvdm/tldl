/**
 * Custom Error class for TLDL application errors
 * Provides structured error information with machine-readable codes
 * and human-friendly messages.
 */

import type { ErrorCode } from "./constants";
import { ERROR_CODES } from "./constants";

// ============================================================================
// User-Friendly Error Messages
// ============================================================================

export const ERROR_MESSAGES: Record<ErrorCode, string> = {
    [ERROR_CODES.INVALID_URL]:
        "Please enter a valid Apple Podcasts episode URL. It should look like: podcasts.apple.com/...?i=...",
    [ERROR_CODES.INVALID_TEMPLATE]:
        "Invalid summary template selected. Please choose a valid template.",
    [ERROR_CODES.EPISODE_NOT_FOUND]:
        "Couldn't find this episode. Please check the URL and try again.",
    [ERROR_CODES.EPISODE_TOO_LONG]:
        "This episode is too long (over 2 hours). Try a shorter episode.",
    [ERROR_CODES.AUDIO_UNAVAILABLE]:
        "Unable to access the episode audio. It may be geo-restricted or no longer available.",
    [ERROR_CODES.AUDIO_TOO_LARGE]:
        "The audio file is too large to process. Try a shorter episode.",
    [ERROR_CODES.TRANSCRIPTION_FAILED]:
        "Transcription failed. Please try again in a few minutes.",
    [ERROR_CODES.SUMMARIZATION_FAILED]:
        "Summary generation failed. Please try again in a few minutes.",
    [ERROR_CODES.RATE_LIMITED]:
        "We're processing too many requests. Please try again in a few minutes.",
    [ERROR_CODES.RSS_TIMEOUT]:
        "The podcast feed took too long to respond. Please try again.",
    [ERROR_CODES.ITUNES_API_ERROR]:
        "Couldn't fetch podcast information. Please try again.",
    [ERROR_CODES.UNKNOWN_ERROR]:
        "Something went wrong. Please try again later.",
    [ERROR_CODES.NOT_FOUND]:
        "The requested resource was not found.",
    [ERROR_CODES.UNAUTHORIZED]:
        "You need to be logged in to access this feature.",
};

// ============================================================================
// HTTP Status Code Mapping
// ============================================================================

export const ERROR_HTTP_STATUS: Record<ErrorCode, number> = {
    [ERROR_CODES.INVALID_URL]: 400,
    [ERROR_CODES.INVALID_TEMPLATE]: 400,
    [ERROR_CODES.EPISODE_NOT_FOUND]: 404,
    [ERROR_CODES.EPISODE_TOO_LONG]: 400,
    [ERROR_CODES.AUDIO_UNAVAILABLE]: 502,
    [ERROR_CODES.AUDIO_TOO_LARGE]: 400,
    [ERROR_CODES.TRANSCRIPTION_FAILED]: 502,
    [ERROR_CODES.SUMMARIZATION_FAILED]: 502,
    [ERROR_CODES.RATE_LIMITED]: 429,
    [ERROR_CODES.RSS_TIMEOUT]: 504,
    [ERROR_CODES.ITUNES_API_ERROR]: 502,
    [ERROR_CODES.UNKNOWN_ERROR]: 500,
    [ERROR_CODES.NOT_FOUND]: 404,
    [ERROR_CODES.UNAUTHORIZED]: 401,
};

// ============================================================================
// AppError Class
// ============================================================================

export class AppError extends Error {
    public readonly code: ErrorCode;
    public readonly userMessage: string;
    public readonly cause?: Error;

    constructor(code: ErrorCode, userMessage?: string, cause?: Error) {
        const message = userMessage || ERROR_MESSAGES[code] || ERROR_MESSAGES[ERROR_CODES.UNKNOWN_ERROR];
        super(message);
        this.name = "AppError";
        this.code = code;
        this.userMessage = message;
        this.cause = cause;

        // Maintains proper stack trace for where error was thrown (V8 only)
        if (Error.captureStackTrace) {
            Error.captureStackTrace(this, AppError);
        }
    }

    /**
     * Get the appropriate HTTP status code for this error
     */
    get httpStatus(): number {
        return ERROR_HTTP_STATUS[this.code] || 500;
    }

    /**
     * Create a JSON-serializable representation of the error
     */
    toJSON(): { code: ErrorCode; message: string; cause?: string } {
        return {
            code: this.code,
            message: this.userMessage,
            ...(this.cause && { cause: this.cause.message }),
        };
    }
}

// ============================================================================
// Error Logging Helper
// ============================================================================

interface ErrorLogContext {
    jobId?: string;
    episodeId?: string;
    requestId?: string;
    url?: string;
    userEmail?: string;
}

/**
 * Log an error with structured context for debugging
 */
export function logError(error: Error, context: ErrorLogContext = {}): void {
    const logEntry = {
        timestamp: new Date().toISOString(),
        errorName: error.name,
        errorCode: error instanceof AppError ? error.code : "UNKNOWN",
        errorMessage: error.message,
        ...context,
        stack: error.stack,
    };

    console.error(JSON.stringify(logEntry));
}

// ============================================================================
// Input Validation Helpers
// ============================================================================

/**
 * Validate a UUID format
 */
export function isValidUuid(id: string): boolean {
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    return uuidRegex.test(id);
}

/**
 * Sanitize text for safe HTML output (prevent XSS)
 */
export function sanitizeForHtml(text: string): string {
    return text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

/**
 * Sanitize text for use in URLs
 */
export function sanitizeForUrl(text: string): string {
    return encodeURIComponent(text);
}
