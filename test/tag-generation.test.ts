/**
 * Tests for Tag Generation Service (OpenAI Responses API)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { generateEpisodeTags } from "../src/services/tag-generation";

/**
 * Helper to create a mock Responses API response
 */
function createMockResponse(text: string, model = "gpt-5.6-luna"): object {
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

describe("generateEpisodeTags", () => {
    beforeEach(() => {
        vi.restoreAllMocks();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("should return tags when a reasoning item precedes the message", async () => {
        // gpt-5.6-luna emits output = ["reasoning", "message"] when it thinks.
        // Indexing output[0] silently yielded zero tags on every episode.
        vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
            new Response(
                JSON.stringify({
                    id: "resp_123",
                    model: "gpt-5.6-luna",
                    output: [
                        { type: "reasoning", summary: [], content: [] },
                        {
                            type: "message",
                            content: [{ type: "output_text", text: "ai, product" }],
                        },
                    ],
                }),
                { status: 200 }
            )
        );

        const result = await generateEpisodeTags(
            "A summary about AI and product management.",
            undefined,
            "test-api-key"
        );

        expect(result.tags).toEqual(["ai", "product"]);
    });

    it("should send correct request format and model to Responses API", async () => {
        const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
            new Response(JSON.stringify(createMockResponse("ai, product")), {
                status: 200,
            })
        );

        const result = await generateEpisodeTags(
            "A summary about AI product management.",
            "Transcript excerpt.",
            "test-key"
        );

        expect(fetchSpy).toHaveBeenCalledTimes(1);
        const [url, options] = fetchSpy.mock.calls[0];
        expect(url).toBe("https://api.openai.com/v1/responses");

        const body = JSON.parse((options as RequestInit).body as string);
        expect(body.model).toBe("gpt-5.6-luna");
        expect(body.input).toContain("SUMMARY:");
        expect(body.input).toContain("TRANSCRIPT (excerpt):");

        expect(result.tags).toEqual(["ai", "product"]);
    });
});
