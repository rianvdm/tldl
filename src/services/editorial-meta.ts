/**
 * Editorial Meta Service — produces the 1-2 sentence deck and one-sentence
 * pull quote used in the Broadsheet design. Called once per episode during
 * ingest, stored on the Episode KV record.
 */

import { AppError } from "../lib/errors";
import { ERROR_CODES } from "../lib/constants";
import { withRetry, isServerError } from "../lib/retry";

export interface EditorialMeta {
    deck: string;
    pullQuote: string;
}

const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
const MODEL = "gpt-5.4";

const PROMPT = `You are writing for a weekly newspaper that summarizes podcast episodes.

Given the transcript below, produce two pieces of copy:

1. "deck": a 1-2 sentence descriptive deck in the voice of a print weekly.
   Complete sentences. Sentence case. No ellipses. No phrases like "In this
   episode" or "This episode explores". Describe what the conversation is
   about, not what it promises.

2. "pullQuote": a single aphoristic sentence taken or lightly condensed from
   the transcript. The kind of line a reader would screenshot. One sentence.
   No ellipses. Prefer the speaker's voice over paraphrase.

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
    const response = await fetch(OPENAI_RESPONSES_URL, {
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

    if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new AppError(
            ERROR_CODES.SUMMARIZATION_FAILED,
            `Editorial meta generation failed: ${response.status} ${body.slice(0, 500)}`
        );
    }

    const data: any = await response.json();
    const text: string | undefined = data?.output?.[0]?.content?.[0]?.text;
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
