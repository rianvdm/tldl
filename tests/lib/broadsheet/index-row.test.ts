import { describe, it, expect } from "vitest";
import { renderIndexRow } from "../../../src/lib/broadsheet/index-row";
import type { EpisodeIndexEntry } from "../../../src/types";

function ep(overrides: Partial<EpisodeIndexEntry & { deck?: string }> = {}): EpisodeIndexEntry & { deck?: string } {
    return {
        id: "ep-2",
        podcastName: "The Ezra Klein Show",
        episodeTitle: "The Case Against Productivity",
        episodeDate: "2026-04-16",
        episodeDuration: 3840,
        createdAt: "2026-04-16T00:00:00Z",
        expiresAt: "2027-04-16T00:00:00Z",
        podcastAuthor: "New York Times",
        tags: ["psychology"],
        ...overrides,
    };
}

describe("renderIndexRow", () => {
    it("renders a row with number, title, date, duration, tag, arrow", () => {
        const html = renderIndexRow(ep({ deck: "A deck." }), 2);
        expect(html).toContain("№ 02");
        expect(html).toContain("The Case Against Productivity");
        expect(html).toContain("Apr 16");
        expect(html).toContain("1h 04m");
        expect(html).toContain("psychology");
        expect(html).toContain("→");
    });

    it("renders deck in the blurb slot when present", () => {
        const html = renderIndexRow(ep({ deck: "Argument against productivity culture." }), 2);
        expect(html).toContain("Argument against productivity culture.");
    });

    it("omits the blurb element entirely when deck is missing", () => {
        const html = renderIndexRow(ep({ deck: undefined }), 2);
        expect(html).not.toContain("bs-row-blurb");
        expect(html).not.toContain("undefined");
    });

    it("pads row numbers to 2 digits", () => {
        expect(renderIndexRow(ep(), 1)).toContain("№ 01");
        expect(renderIndexRow(ep(), 10)).toContain("№ 10");
    });

    it("wraps the row in a link to /episode/:id", () => {
        const html = renderIndexRow(ep({ id: "xyz" }), 2);
        expect(html).toMatch(/<a[^>]+href="\/episode\/xyz"[^>]+class="bs-row"/);
    });
});
