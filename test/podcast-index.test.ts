/**
 * Tests for Podcast Index API Service
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
    lookupPodcastByItunesId,
    getEpisodesByItunesId,
    findEpisodeByAppleId,
    type PodcastIndexEpisode,
} from "../src/services/podcast-index";

describe("lookupPodcastByItunesId", () => {
    beforeEach(() => {
        vi.restoreAllMocks();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("should return podcast info for valid iTunes ID", async () => {
        const mockResponse = {
            status: "true",
            feed: {
                id: 123456,
                url: "https://feeds.example.com/podcast.rss",
                title: "Test Podcast",
                itunesId: 12345,
            },
        };

        vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
            new Response(JSON.stringify(mockResponse), { status: 200 })
        );

        const result = await lookupPodcastByItunesId("12345", "test-key", "test-secret");

        expect(result).toEqual({
            id: 123456,
            url: "https://feeds.example.com/podcast.rss",
            title: "Test Podcast",
            itunesId: 12345,
        });

        expect(fetch).toHaveBeenCalledWith(
            "https://api.podcastindex.org/api/1.0/podcasts/byitunesid?id=12345",
            expect.objectContaining({
                headers: expect.objectContaining({
                    "X-Auth-Key": "test-key",
                    "User-Agent": "TLDL/1.0 (Podcast Summary Service)",
                }),
            })
        );
    });

    it("should return null when podcast not found", async () => {
        const mockResponse = {
            status: "false",
        };

        vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
            new Response(JSON.stringify(mockResponse), { status: 200 })
        );

        const result = await lookupPodcastByItunesId("99999999", "test-key", "test-secret");

        expect(result).toBeNull();
    });

    it("should return null on API error", async () => {
        vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
            new Response("Server error", { status: 500 })
        );

        const result = await lookupPodcastByItunesId("12345", "test-key", "test-secret");

        expect(result).toBeNull();
    });

    it("should return null on network error", async () => {
        vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(
            new Error("Network error")
        );

        const result = await lookupPodcastByItunesId("12345", "test-key", "test-secret");

        expect(result).toBeNull();
    });
});

describe("getEpisodesByItunesId", () => {
    beforeEach(() => {
        vi.restoreAllMocks();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("should return episodes for valid iTunes ID", async () => {
        const mockResponse = {
            status: "true",
            items: [
                {
                    id: 1,
                    title: "Episode 1",
                    datePublished: 1702641600,
                    duration: 3600,
                    enclosureUrl: "https://example.com/ep1.mp3",
                    guid: "ep-1-guid",
                },
                {
                    id: 2,
                    title: "Episode 2",
                    datePublished: 1702555200,
                    duration: 2700,
                    enclosureUrl: "https://example.com/ep2.mp3",
                    guid: "ep-2-guid",
                    transcriptUrl: "https://example.com/ep2.vtt",
                },
            ],
        };

        vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
            new Response(JSON.stringify(mockResponse), { status: 200 })
        );

        const result = await getEpisodesByItunesId("12345", "test-key", "test-secret");

        expect(result).toHaveLength(2);
        expect(result[0].title).toBe("Episode 1");
        expect(result[1].transcriptUrl).toBe("https://example.com/ep2.vtt");
    });

    it("should return empty array when no episodes found", async () => {
        const mockResponse = {
            status: "true",
            items: [],
        };

        vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
            new Response(JSON.stringify(mockResponse), { status: 200 })
        );

        const result = await getEpisodesByItunesId("12345", "test-key", "test-secret");

        expect(result).toEqual([]);
    });

    it("should return empty array on API error", async () => {
        vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
            new Response("Server error", { status: 500 })
        );

        const result = await getEpisodesByItunesId("12345", "test-key", "test-secret");

        expect(result).toEqual([]);
    });

    it("should respect max parameter", async () => {
        const mockResponse = {
            status: "true",
            items: [],
        };

        vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
            new Response(JSON.stringify(mockResponse), { status: 200 })
        );

        await getEpisodesByItunesId("12345", "test-key", "test-secret", 50);

        expect(fetch).toHaveBeenCalledWith(
            "https://api.podcastindex.org/api/1.0/episodes/byitunesid?id=12345&max=50",
            expect.any(Object)
        );
    });
});

describe("findEpisodeByAppleId", () => {
    const sampleEpisodes: PodcastIndexEpisode[] = [
        {
            id: 1,
            title: "The First Episode",
            datePublished: 1702641600, // Dec 15, 2023
            duration: 3600,
            enclosureUrl: "https://example.com/ep1.mp3",
            guid: "episode-12345-guid",
        },
        {
            id: 2,
            title: "Another Great Episode",
            datePublished: 1702555200, // Dec 14, 2023
            duration: 2700,
            enclosureUrl: "https://example.com/ep2.mp3",
            guid: "ep-2-guid",
        },
        {
            id: 3,
            title: "Special Holiday Episode",
            datePublished: 1703160000, // Dec 21, 2023
            duration: 4500,
            enclosureUrl: "https://example.com/ep3.mp3",
            guid: "holiday-special",
        },
    ];

    it("should match by GUID containing Apple episode ID", () => {
        const result = findEpisodeByAppleId(sampleEpisodes, "12345");

        expect(result).not.toBeNull();
        expect(result?.title).toBe("The First Episode");
    });

    it("should match by exact title", () => {
        const result = findEpisodeByAppleId(
            sampleEpisodes,
            "unknown-id",
            "Another Great Episode"
        );

        expect(result).not.toBeNull();
        expect(result?.title).toBe("Another Great Episode");
    });

    it("should match by partial title (expected contains actual)", () => {
        const result = findEpisodeByAppleId(
            sampleEpisodes,
            "unknown-id",
            "Special Holiday Episode - Extended Cut"
        );

        expect(result).not.toBeNull();
        expect(result?.title).toBe("Special Holiday Episode");
    });

    it("should match by partial title (actual contains expected)", () => {
        const result = findEpisodeByAppleId(
            sampleEpisodes,
            "unknown-id",
            "Holiday Episode"
        );

        expect(result).not.toBeNull();
        expect(result?.title).toBe("Special Holiday Episode");
    });

    it("should match by date within 24 hours", () => {
        // Dec 15, 2023 at a different time
        const result = findEpisodeByAppleId(
            sampleEpisodes,
            "unknown-id",
            undefined,
            "2023-12-15T18:00:00Z"
        );

        expect(result).not.toBeNull();
        expect(result?.title).toBe("The First Episode");
    });

    it("should return null when no match found", () => {
        const result = findEpisodeByAppleId(
            sampleEpisodes,
            "no-match",
            "Nonexistent Episode",
            "2020-01-01T00:00:00Z"
        );

        expect(result).toBeNull();
    });

    it("should prioritize GUID match over title match", () => {
        const episodes: PodcastIndexEpisode[] = [
            {
                id: 1,
                title: "Episode ABC",
                datePublished: 1702641600,
                duration: 3600,
                enclosureUrl: "https://example.com/ep1.mp3",
                guid: "guid-contains-12345",
            },
            {
                id: 2,
                title: "Episode 12345",
                datePublished: 1702555200,
                duration: 2700,
                enclosureUrl: "https://example.com/ep2.mp3",
                guid: "different-guid",
            },
        ];

        const result = findEpisodeByAppleId(episodes, "12345", "Episode 12345");

        // Should match by GUID first
        expect(result?.title).toBe("Episode ABC");
    });

    it("should handle empty episodes array", () => {
        const result = findEpisodeByAppleId([], "12345", "Some Title");

        expect(result).toBeNull();
    });

    it("should be case-insensitive for title matching", () => {
        const result = findEpisodeByAppleId(
            sampleEpisodes,
            "unknown-id",
            "THE FIRST EPISODE"
        );

        expect(result).not.toBeNull();
        expect(result?.title).toBe("The First Episode");
    });
});
