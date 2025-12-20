/**
 * Tests for RSS Feed Parser Service
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
    parseDuration,
    parseFeedXml,
    findEpisodeInFeed,
    fetchAndParseFeed,
    fetchTranscript,
    type ParsedFeed,
} from "../src/services/rss";
import { AppError } from "../src/lib/errors";
import { ERROR_CODES } from "../src/lib/constants";

// Inline test fixture (Workers environment doesn't support readFileSync)
const sampleFeedXml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" 
     xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd"
     xmlns:podcast="https://podcastindex.org/namespace/1.0">
  <channel>
    <title>Test Podcast</title>
    <link>https://example.com/podcast</link>
    <description>A test podcast for unit testing</description>
    <itunes:author>Test Author</itunes:author>
    
    <item>
      <guid isPermaLink="false">episode-1000680000000</guid>
      <title>Episode One: The Beginning</title>
      <description>This is the first episode</description>
      <pubDate>Mon, 15 Dec 2024 10:00:00 GMT</pubDate>
      <itunes:duration>1:30:45</itunes:duration>
      <enclosure url="https://example.com/audio/episode1.mp3" type="audio/mpeg" length="54321000"/>
      <podcast:transcript url="https://example.com/transcripts/episode1.srt" type="application/srt"/>
    </item>
    
    <item>
      <guid>https://example.com/episodes/987654321</guid>
      <title>Episode Two: The Sequel</title>
      <description>This is the second episode</description>
      <pubDate>Wed, 18 Dec 2024 10:00:00 GMT</pubDate>
      <itunes:duration>3600</itunes:duration>
      <enclosure url="https://example.com/audio/episode2.mp3" type="audio/mpeg" length="72000000"/>
    </item>
    
    <item>
      <guid>episode-without-duration</guid>
      <title>Episode Three: No Duration</title>
      <description>This episode has no duration specified</description>
      <pubDate>Fri, 20 Dec 2024 10:00:00 GMT</pubDate>
      <enclosure url="https://example.com/audio/episode3.mp3" type="audio/mpeg" length="36000000"/>
    </item>
    
    <item>
      <guid>episode-45-30</guid>
      <title>Episode Four: MM:SS Duration</title>
      <description>Duration in MM:SS format</description>
      <pubDate>Sat, 21 Dec 2024 10:00:00 GMT</pubDate>
      <itunes:duration>45:30</itunes:duration>
      <enclosure url="https://example.com/audio/episode4.mp3" type="audio/mpeg" length="27000000"/>
    </item>
    
    <item>
      <guid>episode%3A1000123456789</guid>
      <title>Episode Five: URL Encoded GUID</title>
      <description>GUID contains URL encoded characters</description>
      <pubDate>Sun, 22 Dec 2024 10:00:00 GMT</pubDate>
      <itunes:duration>2700</itunes:duration>
      <enclosure url="https://example.com/audio/episode5.mp3" type="audio/mpeg" length="40500000"/>
      <podcast:transcript url="https://example.com/transcripts/episode5.vtt" type="text/vtt"/>
    </item>
  </channel>
</rss>`;

describe("parseDuration", () => {
    it("should parse seconds as number", () => {
        expect(parseDuration(3600)).toBe(3600);
    });

    it("should parse seconds as string", () => {
        expect(parseDuration("3600")).toBe(3600);
    });

    it("should parse MM:SS format", () => {
        expect(parseDuration("60:00")).toBe(3600);
        expect(parseDuration("45:30")).toBe(2730);
        expect(parseDuration("1:30")).toBe(90);
    });

    it("should parse HH:MM:SS format", () => {
        expect(parseDuration("1:00:00")).toBe(3600);
        expect(parseDuration("1:30:45")).toBe(5445);
        expect(parseDuration("2:15:30")).toBe(8130);
    });

    it("should return 0 for undefined/null", () => {
        expect(parseDuration(undefined)).toBe(0);
        expect(parseDuration(null as unknown as undefined)).toBe(0);
    });

    it("should return 0 for empty string", () => {
        expect(parseDuration("")).toBe(0);
        expect(parseDuration("   ")).toBe(0);
    });

    it("should return 0 for invalid format", () => {
        expect(parseDuration("invalid")).toBe(0);
        expect(parseDuration("1:2:3:4")).toBe(0);
    });
});

describe("parseFeedXml", () => {
    it("should parse sample feed correctly", () => {
        const feed = parseFeedXml(sampleFeedXml);

        expect(feed.title).toBe("Test Podcast");
        expect(feed.episodes).toHaveLength(5);
    });

    it("should extract episode data correctly", () => {
        const feed = parseFeedXml(sampleFeedXml);
        const episode = feed.episodes[0];

        expect(episode.guid).toBe("episode-1000680000000");
        expect(episode.title).toBe("Episode One: The Beginning");
        expect(episode.duration).toBe(5445); // 1:30:45
        expect(episode.audioUrl).toBe("https://example.com/audio/episode1.mp3");
        expect(episode.transcriptUrl).toBe(
            "https://example.com/transcripts/episode1.srt"
        );
        expect(episode.transcriptType).toBe("srt");
    });

    it("should parse pubDate to ISO format", () => {
        const feed = parseFeedXml(sampleFeedXml);
        const episode = feed.episodes[0];

        expect(episode.pubDate).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it("should handle episodes without duration", () => {
        const feed = parseFeedXml(sampleFeedXml);
        const episode = feed.episodes.find(
            (e) => e.guid === "episode-without-duration"
        );

        expect(episode?.duration).toBe(0);
    });

    it("should handle MM:SS duration format", () => {
        const feed = parseFeedXml(sampleFeedXml);
        const episode = feed.episodes.find((e) => e.guid === "episode-45-30");

        expect(episode?.duration).toBe(2730); // 45:30
    });

    it("should throw on invalid XML", () => {
        expect(() => parseFeedXml("not xml at all <><><<")).toThrow(AppError);
    });

    it("should throw on missing channel", () => {
        const invalidFeed = '<?xml version="1.0"?><rss></rss>';
        expect(() => parseFeedXml(invalidFeed)).toThrow(AppError);
    });
});

describe("findEpisodeInFeed", () => {
    let feed: ParsedFeed;

    beforeEach(() => {
        feed = parseFeedXml(sampleFeedXml);
    });

    describe("Strategy 1 & 2: GUID matching", () => {
        it("should find episode by exact guid match", () => {
            const episode = findEpisodeInFeed(feed, "1000680000000");

            expect(episode).not.toBeNull();
            expect(episode?.title).toBe("Episode One: The Beginning");
        });

        it("should find episode with URL-encoded guid", () => {
            const episode = findEpisodeInFeed(feed, "1000123456789");

            expect(episode).not.toBeNull();
            expect(episode?.title).toBe("Episode Five: URL Encoded GUID");
        });

        it("should return null for non-existent episode", () => {
            const episode = findEpisodeInFeed(feed, "9999999999");

            expect(episode).toBeNull();
        });

        it("should handle partial guid matches", () => {
            const episode = findEpisodeInFeed(feed, "987654321");

            expect(episode).not.toBeNull();
            expect(episode?.title).toBe("Episode Two: The Sequel");
        });
    });

    describe("Strategy 3: Title similarity matching", () => {
        it("should find episode by similar title (high confidence)", () => {
            const episode = findEpisodeInFeed(feed, "nomatch", {
                expectedTitle: "Episode One: The Beginning",
            });

            expect(episode).not.toBeNull();
            expect(episode?.title).toBe("Episode One: The Beginning");
        });

        it("should find episode with partial title match", () => {
            const episode = findEpisodeInFeed(feed, "nomatch", {
                expectedTitle: "Episode Two The Sequel Show",
            });

            expect(episode).not.toBeNull();
            expect(episode?.title).toBe("Episode Two: The Sequel");
        });

        it("should not match low similarity titles", () => {
            const episode = findEpisodeInFeed(feed, "nomatch", {
                expectedTitle: "Completely Different Title About Cats",
            });

            expect(episode).toBeNull();
        });
    });

    describe("Strategy 4: Date matching", () => {
        it("should find episode by exact date when only one match", () => {
            const episode = findEpisodeInFeed(feed, "nomatch", {
                expectedDate: "2024-12-15T10:00:00.000Z",
            });

            expect(episode).not.toBeNull();
            expect(episode?.title).toBe("Episode One: The Beginning");
        });

        it("should find episode by close date (within 2 days)", () => {
            const episode = findEpisodeInFeed(feed, "nomatch", {
                expectedDate: "2024-12-14T10:00:00.000Z", // 1 day before
            });

            expect(episode).not.toBeNull();
            expect(episode?.title).toBe("Episode One: The Beginning");
        });

        it("should use title to disambiguate when multiple episodes on same date", () => {
            // Create a feed with two episodes on the same day
            const sameDayFeedXml = `<?xml version="1.0"?>
            <rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd">
                <channel>
                    <title>Same Day Podcast</title>
                    <item>
                        <guid>ep-morning</guid>
                        <title>Morning Show</title>
                        <pubDate>Mon, 15 Dec 2024 08:00:00 GMT</pubDate>
                        <itunes:duration>3600</itunes:duration>
                        <enclosure url="https://example.com/morning.mp3" type="audio/mpeg"/>
                    </item>
                    <item>
                        <guid>ep-evening</guid>
                        <title>Evening Show</title>
                        <pubDate>Mon, 15 Dec 2024 18:00:00 GMT</pubDate>
                        <itunes:duration>3600</itunes:duration>
                        <enclosure url="https://example.com/evening.mp3" type="audio/mpeg"/>
                    </item>
                </channel>
            </rss>`;
            const sameDayFeed = parseFeedXml(sameDayFeedXml);

            const episode = findEpisodeInFeed(sameDayFeed, "nomatch", {
                expectedDate: "2024-12-15T12:00:00.000Z",
                expectedTitle: "Evening Show",
            });

            expect(episode).not.toBeNull();
            expect(episode?.title).toBe("Evening Show");
        });
    });

    describe("Strategy 5: Episode index fallback", () => {
        it("should find episode by index", () => {
            const episode = findEpisodeInFeed(feed, "nomatch", {
                episodeIndex: 0,
            });

            expect(episode).not.toBeNull();
            expect(episode?.title).toBe("Episode One: The Beginning");
        });

        it("should find last episode in feed", () => {
            const episode = findEpisodeInFeed(feed, "nomatch", {
                episodeIndex: 4,
            });

            expect(episode).not.toBeNull();
            expect(episode?.title).toBe("Episode Five: URL Encoded GUID");
        });

        it("should return null for out of bounds index", () => {
            const episode = findEpisodeInFeed(feed, "nomatch", {
                episodeIndex: 100,
            });

            expect(episode).toBeNull();
        });
    });

    describe("Strategy priority", () => {
        it("should prefer GUID match over title match", () => {
            // GUID matches episode 1, but title matches episode 2
            const episode = findEpisodeInFeed(feed, "1000680000000", {
                expectedTitle: "Episode Two: The Sequel",
            });

            // Should return episode 1 (GUID match wins)
            expect(episode?.title).toBe("Episode One: The Beginning");
        });
    });
});

describe("fetchAndParseFeed", () => {
    beforeEach(() => {
        vi.restoreAllMocks();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("should fetch and parse feed successfully", async () => {
        vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
            new Response(sampleFeedXml, {
                status: 200,
                headers: { "Content-Type": "application/xml" },
            })
        );

        const feed = await fetchAndParseFeed("https://example.com/feed.xml");

        expect(feed.title).toBe("Test Podcast");
        expect(feed.episodes.length).toBeGreaterThan(0);
    });

    it("should throw RSS_TIMEOUT on timeout", async () => {
        vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(
            Object.assign(new Error("Aborted"), { name: "AbortError" })
        );

        try {
            await fetchAndParseFeed("https://example.com/feed.xml");
            expect.fail("Should have thrown");
        } catch (error) {
            expect(error).toBeInstanceOf(AppError);
            expect((error as AppError).code).toBe(ERROR_CODES.RSS_TIMEOUT);
        }
    });

    it("should throw on non-200 response", async () => {
        vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
            new Response("Not found", { status: 404 })
        );

        try {
            await fetchAndParseFeed("https://example.com/feed.xml");
            expect.fail("Should have thrown");
        } catch (error) {
            expect(error).toBeInstanceOf(AppError);
        }
    });
});

describe("fetchTranscript", () => {
    beforeEach(() => {
        vi.restoreAllMocks();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("should parse SRT transcript", async () => {
        const srtContent = `1
00:00:00,000 --> 00:00:05,000
Hello world.

2
00:00:05,000 --> 00:00:10,000
This is a test.`;

        vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
            new Response(srtContent, { status: 200 })
        );

        const result = await fetchTranscript(
            "https://example.com/transcript.srt",
            "srt"
        );

        expect(result).toBe("Hello world. This is a test.");
    });

    it("should parse VTT transcript", async () => {
        const vttContent = `WEBVTT

00:00:00.000 --> 00:00:05.000
Hello from VTT.

00:00:05.000 --> 00:00:10.000
Another line.`;

        vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
            new Response(vttContent, { status: 200 })
        );

        const result = await fetchTranscript(
            "https://example.com/transcript.vtt",
            "vtt"
        );

        expect(result).toBe("Hello from VTT. Another line.");
    });

    it("should parse JSON transcript with segments", async () => {
        const jsonContent = JSON.stringify({
            segments: [{ text: "First segment." }, { text: "Second segment." }],
        });

        vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
            new Response(jsonContent, { status: 200 })
        );

        const result = await fetchTranscript(
            "https://example.com/transcript.json",
            "json"
        );

        expect(result).toBe("First segment. Second segment.");
    });

    it("should return plain text as-is", async () => {
        const plainText = "This is plain text transcript.";

        vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
            new Response(plainText, { status: 200 })
        );

        const result = await fetchTranscript(
            "https://example.com/transcript.txt",
            "plain"
        );

        expect(result).toBe(plainText);
    });

    it("should return null on fetch error", async () => {
        vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
            new Response("Not found", { status: 404 })
        );

        const result = await fetchTranscript(
            "https://example.com/transcript.srt",
            "srt"
        );

        expect(result).toBeNull();
    });
});
