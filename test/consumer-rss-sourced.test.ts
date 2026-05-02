/**
 * Consumer RSS-sourced branch tests
 *
 * Verifies that when a queue message has rssSourced: true and pre-fetched
 * metadata, the consumer skips the Podcast Index / iTunes getEpisodeMetadata
 * call and constructs metadata directly from the message fields.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { env } from "cloudflare:test";
import { saveMonitoredPodcast, createJob } from "../src/lib/kv";
import type { QueueMessage } from "../src/types";

// Module-level mocks must come before the import of queueConsumer
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
        model: "gpt-4o-mini-transcribe",
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
import * as applePodcasts from "../src/services/apple-podcasts";
import * as transcription from "../src/services/transcription";
import * as summarization from "../src/services/summarization";
import * as tagGen from "../src/services/tag-generation";
import queueConsumer from "../src/queue/consumer";

// ============================================================================
// Helpers
// ============================================================================

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
    } as unknown as MessageBatch<QueueMessage>;
}

function getTestEnv(): import("../src/types").Env {
    return {
        ...env,
        OPENAI_API_KEY: "test-api-key",
        ANTHROPIC_API_KEY: "test-anthropic-key",
        MAX_EPISODE_MINUTES: "121",
    } as unknown as import("../src/types").Env;
}

// ============================================================================
// Tests
// ============================================================================

describe("consumer: rssSourced branch", () => {
    beforeEach(async () => {
        // Seed monitored podcast
        await saveMonitoredPodcast(env.TLDL_DATA, {
            id: "1809663079",
            name: "How I AI",
            rssUrl: "https://anchor.fm/s/1035b1568/podcast/rss",
            templateId: "key-takeaways",
            addedAt: "2026-04-17T00:00:00Z",
            episodesProcessed: 0,
            status: "active",
        });

        // Seed job
        await createJob(env.TLDL_DATA, {
            id: "job-1",
            episodeId: "1809663079_rss_deadbeef01",
            appleUrl: "",
            status: "queued",
            templateId: "key-takeaways",
            createdAt: "2026-04-17T00:00:00Z",
            updatedAt: "2026-04-17T00:00:00Z",
        });
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("skips getEpisodeMetadata when rssSourced + prefetched fields present", async () => {
        const getMetaSpy = vi.spyOn(applePodcasts, "getEpisodeMetadata");

        vi.mocked(transcription.transcribeAudio).mockResolvedValue({
            text: "transcript body here. ".repeat(20),
            source: "openai",
            model: "gpt-4o-mini-transcribe",
        });

        vi.mocked(summarization.generateSummary).mockResolvedValue({
            text: "summary",
            model: "claude-opus-4-7",
            usage: { inputTokens: 0, outputTokens: 0 },
        });

        vi.mocked(tagGen.generateEpisodeTags).mockResolvedValue({
            tags: ["ai"],
            model: "claude-opus-4-7",
            usage: { inputTokens: 0, outputTokens: 0 },
        });

        const message: QueueMessage = {
            type: "process_episode",
            jobId: "job-1",
            episodeId: "1809663079_rss_deadbeef01",
            templateId: "key-takeaways",
            rssSourced: true,
            audioUrl: "https://example.com/audio.mp3",
            durationSeconds: 3000,
            podcastTitle: "How I AI",
            expectedTitle: "Test Episode",
            expectedDate: "2026-04-13T11:00:00Z",
            episodeGuid: "dd85426a-9b70-482f-94ed-d5afd61b7d56",
        };

        const batch = createMockBatch([message]);
        await queueConsumer.queue(batch, getTestEnv());

        // Message should have been acked (no error)
        expect(batch.messages[0].ack).toHaveBeenCalled();
        expect(batch.messages[0].retry).not.toHaveBeenCalled();

        // The critical assertion: PI/iTunes lookup was skipped
        expect(getMetaSpy).not.toHaveBeenCalled();
    });
});
