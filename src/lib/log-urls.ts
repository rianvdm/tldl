/**
 * Log-safe views of audio URLs and responses.
 *
 * Audio CDN URLs can be signed (Substack's carry `Expires`, `Signature` and
 * `Key-Pair-Id` in the query), and Workers Logs keep whatever is logged, so
 * logs carry an audio URL's hostname, or at most its path, never its query.
 * The user-facing `AUDIO_REJECTED` debug command is the one place the full
 * URL appears, by design.
 */

/** Logged in place of a host or path when the URL doesn't parse. */
const UNPARSEABLE = "(unparseable URL)";

/** Response headers worth logging on a failed audio fetch; the rest can echo the URL or set cookies. */
const LOGGABLE_HEADERS = new Set(["content-type", "content-length", "content-range", "retry-after", "cf-ray", "server"]);

/** The URL's hostname, for logs. */
export function urlHost(url: string): string {
    try {
        return new URL(url).hostname;
    } catch {
        return UNPARSEABLE;
    }
}

/** The URL's path without its query or fragment, for logs that need to identify the file. */
export function urlPath(url: string): string {
    try {
        return new URL(url).pathname;
    } catch {
        return UNPARSEABLE;
    }
}

/** The response headers on the allowlist, for diagnosing a failed fetch. */
export function loggableHeaders(headers: Headers): Record<string, string> {
    const out: Record<string, string> = {};
    headers.forEach((value, key) => {
        if (LOGGABLE_HEADERS.has(key.toLowerCase())) out[key.toLowerCase()] = value;
    });
    return out;
}

/**
 * `text` with every URL's query string replaced by `?…`, and any loose
 * `Signature=` value blanked, so an error body that echoes the request
 * (S3 and CloudFront errors can) can be logged.
 */
export function redactQueries(text: string): string {
    return text
        .replace(/(https?:\/\/[^\s"'<>?#]+)\?[^\s"'<>#]*/g, "$1?…")
        .replace(/((?:x-amz-)?signature=)[^&\s"'<>]*/gi, "$1…");
}
