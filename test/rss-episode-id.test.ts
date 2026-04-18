import { describe, it, expect } from "vitest";
import { deriveRssEpisodeId, guidHash } from "../src/lib/rss-episode-id";

describe("guidHash", () => {
    it("returns 10 hex chars", async () => {
        const hash = await guidHash("dd85426a-9b70-482f-94ed-d5afd61b7d56");
        expect(hash).toMatch(/^[0-9a-f]{10}$/);
    });

    it("is deterministic", async () => {
        const a = await guidHash("same-guid");
        const b = await guidHash("same-guid");
        expect(a).toBe(b);
    });

    it("differs for different inputs", async () => {
        const a = await guidHash("guid-a");
        const b = await guidHash("guid-b");
        expect(a).not.toBe(b);
    });
});

describe("deriveRssEpisodeId", () => {
    it("produces {podcastId}_rss_{hash}", async () => {
        const id = await deriveRssEpisodeId("1809663079", "dd85426a-9b70-482f-94ed-d5afd61b7d56");
        expect(id).toMatch(/^1809663079_rss_[0-9a-f]{10}$/);
    });
});

import { extractPodcastId } from "../src/lib/url-parser";

describe("extractPodcastId compat", () => {
    it("handles Apple-sourced IDs", () => {
        expect(extractPodcastId("1809663079_12345")).toBe("1809663079");
    });
    it("handles RSS-sourced IDs", () => {
        expect(extractPodcastId("1809663079_rss_abcdef1234")).toBe("1809663079");
    });
});
