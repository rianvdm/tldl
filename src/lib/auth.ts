/**
 * Authentication utilities for Cloudflare Access JWT handling
 */

import { ADMIN_EMAILS } from "./constants";

/**
 * Check if the given email belongs to an admin user.
 * Admin users can view and delete all episodes.
 *
 * @param email - User email to check
 * @returns true if the email is in ADMIN_EMAILS
 */
export function isAdminUser(email: string | undefined): boolean {
    if (!email) return false;
    return ADMIN_EMAILS.includes(email);
}

/**
 * Extract user email from Cloudflare Access JWT.
 * CF Access validates the signature, we just decode and validate the payload structure.
 *
 * @param jwt - The Cf-Access-Jwt-Assertion header value
 * @returns The email from the JWT payload, or null if invalid/missing
 */
export function getUserEmailFromJwt(jwt: string): string | null {
    try {
        const parts = jwt.split(".");
        if (parts.length !== 3) return null;

        const payload = JSON.parse(atob(parts[1]));
        if (typeof payload?.email !== "string") return null;

        return payload.email;
    } catch {
        return null;
    }
}

/**
 * Escape HTML special characters to prevent XSS
 *
 * @param text - Raw text to escape
 * @returns HTML-safe string
 */
export function escapeHtml(text: string): string {
    return text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}
