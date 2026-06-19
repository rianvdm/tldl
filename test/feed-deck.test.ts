/**
 * Tests for surfacing the episode deck in the RSS feed (issue #43).
 *
 * All three feed variants (/feed, /feed?tag=, /podcasts/:id/feed) funnel through
 * the shared enrichWithSummaries + buildRssFeed path, so exercising the global
 * /feed route covers the behavior for every variant.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { env, SELF } from "cloudflare:test";
import { saveEpisode, saveSummary } from "../src/lib/kv";
import type { Episode, Summary } from "../src/types";

async function clearTestData() {
    // "episodes:" catches the index key; "episode:" catches individual records.
    const prefixes = ["episode:", "episodes:", "transcript:", "summary:"];
    for (const prefix of prefixes) {
        const keys = await env.TLDL_DATA.list({ prefix });
        await Promise.all(keys.keys.map((k) => env.TLDL_DATA.delete(k.name)));
    }
}

function sampleEpisode(overrides: Partial<Episode> = {}): Episode {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000);
    return {
        id: "111_222",
        appleUrl: "https://podcasts.apple.com/us/podcast/test/id111?i=222",
        podcastName: "Test Podcast",
        episodeTitle: "Test Episode",
        episodeDuration: 2700,
        episodeDate: "2024-01-15",
        audioUrl: "https://example.com/audio.mp3",
        transcriptSource: "rss",
        createdAt: now.toISOString(),
        expiresAt: expiresAt.toISOString(),
        ...overrides,
    };
}

function sampleSummary(overrides: Partial<Summary> = {}): Summary {
    return {
        episodeId: "111_222",
        templateId: "key-takeaways",
        text: "# Key Takeaways\n\nSummarybody marker with details about the topic.",
        model: "gpt-5.2",
        createdAt: new Date().toISOString(),
        ...overrides,
    };
}

// Isolate the single feed <item> so assertions don't accidentally match the
// channel-level <description>.
function itemXml(feed: string): string {
    const start = feed.indexOf("<item>");
    return start === -1 ? "" : feed.slice(start);
}

describe("RSS feed deck (issue #43)", () => {
    beforeEach(async () => {
        await clearTestData();
    });

    it("uses the deck as <description> and includes it in <content:encoded> when present", async () => {
        const deck = "Deckblurb marker summarizing the conversation in one line.";
        await saveEpisode(env.TLDL_DATA, sampleEpisode({ deck }));
        await saveSummary(env.TLDL_DATA, sampleSummary());

        const res = await SELF.fetch("http://localhost/feed");
        expect(res.status).toBe(200);

        const item = itemXml(await res.text());

        // The deck — a clean 1-2 sentence blurb — becomes the item description,
        // improving readers that only render <description>.
        expect(item).toContain(`<description>${deck}</description>`);

        // content:encoded leads with the deck, then still carries the summary body.
        expect(item).toContain(deck);
        expect(item).toContain("Summarybody marker");
    });

    it("degrades gracefully when an episode has no deck", async () => {
        // Pre-redesign episodes have no deck (Episode.deck is optional).
        await saveEpisode(env.TLDL_DATA, sampleEpisode({ deck: undefined }));
        await saveSummary(env.TLDL_DATA, sampleSummary());

        const res = await SELF.fetch("http://localhost/feed");
        expect(res.status).toBe(200);

        const item = itemXml(await res.text());

        // <description> falls back to the stripped summary excerpt (current behavior).
        expect(item).toContain("Summarybody marker");
        // No empty deck paragraph leaks into content:encoded.
        expect(item).not.toContain("<p></p>");
    });
});
