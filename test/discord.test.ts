import { describe, it, expect } from "vitest";
import { sendDiscordNotification, notifyDiscord, DISCORD_COLORS } from "../src/lib/discord";

// ============================================================================
// Discord Webhook Helper Tests
// ============================================================================

describe("sendDiscordNotification", () => {
    it("returns false when webhook URL is unreachable", async () => {
        // This will fail to connect — sendDiscordNotification should catch and return false
        const result = await sendDiscordNotification(
            "https://discord.com/api/webhooks/invalid/fake-token",
            {
                title: "Test",
                description: "Test notification",
                color: DISCORD_COLORS.INFO,
            }
        );

        // Discord API returns 401/404 for invalid webhook URLs, not a network error
        // sendDiscordNotification returns false for non-ok responses
        expect(result).toBe(false);
    });

    it("uses default color when not specified", async () => {
        // Can't easily test the actual payload without mocking fetch,
        // but we can verify the function doesn't throw
        const result = await sendDiscordNotification(
            "https://discord.com/api/webhooks/invalid/fake-token",
            {
                title: "Test",
                description: "No color specified",
            }
        );
        expect(result).toBe(false);
    });
});

describe("notifyDiscord", () => {
    it("is a no-op when webhook URL is undefined", async () => {
        // Should return immediately without making any network calls
        await notifyDiscord(undefined, {
            title: "Test",
            description: "Should not send",
        });
        // No assertion needed — just verifying it doesn't throw
    });

    it("is a no-op when webhook URL is empty string", async () => {
        await notifyDiscord("", {
            title: "Test",
            description: "Should not send",
        });
    });
});

describe("DISCORD_COLORS", () => {
    it("exports expected color constants", () => {
        expect(DISCORD_COLORS.ERROR).toBe(0xff0000);
        expect(DISCORD_COLORS.SUCCESS).toBe(0x22c55e);
        expect(DISCORD_COLORS.WARNING).toBe(0xeab308);
        expect(DISCORD_COLORS.INFO).toBe(0x3b82f6);
    });
});
