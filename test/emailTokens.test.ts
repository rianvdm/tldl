import { describe, it, expect } from "vitest";
import {
    signToken,
    verifyToken,
    constantTimeEqual,
    manageMessage,
    unsubMessage,
    unsubAllMessage,
} from "../src/lib/emailTokens";

const SECRET = "secret-key-for-testing-only-32b!";

describe("emailTokens", () => {
    it("sign/verify round-trip for manage link", async () => {
        const msg = manageMessage(42, "alice@example.com");
        const token = await signToken(SECRET, msg);
        expect(token).toMatch(/^[0-9a-f]{32}$/);
        expect(await verifyToken(SECRET, msg, token)).toBe(true);
    });

    it("sign/verify round-trip for unsub podcast", async () => {
        const msg = unsubMessage(7, "p1");
        const token = await signToken(SECRET, msg);
        expect(await verifyToken(SECRET, msg, token)).toBe(true);
    });

    it("sign/verify round-trip for unsub all", async () => {
        const msg = unsubAllMessage(7);
        const token = await signToken(SECRET, msg);
        expect(await verifyToken(SECRET, msg, token)).toBe(true);
    });

    it("rejects tokens signed with a different secret", async () => {
        const msg = manageMessage(42, "alice@example.com");
        const token = await signToken(SECRET, msg);
        expect(await verifyToken("different-secret", msg, token)).toBe(false);
    });

    it("rejects tampered messages", async () => {
        const msg = manageMessage(42, "alice@example.com");
        const token = await signToken(SECRET, msg);
        const tamperedMsg = manageMessage(43, "alice@example.com");
        expect(await verifyToken(SECRET, tamperedMsg, token)).toBe(false);
    });

    it("rejects tokens of the wrong length", async () => {
        const msg = manageMessage(42, "alice@example.com");
        expect(await verifyToken(SECRET, msg, "short")).toBe(false);
        expect(await verifyToken(SECRET, msg, "0".repeat(64))).toBe(false);
    });

    it("constantTimeEqual returns true for equal strings", () => {
        expect(constantTimeEqual("abc123", "abc123")).toBe(true);
    });

    it("constantTimeEqual returns false for different strings", () => {
        expect(constantTimeEqual("abc123", "abc124")).toBe(false);
        expect(constantTimeEqual("abc", "abcd")).toBe(false);
    });

    it("manageMessage normalises email to lowercase", () => {
        expect(manageMessage(1, "Foo@Bar.COM")).toBe(manageMessage(1, "foo@bar.com"));
    });
});
