/**
 * Editorial Meta Service — produces the 1-2 sentence deck and one-sentence
 * pull quote used in the Broadsheet design. Called once per episode during
 * ingest, stored on the Episode KV record.
 */

import { AppError } from "../lib/errors";
import { ERROR_CODES } from "../lib/constants";
import { withRetry, isServerError } from "../lib/retry";
import { extractOutputText } from "../lib/openai-response";

export interface EditorialMeta {
    deck: string;
    pullQuote: string;
}

interface ResponsesApiResponse {
    id: string;
    model: string;
    output: Array<{
        type: string;
        content: Array<{
            type: string;
            text: string;
        }>;
    }>;
    error?: {
        message: string;
        type: string;
        code: string;
    };
}

const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
const MODEL = "gpt-5.6-terra";

const PROMPT = `You are writing for a weekly newspaper that summarizes podcast episodes.

Given the transcript below, produce two pieces of copy:

1. "deck": a 1-2 sentence descriptive deck in the voice of a print weekly.
   Complete sentences. Sentence case. No ellipses. No phrases like "In this
   episode" or "This episode explores". Describe what the conversation is
   about, not what it promises.

2. "pullQuote": a single aphoristic sentence taken or lightly condensed from
   the transcript. The kind of line a reader would screenshot. One sentence,
   ideally between 20 and 30 words — never fewer than 20. If no single
   sentence in the transcript hits that range, lightly stitch a clause from
   the same speaker turn rather than dropping below the floor. No ellipses.
   Prefer the speaker's voice over paraphrase.

Respond with strict JSON matching the shape:
{ "deck": string, "pullQuote": string }

No prose, no code fences, JSON only.`;

export function parseEditorialMeta(raw: string): EditorialMeta | null {
    let data: unknown;
    try {
        data = JSON.parse(raw.trim());
    } catch {
        return null;
    }
    if (!data || typeof data !== "object") return null;
    const obj = data as Record<string, unknown>;
    if (typeof obj.deck !== "string" || typeof obj.pullQuote !== "string") return null;
    const deck = obj.deck.trim().replace(/\.{3,}$/, "");
    const pullQuote = obj.pullQuote.trim().replace(/\.{3,}$/, "");
    if (!deck || !pullQuote) return null;
    return { deck, pullQuote };
}

export async function generateEditorialMeta(
    transcript: string,
    openaiApiKey: string
): Promise<EditorialMeta> {
    const result = await withRetry(
        () => callApi(transcript, openaiApiKey),
        { maxRetries: 3, baseDelayMs: 1000, shouldRetry: isServerError }
    );
    return result;
}

async function callApi(transcript: string, apiKey: string): Promise<EditorialMeta> {
    let response: Response;

    try {
        response = await fetch(OPENAI_RESPONSES_URL, {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${apiKey}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                model: MODEL,
                instructions: PROMPT,
                input: transcript,
            }),
        });
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new AppError(
            ERROR_CODES.SUMMARIZATION_FAILED,
            `Could not connect to OpenAI: ${message}`,
            err instanceof Error ? err : undefined
        );
    }

    // Handle rate limiting — do NOT retry (isServerError matches "5xx" only)
    if (response.status === 429) {
        throw new AppError(
            ERROR_CODES.RATE_LIMITED,
            "OpenAI rate limit exceeded while generating editorial meta."
        );
    }

    // Handle server errors — throw plain Error so isServerError triggers retry
    if (response.status >= 500) {
        throw new Error(`OpenAI server error: HTTP ${response.status}`);
    }

    if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new AppError(
            ERROR_CODES.SUMMARIZATION_FAILED,
            `Editorial meta generation failed: ${response.status} ${body.slice(0, 500)}`
        );
    }

    let data: ResponsesApiResponse;
    try {
        data = await response.json() as ResponsesApiResponse;
    } catch {
        throw new AppError(
            ERROR_CODES.SUMMARIZATION_FAILED,
            "Failed to parse editorial meta response"
        );
    }

    if (data.error) {
        throw new AppError(
            ERROR_CODES.SUMMARIZATION_FAILED,
            `Editorial meta error: ${data.error.message}`
        );
    }

    const text = extractOutputText(data);
    if (!text) {
        throw new AppError(
            ERROR_CODES.SUMMARIZATION_FAILED,
            "Editorial meta response missing text output"
        );
    }

    const parsed = parseEditorialMeta(text);
    if (!parsed) {
        throw new AppError(
            ERROR_CODES.SUMMARIZATION_FAILED,
            `Editorial meta response could not be parsed as JSON: ${text.slice(0, 200)}`
        );
    }
    return parsed;
}
