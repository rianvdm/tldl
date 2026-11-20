import { describe, it, expect } from "vitest";
import { renderDetailPage } from "../src/lib/broadsheet/detail-page";
import type { Episode } from "../src/types";

function episode(overrides: Partial<Episode> = {}): Episode {
    return {
        id: "1769051199_rss_43abc3ee50",
        appleUrl: "https://podcasts.apple.com/us/podcast/scaling-slack/id1769051199?i=1000800061661",
        podcastName: "The Pragmatic Engineer",
        episodeTitle: "Scaling Slack and GitHub with Maude Lemaire",
        episodeDuration: 3600,
        episodeDate: "2026-11-05T15:58:00.000Z",
        audioUrl: "https://example.com/a.mp3",
        transcriptSource: "openai",
        createdAt: "2026-11-05T16:30:00.000Z",
        expiresAt: "2027-11-05T16:30:00.000Z",
        ...overrides,
    };
}

function render(ep: Episode): string {
    return renderDetailPage({
        episode: ep,
        summaryHtml: "<p>summary</p>",
        activeTemplate: "key-takeaways",
        availableTemplates: ["key-takeaways"],
        transcriptText: null,
    });
}

/** Text of each link in the "more from" row, in order. */
function moreLinks(html: string): string[] {
    const row = html.match(/<div class="bsd-morefrom">([\s\S]*?)<\/div>/)?.[1] ?? "";
    return [...row.matchAll(/<a [^>]*>([^<]*)<\/a>/g)].map(m => m[1]);
}

describe("detail page outbound links", () => {
    it("shows the episode page, website and Apple links when all are known", () => {
        const html = render(episode({
            episodePageUrl: "https://newsletter.pragmaticengineer.com/p/scaling-slack-and-github-with-maude",
            podcastWebsiteUrl: "https://newsletter.pragmaticengineer.com/podcast",
        }));

        expect(moreLinks(html)).toEqual([
            "All episodes from The Pragmatic Engineer →",
            "Episode page →",
            "Podcast website →",
            "Listen on Apple Podcasts →",
        ]);
        expect(html).toContain('href="https://newsletter.pragmaticengineer.com/p/scaling-slack-and-github-with-maude"');
    });

    it("omits the episode page link when the episode has none", () => {
        const html = render(episode({ podcastWebsiteUrl: "https://newsletter.pragmaticengineer.com/podcast" }));
        expect(moreLinks(html)).not.toContain("Episode page →");
    });
});

describe("detail page share image", () => {
    it("uses the episode card for og:image and twitter:image when given", () => {
        const url = "https://tldl-pod.com/og/episode/x.png?v=abc123abc123";
        const html = renderDetailPage({
            episode: episode(),
            summaryHtml: "",
            activeTemplate: "key-takeaways",
            availableTemplates: ["key-takeaways"],
            transcriptText: null,
            ogImageUrl: url,
        });
        expect(html).toContain(`<meta property="og:image" content="${url}">`);
        expect(html).toContain(`<meta name="twitter:image" content="${url}">`);
    });

    it("falls back to the default image without ogImageUrl", () => {
        expect(render(episode())).toContain("tldl-og-1200x630.png");
    });
});
