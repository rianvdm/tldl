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
    appendActivityEvent,
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
    const prefixes = ["episode:", "episodes:", "transcript:", "summary:", "job:"];
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

    it("empty URL on admin submit shows validation error", async () => {
        const formData = new FormData();
        formData.append("appleUrl", "");
        formData.append("templateId", "key-takeaways");

        const response = await SELF.fetch("http://localhost/admin/submit", {
            method: "POST",
            body: formData,
        });

        expect(response.status).toBe(200);
        const html = await response.text();
        expect(html).toContain("Please enter an Apple Podcasts URL");
    });

    it("invalid template ID on admin submit shows error", async () => {
        const response = await SELF.fetch("http://localhost/admin/submit", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                appleUrl: "https://podcasts.apple.com/us/podcast/test/id123?i=456",
                templateId: "nonexistent-template",
            }),
        });

        expect(response.status).toBe(200);
        const html = await response.text();
        expect(html).toContain("Invalid summary template");
    });
});

// ============================================================================
// Admin CRUD Flow Tests
// ============================================================================

describe("Integration: Admin CRUD Flow", () => {
    beforeEach(async () => {
        await clearTestData();
        await env.TLDL_DATA.delete("activity:log");
    });

    it("full admin lifecycle: create → view → edit tags → edit summary → delete", async () => {
        // Step 1: Create episode data (simulating what the queue consumer would produce)
        // Use ID "123_456" to match deriveEpisodeId("123", "456") from the apple URL
        const episode = createSampleEpisode({
            id: "123_456",
            appleUrl: "https://podcasts.apple.com/us/podcast/test-podcast/id123?i=456",
        });
        const transcript = createSampleTranscript({ episodeId: episode.id });
        const summary = createSampleSummary({ episodeId: episode.id });

        await saveEpisode(env.TLDL_DATA, episode);
        await saveTranscript(env.TLDL_DATA, transcript);
        await saveSummary(env.TLDL_DATA, summary);

        // Step 2: Episode appears on admin dashboard
        const dashboardResponse = await SELF.fetch("http://localhost/admin");
        expect(dashboardResponse.status).toBe(200);
        const dashboardHtml = await dashboardResponse.text();
        expect(dashboardHtml).toContain("Integration Test Podcast");
        expect(dashboardHtml).toContain("Integration Test Episode");

        // Step 3: Episode appears on public home page
        const homeResponse = await SELF.fetch("http://localhost/");
        expect(homeResponse.status).toBe(200);
        const homeHtml = await homeResponse.text();
        expect(homeHtml).toContain("Integration Test Episode");

        // Step 4: Edit tags via admin API
        const tagResponse = await SELF.fetch(
            `http://localhost/admin/episodes/${episode.id}/tags`,
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ tags: ["technology", "ai"] }),
            }
        );
        expect(tagResponse.status).toBe(200);
        const tagData = await tagResponse.json() as { success: boolean; tags: string[] };
        expect(tagData.tags).toEqual(["technology", "ai"]);

        // Step 5: Get summaries via admin API
        const summariesResponse = await SELF.fetch(
            `http://localhost/admin/episodes/${episode.id}/summaries`
        );
        expect(summariesResponse.status).toBe(200);
        const summariesData = await summariesResponse.json() as {
            summaries: Array<{ templateId: string; text: string }>;
        };
        expect(summariesData.summaries).toHaveLength(1);
        expect(summariesData.summaries[0].templateId).toBe("key-takeaways");

        // Step 6: Edit summary text via admin API
        const editResponse = await SELF.fetch(
            `http://localhost/admin/episodes/${episode.id}/summaries/key-takeaways`,
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ text: "Updated summary content" }),
            }
        );
        expect(editResponse.status).toBe(200);

        // Verify the summary was actually updated
        const updatedSummary = await getSummary(env.TLDL_DATA, episode.id, "key-takeaways");
        expect(updatedSummary).not.toBeNull();
        expect(updatedSummary!.text).toBe("Updated summary content");

        // Step 7: Submit same episode URL → should redirect to existing episode
        const resubmitResponse = await SELF.fetch("http://localhost/admin/submit", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                appleUrl: episode.appleUrl,
                templateId: "key-takeaways",
            }),
            redirect: "manual",
        });
        expect(resubmitResponse.status).toBe(302);
        expect(resubmitResponse.headers.get("Location")).toBe(`/episode/${episode.id}`);

        // Step 8: Delete episode via admin
        const deleteResponse = await SELF.fetch(
            `http://localhost/admin/episodes/${episode.id}/delete`,
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
            }
        );
        expect(deleteResponse.status).toBe(200);

        // Step 9: Verify everything is gone
        expect(await getEpisode(env.TLDL_DATA, episode.id)).toBeNull();
        expect(await getTranscript(env.TLDL_DATA, episode.id)).toBeNull();
        expect(await getSummary(env.TLDL_DATA, episode.id, "key-takeaways")).toBeNull();

        // Step 10: Public page no longer shows the episode
        const homeAfterDelete = await SELF.fetch("http://localhost/");
        const homeAfterHtml = await homeAfterDelete.text();
        expect(homeAfterHtml).not.toContain("Integration Test Episode");
    });

    it("admin dashboard shows stats and activity together", async () => {
        // Create some episodes
        await saveEpisode(env.TLDL_DATA, createSampleEpisode({ id: "ep1", podcastName: "Podcast A" }));
        await saveEpisode(env.TLDL_DATA, createSampleEpisode({ id: "ep2", podcastName: "Podcast B" }));

        // Add activity events
        await appendActivityEvent(env.TLDL_DATA, {
            type: "episode_completed",
            timestamp: new Date().toISOString(),
            title: "Podcast A: Great Episode",
            episodeId: "ep1",
        });
        await appendActivityEvent(env.TLDL_DATA, {
            type: "monitor_check",
            timestamp: new Date().toISOString(),
            title: "Monitoring check: 3 podcasts, 0 new episodes",
        });

        // Dashboard should show both stats and activity
        const response = await SELF.fetch("http://localhost/admin");
        expect(response.status).toBe(200);
        const html = await response.text();

        // Stats
        expect(html).toContain("Episodes");
        expect(html).toContain("Podcasts");

        // Activity
        expect(html).toContain("Recent Activity");
        expect(html).toContain("Podcast A: Great Episode");
        expect(html).toContain("Monitoring check: 3 podcasts, 0 new episodes");

        // Episode list
        expect(html).toContain("Podcast A");
        expect(html).toContain("Podcast B");
    });
});

// ============================================================================
// Public vs Admin Access Flow Tests
// ============================================================================

describe("Integration: Public vs Admin Access", () => {
    beforeEach(async () => {
        await clearTestData();
    });

    it("public pages work, removed routes 404, admin routes accessible", async () => {
        // Create test data
        const episode = createSampleEpisode();
        await saveEpisode(env.TLDL_DATA, episode);
        await saveSummary(env.TLDL_DATA, createSampleSummary({ episodeId: episode.id }));

        // Public pages work
        expect((await SELF.fetch("http://localhost/")).status).toBe(200);
        expect((await SELF.fetch("http://localhost/about")).status).toBe(200);
        expect((await SELF.fetch("http://localhost/podcasts")).status).toBe(200);
        expect((await SELF.fetch(`http://localhost/episode/${episode.id}`)).status).toBe(200);
        expect((await SELF.fetch("http://localhost/feed")).status).toBe(200);

        // Removed routes return 404
        expect((await SELF.fetch("http://localhost/submit")).status).toBe(404);
        expect((await SELF.fetch("http://localhost/waitlist")).status).toBe(404);
        expect((await SELF.fetch("http://localhost/profile")).status).toBe(404);
        expect((await SELF.fetch("http://localhost/job/test-id")).status).toBe(404);

        // Admin routes work (dev mode = auto-authenticated)
        expect((await SELF.fetch("http://localhost/admin")).status).toBe(200);
        expect((await SELF.fetch("http://localhost/admin/submit")).status).toBe(200);
        expect((await SELF.fetch("http://localhost/admin/podcasts")).status).toBe(200);

        // Admin trailing slash redirects
        const slashResponse = await SELF.fetch("http://localhost/admin/", { redirect: "manual" });
        expect(slashResponse.status).toBe(301);
        expect(slashResponse.headers.get("Location")).toBe("/admin");
    });

    it("public nav has no login, submit, or auth elements", async () => {
        const response = await SELF.fetch("http://localhost/");
        const html = await response.text();

        // Should NOT contain auth elements
        expect(html).not.toContain('id="nav-auth-link"');
        expect(html).not.toContain("auth-logged-out");
        expect(html).not.toContain("auth-logged-in");
        expect(html).not.toContain('href="/submit"');
        expect(html).not.toContain('href="/profile"');
        expect(html).not.toContain('href="/waitlist"');
        expect(html).not.toContain("__authCheck");
        expect(html).not.toContain("tldl-auth");

        // Should contain public nav links
        expect(html).toContain('href="/podcasts"');
        expect(html).toContain('href="/about"');
    });
});
