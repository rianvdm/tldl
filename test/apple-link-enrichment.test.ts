import { describe, it, expect, vi, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import type { Env, Episode } from "../src/types";
import { saveEpisode, getEpisode, addToEpisodeIndex } from "../src/lib/kv";

vi.mock("../src/services/apple-show-page", () => ({
    fetchAppleEpisodeUrls: vi.fn(),
}));

import { fetchAppleEpisodeUrls } from "../src/services/apple-show-page";
import { enrichAppleEpisodeLinks } from "../src/lib/apple-link-enrichment";

const NOW = new Date("2026-11-07T14:00:00.000Z");
const SHOW_URL = "https://podcasts.apple.com/us/podcast/id1011668648";
const EPISODE_URL = "https://podcasts.apple.com/us/podcast/ai-broke/id1011668648?i=1000800393703";

function daysAgo(days: number): string {
    return new Date(NOW.getTime() - days * 86_400_000).toISOString();
}

async function seed(overrides: Partial<Episode> & { id: string }): Promise<void> {
    const episode: Episode = {
        appleUrl: SHOW_URL,
        podcastName: "Decoder",
        episodeTitle: overrides.id,
        episodeDuration: 3000,
        episodeDate: daysAgo(1),
        audioUrl: `https://example.com/${overrides.id}.mp3`,
        transcriptSource: "openai",
        createdAt: daysAgo(1),
        expiresAt: daysAgo(-364),
        ...overrides,
    };
    await saveEpisode(env.TLDL_DATA, episode);
    await addToEpisodeIndex(env.TLDL_DATA, {
        id: episode.id,
        podcastName: episode.podcastName,
        episodeTitle: episode.episodeTitle,
        episodeDate: episode.episodeDate,
        episodeDuration: episode.episodeDuration,
        createdAt: episode.createdAt,
        expiresAt: episode.expiresAt,
    });
}

const testEnv = () => env as unknown as Env;

describe("enrichAppleEpisodeLinks", () => {
    beforeEach(async () => {
        vi.mocked(fetchAppleEpisodeUrls).mockReset();
        const { keys } = await env.TLDL_DATA.list({ prefix: "episode:" });
        await Promise.all(keys.map(k => env.TLDL_DATA.delete(k.name)));
        await env.TLDL_DATA.delete("episodes:index");
    });

    it("replaces a show-level Apple URL with the episode URL Apple lists for its GUID", async () => {
        await seed({ id: "1011668648_rss_aaaaaaaaaa", episodeGuid: "guid-a" });
        vi.mocked(fetchAppleEpisodeUrls).mockResolvedValue(new Map([["guid-a", EPISODE_URL]]));

        const result = await enrichAppleEpisodeLinks(testEnv(), NOW);

        expect((await getEpisode(env.TLDL_DATA, "1011668648_rss_aaaaaaaaaa"))?.appleUrl).toBe(EPISODE_URL);
        expect(result).toMatchObject({ pending: 1, updated: 1 });
    });

    it("leaves the episode alone when Apple does not list its GUID yet", async () => {
        await seed({ id: "1011668648_rss_bbbbbbbbbb", episodeGuid: "guid-b" });
        vi.mocked(fetchAppleEpisodeUrls).mockResolvedValue(new Map([["someone-else", EPISODE_URL]]));

        const result = await enrichAppleEpisodeLinks(testEnv(), NOW);

        expect((await getEpisode(env.TLDL_DATA, "1011668648_rss_bbbbbbbbbb"))?.appleUrl).toBe(SHOW_URL);
        expect(result).toMatchObject({ pending: 1, updated: 0 });
    });

    it("fetches each podcast's show page once, however many episodes are pending", async () => {
        await seed({ id: "1011668648_rss_cccccccccc", episodeGuid: "guid-c" });
        await seed({ id: "1011668648_rss_dddddddddd", episodeGuid: "guid-d" });
        vi.mocked(fetchAppleEpisodeUrls).mockResolvedValue(new Map());

        await enrichAppleEpisodeLinks(testEnv(), NOW);

        expect(fetchAppleEpisodeUrls).toHaveBeenCalledTimes(1);
        expect(fetchAppleEpisodeUrls).toHaveBeenCalledWith("1011668648");
    });

    it("does not fetch for episodes that need nothing or are past the window", async () => {
        await seed({ id: "1011668648_rss_eeeeeeeeee", episodeGuid: "guid-e", appleUrl: EPISODE_URL });
        await seed({ id: "1011668648_rss_ffffffffff" }); // no GUID to match on
        await seed({ id: "1011668648_rss_gggggggggg", episodeGuid: "guid-g", createdAt: daysAgo(30) });

        const result = await enrichAppleEpisodeLinks(testEnv(), NOW);

        expect(fetchAppleEpisodeUrls).not.toHaveBeenCalled();
        expect(result).toMatchObject({ pending: 0, updated: 0 });
    });
});
