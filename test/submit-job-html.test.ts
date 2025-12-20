import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { SELF } from "cloudflare:test";
import {
    createJob,
    saveEpisode,
    saveSummary,
} from "../src/lib/kv";
import type { Episode, Summary, Job } from "../src/types";

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
// GET /submit Tests (HTML Form)
// ============================================================================

describe("GET /submit", () => {
    it("renders submit form page", async () => {
        const response = await SELF.fetch("http://localhost/submit");

        expect(response.status).toBe(200);
        expect(response.headers.get("content-type")).toContain("text/html");

        const html = await response.text();
        expect(html).toContain("Submit Episode");
        expect(html).toContain("Apple Podcasts Episode URL");
        expect(html).toContain("Summary Template");
        expect(html).toContain("key-takeaways");
        expect(html).toContain("narrative-summary");
        expect(html).toContain("eli5");
        expect(html).toContain("Generate Summary");
    });

    it("includes all three template options", async () => {
        const response = await SELF.fetch("http://localhost/submit");
        const html = await response.text();

        expect(html).toContain("Key Takeaways");
        expect(html).toContain("Narrative Summary");
        expect(html).toContain("ELI5");
    });
});

// ============================================================================
// POST /submit Tests (HTML Form Submission) - Validation Only
// Note: Tests that submit valid forms trigger queue processing which conflicts
// with test isolation. Those are tested in authenticated.test.ts via JSON API.
// ============================================================================

describe("POST /submit (HTML form) - Validation", () => {
    beforeEach(async () => {
        await clearTestData();
    });

    it("shows error for invalid URL", async () => {
        const formData = new FormData();
        formData.append("appleUrl", "https://spotify.com/episode/123");
        formData.append("templateId", "key-takeaways");

        const response = await SELF.fetch("http://localhost/submit", {
            method: "POST",
            body: formData,
        });

        expect(response.status).toBe(400);
        const html = await response.text();
        expect(html).toContain("valid Apple Podcasts episode URL");
    });

    it("shows error for empty URL", async () => {
        const formData = new FormData();
        formData.append("appleUrl", "");
        formData.append("templateId", "key-takeaways");

        const response = await SELF.fetch("http://localhost/submit", {
            method: "POST",
            body: formData,
        });

        expect(response.status).toBe(400);
        const html = await response.text();
        expect(html).toContain("Please enter a podcast episode URL");
    });

    it("redirects to episode page when already cached", async () => {
        // Pre-create episode and summary
        const episode = createSampleEpisode();
        const summary = createSampleSummary();
        await saveEpisode(env.TLDL_DATA, episode);
        await saveSummary(env.TLDL_DATA, summary);

        const formData = new FormData();
        formData.append("appleUrl", "https://podcasts.apple.com/us/podcast/test-podcast/id123?i=456");
        formData.append("templateId", "key-takeaways");

        const response = await SELF.fetch("http://localhost/submit", {
            method: "POST",
            body: formData,
            redirect: "manual",
        });

        expect(response.status).toBe(302);
        const location = response.headers.get("location");
        expect(location).toContain("/episode/");
        expect(location).toContain("template=key-takeaways");
    });
});

// ============================================================================
// GET /job/:jobId Tests (HTML Status Page)
// ============================================================================

describe("GET /job/:jobId (HTML page)", () => {
    beforeEach(async () => {
        await clearTestData();
    });

    it("renders job status page for queued job", async () => {
        const job = createSampleJob({ status: "queued" });
        await createJob(env.TLDL_DATA, job);

        const response = await SELF.fetch(`http://localhost/job/${job.id}`);

        expect(response.status).toBe(200);
        expect(response.headers.get("content-type")).toContain("text/html");

        const html = await response.text();
        expect(html).toContain("Processing Episode");
        expect(html).toContain(job.id);
        expect(html).toContain("Queued");
    });

    it("shows progress stepper with current status", async () => {
        const job = createSampleJob({ status: "transcribing" });
        await createJob(env.TLDL_DATA, job);

        const response = await SELF.fetch(`http://localhost/job/${job.id}`);
        const html = await response.text();

        expect(html).toContain("Transcribing audio");
        expect(html).toContain("step-current");
    });

    it("includes auto-refresh meta tag for in-progress job", async () => {
        const job = createSampleJob({ status: "summarizing" });
        await createJob(env.TLDL_DATA, job);

        const response = await SELF.fetch(`http://localhost/job/${job.id}`);
        const html = await response.text();

        expect(html).toContain('http-equiv="refresh"');
        expect(html).toContain('content="5"');
    });

    it("redirects to episode page when job is completed", async () => {
        const job = createSampleJob({ status: "completed" });
        await createJob(env.TLDL_DATA, job);

        const response = await SELF.fetch(`http://localhost/job/${job.id}`, {
            redirect: "manual",
        });

        expect(response.status).toBe(302);
        const location = response.headers.get("location");
        expect(location).toContain(`/episode/${job.episodeId}`);
        expect(location).toContain(`template=${job.templateId}`);
    });

    it("shows error and retry button for failed job", async () => {
        const job = createSampleJob({
            status: "failed",
            error: "Audio file too large",
        });
        await createJob(env.TLDL_DATA, job);

        const response = await SELF.fetch(`http://localhost/job/${job.id}`);
        const html = await response.text();

        expect(html).toContain("Audio file too large");
        expect(html).toContain("Retry");
        expect(html).toContain(`/job/${job.id}/retry`);
        // Should NOT have auto-refresh for failed jobs
        expect(html).not.toContain('http-equiv="refresh"');
    });

    it("returns 404 for non-existent job", async () => {
        const response = await SELF.fetch("http://localhost/job/non-existent-id");

        expect(response.status).toBe(404);
        const html = await response.text();
        expect(html).toContain("Job Not Found");
    });

    it("shows progress percentage", async () => {
        const job = createSampleJob({ status: "transcribing" });
        await createJob(env.TLDL_DATA, job);

        const response = await SELF.fetch(`http://localhost/job/${job.id}`);
        const html = await response.text();

        expect(html).toContain("60%"); // transcribing is at 60%
        expect(html).toContain("complete");
    });
});

// ============================================================================
// Homepage Submit Button Tests
// ============================================================================

describe("Homepage submit button", () => {
    beforeEach(async () => {
        await clearTestData();
    });

    it("shows submit button in empty state", async () => {
        const response = await SELF.fetch("http://localhost/");
        const html = await response.text();

        expect(html).toContain('href="/submit"');
        expect(html).toContain("Submit Your First Episode");
    });

    it("shows submit button in header when episodes exist", async () => {
        const episode = createSampleEpisode();
        await saveEpisode(env.TLDL_DATA, episode);

        const response = await SELF.fetch("http://localhost/");
        const html = await response.text();

        expect(html).toContain('href="/submit"');
        expect(html).toContain("Submit Episode");
    });
});

// ============================================================================
// NOTE: Tests that trigger queue processing (POST /submit with valid URL,
// POST /job/:jobId/retry) are covered by the JSON API tests in 
// authenticated.test.ts. The queue processing causes storage isolation
// issues in vitest-pool-workers when testing the HTML form handlers.
// ============================================================================
