/**
 * Tests for Summarization Service (Anthropic Messages API, claude-opus-5-5)
 *
 * The SDK is exercised for real; only the network is mocked by spying on
 * globalThis.fetch, which the client resolves at construction time.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { generateSummary } from "../src/services/summarization";
import { AppError } from "../src/lib/errors";
import { ERROR_CODES } from "../src/lib/constants";

interface MockMessageOptions {
    model?: string;
    stopReason?: string;
    stopDetails?: { type: "refusal"; category: string | null; explanation?: string };
    content?: unknown[];
}

/**
 * Build a Messages API response body. `content` defaults to a single text
 * block; pass it explicitly to model thinking blocks or empty output.
 */
function createMockMessage(text: string, options: MockMessageOptions = {}): object {
    return {
        id: "msg_123",
        type: "message",
        role: "assistant",
        model: options.model ?? "claude-opus-5-5",
        content: options.content ?? [{ type: "text", text }],
        stop_reason: options.stopReason ?? "end_turn",
        stop_sequence: null,
        stop_details: options.stopDetails ?? null,
        usage: { input_tokens: 1000, output_tokens: 800 },
    };
}

function jsonResponse(body: object, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
    });
}

describe("generateSummary", () => {
    beforeEach(() => {
        vi.restoreAllMocks();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    describe("successful generation", () => {
        it("should generate summary with key-takeaways template", async () => {
            const mockSummary = "## Key Takeaways\n\n1. First insight\n2. Second insight";
            vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(jsonResponse(createMockMessage(mockSummary)));

            const result = await generateSummary(
                "This is a test transcript about productivity.",
                "key-takeaways",
                "test-api-key"
            );

            expect(result.text).toBe(mockSummary);
            expect(result.model).toBe("claude-opus-5-5");
        });

        it("should ignore thinking blocks and join multiple text blocks", async () => {
            // Adaptive thinking is always on for Opus 5.5; the thinking block
            // precedes the text and must never leak into the summary.
            vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
                jsonResponse(
                    createMockMessage("", {
                        content: [
                            { type: "thinking", thinking: "", signature: "sig" },
                            { type: "text", text: "## Overview\n\nPart one." },
                            { type: "text", text: "\n\nPart two." },
                        ],
                    })
                )
            );

            const result = await generateSummary("Transcript", "key-takeaways", "test-api-key");

            expect(result.text).toBe("## Overview\n\nPart one.\n\nPart two.");
        });

        it("should report the model that actually served the request", async () => {
            // A server-side fallback answers with a different model; the stored
            // Summary.model must say so.
            vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
                jsonResponse(createMockMessage("Summary", { model: "claude-opus-4-8" }))
            );

            const result = await generateSummary("Transcript", "key-takeaways", "test-api-key");

            expect(result.model).toBe("claude-opus-4-8");
        });

        it("should generate summary with narrative-summary template", async () => {
            const mockSummary = "The episode tells the story of...";
            vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(jsonResponse(createMockMessage(mockSummary)));

            const result = await generateSummary("This is a narrative transcript.", "narrative-summary", "test-api-key");

            expect(result.text).toBe(mockSummary);
        });

        it("should generate summary with eli5 template", async () => {
            const mockSummary = "Imagine you have a big box of toys...";
            vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(jsonResponse(createMockMessage(mockSummary)));

            const result = await generateSummary(
                "Complex technical discussion about quantum computing.",
                "eli5",
                "test-api-key"
            );

            expect(result.text).toBe(mockSummary);
        });

        it("should send the production request shape to the Messages API", async () => {
            const fetchSpy = vi
                .spyOn(globalThis, "fetch")
                .mockResolvedValueOnce(jsonResponse(createMockMessage("Summary")));

            await generateSummary("Test transcript", "key-takeaways", "test-key");

            expect(fetchSpy).toHaveBeenCalledTimes(1);
            const [url, options] = fetchSpy.mock.calls[0];
            expect(String(url)).toBe("https://api.anthropic.com/v1/messages");
            expect(options?.method).toBe("POST");

            const headers = new Headers(options?.headers as HeadersInit);
            expect(headers.get("authorization")).toBe("Bearer test-key");
            expect(headers.get("anthropic-beta")).toContain("server-side-fallback-2026-07-01");

            const body = JSON.parse(options?.body as string);
            expect(body.model).toBe("claude-opus-5-5");
            expect(body.output_config).toEqual({ effort: "medium" });
            expect(body.fallbacks).toBe("default");
            expect(body.system).toContain("Analyze this podcast transcript");
            expect(body.messages).toEqual([{ role: "user", content: "Test transcript" }]);
            expect(body.max_tokens).toBeGreaterThanOrEqual(8000);
        });
    });

    describe("invalid template handling", () => {
        it("should throw INVALID_TEMPLATE for unknown template ID", async () => {
            try {
                await generateSummary("Test transcript", "invalid-template", "test-api-key");
                expect.fail("Expected error");
            } catch (error) {
                expect(error).toBeInstanceOf(AppError);
                expect((error as AppError).code).toBe(ERROR_CODES.INVALID_TEMPLATE);
                expect((error as AppError).message).toContain("invalid-template");
            }
        });

        it("should throw INVALID_TEMPLATE for empty template ID", async () => {
            try {
                await generateSummary("Test transcript", "", "test-api-key");
                expect.fail("Expected error");
            } catch (error) {
                expect(error).toBeInstanceOf(AppError);
                expect((error as AppError).code).toBe(ERROR_CODES.INVALID_TEMPLATE);
            }
        });
    });

    describe("rate limiting", () => {
        it("should throw RATE_LIMITED on 429 response without retrying", async () => {
            const fetchSpy = vi
                .spyOn(globalThis, "fetch")
                .mockResolvedValueOnce(new Response("Rate limit exceeded", { status: 429 }));

            try {
                await generateSummary("Test transcript", "key-takeaways", "test-api-key");
                expect.fail("Expected error");
            } catch (error) {
                expect(error).toBeInstanceOf(AppError);
                expect((error as AppError).code).toBe(ERROR_CODES.RATE_LIMITED);
            }
            expect(fetchSpy).toHaveBeenCalledTimes(1);
        });
    });

    describe("server error handling with retry", () => {
        it("should retry on 500 error and succeed", async () => {
            const mockSummary = "Summary after retry";
            vi.spyOn(globalThis, "fetch")
                .mockResolvedValueOnce(new Response("Internal server error", { status: 500 }))
                .mockResolvedValueOnce(jsonResponse(createMockMessage(mockSummary)));

            const result = await generateSummary("Test transcript", "key-takeaways", "test-api-key");

            expect(result.text).toBe(mockSummary);
        });

        it("should retry on 529 overloaded and succeed", async () => {
            const mockSummary = "Summary after 529";
            vi.spyOn(globalThis, "fetch")
                .mockResolvedValueOnce(
                    jsonResponse({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } }, 529)
                )
                .mockResolvedValueOnce(jsonResponse(createMockMessage(mockSummary)));

            const result = await generateSummary("Test transcript", "key-takeaways", "test-api-key");

            expect(result.text).toBe(mockSummary);
        });
    });

    describe("client error handling", () => {
        it("should throw SUMMARIZATION_FAILED on 400 error", async () => {
            vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
                jsonResponse({ type: "error", error: { type: "invalid_request_error", message: "Bad request" } }, 400)
            );

            try {
                await generateSummary("Test transcript", "key-takeaways", "test-api-key");
                expect.fail("Expected error");
            } catch (error) {
                expect(error).toBeInstanceOf(AppError);
                expect((error as AppError).code).toBe(ERROR_CODES.SUMMARIZATION_FAILED);
                expect((error as AppError).message).toContain("400");
                expect((error as AppError).message).toContain("Bad request");
            }
        });

        it("should throw SUMMARIZATION_FAILED on 401 error", async () => {
            vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response("Unauthorized", { status: 401 }));

            try {
                await generateSummary("Test transcript", "key-takeaways", "test-api-key");
                expect.fail("Expected error");
            } catch (error) {
                expect(error).toBeInstanceOf(AppError);
                expect((error as AppError).code).toBe(ERROR_CODES.SUMMARIZATION_FAILED);
            }
        });
    });

    describe("response handling", () => {
        it("should throw SUMMARIZATION_FAILED on a refusal", async () => {
            vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
                jsonResponse(
                    createMockMessage("", {
                        content: [],
                        stopReason: "refusal",
                        stopDetails: { type: "refusal", category: "cyber" },
                    })
                )
            );

            try {
                await generateSummary("Test transcript", "key-takeaways", "test-api-key");
                expect.fail("Expected error");
            } catch (error) {
                expect(error).toBeInstanceOf(AppError);
                expect((error as AppError).code).toBe(ERROR_CODES.SUMMARIZATION_FAILED);
                expect((error as AppError).message).toContain("refused");
                expect((error as AppError).message).toContain("cyber");
            }
        });

        it("should throw SUMMARIZATION_FAILED when output is cut off at max_tokens", async () => {
            vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
                jsonResponse(createMockMessage("## Overview\n\nTruncated mid-", { stopReason: "max_tokens" }))
            );

            try {
                await generateSummary("Test transcript", "key-takeaways", "test-api-key");
                expect.fail("Expected error");
            } catch (error) {
                expect(error).toBeInstanceOf(AppError);
                expect((error as AppError).code).toBe(ERROR_CODES.SUMMARIZATION_FAILED);
                expect((error as AppError).message).toContain("max_tokens");
            }
        });

        it("should throw SUMMARIZATION_FAILED on empty content", async () => {
            vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(jsonResponse(createMockMessage("", { content: [] })));

            try {
                await generateSummary("Test transcript", "key-takeaways", "test-api-key");
                expect.fail("Expected error");
            } catch (error) {
                expect(error).toBeInstanceOf(AppError);
                expect((error as AppError).code).toBe(ERROR_CODES.SUMMARIZATION_FAILED);
                expect((error as AppError).message).toContain("empty");
            }
        });

        it("should throw SUMMARIZATION_FAILED on whitespace-only text", async () => {
            vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(jsonResponse(createMockMessage("   \n  ")));

            try {
                await generateSummary("Test transcript", "key-takeaways", "test-api-key");
                expect.fail("Expected error");
            } catch (error) {
                expect(error).toBeInstanceOf(AppError);
                expect((error as AppError).code).toBe(ERROR_CODES.SUMMARIZATION_FAILED);
            }
        });
    });

    describe("network errors", () => {
        it("should handle network failure", async () => {
            vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("Network error"));

            try {
                await generateSummary("Test transcript", "key-takeaways", "test-api-key");
                expect.fail("Expected error");
            } catch (error) {
                expect(error).toBeInstanceOf(AppError);
                expect((error as AppError).code).toBe(ERROR_CODES.SUMMARIZATION_FAILED);
                expect((error as AppError).message).toContain("connect");
            }
        });
    });
});
