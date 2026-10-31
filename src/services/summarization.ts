/**
 * Summarization Service - Anthropic Messages API (claude-opus-5-5)
 *
 * Generates AI-powered summaries of podcast transcripts using
 * configurable templates (key-takeaways, narrative-summary, eli5).
 *
 * Switched from OpenAI gpt-5.6-terra on 2026-10-31 after the A/B in
 * scripts/ab-summary.ts: Opus is more specific and sticks to the word budget
 * better, at ~3x the cost and ~2x the latency (15–26s on real transcripts).
 */

import Anthropic from "@anthropic-ai/sdk";
import { AppError } from "../lib/errors";
import { ERROR_CODES, getTemplate, isValidTemplateId } from "../lib/constants";
import { withRetry, isServerError } from "../lib/retry";

// ============================================================================
// Types
// ============================================================================

export interface SummarizationResult {
    text: string;
    /** The model that actually served the request — differs from MODEL after a server-side fallback. */
    model: string;
}

// ============================================================================
// Constants
// ============================================================================

const MODEL = "claude-opus-5-5";

/**
 * Opus 5.5 always thinks; effort is the only depth control and its default is
 * `medium`. Set explicitly so the production setting is visible here and the
 * A/B harness (`--effort`) compares like with like.
 */
const EFFORT = "medium";

/**
 * Summaries are 400–600 words (~900 tokens). Thinking tokens count against
 * this too, and the A/B runs peaked under 3,000, so this is headroom, not a
 * target. Non-streaming is fine at this size: the SDK's timeout scales with
 * max_tokens and measured latency is well under a minute.
 */
const MAX_TOKENS = 16000;

/**
 * On a safety refusal the API re-runs the request on a fallback model inside
 * the same call (routed by refusal category) rather than failing the job.
 * The served model is recorded in SummarizationResult.model.
 */
const FALLBACK_BETA = "server-side-fallback-2026-07-01";

// ============================================================================
// Main Functions
// ============================================================================

/**
 * Generate a summary of a transcript using the specified template.
 *
 * @param transcript - The full podcast transcript text
 * @param templateId - ID of the summary template to use
 * @param apiKey - Anthropic API key
 * @returns The generated summary and model used
 * @throws AppError with INVALID_TEMPLATE if templateId is not valid
 * @throws AppError with RATE_LIMITED on 429 responses
 * @throws AppError with SUMMARIZATION_FAILED on other errors
 */
export async function generateSummary(
    transcript: string,
    templateId: string,
    apiKey: string
): Promise<SummarizationResult> {
    // Validate template
    if (!isValidTemplateId(templateId)) {
        throw new AppError(
            ERROR_CODES.INVALID_TEMPLATE,
            `Invalid template ID: "${templateId}". Valid templates are: key-takeaways, narrative-summary, eli5`
        );
    }

    const template = getTemplate(templateId);
    if (!template) {
        throw new AppError(
            ERROR_CODES.INVALID_TEMPLATE,
            `Template "${templateId}" not found`
        );
    }

    // Call the Messages API with retry logic
    // Only retry on 5xx server errors, NOT on rate limits (429)
    const result = await withRetry(
        () => callMessagesApi(transcript, template.prompt, apiKey),
        {
            maxRetries: 3,
            baseDelayMs: 1000,
            shouldRetry: isServerError,
        }
    );

    return result;
}

/**
 * Call the Anthropic Messages API.
 *
 * The template prompt is the system prompt and the transcript is the single
 * user turn — the same split the OpenAI implementation used for
 * `instructions` / `input`, so the templates in constants.ts are unchanged.
 *
 * @internal
 */
async function callMessagesApi(
    transcript: string,
    instructions: string,
    apiKey: string
): Promise<SummarizationResult> {
    // SDK retries are off so withRetry() above stays the single retry policy
    // (the SDK would otherwise also retry 429s, which we deliberately don't).
    const client = new Anthropic({ apiKey, maxRetries: 0 });

    let message: Anthropic.Beta.BetaMessage;
    try {
        message = await client.beta.messages.create({
            betas: [FALLBACK_BETA],
            model: MODEL,
            max_tokens: MAX_TOKENS,
            system: instructions,
            output_config: { effort: EFFORT },
            fallbacks: "default",
            messages: [{ role: "user", content: transcript }],
        });
    } catch (error) {
        throw toAppError(error);
    }

    if (message.stop_reason === "refusal") {
        const category = message.stop_details?.category ?? "unknown";
        throw new AppError(
            ERROR_CODES.SUMMARIZATION_FAILED,
            `Anthropic API refused the request (category: ${category})`
        );
    }

    if (message.stop_reason === "max_tokens") {
        throw new AppError(
            ERROR_CODES.SUMMARIZATION_FAILED,
            `Anthropic API output was cut off at max_tokens (${MAX_TOKENS})`
        );
    }

    const text = message.content
        .filter((block): block is Anthropic.Beta.BetaTextBlock => block.type === "text")
        .map((block) => block.text)
        .join("");

    if (!text.trim()) {
        throw new AppError(
            ERROR_CODES.SUMMARIZATION_FAILED,
            "Anthropic API returned empty or malformed response"
        );
    }

    return {
        text,
        model: message.model || MODEL,
    };
}

/**
 * Map SDK errors onto the service's error contract, most specific first.
 *
 * Server errors are rethrown as plain Errors carrying the status code in the
 * message so `isServerError` in retry.ts (which matches /5\d{2}/) retries them.
 */
function toAppError(error: unknown): Error {
    if (error instanceof Anthropic.RateLimitError) {
        return new AppError(
            ERROR_CODES.RATE_LIMITED,
            "Anthropic rate limit exceeded. Please try again later."
        );
    }

    if (error instanceof Anthropic.APIConnectionError) {
        return new AppError(
            ERROR_CODES.SUMMARIZATION_FAILED,
            "Failed to connect to Anthropic API",
            error
        );
    }

    if (error instanceof Anthropic.APIError) {
        if (typeof error.status === "number" && error.status >= 500) {
            return new Error(`Anthropic server error: HTTP ${error.status}`);
        }
        return new AppError(
            ERROR_CODES.SUMMARIZATION_FAILED,
            `Anthropic API error (${error.status}): ${error.message}`
        );
    }

    return new AppError(
        ERROR_CODES.SUMMARIZATION_FAILED,
        "Anthropic API request failed",
        error instanceof Error ? error : undefined
    );
}
