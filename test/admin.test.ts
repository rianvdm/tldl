import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { SELF } from "cloudflare:test";
import {
    createJob,
    getJob,
    saveEpisode,
    getEpisode,
    saveTranscript,
    getTranscript,
    saveSummary,
    getSummary,
    listSummariesForEpisode,
    appendActivityEvent,
    getActivityLog,
} from "../src/lib/kv";
import type { Episode, Transcript, Summary, Job } from "../src/types";

// ============================================================================
// Helper Functions
// ============================================================================

function createSampleEpisode(overrides: Partial<Episode> = {}): Episode {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000);
    return {
        id: "123_456",
        appleUrl: "https://podcasts.apple.com/us/podcast/test/id123?i=456",
        podcastName: "Test Podcast",
        episodeTitle: "Test Episode",
        episodeDuration: 2700,
        episodeDate: "2024-01-15",
        audioUrl: "https://example.com/audio.mp3",
        transcriptSource: "rss",
        createdAt: now.toISOString(),
        expiresAt: expiresAt.toISOString(),
        ...overrides,
    };
}

function createSampleTranscript(
    overrides: Partial<Transcript> = {}
): Transcript {
    return {
        episodeId: "123_456",
        text: "This is a sample transcript text for the episode.",
        source: "rss",
        createdAt: new Date().toISOString(),
        ...overrides,
    };
}

function createSampleSummary(overrides: Partial<Summary> = {}): Summary {
    return {
        episodeId: "123_456",
        templateId: "key-takeaways",
        text: "# Key Takeaways\n\nThis is a sample summary.",
        model: "gpt-5.2",
        createdAt: new Date().toISOString(),
        ...overrides,
    };
}

function createSampleJob(overrides: Partial<Job> = {}): Job {
    const now = new Date().toISOString();
    return {
        id: "job-123",
        episodeId: "123_456",
        appleUrl: "https://podcasts.apple.com/us/podcast/test/id123?i=456",
        status: "queued",
        templateId: "key-takeaways",
        createdAt: now,
        updatedAt: now,
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
// GET /admin — Dashboard
// ============================================================================

describe("GET /admin", () => {
    beforeEach(async () => {
        await clearTestData();
    });

    it("renders admin dashboard HTML", async () => {
        const response = await SELF.fetch("http://localhost/admin");
        expect(response.status).toBe(200);
        const html = await response.text();
        expect(html).toContain("Admin Dashboard");
        expect(html).toContain("Submit Episode");
        expect(html).toContain("Manage Podcasts");
    });

    it("shows episodes in the dashboard", async () => {
        const episode = createSampleEpisode();
        await saveEpisode(env.TLDL_DATA, episode);
        await saveSummary(env.TLDL_DATA, createSampleSummary());

        const response = await SELF.fetch("http://localhost/admin");
        expect(response.status).toBe(200);
        const html = await response.text();
        expect(html).toContain("Test Podcast");
        expect(html).toContain("Test Episode");
    });

    it("shows empty state when no episodes", async () => {
        const response = await SELF.fetch("http://localhost/admin");
        expect(response.status).toBe(200);
        const html = await response.text();
        expect(html).toContain("No episodes yet");
    });

    it("supports pagination", async () => {
        const response = await SELF.fetch("http://localhost/admin?page=1");
        expect(response.status).toBe(200);
    });
});

// ============================================================================
// GET /admin/submit — Submit Form Page
// ============================================================================

describe("GET /admin/submit", () => {
    it("renders the submit form", async () => {
        const response = await SELF.fetch("http://localhost/admin/submit");
        expect(response.status).toBe(200);
        const html = await response.text();
        expect(html).toContain("Submit Episode");
        expect(html).toContain("Episode URL");
        expect(html).toContain("Summary Style");
    });
});

// ============================================================================
// POST /admin/submit — Episode Submission
// ============================================================================

describe("POST /admin/submit — validation", () => {
    beforeEach(async () => {
        await clearTestData();
    });

    it("redirects to episode when already cached", async () => {
        const episode = createSampleEpisode();
        const summary = createSampleSummary();
        await saveEpisode(env.TLDL_DATA, episode);
        await saveSummary(env.TLDL_DATA, summary);

        const response = await SELF.fetch("http://localhost/admin/submit", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                appleUrl: "https://podcasts.apple.com/us/podcast/test-podcast/id123?i=456",
                templateId: "key-takeaways",
            }),
            redirect: "manual",
        });

        expect(response.status).toBe(302);
        expect(response.headers.get("Location")).toBe("/episode/123_456");
    });

    it("shows error for invalid URL via form", async () => {
        const formData = new FormData();
        formData.append("appleUrl", "https://spotify.com/episode/123");
        formData.append("templateId", "key-takeaways");

        const response = await SELF.fetch("http://localhost/admin/submit", {
            method: "POST",
            body: formData,
        });

        expect(response.status).toBe(200);
        const html = await response.text();
        expect(html).toContain("Please enter an Apple Podcasts episode URL or a YouTube video URL");
    });

    it("shows error for empty URL via form", async () => {
        const formData = new FormData();
        formData.append("appleUrl", "");
        formData.append("templateId", "key-takeaways");

        const response = await SELF.fetch("http://localhost/admin/submit", {
            method: "POST",
            body: formData,
        });

        expect(response.status).toBe(200);
        const html = await response.text();
        expect(html).toContain("Please enter an Apple Podcasts episode URL or a YouTube video URL");
    });

    it("shows error for invalid URL via JSON", async () => {
        const response = await SELF.fetch("http://localhost/admin/submit", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                appleUrl: "https://spotify.com/episode/123",
                templateId: "key-takeaways",
            }),
        });

        expect(response.status).toBe(200);
        const html = await response.text();
        expect(html).toContain("Please enter an Apple Podcasts episode URL or a YouTube video URL");
    });
});

// NOTE: Tests for successful submit (creating jobs via DO + queue) are excluded
// from automated tests due to Durable Objects storage isolation issues in
// vitest-pool-workers. The submit handler calls createJobDO() which breaks
// isolated storage. Test these flows manually via `npm run dev`.
// See: https://github.com/cloudflare/workers-sdk/issues/4985

// ============================================================================
// POST /admin/episodes/:id/delete — Delete Episode
// ============================================================================

describe("POST /admin/episodes/:id/delete", () => {
    beforeEach(async () => {
        await clearTestData();
    });

    it("deletes episode and all related data", async () => {
        const episode = createSampleEpisode();
        const transcript = createSampleTranscript({ episodeId: episode.id });
        const summary = createSampleSummary({ episodeId: episode.id });

        await saveEpisode(env.TLDL_DATA, episode);
        await saveTranscript(env.TLDL_DATA, transcript);
        await saveSummary(env.TLDL_DATA, summary);

        const response = await SELF.fetch(
            `http://localhost/admin/episodes/${episode.id}/delete`,
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
            }
        );

        expect(response.status).toBe(200);
        const data = (await response.json()) as { deleted: boolean };
        expect(data.deleted).toBe(true);

        // Verify everything is deleted
        expect(await getEpisode(env.TLDL_DATA, episode.id)).toBeNull();
        expect(await getTranscript(env.TLDL_DATA, episode.id)).toBeNull();
        expect(await listSummariesForEpisode(env.TLDL_DATA, episode.id)).toHaveLength(0);
    });

    it("returns 404 for non-existent episode", async () => {
        const response = await SELF.fetch(
            "http://localhost/admin/episodes/non-existent/delete",
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
            }
        );

        expect(response.status).toBe(404);
        const data = (await response.json()) as { error: string };
        expect(data.error).toBe("Episode not found");
    });
});

// ============================================================================
// DELETE /admin/episodes/:id — Delete Episode (REST)
// ============================================================================

describe("DELETE /admin/episodes/:id", () => {
    beforeEach(async () => {
        await clearTestData();
    });

    it("deletes episode via REST DELETE", async () => {
        const episode = createSampleEpisode();
        await saveEpisode(env.TLDL_DATA, episode);

        const response = await SELF.fetch(
            `http://localhost/admin/episodes/${episode.id}`,
            { method: "DELETE" }
        );

        expect(response.status).toBe(200);
        const data = (await response.json()) as { deleted: boolean };
        expect(data.deleted).toBe(true);

        expect(await getEpisode(env.TLDL_DATA, episode.id)).toBeNull();
    });

    it("returns 404 for non-existent episode", async () => {
        const response = await SELF.fetch(
            "http://localhost/admin/episodes/non-existent",
            { method: "DELETE" }
        );

        expect(response.status).toBe(404);
    });
});

// ============================================================================
// POST /admin/episodes/:id/tags — Update Episode Tags
// ============================================================================

describe("POST /admin/episodes/:id/tags", () => {
    beforeEach(async () => {
        await clearTestData();
    });

    it("updates tags for an episode", async () => {
        const episode = createSampleEpisode();
        await saveEpisode(env.TLDL_DATA, episode);

        const response = await SELF.fetch(
            `http://localhost/admin/episodes/${episode.id}/tags`,
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ tags: ["technology", "ai"] }),
            }
        );

        expect(response.status).toBe(200);
        const data = (await response.json()) as { success: boolean; tags: string[] };
        expect(data.success).toBe(true);
        expect(data.tags).toEqual(["technology", "ai"]);
    });

    it("rejects invalid tags", async () => {
        const episode = createSampleEpisode();
        await saveEpisode(env.TLDL_DATA, episode);

        const response = await SELF.fetch(
            `http://localhost/admin/episodes/${episode.id}/tags`,
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ tags: ["not-a-real-tag"] }),
            }
        );

        expect(response.status).toBe(400);
        const data = (await response.json()) as { error: string };
        expect(data.error).toContain("Invalid tags");
    });

    it("rejects empty tags array", async () => {
        const episode = createSampleEpisode();
        await saveEpisode(env.TLDL_DATA, episode);

        const response = await SELF.fetch(
            `http://localhost/admin/episodes/${episode.id}/tags`,
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ tags: [] }),
            }
        );

        expect(response.status).toBe(400);
        const data = (await response.json()) as { error: string };
        expect(data.error).toContain("between 1 and 4 tags");
    });

    it("rejects more than 4 tags", async () => {
        const episode = createSampleEpisode();
        await saveEpisode(env.TLDL_DATA, episode);

        const response = await SELF.fetch(
            `http://localhost/admin/episodes/${episode.id}/tags`,
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    tags: ["technology", "ai", "science", "politics", "business"],
                }),
            }
        );

        expect(response.status).toBe(400);
    });

    it("returns 404 for non-existent episode", async () => {
        const response = await SELF.fetch(
            "http://localhost/admin/episodes/non-existent/tags",
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ tags: ["technology"] }),
            }
        );

        expect(response.status).toBe(404);
    });

    it("returns 400 for non-array tags", async () => {
        const episode = createSampleEpisode();
        await saveEpisode(env.TLDL_DATA, episode);

        const response = await SELF.fetch(
            `http://localhost/admin/episodes/${episode.id}/tags`,
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ tags: "technology" }),
            }
        );

        expect(response.status).toBe(400);
        const data = (await response.json()) as { error: string };
        expect(data.error).toContain("tags must be an array");
    });
});

// ============================================================================
// GET /admin/episodes/:id/summaries — List Summaries
// ============================================================================

describe("GET /admin/episodes/:id/summaries", () => {
    beforeEach(async () => {
        await clearTestData();
    });

    it("returns all summaries for an episode", async () => {
        const episode = createSampleEpisode();
        await saveEpisode(env.TLDL_DATA, episode);
        await saveSummary(env.TLDL_DATA, createSampleSummary({ templateId: "key-takeaways" }));
        await saveSummary(env.TLDL_DATA, createSampleSummary({ templateId: "eli5", text: "Simple version" }));

        const response = await SELF.fetch(
            `http://localhost/admin/episodes/${episode.id}/summaries`
        );

        expect(response.status).toBe(200);
        const data = (await response.json()) as {
            episodeId: string;
            episodeTitle: string;
            summaries: Array<{ templateId: string; templateName: string; text: string }>;
        };

        expect(data.episodeId).toBe(episode.id);
        expect(data.episodeTitle).toBe("Test Episode");
        expect(data.summaries).toHaveLength(2);
    });

    it("returns empty summaries array when none exist", async () => {
        const episode = createSampleEpisode();
        await saveEpisode(env.TLDL_DATA, episode);

        const response = await SELF.fetch(
            `http://localhost/admin/episodes/${episode.id}/summaries`
        );

        expect(response.status).toBe(200);
        const data = (await response.json()) as { summaries: unknown[] };
        expect(data.summaries).toHaveLength(0);
    });

    it("returns 404 for non-existent episode", async () => {
        const response = await SELF.fetch(
            "http://localhost/admin/episodes/non-existent/summaries"
        );

        expect(response.status).toBe(404);
    });
});

// ============================================================================
// POST /admin/episodes/:id/summaries/:templateId — Update Summary
// ============================================================================

describe("POST /admin/episodes/:id/summaries/:templateId", () => {
    beforeEach(async () => {
        await clearTestData();
    });

    it("updates an existing summary", async () => {
        const episode = createSampleEpisode();
        await saveEpisode(env.TLDL_DATA, episode);
        await saveSummary(env.TLDL_DATA, createSampleSummary());

        const response = await SELF.fetch(
            `http://localhost/admin/episodes/${episode.id}/summaries/key-takeaways`,
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ text: "Updated summary text" }),
            }
        );

        expect(response.status).toBe(200);
        const data = (await response.json()) as { success: boolean; templateId: string };
        expect(data.success).toBe(true);
        expect(data.templateId).toBe("key-takeaways");

        // Verify the summary was actually updated
        const updated = await getSummary(env.TLDL_DATA, episode.id, "key-takeaways");
        expect(updated).not.toBeNull();
        expect(updated!.text).toBe("Updated summary text");
    });

    it("returns 404 when summary does not exist", async () => {
        const episode = createSampleEpisode();
        await saveEpisode(env.TLDL_DATA, episode);
        // No summary saved

        const response = await SELF.fetch(
            `http://localhost/admin/episodes/${episode.id}/summaries/key-takeaways`,
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ text: "New text" }),
            }
        );

        expect(response.status).toBe(404);
        const data = (await response.json()) as { error: string };
        expect(data.error).toContain("Summary not found");
    });

    it("returns 404 for non-existent episode", async () => {
        const response = await SELF.fetch(
            "http://localhost/admin/episodes/non-existent/summaries/key-takeaways",
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ text: "New text" }),
            }
        );

        expect(response.status).toBe(404);
    });

    it("returns 400 for invalid template ID", async () => {
        const episode = createSampleEpisode();
        await saveEpisode(env.TLDL_DATA, episode);

        const response = await SELF.fetch(
            `http://localhost/admin/episodes/${episode.id}/summaries/invalid-template`,
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ text: "New text" }),
            }
        );

        expect(response.status).toBe(400);
        const data = (await response.json()) as { error: string };
        expect(data.error).toContain("Invalid template ID");
    });

    it("returns 400 when text is missing", async () => {
        const episode = createSampleEpisode();
        await saveEpisode(env.TLDL_DATA, episode);
        await saveSummary(env.TLDL_DATA, createSampleSummary());

        const response = await SELF.fetch(
            `http://localhost/admin/episodes/${episode.id}/summaries/key-takeaways`,
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({}),
            }
        );

        expect(response.status).toBe(400);
        const data = (await response.json()) as { error: string };
        expect(data.error).toContain("text field is required");
    });
});

// ============================================================================
// POST /admin/episodes/:id/regenerate — Regenerate Summary
// ============================================================================

describe("POST /admin/episodes/:id/regenerate", () => {
    beforeEach(async () => {
        await clearTestData();
    });

    it("creates regeneration job for existing episode", async () => {
        const episode = createSampleEpisode();
        const transcript = createSampleTranscript({ episodeId: episode.id });
        await saveEpisode(env.TLDL_DATA, episode);
        await saveTranscript(env.TLDL_DATA, transcript);

        const response = await SELF.fetch(
            `http://localhost/admin/episodes/${episode.id}/regenerate`,
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ templateId: "eli5" }),
            }
        );

        expect(response.status).toBe(201);
        const data = (await response.json()) as {
            jobId: string;
            status: string;
            cached: boolean;
        };

        expect(data.jobId).toBeDefined();
        expect(data.status).toBe("queued");
        expect(data.cached).toBe(false);
    });

    it("returns cached when summary already exists", async () => {
        const episode = createSampleEpisode();
        const transcript = createSampleTranscript({ episodeId: episode.id });
        const summary = createSampleSummary({
            episodeId: episode.id,
            templateId: "eli5",
        });
        await saveEpisode(env.TLDL_DATA, episode);
        await saveTranscript(env.TLDL_DATA, transcript);
        await saveSummary(env.TLDL_DATA, summary);

        const response = await SELF.fetch(
            `http://localhost/admin/episodes/${episode.id}/regenerate`,
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ templateId: "eli5" }),
            }
        );

        expect(response.status).toBe(200);
        const data = (await response.json()) as { cached: boolean };
        expect(data.cached).toBe(true);
    });

    it("returns 404 for non-existent episode", async () => {
        const response = await SELF.fetch(
            "http://localhost/admin/episodes/non-existent/regenerate",
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ templateId: "eli5" }),
            }
        );

        expect(response.status).toBe(404);
    });

    it("returns 400 when transcript is missing", async () => {
        const episode = createSampleEpisode();
        await saveEpisode(env.TLDL_DATA, episode);
        // No transcript saved

        const response = await SELF.fetch(
            `http://localhost/admin/episodes/${episode.id}/regenerate`,
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ templateId: "eli5" }),
            }
        );

        expect(response.status).toBe(400);
        const data = (await response.json()) as { error: string };
        expect(data.error).toContain("Transcript not found");
    });

    it("returns 400 for invalid template ID", async () => {
        const episode = createSampleEpisode();
        const transcript = createSampleTranscript({ episodeId: episode.id });
        await saveEpisode(env.TLDL_DATA, episode);
        await saveTranscript(env.TLDL_DATA, transcript);

        const response = await SELF.fetch(
            `http://localhost/admin/episodes/${episode.id}/regenerate`,
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ templateId: "invalid" }),
            }
        );

        expect(response.status).toBe(400);
        const data = (await response.json()) as { error: string };
        expect(data.error).toContain("Invalid template ID");
    });

    it("returns 400 when templateId is missing", async () => {
        const episode = createSampleEpisode();
        const transcript = createSampleTranscript({ episodeId: episode.id });
        await saveEpisode(env.TLDL_DATA, episode);
        await saveTranscript(env.TLDL_DATA, transcript);

        const response = await SELF.fetch(
            `http://localhost/admin/episodes/${episode.id}/regenerate`,
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({}),
            }
        );

        expect(response.status).toBe(400);
        const data = (await response.json()) as { error: string };
        expect(data.error).toContain("Missing templateId");
    });
});

// ============================================================================
// POST /admin/rebuild-index — Rebuild Episode Index
// ============================================================================

describe("POST /admin/rebuild-index", () => {
    beforeEach(async () => {
        await clearTestData();
    });

    it("rebuilds the episode index", async () => {
        // Create a couple of episodes
        await saveEpisode(env.TLDL_DATA, createSampleEpisode({ id: "ep1" }));
        await saveEpisode(env.TLDL_DATA, createSampleEpisode({ id: "ep2" }));

        const response = await SELF.fetch(
            "http://localhost/admin/rebuild-index",
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
            }
        );

        expect(response.status).toBe(200);
        const data = (await response.json()) as {
            success: boolean;
            episodeCount: number;
        };

        expect(data.success).toBe(true);
        expect(data.episodeCount).toBe(2);
    });

    it("returns 0 count when no episodes exist", async () => {
        const response = await SELF.fetch(
            "http://localhost/admin/rebuild-index",
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
            }
        );

        expect(response.status).toBe(200);
        const data = (await response.json()) as {
            success: boolean;
            episodeCount: number;
        };

        expect(data.success).toBe(true);
        expect(data.episodeCount).toBe(0);
    });
});

// ============================================================================
// GET /admin/podcasts — Podcast Monitoring Page
// ============================================================================

describe("GET /admin/podcasts", () => {
    it("renders the podcast monitoring page", async () => {
        const response = await SELF.fetch("http://localhost/admin/podcasts");
        expect(response.status).toBe(200);
        const html = await response.text();
        expect(html).toContain("Monitor Podcasts");
        expect(html).toContain("Add Podcast");
        expect(html).toContain("Settings");
    });
});

// ============================================================================
// DELETE /admin/jobs/:id — Delete Job
// ============================================================================

describe("DELETE /admin/jobs/:id", () => {
    beforeEach(async () => {
        await clearTestData();
    });

    it("deletes a job", async () => {
        const job = createSampleJob();
        await createJob(env.TLDL_DATA, job);

        const response = await SELF.fetch(
            `http://localhost/admin/jobs/${job.id}`,
            { method: "DELETE" }
        );

        expect(response.status).toBe(200);
        const data = (await response.json()) as { success: boolean; message: string };
        expect(data.success).toBe(true);

        // Verify job is gone from KV
        const deleted = await getJob(env.TLDL_DATA, job.id);
        expect(deleted).toBeNull();
    });

    it("succeeds even when job does not exist", async () => {
        // DELETE is idempotent — should not error
        const response = await SELF.fetch(
            "http://localhost/admin/jobs/non-existent",
            { method: "DELETE" }
        );

        expect(response.status).toBe(200);
        const data = (await response.json()) as { success: boolean };
        expect(data.success).toBe(true);
    });
});

// ============================================================================
// Activity Log
// ============================================================================

describe("Activity Log", () => {
    beforeEach(async () => {
        await clearTestData();
        // Also clear activity log
        await env.TLDL_DATA.delete("activity:log");
    });

    it("appends and retrieves activity events", async () => {
        await appendActivityEvent(env.TLDL_DATA, {
            type: "episode_completed",
            timestamp: "2025-01-01T10:00:00Z",
            title: "Test Podcast: Episode 1",
            episodeId: "ep1",
        });

        await appendActivityEvent(env.TLDL_DATA, {
            type: "monitor_check",
            timestamp: "2025-01-01T11:00:00Z",
            title: "Monitoring check: 5 podcasts, 1 new episode",
        });

        const log = await getActivityLog(env.TLDL_DATA);
        expect(log).toHaveLength(2);
        // Newest first
        expect(log[0].type).toBe("monitor_check");
        expect(log[1].type).toBe("episode_completed");
    });

    it("respects limit parameter", async () => {
        for (let i = 0; i < 5; i++) {
            await appendActivityEvent(env.TLDL_DATA, {
                type: "episode_completed",
                timestamp: new Date(Date.now() + i * 1000).toISOString(),
                title: `Episode ${i}`,
            });
        }

        const limited = await getActivityLog(env.TLDL_DATA, 3);
        expect(limited).toHaveLength(3);
    });

    it("caps at 50 entries", async () => {
        for (let i = 0; i < 55; i++) {
            await appendActivityEvent(env.TLDL_DATA, {
                type: "episode_completed",
                timestamp: new Date(Date.now() + i * 1000).toISOString(),
                title: `Episode ${i}`,
            });
        }

        const log = await getActivityLog(env.TLDL_DATA);
        expect(log).toHaveLength(50);
        // Most recent should be Episode 54
        expect(log[0].title).toBe("Episode 54");
    });

    it("returns empty array when no log exists", async () => {
        const log = await getActivityLog(env.TLDL_DATA);
        expect(log).toHaveLength(0);
    });

    it("handles corrupted log data gracefully", async () => {
        await env.TLDL_DATA.put("activity:log", "not valid json");
        const log = await getActivityLog(env.TLDL_DATA);
        expect(log).toHaveLength(0);
    });

    it("activity shows on admin dashboard", async () => {
        await appendActivityEvent(env.TLDL_DATA, {
            type: "episode_completed",
            timestamp: new Date().toISOString(),
            title: "Test Podcast: Great Episode",
            episodeId: "ep1",
        });

        const response = await SELF.fetch("http://localhost/admin");
        expect(response.status).toBe(200);
        const html = await response.text();
        expect(html).toContain("Recent Activity");
        expect(html).toContain("Test Podcast: Great Episode");
    });
});

// ============================================================================
// Dashboard Stats
// ============================================================================

describe("Dashboard Stats", () => {
    beforeEach(async () => {
        await clearTestData();
    });

    it("shows episode and podcast counts", async () => {
        await saveEpisode(env.TLDL_DATA, createSampleEpisode({ id: "ep1", podcastName: "Podcast A" }));
        await saveEpisode(env.TLDL_DATA, createSampleEpisode({ id: "ep2", podcastName: "Podcast B" }));

        const response = await SELF.fetch("http://localhost/admin");
        const html = await response.text();

        // Stats should show counts
        expect(html).toContain("Episodes");
        expect(html).toContain("Podcasts");
    });
});

// ============================================================================
// Removed routes return 404
// ============================================================================

describe("Removed public routes", () => {
    it("GET /submit returns 404", async () => {
        const response = await SELF.fetch("http://localhost/submit");
        expect(response.status).toBe(404);
    });

    it("POST /submit returns 404", async () => {
        const response = await SELF.fetch("http://localhost/submit", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ appleUrl: "https://podcasts.apple.com/us/podcast/test/id123?i=456" }),
        });
        expect(response.status).toBe(404);
    });

    it("GET /waitlist returns 404", async () => {
        const response = await SELF.fetch("http://localhost/waitlist");
        expect(response.status).toBe(404);
    });

    it("GET /job/:id returns 404", async () => {
        const response = await SELF.fetch("http://localhost/job/some-job-id");
        expect(response.status).toBe(404);
    });

    it("GET /profile returns 404", async () => {
        const response = await SELF.fetch("http://localhost/profile");
        expect(response.status).toBe(404);
    });

    it("DELETE /api/job/:id returns 404", async () => {
        const response = await SELF.fetch("http://localhost/api/job/some-job-id", {
            method: "DELETE",
        });
        expect(response.status).toBe(404);
    });
});
