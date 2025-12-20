/**
 * Tests for Apple Podcasts URL Parser
 */

import { describe, it, expect } from "vitest";
import {
    parseApplePodcastsUrl,
    deriveEpisodeId,
    type ParsedAppleUrl,
} from "../src/lib/url-parser";

describe("parseApplePodcastsUrl", () => {
    describe("valid URLs", () => {
        it("should parse a valid US episode URL", () => {
            const url =
                "https://podcasts.apple.com/us/podcast/the-daily/id1200361736?i=1000680000000";
            const result = parseApplePodcastsUrl(url);

            expect(result).toEqual({
                podcastId: "1200361736",
                episodeId: "1000680000000",
                country: "us",
            } satisfies ParsedAppleUrl);
        });

        it("should parse a valid UK episode URL", () => {
            const url =
                "https://podcasts.apple.com/gb/podcast/some-podcast/id9876543210?i=1000123456789";
            const result = parseApplePodcastsUrl(url);

            expect(result).toEqual({
                podcastId: "9876543210",
                episodeId: "1000123456789",
                country: "gb",
            } satisfies ParsedAppleUrl);
        });

        it("should handle URLs with trailing slashes", () => {
            const url =
                "https://podcasts.apple.com/us/podcast/my-podcast/id12345/?i=67890";
            const result = parseApplePodcastsUrl(url);

            expect(result).toEqual({
                podcastId: "12345",
                episodeId: "67890",
                country: "us",
            });
        });

        it("should handle URLs with extra query parameters", () => {
            const url =
                "https://podcasts.apple.com/us/podcast/test/id111?i=222&mt=2&app=podcast";
            const result = parseApplePodcastsUrl(url);

            expect(result).toEqual({
                podcastId: "111",
                episodeId: "222",
                country: "us",
            });
        });

        it("should handle uppercase country codes", () => {
            const url =
                "https://podcasts.apple.com/US/podcast/test/id111?i=222";
            const result = parseApplePodcastsUrl(url);

            expect(result?.country).toBe("us");
        });

        it("should handle slugs with unicode characters", () => {
            const url =
                "https://podcasts.apple.com/de/podcast/über-die-welt/id12345?i=67890";
            const result = parseApplePodcastsUrl(url);

            expect(result).toEqual({
                podcastId: "12345",
                episodeId: "67890",
                country: "de",
            });
        });

        it("should handle slugs with special characters and dashes", () => {
            const url =
                "https://podcasts.apple.com/us/podcast/the-99-invisible-podcast-show/id12345?i=67890";
            const result = parseApplePodcastsUrl(url);

            expect(result).toEqual({
                podcastId: "12345",
                episodeId: "67890",
                country: "us",
            });
        });
    });

    describe("invalid URLs", () => {
        it("should return null for show URL without episode ID", () => {
            const url =
                "https://podcasts.apple.com/us/podcast/the-daily/id1200361736";
            const result = parseApplePodcastsUrl(url);

            expect(result).toBeNull();
        });

        it("should return null for Spotify URLs", () => {
            const url =
                "https://open.spotify.com/episode/1234567890abcdefghij";
            const result = parseApplePodcastsUrl(url);

            expect(result).toBeNull();
        });

        it("should return null for generic URLs", () => {
            const url = "https://example.com/podcast/episode";
            const result = parseApplePodcastsUrl(url);

            expect(result).toBeNull();
        });

        it("should return null for malformed URLs", () => {
            const result = parseApplePodcastsUrl("not a url at all");
            expect(result).toBeNull();
        });

        it("should return null for empty string", () => {
            const result = parseApplePodcastsUrl("");
            expect(result).toBeNull();
        });

        it("should return null for undefined/null input", () => {
            expect(parseApplePodcastsUrl(undefined as unknown as string)).toBeNull();
            expect(parseApplePodcastsUrl(null as unknown as string)).toBeNull();
        });

        it("should return null for non-numeric episode ID", () => {
            const url =
                "https://podcasts.apple.com/us/podcast/test/id12345?i=abc123";
            const result = parseApplePodcastsUrl(url);

            expect(result).toBeNull();
        });

        it("should return null for missing episode ID param", () => {
            const url =
                "https://podcasts.apple.com/us/podcast/test/id12345?foo=bar";
            const result = parseApplePodcastsUrl(url);

            expect(result).toBeNull();
        });

        it("should return null for podcast embed page", () => {
            const url = "https://podcasts.apple.com/podcast/id12345";
            const result = parseApplePodcastsUrl(url);

            expect(result).toBeNull();
        });
    });
});

describe("deriveEpisodeId", () => {
    it("should combine podcast and episode IDs with underscore", () => {
        const result = deriveEpisodeId("1200361736", "1000680000000");
        expect(result).toBe("1200361736_1000680000000");
    });

    it("should create unique IDs for different episodes", () => {
        const id1 = deriveEpisodeId("123", "456");
        const id2 = deriveEpisodeId("123", "789");
        const id3 = deriveEpisodeId("999", "456");

        expect(id1).not.toBe(id2);
        expect(id1).not.toBe(id3);
        expect(id2).not.toBe(id3);
    });
});
