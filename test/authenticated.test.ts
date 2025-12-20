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
    listSummariesForEpisode,
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
    const prefixes = ["episode:", "transcript:", "summary:", "job:"];
    for (const prefix of prefixes) {
        const keys = await env.TLDL_DATA.list({ prefix });
        await Promise.all(keys.keys.map((k) => env.TLDL_DATA.delete(k.name)));
    }
}

// ============================================================================
// POST /submit Tests
// ============================================================================

describe("POST /submit", () => {
    beforeEach(async () => {
        await clearTestData();
    });

    it("creates job and returns job ID for valid URL", async () => {
        const response = await SELF.fetch("http://localhost/submit", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                appleUrl:
                    "https://podcasts.apple.com/us/podcast/test-podcast/id123?i=456",
                templateId: "key-takeaways",
            }),
        });

        expect(response.status).toBe(201);
        const data = (await response.json()) as {
            jobId: string;
            status: string;
            episodeId: string;
            cached: boolean;
        };

        expect(data.jobId).toBeDefined();
        expect(data.status).toBe("queued");
        expect(data.episodeId).toBe("123_456");
        expect(data.cached).toBe(false);

        // Verify job was created in KV
        const job = await getJob(env.TLDL_DATA, data.jobId);
        expect(job).not.toBeNull();
        expect(job!.status).toBe("queued");
    });

    it("returns cached result when episode+template already exists", async () => {
        // Pre-create episode and summary
        const episode = createSampleEpisode();
        const summary = createSampleSummary();
        await saveEpisode(env.TLDL_DATA, episode);
        await saveSummary(env.TLDL_DATA, summary);

        const response = await SELF.fetch("http://localhost/submit", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                appleUrl:
                    "https://podcasts.apple.com/us/podcast/test-podcast/id123?i=456",
                templateId: "key-takeaways",
            }),
        });

        expect(response.status).toBe(200);
        const data = (await response.json()) as {
            jobId: string;
            status: string;
            episodeId: string;
            cached: boolean;
        };

        expect(data.cached).toBe(true);
        expect(data.status).toBe("completed");
        expect(data.jobId).toBe("");
    });

    it("returns 400 for invalid URL", async () => {
        const response = await SELF.fetch("http://localhost/submit", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                appleUrl: "https://spotify.com/episode/123",
                templateId: "key-takeaways",
            }),
        });

        expect(response.status).toBe(400);
        const data = (await response.json()) as { error: string };
        expect(data.error).toContain("valid Apple Podcasts");
    });

    it("returns 400 for missing URL", async () => {
        const response = await SELF.fetch("http://localhost/submit", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                templateId: "key-takeaways",
            }),
        });

        expect(response.status).toBe(400);
        const data = (await response.json()) as { error: string };
        expect(data.error).toContain("Missing appleUrl");
    });

    it("returns 400 for invalid template ID", async () => {
        const response = await SELF.fetch("http://localhost/submit", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                appleUrl:
                    "https://podcasts.apple.com/us/podcast/test-podcast/id123?i=456",
                templateId: "invalid-template",
            }),
        });

        expect(response.status).toBe(400);
        const data = (await response.json()) as { error: string };
        expect(data.error).toContain("Invalid template ID");
    });

    it("uses default template when none specified", async () => {
        const response = await SELF.fetch("http://localhost/submit", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                appleUrl:
                    "https://podcasts.apple.com/us/podcast/test-podcast/id123?i=456",
            }),
        });

        expect(response.status).toBe(201);
        const data = (await response.json()) as { jobId: string };

        // Check job was created with default template
        const job = await getJob(env.TLDL_DATA, data.jobId);
        expect(job!.templateId).toBe("key-takeaways");
    });
});

// ============================================================================
// GET /job/:jobId Tests
// ============================================================================

describe("GET /job/:jobId", () => {
    beforeEach(async () => {
        await clearTestData();
    });

    it("returns job status for existing job", async () => {
        const job = createSampleJob();
        await createJob(env.TLDL_DATA, job);

        const response = await SELF.fetch(
            `http://localhost/job/${job.id}`
        );

        expect(response.status).toBe(200);
        const data = (await response.json()) as {
            id: string;
            status: string;
            episodeId: string;
            updatedAt: string;
        };

        expect(data.id).toBe(job.id);
        expect(data.status).toBe("queued");
        expect(data.episodeId).toBe(job.episodeId);
    });

    it("returns 404 for non-existent job", async () => {
        const response = await SELF.fetch(
            "http://localhost/job/non-existent-id"
        );

        expect(response.status).toBe(404);
        const data = (await response.json()) as { error: string };
        expect(data.error).toBe("Job not found");
    });

    it("includes error message for failed jobs", async () => {
        const job = createSampleJob({
            status: "failed",
            error: "Transcription failed",
        });
        await createJob(env.TLDL_DATA, job);

        const response = await SELF.fetch(
            `http://localhost/job/${job.id}`
        );

        expect(response.status).toBe(200);
        const data = (await response.json()) as {
            status: string;
            error?: string;
        };

        expect(data.status).toBe("failed");
        expect(data.error).toBe("Transcription failed");
    });

    it("includes estimated seconds when available", async () => {
        const job = createSampleJob({
            status: "transcribing",
            estimatedSeconds: 120,
        });
        await createJob(env.TLDL_DATA, job);

        const response = await SELF.fetch(
            `http://localhost/job/${job.id}`
        );

        expect(response.status).toBe(200);
        const data = (await response.json()) as { estimatedSeconds?: number };

        expect(data.estimatedSeconds).toBe(120);
    });
});

// ============================================================================
// POST /episode/:episodeId/regenerate Tests
// ============================================================================

describe("POST /episode/:episodeId/regenerate", () => {
    beforeEach(async () => {
        await clearTestData();
    });

    it("creates regeneration job for existing episode", async () => {
        const episode = createSampleEpisode();
        const transcript = createSampleTranscript({ episodeId: episode.id });
        await saveEpisode(env.TLDL_DATA, episode);
        await saveTranscript(env.TLDL_DATA, transcript);

        const response = await SELF.fetch(
            `http://localhost/episode/${episode.id}/regenerate`,
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
            `http://localhost/episode/${episode.id}/regenerate`,
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
            "http://localhost/episode/non-existent/regenerate",
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
        // Note: No transcript saved

        const response = await SELF.fetch(
            `http://localhost/episode/${episode.id}/regenerate`,
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
            `http://localhost/episode/${episode.id}/regenerate`,
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
});

// ============================================================================
// DELETE /episode/:episodeId Tests
// ============================================================================

describe("DELETE /episode/:episodeId", () => {
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
            `http://localhost/episode/${episode.id}`,
            { method: "DELETE" }
        );

        expect(response.status).toBe(200);
        const data = (await response.json()) as { deleted: boolean };
        expect(data.deleted).toBe(true);

        // Verify everything is deleted
        const deletedEpisode = await getEpisode(env.TLDL_DATA, episode.id);
        const deletedTranscript = await getTranscript(
            env.TLDL_DATA,
            episode.id
        );
        const deletedSummaries = await listSummariesForEpisode(
            env.TLDL_DATA,
            episode.id
        );

        expect(deletedEpisode).toBeNull();
        expect(deletedTranscript).toBeNull();
        expect(deletedSummaries).toHaveLength(0);
    });

    it("returns 404 for non-existent episode", async () => {
        const response = await SELF.fetch(
            "http://localhost/episode/non-existent",
            { method: "DELETE" }
        );

        expect(response.status).toBe(404);
        const data = (await response.json()) as { error: string };
        expect(data.error).toBe("Episode not found");
    });
});

// ============================================================================
// POST /job/:jobId/retry Tests
// ============================================================================

describe("POST /job/:jobId/retry", () => {
    beforeEach(async () => {
        await clearTestData();
    });

    it("resets failed job to queued status", async () => {
        const job = createSampleJob({
            status: "failed",
            error: "Previous error",
        });
        await createJob(env.TLDL_DATA, job);

        const response = await SELF.fetch(
            `http://localhost/job/${job.id}/retry`,
            { method: "POST" }
        );

        expect(response.status).toBe(200);
        const data = (await response.json()) as {
            jobId: string;
            status: string;
        };

        expect(data.jobId).toBe(job.id);
        expect(data.status).toBe("queued");

        // Verify job status was updated
        const updatedJob = await getJob(env.TLDL_DATA, job.id);
        expect(updatedJob!.status).toBe("queued");
    });

    it("returns 404 for non-existent job", async () => {
        const response = await SELF.fetch(
            "http://localhost/job/non-existent/retry",
            { method: "POST" }
        );

        expect(response.status).toBe(404);
    });

    it("returns 400 when job is not in failed status", async () => {
        const job = createSampleJob({ status: "transcribing" });
        await createJob(env.TLDL_DATA, job);

        const response = await SELF.fetch(
            `http://localhost/job/${job.id}/retry`,
            { method: "POST" }
        );

        expect(response.status).toBe(400);
        const data = (await response.json()) as { error: string };
        expect(data.error).toContain("Cannot retry job with status");
    });

    it("returns 400 when job is already completed", async () => {
        const job = createSampleJob({ status: "completed" });
        await createJob(env.TLDL_DATA, job);

        const response = await SELF.fetch(
            `http://localhost/job/${job.id}/retry`,
            { method: "POST" }
        );

        expect(response.status).toBe(400);
    });
});
