/**
 * Queue Consumer Tests
 *
 * Tests the background job processing pipeline.
 * Uses mocked services to avoid external API calls.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { env } from "cloudflare:test";
import {
    createJob,
    getJob,
    saveEpisode,
    getEpisode,
    saveTranscript,
    getTranscript,
    getSummary,
} from "../src/lib/kv";
import type { Job, Episode, Transcript, QueueMessage, Env } from "../src/types";

// Mock the external services
vi.mock("../src/services/apple-podcasts", () => ({
    getEpisodeMetadata: vi.fn(),
}));

vi.mock("../src/services/rss", () => ({
    fetchTranscript: vi.fn(),
}));

vi.mock("../src/services/transcription", () => ({
    transcribeAudio: vi.fn(),
    getProviderConfig: vi.fn().mockReturnValue({
        baseUrl: "https://api.openai.com/v1/audio/transcriptions",
        model: "whisper-1",
        name: "openai",
    }),
}));

vi.mock("../src/services/summarization", () => ({
    generateSummary: vi.fn(),
}));

vi.mock("../src/services/tag-generation", () => ({
    generateEpisodeTags: vi.fn(),
}));

// Import after mocking
import { getEpisodeMetadata } from "../src/services/apple-podcasts";
import { fetchTranscript } from "../src/services/rss";
import { transcribeAudio } from "../src/services/transcription";
import { generateSummary } from "../src/services/summarization";
import { generateEpisodeTags } from "../src/services/tag-generation";
import queueConsumer from "../src/queue/consumer";

// ============================================================================
// Test Environment Setup
// ============================================================================

/**
 * Create a test env with mocked OPENAI_API_KEY
 */
function getTestEnv(): Env {
    return {
        ...env,
        OPENAI_API_KEY: "test-api-key",
        ANTHROPIC_API_KEY: "test-anthropic-key",
    } as Env;
}

// ============================================================================
// Test Helpers
// ============================================================================

function createSampleJob(overrides: Partial<Job> = {}): Job {
    const now = new Date().toISOString();
    return {
        id: "test-job-123",
        episodeId: "123_456",
        appleUrl: "https://podcasts.apple.com/us/podcast/test-podcast/id123?i=456",
        status: "queued",
        templateId: "key-takeaways",
        createdAt: now,
        updatedAt: now,
        ...overrides,
    };
}

function createSampleEpisode(overrides: Partial<Episode> = {}): Episode {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000);
    return {
        id: "123_456",
        appleUrl: "https://podcasts.apple.com/us/podcast/test-podcast/id123?i=456",
        podcastName: "Test Podcast",
        episodeTitle: "Test Episode",
        episodeDuration: 1800, // 30 minutes
        episodeDate: "2024-01-15",
        audioUrl: "https://example.com/audio.mp3",
        transcriptSource: "openai",
        createdAt: now.toISOString(),
        expiresAt: expiresAt.toISOString(),
        ...overrides,
    };
}

function createSampleTranscript(overrides: Partial<Transcript> = {}): Transcript {
    return {
        episodeId: "123_456",
        text: "This is a sample transcript of the podcast episode.",
        source: "rss",
        createdAt: new Date().toISOString(),
        ...overrides,
    };
}

function createQueueMessage(overrides: Partial<QueueMessage> = {}): QueueMessage {
    return {
        type: "process_episode",
        jobId: "test-job-123",
        episodeId: "123_456",
        appleUrl: "https://podcasts.apple.com/us/podcast/test-podcast/id123?i=456",
        templateId: "key-takeaways",
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

/**
 * Create a mock MessageBatch for testing
 */
function createMockBatch(messages: QueueMessage[]): MessageBatch<QueueMessage> {
    const mockMessages = messages.map((body) => ({
        body,
        id: crypto.randomUUID(),
        timestamp: new Date(),
        attempts: 1,
        ack: vi.fn(),
        retry: vi.fn(),
    }));

    return {
        messages: mockMessages,
        queue: "test-queue",
        ackAll: vi.fn(),
        retryAll: vi.fn(),
    };
}

// ============================================================================
// Process Episode Tests
// ============================================================================

describe("Queue Consumer - process_episode", () => {
    beforeEach(async () => {
        await clearTestData();
        vi.clearAllMocks();
    });

    it("processes new episode successfully with Whisper transcription", async () => {
        // Set up mocks
        vi.mocked(getEpisodeMetadata).mockResolvedValue({
            podcastName: "Test Podcast",
            episodeTitle: "Test Episode",
            episodeDuration: 1800,
            episodeDate: "2024-01-15T00:00:00.000Z",
            audioUrl: "https://example.com/audio.mp3",
            feedUrl: "https://example.com/feed.xml",
            // No transcript available in RSS
        });

        vi.mocked(transcribeAudio).mockResolvedValue({
            text: "This is the transcribed text from Whisper.",
            source: "openai",
            model: "gpt-4o-mini-transcribe",
        });

        vi.mocked(generateSummary).mockResolvedValue({
            text: "# Summary\n\nKey takeaways from the episode.",
            model: "claude-opus-4-7",
            usage: { inputTokens: 0, outputTokens: 0 },
        });

        // Create job in KV
        const job = createSampleJob();
        await createJob(env.TLDL_DATA, job);

        // Process message
        const message = createQueueMessage();
        const batch = createMockBatch([message]);

        await queueConsumer.queue(batch, getTestEnv());

        // Verify message was acknowledged
        expect(batch.messages[0].ack).toHaveBeenCalled();
        expect(batch.messages[0].retry).not.toHaveBeenCalled();

        // Verify job completed
        const updatedJob = await getJob(env.TLDL_DATA, job.id);
        expect(updatedJob?.status).toBe("completed");

        // Verify episode saved
        const episode = await getEpisode(env.TLDL_DATA, "123_456");
        expect(episode).not.toBeNull();
        expect(episode?.podcastName).toBe("Test Podcast");
        expect(episode?.transcriptSource).toBe("openai");

        // Verify transcript saved
        const transcript = await getTranscript(env.TLDL_DATA, "123_456");
        expect(transcript).not.toBeNull();
        expect(transcript?.text).toBe("This is the transcribed text from Whisper.");
        expect(transcript?.source).toBe("openai");

        // Verify summary saved
        const summary = await getSummary(env.TLDL_DATA, "123_456", "key-takeaways");
        expect(summary).not.toBeNull();
        expect(summary?.text).toContain("Summary");
    });

    it("uses RSS transcript when available (skips Whisper)", async () => {
        vi.mocked(getEpisodeMetadata).mockResolvedValue({
            podcastName: "Test Podcast",
            episodeTitle: "Test Episode",
            episodeDuration: 1800,
            episodeDate: "2024-01-15T00:00:00.000Z",
            audioUrl: "https://example.com/audio.mp3",
            feedUrl: "https://example.com/feed.xml",
            transcriptUrl: "https://example.com/transcript.srt",
            transcriptType: "srt",
        });

        // Mock must return text > 100 chars to be considered valid
        vi.mocked(fetchTranscript).mockResolvedValue(
            "This is the RSS transcript text from the podcast feed. It needs to be long enough to pass the minimum length check that ensures we have a valid transcript and not just some placeholder text or error message from the server."
        );

        vi.mocked(generateSummary).mockResolvedValue({
            text: "# Summary\n\nKey takeaways.",
            model: "claude-opus-4-7",
            usage: { inputTokens: 0, outputTokens: 0 },
        });

        const job = createSampleJob();
        await createJob(env.TLDL_DATA, job);

        const message = createQueueMessage();
        const batch = createMockBatch([message]);

        await queueConsumer.queue(batch, getTestEnv());

        // Verify message acknowledged
        expect(batch.messages[0].ack).toHaveBeenCalled();

        // Verify Whisper was NOT called
        expect(transcribeAudio).not.toHaveBeenCalled();

        // Verify RSS transcript was used
        const transcript = await getTranscript(env.TLDL_DATA, "123_456");
        expect(transcript?.source).toBe("rss");
        expect(transcript?.text).toContain("RSS transcript text from the podcast feed");
    });

    it("uses cached transcript (skips both RSS and Whisper)", async () => {
        // Pre-save transcript
        const existingTranscript = createSampleTranscript({
            source: "openai",
            text: "Previously transcribed text.",
        });
        await saveTranscript(env.TLDL_DATA, existingTranscript);

        vi.mocked(getEpisodeMetadata).mockResolvedValue({
            podcastName: "Test Podcast",
            episodeTitle: "Test Episode",
            episodeDuration: 1800,
            episodeDate: "2024-01-15T00:00:00.000Z",
            audioUrl: "https://example.com/audio.mp3",
            feedUrl: "https://example.com/feed.xml",
        });

        vi.mocked(generateSummary).mockResolvedValue({
            text: "# Summary\n\nKey takeaways.",
            model: "claude-opus-4-7",
            usage: { inputTokens: 0, outputTokens: 0 },
        });

        const job = createSampleJob();
        await createJob(env.TLDL_DATA, job);

        const message = createQueueMessage();
        const batch = createMockBatch([message]);

        await queueConsumer.queue(batch, getTestEnv());

        // Verify neither transcription service was called
        expect(transcribeAudio).not.toHaveBeenCalled();
        expect(fetchTranscript).not.toHaveBeenCalled();

        // Verify summary was still generated
        expect(generateSummary).toHaveBeenCalledWith(
            "Previously transcribed text.",
            "key-takeaways",
            expect.any(String)
        );
    });

    it("updates job status through each phase", async () => {
        const statusUpdates: string[] = [];

        vi.mocked(getEpisodeMetadata).mockImplementation(async () => {
            const job = await getJob(env.TLDL_DATA, "test-job-123");
            statusUpdates.push(job?.status || "unknown");
            return {
                podcastName: "Test Podcast",
                episodeTitle: "Test Episode",
                episodeDuration: 1800,
                episodeDate: "2024-01-15T00:00:00.000Z",
                audioUrl: "https://example.com/audio.mp3",
                feedUrl: "https://example.com/feed.xml",
            };
        });

        vi.mocked(transcribeAudio).mockImplementation(async () => {
            const job = await getJob(env.TLDL_DATA, "test-job-123");
            statusUpdates.push(job?.status || "unknown");
            return { text: "Transcript", source: "openai", model: "gpt-4o-mini-transcribe" };
        });

        vi.mocked(generateSummary).mockImplementation(async () => {
            const job = await getJob(env.TLDL_DATA, "test-job-123");
            statusUpdates.push(job?.status || "unknown");
            return { text: "Summary", model: "claude-opus-4-7", usage: { inputTokens: 0, outputTokens: 0 } };
        });

        const job = createSampleJob();
        await createJob(env.TLDL_DATA, job);

        const message = createQueueMessage();
        const batch = createMockBatch([message]);

        await queueConsumer.queue(batch, getTestEnv());

        // Verify status progression
        expect(statusUpdates).toContain("fetching_metadata");
        expect(statusUpdates).toContain("transcribing");
        expect(statusUpdates).toContain("summarizing");

        const finalJob = await getJob(env.TLDL_DATA, "test-job-123");
        expect(finalJob?.status).toBe("completed");
    });

    it("fails job on metadata fetch error", async () => {
        vi.mocked(getEpisodeMetadata).mockRejectedValue(
            new Error("Podcast not found")
        );

        const job = createSampleJob();
        await createJob(env.TLDL_DATA, job);

        const message = createQueueMessage();
        const batch = createMockBatch([message]);

        await queueConsumer.queue(batch, getTestEnv());

        // Verify message was retried
        expect(batch.messages[0].retry).toHaveBeenCalled();

        // Verify job marked as failed
        const updatedJob = await getJob(env.TLDL_DATA, job.id);
        expect(updatedJob?.status).toBe("failed");
        expect(updatedJob?.error).toBeDefined();
    });

    it("fails job on transcription error", async () => {
        vi.mocked(getEpisodeMetadata).mockResolvedValue({
            podcastName: "Test Podcast",
            episodeTitle: "Test Episode",
            episodeDuration: 1800,
            episodeDate: "2024-01-15T00:00:00.000Z",
            audioUrl: "https://example.com/audio.mp3",
            feedUrl: "https://example.com/feed.xml",
        });

        vi.mocked(transcribeAudio).mockRejectedValue(
            new Error("Audio unavailable")
        );

        const job = createSampleJob();
        await createJob(env.TLDL_DATA, job);

        const message = createQueueMessage();
        const batch = createMockBatch([message]);

        await queueConsumer.queue(batch, getTestEnv());

        expect(batch.messages[0].retry).toHaveBeenCalled();

        const updatedJob = await getJob(env.TLDL_DATA, job.id);
        expect(updatedJob?.status).toBe("failed");
    });

    it("fails job on summarization error", async () => {
        vi.mocked(getEpisodeMetadata).mockResolvedValue({
            podcastName: "Test Podcast",
            episodeTitle: "Test Episode",
            episodeDuration: 1800,
            episodeDate: "2024-01-15T00:00:00.000Z",
            audioUrl: "https://example.com/audio.mp3",
            feedUrl: "https://example.com/feed.xml",
        });

        vi.mocked(transcribeAudio).mockResolvedValue({
            text: "Transcript",
            source: "openai",
            model: "gpt-4o-mini-transcribe",
        });

        vi.mocked(generateSummary).mockRejectedValue(
            new Error("Rate limited")
        );

        const job = createSampleJob();
        await createJob(env.TLDL_DATA, job);

        const message = createQueueMessage();
        const batch = createMockBatch([message]);

        await queueConsumer.queue(batch, getTestEnv());

        expect(batch.messages[0].retry).toHaveBeenCalled();

        const updatedJob = await getJob(env.TLDL_DATA, job.id);
        expect(updatedJob?.status).toBe("failed");
    });
});

// ============================================================================
// Regenerate Summary Tests
// ============================================================================

describe("Queue Consumer - regenerate_summary", () => {
    beforeEach(async () => {
        await clearTestData();
        vi.clearAllMocks();
    });

    it("regenerates summary for existing episode", async () => {
        // Pre-save episode and transcript
        const episode = createSampleEpisode();
        const transcript = createSampleTranscript();
        await saveEpisode(env.TLDL_DATA, episode);
        await saveTranscript(env.TLDL_DATA, transcript);

        vi.mocked(generateSummary).mockResolvedValue({
            text: "# ELI5 Summary\n\nSimple explanation.",
            model: "claude-opus-4-7",
            usage: { inputTokens: 0, outputTokens: 0 },
        });

        const job = createSampleJob({
            templateId: "eli5",
        });
        await createJob(env.TLDL_DATA, job);

        const message = createQueueMessage({
            type: "regenerate_summary",
            templateId: "eli5",
        });
        const batch = createMockBatch([message]);

        await queueConsumer.queue(batch, getTestEnv());

        // Verify message acknowledged
        expect(batch.messages[0].ack).toHaveBeenCalled();

        // Verify no transcription happened
        expect(transcribeAudio).not.toHaveBeenCalled();
        expect(getEpisodeMetadata).not.toHaveBeenCalled();

        // Verify new summary saved with correct template
        const summary = await getSummary(env.TLDL_DATA, "123_456", "eli5");
        expect(summary).not.toBeNull();
        expect(summary?.templateId).toBe("eli5");
        expect(summary?.text).toContain("ELI5");
    });

    it("fails if episode does not exist", async () => {
        // No episode saved
        const job = createSampleJob();
        await createJob(env.TLDL_DATA, job);

        const message = createQueueMessage({
            type: "regenerate_summary",
        });
        const batch = createMockBatch([message]);

        await queueConsumer.queue(batch, getTestEnv());

        expect(batch.messages[0].retry).toHaveBeenCalled();

        const updatedJob = await getJob(env.TLDL_DATA, job.id);
        expect(updatedJob?.status).toBe("failed");
    });

    it("fails if transcript does not exist", async () => {
        // Save episode but no transcript
        const episode = createSampleEpisode();
        await saveEpisode(env.TLDL_DATA, episode);

        const job = createSampleJob();
        await createJob(env.TLDL_DATA, job);

        const message = createQueueMessage({
            type: "regenerate_summary",
        });
        const batch = createMockBatch([message]);

        await queueConsumer.queue(batch, getTestEnv());

        expect(batch.messages[0].retry).toHaveBeenCalled();

        const updatedJob = await getJob(env.TLDL_DATA, job.id);
        expect(updatedJob?.status).toBe("failed");
        expect(updatedJob?.error).toContain("Transcript not found");
    });
});

// ============================================================================
// Process Manual Job Tests
// ============================================================================

describe("Queue Consumer - process_manual", () => {
    beforeEach(async () => {
        await clearTestData();
        vi.clearAllMocks();
    });

    it("processes a manual transcript submission end-to-end", async () => {
        // Pre-seed transcript and partial episode (as the manual submit handler would)
        const episode = createSampleEpisode({
            transcriptSource: "manual",
            podcastName: "Manual Podcast",
            episodeTitle: "Manual Episode",
        });
        const transcript = createSampleTranscript({
            source: "manual",
            text: "This is a pre-seeded manual transcript.",
        });
        await saveEpisode(env.TLDL_DATA, episode);
        await saveTranscript(env.TLDL_DATA, transcript);

        vi.mocked(generateSummary).mockResolvedValue({
            text: "# Manual Summary\n\nKey takeaways from manual transcript.",
            model: "claude-opus-4-7",
            usage: { inputTokens: 0, outputTokens: 0 },
        });

        vi.mocked(generateEpisodeTags).mockResolvedValue({
            tags: ["business", "ai"],
            model: "claude-opus-4-7",
            usage: { inputTokens: 0, outputTokens: 0 },
        });

        const job = createSampleJob();
        await createJob(env.TLDL_DATA, job);

        const message = createQueueMessage({
            type: "process_manual",
            appleUrl: undefined,
        });
        const batch = createMockBatch([message]);

        await queueConsumer.queue(batch, getTestEnv());

        // Acknowledged, not retried
        expect(batch.messages[0].ack).toHaveBeenCalled();
        expect(batch.messages[0].retry).not.toHaveBeenCalled();

        // Transcription/metadata services should NOT be called for manual
        expect(transcribeAudio).not.toHaveBeenCalled();
        expect(getEpisodeMetadata).not.toHaveBeenCalled();
        expect(fetchTranscript).not.toHaveBeenCalled();

        // Summary saved
        const summary = await getSummary(env.TLDL_DATA, "123_456", "key-takeaways");
        expect(summary).not.toBeNull();
        expect(summary?.text).toContain("Manual Summary");

        // Episode index contains the episode
        const indexRaw = await env.TLDL_DATA.get("episodes:index");
        expect(indexRaw).not.toBeNull();
        const index = JSON.parse(indexRaw!);
        expect(index.some((e: { id: string }) => e.id === "123_456")).toBe(true);

        // Episode updated with tags
        const updatedEpisode = await getEpisode(env.TLDL_DATA, "123_456");
        expect(updatedEpisode?.tags).toEqual(["business", "ai"]);

        // Job completed
        const updatedJob = await getJob(env.TLDL_DATA, job.id);
        expect(updatedJob?.status).toBe("completed");
    });
});

// ============================================================================
// Error Message Mapping Tests
// ============================================================================

describe("Queue Consumer - Error Handling", () => {
    beforeEach(async () => {
        await clearTestData();
        vi.clearAllMocks();
    });

    it("maps rate limit errors to user-friendly message", async () => {
        vi.mocked(getEpisodeMetadata).mockRejectedValue(
            new Error("Rate limit: HTTP 429")
        );

        const job = createSampleJob();
        await createJob(env.TLDL_DATA, job);

        const message = createQueueMessage();
        const batch = createMockBatch([message]);

        await queueConsumer.queue(batch, getTestEnv());

        const updatedJob = await getJob(env.TLDL_DATA, job.id);
        expect(updatedJob?.error).toContain("busy");
    });

    it("maps timeout errors to user-friendly message", async () => {
        vi.mocked(getEpisodeMetadata).mockRejectedValue(
            new Error("Request timeout")
        );

        const job = createSampleJob();
        await createJob(env.TLDL_DATA, job);

        const message = createQueueMessage();
        const batch = createMockBatch([message]);

        await queueConsumer.queue(batch, getTestEnv());

        const updatedJob = await getJob(env.TLDL_DATA, job.id);
        expect(updatedJob?.error).toContain("timed out");
    });
});
