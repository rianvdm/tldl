/**
 * Consumer RSS-sourced branch tests
 *
 * Verifies that when a queue message has rssSourced: true and pre-fetched
 * metadata, the consumer skips the Podcast Index / iTunes getEpisodeMetadata
 * call and constructs metadata directly from the message fields.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { env } from "cloudflare:test";
import { saveMonitoredPodcast, createJob, getEpisode } from "../src/lib/kv";
import type { QueueMessage } from "../src/types";

// Module-level mocks must come before the import of queueConsumer
vi.mock("../src/services/apple-podcasts", () => ({
    getEpisodeMetadata: vi.fn(),
}));

// Real parsing/matching helpers; only the network calls are stubbed.
vi.mock("../src/services/rss", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../src/services/rss")>()),
    fetchTranscript: vi.fn(),
    fetchAndParseFeed: vi.fn(),
}));

vi.mock("../src/services/transcription", () => ({
    transcribeAudio: vi.fn(),
    getProviderConfig: vi.fn().mockReturnValue({
        baseUrl: "https://api.openai.com/v1/audio/transcriptions",
        model: "gpt-transcribe",
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
import * as rss from "../src/services/rss";
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
            model: "gpt-transcribe",
        });

        vi.mocked(summarization.generateSummary).mockResolvedValue({
            text: "summary",
            model: "gpt-5.6-terra",
        });

        vi.mocked(tagGen.generateEpisodeTags).mockResolvedValue({
            tags: ["ai"],
            model: "gpt-5.6-terra",
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

    describe("audio URLs stay out of logs (#48)", () => {
        const QUERY = "Expires=1789000000&Signature=s3cr3tSIG&Key-Pair-Id=K2ABC";
        const signed = (host: string, path = "/ep.mp3") => `https://${host}${path}?${QUERY}`;

        let output: () => string;
        let events: () => Record<string, unknown>[];
        beforeEach(() => {
            vi.mocked(transcription.transcribeAudio).mockResolvedValue({
                text: "transcript body here. ".repeat(20),
                source: "openai",
                model: "gpt-transcribe",
            });
            vi.mocked(summarization.generateSummary).mockResolvedValue({ text: "summary", model: "claude-opus-5-5" });
            vi.mocked(tagGen.generateEpisodeTags).mockResolvedValue({ tags: ["ai"], model: "gpt-5.6-luna" });
            const spies = (["log", "warn", "error", "info", "debug"] as const).map((level) =>
                vi.spyOn(console, level).mockImplementation(() => {}),
            );
            const lines = () => spies.flatMap((spy) => spy.mock.calls.flat().map(String));
            output = () => lines().join("\n");
            events = () =>
                lines().flatMap((line) => {
                    try {
                        return [JSON.parse(line) as Record<string, unknown>];
                    } catch {
                        return [];
                    }
                });
        });

        async function run(extra: Partial<QueueMessage>) {
            for (const prefix of ["episode:", "transcript:", "summary:"]) {
                const { keys } = await env.TLDL_DATA.list({ prefix });
                await Promise.all(keys.map((k) => env.TLDL_DATA.delete(k.name)));
            }
            await queueConsumer.queue(
                createMockBatch([
                    {
                        type: "process_episode",
                        jobId: "job-1",
                        episodeId: "1809663079_rss_deadbeef01",
                        templateId: "key-takeaways",
                        rssSourced: true,
                        audioUrl: signed("substackcdn.example.com", "/feed/podcast/123/ep.mp3"),
                        durationSeconds: 3000,
                        podcastTitle: "How I AI",
                        expectedTitle: "Test Episode",
                        expectedDate: "2026-04-13T11:00:00Z",
                        ...extra,
                    },
                ]),
                getTestEnv(),
            );
            const text = output();
            expect(text.length).toBeGreaterThan(0);
            expect(text).not.toContain("Signature=");
            expect(text).not.toContain("s3cr3tSIG");
            expect(text).not.toContain("Expires=");
        }

        it("the RSS enclosure logs as host and path, without its query", async () => {
            await run({});

            expect(events().find((e) => e.event === "consumer_rss_sourced_skip_pi")).toMatchObject({
                audioHost: "substackcdn.example.com",
                audioPath: "/feed/podcast/123/ep.mp3",
            });
        });

        it("a pre-resolved override logs hostnames only", async () => {
            await run({
                audioUrlOverride: signed("override.example.com"),
                preResolvedAudioUrl: signed("resolved.example.net"),
            });

            expect(events().find((e) => e.event === "using_preresolve_audio_url")).toMatchObject({
                resolvedHost: "resolved.example.net",
                originalHost: "override.example.com",
            });
        });

        it("an override logs its hostname only", async () => {
            await run({ audioUrlOverride: signed("override.example.com") });

            expect(events().find((e) => e.event === "using_audio_url_override")).toMatchObject({
                overrideHost: "override.example.com",
            });
        });
    });

    describe("outbound links on the saved episode", () => {
        const EPISODE_ID = "1809663079_rss_deadbeef01";

        beforeEach(async () => {
            // KV persists across tests in this file; a leftover episode would make
            // the consumer skip the save and turn these assertions into no-ops.
            for (const prefix of ["episode:", "transcript:", "summary:"]) {
                const { keys } = await env.TLDL_DATA.list({ prefix });
                await Promise.all(keys.map((k) => env.TLDL_DATA.delete(k.name)));
            }
            await env.TLDL_DATA.delete("episodes:index");

            vi.mocked(transcription.transcribeAudio).mockResolvedValue({
                text: "transcript body here. ".repeat(20),
                source: "openai",
                model: "gpt-transcribe",
            });
            vi.mocked(summarization.generateSummary).mockResolvedValue({ text: "summary", model: "claude-opus-5-5" });
            vi.mocked(tagGen.generateEpisodeTags).mockResolvedValue({ tags: ["ai"], model: "gpt-5.6-luna" });
        });

        function rssMessage(extra: Partial<QueueMessage> = {}): QueueMessage {
            return {
                type: "process_episode",
                jobId: "job-1",
                episodeId: EPISODE_ID,
                templateId: "key-takeaways",
                rssSourced: true,
                audioUrl: "https://example.com/audio.mp3",
                durationSeconds: 3000,
                podcastTitle: "How I AI",
                expectedTitle: "Test Episode",
                expectedDate: "2026-04-13T11:00:00Z",
                episodeGuid: "dd85426a-9b70-482f-94ed-d5afd61b7d56",
                ...extra,
            };
        }

        it("stores the GUID, episode page and feed website, with a show-level Apple URL", async () => {
            await queueConsumer.queue(createMockBatch([rssMessage({
                podcastWebsiteUrl: "https://www.lennysnewsletter.com/podcast",
                episodePageUrl: "https://www.lennysnewsletter.com/p/test-episode",
            })]), getTestEnv());

            const saved = await getEpisode(env.TLDL_DATA, EPISODE_ID);
            expect(saved?.episodeGuid).toBe("dd85426a-9b70-482f-94ed-d5afd61b7d56");
            expect(saved?.episodePageUrl).toBe("https://www.lennysnewsletter.com/p/test-episode");
            expect(saved?.podcastWebsiteUrl).toBe("https://www.lennysnewsletter.com/podcast");
            expect(saved?.appleUrl).toBe("https://podcasts.apple.com/us/podcast/id1809663079");
        });

        it("does not fall back to an Apple URL stored as the monitored podcast's website", async () => {
            await saveMonitoredPodcast(env.TLDL_DATA, {
                id: "1809663079",
                name: "How I AI",
                rssUrl: "https://anchor.fm/s/1035b1568/podcast/rss",
                templateId: "key-takeaways",
                addedAt: "2026-04-17T00:00:00Z",
                episodesProcessed: 0,
                status: "active",
                websiteUrl: "https://podcasts.apple.com/us/podcast/how-i-ai/id1809663079",
            });

            await queueConsumer.queue(createMockBatch([rssMessage()]), getTestEnv());

            const saved = await getEpisode(env.TLDL_DATA, EPISODE_ID);
            expect(saved).not.toBeNull();
            expect(saved?.podcastWebsiteUrl).toBeUndefined();
        });

        describe("Apple-submitted episodes (non-RSS path)", () => {
            const APPLE_URL = "https://podcasts.apple.com/us/podcast/how-i-ai/id1809663079?i=1000700000001";
            const FEED: rss.ParsedFeed = {
                title: "How I AI",
                link: "https://www.howiai.example/podcast",
                episodes: [{
                    guid: "feed-guid-1",
                    title: "Test Episode",
                    pubDate: "2026-04-13T11:00:00Z",
                    duration: 3000,
                    audioUrl: "https://example.com/audio.mp3?token=abc",
                    link: "https://www.howiai.example/p/test-episode",
                }],
            };

            function appleMessage(): QueueMessage {
                return { type: "process_episode", jobId: "job-1", episodeId: EPISODE_ID, templateId: "key-takeaways", appleUrl: APPLE_URL };
            }

            beforeEach(() => {
                vi.mocked(applePodcasts.getEpisodeMetadata).mockResolvedValue({
                    podcastName: "How I AI",
                    episodeTitle: "Test Episode",
                    episodeDuration: 3000,
                    episodeDate: "2026-04-13T11:00:00Z",
                    audioUrl: "https://example.com/audio.mp3",
                    feedUrl: "https://anchor.fm/s/1035b1568/podcast/rss",
                    podcastWebsiteUrl: "https://podcast-index-link.example",
                });
            });

            it("reads the episode page, GUID and website from the podcast's feed", async () => {
                vi.mocked(rss.fetchAndParseFeed).mockResolvedValue(FEED);

                await queueConsumer.queue(createMockBatch([appleMessage()]), getTestEnv());

                const saved = await getEpisode(env.TLDL_DATA, EPISODE_ID);
                expect(saved?.episodePageUrl).toBe("https://www.howiai.example/p/test-episode");
                expect(saved?.episodeGuid).toBe("feed-guid-1");
                expect(saved?.podcastWebsiteUrl).toBe("https://www.howiai.example/podcast");
                expect(saved?.appleUrl).toBe(APPLE_URL);
            });

            it("uses the monitored podcast's website when one is set", async () => {
                await saveMonitoredPodcast(env.TLDL_DATA, {
                    id: "1809663079", name: "How I AI", rssUrl: "https://anchor.fm/s/1035b1568/podcast/rss",
                    templateId: "key-takeaways", addedAt: "2026-04-17T00:00:00Z", episodesProcessed: 0,
                    status: "active", websiteUrl: "https://www.platformer.news",
                });
                vi.mocked(rss.fetchAndParseFeed).mockResolvedValue(FEED);

                await queueConsumer.queue(createMockBatch([appleMessage()]), getTestEnv());

                expect((await getEpisode(env.TLDL_DATA, EPISODE_ID))?.podcastWebsiteUrl).toBe("https://www.platformer.news");
            });

            it("still saves the episode when the feed can't be read", async () => {
                vi.mocked(rss.fetchAndParseFeed).mockRejectedValue(new Error("feed down"));

                const batch = createMockBatch([appleMessage()]);
                await queueConsumer.queue(batch, getTestEnv());

                expect(batch.messages[0].ack).toHaveBeenCalled();
                const saved = await getEpisode(env.TLDL_DATA, EPISODE_ID);
                expect(saved?.episodePageUrl).toBeUndefined();
                expect(saved?.podcastWebsiteUrl).toBe("https://podcast-index-link.example");
            });
        });

        it("stores a show-level Apple URL when the queued one was built from a Podcast Index ID", async () => {
            vi.mocked(applePodcasts.getEpisodeMetadata).mockResolvedValue({
                podcastName: "How I AI",
                episodeTitle: "Test Episode",
                episodeDuration: 3000,
                episodeDate: "2026-04-13T11:00:00Z",
                audioUrl: "https://example.com/audio.mp3",
                feedUrl: "https://anchor.fm/s/1035b1568/podcast/rss",
            });

            await queueConsumer.queue(createMockBatch([{
                type: "process_episode",
                jobId: "job-1",
                episodeId: EPISODE_ID,
                templateId: "key-takeaways",
                appleUrl: "https://podcasts.apple.com/us/podcast/podcast/id1809663079?i=62880121466",
                appleUrlIsSynthetic: true,
                episodeGuid: "dd85426a-9b70-482f-94ed-d5afd61b7d56",
            }]), getTestEnv());

            const saved = await getEpisode(env.TLDL_DATA, EPISODE_ID);
            expect(saved?.appleUrl).toBe("https://podcasts.apple.com/us/podcast/id1809663079");
            expect(saved?.episodeGuid).toBe("dd85426a-9b70-482f-94ed-d5afd61b7d56");
        });
    });
});
