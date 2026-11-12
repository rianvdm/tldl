/**
 * Tests for Transcription Service (OpenAI gpt-transcribe)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
    transcribeAudio,
    validateAudioUrl,
    resolveAudioUrl,
    getProviderConfig,
    extensionFromMime,
    detectAudioFormat,
    prepareForUpload,
    chunkCacheKey,
} from "../src/services/transcription";
import { withRetry, isTransientError, isRateLimitError, isServerError } from "../src/lib/retry";
import { AppError } from "../src/lib/errors";
import { AUDIO_LIMITS, ERROR_CODES, TIMEOUTS } from "../src/lib/constants";
import {
    CHUNK_OVERLAP_SECONDS,
    CONTAINER_PROBE_BYTES,
    MAX_CHUNK_SECONDS,
    MAX_TOTAL_SIZE_BYTES,
    TARGET_CHUNK_SIZE_BYTES,
    id3Length,
} from "../src/lib/audio";
import { parseMp3FrameHeader, readVbrHeader } from "../src/lib/mp3";
import {
    box,
    fullBox,
    parseAudioTrack,
    planSampleChunks,
    u16,
    u32,
    type Mp4AudioTrack,
    type SampleChunk,
} from "../src/lib/mp4";
import { parseAdtsFrames, type AdtsFrame } from "../src/lib/adts";
import { locateMoov } from "../src/services/audio-containers";
import { CHUNK_PLAN_VERSION, detectContainer, planChunks } from "../src/services/chunk-planning";
import type { ChunkTranscriptCache } from "../src/types";
import {
    ADTS_AAC,
    ADTS_AAC_ID3,
    ALAC_M4A,
    CHAPTERS_M4A,
    FRAGMENTED_M4A,
    MOOV_FIRST_M4A,
    MOOV_LAST_M4A,
    MP3_CBR_INFO,
    fixtureBytes,
} from "./fixtures/audio";

describe("validateAudioUrl", () => {
    beforeEach(() => {
        vi.restoreAllMocks();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("should return content info for valid audio URL", async () => {
        vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
            new Response(null, {
                status: 200,
                headers: {
                    "content-length": "1048576",
                    "content-type": "audio/mpeg",
                },
            })
        );

        const result = await validateAudioUrl("https://example.com/audio.mp3");

        expect(result).toEqual({
            contentLength: 1048576,
            contentType: "audio/mpeg",
        });
    });

    it("should throw AUDIO_UNAVAILABLE on 403", async () => {
        vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
            new Response(null, { status: 403 })
        );

        try {
            await validateAudioUrl("https://example.com/audio.mp3");
            expect.fail("Expected error");
        } catch (error) {
            expect(error).toBeInstanceOf(AppError);
            expect((error as AppError).code).toBe(ERROR_CODES.AUDIO_UNAVAILABLE);
        }
    });

    it("should throw AUDIO_UNAVAILABLE on 404", async () => {
        vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
            new Response(null, { status: 404 })
        );

        try {
            await validateAudioUrl("https://example.com/audio.mp3");
            expect.fail("Expected error");
        } catch (error) {
            expect(error).toBeInstanceOf(AppError);
            expect((error as AppError).code).toBe(ERROR_CODES.AUDIO_UNAVAILABLE);
        }
    });

    it("should throw AUDIO_UNAVAILABLE for non-audio content type", async () => {
        vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
            new Response(null, {
                status: 200,
                headers: {
                    "content-length": "1000",
                    "content-type": "text/html",
                },
            })
        );

        try {
            await validateAudioUrl("https://example.com/audio.mp3");
            expect.fail("Expected error");
        } catch (error) {
            expect(error).toBeInstanceOf(AppError);
            expect((error as AppError).code).toBe(ERROR_CODES.AUDIO_UNAVAILABLE);
            expect((error as AppError).message).toContain("Invalid content type");
        }
    });

    it("should throw AUDIO_UNAVAILABLE on network error", async () => {
        vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(
            new Error("Network error")
        );

        try {
            await validateAudioUrl("https://example.com/audio.mp3");
            expect.fail("Expected error");
        } catch (error) {
            expect(error).toBeInstanceOf(AppError);
            expect((error as AppError).code).toBe(ERROR_CODES.AUDIO_UNAVAILABLE);
        }
    });
});

describe("resolveAudioUrl", () => {
    beforeEach(() => {
        vi.restoreAllMocks();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    /** Build a fetch mock that replays a redirect chain keyed by URL. */
    function mockChain(chain: Record<string, { status: number; location?: string }>) {
        return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
            const url = typeof input === "string" ? input : (input as Request).url;
            const hop = chain[url];
            if (!hop) return new Response(null, { status: 200 });
            return new Response(null, {
                status: hop.status,
                headers: hop.location ? { Location: hop.location } : {},
            });
        });
    }

    it("returns the original URL when there is no redirect", async () => {
        mockChain({ "https://example.com/audio.mp3": { status: 200 } });

        const result = await resolveAudioUrl("https://example.com/audio.mp3");

        expect(result).toBe("https://example.com/audio.mp3");
    });

    it("follows a single redirect hop", async () => {
        mockChain({
            "https://origin.example/a.mp3": { status: 302, location: "https://cdn.example/a.mp3" },
            "https://cdn.example/a.mp3": { status: 200 },
        });

        const result = await resolveAudioUrl("https://origin.example/a.mp3");

        expect(result).toBe("https://cdn.example/a.mp3");
    });

    // Regression: the real Substack/Podscribe chain is two hops. Stopping after
    // the first left us on api.substack.com — the host that rate-limits us —
    // which is what broke cron episodes on 2026-08-12 and 2026-08-16.
    it("follows a multi-hop chain to the final CDN", async () => {
        mockChain({
            "https://pscrb.fm/rss/p/api.substack.com/feed/podcast/1/a.mp3": {
                status: 302,
                location: "https://api.substack.com/feed/podcast/1/a.mp3",
            },
            "https://api.substack.com/feed/podcast/1/a.mp3": {
                status: 307,
                location: "https://substackcdn.com/video_upload/post/1/transcoded.mp3?Expires=1",
            },
            "https://substackcdn.com/video_upload/post/1/transcoded.mp3?Expires=1": { status: 200 },
        });

        const result = await resolveAudioUrl(
            "https://pscrb.fm/rss/p/api.substack.com/feed/podcast/1/a.mp3"
        );

        expect(result).toBe("https://substackcdn.com/video_upload/post/1/transcoded.mp3?Expires=1");
    });

    it("resolves a relative Location header against the current URL", async () => {
        mockChain({
            "https://cdn.example/dir/a.mp3": { status: 302, location: "/final/b.mp3" },
            "https://cdn.example/final/b.mp3": { status: 200 },
        });

        const result = await resolveAudioUrl("https://cdn.example/dir/a.mp3");

        expect(result).toBe("https://cdn.example/final/b.mp3");
    });

    it("stops after the hop limit instead of following forever", async () => {
        // Every URL redirects to a brand new one — an unbounded chain.
        const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
            const url = typeof input === "string" ? input : (input as Request).url;
            const n = Number(new URL(url).searchParams.get("n") ?? "0");
            return new Response(null, {
                status: 302,
                headers: { Location: `https://example.com/a.mp3?n=${n + 1}` },
            });
        });

        const result = await resolveAudioUrl("https://example.com/a.mp3?n=0");

        expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(5);
        expect(result).toContain("https://example.com/a.mp3?n=");
    });

    it("breaks out of a redirect loop", async () => {
        mockChain({
            "https://example.com/a.mp3": { status: 302, location: "https://example.com/b.mp3" },
            "https://example.com/b.mp3": { status: 302, location: "https://example.com/a.mp3" },
        });

        const result = await resolveAudioUrl("https://example.com/a.mp3");

        expect(["https://example.com/a.mp3", "https://example.com/b.mp3"]).toContain(result);
    });

    it("falls back to the furthest URL reached when a hop throws", async () => {
        vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
            const url = typeof input === "string" ? input : (input as Request).url;
            if (url === "https://origin.example/a.mp3") {
                return new Response(null, {
                    status: 302,
                    headers: { Location: "https://cdn.example/a.mp3" },
                });
            }
            throw new Error("network down");
        });

        const result = await resolveAudioUrl("https://origin.example/a.mp3");

        expect(result).toBe("https://cdn.example/a.mp3");
    });

    it("returns the original URL when the very first hop throws", async () => {
        vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network down"));

        const result = await resolveAudioUrl("https://origin.example/a.mp3");

        expect(result).toBe("https://origin.example/a.mp3");
    });

    it("ignores a redirect status with no Location header", async () => {
        mockChain({ "https://origin.example/a.mp3": { status: 302 } });

        const result = await resolveAudioUrl("https://origin.example/a.mp3");

        expect(result).toBe("https://origin.example/a.mp3");
    });

    // Regression for #52. api.substack.com throttles Cloudflare egress
    // probabilistically — measured 9 successes in 34 attempts on 2026-08-24,
    // with no method, user-agent or Range effect. A 429 is therefore not a
    // verdict on the URL, it's a coin flip, and the old code treated it as
    // "chain finished" and handed the throttled origin straight to validation.
    it("retries a rate-limited hop and follows the chain once it succeeds", async () => {
        let originCalls = 0;
        vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
            const url = typeof input === "string" ? input : (input as Request).url;
            if (url === "https://api.substack.com/a.mp3") {
                originCalls++;
                // Throttled twice, then lets us through.
                if (originCalls <= 2) return new Response(null, { status: 429 });
                return new Response(null, {
                    status: 307,
                    headers: { Location: "https://substackcdn.com/a.mp3?Expires=1" },
                });
            }
            return new Response(null, { status: 200 });
        });

        const result = await resolveAudioUrl("https://api.substack.com/a.mp3", {
            rateLimitRetries: 4,
            rateLimitBaseDelayMs: 1,
        });

        expect(result).toBe("https://substackcdn.com/a.mp3?Expires=1");
        expect(originCalls).toBe(3);
    });

    // The hop-zero case (Supra Insider, 2026-08-24): the feed enclosure IS the
    // throttled origin, so there is no earlier hop to fall back to.
    it("retries a rate-limited first hop", async () => {
        let calls = 0;
        vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
            calls++;
            if (calls === 1) return new Response(null, { status: 429 });
            return new Response(null, {
                status: 307,
                headers: { Location: "https://substackcdn.com/a.mp3" },
            });
        });

        const result = await resolveAudioUrl("https://api.substack.com/a.mp3", {
            rateLimitRetries: 4,
            rateLimitBaseDelayMs: 1,
        });

        expect(result).toBe("https://substackcdn.com/a.mp3");
    });

    // The never-throws contract has to survive the new retry path.
    it("returns the furthest URL reached when the retry budget is exhausted", async () => {
        vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 429 }));

        const result = await resolveAudioUrl("https://api.substack.com/a.mp3", {
            rateLimitRetries: 2,
            rateLimitBaseDelayMs: 1,
        });

        expect(result).toBe("https://api.substack.com/a.mp3");
    });

    it("does not burn retries on a genuine terminal status", async () => {
        const fetchMock = vi
            .spyOn(globalThis, "fetch")
            .mockResolvedValue(new Response(null, { status: 200 }));

        const result = await resolveAudioUrl("https://cdn.example/a.mp3", {
            rateLimitRetries: 4,
            rateLimitBaseDelayMs: 1,
        });

        expect(result).toBe("https://cdn.example/a.mp3");
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("does not retry a 404", async () => {
        const fetchMock = vi
            .spyOn(globalThis, "fetch")
            .mockResolvedValue(new Response(null, { status: 404 }));

        await resolveAudioUrl("https://cdn.example/missing.mp3", {
            rateLimitRetries: 4,
            rateLimitBaseDelayMs: 1,
        });

        expect(fetchMock).toHaveBeenCalledTimes(1);
    });
});

describe("transcribeAudio", () => {
    beforeEach(() => {
        vi.restoreAllMocks();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("should transcribe audio under 25MB successfully", async () => {
        const mockAudioBuffer = new ArrayBuffer(1024); // 1KB

        vi.spyOn(globalThis, "fetch")
            // Mock redirect resolution (no redirect)
            .mockResolvedValueOnce(new Response(null, { status: 200 }))
            // Mock HEAD request for validation
            .mockResolvedValueOnce(
                new Response(null, {
                    status: 200,
                    headers: {
                        "content-length": "1024",
                        "content-type": "audio/mpeg",
                    },
                })
            )
            // Mock audio fetch
            .mockResolvedValueOnce(
                new Response(mockAudioBuffer, { status: 200 })
            )
            // Mock transcription API (gpt-transcribe returns JSON)
            .mockResolvedValueOnce(
                new Response(JSON.stringify({ text: "This is the transcribed text.", languages: [{ code: "en" }] }), { status: 200 })
            );

        const result = await transcribeAudio(
            "https://example.com/audio.mp3",
            "test-api-key"
        );

        expect(result.text).toBe("This is the transcribed text.");
        expect(result.source).toBe("openai");
    });

    it("should use chunked transcription for files over 25MB", async () => {
        // 30MB with 15MB chunks (TARGET_CHUNK_SIZE_BYTES) produces 3 chunks:
        //   chunk 1: 0–15MB
        //   chunk 2: 15MB-32KB to 30MB-32KB
        //   chunk 3: small trailing chunk
        const largeSize = 30 * 1024 * 1024; // 30MB
        const mockChunkBuffer = new ArrayBuffer(15 * 1024 * 1024); // 15MB

        vi.spyOn(globalThis, "fetch")
            // Mock redirect resolution (no redirect)
            .mockResolvedValueOnce(new Response(null, { status: 200 }))
            // HEAD request for validation
            .mockResolvedValueOnce(
                new Response(null, {
                    status: 200,
                    headers: {
                        "content-length": String(largeSize),
                        "content-type": "audio/mpeg",
                    },
                })
            )
            // Header fetch (bytes 0-511) for prepending to non-first chunks
            .mockResolvedValueOnce(
                new Response(new ArrayBuffer(512), { status: 206 })
            )
            // Chunk 1 fetch
            .mockResolvedValueOnce(
                new Response(mockChunkBuffer, { status: 206 })
            )
            // Chunk 1 transcription
            .mockResolvedValueOnce(
                new Response(JSON.stringify({ text: "This is the first part of the transcript." }), { status: 200 })
            )
            // Chunk 2 fetch
            .mockResolvedValueOnce(
                new Response(mockChunkBuffer, { status: 206 })
            )
            // Chunk 2 transcription
            .mockResolvedValueOnce(
                new Response(JSON.stringify({ text: "And this is the second part." }), { status: 200 })
            )
            // Chunk 3 fetch
            .mockResolvedValueOnce(
                new Response(new ArrayBuffer(1024 * 1024), { status: 206 })
            )
            // Chunk 3 transcription
            .mockResolvedValueOnce(
                new Response(JSON.stringify({ text: "And the third part." }), { status: 200 })
            );

        const result = await transcribeAudio(
            "https://example.com/large.mp3",
            "test-api-key"
        );

        // Verify result is the stitched transcript
        expect(result.source).toBe("openai");
        expect(result.text).toContain("first part");
        expect(result.text).toContain("second part");
    });

    it("should return partial transcript when only the trailing chunk is rejected", async () => {
        // 30MB → 3 chunks. Chunks 1+2 succeed; gpt-transcribe rejects chunk 3 once, with no second model to try.
        // Expect: no throw, result.partial === true, result.text contains the first two chunks.
        const largeSize = 30 * 1024 * 1024;
        const mockChunkBuffer = new ArrayBuffer(15 * 1024 * 1024);
        const corruptedError = JSON.stringify({
            error: { message: "Audio file might be corrupted or unsupported", type: "invalid_request_error", param: "file", code: "invalid_value" },
        });

        const fetchSpy = vi.spyOn(globalThis, "fetch")
            // redirect resolution
            .mockResolvedValueOnce(new Response(null, { status: 200 }))
            // HEAD validation
            .mockResolvedValueOnce(new Response(null, { status: 200, headers: { "content-length": String(largeSize), "content-type": "audio/mpeg" } }))
            // header fetch (512B)
            .mockResolvedValueOnce(new Response(new ArrayBuffer(512), { status: 206 }))
            // chunk 1 fetch + transcribe (success)
            .mockResolvedValueOnce(new Response(mockChunkBuffer, { status: 206 }))
            .mockResolvedValueOnce(new Response(JSON.stringify({ text: "First chunk transcript." }), { status: 200 }))
            // chunk 2 fetch + transcribe (success)
            .mockResolvedValueOnce(new Response(mockChunkBuffer, { status: 206 }))
            .mockResolvedValueOnce(new Response(JSON.stringify({ text: "Second chunk transcript." }), { status: 200 }))
            // chunk 3 (tail) fetch — succeeds at the byte level
            .mockResolvedValueOnce(new Response(new ArrayBuffer(1024 * 1024), { status: 206 }))
            // chunk 3 → 400 corrupted, not retried
            .mockResolvedValueOnce(new Response(corruptedError, { status: 400 }));

        const result = await transcribeAudio(
            "https://example.com/large.mp3",
            "test-api-key"
        );

        expect(fetchSpy).toHaveBeenCalledTimes(9);
        expect(result.source).toBe("openai");
        expect(result.model).toBe("gpt-transcribe");
        expect(result.partial).toBe(true);
        expect(result.partialReason).toContain("Final chunk 3/3 was rejected by gpt-transcribe");
        expect(result.partialReason).not.toContain("whisper");
        // The 30MB tail chunk holds only 32KB of new audio past the overlap.
        expect(result.partialReason).toContain("missing the last 0.1% of the audio");
        expect(result.text).toContain("First chunk");
        expect(result.text).toContain("Second chunk");
    });

    // #54: the tail tolerance was meant for a few minutes of undecodable
    // trailer. A 28MB file splits into 15MB + ~13MB, so dropping chunk 2
    // would silently lose almost half the episode. That must fail the job.
    it("fails instead of returning a partial transcript when the failed tail is a large share of the file", async () => {
        const largeSize = 28 * 1024 * 1024; // → 2 chunks; chunk 2 holds ~46% of the audio
        const corruptedError = JSON.stringify({
            error: { message: "Audio file might be corrupted or unsupported", type: "invalid_request_error", param: "file", code: "invalid_value" },
        });

        vi.spyOn(globalThis, "fetch")
            .mockResolvedValueOnce(new Response(null, { status: 200 }))
            .mockResolvedValueOnce(new Response(null, { status: 200, headers: { "content-length": String(largeSize), "content-type": "audio/mpeg" } }))
            .mockResolvedValueOnce(new Response(new ArrayBuffer(512), { status: 206 }))
            // chunk 1 succeeds
            .mockResolvedValueOnce(new Response(new ArrayBuffer(15 * 1024 * 1024), { status: 206 }))
            .mockResolvedValueOnce(new Response(JSON.stringify({ text: "First half." }), { status: 200 }))
            // chunk 2 (the tail) is rejected
            .mockResolvedValueOnce(new Response(new ArrayBuffer(13 * 1024 * 1024), { status: 206 }))
            .mockResolvedValueOnce(new Response(corruptedError, { status: 400 }));

        try {
            await transcribeAudio("https://example.com/large.mp3", "test-api-key");
            expect.fail("Should have thrown");
        } catch (error) {
            expect(error).toBeInstanceOf(AppError);
            expect((error as AppError).code).toBe(ERROR_CODES.AUDIO_REJECTED);
            expect((error as AppError).message).toBe("gpt-transcribe rejected chunk 2/2 of the audio");
        }
    });

    it("reports gpt-transcribe as the model of a chunked transcript", async () => {
        const largeSize = 30 * 1024 * 1024;
        const mockChunkBuffer = new ArrayBuffer(15 * 1024 * 1024);

        vi.spyOn(globalThis, "fetch")
            .mockResolvedValueOnce(new Response(null, { status: 200 }))
            .mockResolvedValueOnce(new Response(null, { status: 200, headers: { "content-length": String(largeSize), "content-type": "audio/mpeg" } }))
            .mockResolvedValueOnce(new Response(new ArrayBuffer(512), { status: 206 }))
            .mockResolvedValueOnce(new Response(mockChunkBuffer, { status: 206 }))
            .mockResolvedValueOnce(new Response(JSON.stringify({ text: "One." }), { status: 200 }))
            .mockResolvedValueOnce(new Response(mockChunkBuffer, { status: 206 }))
            .mockResolvedValueOnce(new Response(JSON.stringify({ text: "Two." }), { status: 200 }))
            .mockResolvedValueOnce(new Response(new ArrayBuffer(1024 * 1024), { status: 206 }))
            .mockResolvedValueOnce(new Response(JSON.stringify({ text: "Three." }), { status: 200 }));

        const result = await transcribeAudio(
            "https://example.com/large.mp3",
            "test-api-key"
        );

        expect(result.model).toBe("gpt-transcribe");
    });

    it("should throw TRANSCRIPTION_FAILED on Whisper API error", async () => {
        const mockAudioBuffer = new ArrayBuffer(1024);

        vi.spyOn(globalThis, "fetch")
            // Mock redirect resolution (no redirect)
            .mockResolvedValueOnce(new Response(null, { status: 200 }))
            .mockResolvedValueOnce(
                new Response(null, {
                    status: 200,
                    headers: {
                        "content-length": "1024",
                        "content-type": "audio/mpeg",
                    },
                })
            )
            .mockResolvedValueOnce(
                new Response(mockAudioBuffer, { status: 200 })
            )
            .mockResolvedValueOnce(
                new Response("Invalid audio format", { status: 400 })
            );

        try {
            await transcribeAudio("https://example.com/audio.mp3", "test-api-key");
            expect.fail("Expected error");
        } catch (error) {
            expect(error).toBeInstanceOf(AppError);
            expect((error as AppError).code).toBe(ERROR_CODES.TRANSCRIPTION_FAILED);
        }
    });

    it("should retry on rate limit (429) and succeed", async () => {
        const mockAudioBuffer = new ArrayBuffer(1024);

        vi.spyOn(globalThis, "fetch")
            // Mock redirect resolution (no redirect)
            .mockResolvedValueOnce(new Response(null, { status: 200 }))
            .mockResolvedValueOnce(
                new Response(null, {
                    status: 200,
                    headers: {
                        "content-length": "1024",
                        "content-type": "audio/mpeg",
                    },
                })
            )
            .mockResolvedValueOnce(
                new Response(mockAudioBuffer, { status: 200 })
            )
            // First transcription call: rate limited
            .mockResolvedValueOnce(
                new Response("Rate limited", { status: 429 })
            )
            // Retry: success
            .mockResolvedValueOnce(
                new Response(JSON.stringify({ text: "Transcribed text after retry." }), { status: 200 })
            );

        const result = await transcribeAudio(
            "https://example.com/audio.mp3",
            "test-api-key"
        );

        expect(result.text).toBe("Transcribed text after retry.");
    });

    it("should retry on server error (500) and succeed", async () => {
        const mockAudioBuffer = new ArrayBuffer(1024);

        vi.spyOn(globalThis, "fetch")
            // Mock redirect resolution (no redirect)
            .mockResolvedValueOnce(new Response(null, { status: 200 }))
            .mockResolvedValueOnce(
                new Response(null, {
                    status: 200,
                    headers: {
                        "content-length": "1024",
                        "content-type": "audio/mpeg",
                    },
                })
            )
            .mockResolvedValueOnce(
                new Response(mockAudioBuffer, { status: 200 })
            )
            // First transcription call: server error
            .mockResolvedValueOnce(
                new Response("Server error", { status: 500 })
            )
            // Retry: success
            .mockResolvedValueOnce(
                new Response(JSON.stringify({ text: "Transcribed after server error." }), { status: 200 })
            );

        const result = await transcribeAudio(
            "https://example.com/audio.mp3",
            "test-api-key"
        );

        expect(result.text).toBe("Transcribed after server error.");
    });

    it("should throw TRANSCRIPTION_FAILED when a 200 response has no text field", async () => {
        const mockAudioBuffer = new ArrayBuffer(1024);

        vi.spyOn(globalThis, "fetch")
            // Mock redirect resolution (no redirect)
            .mockResolvedValueOnce(new Response(null, { status: 200 }))
            .mockResolvedValueOnce(
                new Response(null, {
                    status: 200,
                    headers: {
                        "content-length": "1024",
                        "content-type": "audio/mpeg",
                    },
                })
            )
            .mockResolvedValueOnce(
                new Response(mockAudioBuffer, { status: 200 })
            )
            // 200 OK but the JSON body has no "text" string
            .mockResolvedValueOnce(
                new Response(JSON.stringify({ languages: [{ code: "en" }] }), { status: 200 })
            );

        try {
            await transcribeAudio("https://example.com/audio.mp3", "test-api-key");
            expect.fail("Expected error");
        } catch (error) {
            expect(error).toBeInstanceOf(AppError);
            expect((error as AppError).code).toBe(ERROR_CODES.TRANSCRIPTION_FAILED);
            expect((error as AppError).message).toContain("response shape");
        }
    });

    it("should throw TRANSCRIPTION_FAILED when a 200 response body is not JSON", async () => {
        const mockAudioBuffer = new ArrayBuffer(1024);

        vi.spyOn(globalThis, "fetch")
            // Mock redirect resolution (no redirect)
            .mockResolvedValueOnce(new Response(null, { status: 200 }))
            .mockResolvedValueOnce(
                new Response(null, {
                    status: 200,
                    headers: {
                        "content-length": "1024",
                        "content-type": "audio/mpeg",
                    },
                })
            )
            .mockResolvedValueOnce(
                new Response(mockAudioBuffer, { status: 200 })
            )
            // 200 OK but a plain-text body (not the JSON the model contract promises)
            .mockResolvedValueOnce(
                new Response("This is not JSON.", { status: 200 })
            );

        try {
            await transcribeAudio("https://example.com/audio.mp3", "test-api-key");
            expect.fail("Expected error");
        } catch (error) {
            expect(error).toBeInstanceOf(AppError);
            expect((error as AppError).code).toBe(ERROR_CODES.TRANSCRIPTION_FAILED);
        }
    });
});

describe("withRetry", () => {
    it("should return result on first success", async () => {
        const fn = vi.fn().mockResolvedValue("success");

        const result = await withRetry(fn, { maxRetries: 3, baseDelayMs: 10 });

        expect(result).toBe("success");
        expect(fn).toHaveBeenCalledTimes(1);
    });

    it("should retry on failure and succeed", async () => {
        const fn = vi
            .fn()
            .mockRejectedValueOnce(new Error("fail 1"))
            .mockRejectedValueOnce(new Error("fail 2"))
            .mockResolvedValue("success");

        const result = await withRetry(fn, { maxRetries: 3, baseDelayMs: 10 });

        expect(result).toBe("success");
        expect(fn).toHaveBeenCalledTimes(3);
    });

    it("should throw after max retries exhausted", async () => {
        const fn = vi.fn().mockRejectedValue(new Error("always fails"));

        try {
            await withRetry(fn, { maxRetries: 2, baseDelayMs: 10 });
            expect.fail("Expected error");
        } catch (error) {
            expect((error as Error).message).toBe("always fails");
        }

        expect(fn).toHaveBeenCalledTimes(3); // initial + 2 retries
    });

    it("should not retry when shouldRetry returns false", async () => {
        const fn = vi.fn().mockRejectedValue(new Error("non-retryable"));

        try {
            await withRetry(fn, {
                maxRetries: 3,
                baseDelayMs: 10,
                shouldRetry: () => false,
            });
            expect.fail("Expected error");
        } catch (error) {
            expect((error as Error).message).toBe("non-retryable");
        }

        expect(fn).toHaveBeenCalledTimes(1); // No retries
    });
});

describe("getProviderConfig", () => {
    it("should return OpenAI config by default", () => {
        const config = getProviderConfig();
        expect(config.name).toBe("openai");
        expect(config.baseUrl).toBe("https://api.openai.com/v1/audio/transcriptions");
        expect(config.model).toBe("gpt-transcribe");
    });

    it("should return OpenAI config for undefined provider", () => {
        const config = getProviderConfig(undefined);
        expect(config.name).toBe("openai");
    });

    it("should return OpenAI config for 'openai' provider", () => {
        const config = getProviderConfig("openai");
        expect(config.name).toBe("openai");
        expect(config.model).toBe("gpt-transcribe");
    });

    it("should return OpenAI config for any string (Groq removed)", () => {
        const config = getProviderConfig("unknown");
        expect(config.name).toBe("openai");
    });
});

describe("transcribeAudio with options object", () => {
    beforeEach(() => {
        vi.restoreAllMocks();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("should use OpenAI when provider is 'openai'", async () => {
        const mockAudioBuffer = new ArrayBuffer(1024);

        const fetchSpy = vi.spyOn(globalThis, "fetch")
            // Mock redirect resolution (no redirect)
            .mockResolvedValueOnce(new Response(null, { status: 200 }))
            .mockResolvedValueOnce(
                new Response(null, {
                    status: 200,
                    headers: {
                        "content-length": "1024",
                        "content-type": "audio/mpeg",
                    },
                })
            )
            .mockResolvedValueOnce(
                new Response(mockAudioBuffer, { status: 200 })
            )
            .mockResolvedValueOnce(
                new Response(JSON.stringify({ text: "OpenAI transcription." }), { status: 200 })
            );

        const result = await transcribeAudio(
            "https://example.com/audio.mp3",
            { apiKey: "openai-key", provider: "openai" }
        );

        expect(result.text).toBe("OpenAI transcription.");
        expect(result.source).toBe("openai");

        // Verify the transcription API was called with OpenAI URL, the new model, and JSON response format
        const whisperCall = fetchSpy.mock.calls[3];
        expect(whisperCall[0]).toBe("https://api.openai.com/v1/audio/transcriptions");
        const requestBody = (whisperCall[1] as RequestInit).body as FormData;
        expect(requestBody.get("model")).toBe("gpt-transcribe");
        expect(requestBody.get("response_format")).toBe("json");
    });

    it("should default to OpenAI when provider is not specified in options", async () => {
        const mockAudioBuffer = new ArrayBuffer(1024);

        const fetchSpy = vi.spyOn(globalThis, "fetch")
            // Mock redirect resolution (no redirect)
            .mockResolvedValueOnce(new Response(null, { status: 200 }))
            .mockResolvedValueOnce(
                new Response(null, {
                    status: 200,
                    headers: {
                        "content-length": "1024",
                        "content-type": "audio/mpeg",
                    },
                })
            )
            .mockResolvedValueOnce(
                new Response(mockAudioBuffer, { status: 200 })
            )
            .mockResolvedValueOnce(
                new Response(JSON.stringify({ text: "Default provider transcription." }), { status: 200 })
            );

        const result = await transcribeAudio(
            "https://example.com/audio.mp3",
            { apiKey: "some-key" }
        );

        expect(result.text).toBe("Default provider transcription.");
        expect(result.source).toBe("openai");

        // Verify it used OpenAI URL
        const whisperCall = fetchSpy.mock.calls[3];
        expect(whisperCall[0]).toBe("https://api.openai.com/v1/audio/transcriptions");
    });

    it("should support legacy string API key argument", async () => {
        const mockAudioBuffer = new ArrayBuffer(1024);

        vi.spyOn(globalThis, "fetch")
            // Mock redirect resolution (no redirect)
            .mockResolvedValueOnce(new Response(null, { status: 200 }))
            .mockResolvedValueOnce(
                new Response(null, {
                    status: 200,
                    headers: {
                        "content-length": "1024",
                        "content-type": "audio/mpeg",
                    },
                })
            )
            .mockResolvedValueOnce(
                new Response(mockAudioBuffer, { status: 200 })
            )
            .mockResolvedValueOnce(
                new Response(JSON.stringify({ text: "Legacy call transcription." }), { status: 200 })
            );

        // Legacy call signature: transcribeAudio(url, apiKeyString)
        const result = await transcribeAudio(
            "https://example.com/audio.mp3",
            "test-api-key"
        );

        expect(result.text).toBe("Legacy call transcription.");
        expect(result.source).toBe("openai");
    });
});

describe("error predicates", () => {
    it("isRateLimitError should detect 429 errors", () => {
        expect(isRateLimitError(new Error("HTTP 429"))).toBe(true);
        expect(isRateLimitError(new Error("rate limited"))).toBe(true);
        expect(isRateLimitError(new Error("HTTP 500"))).toBe(false);
    });

    it("isServerError should detect 5xx errors", () => {
        expect(isServerError(new Error("HTTP 500"))).toBe(true);
        expect(isServerError(new Error("503 Service Unavailable"))).toBe(true);
        expect(isServerError(new Error("HTTP 429"))).toBe(false);
    });

    it("isTransientError should detect both rate limit and server errors", () => {
        expect(isTransientError(new Error("HTTP 429"))).toBe(true);
        expect(isTransientError(new Error("HTTP 500"))).toBe(true);
        expect(isTransientError(new Error("HTTP 400"))).toBe(false);
    });

    it("never retries AUDIO_REJECTED, even when its message contains a 5xx-like number", () => {
        expect(isTransientError(new AppError(ERROR_CODES.AUDIO_REJECTED, "gpt-transcribe rejected chunk 2/7 (bytes 15695872-31424511)"))).toBe(false);
    });

    it("never retries AUDIO_UNSUPPORTED, even when its message contains a 5xx-like number", () => {
        expect(isTransientError(new AppError(ERROR_CODES.AUDIO_UNSUPPORTED, "Unsupported MP4: chunk would fetch 52 MB"))).toBe(false);
    });
});

describe("extensionFromMime", () => {
    it("should map audio/mpeg to mp3", () => {
        expect(extensionFromMime("audio/mpeg")).toBe("mp3");
    });

    it("should map audio/mp4 to m4a", () => {
        expect(extensionFromMime("audio/mp4")).toBe("m4a");
    });

    it("should map audio/x-m4a to m4a", () => {
        expect(extensionFromMime("audio/x-m4a")).toBe("m4a");
    });

    it("should map audio/aac to m4a", () => {
        expect(extensionFromMime("audio/aac")).toBe("m4a");
    });

    it("should map audio/wav to wav", () => {
        expect(extensionFromMime("audio/wav")).toBe("wav");
    });

    it("should strip parameters from content-type", () => {
        expect(extensionFromMime("audio/mpeg; charset=utf-8")).toBe("mp3");
    });

    it("should fall back to mp3 for unknown types", () => {
        expect(extensionFromMime("application/octet-stream")).toBe("mp3");
        expect(extensionFromMime("unknown")).toBe("mp3");
    });
});

describe("detectAudioFormat", () => {
    it("should detect MP3 after parsing ID3 tag (ID3 + MP3 frames)", () => {
        // ID3v2.4 header with tag size = 4 (syncsafe), followed by 4 filler bytes, then MP3 sync (0xFF 0xFB)
        // bytes 0-9: ID3 header (10 bytes), bytes 10-13: tag body (4 bytes), bytes 14+: audio frames
        const buf = new Uint8Array(20);
        buf[0] = 0x49; buf[1] = 0x44; buf[2] = 0x33; // "ID3"
        buf[3] = 0x04; // version 2.4
        buf[4] = 0x00; // revision
        buf[5] = 0x00; // flags
        buf[6] = 0x00; buf[7] = 0x00; buf[8] = 0x00; buf[9] = 0x04; // size = 4 (syncsafe)
        // tag body: bytes 10-13 (4 bytes of filler)
        buf[10] = 0x00; buf[11] = 0x00; buf[12] = 0x00; buf[13] = 0x00;
        // audio frames start at byte 14: MP3 Layer III sync (0xFF 0xFB)
        buf[14] = 0xFF; buf[15] = 0xFB;
        expect(detectAudioFormat(buf.buffer, "application/octet-stream")).toBe("mp3");
    });

    it("should detect AAC after parsing ID3 tag (ID3 + ADTS AAC frames)", () => {
        // Same ID3 header, but audio frames are ADTS AAC (0xFF 0xF1, layer=00)
        const buf = new Uint8Array(20);
        buf[0] = 0x49; buf[1] = 0x44; buf[2] = 0x33;
        buf[3] = 0x04; buf[4] = 0x00; buf[5] = 0x00;
        buf[6] = 0x00; buf[7] = 0x00; buf[8] = 0x00; buf[9] = 0x04; // tag size = 4
        buf[10] = 0x00; buf[11] = 0x00; buf[12] = 0x00; buf[13] = 0x00;
        // ADTS AAC sync at byte 14 (0xFF 0xF1 → layer=00)
        buf[14] = 0xFF; buf[15] = 0xF1;
        expect(detectAudioFormat(buf.buffer, "application/octet-stream")).toBe("m4a");
    });

    it("should fall back to mp3 when ID3 tag extends beyond buffer", () => {
        // ID3 header with tag size larger than remaining buffer
        const buffer = new Uint8Array([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00]).buffer;
        expect(detectAudioFormat(buffer, "application/octet-stream")).toBe("mp3");
    });

    it("should detect MP3 via MPEG sync word (Layer III)", () => {
        // 0xFB = 1111_1011 → layer bits = (0xFB >> 1) & 0x03 = 01 (Layer III = MP3)
        const buffer = new Uint8Array([0xFF, 0xFB, 0x90, 0x00, 0x00, 0x00, 0x00, 0x00]).buffer;
        expect(detectAudioFormat(buffer, "application/octet-stream")).toBe("mp3");
    });

    it("should detect ADTS AAC via MPEG sync word (Layer 00)", () => {
        // 0xF1 = 1111_0001 → layer bits = (0xF1 >> 1) & 0x03 = 00 (ADTS AAC)
        const buffer = new Uint8Array([0xFF, 0xF1, 0x50, 0x80, 0x00, 0x00, 0x00, 0x00]).buffer;
        expect(detectAudioFormat(buffer, "application/octet-stream")).toBe("m4a");
    });

    it("should detect ADTS AAC with MPEG-2 ID bit", () => {
        // 0xF9 = 1111_1001 → layer bits = (0xF9 >> 1) & 0x03 = 00 (ADTS AAC, MPEG-2 variant)
        const buffer = new Uint8Array([0xFF, 0xF9, 0x50, 0x80, 0x00, 0x00, 0x00, 0x00]).buffer;
        expect(detectAudioFormat(buffer, "application/octet-stream")).toBe("m4a");
    });

    it("should detect M4A via ftyp box", () => {
        // ftyp at bytes 4-7: 0x66 0x74 0x79 0x70
        const buffer = new Uint8Array([0x00, 0x00, 0x00, 0x20, 0x66, 0x74, 0x79, 0x70, 0x4D, 0x34, 0x41, 0x20]).buffer;
        expect(detectAudioFormat(buffer, "application/octet-stream")).toBe("m4a");
    });

    it("should detect WAV via RIFF header", () => {
        const buffer = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00]).buffer;
        expect(detectAudioFormat(buffer, "application/octet-stream")).toBe("wav");
    });

    it("should fall back to content-type header when bytes are unrecognized", () => {
        const buffer = new Uint8Array([0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]).buffer;
        expect(detectAudioFormat(buffer, "audio/mp4")).toBe("m4a");
    });

    it("should fall back to mp3 for unrecognized bytes and generic header", () => {
        const buffer = new Uint8Array([0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]).buffer;
        expect(detectAudioFormat(buffer, "application/octet-stream")).toBe("mp3");
    });
});

// ============================================================================
// Container-aware chunking (#53)
// ============================================================================

const AUDIO_URL = "https://cdn.example.com/episode.m4a";
const OPENAI_URL = getProviderConfig().baseUrl;
const CORRUPTED_ERROR = JSON.stringify({
    error: { message: "Audio file might be corrupted or unsupported", type: "invalid_request_error", param: "file", code: "invalid_value" },
});

interface Upload {
    model: string;
    name: string;
    type: string;
    bytes: Uint8Array;
}

interface ServeOptions {
    contentType?: string;
    /** content-length the HEAD reports. Default: the file's real length. */
    contentLength?: number;
    /** Return an error to throw from the range fetch for `[start, end]`. */
    failRange?: (start: number, end: number) => Error | undefined;
    /** Response for the nth upload (1-based). Default: `{"text": "chunk n."}`. */
    respond?: (upload: Upload, n: number) => Response | undefined;
    /** Serve a GET without a Range header (the small-file path) instead of failing it. */
    allowWholeFileGet?: boolean;
    /** Answer the range fetch for `[start, end]` with the whole file and a 200, like a CDN that ignores Range. */
    ignoreRange?: (start: number, end: number) => boolean;
}

/**
 * Mock `fetch` to serve `file` with real HEAD and Range semantics, and to
 * record every upload to the transcription API.
 */
function serveAudio(file: Uint8Array, options: ServeOptions = {}) {
    const uploads: Upload[] = [];
    const ranges: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
        const url = input instanceof Request ? input.url : String(input);
        if (url === OPENAI_URL) {
            const form = init!.body as FormData;
            const blob = form.get("file") as File;
            const upload: Upload = {
                model: String(form.get("model")),
                name: blob.name,
                type: blob.type,
                bytes: new Uint8Array(await blob.arrayBuffer()),
            };
            uploads.push(upload);
            return (
                options.respond?.(upload, uploads.length) ??
                new Response(JSON.stringify({ text: `chunk ${uploads.length}.` }), { status: 200 })
            );
        }
        if (init?.method === "HEAD") {
            return new Response(null, {
                status: 200,
                headers: {
                    "content-length": String(options.contentLength ?? file.length),
                    "content-type": options.contentType ?? "audio/mp4",
                },
            });
        }
        const range = new Headers(init?.headers).get("Range") ?? "";
        if (!range && options.allowWholeFileGet) {
            return new Response(file.slice(), { status: 200 });
        }
        ranges.push(range);
        const match = /^bytes=(\d+)-(\d+)$/.exec(range);
        if (!match) throw new Error(`unexpected request without a Range: ${url}`);
        const start = Number(match[1]);
        const end = Math.min(Number(match[2]), file.length - 1);
        const failure = options.failRange?.(start, end);
        if (failure) throw failure;
        if (options.ignoreRange?.(start, end)) return new Response(file.slice(), { status: 200 });
        return new Response(file.slice(start, end + 1), { status: 206 });
    });
    return { uploads, ranges };
}

/** The JSON log events a `console.log` spy saw, in order. */
function loggedEvents(log: { mock: { calls: unknown[][] } }) {
    return log.mock.calls
        .map(([line]) => {
            try {
                return JSON.parse(String(line)) as Record<string, unknown>;
            } catch {
                return null;
            }
        })
        .filter((e): e is Record<string, unknown> => e !== null);
}

/** Force the chunked path on a small fixture: it is far over a 1 KB upload limit. */
function chunkedOptions(maxSeconds: number) {
    return { apiKey: "k", chunkLimits: { maxBytes: 1e9, maxSeconds, uploadLimitBytes: 1024 } };
}

async function readTrack(file: Uint8Array) {
    const { moov } = await locateMoov(file, file.length, async (s, e) => file.slice(s, e + 1).buffer);
    return parseAudioTrack(moov);
}

/** The plan production should make for `file`, computed straight from the library. */
async function expectedPlan(file: Uint8Array, maxSeconds: number) {
    const track = await readTrack(file);
    const chunks: SampleChunk[] = planSampleChunks(track, {
        maxBytes: 1e9,
        maxSeconds,
        overlapSeconds: CHUNK_OVERLAP_SECONDS,
    });
    return { track, chunks };
}

const tailPercent = (newBytes: number, totalBytes: number) => Math.round((newBytes / totalBytes) * 1000) / 10;

/**
 * A moov-first MP4 with a video track and an audio track whose samples
 * (one per second) each sit `gapBytes` apart, the way a video track's frames
 * are interleaved with the audio. The audio sample entry is borrowed from a
 * fixture; the sample bytes are filler, which the mocked API never decodes.
 */
async function interleavedMp4({ samples, sampleBytes, gapBytes }: { samples: number; sampleBytes: number; gapBytes: number }) {
    const { stsd } = await readTrack(fixtureBytes(MOOV_FIRST_M4A));
    const ascii = (s: string) => new TextEncoder().encode(s);
    const handler = (type: string) => fullBox("hdlr", 0, 0, u32(0), ascii(type), new Uint8Array(13));
    const ftyp = box("ftyp", ascii("M4A "), u32(0), ascii("M4A "), ascii("isom"));
    const moov = (firstOffset: number) => {
        const offsets = Array.from({ length: samples }, (_, i) => firstOffset + i * (sampleBytes + gapBytes));
        const stbl = box(
            "stbl",
            stsd,
            fullBox("stts", 0, 0, u32(1, samples, 1000)),
            fullBox("stsc", 0, 0, u32(1, 1, 1, 1)),
            fullBox("stsz", 0, 0, u32(sampleBytes, samples)),
            fullBox("stco", 0, 0, u32(samples, ...offsets)),
        );
        const mdhd = fullBox("mdhd", 0, 0, u32(0, 0, 1000, samples * 1000), u16(0x55c4, 0));
        const video = box("trak", box("mdia", handler("vide")));
        const audio = box("trak", box("mdia", mdhd, handler("soun"), box("minf", stbl)));
        return box("moov", video, audio);
    };
    // The stco values don't change moov's size, so size it with a placeholder.
    const mdatStart = ftyp.length + moov(0).length;
    const mdatPayload = new Uint8Array(samples * (sampleBytes + gapBytes));
    for (let i = 0; i < mdatPayload.length; i++) mdatPayload[i] = i % 251;
    const file = new Uint8Array(mdatStart + 8 + mdatPayload.length);
    file.set(ftyp, 0);
    file.set(moov(mdatStart + 8), ftyp.length);
    file.set(box("mdat", mdatPayload), mdatStart);
    return file;
}

describe("detectContainer", () => {
    /** A 10-byte ID3v2.4 header with a `bodySize`-byte (zeroed) body. */
    function id3(bodySize: number): Uint8Array {
        const tag = new Uint8Array(10 + bodySize);
        tag.set([0x49, 0x44, 0x33, 0x04, 0x00, 0x00]);
        tag[6] = (bodySize >> 21) & 0x7f;
        tag[7] = (bodySize >> 14) & 0x7f;
        tag[8] = (bodySize >> 7) & 0x7f;
        tag[9] = bodySize & 0x7f;
        return tag;
    }

    function concat(...parts: Uint8Array[]): Uint8Array {
        const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
        let at = 0;
        for (const p of parts) {
            out.set(p, at);
            at += p.length;
        }
        return out;
    }

    it("returns mp4 for an ftyp box", () => {
        expect(detectContainer(fixtureBytes(MOOV_FIRST_M4A))).toBe("mp4");
        expect(detectContainer(fixtureBytes(MOOV_LAST_M4A))).toBe("mp4");
    });

    it("returns mp3 for an ID3 tag followed by an MPEG Layer III frame", () => {
        const probe = concat(id3(4), new Uint8Array([0xff, 0xfb, 0x90, 0x00, 0x00, 0x00, 0x00]));
        expect(detectContainer(probe)).toBe("mp3");
    });

    it("returns mp3 for a bare Layer III frame and for an ID3 tag longer than the probe", () => {
        expect(detectContainer(new Uint8Array([0xff, 0xfb, 0x90, 0x00, 0x00, 0x00, 0x00]))).toBe("mp3");
        expect(detectContainer(id3(1000).subarray(0, 512))).toBe("mp3");
    });

    it("returns adts for ADTS_AAC and ADTS_AAC_ID3", () => {
        expect(detectContainer(fixtureBytes(ADTS_AAC))).toBe("adts");
        expect(detectContainer(fixtureBytes(ADTS_AAC_ID3))).toBe("adts");
    });

    it("returns other for zero-filled bytes", () => {
        expect(detectContainer(new Uint8Array(512))).toBe("other");
    });

    it("returns other for a lone 0xFFF1 header with no second header", () => {
        const firstHeader = fixtureBytes(ADTS_AAC).slice(0, 7);
        // Nothing valid where the second frame should start.
        expect(detectContainer(concat(firstHeader, new Uint8Array(1024)))).toBe("other");
        // The probe ends before the second frame could start.
        expect(detectContainer(firstHeader)).toBe("other");
    });
});

describe("chunked MP4 transcription", () => {
    beforeEach(() => {
        vi.restoreAllMocks();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    // 3.25 s chunks with 2 s overlap split the 5 s fixtures into 3 chunks.
    const THREE_CHUNKS_SECONDS = 3.25;

    it.each([
        ["moov before mdat", MOOV_FIRST_M4A],
        ["moov at the end", MOOV_LAST_M4A],
        ["an interleaved chapter track", CHAPTERS_M4A],
    ])("uploads only self-contained M4A chunks (%s)", async (_label, fixture) => {
        const file = fixtureBytes(fixture);
        const { uploads, ranges } = serveAudio(file);
        const plan = await expectedPlan(file, THREE_CHUNKS_SECONDS);
        expect(plan.chunks).toHaveLength(3);

        const result = await transcribeAudio(AUDIO_URL, chunkedOptions(THREE_CHUNKS_SECONDS));

        expect(result.partial).toBeUndefined();
        expect(uploads).toHaveLength(3);
        for (const [i, upload] of uploads.entries()) {
            expect(upload.name).toBe("audio.m4a");
            expect(upload.type).toBe("audio/mp4");
            expect(new TextDecoder().decode(upload.bytes.subarray(4, 8))).toBe("ftyp");
            const track = await readTrack(upload.bytes);
            expect(track.codec).toBe("mp4a");
            const chunk = plan.chunks[i];
            expect(track.sampleCount).toBe(chunk.endSample - chunk.firstSample);
            expect(track.totalPayloadBytes).toBe(chunk.payloadBytes);
        }
        // One probe of the whole (sub-64 KB) file, then range reads for samples only.
        expect(ranges[0]).toBe(`bytes=0-${file.length - 1}`);
    });

    it("stitches the chunk texts in order", async () => {
        serveAudio(fixtureBytes(MOOV_FIRST_M4A));

        const result = await transcribeAudio(AUDIO_URL, chunkedOptions(THREE_CHUNKS_SECONDS));

        expect(result.text).toBe("chunk 1. chunk 2. chunk 3.");
        expect(result.model).toBe("gpt-transcribe");
    });

    it("logs the container, the MP4 layout and the chunk plan", async () => {
        serveAudio(fixtureBytes(MOOV_LAST_M4A));
        const log = vi.spyOn(console, "log").mockImplementation(() => {});

        await transcribeAudio(AUDIO_URL, chunkedOptions(THREE_CHUNKS_SECONDS));

        const events = log.mock.calls
            .map(([line]) => {
                try {
                    return JSON.parse(String(line)) as Record<string, unknown>;
                } catch {
                    return null;
                }
            })
            .filter((e): e is Record<string, unknown> => e !== null);
        const find = (name: string) => events.filter((e) => e.event === name);

        expect(find("container_detected")).toEqual([
            { event: "container_detected", container: "mp4", contentType: "audio/mp4", id3Bytes: 0 },
        ]);
        const [layout] = find("mp4_layout");
        expect(layout).toMatchObject({
            moovAtEnd: true,
            trackCount: 1,
            codec: "mp4a",
            timescale: 44100,
            sampleCount: 217,
        });
        expect((layout.layout as Array<{ type: string }>).map((b) => b.type)).toEqual(["ftyp", "free", "mdat", "moov"]);
        const [plan] = find("mp4_chunk_plan");
        expect(plan.totalChunks).toBe(3);
        expect(plan.chunks).toHaveLength(3);
        const [first] = plan.chunks as Array<Record<string, unknown>>;
        // An audio-only file fetches exactly its samples.
        expect(first).toMatchObject({ rangeRequests: 1, fetchBytes: first.payloadBytes, startSeconds: 0 });
        const processing = find("chunk_processing");
        expect(processing.map((e) => [e.chunkIndex, e.totalChunks])).toEqual([[1, 3], [2, 3], [3, 3]]);
        expect(processing[0]).toHaveProperty("firstSample", 0);
    });

    it("rejects a file over MAX_TOTAL_SIZE_BYTES before fetching any audio", async () => {
        const { uploads, ranges } = serveAudio(fixtureBytes(MOOV_FIRST_M4A), {
            contentLength: MAX_TOTAL_SIZE_BYTES + 1,
        });

        const error = await transcribeAudio(AUDIO_URL, { apiKey: "k" }).catch((e) => e);

        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toMatch(/^Audio file too large: \d+MB exceeds 300MB limit$/);
        expect(ranges).toEqual([]);
        expect(uploads).toHaveLength(0);
    });

    it("fails fast with AUDIO_UNSUPPORTED when a chunk's fetches would far exceed the chunk size (video)", async () => {
        // 1 KB of audio every 20 KB: a 10 KB chunk of audio spans ~200 KB of file.
        const file = await interleavedMp4({ samples: 40, sampleBytes: 1000, gapBytes: 20_000 });
        expect(file.length).toBeGreaterThan(CONTAINER_PROBE_BYTES);
        const { uploads, ranges } = serveAudio(file, { contentType: "application/octet-stream" });

        const error = await transcribeAudio(AUDIO_URL, {
            apiKey: "k",
            chunkLimits: { maxBytes: 10_000, maxSeconds: 900, uploadLimitBytes: 1024 },
        }).catch((e) => e);

        expect(error).toBeInstanceOf(AppError);
        expect((error as AppError).code).toBe(ERROR_CODES.AUDIO_UNSUPPORTED);
        expect((error as AppError).message).toMatch(
            /^Unsupported MP4: audio is interleaved with \d+ MB of other data per chunk \(video file\?\)$/,
        );
        // moov is inside the probe, so the probe is the only read.
        expect(ranges).toEqual([`bytes=0-${CONTAINER_PROBE_BYTES - 1}`]);
        expect(uploads).toHaveLength(0);
    });

    it("chunks a file whose audio is interleaved with a little other data", async () => {
        const file = await interleavedMp4({ samples: 40, sampleBytes: 1000, gapBytes: 100 });
        const { uploads } = serveAudio(file, { contentType: "application/octet-stream" });

        const result = await transcribeAudio(AUDIO_URL, {
            apiKey: "k",
            chunkLimits: { maxBytes: 10_000, maxSeconds: 900, uploadLimitBytes: 1024 },
        });

        expect(result.partial).toBeUndefined();
        expect(uploads.length).toBeGreaterThan(1);
        for (const upload of uploads) expect((await readTrack(upload.bytes)).totalPayloadBytes).toBeLessThanOrEqual(10_000);
    });

    it("fails fast with AUDIO_UNSUPPORTED for a truncated moov-first file, before any upload", async () => {
        const whole = fixtureBytes(MOOV_FIRST_M4A);
        const file = whole.slice(0, whole.length - 500);
        const { uploads } = serveAudio(file);

        const error = await transcribeAudio(AUDIO_URL, chunkedOptions(THREE_CHUNKS_SECONDS)).catch((e) => e);

        expect(error).toBeInstanceOf(AppError);
        expect((error as AppError).code).toBe(ERROR_CODES.AUDIO_UNSUPPORTED);
        expect((error as AppError).message).toBe(
            `Unsupported MP4: file is truncated (sample table needs ${whole.length} bytes, file has ${file.length})`,
        );
        expect(uploads).toHaveLength(0);
    });

    it("fails fast with AUDIO_UNSUPPORTED for a fragmented file and never calls OpenAI", async () => {
        const { uploads } = serveAudio(fixtureBytes(FRAGMENTED_M4A));

        const error = await transcribeAudio(AUDIO_URL, chunkedOptions(THREE_CHUNKS_SECONDS)).catch((e) => e);

        expect(error).toBeInstanceOf(AppError);
        expect((error as AppError).code).toBe(ERROR_CODES.AUDIO_UNSUPPORTED);
        expect((error as AppError).message).toContain("fragmented");
        expect(uploads).toHaveLength(0);
    });

    it("fails fast with AUDIO_UNSUPPORTED for a non-AAC codec", async () => {
        const { uploads } = serveAudio(fixtureBytes(ALAC_M4A));

        const error = await transcribeAudio(AUDIO_URL, chunkedOptions(THREE_CHUNKS_SECONDS)).catch((e) => e);

        expect((error as AppError).code).toBe(ERROR_CODES.AUDIO_UNSUPPORTED);
        expect((error as AppError).message).toContain("alac");
        expect(uploads).toHaveLength(0);
    });

    it("does not tail-skip an AUDIO_UNSUPPORTED error", async () => {
        const file = fixtureBytes(MOOV_FIRST_M4A);
        const maxSeconds = 3.3;
        const { track, chunks } = await expectedPlan(file, maxSeconds);
        const tail = chunks[chunks.length - 1];
        // Small enough that a transcription failure here would be skipped.
        expect(tail.newPayloadBytes / track.totalPayloadBytes).toBeLessThanOrEqual(0.1);

        const { uploads } = serveAudio(file, {
            // mdat is the last box, so only the final chunk's samples reach EOF.
            failRange: (start, end) =>
                start > 0 && end === file.length - 1
                    ? new AppError(ERROR_CODES.AUDIO_UNSUPPORTED, "Unsupported MP4: test failure")
                    : undefined,
        });

        const error = await transcribeAudio(AUDIO_URL, chunkedOptions(maxSeconds)).catch((e) => e);

        expect(error).toBeInstanceOf(AppError);
        expect((error as AppError).code).toBe(ERROR_CODES.AUDIO_UNSUPPORTED);
        expect((error as AppError).message).toBe("Unsupported MP4: test failure");
        expect(uploads).toHaveLength(chunks.length - 1);
    });

    /** gpt-transcribe rejects the final chunk's upload. */
    function rejectFinalChunk(totalChunks: number) {
        return (_upload: Upload, n: number) =>
            n === totalChunks ? new Response(CORRUPTED_ERROR, { status: 400 }) : undefined;
    }

    it("measures the #54 tail share on payload bytes: a small tail is skipped", async () => {
        const file = fixtureBytes(MOOV_FIRST_M4A);
        const maxSeconds = 3.3;
        const { track, chunks } = await expectedPlan(file, maxSeconds);
        const tail = chunks[chunks.length - 1];
        const expected = tailPercent(tail.newPayloadBytes, track.totalPayloadBytes);
        expect(expected).toBeLessThanOrEqual(10);
        // Measuring on file size would report a different figure.
        expect(tailPercent(tail.newPayloadBytes, file.length)).not.toBe(expected);
        const { uploads } = serveAudio(file, { respond: rejectFinalChunk(chunks.length) });

        const result = await transcribeAudio(AUDIO_URL, chunkedOptions(maxSeconds));

        expect(uploads).toHaveLength(chunks.length);
        expect(result.partial).toBe(true);
        expect(result.partialReason).toContain(`Final chunk ${chunks.length}/${chunks.length}`);
        expect(result.partialReason).toContain(`missing the last ${expected}% of the audio`);
        expect(result.text).toBe("chunk 1. chunk 2.");
    });

    it("measures the #54 tail share on payload bytes: a large tail fails the job", async () => {
        const file = fixtureBytes(MOOV_FIRST_M4A);
        const maxSeconds = 3.25;
        const { track, chunks } = await expectedPlan(file, maxSeconds);
        const tail = chunks[chunks.length - 1];
        expect(tail.newPayloadBytes / track.totalPayloadBytes).toBeGreaterThan(0.1);
        const { uploads } = serveAudio(file, { respond: rejectFinalChunk(chunks.length) });

        const error = await transcribeAudio(AUDIO_URL, chunkedOptions(maxSeconds)).catch((e) => e);

        expect(error).toBeInstanceOf(AppError);
        expect((error as AppError).code).toBe(ERROR_CODES.AUDIO_REJECTED);
        expect((error as AppError).message).toBe(`gpt-transcribe rejected chunk ${chunks.length}/${chunks.length} of the audio`);
        expect(uploads).toHaveLength(chunks.length);
    });
});

describe("chunked transcription of non-MP4 containers", () => {
    beforeEach(() => {
        vi.restoreAllMocks();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("uploads MP3 chunks as bare MPEG frames: no ID3 tag, no Info frame, no 512-byte prepend", async () => {
        const file = fixtureBytes(MP3_CBR_INFO);
        const id3 = id3Length(file);
        const audioStart = id3 + parseMp3FrameHeader(file, id3)!.frameLength;
        const { uploads, ranges } = serveAudio(file, { contentType: "audio/mpeg" });
        const log = vi.spyOn(console, "log").mockImplementation(() => {});

        const result = await transcribeAudio("https://cdn.example.com/episode.mp3", chunkedOptions(2));

        expect(result.text).toBe("chunk 1. chunk 2. chunk 3. chunk 4.");
        const chunkRanges = ranges.slice(1).map((r) => r.slice("bytes=".length).split("-").map(Number));
        expect(ranges[0]).toBe(`bytes=0-${file.length - 1}`);
        expect(chunkRanges[0][0]).toBe(audioStart);
        expect(uploads.map((u) => u.name)).toEqual(["audio.mp3", "audio.mp3", "audio.mp3", "audio.mp3"]);
        expect(uploads[0].bytes).toEqual(file.slice(audioStart, chunkRanges[0][1] + 1));
        for (const [i, upload] of uploads.entries()) {
            // Each upload is its fetched range, trimmed to start on a plain audio frame.
            const [start, end] = chunkRanges[i];
            const fetched = file.slice(start, end + 1);
            expect(fetched.subarray(fetched.length - upload.bytes.length)).toEqual(upload.bytes);
            const header = parseMp3FrameHeader(upload.bytes, 0);
            expect(header).not.toBeNull();
            expect(readVbrHeader(upload.bytes, 0, header!)).toBeNull();
        }
        expect(log.mock.calls.some(([line]) => String(line).includes("header_prepended"))).toBe(false);
    });

    it("keeps the byte-range path, prepending the first 512 bytes, for an MP3 whose frames can't be parsed", async () => {
        // ID3 tag + one Layer III sync with no second frame behind it, then a recognisable byte pattern.
        const file = new Uint8Array(60_000);
        for (let i = 0; i < file.length; i++) file[i] = i % 251;
        file.set([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x04, 0, 0, 0, 0, 0xff, 0xfb, 0x90, 0x00]);
        const { uploads, ranges } = serveAudio(file, { contentType: "audio/mpeg" });

        // 50 KB byte chunks with today's 32 KB overlap: [0, 49999] and [17232, 59999].
        const result = await transcribeAudio("https://cdn.example.com/episode.mp3", {
            apiKey: "k",
            chunkLimits: { maxBytes: 50_000, maxSeconds: 900, uploadLimitBytes: 1024 },
        });

        expect(result.text).toBe("chunk 1. chunk 2.");
        expect(ranges).toEqual(["bytes=0-59999", "bytes=0-49999", "bytes=17232-59999"]);
        expect(uploads.map((u) => u.name)).toEqual(["audio.mp3", "audio.mp3"]);
        expect(uploads[0].bytes).toEqual(file.slice(0, 50_000));
        expect(uploads[1].bytes).toEqual(new Uint8Array([...file.slice(0, 512), ...file.slice(17_232)]));
    });
});

describe("ADTS transcription", () => {
    beforeEach(() => {
        vi.restoreAllMocks();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    const ADTS_URL = "https://cdn.example.com/episode.aac";

    /** A 10-byte ID3v2.4 header with a `bodySize`-byte (zeroed) body. */
    function id3(bodySize: number): Uint8Array {
        const tag = new Uint8Array(10 + bodySize);
        tag.set([0x49, 0x44, 0x33, 0x04, 0x00, 0x00]);
        tag[6] = (bodySize >> 21) & 0x7f;
        tag[7] = (bodySize >> 14) & 0x7f;
        tag[8] = (bodySize >> 7) & 0x7f;
        tag[9] = bodySize & 0x7f;
        return tag;
    }

    function concat(...parts: Uint8Array[]): Uint8Array {
        const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
        let at = 0;
        for (const p of parts) {
            out.set(p, at);
            at += p.length;
        }
        return out;
    }

    /** Payload bytes of an ADTS frame, header stripped. */
    function framePayload(bytes: Uint8Array, frame: AdtsFrame): Uint8Array {
        return bytes.subarray(frame.offset + frame.headerSize, frame.offset + frame.length);
    }

    /** Every upload is a parseable M4A; returns their tracks. */
    async function expectM4aUploads(uploads: Upload[]) {
        const tracks = [];
        for (const upload of uploads) {
            expect(upload.name).toBe("audio.m4a");
            expect(new TextDecoder().decode(upload.bytes.subarray(4, 8))).toBe("ftyp");
            const track = await readTrack(upload.bytes);
            expect(track.codec).toBe("mp4a");
            expect(track.sampleCount).toBeGreaterThan(0);
            tracks.push(track);
        }
        return tracks;
    }

    /** The first and last uploaded samples are the stream's first and last frames. */
    function expectFullCoverage(uploads: Upload[], tracks: Mp4AudioTrack[], audio: Uint8Array) {
        const { frames } = parseAdtsFrames(audio);
        const first = tracks[0];
        const last = tracks[tracks.length - 1];
        const lastUpload = uploads[uploads.length - 1].bytes;
        const lastSample = last.sampleCount - 1;
        expect(uploads[0].bytes.subarray(first.offsets[0], first.offsets[0] + first.sizes[0])).toEqual(
            framePayload(audio, frames[0]),
        );
        expect(
            lastUpload.subarray(last.offsets[lastSample], last.offsets[lastSample] + last.sizes[lastSample]),
        ).toEqual(framePayload(audio, frames[frames.length - 1]));
    }

    it("wraps a small ADTS file before upload", async () => {
        const file = fixtureBytes(ADTS_AAC);
        const { uploads } = serveAudio(file, { contentType: "audio/aac", allowWholeFileGet: true });

        const result = await transcribeAudio(ADTS_URL, { apiKey: "k" });

        expect(result.text).toBe("chunk 1.");
        expect(uploads).toHaveLength(1);
        const [track] = await expectM4aUploads(uploads);
        expect(uploads[0].type).toBe("audio/mp4");
        expect(track.sampleCount).toBe(parseAdtsFrames(file).frames.length);
    });

    it("wraps a small ADTS file behind an ID3 tag", async () => {
        const file = concat(id3(70_000), fixtureBytes(ADTS_AAC));
        const { uploads } = serveAudio(file, { contentType: "audio/aac", allowWholeFileGet: true });

        await transcribeAudio(ADTS_URL, { apiKey: "k" });

        const [track] = await expectM4aUploads(uploads);
        expect(track.sampleCount).toBe(217);
    });

    it("leaves a small MP4 untouched", async () => {
        const file = fixtureBytes(MOOV_LAST_M4A);
        const { uploads } = serveAudio(file, { allowWholeFileGet: true });

        await transcribeAudio(AUDIO_URL, { apiKey: "k" });

        expect(uploads).toHaveLength(1);
        expect(uploads[0].bytes).toEqual(file);
    });

    it("prepareForUpload rewrites only ADTS", () => {
        const mp3 = new Uint8Array([0xff, 0xfb, 0x90, 0x00, 0x00, 0x00, 0x00]).buffer;
        expect(prepareForUpload(mp3)).toBe(mp3);
        const m4a = new Uint8Array(fixtureBytes(MOOV_FIRST_M4A)).buffer;
        expect(prepareForUpload(m4a)).toBe(m4a);
        const wrapped = new Uint8Array(prepareForUpload(new Uint8Array(fixtureBytes(ADTS_AAC_ID3)).buffer));
        expect(new TextDecoder().decode(wrapped.subarray(4, 8))).toBe("ftyp");
    });

    it("chunks a large ADTS file into M4A chunks", async () => {
        const file = fixtureBytes(ADTS_AAC);
        const { uploads } = serveAudio(file, { contentType: "audio/aac" });

        const result = await transcribeAudio(ADTS_URL, {
            apiKey: "k",
            chunkLimits: { maxBytes: 16_000, maxSeconds: 900, uploadLimitBytes: 1024 },
        });

        expect(result.partial).toBeUndefined();
        expect(uploads.length).toBeGreaterThanOrEqual(3);
        expect(result.text).toBe(uploads.map((_, i) => `chunk ${i + 1}.`).join(" "));
        const tracks = await expectM4aUploads(uploads);
        for (const upload of uploads) expect(upload.bytes.length).toBeLessThanOrEqual(16_000 + 1024);
        expectFullCoverage(uploads, tracks, file);
    });

    it("fails a chunk with AUDIO_UNAVAILABLE when the CDN ignores its Range", async () => {
        const file = fixtureBytes(ADTS_AAC);
        expect(file.length).toBeLessThan(CONTAINER_PROBE_BYTES);
        const { uploads } = serveAudio(file, {
            contentType: "audio/aac",
            // The probe already asks for the whole file; the first chunk asks for less.
            ignoreRange: (start, end) => start === 0 && end < file.length - 1,
        });

        const error = await transcribeAudio(ADTS_URL, {
            apiKey: "k",
            chunkLimits: { maxBytes: 16_000, maxSeconds: 900, uploadLimitBytes: 1024 },
        }).catch((e) => e);

        expect(error).toBeInstanceOf(AppError);
        expect((error as AppError).code).toBe(ERROR_CODES.AUDIO_UNAVAILABLE);
        expect((error as AppError).message).toBe(`Range request returned ${file.length} bytes, expected 16000`);
        expect(uploads).toHaveLength(0);
    });

    it("shrinks ADTS byte chunks to the duration cap", async () => {
        const file = fixtureBytes(ADTS_AAC);
        const { uploads } = serveAudio(file, { contentType: "audio/aac" });

        await transcribeAudio(ADTS_URL, chunkedOptions(2));

        expect(uploads.length).toBeGreaterThanOrEqual(3);
        const tracks = await expectM4aUploads(uploads);
        // The bitrate is estimated from the probe, so allow a frame or two of slack.
        for (const track of tracks) expect(track.durationSeconds).toBeLessThanOrEqual(2.05);
        expectFullCoverage(uploads, tracks, file);
    });

    it("logs the ADTS chunk plan", async () => {
        serveAudio(fixtureBytes(ADTS_AAC), { contentType: "audio/aac" });
        const log = vi.spyOn(console, "log").mockImplementation(() => {});

        await transcribeAudio(ADTS_URL, chunkedOptions(2));

        const events = loggedEvents(log);
        expect(events.find((e) => e.event === "container_detected")).toMatchObject({ container: "adts" });
        const plan = events.find((e) => e.event === "adts_chunk_plan");
        expect(plan).toMatchObject({
            objectType: 2,
            sampleRate: 44100,
            channelConfig: 1,
            totalChunks: events.filter((e) => e.event === "chunk_processing").length,
        });
        const bytesPerSecond = plan!.bytesPerSecond as number;
        expect(bytesPerSecond).toBeGreaterThan(8000);
        expect(bytesPerSecond).toBeLessThan(9000);
        // bytesPerSecond is logged rounded.
        expect(Math.abs((plan!.maxChunkBytes as number) - bytesPerSecond * 2)).toBeLessThanOrEqual(2);
        expect(plan!.overlapBytes).toBe(Math.floor((plan!.maxChunkBytes as number) / 4));
        expect(events.some((e) => e.event === "header_prepended")).toBe(false);
    });

    it("chunks ADTS behind an ID3 tag larger than the probe", async () => {
        const tag = id3(70_000);
        const audio = fixtureBytes(ADTS_AAC);
        const file = concat(tag, audio);
        const { uploads, ranges } = serveAudio(file, { contentType: "audio/aac" });
        const log = vi.spyOn(console, "log").mockImplementation(() => {});

        await transcribeAudio(ADTS_URL, {
            apiKey: "k",
            chunkLimits: { maxBytes: 16_000, maxSeconds: 900, uploadLimitBytes: 1024 },
        });

        expect(loggedEvents(log).find((e) => e.event === "container_detected")).toMatchObject({
            container: "adts",
            id3Bytes: tag.length,
        });
        // A second probe starts where the tag ends; no chunk reads the tag.
        expect(ranges[1]).toMatch(new RegExp(`^bytes=${tag.length}-`));
        for (const range of ranges.slice(2)) {
            expect(Number(/^bytes=(\d+)-/.exec(range)![1])).toBeGreaterThanOrEqual(tag.length);
        }
        const tracks = await expectM4aUploads(uploads);
        expect(uploads.length).toBeGreaterThanOrEqual(3);
        expectFullCoverage(uploads, tracks, audio);
    });

    it("keeps MP3 behind an ID3 tag larger than the probe on the byte path", async () => {
        const tag = id3(70_000);
        const frames = new Uint8Array(20_000);
        for (let i = 0; i < frames.length; i++) frames[i] = i % 251;
        frames.set([0xff, 0xfb, 0x90, 0x00]);
        const file = concat(tag, frames);
        const { uploads } = serveAudio(file, { contentType: "audio/mpeg" });
        const log = vi.spyOn(console, "log").mockImplementation(() => {});

        await transcribeAudio("https://cdn.example.com/episode.mp3", {
            apiKey: "k",
            chunkLimits: { maxBytes: 50_000, maxSeconds: 900, uploadLimitBytes: 1024 },
        });

        expect(loggedEvents(log).find((e) => e.event === "container_detected")).toMatchObject({ container: "mp3" });
        expect(uploads.length).toBeGreaterThanOrEqual(2);
        expect(uploads.map((u) => u.name)).toEqual(uploads.map(() => "audio.mp3"));
    });
});

describe("duration-aware routing for small files", () => {
    beforeEach(() => {
        vi.restoreAllMocks();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    const MP3_URL = "https://example.com/episode.mp3";

    /** Where an MP3 fixture's audio starts: past its ID3 tag and its VBR header frame. */
    function mp3AudioStart(file: Uint8Array): number {
        const id3 = id3Length(file);
        return id3 + parseMp3FrameHeader(file, id3)!.frameLength;
    }

    /** The upload starts on a plain audio frame, not a Xing/Info/VBRI frame. */
    function expectBareFirstFrame(bytes: Uint8Array) {
        const header = parseMp3FrameHeader(bytes, 0);
        expect(header).not.toBeNull();
        expect(readVbrHeader(bytes, 0, header!)).toBeNull();
    }

    /** Small-file limits: the default caps with one overridden. */
    function limits(overrides: { maxSeconds?: number; uploadLimitBytes?: number }) {
        return { maxBytes: TARGET_CHUNK_SIZE_BYTES, maxSeconds: MAX_CHUNK_SECONDS, ...overrides };
    }

    it("uploads a small MP3 whole, without its Info frame", async () => {
        const file = fixtureBytes(MP3_CBR_INFO);
        const id3 = id3Length(file);
        expect(readVbrHeader(file, id3, parseMp3FrameHeader(file, id3)!)).toMatchObject({ kind: "info" });
        const { uploads, ranges } = serveAudio(file, { contentType: "audio/mpeg", allowWholeFileGet: true });

        const result = await transcribeAudio(MP3_URL, { apiKey: "k" });

        expect(result.text).toBe("chunk 1.");
        expect(uploads).toHaveLength(1);
        expect(uploads[0].name).toBe("audio.mp3");
        expect(uploads[0].bytes).toEqual(file.slice(mp3AudioStart(file)));
        expectBareFirstFrame(uploads[0].bytes);
        // Planned from the bytes already fetched: no range reads.
        expect(ranges).toEqual([]);
    });

    it("chunks a small file whose duration exceeds the cap", async () => {
        const file = fixtureBytes(MP3_CBR_INFO);
        const plan = await planChunks({
            probe: file,
            fileSize: file.length,
            contentType: "audio/mpeg",
            limits: { maxBytes: AUDIO_LIMITS.MAX_SIZE_BYTES, maxSeconds: 2 },
            fetchRange: async (start, end) => file.slice(start, end + 1).buffer,
        });
        expect(plan.chunks.length).toBeGreaterThan(1);
        const { uploads, ranges } = serveAudio(file, { contentType: "audio/mpeg", allowWholeFileGet: true });

        const result = await transcribeAudio(MP3_URL, { apiKey: "k", chunkLimits: limits({ maxSeconds: 2 }) });

        expect(result.partial).toBeUndefined();
        expect(uploads).toHaveLength(plan.chunks.length);
        expect(result.text).toBe(plan.chunks.map((_, i) => `chunk ${i + 1}.`).join(" "));
        expect(ranges).toEqual([]);
        expect(uploads[0].bytes).toEqual(file.slice(mp3AudioStart(file), mp3AudioStart(file) + uploads[0].bytes.length));
        for (const upload of uploads) expectBareFirstFrame(upload.bytes);
    });

    it("uploads a small MP4 under the cap byte-for-byte as today", async () => {
        const file = fixtureBytes(MOOV_FIRST_M4A);
        const { uploads, ranges } = serveAudio(file, { allowWholeFileGet: true });
        const log = vi.spyOn(console, "log").mockImplementation(() => {});

        const result = await transcribeAudio(AUDIO_URL, { apiKey: "k" });

        expect(result.text).toBe("chunk 1.");
        expect(uploads).toHaveLength(1);
        expect(uploads[0].bytes).toEqual(file);
        expect(ranges).toEqual([]);
        expect(loggedEvents(log).find((e) => e.event === "upload_plan")).toMatchObject({
            container: "mp4",
            uploadBytes: file.length,
        });
    });

    it("uploads a small 'other' file whole as today", async () => {
        const file = new Uint8Array(30_000);
        for (let i = 0; i < file.length; i++) file[i] = i % 251;
        file.set([0x4f, 0x67, 0x67, 0x53]); // OggS
        const { uploads } = serveAudio(file, { contentType: "audio/ogg", allowWholeFileGet: true });
        const log = vi.spyOn(console, "log").mockImplementation(() => {});

        await transcribeAudio("https://example.com/episode.ogg", { apiKey: "k" });

        expect(uploads).toHaveLength(1);
        expect(uploads[0].name).toBe("audio.ogg");
        expect(uploads[0].bytes).toEqual(file);
        const events = loggedEvents(log);
        expect(events.find((e) => e.event === "upload_plan")).toMatchObject({
            container: "other",
            uploadBytes: file.length,
        });
        expect(events.some((e) => e.event === "header_prepended")).toBe(false);
    });

    it("falls back to the whole-file upload when planning a small file throws AUDIO_UNSUPPORTED", async () => {
        const file = fixtureBytes(FRAGMENTED_M4A);
        const { uploads } = serveAudio(file, { allowWholeFileGet: true });
        const log = vi.spyOn(console, "log").mockImplementation(() => {});

        const result = await transcribeAudio(AUDIO_URL, { apiKey: "k" });

        expect(result.text).toBe("chunk 1.");
        expect(uploads).toHaveLength(1);
        expect(uploads[0].bytes).toEqual(file);
        const events = loggedEvents(log);
        const unavailable = events.filter((e) => e.event === "upload_plan_unavailable");
        expect(unavailable).toHaveLength(1);
        expect(unavailable[0]).toMatchObject({
            reason: expect.stringContaining("fragmented"),
            audioHost: "cdn.example.com",
        });
        expect(events.some((e) => e.event === "upload_plan")).toBe(false);
    });

    /** The audio summary MP3_CBR_INFO plans with. */
    function mp3Summary(file: Uint8Array) {
        const header = parseMp3FrameHeader(file, mp3AudioStart(file))!;
        return {
            container: "mp3",
            bitrateKbps: header.bitrateKbps,
            sampleRate: header.sampleRate,
            channels: header.channels,
            vbrHeader: "info",
            vbrHeaderDropped: true,
            declaredSeconds: expect.any(Number),
            estimatedSeconds: expect.any(Number),
            usedSeconds: expect.any(Number),
            maxChunkSeconds: 900,
            audioHost: "example.com",
        };
    }

    function expectHostOnly(event: Record<string, unknown>) {
        const line = JSON.stringify(event);
        expect(line).not.toContain("https://");
        expect(line).not.toContain("sig=");
    }

    it("logs chunking_plan with the audio summary and the host only", async () => {
        const file = fixtureBytes(MP3_CBR_INFO);
        serveAudio(file, { contentType: "audio/mpeg" });
        const log = vi.spyOn(console, "log").mockImplementation(() => {});

        // Over a 1 KB upload limit, so the remote chunked path with the default per-chunk caps.
        await transcribeAudio(`${MP3_URL}?sig=secret`, { apiKey: "k", chunkLimits: limits({ uploadLimitBytes: 1024 }) });

        const plans = loggedEvents(log).filter((e) => e.event === "chunking_plan");
        expect(plans).toHaveLength(1);
        expect(plans[0]).toMatchObject({ ...mp3Summary(file), totalChunks: 1 });
        const { declaredSeconds, estimatedSeconds, usedSeconds } = plans[0] as Record<string, number>;
        expect(usedSeconds).toBe(Math.max(declaredSeconds, estimatedSeconds));
        expectHostOnly(plans[0]);
    });

    it("logs upload_plan for a whole-file upload with the same fields", async () => {
        const file = fixtureBytes(MP3_CBR_INFO);
        serveAudio(file, { contentType: "audio/mpeg", allowWholeFileGet: true });
        const log = vi.spyOn(console, "log").mockImplementation(() => {});

        await transcribeAudio(`${MP3_URL}?sig=secret`, { apiKey: "k" });

        const events = loggedEvents(log);
        const plans = events.filter((e) => e.event === "upload_plan");
        expect(plans).toHaveLength(1);
        expect(plans[0]).toMatchObject({ ...mp3Summary(file), uploadBytes: file.length - mp3AudioStart(file) });
        expectHostOnly(plans[0]);
        expect(events.some((e) => e.event === "chunking_plan")).toBe(false);
    });
});

describe("model rejections (AUDIO_REJECTED)", () => {
    beforeEach(() => {
        vi.restoreAllMocks();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    const MP3_URL = "https://cdn.example.com/episode.mp3";
    /** Splits the 5 s MP3_CBR_INFO fixture into three chunks. */
    const THREE_MP3_CHUNKS_SECONDS = 2.5;
    const INPUT_TOO_LARGE_ERROR = JSON.stringify({
        error: { message: "Audio input is too large.", type: "invalid_request_error", param: "file", code: "input_too_large" },
    });
    const TOO_LARGE_FOR_MODEL_ERROR = JSON.stringify({
        error: { message: "Audio duration 1520 seconds is too large for this model", type: "invalid_request_error", param: null, code: null },
    });

    const reject = (body = CORRUPTED_ERROR) => new Response(body, { status: 400 });
    const hex = (bytes: Uint8Array) =>
        Array.from(bytes.subarray(0, 32), (b) => b.toString(16).padStart(2, "0")).join(" ");

    /** The plan the remote chunked path makes for MP3_CBR_INFO at `maxSeconds`. */
    async function mp3Plan(file: Uint8Array, maxSeconds: number) {
        return planChunks({
            probe: file,
            fileSize: file.length,
            contentType: "audio/mpeg",
            limits: { maxBytes: 1e9, maxSeconds },
            fetchRange: async (start, end) => file.slice(start, end + 1).buffer,
        });
    }

    function rejectionEvents(errorLog: { mock: { calls: unknown[][] } }) {
        return loggedEvents(errorLog).filter((e) => e.event === "transcription_rejected");
    }

    it("a 400 'corrupted or unsupported' throws AUDIO_REJECTED after exactly one OpenAI call, to gpt-transcribe only", async () => {
        const file = fixtureBytes(MP3_CBR_INFO);
        const { uploads } = serveAudio(file, { contentType: "audio/mpeg", allowWholeFileGet: true, respond: () => reject() });

        const error = await transcribeAudio(MP3_URL, { apiKey: "k" }).catch((e) => e);

        expect(error).toBeInstanceOf(AppError);
        expect((error as AppError).code).toBe(ERROR_CODES.AUDIO_REJECTED);
        expect((error as AppError).message).toBe("gpt-transcribe rejected the audio");
        expect((error as AppError).cause?.message).toBe(CORRUPTED_ERROR);
        expect(uploads).toHaveLength(1);
        expect(uploads.map((u) => u.model)).toEqual(["gpt-transcribe"]);
    });

    it.each([
        ["input_too_large", INPUT_TOO_LARGE_ERROR],
        ["too large for this model", TOO_LARGE_FOR_MODEL_ERROR],
    ])("%s is a rejection too", async (_label, body) => {
        const file = fixtureBytes(MP3_CBR_INFO);
        const { uploads } = serveAudio(file, { contentType: "audio/mpeg", allowWholeFileGet: true, respond: () => reject(body) });

        const error = await transcribeAudio(MP3_URL, { apiKey: "k" }).catch((e) => e);

        expect((error as AppError).code).toBe(ERROR_CODES.AUDIO_REJECTED);
        expect((error as AppError).cause?.message).toBe(body);
        expect(uploads).toHaveLength(1);
    });

    it("a 400 without a rejection phrase stays TRANSCRIPTION_FAILED", async () => {
        const file = fixtureBytes(MP3_CBR_INFO);
        serveAudio(file, {
            contentType: "audio/mpeg",
            allowWholeFileGet: true,
            respond: () => new Response("Invalid language code", { status: 400 }),
        });

        const error = await transcribeAudio(MP3_URL, { apiKey: "k" }).catch((e) => e);

        expect((error as AppError).code).toBe(ERROR_CODES.TRANSCRIPTION_FAILED);
    });

    it("a rejected middle chunk fails the job as AUDIO_REJECTED naming the chunk", async () => {
        const file = fixtureBytes(MP3_CBR_INFO);
        const plan = await mp3Plan(file, THREE_MP3_CHUNKS_SECONDS);
        expect(plan.chunks).toHaveLength(3);
        const { uploads, ranges } = serveAudio(file, {
            contentType: "audio/mpeg",
            respond: (_upload, n) => (n === 2 ? reject() : undefined),
        });

        const error = await transcribeAudio(MP3_URL, chunkedOptions(THREE_MP3_CHUNKS_SECONDS)).catch((e) => e);

        expect(error).toBeInstanceOf(AppError);
        expect((error as AppError).code).toBe(ERROR_CODES.AUDIO_REJECTED);
        expect((error as AppError).message).toBe("gpt-transcribe rejected chunk 2/3 of the audio");
        expect((error as AppError).cause?.message).toBe(CORRUPTED_ERROR);
        // Chunk 3 is never requested: no range fetch for it and no upload.
        expect(uploads).toHaveLength(2);
        expect(ranges).toHaveLength(3); // the probe, then chunks 1 and 2
        const { startByte, endByte } = plan.chunks[2].logFields;
        expect(ranges).not.toContain(`bytes=${startByte}-${endByte}`);
    });

    it("a rejected small tail chunk is still skipped under the #54 rule", async () => {
        const file = fixtureBytes(MOOV_FIRST_M4A);
        const maxSeconds = 3.3;
        const { track, chunks } = await expectedPlan(file, maxSeconds);
        const tail = chunks[chunks.length - 1];
        expect(tail.newPayloadBytes / track.totalPayloadBytes).toBeLessThanOrEqual(0.1);
        const { uploads } = serveAudio(file, { respond: (_upload, n) => (n === chunks.length ? reject() : undefined) });

        const result = await transcribeAudio(AUDIO_URL, chunkedOptions(maxSeconds));

        expect(uploads).toHaveLength(chunks.length);
        expect(result.partial).toBe(true);
        expect(result.partialReason).toMatch(
            new RegExp(`^Final chunk ${chunks.length}/${chunks.length} was rejected by gpt-transcribe \\(`),
        );
        expect(result.partialReason).not.toContain("whisper");
    });

    it("logs transcription_rejected with chunk context (MP3 byte range)", async () => {
        const file = fixtureBytes(MP3_CBR_INFO);
        const plan = await mp3Plan(file, THREE_MP3_CHUNKS_SECONDS);
        const { uploads } = serveAudio(file, {
            contentType: "audio/mpeg",
            respond: (_upload, n) => (n === 2 ? reject() : undefined),
        });
        vi.spyOn(console, "log").mockImplementation(() => {});
        const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});

        await transcribeAudio(`${MP3_URL}?sig=secret`, chunkedOptions(THREE_MP3_CHUNKS_SECONDS)).catch(() => {});

        const events = rejectionEvents(errorLog);
        expect(events).toHaveLength(1);
        const chunk = plan.chunks[1];
        expect(events[0]).toEqual({
            event: "transcription_rejected",
            container: "mp3",
            chunkIndex: 2,
            totalChunks: 3,
            uploadBytes: uploads[1].bytes.length,
            plannedSeconds: chunk.plannedSeconds,
            startByte: chunk.logFields.startByte,
            endByte: chunk.logFields.endByte,
            sizeMB: chunk.logFields.sizeMB,
            firstBytesHex: hex(uploads[1].bytes),
            vbrHeaderDropped: true,
            openAiError: CORRUPTED_ERROR,
            audioHost: "cdn.example.com",
        });
        expect((events[0].firstBytesHex as string).split(" ")).toHaveLength(32);
        const line = JSON.stringify(events[0]);
        expect(line).not.toContain("https://");
        expect(line).not.toContain("sig=");
    });

    it("logs transcription_rejected with the sample range for an MP4 chunk", async () => {
        const file = fixtureBytes(MOOV_FIRST_M4A);
        const maxSeconds = 3.25;
        const { chunks } = await expectedPlan(file, maxSeconds);
        const { uploads } = serveAudio(file, { respond: (_upload, n) => (n === 2 ? reject() : undefined) });
        vi.spyOn(console, "log").mockImplementation(() => {});
        const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});

        await transcribeAudio(AUDIO_URL, chunkedOptions(maxSeconds)).catch(() => {});

        const events = rejectionEvents(errorLog);
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({
            container: "mp4",
            chunkIndex: 2,
            totalChunks: chunks.length,
            uploadBytes: uploads[1].bytes.length,
            plannedSeconds: expect.any(Number),
            firstSample: chunks[1].firstSample,
            endSample: chunks[1].endSample,
            firstBytesHex: hex(uploads[1].bytes),
            vbrHeaderDropped: false,
            openAiError: CORRUPTED_ERROR,
            audioHost: "cdn.example.com",
        });
        expect(events[0]).not.toHaveProperty("wholeFile");
    });

    it("logs transcription_rejected with wholeFile: true for a whole-file upload", async () => {
        const file = fixtureBytes(MP3_CBR_INFO);
        const plan = await mp3Plan(file, MAX_CHUNK_SECONDS);
        expect(plan.chunks).toHaveLength(1);
        const { uploads } = serveAudio(file, { contentType: "audio/mpeg", allowWholeFileGet: true, respond: () => reject() });
        vi.spyOn(console, "log").mockImplementation(() => {});
        const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});

        await transcribeAudio(`${MP3_URL}?sig=secret`, { apiKey: "k" }).catch(() => {});

        const events = rejectionEvents(errorLog);
        expect(events).toHaveLength(1);
        expect(events[0]).toEqual({
            event: "transcription_rejected",
            container: "mp3",
            wholeFile: true,
            uploadBytes: uploads[0].bytes.length,
            plannedSeconds: plan.chunks[0].plannedSeconds,
            startByte: plan.chunks[0].logFields.startByte,
            endByte: plan.chunks[0].logFields.endByte,
            sizeMB: plan.chunks[0].logFields.sizeMB,
            firstBytesHex: hex(uploads[0].bytes),
            vbrHeaderDropped: true,
            openAiError: CORRUPTED_ERROR,
            audioHost: "cdn.example.com",
        });
    });

    it("logs transcription_rejected for a whole-file upload the planner couldn't plan", async () => {
        const file = fixtureBytes(FRAGMENTED_M4A);
        const { uploads } = serveAudio(file, { allowWholeFileGet: true, respond: () => reject() });
        vi.spyOn(console, "log").mockImplementation(() => {});
        const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});

        const error = await transcribeAudio(AUDIO_URL, { apiKey: "k" }).catch((e) => e);

        expect((error as AppError).code).toBe(ERROR_CODES.AUDIO_REJECTED);
        const events = rejectionEvents(errorLog);
        expect(events).toHaveLength(1);
        expect(events[0]).toEqual({
            event: "transcription_rejected",
            container: "mp4",
            wholeFile: true,
            uploadBytes: file.length,
            firstBytesHex: hex(uploads[0].bytes),
            vbrHeaderDropped: false,
            openAiError: CORRUPTED_ERROR,
            audioHost: "cdn.example.com",
        });
    });

    it("result.model is always gpt-transcribe", async () => {
        const file = fixtureBytes(MOOV_FIRST_M4A);
        const maxSeconds = 3.3;
        const { chunks } = await expectedPlan(file, maxSeconds);

        serveAudio(file, { allowWholeFileGet: true });
        const whole = await transcribeAudio(AUDIO_URL, { apiKey: "k" });
        vi.restoreAllMocks();

        serveAudio(file);
        const chunked = await transcribeAudio(AUDIO_URL, chunkedOptions(maxSeconds));
        vi.restoreAllMocks();

        const { uploads } = serveAudio(file, { respond: (_upload, n) => (n === chunks.length ? reject() : undefined) });
        const partial = await transcribeAudio(AUDIO_URL, chunkedOptions(maxSeconds));

        expect([whole.model, chunked.model, partial.model]).toEqual(["gpt-transcribe", "gpt-transcribe", "gpt-transcribe"]);
        expect(partial.partial).toBe(true);
        expect(uploads.every((u) => u.model === "gpt-transcribe")).toBe(true);
    });
});

describe("per-chunk transcript cache (#48)", () => {
    beforeEach(() => {
        vi.restoreAllMocks();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    const MP3_URL = "https://cdn.example.com/episode.mp3";
    /** Splits the 5 s MP3_CBR_INFO fixture into three chunks. */
    const THREE_MP3_CHUNKS_SECONDS = 2.5;

    /** A Map-backed cache; `entries` is the backing store, so tests can seed and inspect it. */
    function fakeCache(entries = new Map<string, { text: string }>()) {
        const cache: ChunkTranscriptCache = {
            get: async (key) => entries.get(key) ?? null,
            put: async (key, value) => {
                entries.set(key, value);
            },
        };
        return { cache, entries };
    }

    /** The plan the remote chunked path makes for MP3_CBR_INFO at `maxSeconds`. */
    async function mp3Plan(maxSeconds = THREE_MP3_CHUNKS_SECONDS) {
        const file = fixtureBytes(MP3_CBR_INFO);
        const plan = await planChunks({
            probe: file,
            fileSize: file.length,
            contentType: "audio/mpeg",
            limits: { maxBytes: 1e9, maxSeconds },
            fetchRange: async (start, end) => file.slice(start, end + 1).buffer,
        });
        return { file, plan };
    }

    const rangeOf = (chunk: { logFields: Record<string, unknown> }) =>
        `bytes=${chunk.logFields.startByte}-${chunk.logFields.endByte}`;

    /** How many inter-chunk sleeps a `setTimeout` spy saw. */
    const chunkSleeps = (timeouts: { mock: { calls: unknown[][] } }) =>
        timeouts.mock.calls.filter(([, ms]) => ms === TIMEOUTS.CHUNK_FETCH_DELAY_MS).length;

    function cachedOptions(cache: ChunkTranscriptCache, maxSeconds = THREE_MP3_CHUNKS_SECONDS) {
        return { ...chunkedOptions(maxSeconds), chunkCache: cache };
    }

    it("builds the key from the plan version, container, file size, chunk index and chunk range", async () => {
        const { plan } = await mp3Plan();
        const chunk = plan.chunks[1];

        expect(chunkCacheKey(plan, chunk)).toBe(
            `${CHUNK_PLAN_VERSION}:mp3:${plan.fileSize}:1:${chunk.cacheId}`,
        );
    });

    it("writes each successful chunk to the cache", async () => {
        const { file, plan } = await mp3Plan();
        expect(plan.chunks).toHaveLength(3);
        serveAudio(file, { contentType: "audio/mpeg" });
        const { cache, entries } = fakeCache();

        const result = await transcribeAudio(MP3_URL, cachedOptions(cache));

        expect(result.text).toBe("chunk 1. chunk 2. chunk 3.");
        expect([...entries]).toEqual(
            plan.chunks.map((chunk, i) => [chunkCacheKey(plan, chunk), { text: `chunk ${i + 1}.` }]),
        );
    });

    it("writes the trimmed text the transcript is stitched from", async () => {
        const { file, plan } = await mp3Plan();
        serveAudio(file, {
            contentType: "audio/mpeg",
            respond: (_upload, n) => new Response(JSON.stringify({ text: `  padded ${n}.\n` }), { status: 200 }),
        });
        const { cache, entries } = fakeCache();

        await transcribeAudio(MP3_URL, cachedOptions(cache));

        expect(entries.get(chunkCacheKey(plan, plan.chunks[0]))).toEqual({ text: "padded 1." });
    });

    it("writes chunks on the small-file path when a short file is chunked for duration", async () => {
        const file = fixtureBytes(MP3_CBR_INFO);
        serveAudio(file, { contentType: "audio/mpeg", allowWholeFileGet: true });
        const { cache, entries } = fakeCache();

        const result = await transcribeAudio("https://example.com/episode.mp3", {
            apiKey: "k",
            chunkLimits: { maxBytes: TARGET_CHUNK_SIZE_BYTES, maxSeconds: 2 },
            chunkCache: cache,
        });

        expect(entries.size).toBeGreaterThan(1);
        expect([...entries.values()].map((v) => v.text).join(" ")).toBe(result.text);
    });

    it("resumes: cached chunks 1–2 skip their range fetch and OpenAI call; chunk 3 runs; text stitched in order", async () => {
        const { file, plan } = await mp3Plan();
        const [first, second, third] = plan.chunks;
        const { cache } = fakeCache(
            new Map([
                [chunkCacheKey(plan, first), { text: "cached one." }],
                [chunkCacheKey(plan, second), { text: "cached two." }],
            ]),
        );
        const { uploads, ranges } = serveAudio(file, { contentType: "audio/mpeg" });
        const timeouts = vi.spyOn(globalThis, "setTimeout");

        const result = await transcribeAudio(MP3_URL, cachedOptions(cache));

        expect(result.text).toBe("cached one. cached two. chunk 1.");
        expect(result.partial).toBeUndefined();
        expect(uploads).toHaveLength(1);
        // The probe, then chunk 3's range only.
        expect(ranges).toEqual([`bytes=0-${file.length - 1}`, rangeOf(third)]);
        // Chunk 3 is the first network fetch, so nothing waits.
        expect(chunkSleeps(timeouts)).toBe(0);
    });

    it("a cached middle chunk skips its sleep; the next fetched chunk still waits", async () => {
        const { file, plan } = await mp3Plan();
        const { cache } = fakeCache(new Map([[chunkCacheKey(plan, plan.chunks[1]), { text: "cached two." }]]));
        const { uploads } = serveAudio(file, { contentType: "audio/mpeg" });
        const timeouts = vi.spyOn(globalThis, "setTimeout");

        const result = await transcribeAudio(MP3_URL, cachedOptions(cache));

        expect(result.text).toBe("chunk 1. cached two. chunk 2.");
        expect(uploads).toHaveLength(2);
        expect(chunkSleeps(timeouts)).toBe(1);
    });

    it("a cached empty transcript is a hit", async () => {
        const { file, plan } = await mp3Plan();
        const { cache } = fakeCache(new Map([[chunkCacheKey(plan, plan.chunks[0]), { text: "" }]]));
        const { uploads } = serveAudio(file, { contentType: "audio/mpeg" });

        await transcribeAudio(MP3_URL, cachedOptions(cache));

        expect(uploads).toHaveLength(2);
    });

    it("a cache entry from a different file size, plan version or range is a miss", async () => {
        const { file, plan } = await mp3Plan();
        const [first, second, third] = plan.chunks;
        const { cache, entries } = fakeCache(
            new Map([
                [chunkCacheKey({ ...plan, fileSize: plan.fileSize + 1 }, first), { text: "stale size." }],
                [`${CHUNK_PLAN_VERSION - 1}:${plan.container}:${plan.fileSize}:${second.index}:${second.cacheId}`, { text: "stale version." }],
                [chunkCacheKey(plan, { ...third, cacheId: "0-1" }), { text: "stale range." }],
            ]),
        );
        const { uploads } = serveAudio(file, { contentType: "audio/mpeg" });

        const result = await transcribeAudio(MP3_URL, cachedOptions(cache));

        expect(result.text).toBe("chunk 1. chunk 2. chunk 3.");
        expect(uploads).toHaveLength(3);
        // The fresh chunks are written alongside the stale entries.
        expect(entries.size).toBe(6);
    });

    it("cache get/put errors are logged and ignored", async () => {
        const { file } = await mp3Plan();
        serveAudio(file, { contentType: "audio/mpeg" });
        const uncached = await transcribeAudio(MP3_URL, chunkedOptions(THREE_MP3_CHUNKS_SECONDS));
        vi.restoreAllMocks();

        const { uploads } = serveAudio(file, { contentType: "audio/mpeg" });
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        const broken: ChunkTranscriptCache = {
            get: async () => {
                throw new Error("KV get exploded");
            },
            put: async () => {
                throw new Error("KV put exploded");
            },
        };

        const result = await transcribeAudio(MP3_URL, cachedOptions(broken));

        expect(result).toEqual(uncached);
        expect(uploads).toHaveLength(3);
        const events = loggedEvents(warn);
        expect(events.filter((e) => e.event === "chunk_cache_read_failed")).toEqual(
            [1, 2, 3].map((chunkIndex) => ({ event: "chunk_cache_read_failed", chunkIndex, error: "KV get exploded" })),
        );
        expect(events.filter((e) => e.event === "chunk_cache_write_failed")).toEqual(
            [1, 2, 3].map((chunkIndex) => ({ event: "chunk_cache_write_failed", chunkIndex, error: "KV put exploded" })),
        );
    });

    it("logs chunk_cache_hit", async () => {
        const { file, plan } = await mp3Plan();
        const { cache } = fakeCache(new Map([[chunkCacheKey(plan, plan.chunks[0]), { text: "cached one." }]]));
        serveAudio(file, { contentType: "audio/mpeg" });
        const log = vi.spyOn(console, "log").mockImplementation(() => {});

        await transcribeAudio(MP3_URL, cachedOptions(cache));

        expect(loggedEvents(log).filter((e) => e.event === "chunk_cache_hit")).toEqual([
            { event: "chunk_cache_hit", chunkIndex: 1, totalChunks: 3 },
        ]);
    });

    it("a rejected chunk is not cached", async () => {
        const { file, plan } = await mp3Plan();
        serveAudio(file, {
            contentType: "audio/mpeg",
            respond: (_upload, n) => (n === 2 ? new Response(CORRUPTED_ERROR, { status: 400 }) : undefined),
        });
        const { cache, entries } = fakeCache();

        const error = await transcribeAudio(MP3_URL, cachedOptions(cache)).catch((e) => e);

        expect((error as AppError).code).toBe(ERROR_CODES.AUDIO_REJECTED);
        expect([...entries.keys()]).toEqual([chunkCacheKey(plan, plan.chunks[0])]);
    });
});
