/**
 * Tag Generation Service
 *
 * Generates AI-powered episode tags using GPT-5.2 based on
 * the episode transcript and summary.
 */

import { AppError } from "../lib/errors";
import { ERROR_CODES, getValidTags } from "../lib/constants";
import { withRetry, isServerError } from "../lib/retry";

// ============================================================================
// Types
// ============================================================================

export interface TagGenerationResult {
    tags: string[];
    model: string;
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

// ============================================================================
// Constants
// ============================================================================

const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
const MODEL = "gpt-5.2";

/**
 * Build the tag generation prompt
 */
function buildTagPrompt(): string {
    const validTags = getValidTags();
    const tagList = validTags.map(tag => `- ${tag}`).join('\n');

    return `Analyze the following podcast episode content and select 1-4 most relevant tags from the list below. Choose tags that best describe the primary themes and subject matter of the episode.

AVAILABLE TAGS:
${tagList}

INSTRUCTIONS:
- Select between 1 and 4 tags
- Choose tags that best represent the episode's main topics
- Return ONLY a comma-separated list of tags, nothing else
- Tags must be from the list above (lowercase with hyphens)
- Example output: "psychology, personal-development, health"

Return the tags as a simple comma-separated list.`;
}

// ============================================================================
// Main Functions
// ============================================================================

/**
 * Generate tags for an episode based on its content.
 *
 * @param summary - The episode summary text
 * @param transcript - Optional full transcript (will use first 8000 chars if provided)
 * @param openaiApiKey - OpenAI API key
 * @returns Array of 1-4 tags
 */
export async function generateEpisodeTags(
    summary: string,
    transcript: string | undefined,
    openaiApiKey: string
): Promise<TagGenerationResult> {
    // Build content to analyze (summary + truncated transcript)
    let content = `SUMMARY:\n${summary}`;

    if (transcript) {
        // Include first 8000 chars of transcript for context
        const transcriptSample = transcript.substring(0, 8000);
        content += `\n\nTRANSCRIPT (excerpt):\n${transcriptSample}`;
    }

    // Call GPT-5.2 with retry logic
    const result = await withRetry(
        () => callTagGenerationApi(content, openaiApiKey),
        {
            maxRetries: 3,
            baseDelayMs: 1000,
            shouldRetry: isServerError,
        }
    );

    return result;
}

/**
 * Call the OpenAI Responses API for tag generation
 */
async function callTagGenerationApi(
    content: string,
    apiKey: string
): Promise<TagGenerationResult> {
    const instructions = buildTagPrompt();

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
                input: content,
            }),
        });
    } catch (error) {
        throw new AppError(
            ERROR_CODES.SUMMARIZATION_FAILED,
            "Failed to generate tags: Could not connect to OpenAI API",
            error instanceof Error ? error : undefined
        );
    }

    // Handle rate limiting
    if (response.status === 429) {
        throw new AppError(
            ERROR_CODES.RATE_LIMITED,
            "OpenAI rate limit exceeded while generating tags."
        );
    }

    // Handle server errors
    if (response.status >= 500) {
        throw new Error(`OpenAI server error: HTTP ${response.status}`);
    }

    if (!response.ok) {
        const errorText = await response.text().catch(() => "Unknown error");
        throw new AppError(
            ERROR_CODES.SUMMARIZATION_FAILED,
            `Failed to generate tags: OpenAI API error (${response.status}): ${errorText}`
        );
    }

    // Parse response
    let data: ResponsesApiResponse;
    try {
        data = await response.json() as ResponsesApiResponse;
    } catch {
        throw new AppError(
            ERROR_CODES.SUMMARIZATION_FAILED,
            "Failed to parse tag generation response"
        );
    }

    if (data.error) {
        throw new AppError(
            ERROR_CODES.SUMMARIZATION_FAILED,
            `Tag generation error: ${data.error.message}`
        );
    }

    // Extract and parse tags
    const text = extractTextFromResponse(data);
    if (!text) {
        // Non-critical - return empty array rather than failing
        console.warn("Tag generation returned empty response, using default tags");
        return {
            tags: [],
            model: data.model || MODEL,
        };
    }

    const tags = parseTags(text);

    return {
        tags,
        model: data.model || MODEL,
    };
}

/**
 * Extract text from Responses API response
 */
function extractTextFromResponse(data: ResponsesApiResponse): string | null {
    try {
        const output = data.output?.[0];
        if (!output || output.type !== "message") {
            return null;
        }

        const content = output.content?.[0];
        if (!content || content.type !== "output_text") {
            return null;
        }

        return content.text || null;
    } catch {
        return null;
    }
}

/**
 * Parse comma-separated tags from API response
 * Validates against allowed tags and returns 1-4 tags
 */
function parseTags(text: string): string[] {
    const validTags = getValidTags();

    // Split by comma, clean up whitespace, convert to lowercase
    const rawTags = text
        .split(',')
        .map(tag => tag.trim().toLowerCase())
        .filter(tag => tag.length > 0);

    // Validate against allowed tags
    const validatedTags = rawTags.filter(tag =>
        validTags.includes(tag as any)
    );

    // Ensure at least 1 tag (but don't fail if 0)
    if (validatedTags.length === 0) {
        console.warn(`Tag generation returned no valid tags: ${rawTags.join(', ')}`);
        return validatedTags; // Return empty array
    }

    // Take only first 4 if more were returned
    return validatedTags.slice(0, 4);
}
