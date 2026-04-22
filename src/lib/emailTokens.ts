/**
 * HMAC-SHA-256 signing for stateless manage / unsubscribe tokens.
 *
 * Tokens are 32 hex chars (128 bits) — first half of a full SHA-256 HMAC.
 * Verification uses a pure-JS XOR accumulator. `crypto.subtle.timingSafeEqual`
 * is a Cloudflare Workers extension (not Web Crypto), so it breaks Vitest
 * tests running outside the Workers pool.
 */

export function manageMessage(subscriberId: number, email: string): string {
    return `manage|${subscriberId}|${email.toLowerCase()}`;
}

export function unsubMessage(subscriberId: number, podcastId: string): string {
    return `unsub|${subscriberId}|${podcastId}`;
}

export function unsubAllMessage(subscriberId: number): string {
    return `unsuball|${subscriberId}`;
}

export async function signToken(secret: string, message: string): Promise<string> {
    const key = await crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(secret),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"]
    );
    const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
    const hex = bufferToHex(sig);
    return hex.slice(0, 32);
}

export async function verifyToken(secret: string, message: string, token: string): Promise<boolean> {
    if (token.length !== 32) return false;
    const expected = await signToken(secret, message);
    return constantTimeEqual(expected, token);
}

export function constantTimeEqual(a: string, b: string): boolean {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return diff === 0;
}

function bufferToHex(buffer: ArrayBuffer): string {
    const bytes = new Uint8Array(buffer);
    let hex = "";
    for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, "0");
    return hex;
}
