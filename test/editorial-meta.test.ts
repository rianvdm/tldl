/**
 * Tests for the Editorial Meta service (OpenAI Responses API)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { generateEditorialMeta } from "../src/services/editorial-meta";
import { AppError } from "../src/lib/errors";

const META = { deck: "A deck sentence.", pullQuote: "A quotable line." };

describe("generateEditorialMeta", () => {
    beforeEach(() => {
        vi.restoreAllMocks();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("parses the deck and pull quote from a message-only response", async () => {
        vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
            new Response(
                JSON.stringify({
                    id: "resp_123",
                    model: "gpt-5.6-terra",
                    output: [
                        {
                            type: "message",
                            content: [{ type: "output_text", text: JSON.stringify(META) }],
                        },
                    ],
                }),
                { status: 200 }
            )
        );

        await expect(generateEditorialMeta("transcript", "test-key")).resolves.toEqual(META);
    });

    it("parses the deck and pull quote when a reasoning item precedes the message", async () => {
        // gpt-5.6-terra emits output = ["reasoning", "message"] when it thinks.
        vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
            new Response(
                JSON.stringify({
                    id: "resp_123",
                    model: "gpt-5.6-terra",
                    output: [
                        { type: "reasoning", summary: [], content: [] },
                        {
                            type: "message",
                            content: [{ type: "output_text", text: JSON.stringify(META) }],
                        },
                    ],
                }),
                { status: 200 }
            )
        );

        await expect(generateEditorialMeta("transcript", "test-key")).resolves.toEqual(META);
    });

    it("throws when the response carries no text output", async () => {
        vi.spyOn(globalThis, "fetch").mockResolvedValue(
            new Response(
                JSON.stringify({
                    id: "resp_123",
                    model: "gpt-5.6-terra",
                    output: [{ type: "reasoning", summary: [], content: [] }],
                }),
                { status: 200 }
            )
        );

        await expect(generateEditorialMeta("transcript", "test-key")).rejects.toBeInstanceOf(
            AppError
        );
    });
});
