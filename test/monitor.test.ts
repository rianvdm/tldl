/**
 * Podcast Monitoring Tests
 *
 * Tests the monitoring logic for detecting and queuing new episodes.
 * Uses mocked services to avoid external API calls.
 *
 * Primary strategy: Podcast Index API (PI-first)
 * Fallback: RSS feed (when PI fails)
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { env } from "cloudflare:test";
import {
    saveMonitoredPodcast,
    getProcessedEpisodes,
    markEpisodesProcessed,
} from "../src/lib/kv";
import type { MonitoredPodcast, Env } from "../src/types";

// Mock external services used by monitor.ts
vi.mock("../src/services/rss", () => ({
    fetchAndParseFeed: vi.fn(),
    fetchTranscript: vi.fn(),
    // Default: simulate RSS error so tests exercise the PI fallback path
    fetchFeedIfChanged: vi.fn().mockResolvedValue({ status: "error", reason: "http_429" }),
}));

vi.mock("../src/services/podcast-index", () => ({
    lookupPodcastByItunesId: vi.fn(),
    getEpisodesByItunesId: vi.fn(),
}));

// Mock queue and DO to prevent actual queuing
vi.mock("../src/lib/queue", () => ({
    enqueueJob: vi.fn(),
    createProcessEpisodeMessage: vi.fn().mockReturnValue({
        type: "process_episode",
        jobId: "mock-job-id",
        episodeId: "mock-episode-id",
        appleUrl: "https://example.com",
        templateId: "key-takeaways",
    }),
}));

vi.mock("../src/lib/job-status-do", () => ({
    createJobDO: vi.fn(),
}));

// Import after mocking
import { fetchAndParseFeed, fetchFeedIfChanged } from "../src/services/rss";
import { getEpisodesByItunesId } from "../src/services/podcast-index";
import { checkPodcastForNewEpisodes } from "../src/lib/monitor";

// ============================================================================
// Test Environment Setup
// ============================================================================

function getTestEnv(): Env {
    return {
        ...env,
        OPENAI_API_KEY: "test-api-key",
        PODCAST_INDEX_KEY: "test-pi-key",
        PODCAST_INDEX_SECRET: "test-pi-secret",
    } as Env;
}

function createTestPodcast(overrides: Partial<MonitoredPodcast> = {}): MonitoredPodcast {
    return {
        id: "1809663079",
        name: "Test Podcast",
        rssUrl: "https://example.com/feed.xml",
        templateId: "key-takeaways",
        addedAt: "2025-12-01T00:00:00.000Z",
        episodesProcessed: 0,
        status: "active",
        ...overrides,
    };
}

async function clearMonitorData() {
    const prefixes = ["monitored:", "monitor:", "episode:", "job:"];
    for (const prefix of prefixes) {
        const keys = await env.TLDL_DATA.list({ prefix });
        await Promise.all(keys.keys.map((k) => env.TLDL_DATA.delete(k.name)));
    }
    // Also clear episodes index
    await env.TLDL_DATA.delete("episodes:index");
}

// ============================================================================
// Tests — PI-first strategy
// ============================================================================

describe("checkPodcastForNewEpisodes", () => {
    beforeEach(async () => {
        await clearMonitorData();
        vi.clearAllMocks();
    });

    it("queues new episode found via Podcast Index", async () => {
        const podcast = createTestPodcast();
        await saveMonitoredPodcast(env.TLDL_DATA, podcast);

        // PI returns one new episode
        vi.mocked(getEpisodesByItunesId).mockResolvedValue([
            {
                id: 999888,
                guid: "new-guid-1",
                title: "Brand New Episode",
                datePublished: Math.floor(new Date("2026-03-16T11:00:00.000Z").getTime() / 1000),
                duration: 1800,
                enclosureUrl: "https://example.com/new.mp3",
            },
        ]);

        const result = await checkPodcastForNewEpisodes(getTestEnv(), podcast);

        expect(result.newEpisodes).toBe(1);
        expect(result.queued).toContain("Brand New Episode");
        expect(result.errors).toHaveLength(0);

        // Should be marked as processed
        const processed = await getProcessedEpisodes(env.TLDL_DATA, podcast.id);
        expect(processed).toContain("new-guid-1");

        // RSS should NOT have been called (PI succeeded)
        expect(fetchAndParseFeed).not.toHaveBeenCalled();
    });

    it("reports no new episodes when all are already processed", async () => {
        const podcast = createTestPodcast();
        await saveMonitoredPodcast(env.TLDL_DATA, podcast);

        // All episodes already processed
        await markEpisodesProcessed(env.TLDL_DATA, podcast.id, ["guid-1", "guid-2"]);

        // PI returns the same episodes (filtered by since, but GUIDs match processed)
        vi.mocked(getEpisodesByItunesId).mockResolvedValue([
            {
                id: 111,
                guid: "guid-1",
                title: "Episode 1",
                datePublished: Math.floor(new Date("2026-03-15T11:00:00.000Z").getTime() / 1000),
                duration: 1800,
                enclosureUrl: "https://example.com/1.mp3",
            },
            {
                id: 222,
                guid: "guid-2",
                title: "Episode 2",
                datePublished: Math.floor(new Date("2026-03-14T11:00:00.000Z").getTime() / 1000),
                duration: 1800,
                enclosureUrl: "https://example.com/2.mp3",
            },
        ]);

        const result = await checkPodcastForNewEpisodes(getTestEnv(), podcast);

        expect(result.newEpisodes).toBe(0);
        expect(result.errors).toHaveLength(0);
    });

    it("marks episode processed when it already exists in KV", async () => {
        const podcast = createTestPodcast();
        await saveMonitoredPodcast(env.TLDL_DATA, podcast);

        vi.mocked(getEpisodesByItunesId).mockResolvedValue([
            {
                id: 111222,
                guid: "existing-guid",
                title: "Already Processed Episode",
                datePublished: Math.floor(new Date("2026-03-15T11:00:00.000Z").getTime() / 1000),
                duration: 1800,
                enclosureUrl: "https://example.com/existing.mp3",
            },
        ]);

        // Pre-save the episode in KV so it's treated as "already exists"
        const episodeId = `${podcast.id}_111222`;
        await env.TLDL_DATA.put(
            `episode:${episodeId}`,
            JSON.stringify({
                id: episodeId,
                podcastName: "Test Podcast",
                episodeTitle: "Already Processed Episode",
            }),
            { expirationTtl: 86400 }
        );

        const result = await checkPodcastForNewEpisodes(getTestEnv(), podcast);

        // Should not queue (already exists)
        expect(result.newEpisodes).toBe(0);

        // Should be marked as processed
        const processed = await getProcessedEpisodes(env.TLDL_DATA, podcast.id);
        expect(processed).toContain("existing-guid");
    });

    it("falls back to RSS when Podcast Index is rate-limited", async () => {
        const podcast = createTestPodcast();
        await saveMonitoredPodcast(env.TLDL_DATA, podcast);

        const { AppError } = await import("../src/lib/errors");
        const { ERROR_CODES } = await import("../src/lib/constants");

        // First call (PI-first): rate limited
        // Second call (RSS fallback PI lookup): returns the episode
        vi.mocked(getEpisodesByItunesId)
            .mockRejectedValueOnce(new AppError(ERROR_CODES.RATE_LIMITED, "Rate limited"))
            .mockResolvedValueOnce([
                {
                    id: 999888,
                    guid: "new-guid-1",
                    title: "Brand New Episode",
                    datePublished: Math.floor(new Date("2026-03-16T11:00:00.000Z").getTime() / 1000),
                    duration: 1800,
                    enclosureUrl: "https://example.com/new.mp3",
                },
            ]);

        // RSS feed for fallback
        vi.mocked(fetchAndParseFeed).mockResolvedValue({
            title: "Test Podcast",
            episodes: [
                {
                    guid: "new-guid-1",
                    title: "Brand New Episode",
                    pubDate: "2026-03-16T11:00:00.000Z",
                    audioUrl: "https://example.com/new.mp3",
                    duration: 1800,
                },
            ],
        });

        const result = await checkPodcastForNewEpisodes(getTestEnv(), podcast);

        expect(result.newEpisodes).toBe(1);
        expect(result.queued).toContain("Brand New Episode");
        // RSS should have been called as fallback
        expect(fetchAndParseFeed).toHaveBeenCalled();
    });
});
