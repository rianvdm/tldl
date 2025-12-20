/**
 * Tests for Apple Podcasts / iTunes API Service
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { lookupPodcast, getEpisodeMetadata } from "../src/services/apple-podcasts";
import { AppError } from "../src/lib/errors";
import { ERROR_CODES } from "../src/lib/constants";
import type { ParsedAppleUrl } from "../src/lib/url-parser";

describe("lookupPodcast", () => {
    beforeEach(() => {
        vi.restoreAllMocks();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("should return podcast info for valid podcast ID", async () => {
        const mockResponse = {
            resultCount: 1,
            results: [
                {
                    wrapperType: "collection",
                    kind: "podcast",
                    feedUrl: "https://feeds.example.com/podcast.rss",
                    collectionName: "Test Podcast",
                    artistName: "Test Artist",
                },
            ],
        };

        vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
            new Response(JSON.stringify(mockResponse), { status: 200 })
        );

        const result = await lookupPodcast("12345");

        expect(result).toEqual({
            feedUrl: "https://feeds.example.com/podcast.rss",
            collectionName: "Test Podcast",
            artistName: "Test Artist",
        });

        expect(fetch).toHaveBeenCalledWith(
            "https://itunes.apple.com/lookup?id=12345&entity=podcast",
            expect.objectContaining({
                headers: {
                    Accept: "application/json",
                    "User-Agent": "TLDL/1.0 (Podcast Summary Service)",
                },
            })
        );
    });

    it("should return null when podcast not found", async () => {
        const mockResponse = {
            resultCount: 0,
            results: [],
        };

        vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
            new Response(JSON.stringify(mockResponse), { status: 200 })
        );

        const result = await lookupPodcast("99999999");

        expect(result).toBeNull();
    });

    it("should return null when no feed URL in response", async () => {
        const mockResponse = {
            resultCount: 1,
            results: [
                {
                    wrapperType: "collection",
                    kind: "podcast",
                    // Missing feedUrl
                    collectionName: "Test Podcast",
                },
            ],
        };

        vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
            new Response(JSON.stringify(mockResponse), { status: 200 })
        );

        const result = await lookupPodcast("12345");

        expect(result).toBeNull();
    });

    it("should throw AppError on rate limit (429)", async () => {
        vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
            new Response("Rate limited", { status: 429 })
        );

        try {
            await lookupPodcast("12345");
            expect.fail("Expected AppError to be thrown");
        } catch (error) {
            expect(error).toBeInstanceOf(AppError);
            expect((error as AppError).code).toBe(ERROR_CODES.RATE_LIMITED);
        }
    });


    it("should throw AppError on server error", async () => {
        vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
            new Response("Server error", { status: 500 })
        );

        try {
            await lookupPodcast("12345");
            expect.fail("Expected AppError to be thrown");
        } catch (error) {
            expect(error).toBeInstanceOf(AppError);
            expect((error as AppError).code).toBe(ERROR_CODES.ITUNES_API_ERROR);
        }
    });


    it("should throw AppError on network error", async () => {
        vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(
            new Error("Network error")
        );

        try {
            await lookupPodcast("12345");
            expect.fail("Expected AppError to be thrown");
        } catch (error) {
            expect(error).toBeInstanceOf(AppError);
            expect((error as AppError).code).toBe(ERROR_CODES.ITUNES_API_ERROR);
        }
    });


    it("should handle response with multiple results", async () => {
        const mockResponse = {
            resultCount: 3,
            results: [
                { wrapperType: "artist", artistName: "Someone" },
                {
                    wrapperType: "collection",
                    kind: "podcast",
                    feedUrl: "https://feeds.example.com/podcast.rss",
                    collectionName: "The Real Podcast",
                    artistName: "Host Name",
                },
                { wrapperType: "track", trackName: "Episode" },
            ],
        };

        vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
            new Response(JSON.stringify(mockResponse), { status: 200 })
        );

        const result = await lookupPodcast("12345");

        expect(result?.collectionName).toBe("The Real Podcast");
    });
});

describe("getEpisodeMetadata", () => {
    // Sample RSS feed for mocking
    const sampleRssFeed = `<?xml version="1.0"?>
<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd">
  <channel>
    <title>Test Podcast</title>
    <item>
      <guid>episode-67890</guid>
      <title>Test Episode Title</title>
      <pubDate>Mon, 15 Dec 2024 10:00:00 GMT</pubDate>
      <itunes:duration>1:30:00</itunes:duration>
      <enclosure url="https://example.com/audio.mp3" type="audio/mpeg"/>
    </item>
  </channel>
</rss>`;

    beforeEach(() => {
        vi.restoreAllMocks();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("should return metadata for valid parsed URL", async () => {
        const mockItunesResponse = {
            resultCount: 1,
            results: [
                {
                    wrapperType: "collection",
                    feedUrl: "https://feeds.example.com/podcast.rss",
                    collectionName: "Test Podcast",
                    artistName: "Test Artist",
                },
            ],
        };

        // Mock iTunes API call first, then RSS feed call
        vi.spyOn(globalThis, "fetch")
            .mockResolvedValueOnce(
                new Response(JSON.stringify(mockItunesResponse), { status: 200 })
            )
            .mockResolvedValueOnce(
                new Response(sampleRssFeed, { status: 200 })
            );

        const parsedUrl: ParsedAppleUrl = {
            podcastId: "12345",
            episodeId: "67890",
            country: "us",
        };

        const result = await getEpisodeMetadata(parsedUrl);

        expect(result.podcastName).toBe("Test Podcast");
        expect(result.episodeTitle).toBe("Test Episode Title");
        expect(result.episodeDuration).toBe(5400); // 1:30:00
        expect(result.audioUrl).toBe("https://example.com/audio.mp3");
        expect(result.feedUrl).toBe("https://feeds.example.com/podcast.rss");
    });

    it("should throw EPISODE_NOT_FOUND when podcast not found", async () => {
        const mockResponse = {
            resultCount: 0,
            results: [],
        };

        vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
            new Response(JSON.stringify(mockResponse), { status: 200 })
        );

        const parsedUrl: ParsedAppleUrl = {
            podcastId: "99999999",
            episodeId: "11111111",
            country: "us",
        };

        try {
            await getEpisodeMetadata(parsedUrl);
            expect.fail("Should have thrown");
        } catch (error) {
            expect(error).toBeInstanceOf(AppError);
            expect((error as AppError).code).toBe(ERROR_CODES.EPISODE_NOT_FOUND);
        }
    });

    it("should throw EPISODE_NOT_FOUND when episode not in feed", async () => {
        const mockItunesResponse = {
            resultCount: 1,
            results: [
                {
                    wrapperType: "collection",
                    feedUrl: "https://feeds.example.com/podcast.rss",
                    collectionName: "Test Podcast",
                    artistName: "Test Artist",
                },
            ],
        };

        vi.spyOn(globalThis, "fetch")
            .mockResolvedValueOnce(
                new Response(JSON.stringify(mockItunesResponse), { status: 200 })
            )
            .mockResolvedValueOnce(
                new Response(sampleRssFeed, { status: 200 })
            );

        const parsedUrl: ParsedAppleUrl = {
            podcastId: "12345",
            episodeId: "NONEXISTENT",
            country: "us",
        };

        try {
            await getEpisodeMetadata(parsedUrl);
            expect.fail("Should have thrown");
        } catch (error) {
            expect(error).toBeInstanceOf(AppError);
            expect((error as AppError).code).toBe(ERROR_CODES.EPISODE_NOT_FOUND);
        }
    });
});

