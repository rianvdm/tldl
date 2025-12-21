/**
 * Tests for authentication utilities
 */

import { describe, it, expect } from "vitest";
import { getUserEmailFromJwt, escapeHtml } from "../src/lib/auth";

describe("getUserEmailFromJwt", () => {
    // Helper to create a mock JWT with a given payload
    function createMockJwt(payload: object): string {
        const header = btoa(JSON.stringify({ alg: "RS256", typ: "JWT" }));
        const body = btoa(JSON.stringify(payload));
        const signature = "mock-signature";
        return `${header}.${body}.${signature}`;
    }

    it("should extract email from valid JWT", () => {
        const jwt = createMockJwt({ email: "user@example.com", sub: "123" });
        expect(getUserEmailFromJwt(jwt)).toBe("user@example.com");
    });

    it("should return null for malformed JWT (wrong number of parts)", () => {
        expect(getUserEmailFromJwt("invalid")).toBeNull();
        expect(getUserEmailFromJwt("one.two")).toBeNull();
        expect(getUserEmailFromJwt("one.two.three.four")).toBeNull();
    });

    it("should return null for invalid base64", () => {
        expect(getUserEmailFromJwt("a.!!!.c")).toBeNull();
    });

    it("should return null when email is not a string", () => {
        const jwt = createMockJwt({ email: 123, sub: "123" });
        expect(getUserEmailFromJwt(jwt)).toBeNull();
    });

    it("should return null when email is missing", () => {
        const jwt = createMockJwt({ sub: "123", name: "User" });
        expect(getUserEmailFromJwt(jwt)).toBeNull();
    });

    it("should return null when payload is not valid JSON", () => {
        const header = btoa(JSON.stringify({ alg: "RS256" }));
        const invalidBody = btoa("not-json");
        expect(getUserEmailFromJwt(`${header}.${invalidBody}.sig`)).toBeNull();
    });
});

describe("escapeHtml", () => {
    it("should escape angle brackets", () => {
        expect(escapeHtml("<script>")).toBe("&lt;script&gt;");
    });

    it("should escape ampersands", () => {
        expect(escapeHtml("a & b")).toBe("a &amp; b");
    });

    it("should escape double quotes", () => {
        expect(escapeHtml('say "hello"')).toBe("say &quot;hello&quot;");
    });

    it("should escape single quotes", () => {
        expect(escapeHtml("it's fine")).toBe("it&#039;s fine");
    });

    it("should handle multiple special characters", () => {
        expect(escapeHtml('<a href="test">O\'Brien & Co</a>')).toBe(
            "&lt;a href=&quot;test&quot;&gt;O&#039;Brien &amp; Co&lt;/a&gt;"
        );
    });

    it("should return empty string for empty input", () => {
        expect(escapeHtml("")).toBe("");
    });

    it("should not modify plain text", () => {
        expect(escapeHtml("Hello World")).toBe("Hello World");
    });
});
