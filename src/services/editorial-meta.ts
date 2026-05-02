/**
 * Editorial Meta Service — produces the 1-2 sentence deck and one-sentence
 * pull quote used in the Broadsheet design. Called once per episode during
 * ingest, stored on the Episode KV record. Backed by Anthropic Claude
 * Opus 4.7.
 */

import { AppError } from "../lib/errors";
import { ERROR_CODES } from "../lib/constants";
import { createAnthropicMessage, type AnthropicUsage } from "./anthropic-client";

export interface EditorialMeta {
    deck: string;
    pullQuote: string;
}

export interface EditorialMetaResult extends EditorialMeta {
    model: string;
    usage: AnthropicUsage;
}

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
    anthropicApiKey: string
): Promise<EditorialMetaResult> {
    let result;
    try {
        result = await createAnthropicMessage({
            apiKey: anthropicApiKey,
            system: PROMPT,
            user: transcript,
        });
    } catch (err) {
        if (err instanceof AppError && err.code === ERROR_CODES.RATE_LIMITED) {
            throw new AppError(
                ERROR_CODES.RATE_LIMITED,
                "Anthropic rate limit exceeded while generating editorial meta."
            );
        }
        throw err;
    }

    const parsed = parseEditorialMeta(result.text);
    if (!parsed) {
        throw new AppError(
            ERROR_CODES.SUMMARIZATION_FAILED,
            `Editorial meta response could not be parsed as JSON: ${result.text.slice(0, 200)}`
        );
    }
    return { ...parsed, model: result.model, usage: result.usage };
}
