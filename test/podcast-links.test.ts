import { describe, it, expect } from "vitest";
import {
    toWebsiteUrl,
    resolveWebsiteUrl,
    toEpisodePageUrl,
    showLevelAppleUrl,
    isShowLevelAppleUrl,
} from "../src/lib/podcast-links";

describe("toWebsiteUrl", () => {
    it("keeps an ordinary website URL", () => {
        expect(toWebsiteUrl("https://hbr.org/podcasts/on-leadership")).toBe("https://hbr.org/podcasts/on-leadership");
    });

    it("trims surrounding whitespace", () => {
        expect(toWebsiteUrl("  https://theverge.com \n")).toBe("https://theverge.com");
    });

    it("rejects an Apple Podcasts URL, which is not the podcast's website", () => {
        expect(toWebsiteUrl("https://podcasts.apple.com/us/podcast/hbr-on-leadership/id1683948659")).toBeUndefined();
        expect(toWebsiteUrl("https://itunes.apple.com/us/podcast/id1683948659")).toBeUndefined();
    });

    it("rejects a feed host such as feeds.acast.com", () => {
        expect(toWebsiteUrl("https://feeds.acast.com/public/shows/platformer")).toBeUndefined();
    });

    it("strips a feed filename back to its directory", () => {
        expect(toWebsiteUrl("https://www.thisamericanlife.org/podcast/rss.xml")).toBe("https://www.thisamericanlife.org/podcast");
    });

    it("strips a trailing /feed segment back to the origin", () => {
        expect(toWebsiteUrl("https://example.com/feed/")).toBe("https://example.com");
    });

    it("rejects empty, unparseable and non-http values", () => {
        expect(toWebsiteUrl(undefined)).toBeUndefined();
        expect(toWebsiteUrl("")).toBeUndefined();
        expect(toWebsiteUrl("not a url")).toBeUndefined();
        expect(toWebsiteUrl("mailto:host@example.com")).toBeUndefined();
    });
});

describe("resolveWebsiteUrl", () => {
    it("keeps a stored website that is already valid", () => {
        expect(resolveWebsiteUrl("https://crooked.com", ["https://audioboom.com/channels/5166624"])).toBe("https://crooked.com");
    });

    it("replaces an invalid stored website with the first valid candidate", () => {
        expect(resolveWebsiteUrl(
            "https://podcasts.apple.com/us/podcast/x/id1",
            ["https://feeds.acast.com/public/shows/x", "https://hbr.org/podcasts/on-leadership"]
        )).toBe("https://hbr.org/podcasts/on-leadership");
    });

    it("falls back to a cleaned copy of the stored value, or nothing", () => {
        expect(resolveWebsiteUrl("https://example.com/podcast/rss.xml", [undefined])).toBe("https://example.com/podcast");
        expect(resolveWebsiteUrl("https://podcasts.apple.com/us/podcast/x/id1", [undefined])).toBeUndefined();
    });
});

describe("toEpisodePageUrl", () => {
    it("keeps an episode-specific page", () => {
        expect(toEpisodePageUrl("https://www.platformer.news/thursday-newsletter-7/"))
            .toBe("https://www.platformer.news/thursday-newsletter-7/");
    });

    it("rejects a bare origin, which some feeds repeat on every item", () => {
        expect(toEpisodePageUrl("https://audiocollective.ted.com/")).toBeUndefined();
        expect(toEpisodePageUrl("https://audiocollective.ted.com")).toBeUndefined();
    });

    it("rejects a link that just repeats the podcast website", () => {
        expect(toEpisodePageUrl("https://www.ted.com/podcasts/worklife/", { websiteUrl: "https://www.ted.com/podcasts/worklife" }))
            .toBeUndefined();
    });

    it("rejects a link to the audio file", () => {
        expect(toEpisodePageUrl("https://cdn.example.com/shows/ep-12.mp3")).toBeUndefined();
        expect(toEpisodePageUrl("https://cdn.example.com/ep", { audioUrl: "https://cdn.example.com/ep" })).toBeUndefined();
    });

    it("rejects Apple Podcasts and feed URLs", () => {
        expect(toEpisodePageUrl("https://podcasts.apple.com/us/podcast/x/id1?i=1000")).toBeUndefined();
        expect(toEpisodePageUrl("https://example.com/podcast/rss.xml")).toBeUndefined();
        expect(toEpisodePageUrl("https://feeds.example.com/show/episode-1")).toBeUndefined();
    });

    it("rejects missing or invalid values", () => {
        expect(toEpisodePageUrl(undefined)).toBeUndefined();
        expect(toEpisodePageUrl("nope")).toBeUndefined();
    });
});

describe("showLevelAppleUrl / isShowLevelAppleUrl", () => {
    it("builds the show-level Apple URL for a numeric podcast ID", () => {
        expect(showLevelAppleUrl("1011668648")).toBe("https://podcasts.apple.com/us/podcast/id1011668648");
    });

    it("returns undefined for a non-numeric podcast ID", () => {
        expect(showLevelAppleUrl("manual")).toBeUndefined();
    });

    it("recognises show-level URLs, with or without a slug", () => {
        expect(isShowLevelAppleUrl("https://podcasts.apple.com/us/podcast/id1011668648")).toBe(true);
        expect(isShowLevelAppleUrl("https://podcasts.apple.com/us/podcast/decoder/id1011668648")).toBe(true);
    });

    it("does not treat an episode URL as show-level", () => {
        expect(isShowLevelAppleUrl("https://podcasts.apple.com/us/podcast/ai-broke/id1011668648?i=1000800393703")).toBe(false);
    });

    it("does not treat missing or non-Apple URLs as show-level", () => {
        expect(isShowLevelAppleUrl(undefined)).toBe(false);
        expect(isShowLevelAppleUrl("https://theverge.com")).toBe(false);
    });
});
