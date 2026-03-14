import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { SELF } from "cloudflare:test";
import {
    saveEpisode,
    saveTranscript,
    saveSummary,
    getEpisode,
    getTranscript,
    getSummary,
} from "../../src/lib/kv";
import type { Episode, Transcript, Summary } from "../../src/types";

// ============================================================================
// Integration Tests for TLDL
// 
// These tests verify end-to-end flows that don't require queue processing.
// Tests that trigger the queue (POST /submit with new episodes) are excluded
// due to Durable Objects storage isolation issues in vitest-pool-workers.
// 
// For full queue-based flow testing, use manual testing:
// 1. npm run dev
// 2. Submit an episode via the web UI
// 3. Watch logs with wrangler tail
// ============================================================================

// Helper functions
function createSampleEpisode(overrides: Partial<Episode> = {}): Episode {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000);
    return {
        id: "integration_test_123_456",
        appleUrl: "https://podcasts.apple.com/us/podcast/test-podcast/id123?i=456",
        podcastName: "Integration Test Podcast",
        episodeTitle: "Integration Test Episode",
        episodeDuration: 1800,
        episodeDate: "2024-06-15",
        audioUrl: "https://example.com/audio.mp3",
        transcriptSource: "rss",
        createdAt: now.toISOString(),
        expiresAt: expiresAt.toISOString(),
        ...overrides,
    };
}

function createSampleTranscript(overrides: Partial<Transcript> = {}): Transcript {
    return {
        episodeId: "integration_test_123_456",
        text: "This is a full transcript of the podcast episode. It contains multiple sentences and paragraphs to simulate real content.",
        source: "rss",
        createdAt: new Date().toISOString(),
        ...overrides,
    };
}

function createSampleSummary(overrides: Partial<Summary> = {}): Summary {
    return {
        episodeId: "integration_test_123_456",
        templateId: "key-takeaways",
        text: "# Key Takeaways\n\n## Overview\nThis episode covers important topics.\n\n## Main Points\n- Point one\n- Point two\n- Point three",
        model: "gpt-4o",
        createdAt: new Date().toISOString(),
        ...overrides,
    };
}

async function clearTestData() {
    const prefixes = ["episode:", "transcript:", "summary:", "job:"];
    for (const prefix of prefixes) {
        const keys = await env.TLDL_DATA.list({ prefix });
        await Promise.all(keys.keys.map((k) => env.TLDL_DATA.delete(k.name)));
    }
}

// ============================================================================
// Cached Episode Flow Tests
// ============================================================================

describe("Integration: Episode View Flow", () => {
    beforeEach(async () => {
        await clearTestData();
    });

    it("full view flow: list → detail", async () => {
        // Setup: Create complete episode data
        const episode = createSampleEpisode();
        const transcript = createSampleTranscript({ episodeId: episode.id });
        const summary = createSampleSummary({ episodeId: episode.id });

        await saveEpisode(env.TLDL_DATA, episode);
        await saveTranscript(env.TLDL_DATA, transcript);
        await saveSummary(env.TLDL_DATA, summary);

        // Step 1: View episode list (HTML)
        const listResponse = await SELF.fetch("http://localhost/");
        expect(listResponse.status).toBe(200);
        const listHtml = await listResponse.text();
        expect(listHtml).toContain("Integration Test Podcast");
        expect(listHtml).toContain("Integration Test Episode");

        // Step 2: View episode list (JSON API)
        const apiListResponse = await SELF.fetch("http://localhost/api/episodes");
        expect(apiListResponse.status).toBe(200);
        const apiListData = await apiListResponse.json() as { episodes: Episode[] };
        expect(apiListData.episodes.length).toBeGreaterThan(0);
        expect(apiListData.episodes[0].id).toBe(episode.id);

        // Step 3: View episode detail (HTML)
        const detailResponse = await SELF.fetch(`http://localhost/episode/${episode.id}`);
        expect(detailResponse.status).toBe(200);
        const detailHtml = await detailResponse.text();
        expect(detailHtml).toContain("Integration Test Episode");
        expect(detailHtml).toContain("Key Takeaways");

        // Step 4: View episode detail (JSON API)
        const apiDetailResponse = await SELF.fetch(`http://localhost/api/episode/${episode.id}`);
        expect(apiDetailResponse.status).toBe(200);
        const apiDetailData = await apiDetailResponse.json() as {
            episode: Episode;
            summaries: Summary[];
            transcript: Transcript | null;
        };
        expect(apiDetailData.episode.id).toBe(episode.id);
        expect(apiDetailData.summaries.length).toBe(1);
        expect(apiDetailData.transcript).not.toBeNull();
    });
});

// ============================================================================
// Multiple Template Flow Tests
// ============================================================================

describe("Integration: Multiple Templates Flow", () => {
    beforeEach(async () => {
        await clearTestData();
    });

    it("episode with multiple summaries shows all templates", async () => {
        const episode = createSampleEpisode();
        const transcript = createSampleTranscript({ episodeId: episode.id });

        await saveEpisode(env.TLDL_DATA, episode);
        await saveTranscript(env.TLDL_DATA, transcript);

        // Create summaries for all three templates
        const templates = ["key-takeaways", "narrative-summary", "eli5"];
        for (const templateId of templates) {
            await saveSummary(env.TLDL_DATA, createSampleSummary({
                episodeId: episode.id,
                templateId,
                text: `# ${templateId} Summary\n\nContent for ${templateId}`,
            }));
        }

        // Check HTML page shows all templates
        const response = await SELF.fetch(`http://localhost/episode/${episode.id}`);
        const html = await response.text();
        
        expect(html).toContain("key-takeaways");
        expect(html).toContain("narrative-summary");
        expect(html).toContain("eli5");

        // Check API returns all summaries
        const apiResponse = await SELF.fetch(`http://localhost/api/episode/${episode.id}`);
        const data = await apiResponse.json() as { summaries: Summary[] };
        expect(data.summaries.length).toBe(3);
    });

    it("can view specific template via query parameter", async () => {
        const episode = createSampleEpisode();
        await saveEpisode(env.TLDL_DATA, episode);
        await saveSummary(env.TLDL_DATA, createSampleSummary({
            episodeId: episode.id,
            templateId: "eli5",
            text: "# ELI5 Summary\n\nSimple explanation here.",
        }));

        const response = await SELF.fetch(`http://localhost/episode/${episode.id}?template=eli5`);
        expect(response.status).toBe(200);
        const html = await response.text();
        expect(html).toContain("ELI5 Summary");
    });
});

// ============================================================================
// Delete Flow Tests
// ============================================================================

describe("Integration: Delete Episode Flow", () => {
    beforeEach(async () => {
        await clearTestData();
    });

    it("deleting episode removes all related data", async () => {
        // Setup: Create complete episode data
        const episode = createSampleEpisode();
        const transcript = createSampleTranscript({ episodeId: episode.id });
        const summary1 = createSampleSummary({ episodeId: episode.id, templateId: "key-takeaways" });
        const summary2 = createSampleSummary({ episodeId: episode.id, templateId: "eli5" });

        await saveEpisode(env.TLDL_DATA, episode);
        await saveTranscript(env.TLDL_DATA, transcript);
        await saveSummary(env.TLDL_DATA, summary1);
        await saveSummary(env.TLDL_DATA, summary2);

        // Verify data exists
        expect(await getEpisode(env.TLDL_DATA, episode.id)).not.toBeNull();
        expect(await getTranscript(env.TLDL_DATA, episode.id)).not.toBeNull();
        expect(await getSummary(env.TLDL_DATA, episode.id, "key-takeaways")).not.toBeNull();

        // Delete via admin API
        const deleteResponse = await SELF.fetch(`http://localhost/admin/episodes/${episode.id}`, {
            method: "DELETE",
            headers: { "Content-Type": "application/json" },
        });
        expect(deleteResponse.status).toBe(200);

        // Verify all data is gone
        expect(await getEpisode(env.TLDL_DATA, episode.id)).toBeNull();
        expect(await getTranscript(env.TLDL_DATA, episode.id)).toBeNull();
        expect(await getSummary(env.TLDL_DATA, episode.id, "key-takeaways")).toBeNull();
        expect(await getSummary(env.TLDL_DATA, episode.id, "eli5")).toBeNull();

        // Verify 404 on detail page
        const detailResponse = await SELF.fetch(`http://localhost/episode/${episode.id}`);
        expect(detailResponse.status).toBe(404);

        // Verify not in list
        const listResponse = await SELF.fetch("http://localhost/api/episodes");
        const listData = await listResponse.json() as { episodes: Episode[] };
        expect(listData.episodes.find(e => e.id === episode.id)).toBeUndefined();
    });
});

// ============================================================================
// Error Handling Flow Tests
// ============================================================================

describe("Integration: Error Handling", () => {
    beforeEach(async () => {
        await clearTestData();
    });

    it("invalid URL on admin submit shows helpful error", async () => {
        const formData = new FormData();
        formData.append("appleUrl", "https://spotify.com/episode/123");
        formData.append("templateId", "key-takeaways");

        const response = await SELF.fetch("http://localhost/admin/submit", {
            method: "POST",
            body: formData,
        });

        expect(response.status).toBe(200); // Admin submit returns HTML error page with 200
        const html = await response.text();
        expect(html).toContain("Invalid Apple Podcasts episode URL");
    });

    it("non-existent episode returns 404 with helpful message", async () => {
        const response = await SELF.fetch("http://localhost/episode/non-existent-id");
        expect(response.status).toBe(404);
        const html = await response.text();
        expect(html).toContain("Episode Not Found");
    });
});
