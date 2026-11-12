/**
 * Generic retry utility with exponential backoff
 * Used for handling transient failures in external API calls
 */

import { ERROR_CODES } from "./constants";
import { AppError } from "./errors";

export interface RetryOptions {
    /** Maximum number of retry attempts (not including initial attempt) */
    maxRetries: number;
    /** Base delay in milliseconds (doubles with each retry) */
    baseDelayMs: number;
    /** Optional predicate to determine if error should trigger retry */
    shouldRetry?: (error: Error) => boolean;
}

/**
 * Execute an async function with retry logic and exponential backoff.
 * 
 * @param fn - Async function to execute
 * @param options - Retry configuration
 * @returns Promise resolving to the function result
 * @throws The last error if all retries are exhausted
 * 
 * @example
 * ```typescript
 * const result = await withRetry(
 *   () => fetch('https://api.example.com/data'),
 *   { maxRetries: 3, baseDelayMs: 1000 }
 * );
 * ```
 */
export async function withRetry<T>(
    fn: () => Promise<T>,
    options: RetryOptions
): Promise<T> {
    const { maxRetries, baseDelayMs, shouldRetry } = options;
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            return await fn();
        } catch (error) {
            lastError = error instanceof Error ? error : new Error(String(error));

            // Check if we should retry this error
            if (shouldRetry && !shouldRetry(lastError)) {
                throw lastError;
            }

            // If this was the last attempt, throw
            if (attempt === maxRetries) {
                throw lastError;
            }

            // Calculate delay with exponential backoff, respecting Retry-After header if present
            const retryAfterMatch = lastError.message.match(/retry-after: (\d+)s/);
            const retryAfterMs = retryAfterMatch ? parseInt(retryAfterMatch[1], 10) * 1000 : 0;
            const delay = Math.max(retryAfterMs, baseDelayMs * Math.pow(2, attempt));
            await sleep(delay);
        }
    }

    // This should never be reached, but TypeScript needs it
    throw lastError ?? new Error("Retry failed");
}

/**
 * Sleep for a given number of milliseconds
 */
export function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Predicate for retrying on rate limit errors (HTTP 429)
 */
export function isRateLimitError(error: Error): boolean {
    return error.message.includes("429") || error.message.includes("rate limit");
}

/**
 * Predicate for retrying on server errors (HTTP 5xx)
 */
export function isServerError(error: Error): boolean {
    return /5\d{2}/.test(error.message);
}

/**
 * Predicate for retrying on transient errors (rate limit or server errors).
 * A rejected or unsupported file fails the same way every time, so it is never
 * transient, whatever digits its message happens to contain.
 */
export function isTransientError(error: Error): boolean {
    if (
        error instanceof AppError &&
        (error.code === ERROR_CODES.AUDIO_REJECTED || error.code === ERROR_CODES.AUDIO_UNSUPPORTED)
    ) {
        return false;
    }
    return isRateLimitError(error) || isServerError(error);
}
