import { describe, it, expect } from "vitest";
import { cardVersion, episodeCardUrl, toCardModel } from "../src/lib/og/card-model";
import type { Episode } from "../src/types";

function episode(overrides: Partial<Episode> = {}): Episode {
    return {
        id: "1769051199_rss_43abc3ee50",
        appleUrl: "https://podcasts.apple.com/us/podcast/scaling-slack/id1769051199?i=1000800061661",
        podcastName: "The Pragmatic Engineer",
        episodeTitle: "Scaling Slack and GitHub with Maude Lemaire",
        episodeDuration: 3600,
        episodeDate: "2026-11-05T15:58:00.000Z",
        audioUrl: "https://example.com/a.mp3",
        transcriptSource: "openai",
        createdAt: "2026-11-05T16:30:00.000Z",
        expiresAt: "2027-11-05T16:30:00.000Z",
        ...overrides,
    };
}

describe("toCardModel", () => {
    it("builds kicker, title, deck and runtime", () => {
        const m = toCardModel(episode({ podcastName: "Lenny's Podcast", episodeDate: "2026-11-18T10:00:00Z",
            episodeTitle: "Deciding what not to build", deck: "A deck.", episodeDuration: 4320 }));
        expect(m).toEqual({ kicker: "LENNY'S PODCAST — NOV 18, 2026", title: "Deciding what not to build",
            deck: "A deck.", runtime: "1H 12M" });
    });

    it("drops runtime when duration is 0", () => expect(toCardModel(episode({ episodeDuration: 0 })).runtime).toBeNull());

    it("formats runtime like the detail page", () => {
        expect(toCardModel(episode({ episodeDuration: 2700 })).runtime).toBe("45M");
        expect(toCardModel(episode({ episodeDuration: 7500 })).runtime).toBe("2H 05M");
    });

    it("treats a missing or blank deck as no deck", () => {
        expect(toCardModel(episode({ deck: undefined })).deck).toBeNull();
        expect(toCardModel(episode({ deck: "   " })).deck).toBeNull();
    });

    it("strips emoji and collapses whitespace", () =>
        expect(toCardModel(episode({ episodeTitle: "AI 🤖  agents 👨‍👩‍👧 now" })).title).toBe("AI agents now"));

    it("falls back to the podcast name when the title is only emoji", () =>
        expect(toCardModel(episode({ podcastName: "Pod", episodeTitle: "🎙️🔥" })).title).toBe("Pod"));

    it.each([
        ["a skin-tone modifier", "🧑🏽"],
        ["a flag", "🇺🇸"],
        ["a keycap", "1️⃣"],
    ])("strips the whole of %s", (_, emoji) => {
        expect(toCardModel(episode({ episodeTitle: `Top ${emoji} picks` })).title).toBe("Top picks");
        expect(toCardModel(episode({ podcastName: "Pod", episodeTitle: emoji })).title).toBe("Pod");
    });

    it("falls back to TL;DL when the title and podcast name are both only emoji", () =>
        expect(toCardModel(episode({ podcastName: "🎙️", episodeTitle: "🔥" })).title).toBe("TL;DL"));

    it("omits the date from the kicker when episodeDate does not parse", () =>
        expect(toCardModel(episode({ podcastName: "Pod", episodeDate: "not a date" })).kicker).toBe("POD"));
});

describe("cardVersion", () => {
    it("cardVersion is 12 hex chars and stable", async () => {
        const a = await cardVersion(episode()); expect(a).toMatch(/^[0-9a-f]{12}$/);
        expect(await cardVersion(episode())).toBe(a);
    });

    it.each(["episodeTitle", "podcastName", "deck", "episodeDate", "episodeDuration"] as const)(
        "cardVersion changes when %s changes", async (field) => {
            const base = episode({ deck: "d" });
            const changed = { ...base, [field]: field === "episodeDuration" ? 1 : "changed" };
            expect(await cardVersion(changed)).not.toBe(await cardVersion(base));
        });

    it("cardVersion ignores fields not drawn on the card", async () =>
        expect(await cardVersion(episode({ tags: ["ai"], pullQuote: "q" }))).toBe(await cardVersion(episode())));
});

describe("episodeCardUrl", () => {
    it("builds the card URL", () =>
        expect(episodeCardUrl("a b", "abc123abc123")).toBe("https://tldl-pod.com/og/episode/a%20b.png?v=abc123abc123"));
});
