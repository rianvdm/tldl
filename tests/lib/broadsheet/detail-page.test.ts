import { describe, it, expect } from "vitest";
import { renderDetailPage } from "../../../src/lib/broadsheet/detail-page";
import type { Episode } from "../../../src/types";

function ep(overrides: Partial<Episode> = {}): Episode {
    return {
        id: "ep-1",
        appleUrl: "https://example.com",
        podcastName: "Acquired",
        episodeTitle: "Nvidia",
        episodeDuration: 15120,
        episodeDate: "2026-04-18",
        audioUrl: "https://example.com/a.mp3",
        transcriptSource: "rss",
        createdAt: "2026-04-18T00:00:00Z",
        expiresAt: "2027-04-18T00:00:00Z",
        podcastAuthor: "Ben Gilbert & David Rosenthal",
        tags: ["technology"],
        deck: "A deck.",
        pullQuote: "A quote.",
        ...overrides,
    } as Episode;
}

describe("renderDetailPage", () => {
    it("renders title, deck, and meta", () => {
        const html = renderDetailPage({
            episode: ep(),
            summaryHtml: "<p>Body</p>",
            activeTemplate: "key-takeaways",
            availableTemplates: ["key-takeaways", "narrative-summary"],
            transcriptText: null,
        });
        expect(html).toContain("Nvidia");
        expect(html).toContain("A deck.");
        expect(html).toContain("ACQUIRED");
    });

    it("shows only the templates that are available", () => {
        const html = renderDetailPage({
            episode: ep(),
            summaryHtml: "<p>Body</p>",
            activeTemplate: "key-takeaways",
            availableTemplates: ["key-takeaways", "eli5"],
            transcriptText: null,
        });
        expect(html).toContain("Key Takeaways");
        expect(html).toContain("ELI5");
        expect(html).not.toContain("Narrative");
    });

    it("marks the active template with the active class", () => {
        const html = renderDetailPage({
            episode: ep(),
            summaryHtml: "<p>Body</p>",
            activeTemplate: "eli5",
            availableTemplates: ["key-takeaways", "eli5"],
            transcriptText: null,
        });
        expect(html).toMatch(/class="tmpl active"[^>]*>[^<]*ELI5/);
    });

    it("template links carry ?template= query param", () => {
        const html = renderDetailPage({
            episode: ep({ id: "abc" }),
            summaryHtml: "<p>Body</p>",
            activeTemplate: "key-takeaways",
            availableTemplates: ["key-takeaways", "narrative-summary"],
            transcriptText: null,
        });
        expect(html).toContain('href="/episode/abc?template=narrative-summary"');
    });

    it("renders transcript when provided", () => {
        const html = renderDetailPage({
            episode: ep(),
            summaryHtml: "<p>Body</p>",
            activeTemplate: "key-takeaways",
            availableTemplates: ["key-takeaways"],
            transcriptText: "Host: Welcome to the show.",
        });
        expect(html).toContain("Full Transcript");
        expect(html).toContain("Host: Welcome to the show.");
        expect(html).not.toContain("transcript not available");
    });

    it("renders the fallback note when transcript is null", () => {
        const html = renderDetailPage({
            episode: ep(),
            summaryHtml: "<p>Body</p>",
            activeTemplate: "key-takeaways",
            availableTemplates: ["key-takeaways"],
            transcriptText: null,
        });
        expect(html).toContain("Full Transcript");
        expect(html).toContain("transcript not available for this episode");
        expect(html).toContain("bsd-transcript-missing");
    });

    it("renders the pull-quote block when episode has one", () => {
        const html = renderDetailPage({
            episode: ep({ pullQuote: "Memorable line." }),
            summaryHtml: "<p>Body</p>",
            activeTemplate: "key-takeaways",
            availableTemplates: ["key-takeaways"],
            transcriptText: null,
        });
        expect(html).toContain("bsd-pullquote");
        expect(html).toContain("Memorable line.");
    });

    it("omits the pull-quote block for ELI5 even when one exists", () => {
        const html = renderDetailPage({
            episode: ep({ pullQuote: "Memorable line." }),
            summaryHtml: "<p>Body</p>",
            activeTemplate: "eli5",
            availableTemplates: ["eli5"],
            transcriptText: null,
        });
        expect(html).not.toContain("bsd-pullquote");
    });
});
