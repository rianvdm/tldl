/**
 * Shared Anthropic Messages API client for non-transcription LLM calls.
 *
 * All summary, tag, and editorial-meta generation goes through this helper
 * so we have one provider, one error-handling path, and consistent prompt
 * caching. Transcription stays on OpenAI gpt-4o-mini-transcribe.
 *
 * Caching: each caller passes its template/system prompt verbatim across
 * episodes, so we mark the system block ephemeral. Subsequent calls within
 * the 5-minute TTL get cache hits.
 */

import { AppError } from "../lib/errors";
import { ERROR_CODES } from "../lib/constants";
import { withRetry, isServerError } from "../lib/retry";

const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";

export const DEFAULT_MODEL = "claude-opus-4-7";
export const DEFAULT_MAX_TOKENS = 10_000;

export interface AnthropicUsage {
    inputTokens: number;
    outputTokens: number;
    cacheCreationInputTokens?: number;
    cacheReadInputTokens?: number;
}

export interface AnthropicMessageResult {
    text: string;
    model: string;
    usage: AnthropicUsage;
}

export interface CreateMessageOptions {
    apiKey: string;
    system: string;
    user: string;
    maxTokens?: number;
    model?: string;
}

interface MessagesApiResponse {
    id: string;
    model: string;
    content: Array<{ type: string; text?: string }>;
    stop_reason: string;
    usage: {
        input_tokens: number;
        output_tokens: number;
        cache_creation_input_tokens?: number;
        cache_read_input_tokens?: number;
    };
}

interface ApiErrorResponse {
    type: "error";
    error: { type: string; message: string };
}

/**
 * Call Anthropic Messages API with retry on 5xx (including 529 overloaded).
 *
 * The system prompt is marked ephemeral so repeated calls with the same
 * template hit the prompt cache.
 */
export async function createAnthropicMessage(
    options: CreateMessageOptions
): Promise<AnthropicMessageResult> {
    return withRetry(() => callMessagesApi(options), {
        maxRetries: 3,
        baseDelayMs: 1000,
        shouldRetry: isServerError,
    });
}

async function callMessagesApi(
    options: CreateMessageOptions
): Promise<AnthropicMessageResult> {
    const { apiKey, system, user, maxTokens = DEFAULT_MAX_TOKENS, model = DEFAULT_MODEL } = options;

    let response: Response;

    try {
        response = await fetch(ANTHROPIC_MESSAGES_URL, {
            method: "POST",
            headers: {
                "x-api-key": apiKey,
                "anthropic-version": ANTHROPIC_VERSION,
                "content-type": "application/json",
            },
            body: JSON.stringify({
                model,
                max_tokens: maxTokens,
                system: [
                    {
                        type: "text",
                        text: system,
                        cache_control: { type: "ephemeral" },
                    },
                ],
                messages: [{ role: "user", content: user }],
            }),
        });
    } catch (error) {
        throw new AppError(
            ERROR_CODES.SUMMARIZATION_FAILED,
            "Failed to connect to Anthropic API",
            error instanceof Error ? error : undefined
        );
    }

    if (response.status === 429) {
        throw new AppError(
            ERROR_CODES.RATE_LIMITED,
            "Anthropic rate limit exceeded. Please try again later."
        );
    }

    // 5xx and 529 (overloaded) both retry via isServerError
    if (response.status >= 500) {
        throw new Error(`Anthropic server error: HTTP ${response.status}`);
    }

    if (!response.ok) {
        const errorText = await response.text().catch(() => "Unknown error");
        throw new AppError(
            ERROR_CODES.SUMMARIZATION_FAILED,
            `Anthropic API error (${response.status}): ${errorText}`
        );
    }

    let data: MessagesApiResponse | ApiErrorResponse;
    try {
        data = (await response.json()) as MessagesApiResponse | ApiErrorResponse;
    } catch {
        throw new AppError(
            ERROR_CODES.SUMMARIZATION_FAILED,
            "Failed to parse Anthropic API response"
        );
    }

    if ((data as ApiErrorResponse).type === "error") {
        const err = (data as ApiErrorResponse).error;
        throw new AppError(
            ERROR_CODES.SUMMARIZATION_FAILED,
            `Anthropic API error: ${err.message}`
        );
    }

    const ok = data as MessagesApiResponse;
    const text = ok.content?.find((b) => b.type === "text")?.text;
    if (!text) {
        throw new AppError(
            ERROR_CODES.SUMMARIZATION_FAILED,
            "Anthropic API returned empty or malformed response"
        );
    }

    return {
        text,
        model: ok.model || model,
        usage: {
            inputTokens: ok.usage.input_tokens,
            outputTokens: ok.usage.output_tokens,
            cacheCreationInputTokens: ok.usage.cache_creation_input_tokens,
            cacheReadInputTokens: ok.usage.cache_read_input_tokens,
        },
    };
}
