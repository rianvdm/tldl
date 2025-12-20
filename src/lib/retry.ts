/**
 * Generic retry utility with exponential backoff
 * Used for handling transient failures in external API calls
 */

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

            // Calculate delay with exponential backoff
            const delay = baseDelayMs * Math.pow(2, attempt);
            await sleep(delay);
        }
    }

    // This should never be reached, but TypeScript needs it
    throw lastError ?? new Error("Retry failed");
}

/**
 * Sleep for a given number of milliseconds
 */
function sleep(ms: number): Promise<void> {
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
 * Predicate for retrying on transient errors (rate limit or server errors)
 */
export function isTransientError(error: Error): boolean {
    return isRateLimitError(error) || isServerError(error);
}
