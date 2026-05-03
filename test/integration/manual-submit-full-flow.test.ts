/**
 * Integration test: Manual Transcript Submission — Full Flow
 *
 * Exercises POST /admin/submit-manual → enqueue → queue consumer → read-back.
 *
 * This test lives in its own file because invoking POST /admin/submit-manual
 * through SELF.fetch causes the admin handler to write to the JobStatus
 * Durable Object. vitest-pool-workers' isolated-storage teardown fails to
 * clean up DO state created this way (the same limitation documented in
 * full-flow.test.ts's header). The test itself runs to completion and all
 * assertions pass — only the per-file teardown hook errors. Isolating it
 * here keeps the failure contained to one file instead of spilling into the
 * broader integration suite.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { env, SELF } from "cloudflare:test";

// Mock the queue module so we can capture the enqueued process_manual
// message and dispatch it to the consumer ourselves.
vi.mock("../../src/lib/queue", async () => {
    const actual = await vi.importActual<typeof import("../../src/lib/queue")>(
        "../../src/lib/queue"
    );
    return {
        ...actual,
        enqueueJob: vi.fn(async () => {}),
    };
});

// Mock external services invoked by the process_manual consumer path.
vi.mock("../../src/services/summarization", () => ({
    generateSummary: vi.fn(),
}));

vi.mock("../../src/services/tag-generation", () => ({
    generateEpisodeTags: vi.fn(),
}));

import { enqueueJob } from "../../src/lib/queue";
import { generateSummary } from "../../src/services/summarization";
import { generateEpisodeTags } from "../../src/services/tag-generation";
import queueConsumer from "../../src/queue/consumer";
import { getSummary } from "../../src/lib/kv";
import type { QueueMessage, Env } from "../../src/types";

function getTestEnv(): Env {
    return {
        ...env,
        OPENAI_API_KEY: "test-api-key",
    } as unknown as Env;
}

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

async function clearTestData() {
    const prefixes = ["episode:", "episodes:", "transcript:", "summary:", "job:"];
    for (const prefix of prefixes) {
        const keys = await env.TLDL_DATA.list({ prefix });
        await Promise.all(keys.keys.map((k) => env.TLDL_DATA.delete(k.name)));
    }
}

describe("Integration: Manual transcript submission — full flow", () => {
    beforeEach(async () => {
        await clearTestData();
        vi.mocked(enqueueJob).mockClear();
        vi.mocked(generateSummary).mockReset();
        vi.mocked(generateEpisodeTags).mockReset();
    });

    it("POST /admin/submit-manual → consumer → summary + index + detail page", async () => {
        vi.mocked(generateSummary).mockResolvedValue({
            text: "# Key Takeaways\n\nEnd-to-end manual flow summary.",
            model: "gpt-5.2",
        });
        vi.mocked(generateEpisodeTags).mockResolvedValue({
            tags: ["business"],
            model: "gpt-5.4",
        });

        const transcriptText = "A".repeat(500) + " full end to end test body";

        const form = new FormData();
        form.append("title", "E2E Manual Episode");
        form.append("transcript", transcriptText);
        form.append("podcastName", "E2E Podcast");

        // Step 1: POST the manual form.
        const postResponse = await SELF.fetch(
            "http://localhost/admin/submit-manual",
            {
                method: "POST",
                body: form,
                redirect: "manual",
            }
        );
        expect(postResponse.status).toBe(303);
        expect(postResponse.headers.get("Location")).toBe("/admin");

        // Step 2: Capture the enqueued process_manual message.
        expect(vi.mocked(enqueueJob)).toHaveBeenCalledTimes(1);
        const enqueuedMessage = vi.mocked(enqueueJob).mock.calls[0][1] as QueueMessage;
        expect(enqueuedMessage.type).toBe("process_manual");
        const episodeId = enqueuedMessage.episodeId!;
        expect(episodeId).toBeTruthy();

        // Step 3: Dispatch the message to the queue consumer.
        const batch = createMockBatch([enqueuedMessage]);
        await queueConsumer.queue(batch, getTestEnv());

        // Step 4: Summary persisted in KV.
        const summary = await getSummary(env.TLDL_DATA, episodeId, "key-takeaways");
        expect(summary).not.toBeNull();
        expect(summary?.text).toContain("End-to-end manual flow summary");

        // Step 5: Episodes index contains the new episode.
        const indexRaw = await env.TLDL_DATA.get("episodes:index");
        expect(indexRaw).not.toBeNull();
        const index = JSON.parse(indexRaw!) as Array<{ id: string }>;
        expect(index.some((e) => e.id === episodeId)).toBe(true);

        // Step 6: Episode detail page renders successfully.
        const detailResponse = await SELF.fetch(
            `http://localhost/episode/${episodeId}`
        );
        expect(detailResponse.status).toBe(200);
        const detailHtml = await detailResponse.text();
        expect(detailHtml).toContain("E2E Manual Episode");
        expect(detailHtml).toContain("End-to-end manual flow summary");
    });
});
