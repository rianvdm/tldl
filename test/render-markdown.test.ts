import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { SELF } from "cloudflare:test";
import { saveEpisode, saveSummary } from "../src/lib/kv";
import type { Episode, Summary } from "../src/types";

// ============================================================================
// Test Helpers
// ============================================================================

function createTestEpisode(overrides: Partial<Episode> = {}): Episode {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000);
    return {
        id: "xss_test_episode",
        appleUrl: "https://podcasts.apple.com/us/podcast/test/id999?i=001",
        podcastName: "XSS Test Podcast",
        episodeTitle: "XSS Test Episode",
        episodeDuration: 1800,
        episodeDate: "2024-01-15",
        audioUrl: "https://example.com/audio.mp3",
        transcriptSource: "rss",
        createdAt: now.toISOString(),
        expiresAt: expiresAt.toISOString(),
        ...overrides,
    };
}

function createTestSummary(overrides: Partial<Summary> = {}): Summary {
    return {
        episodeId: "xss_test_episode",
        templateId: "key-takeaways",
        text: "# Summary\n\nDefault summary text.",
        model: "gpt-5.4",
        createdAt: new Date().toISOString(),
        ...overrides,
    };
}

async function clearTestData() {
    const prefixes = ["episode:", "summary:"];
    for (const prefix of prefixes) {
        const keys = await env.TLDL_DATA.list({ prefix });
        await Promise.all(keys.keys.map((k) => env.TLDL_DATA.delete(k.name)));
    }
}

async function getEpisodePageHtml(episodeId: string): Promise<string> {
    const response = await SELF.fetch(`http://localhost/episode/${episodeId}`);
    return response.text();
}

// ============================================================================
// XSS Sanitization Tests
// Verify that renderMarkdown strips dangerous content from AI-generated summaries.
// ============================================================================

describe("renderMarkdown XSS sanitization (via GET /episode/:id)", () => {
    beforeEach(async () => {
        await clearTestData();
    });

    it("strips raw <script> tags from rendered summary output", async () => {
        const episode = createTestEpisode({ id: "xss_script_test" });
        const summary = createTestSummary({
            episodeId: "xss_script_test",
            text: "Normal intro.\n\n<script>alert('xss')</script>\n\nNormal outro.",
        });
        await saveEpisode(env.TLDL_DATA, episode);
        await saveSummary(env.TLDL_DATA, summary);

        const html = await getEpisodePageHtml("xss_script_test");

        // The script tag (or its contents) must not appear in the rendered HTML
        expect(html).not.toContain("<script>alert('xss')</script>");
        expect(html).not.toContain("alert('xss')");
    });

    it("strips event handler attributes (onerror=) from raw HTML in markdown", async () => {
        const episode = createTestEpisode({ id: "xss_onerror_test" });
        const summary = createTestSummary({
            episodeId: "xss_onerror_test",
            text: 'Some text.\n\n<img src="x" onerror="alert(1)">\n\nMore text.',
        });
        await saveEpisode(env.TLDL_DATA, episode);
        await saveSummary(env.TLDL_DATA, summary);

        const html = await getEpisodePageHtml("xss_onerror_test");

        // Check the specific payload is absent — avoids false positives from page template
        expect(html).not.toContain('onerror="alert(1)"');
    });

    it("strips javascript: href from links but preserves link text", async () => {
        const episode = createTestEpisode({ id: "xss_jslink_test" });
        const summary = createTestSummary({
            episodeId: "xss_jslink_test",
            text: "Click [this link](javascript:alert('xss')) for more.",
        });
        await saveEpisode(env.TLDL_DATA, episode);
        await saveSummary(env.TLDL_DATA, summary);

        const html = await getEpisodePageHtml("xss_jslink_test");

        // The dangerous href must not appear as an actual href attribute
        expect(html).not.toContain('href="javascript:');
        expect(html).not.toContain("href='javascript:");
        // But the link text should still appear
        expect(html).toContain("this link");
    });

    it("strips JAVASCRIPT: (uppercase) href from links", async () => {
        const episode = createTestEpisode({ id: "xss_jsupper_test" });
        const summary = createTestSummary({
            episodeId: "xss_jsupper_test",
            text: "Click [uppercase js link](JAVASCRIPT:alert('xss')) here.",
        });
        await saveEpisode(env.TLDL_DATA, episode);
        await saveSummary(env.TLDL_DATA, summary);

        const html = await getEpisodePageHtml("xss_jsupper_test");

        // The dangerous href must not appear as an actual href attribute (case-insensitive)
        expect(html).not.toContain('href="JAVASCRIPT:');
        expect(html.toLowerCase()).not.toContain('href="javascript:');
        // But the link text should still appear
        expect(html).toContain("uppercase js link");
    });

    it("strips data: URI hrefs from links", async () => {
        const episode = createTestEpisode({ id: "xss_datauri_test" });
        const summary = createTestSummary({
            episodeId: "xss_datauri_test",
            text: "Click [this link](data:text/html,<script>alert(1)</script>) here.",
        });
        await saveEpisode(env.TLDL_DATA, episode);
        await saveSummary(env.TLDL_DATA, summary);

        const html = await getEpisodePageHtml("xss_datauri_test");

        expect(html).not.toContain('href="data:');
        expect(html).toContain("this link");
    });

    it("escapes title attribute to prevent attribute injection", async () => {
        const episode = createTestEpisode({ id: "xss_title_test" });
        const summary = createTestSummary({
            episodeId: "xss_title_test",
            text: `[link](https://example.com 'x" onmouseover="alert(1)')`,
        });
        await saveEpisode(env.TLDL_DATA, episode);
        await saveSummary(env.TLDL_DATA, summary);

        const html = await getEpisodePageHtml("xss_title_test");

        expect(html).not.toContain('onmouseover="alert(1)"');
        expect(html).toContain("https://example.com");
    });

    // ============================================================================
    // Normal Markdown Rendering Tests
    // These should PASS today and after the fix.
    // ============================================================================

    it("preserves normal https:// links with href intact", async () => {
        const episode = createTestEpisode({ id: "md_https_test" });
        const summary = createTestSummary({
            episodeId: "md_https_test",
            text: "Read more at [example.com](https://example.com/page).",
        });
        await saveEpisode(env.TLDL_DATA, episode);
        await saveSummary(env.TLDL_DATA, summary);

        const html = await getEpisodePageHtml("md_https_test");

        expect(html).toContain('href="https://example.com/page"');
        expect(html).toContain("example.com");
    });

    it("renders bold markdown (**text**) as <strong> elements", async () => {
        const episode = createTestEpisode({ id: "md_bold_test" });
        const summary = createTestSummary({
            episodeId: "md_bold_test",
            text: "This is **bold text** in a summary.",
        });
        await saveEpisode(env.TLDL_DATA, episode);
        await saveSummary(env.TLDL_DATA, summary);

        const html = await getEpisodePageHtml("md_bold_test");

        expect(html).toContain("<strong>bold text</strong>");
    });

    it("renders bullet list items as <li> elements", async () => {
        const episode = createTestEpisode({ id: "md_list_test" });
        const summary = createTestSummary({
            episodeId: "md_list_test",
            text: "Key points:\n\n- First item\n- Second item\n- Third item\n",
        });
        await saveEpisode(env.TLDL_DATA, episode);
        await saveSummary(env.TLDL_DATA, summary);

        const html = await getEpisodePageHtml("md_list_test");

        expect(html).toContain("<li>First item</li>");
        expect(html).toContain("<li>Second item</li>");
        expect(html).toContain("<li>Third item</li>");
    });
});
