/**
 * Tests for Summarization Service (GPT-5.2 Responses API)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { generateSummary } from "../src/services/summarization";
import { AppError } from "../src/lib/errors";
import { ERROR_CODES } from "../src/lib/constants";

/**
 * Helper to create a mock Responses API response
 */
function createMockResponse(text: string, model = "gpt-5.2"): object {
    return {
        id: "resp_123",
        model,
        output: [
            {
                type: "message",
                content: [
                    {
                        type: "output_text",
                        text,
                    },
                ],
            },
        ],
    };
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
            vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
                new Response(JSON.stringify(createMockResponse(mockSummary)), {
                    status: 200,
                })
            );

            const result = await generateSummary(
                "This is a test transcript about productivity.",
                "key-takeaways",
                "test-api-key"
            );

            expect(result.text).toBe(mockSummary);
            expect(result.model).toBe("gpt-5.2");
        });

        it("should generate summary with narrative-summary template", async () => {
            const mockSummary = "The episode tells the story of...";
            vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
                new Response(JSON.stringify(createMockResponse(mockSummary)), {
                    status: 200,
                })
            );

            const result = await generateSummary(
                "This is a narrative transcript.",
                "narrative-summary",
                "test-api-key"
            );

            expect(result.text).toBe(mockSummary);
        });

        it("should generate summary with eli5 template", async () => {
            const mockSummary = "Imagine you have a big box of toys...";
            vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
                new Response(JSON.stringify(createMockResponse(mockSummary)), {
                    status: 200,
                })
            );

            const result = await generateSummary(
                "Complex technical discussion about quantum computing.",
                "eli5",
                "test-api-key"
            );

            expect(result.text).toBe(mockSummary);
        });

        it("should send correct request format to Responses API", async () => {
            const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
                new Response(JSON.stringify(createMockResponse("Summary")), {
                    status: 200,
                })
            );

            await generateSummary("Test transcript", "key-takeaways", "test-key");

            expect(fetchSpy).toHaveBeenCalledTimes(1);
            const [url, options] = fetchSpy.mock.calls[0];
            expect(url).toBe("https://api.openai.com/v1/responses");
            expect(options?.method).toBe("POST");
            expect(options?.headers).toEqual({
                Authorization: "Bearer test-key",
                "Content-Type": "application/json",
            });

            const body = JSON.parse(options?.body as string);
            expect(body.model).toBe("gpt-5.4");
            expect(body.input).toBe("Test transcript");
            expect(body.instructions).toContain("Analyze this podcast transcript");
        });
    });

    describe("invalid template handling", () => {
        it("should throw INVALID_TEMPLATE for unknown template ID", async () => {
            try {
                await generateSummary(
                    "Test transcript",
                    "invalid-template",
                    "test-api-key"
                );
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
        it("should throw RATE_LIMITED on 429 response", async () => {
            vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
                new Response("Rate limit exceeded", { status: 429 })
            );

            try {
                await generateSummary(
                    "Test transcript",
                    "key-takeaways",
                    "test-api-key"
                );
                expect.fail("Expected error");
            } catch (error) {
                expect(error).toBeInstanceOf(AppError);
                expect((error as AppError).code).toBe(ERROR_CODES.RATE_LIMITED);
            }
        });
    });

    describe("server error handling with retry", () => {
        it("should retry on 500 error and succeed", async () => {
            const mockSummary = "Summary after retry";
            vi.spyOn(globalThis, "fetch")
                // First call: server error
                .mockResolvedValueOnce(
                    new Response("Internal server error", { status: 500 })
                )
                // Retry: success
                .mockResolvedValueOnce(
                    new Response(JSON.stringify(createMockResponse(mockSummary)), {
                        status: 200,
                    })
                );

            const result = await generateSummary(
                "Test transcript",
                "key-takeaways",
                "test-api-key"
            );

            expect(result.text).toBe(mockSummary);
        });

        it("should retry on 503 error and succeed", async () => {
            const mockSummary = "Summary after 503";
            vi.spyOn(globalThis, "fetch")
                .mockResolvedValueOnce(
                    new Response("Service unavailable", { status: 503 })
                )
                .mockResolvedValueOnce(
                    new Response(JSON.stringify(createMockResponse(mockSummary)), {
                        status: 200,
                    })
                );

            const result = await generateSummary(
                "Test transcript",
                "key-takeaways",
                "test-api-key"
            );

            expect(result.text).toBe(mockSummary);
        });
    });

    describe("client error handling", () => {
        it("should throw SUMMARIZATION_FAILED on 400 error", async () => {
            vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
                new Response("Bad request", { status: 400 })
            );

            try {
                await generateSummary(
                    "Test transcript",
                    "key-takeaways",
                    "test-api-key"
                );
                expect.fail("Expected error");
            } catch (error) {
                expect(error).toBeInstanceOf(AppError);
                expect((error as AppError).code).toBe(ERROR_CODES.SUMMARIZATION_FAILED);
                expect((error as AppError).message).toContain("400");
            }
        });

        it("should throw SUMMARIZATION_FAILED on 401 error", async () => {
            vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
                new Response("Unauthorized", { status: 401 })
            );

            try {
                await generateSummary(
                    "Test transcript",
                    "key-takeaways",
                    "test-api-key"
                );
                expect.fail("Expected error");
            } catch (error) {
                expect(error).toBeInstanceOf(AppError);
                expect((error as AppError).code).toBe(ERROR_CODES.SUMMARIZATION_FAILED);
            }
        });
    });

    describe("response parsing", () => {
        it("should handle malformed JSON response", async () => {
            vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
                new Response("not valid json", { status: 200 })
            );

            try {
                await generateSummary(
                    "Test transcript",
                    "key-takeaways",
                    "test-api-key"
                );
                expect.fail("Expected error");
            } catch (error) {
                expect(error).toBeInstanceOf(AppError);
                expect((error as AppError).code).toBe(ERROR_CODES.SUMMARIZATION_FAILED);
                expect((error as AppError).message).toContain("parse");
            }
        });

        it("should handle empty output array", async () => {
            vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
                new Response(
                    JSON.stringify({
                        id: "resp_123",
                        model: "gpt-5.2",
                        output: [],
                    }),
                    { status: 200 }
                )
            );

            try {
                await generateSummary(
                    "Test transcript",
                    "key-takeaways",
                    "test-api-key"
                );
                expect.fail("Expected error");
            } catch (error) {
                expect(error).toBeInstanceOf(AppError);
                expect((error as AppError).code).toBe(ERROR_CODES.SUMMARIZATION_FAILED);
                expect((error as AppError).message).toContain("empty or malformed");
            }
        });

        it("should handle missing content in output", async () => {
            vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
                new Response(
                    JSON.stringify({
                        id: "resp_123",
                        model: "gpt-5.2",
                        output: [{ type: "message", content: [] }],
                    }),
                    { status: 200 }
                )
            );

            try {
                await generateSummary(
                    "Test transcript",
                    "key-takeaways",
                    "test-api-key"
                );
                expect.fail("Expected error");
            } catch (error) {
                expect(error).toBeInstanceOf(AppError);
                expect((error as AppError).code).toBe(ERROR_CODES.SUMMARIZATION_FAILED);
            }
        });

        it("should handle API-level error in response body", async () => {
            vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
                new Response(
                    JSON.stringify({
                        error: {
                            message: "Context length exceeded",
                            type: "invalid_request_error",
                            code: "context_length_exceeded",
                        },
                    }),
                    { status: 200 }
                )
            );

            try {
                await generateSummary(
                    "Very long transcript...",
                    "key-takeaways",
                    "test-api-key"
                );
                expect.fail("Expected error");
            } catch (error) {
                expect(error).toBeInstanceOf(AppError);
                expect((error as AppError).code).toBe(ERROR_CODES.SUMMARIZATION_FAILED);
                expect((error as AppError).message).toContain("Context length exceeded");
            }
        });
    });

    describe("network errors", () => {
        it("should handle network failure", async () => {
            vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(
                new Error("Network error")
            );

            try {
                await generateSummary(
                    "Test transcript",
                    "key-takeaways",
                    "test-api-key"
                );
                expect.fail("Expected error");
            } catch (error) {
                expect(error).toBeInstanceOf(AppError);
                expect((error as AppError).code).toBe(ERROR_CODES.SUMMARIZATION_FAILED);
                expect((error as AppError).message).toContain("connect");
            }
        });
    });
});
