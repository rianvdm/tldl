/**
 * Tests for the shared OpenAI Responses API text extractor.
 *
 * Reasoning-capable models (the gpt-5.6 tier family) emit a `reasoning` item
 * ahead of the assistant message, so the message is not always `output[0]`.
 */

import { describe, it, expect } from "vitest";
import { extractOutputText } from "../src/lib/openai-response";

describe("extractOutputText", () => {
    it("extracts text when the message is the only output item", () => {
        const data = {
            output: [
                { type: "message", content: [{ type: "output_text", text: "hello" }] },
            ],
        };

        expect(extractOutputText(data)).toBe("hello");
    });

    it("extracts text when a reasoning item precedes the message", () => {
        // Real gpt-5.6-terra shape: output = ["reasoning", "message"]
        const data = {
            output: [
                { type: "reasoning", summary: [], content: [] },
                { type: "message", content: [{ type: "output_text", text: "hello" }] },
            ],
        };

        expect(extractOutputText(data)).toBe("hello");
    });

    it("skips leading non-output_text content within the message", () => {
        const data = {
            output: [
                {
                    type: "message",
                    content: [
                        { type: "reasoning_text", text: "thinking" },
                        { type: "output_text", text: "hello" },
                    ],
                },
            ],
        };

        expect(extractOutputText(data)).toBe("hello");
    });

    it("returns null when output is empty", () => {
        expect(extractOutputText({ output: [] })).toBeNull();
    });

    it("returns null when output is missing", () => {
        expect(extractOutputText({})).toBeNull();
    });

    it("returns null when no message item is present", () => {
        const data = { output: [{ type: "reasoning", content: [] }] };

        expect(extractOutputText(data)).toBeNull();
    });

    it("returns null when the message has no content", () => {
        const data = { output: [{ type: "message", content: [] }] };

        expect(extractOutputText(data)).toBeNull();
    });

    it("returns null when the message carries only a refusal", () => {
        const data = {
            output: [
                {
                    type: "message",
                    content: [{ type: "refusal", refusal: "I can't help with that" }],
                },
            ],
        };

        expect(extractOutputText(data)).toBeNull();
    });

    it("returns null when the output_text is an empty string", () => {
        const data = {
            output: [{ type: "message", content: [{ type: "output_text", text: "" }] }],
        };

        expect(extractOutputText(data)).toBeNull();
    });
});
