import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import {
    KV_KEYS,
    TTL,
    createJob,
    getJob,
    updateJobStatus,
    saveEpisode,
    getEpisode,
    deleteEpisode,
    listEpisodes,
    saveTranscript,
    getTranscript,
    saveSummary,
    getSummary,
    listSummariesForEpisode,
    rebuildEpisodeIndex,
} from "../src/lib/kv";
import type { Job, Episode, Transcript, Summary } from "../src/types";

// Helper to create a sample job
function createSampleJob(overrides: Partial<Job> = {}): Job {
    return {
        id: "job-123",
        episodeId: "podcast_episode",
        appleUrl: "https://podcasts.apple.com/us/podcast/test/id123?i=456",
        status: "queued",
        templateId: "key-takeaways",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        ...overrides,
    };
}

// Helper to create a sample episode
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

// Helper to create a sample transcript
function createSampleTranscript(
    overrides: Partial<Transcript> = {}
): Transcript {
    return {
        episodeId: "123_456",
        text: "This is a sample transcript text.",
        source: "rss",
        createdAt: new Date().toISOString(),
        ...overrides,
    };
}

// Helper to create a sample summary
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

describe("KV Key Generation", () => {
    it("generates correct job key", () => {
        expect(KV_KEYS.job("abc-123")).toBe("job:abc-123");
    });

    it("generates correct episode key", () => {
        expect(KV_KEYS.episode("123_456")).toBe("episode:123_456");
    });

    it("generates correct transcript key", () => {
        expect(KV_KEYS.transcript("123_456")).toBe("transcript:123_456");
    });

    it("generates correct summary key", () => {
        expect(KV_KEYS.summary("123_456", "key-takeaways")).toBe(
            "summary:123_456:key-takeaways"
        );
    });
});

describe("TTL Constants", () => {
    it("sets job TTL to 7 days", () => {
        expect(TTL.JOB).toBe(7 * 24 * 60 * 60);
    });

    it("sets content TTL to 365 days", () => {
        expect(TTL.CONTENT).toBe(365 * 24 * 60 * 60);
    });
});

describe("Job Operations", () => {
    beforeEach(async () => {
        // Clear any existing test data
        const keys = await env.TLDL_DATA.list({ prefix: "job:" });
        await Promise.all(keys.keys.map((k) => env.TLDL_DATA.delete(k.name)));
    });

    it("creates and retrieves a job", async () => {
        const job = createSampleJob();
        await createJob(env.TLDL_DATA, job);

        const retrieved = await getJob(env.TLDL_DATA, job.id);
        expect(retrieved).not.toBeNull();
        expect(retrieved?.id).toBe(job.id);
        expect(retrieved?.status).toBe("queued");
        expect(retrieved?.episodeId).toBe(job.episodeId);
    });

    it("returns null for non-existent job", async () => {
        const retrieved = await getJob(env.TLDL_DATA, "non-existent-id");
        expect(retrieved).toBeNull();
    });

    it("updates job status", async () => {
        const job = createSampleJob();
        await createJob(env.TLDL_DATA, job);

        await updateJobStatus(env.TLDL_DATA, job.id, "transcribing");

        const retrieved = await getJob(env.TLDL_DATA, job.id);
        expect(retrieved?.status).toBe("transcribing");
        expect(new Date(retrieved!.updatedAt).getTime()).toBeGreaterThan(
            new Date(job.updatedAt).getTime() - 1000
        );
    });

    it("updates job status with error message", async () => {
        const job = createSampleJob();
        await createJob(env.TLDL_DATA, job);

        await updateJobStatus(
            env.TLDL_DATA,
            job.id,
            "failed",
            "Audio file not accessible"
        );

        const retrieved = await getJob(env.TLDL_DATA, job.id);
        expect(retrieved?.status).toBe("failed");
        expect(retrieved?.error).toBe("Audio file not accessible");
    });

    it("throws error when updating non-existent job", async () => {
        await expect(
            updateJobStatus(env.TLDL_DATA, "non-existent", "completed")
        ).rejects.toThrow("Job not found: non-existent");
    });
});

describe("Episode Operations", () => {
    beforeEach(async () => {
        // Clear any existing test data including the episode index
        const episodeKeys = await env.TLDL_DATA.list({ prefix: "episode:" });
        const transcriptKeys = await env.TLDL_DATA.list({ prefix: "transcript:" });
        const summaryKeys = await env.TLDL_DATA.list({ prefix: "summary:" });
        await Promise.all([
            ...episodeKeys.keys.map((k) => env.TLDL_DATA.delete(k.name)),
            ...transcriptKeys.keys.map((k) => env.TLDL_DATA.delete(k.name)),
            ...summaryKeys.keys.map((k) => env.TLDL_DATA.delete(k.name)),
            env.TLDL_DATA.delete(KV_KEYS.episodeIndex),
        ]);
    });

    it("saves and retrieves an episode", async () => {
        const episode = createSampleEpisode();
        await saveEpisode(env.TLDL_DATA, episode);

        const retrieved = await getEpisode(env.TLDL_DATA, episode.id);
        expect(retrieved).not.toBeNull();
        expect(retrieved?.id).toBe(episode.id);
        expect(retrieved?.podcastName).toBe("Test Podcast");
        expect(retrieved?.episodeTitle).toBe("Test Episode");
    });

    it("returns null for non-existent episode", async () => {
        const retrieved = await getEpisode(env.TLDL_DATA, "non-existent-id");
        expect(retrieved).toBeNull();
    });

    it("deletes an episode", async () => {
        const episode = createSampleEpisode();
        await saveEpisode(env.TLDL_DATA, episode);

        await deleteEpisode(env.TLDL_DATA, episode.id);

        const retrieved = await getEpisode(env.TLDL_DATA, episode.id);
        expect(retrieved).toBeNull();
    });

    it("deletes episode along with related data", async () => {
        const episode = createSampleEpisode({ id: "delete-test" });
        const transcript = createSampleTranscript({ episodeId: "delete-test" });
        const summary = createSampleSummary({
            episodeId: "delete-test",
            templateId: "key-takeaways",
        });

        await saveEpisode(env.TLDL_DATA, episode);
        await saveTranscript(env.TLDL_DATA, transcript);
        await saveSummary(env.TLDL_DATA, summary);

        // Verify all exist
        expect(await getEpisode(env.TLDL_DATA, "delete-test")).not.toBeNull();
        expect(await getTranscript(env.TLDL_DATA, "delete-test")).not.toBeNull();
        expect(
            await getSummary(env.TLDL_DATA, "delete-test", "key-takeaways")
        ).not.toBeNull();

        // Delete episode
        await deleteEpisode(env.TLDL_DATA, "delete-test");

        // Verify all are gone
        expect(await getEpisode(env.TLDL_DATA, "delete-test")).toBeNull();
        expect(await getTranscript(env.TLDL_DATA, "delete-test")).toBeNull();
        expect(
            await getSummary(env.TLDL_DATA, "delete-test", "key-takeaways")
        ).toBeNull();
    });

    it("lists episodes sorted by createdAt descending", async () => {
        const older = createSampleEpisode({
            id: "older-episode",
            createdAt: "2024-01-01T00:00:00Z",
        });
        const newer = createSampleEpisode({
            id: "newer-episode",
            createdAt: "2024-06-01T00:00:00Z",
        });
        const newest = createSampleEpisode({
            id: "newest-episode",
            createdAt: "2024-12-01T00:00:00Z",
        });

        // Save in random order
        await saveEpisode(env.TLDL_DATA, older);
        await saveEpisode(env.TLDL_DATA, newest);
        await saveEpisode(env.TLDL_DATA, newer);

        // Rebuild index from saved episodes (simulating what queue consumer does)
        await rebuildEpisodeIndex(env.TLDL_DATA);

        const result = await listEpisodes(env.TLDL_DATA);

        expect(result.episodes).toHaveLength(3);
        expect(result.episodes[0].id).toBe("newest-episode");
        expect(result.episodes[1].id).toBe("newer-episode");
        expect(result.episodes[2].id).toBe("older-episode");
    });

    it("returns empty array when no episodes exist", async () => {
        const result = await listEpisodes(env.TLDL_DATA);
        expect(result.episodes).toEqual([]);
    });
});

describe("Transcript Operations", () => {
    beforeEach(async () => {
        const keys = await env.TLDL_DATA.list({ prefix: "transcript:" });
        await Promise.all(keys.keys.map((k) => env.TLDL_DATA.delete(k.name)));
    });

    it("saves and retrieves a transcript", async () => {
        const transcript = createSampleTranscript();
        await saveTranscript(env.TLDL_DATA, transcript);

        const retrieved = await getTranscript(env.TLDL_DATA, transcript.episodeId);
        expect(retrieved).not.toBeNull();
        expect(retrieved?.text).toBe("This is a sample transcript text.");
        expect(retrieved?.source).toBe("rss");
    });

    it("returns null for non-existent transcript", async () => {
        const retrieved = await getTranscript(env.TLDL_DATA, "non-existent-id");
        expect(retrieved).toBeNull();
    });
});

describe("Summary Operations", () => {
    beforeEach(async () => {
        const keys = await env.TLDL_DATA.list({ prefix: "summary:" });
        await Promise.all(keys.keys.map((k) => env.TLDL_DATA.delete(k.name)));
    });

    it("saves and retrieves a summary", async () => {
        const summary = createSampleSummary();
        await saveSummary(env.TLDL_DATA, summary);

        const retrieved = await getSummary(
            env.TLDL_DATA,
            summary.episodeId,
            summary.templateId
        );
        expect(retrieved).not.toBeNull();
        expect(retrieved?.text).toBe("# Key Takeaways\n\nThis is a sample summary.");
        expect(retrieved?.model).toBe("gpt-5.2");
    });

    it("returns null for non-existent summary", async () => {
        const retrieved = await getSummary(
            env.TLDL_DATA,
            "non-existent",
            "key-takeaways"
        );
        expect(retrieved).toBeNull();
    });

    it("stores different templates for same episode separately", async () => {
        const keyTakeaways = createSampleSummary({
            templateId: "key-takeaways",
            text: "Key takeaways summary",
        });
        const eli5 = createSampleSummary({
            templateId: "eli5",
            text: "ELI5 summary",
        });

        await saveSummary(env.TLDL_DATA, keyTakeaways);
        await saveSummary(env.TLDL_DATA, eli5);

        const retrievedKey = await getSummary(
            env.TLDL_DATA,
            "123_456",
            "key-takeaways"
        );
        const retrievedEli5 = await getSummary(env.TLDL_DATA, "123_456", "eli5");

        expect(retrievedKey?.text).toBe("Key takeaways summary");
        expect(retrievedEli5?.text).toBe("ELI5 summary");
    });

    it("lists all summaries for an episode", async () => {
        const episode1 = "episode-with-summaries";
        const summaries = [
            createSampleSummary({
                episodeId: episode1,
                templateId: "key-takeaways",
                createdAt: "2024-01-01T00:00:00Z",
            }),
            createSampleSummary({
                episodeId: episode1,
                templateId: "eli5",
                createdAt: "2024-06-01T00:00:00Z",
            }),
            createSampleSummary({
                episodeId: episode1,
                templateId: "narrative-summary",
                createdAt: "2024-03-01T00:00:00Z",
            }),
        ];

        // Also save a summary for a different episode to ensure isolation
        const otherSummary = createSampleSummary({
            episodeId: "other-episode",
            templateId: "key-takeaways",
        });

        for (const summary of summaries) {
            await saveSummary(env.TLDL_DATA, summary);
        }
        await saveSummary(env.TLDL_DATA, otherSummary);

        const listed = await listSummariesForEpisode(env.TLDL_DATA, episode1);

        expect(listed).toHaveLength(3);
        // Should be sorted by createdAt descending
        expect(listed[0].templateId).toBe("eli5"); // newest
        expect(listed[1].templateId).toBe("narrative-summary");
        expect(listed[2].templateId).toBe("key-takeaways"); // oldest
    });

    it("returns empty array when no summaries exist for episode", async () => {
        const listed = await listSummariesForEpisode(
            env.TLDL_DATA,
            "no-summaries-here"
        );
        expect(listed).toEqual([]);
    });
});
