/**
 * Tests for Transcription Service (OpenAI gpt-4o-mini-transcribe)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
    transcribeAudio,
    validateAudioUrl,
    getProviderConfig,
    extensionFromMime,
    detectAudioFormat,
} from "../src/services/transcription";
import { withRetry, isTransientError, isRateLimitError, isServerError } from "../src/lib/retry";
import { AppError } from "../src/lib/errors";
import { ERROR_CODES } from "../src/lib/constants";

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

describe("transcribeAudio", () => {
    beforeEach(() => {
        vi.restoreAllMocks();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("should transcribe audio under 25MB successfully", async () => {
        const mockAudioBuffer = new ArrayBuffer(1024); // 1KB

        // Mock HEAD request for validation
        vi.spyOn(globalThis, "fetch")
            .mockResolvedValueOnce(
                new Response(null, {
                    status: 200,
                    headers: {
                        "content-length": "1024",
                        "content-type": "audio/mpeg",
                    },
                })
            )
            // Mock redirect resolution (no redirect)
            .mockResolvedValueOnce(new Response(null, { status: 200 }))
            // Mock audio fetch
            .mockResolvedValueOnce(
                new Response(mockAudioBuffer, { status: 200 })
            )
            // Mock Whisper API
            .mockResolvedValueOnce(
                new Response("This is the transcribed text.", { status: 200 })
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
            // Mock redirect resolution (no redirect)
            .mockResolvedValueOnce(new Response(null, { status: 200 }))
            // Header fetch (bytes 0-511) for prepending to non-first chunks
            .mockResolvedValueOnce(
                new Response(new ArrayBuffer(512), { status: 206 })
            )
            // Chunk 1 fetch
            .mockResolvedValueOnce(
                new Response(mockChunkBuffer, { status: 206 })
            )
            // Chunk 1 Whisper transcription
            .mockResolvedValueOnce(
                new Response("This is the first part of the transcript.", { status: 200 })
            )
            // Chunk 2 fetch
            .mockResolvedValueOnce(
                new Response(mockChunkBuffer, { status: 206 })
            )
            // Chunk 2 Whisper transcription
            .mockResolvedValueOnce(
                new Response("And this is the second part.", { status: 200 })
            )
            // Chunk 3 fetch
            .mockResolvedValueOnce(
                new Response(new ArrayBuffer(1024 * 1024), { status: 206 })
            )
            // Chunk 3 Whisper transcription
            .mockResolvedValueOnce(
                new Response("And the third part.", { status: 200 })
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

    it("should return partial transcript when only the trailing chunk fails", async () => {
        // 30MB → 3 chunks. Chunks 1+2 succeed; chunk 3 fails on gpt-4o-mini AND whisper-1 fallback.
        // Expect: no throw, result.partial === true, result.text contains the first two chunks.
        const largeSize = 30 * 1024 * 1024;
        const mockChunkBuffer = new ArrayBuffer(15 * 1024 * 1024);
        const corruptedError = JSON.stringify({
            error: { message: "Audio file might be corrupted or unsupported", type: "invalid_request_error", param: "file", code: "invalid_value" },
        });
        const whisper1Error = JSON.stringify({
            error: { message: "The audio file could not be decoded or its format is not supported.", type: "invalid_request_error", param: null, code: null },
        });

        vi.spyOn(globalThis, "fetch")
            // HEAD validation
            .mockResolvedValueOnce(new Response(null, { status: 200, headers: { "content-length": String(largeSize), "content-type": "audio/mpeg" } }))
            // redirect resolution
            .mockResolvedValueOnce(new Response(null, { status: 200 }))
            // header fetch (512B)
            .mockResolvedValueOnce(new Response(new ArrayBuffer(512), { status: 206 }))
            // chunk 1 fetch + transcribe (success)
            .mockResolvedValueOnce(new Response(mockChunkBuffer, { status: 206 }))
            .mockResolvedValueOnce(new Response("First chunk transcript.", { status: 200 }))
            // chunk 2 fetch + transcribe (success)
            .mockResolvedValueOnce(new Response(mockChunkBuffer, { status: 206 }))
            .mockResolvedValueOnce(new Response("Second chunk transcript.", { status: 200 }))
            // chunk 3 (tail) fetch — succeeds at the byte level
            .mockResolvedValueOnce(new Response(new ArrayBuffer(1024 * 1024), { status: 206 }))
            // chunk 3 gpt-4o-mini-transcribe → 400 corrupted (triggers fallback)
            .mockResolvedValueOnce(new Response(corruptedError, { status: 400 }))
            // chunk 3 whisper-1 fallback → 400 also (no retry on non-transient)
            .mockResolvedValueOnce(new Response(whisper1Error, { status: 400 }));

        const result = await transcribeAudio(
            "https://example.com/large.mp3",
            "test-api-key"
        );

        expect(result.source).toBe("openai");
        expect(result.partial).toBe(true);
        expect(result.partialReason).toContain("Final chunk 3/3");
        expect(result.partialReason).toContain("whisper-1");
        expect(result.text).toContain("First chunk");
        expect(result.text).toContain("Second chunk");
    });

    it("should throw TRANSCRIPTION_FAILED on Whisper API error", async () => {
        const mockAudioBuffer = new ArrayBuffer(1024);

        vi.spyOn(globalThis, "fetch")
            .mockResolvedValueOnce(
                new Response(null, {
                    status: 200,
                    headers: {
                        "content-length": "1024",
                        "content-type": "audio/mpeg",
                    },
                })
            )
            // Mock redirect resolution (no redirect)
            .mockResolvedValueOnce(new Response(null, { status: 200 }))
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
            .mockResolvedValueOnce(
                new Response(null, {
                    status: 200,
                    headers: {
                        "content-length": "1024",
                        "content-type": "audio/mpeg",
                    },
                })
            )
            // Mock redirect resolution (no redirect)
            .mockResolvedValueOnce(new Response(null, { status: 200 }))
            .mockResolvedValueOnce(
                new Response(mockAudioBuffer, { status: 200 })
            )
            // First Whisper call: rate limited
            .mockResolvedValueOnce(
                new Response("Rate limited", { status: 429 })
            )
            // Retry: success
            .mockResolvedValueOnce(
                new Response("Transcribed text after retry.", { status: 200 })
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
            .mockResolvedValueOnce(
                new Response(null, {
                    status: 200,
                    headers: {
                        "content-length": "1024",
                        "content-type": "audio/mpeg",
                    },
                })
            )
            // Mock redirect resolution (no redirect)
            .mockResolvedValueOnce(new Response(null, { status: 200 }))
            .mockResolvedValueOnce(
                new Response(mockAudioBuffer, { status: 200 })
            )
            // First Whisper call: server error
            .mockResolvedValueOnce(
                new Response("Server error", { status: 500 })
            )
            // Retry: success
            .mockResolvedValueOnce(
                new Response("Transcribed after server error.", { status: 200 })
            );

        const result = await transcribeAudio(
            "https://example.com/audio.mp3",
            "test-api-key"
        );

        expect(result.text).toBe("Transcribed after server error.");
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
        expect(config.model).toBe("gpt-4o-mini-transcribe");
    });

    it("should return OpenAI config for undefined provider", () => {
        const config = getProviderConfig(undefined);
        expect(config.name).toBe("openai");
    });

    it("should return OpenAI config for 'openai' provider", () => {
        const config = getProviderConfig("openai");
        expect(config.name).toBe("openai");
        expect(config.model).toBe("gpt-4o-mini-transcribe");
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
            .mockResolvedValueOnce(
                new Response(null, {
                    status: 200,
                    headers: {
                        "content-length": "1024",
                        "content-type": "audio/mpeg",
                    },
                })
            )
            // Mock redirect resolution (no redirect)
            .mockResolvedValueOnce(new Response(null, { status: 200 }))
            .mockResolvedValueOnce(
                new Response(mockAudioBuffer, { status: 200 })
            )
            .mockResolvedValueOnce(
                new Response("OpenAI transcription.", { status: 200 })
            );

        const result = await transcribeAudio(
            "https://example.com/audio.mp3",
            { apiKey: "openai-key", provider: "openai" }
        );

        expect(result.text).toBe("OpenAI transcription.");
        expect(result.source).toBe("openai");

        // Verify the Whisper API was called with OpenAI URL
        const whisperCall = fetchSpy.mock.calls[3];
        expect(whisperCall[0]).toBe("https://api.openai.com/v1/audio/transcriptions");
    });

    it("should default to OpenAI when provider is not specified in options", async () => {
        const mockAudioBuffer = new ArrayBuffer(1024);

        const fetchSpy = vi.spyOn(globalThis, "fetch")
            .mockResolvedValueOnce(
                new Response(null, {
                    status: 200,
                    headers: {
                        "content-length": "1024",
                        "content-type": "audio/mpeg",
                    },
                })
            )
            // Mock redirect resolution (no redirect)
            .mockResolvedValueOnce(new Response(null, { status: 200 }))
            .mockResolvedValueOnce(
                new Response(mockAudioBuffer, { status: 200 })
            )
            .mockResolvedValueOnce(
                new Response("Default provider transcription.", { status: 200 })
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
            .mockResolvedValueOnce(
                new Response(null, {
                    status: 200,
                    headers: {
                        "content-length": "1024",
                        "content-type": "audio/mpeg",
                    },
                })
            )
            // Mock redirect resolution (no redirect)
            .mockResolvedValueOnce(new Response(null, { status: 200 }))
            .mockResolvedValueOnce(
                new Response(mockAudioBuffer, { status: 200 })
            )
            .mockResolvedValueOnce(
                new Response("Legacy call transcription.", { status: 200 })
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
