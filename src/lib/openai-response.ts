/**
 * Shared helpers for the OpenAI Responses API envelope.
 *
 * The assistant message is NOT reliably `output[0]`. Reasoning-capable models
 * (the gpt-5.6 tier family) emit a `reasoning` item ahead of the message when
 * they think, so `output` is `["reasoning", "message"]`. Whether the reasoning
 * item appears varies per request, so indexing `output[0]` fails intermittently.
 * Always search the array by item type.
 */

/**
 * Minimal shape of a Responses API payload. Item types beyond `message` (e.g.
 * `reasoning`) carry other fields we don't read, hence the permissive typing.
 */
export interface ResponsesApiEnvelope {
    output?: Array<{
        type?: string;
        content?: Array<{
            type?: string;
            text?: string;
        }>;
    }>;
}

/**
 * Extract the assistant's text from a Responses API payload.
 *
 * @returns The first `output_text` of the first `message` item, or null when
 *          the payload carries no usable text (empty output, reasoning only,
 *          a refusal, or an empty string).
 */
export function extractOutputText(data: ResponsesApiEnvelope): string | null {
    try {
        const message = data.output?.find((item) => item?.type === "message");
        if (!message) {
            return null;
        }

        const content = message.content?.find((part) => part?.type === "output_text");

        return content?.text || null;
    } catch {
        return null;
    }
}
