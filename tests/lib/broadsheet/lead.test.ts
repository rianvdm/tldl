import { describe, it, expect } from "vitest";
import { renderLead } from "../../../src/lib/broadsheet/lead";
import type { Episode } from "../../../src/types";

function ep(overrides: Partial<Episode> = {}): Episode {
    return {
        id: "ep-1",
        appleUrl: "https://example.com",
        podcastName: "Acquired",
        episodeTitle: "Nvidia — The Dawn of the AI Era",
        episodeDuration: 15120,
        episodeDate: "2026-04-18",
        audioUrl: "https://example.com/a.mp3",
        transcriptSource: "rss",
        createdAt: "2026-04-18T00:00:00Z",
        expiresAt: "2027-04-18T00:00:00Z",
        podcastAuthor: "Ben Gilbert & David Rosenthal",
        tags: ["technology"],
        ...overrides,
    } as Episode;
}

describe("renderLead", () => {
    it("renders two-column grid when pullQuote is present", () => {
        const html = renderLead(ep({
            deck: "A four-hour conversation about compounding.",
            pullQuote: "Patience is the only moat that scales.",
        }));
        expect(html).toContain('class="bs-lead"');
        expect(html).not.toContain('class="bs-lead single"');
        expect(html).toContain("bs-pull");
        expect(html).toContain("Patience is the only moat that scales.");
    });

    it("collapses to single-column when pullQuote is missing", () => {
        const html = renderLead(ep({
            deck: "A deck line.",
            pullQuote: undefined,
        }));
        expect(html).toContain('class="bs-lead single"');
        expect(html).not.toContain("bs-pull");
    });

    it("falls back to empty deck when missing (no 'undefined' leak)", () => {
        const html = renderLead(ep({ deck: undefined, pullQuote: undefined }));
        expect(html).not.toContain("undefined");
    });

    it("renders the episode title as H1", () => {
        const html = renderLead(ep({ deck: "d", pullQuote: "q" }));
        expect(html).toMatch(/<h1[^>]*class="bs-lead-title"[^>]*>\s*<a[^>]*>\s*Nvidia/);
    });

    it("links to the episode detail page", () => {
        const html = renderLead(ep({ id: "abc123" }));
        expect(html).toContain('href="/episode/abc123"');
    });
});
