/**
 * Cloudflare Turnstile verification helper
 * Used for spam protection on the waitlist form
 */

interface TurnstileVerifyResponse {
    success: boolean;
    "error-codes"?: string[];
    challenge_ts?: string;
    hostname?: string;
}

/**
 * Verify a Turnstile token with Cloudflare's API
 * @param token - The cf-turnstile-response token from the form
 * @param secret - The Turnstile secret key
 * @returns true if verification succeeded, false otherwise
 */
export async function verifyTurnstile(token: string, secret: string): Promise<boolean> {
    if (!token) {
        console.log(JSON.stringify({ event: "turnstile_no_token" }));
        return false;
    }

    try {
        const response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                secret,
                response: token
            })
        });

        const result = await response.json() as TurnstileVerifyResponse;

        console.log(JSON.stringify({
            event: "turnstile_verification_result",
            success: result.success,
            errorCodes: result["error-codes"],
            hostname: result.hostname
        }));

        return result.success;
    } catch (error) {
        console.error(
            JSON.stringify({
                event: "turnstile_verification_error",
                error: error instanceof Error ? error.message : "Unknown error"
            })
        );
        return false;
    }
}

/**
 * Simple email validation using regex
 * @param email - The email address to validate
 * @returns true if email format is valid
 */
export function isValidEmail(email: string): boolean {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}
