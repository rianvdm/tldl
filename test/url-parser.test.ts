/**
 * Tests for Apple Podcasts URL Parser
 */

import { describe, it, expect } from "vitest";
import {
    parseApplePodcastsUrl,
    parseYouTubeUrl,
    detectUrlType,
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

describe("parseYouTubeUrl", () => {
    describe("valid URLs", () => {
        it("should parse a youtube.com/watch URL", () => {
            const result = parseYouTubeUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
            expect(result).toEqual({ videoId: "dQw4w9WgXcQ" });
        });

        it("should parse a youtu.be short URL", () => {
            const result = parseYouTubeUrl("https://youtu.be/dQw4w9WgXcQ");
            expect(result).toEqual({ videoId: "dQw4w9WgXcQ" });
        });

        it("should parse a youtu.be URL with share params", () => {
            const result = parseYouTubeUrl("https://youtu.be/a2aYd-XHzsI?si=Ix4VfQJ5GnX8VnN5");
            expect(result).toEqual({ videoId: "a2aYd-XHzsI" });
        });

        it("should parse a youtube.com/shorts URL", () => {
            const result = parseYouTubeUrl("https://www.youtube.com/shorts/dQw4w9WgXcQ");
            expect(result).toEqual({ videoId: "dQw4w9WgXcQ" });
        });

        it("should parse a youtube.com/watch URL without www", () => {
            const result = parseYouTubeUrl("https://youtube.com/watch?v=dQw4w9WgXcQ");
            expect(result).toEqual({ videoId: "dQw4w9WgXcQ" });
        });
    });

    describe("invalid URLs", () => {
        it("should return null for Apple Podcasts URLs", () => {
            expect(parseYouTubeUrl("https://podcasts.apple.com/us/podcast/test/id123?i=456")).toBeNull();
        });

        it("should return null for random URLs", () => {
            expect(parseYouTubeUrl("https://example.com/watch?v=dQw4w9WgXcQ")).toBeNull();
        });

        it("should return null for youtube.com without video ID", () => {
            expect(parseYouTubeUrl("https://www.youtube.com/channel/UCtest")).toBeNull();
        });

        it("should return null for empty string", () => {
            expect(parseYouTubeUrl("")).toBeNull();
        });

        it("should return null for null/undefined", () => {
            expect(parseYouTubeUrl(null as unknown as string)).toBeNull();
            expect(parseYouTubeUrl(undefined as unknown as string)).toBeNull();
        });
    });
});

describe("detectUrlType", () => {
    it("should return 'apple' for Apple Podcasts episode URLs", () => {
        expect(detectUrlType("https://podcasts.apple.com/us/podcast/test/id123?i=456")).toBe("apple");
    });

    it("should return 'youtube' for YouTube watch URLs", () => {
        expect(detectUrlType("https://www.youtube.com/watch?v=dQw4w9WgXcQ")).toBe("youtube");
    });

    it("should return 'youtube' for youtu.be URLs", () => {
        expect(detectUrlType("https://youtu.be/dQw4w9WgXcQ")).toBe("youtube");
    });

    it("should return 'unknown' for Spotify URLs", () => {
        expect(detectUrlType("https://open.spotify.com/episode/abc123")).toBe("unknown");
    });

    it("should return 'unknown' for empty string", () => {
        expect(detectUrlType("")).toBe("unknown");
    });
});
