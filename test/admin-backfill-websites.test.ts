/**
 * The admin backfill tools that set podcastWebsiteUrl must apply the same
 * rules as ingest (lib/podcast-links.ts): never store an Apple listing or
 * feed URL as the website, and never clobber a valid website already set.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { env, SELF } from "cloudflare:test";

vi.mock("../src/services/podcast-index", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../src/services/podcast-index")>();
    return { ...actual, lookupPodcastByItunesId: vi.fn() };
});

import { lookupPodcastByItunesId } from "../src/services/podcast-index";
import { saveEpisode, getEpisode, rebuildEpisodeIndex, saveMonitoredPodcast, addToMonitoredList } from "../src/lib/kv";
import type { Episode } from "../src/types";

const APPLE_LISTING = "https://podcasts.apple.com/us/podcast/hbr-on-leadership/id1683948659";

function episode(overrides: Partial<Episode> = {}): Episode {
    return {
        id: "1683948659_1000700000001",
        appleUrl: "https://podcasts.apple.com/us/podcast/x/id1683948659?i=1000700000001",
        podcastName: "HBR On Leadership",
        episodeTitle: "Episode",
        episodeDuration: 1800,
        episodeDate: "2026-06-01T00:00:00.000Z",
        audioUrl: "https://example.com/a.mp3",
        transcriptSource: "openai",
        createdAt: "2026-06-01T00:00:00.000Z",
        expiresAt: "2027-06-01T00:00:00.000Z",
        ...overrides,
    };
}

async function seed(ep: Episode): Promise<void> {
    await saveEpisode(env.TLDL_DATA, ep);
    await rebuildEpisodeIndex(env.TLDL_DATA);
}

function post(path: string): Promise<Response> {
    return SELF.fetch(`http://localhost/admin/${path}`, { method: "POST" });
}

beforeEach(async () => {
    for (const prefix of ["episode:", "episodes:", "monitored:"]) {
        const { keys } = await env.TLDL_DATA.list({ prefix });
        await Promise.all(keys.map(k => env.TLDL_DATA.delete(k.name)));
    }
    vi.mocked(lookupPodcastByItunesId).mockReset();
});

describe("POST /admin/backfill-podcast-info", () => {
    function podcastIndexReturns(link: string) {
        vi.mocked(lookupPodcastByItunesId).mockResolvedValue({
            id: 1, url: "https://feeds.example.com/x.rss", title: "HBR On Leadership", itunesId: 1683948659,
            author: "HBR", link,
        });
    }

    it("does not store Podcast Index's link when it is an Apple listing", async () => {
        await seed(episode());
        podcastIndexReturns(APPLE_LISTING);

        expect((await post("backfill-podcast-info")).status).toBe(200);

        const saved = await getEpisode(env.TLDL_DATA, episode().id);
        expect(saved?.podcastAuthor).toBe("HBR");
        expect(saved?.podcastWebsiteUrl).toBeUndefined();
    });

    it("keeps a valid website already on the episode", async () => {
        await seed(episode({ podcastWebsiteUrl: "https://hbr.org/podcasts/on-leadership" }));
        podcastIndexReturns("https://example.com/somewhere-else");

        await post("backfill-podcast-info");

        const saved = await getEpisode(env.TLDL_DATA, episode().id);
        expect(saved?.podcastWebsiteUrl).toBe("https://hbr.org/podcasts/on-leadership");
    });
});

describe("POST /admin/backfill-episode-podcast-metadata", () => {
    it("does not copy an Apple listing from the monitored podcast as the website", async () => {
        await saveMonitoredPodcast(env.TLDL_DATA, {
            id: "1683948659", name: "HBR On Leadership", rssUrl: "https://example.com/feed.xml",
            templateId: "key-takeaways", addedAt: "2026-01-01T00:00:00Z", episodesProcessed: 0,
            status: "active", author: "HBR", websiteUrl: APPLE_LISTING,
        });
        await addToMonitoredList(env.TLDL_DATA, "1683948659");
        await seed(episode());

        expect((await post("backfill-episode-podcast-metadata")).status).toBe(200);

        const saved = await getEpisode(env.TLDL_DATA, episode().id);
        expect(saved?.podcastAuthor).toBe("HBR");
        expect(saved?.podcastWebsiteUrl).toBeUndefined();
    });
});
