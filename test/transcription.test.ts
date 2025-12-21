/**
 * Tests for Transcription Service (OpenAI Whisper API)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
    transcribeAudio,
    validateAudioUrl,
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
        const largeSize = 30 * 1024 * 1024; // 30MB - will be split into 2 chunks
        const mockAudioBuffer = new ArrayBuffer(20 * 1024 * 1024); // Mock chunk size

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
            // Header fetch (bytes 0-511) for prepending to non-first chunks
            .mockResolvedValueOnce(
                new Response(new ArrayBuffer(512), { status: 206 })
            )
            // First chunk fetch (Range request)
            .mockResolvedValueOnce(
                new Response(mockAudioBuffer, { status: 206 })
            )
            // First chunk Whisper transcription
            .mockResolvedValueOnce(
                new Response("This is the first part of the transcript.", { status: 200 })
            )
            // Second chunk fetch
            .mockResolvedValueOnce(
                new Response(mockAudioBuffer, { status: 206 })
            )
            // Second chunk Whisper transcription
            .mockResolvedValueOnce(
                new Response("And this is the second part.", { status: 200 })
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
