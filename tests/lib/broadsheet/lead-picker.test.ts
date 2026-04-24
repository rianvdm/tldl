import { describe, it, expect } from "vitest";
import { selectLeadEpisode } from "../../../src/lib/broadsheet/lead-picker";
import type { EpisodeIndexEntry } from "../../../src/types";

function ep(overrides: Partial<EpisodeIndexEntry>): EpisodeIndexEntry {
    return {
        id: "x",
        podcastName: "Pod",
        episodeTitle: "Title",
        episodeDate: "2026-01-01",
        episodeDuration: 3600,
        createdAt: "2026-01-01T00:00:00Z",
        expiresAt: "2027-01-01T00:00:00Z",
        ...overrides,
    };
}

describe("selectLeadEpisode", () => {
    it("returns null on empty list", () => {
        expect(selectLeadEpisode([])).toBeNull();
    });
    it("returns the only episode when list has one", () => {
        const one = ep({ id: "a" });
        expect(selectLeadEpisode([one])).toBe(one);
    });
    it("returns the newest by episodeDate", () => {
        const older = ep({ id: "a", episodeDate: "2026-01-01" });
        const newer = ep({ id: "b", episodeDate: "2026-02-01" });
        expect(selectLeadEpisode([older, newer])).toBe(newer);
        expect(selectLeadEpisode([newer, older])).toBe(newer);
    });
    it("breaks ties by createdAt when episodeDate is identical", () => {
        const a = ep({ id: "a", episodeDate: "2026-02-01", createdAt: "2026-02-01T08:00:00Z" });
        const b = ep({ id: "b", episodeDate: "2026-02-01", createdAt: "2026-02-01T12:00:00Z" });
        expect(selectLeadEpisode([a, b])).toBe(b);
    });
});
