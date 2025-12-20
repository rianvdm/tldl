/**
 * Summarization Service - GPT-5.2 Responses API
 *
 * Generates AI-powered summaries of podcast transcripts using
 * configurable templates (key-takeaways, narrative-summary, eli5).
 */

import { AppError } from "../lib/errors";
import { ERROR_CODES, getTemplate, isValidTemplateId } from "../lib/constants";
import { withRetry, isServerError } from "../lib/retry";

// ============================================================================
// Types
// ============================================================================

export interface SummarizationResult {
    text: string;
    model: string;
}

/**
 * OpenAI Responses API response structure
 */
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

// ============================================================================
// Constants
// ============================================================================

const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
const MODEL = "gpt-5.2";

// ============================================================================
// Main Functions
// ============================================================================

/**
 * Generate a summary of a transcript using the specified template.
 *
 * @param transcript - The full podcast transcript text
 * @param templateId - ID of the summary template to use
 * @param openaiApiKey - OpenAI API key
 * @returns The generated summary and model used
 * @throws AppError with INVALID_TEMPLATE if templateId is not valid
 * @throws AppError with RATE_LIMITED on 429 responses
 * @throws AppError with SUMMARIZATION_FAILED on other errors
 */
export async function generateSummary(
    transcript: string,
    templateId: string,
    openaiApiKey: string
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

    // Call GPT-5.2 Responses API with retry logic
    // Only retry on 5xx server errors, NOT on rate limits (429)
    const result = await withRetry(
        () => callResponsesApi(transcript, template.prompt, openaiApiKey),
        {
            maxRetries: 3,
            baseDelayMs: 1000,
            shouldRetry: isServerError,
        }
    );

    return result;
}

/**
 * Call the OpenAI Responses API.
 *
 * @internal
 */
async function callResponsesApi(
    transcript: string,
    instructions: string,
    apiKey: string
): Promise<SummarizationResult> {
    let response: Response;

    try {
        response = await fetch(OPENAI_RESPONSES_URL, {
            method: "POST",
            headers: {
                Authorization: `Bearer ${apiKey}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                model: MODEL,
                instructions: instructions,
                input: transcript,
            }),
        });
    } catch (error) {
        throw new AppError(
            ERROR_CODES.SUMMARIZATION_FAILED,
            "Failed to connect to OpenAI API",
            error instanceof Error ? error : undefined
        );
    }

    // Handle rate limiting
    if (response.status === 429) {
        throw new AppError(
            ERROR_CODES.RATE_LIMITED,
            "OpenAI rate limit exceeded. Please try again later."
        );
    }

    // Handle server errors (should trigger retry)
    if (response.status >= 500) {
        throw new Error(`OpenAI server error: HTTP ${response.status}`);
    }

    // Handle other client errors
    if (!response.ok) {
        const errorText = await response.text().catch(() => "Unknown error");
        throw new AppError(
            ERROR_CODES.SUMMARIZATION_FAILED,
            `OpenAI API error (${response.status}): ${errorText}`
        );
    }

    // Parse response
    let data: ResponsesApiResponse;
    try {
        data = await response.json() as ResponsesApiResponse;
    } catch {
        throw new AppError(
            ERROR_CODES.SUMMARIZATION_FAILED,
            "Failed to parse OpenAI API response"
        );
    }

    // Check for API-level error
    if (data.error) {
        throw new AppError(
            ERROR_CODES.SUMMARIZATION_FAILED,
            `OpenAI API error: ${data.error.message}`
        );
    }

    // Extract text from response
    const text = extractTextFromResponse(data);
    if (!text) {
        throw new AppError(
            ERROR_CODES.SUMMARIZATION_FAILED,
            "OpenAI API returned empty or malformed response"
        );
    }

    return {
        text,
        model: data.model || MODEL,
    };
}

/**
 * Extract the text content from a Responses API response.
 *
 * @internal
 */
function extractTextFromResponse(data: ResponsesApiResponse): string | null {
    try {
        // Navigate: output[0].content[0].text
        const output = data.output?.[0];
        if (!output || output.type !== "message") {
            return null;
        }

        const content = output.content?.[0];
        if (!content || content.type !== "text") {
            return null;
        }

        return content.text || null;
    } catch {
        return null;
    }
}
