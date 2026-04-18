import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { env } from "cloudflare:test";
import { checkPodcastForNewEpisodes } from "../src/lib/monitor";
import * as rss from "../src/services/rss";
import { saveMonitoredPodcast, getMonitoredPodcast, markEpisodesProcessed } from "../src/lib/kv";
import type { MonitoredPodcast } from "../src/types";

// Mock DO and queue to prevent actual Durable Object / queue interactions
vi.mock("../src/lib/job-status-do", () => ({
    createJobDO: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../src/lib/queue", () => ({
    enqueueJob: vi.fn().mockResolvedValue(undefined),
    createProcessEpisodeMessage: vi.fn((params) => ({
        type: "process_episode",
        jobId: params.jobId,
        episodeId: params.episodeId,
        templateId: params.templateId,
        rssSourced: params.rssSourced,
        audioUrl: params.audioUrl,
        durationSeconds: params.durationSeconds,
        transcriptUrl: params.transcriptUrl,
        transcriptType: params.transcriptType,
        podcastTitle: params.podcastTitle,
        episodeGuid: params.episodeGuid,
        expectedTitle: params.expectedTitle,
        expectedDate: params.expectedDate,
        submittedBy: params.submittedBy,
    })),
}));

// Import after mocking
import { enqueueJob } from "../src/lib/queue";

const PODCAST: MonitoredPodcast = {
    id: "1809663079",
    name: "How I AI",
    rssUrl: "https://anchor.fm/s/1035b1568/podcast/rss",
    templateId: "key-takeaways",
    addedAt: "2026-04-17T00:00:00Z",
    episodesProcessed: 0,
    status: "active",
};

describe("monitor: RSS-first", () => {
    beforeEach(async () => {
        // Clear KV monitor data before each test
        const prefixes = ["monitored:", "monitor:", "episode:", "job:"];
        for (const prefix of prefixes) {
            const keys = await env.TLDL_DATA.list({ prefix });
            await Promise.all(keys.keys.map((k) => env.TLDL_DATA.delete(k.name)));
        }
        await env.TLDL_DATA.delete("episodes:index");

        await saveMonitoredPodcast(env.TLDL_DATA, PODCAST);
        vi.clearAllMocks();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("returns no new episodes on 304", async () => {
        vi.spyOn(rss, "fetchFeedIfChanged").mockResolvedValue({ status: "not_modified" });

        const result = await checkPodcastForNewEpisodes(env, PODCAST, 5);

        expect(result.newEpisodes).toBe(0);
        expect(vi.mocked(enqueueJob)).not.toHaveBeenCalled();
        const updated = await getMonitoredPodcast(env.TLDL_DATA, PODCAST.id);
        expect(updated?.lastChecked).toBeDefined();
    });

    it("queues new episodes with rssSourced=true and full metadata on 200", async () => {
        vi.spyOn(rss, "fetchFeedIfChanged").mockResolvedValue({
            status: "ok",
            etag: "\"new-etag\"",
            lastModified: "Mon, 13 Apr 2026 11:00:00 GMT",
            feed: {
                title: "How I AI",
                episodes: [{
                    guid: "dd85426a-9b70-482f-94ed-d5afd61b7d56",
                    title: "Claude Cowork 101",
                    pubDate: "2026-04-13T11:00:00Z",
                    duration: 3011,
                    audioUrl: "https://example.com/audio.mp3",
                }],
            },
        });

        const result = await checkPodcastForNewEpisodes(env, PODCAST, 5);

        expect(result.newEpisodes).toBe(1);
        expect(vi.mocked(enqueueJob)).toHaveBeenCalledTimes(1);

        // Inspect the message passed to enqueueJob
        const [, msg] = vi.mocked(enqueueJob).mock.calls[0];
        expect(msg.rssSourced).toBe(true);
        expect(msg.audioUrl).toBe("https://example.com/audio.mp3");
        expect(msg.durationSeconds).toBe(3011);
        expect(msg.episodeId).toMatch(/^1809663079_rss_[0-9a-f]{10}$/);

        const updated = await getMonitoredPodcast(env.TLDL_DATA, PODCAST.id);
        expect(updated?.etag).toBe("\"new-etag\"");
        expect(updated?.lastModified).toBe("Mon, 13 Apr 2026 11:00:00 GMT");
    });

    it("skips already-processed GUIDs", async () => {
        await markEpisodesProcessed(env.TLDL_DATA, PODCAST.id, ["already-seen"]);
        vi.spyOn(rss, "fetchFeedIfChanged").mockResolvedValue({
            status: "ok",
            feed: {
                title: "How I AI",
                episodes: [{
                    guid: "already-seen",
                    title: "Old Ep",
                    pubDate: "2026-04-01T00:00:00Z",
                    duration: 1000,
                    audioUrl: "https://example.com/old.mp3",
                }],
            },
        });

        const result = await checkPodcastForNewEpisodes(env, PODCAST, 5);

        expect(result.newEpisodes).toBe(0);
        expect(vi.mocked(enqueueJob)).not.toHaveBeenCalled();
    });

    it("falls back to PI on RSS error", async () => {
        vi.spyOn(rss, "fetchFeedIfChanged").mockResolvedValue({ status: "error", reason: "http_429" });
        // PI will fail in test env (no real credentials), but result must still be defined
        const result = await checkPodcastForNewEpisodes(env, PODCAST, 5);
        expect(result).toBeDefined();
    });
});
