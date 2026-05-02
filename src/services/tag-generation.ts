/**
 * Tag Generation Service — Anthropic Claude Opus 4.7
 *
 * Generates 2-3 episode tags from a fixed taxonomy based on the
 * episode summary and transcript excerpt.
 */

import { AppError } from "../lib/errors";
import { ERROR_CODES, getValidTags } from "../lib/constants";
import { createAnthropicMessage, type AnthropicUsage } from "./anthropic-client";

export interface TagGenerationResult {
    tags: string[];
    model: string;
    usage: AnthropicUsage;
}

function buildTagPrompt(): string {
    const validTags = getValidTags();
    const tagList = validTags.map((tag) => `- ${tag}`).join("\n");

    return `Analyze the following podcast episode content and select 2-3 most relevant tags from the list below. Choose tags that best describe the primary themes and subject matter of the episode.

AVAILABLE TAGS:
${tagList}

INSTRUCTIONS:
- Select between 2 and 3 tags
- Choose tags that best represent the episode's main topics
- Return ONLY a comma-separated list of tags, nothing else
- Tags must be from the list above (lowercase with hyphens)
- Example output: "product, technology"

Return the tags as a simple comma-separated list.`;
}

/**
 * Generate tags for an episode based on its content.
 */
export async function generateEpisodeTags(
    summary: string,
    transcript: string | undefined,
    anthropicApiKey: string
): Promise<TagGenerationResult> {
    let content = `SUMMARY:\n${summary}`;
    if (transcript) {
        const transcriptSample = transcript.substring(0, 8000);
        content += `\n\nTRANSCRIPT (excerpt):\n${transcriptSample}`;
    }

    let result;
    try {
        result = await createAnthropicMessage({
            apiKey: anthropicApiKey,
            system: buildTagPrompt(),
            user: content,
        });
    } catch (err) {
        // Re-wrap rate-limit messages so the caller gets a tag-specific log line.
        if (err instanceof AppError && err.code === ERROR_CODES.RATE_LIMITED) {
            throw new AppError(
                ERROR_CODES.RATE_LIMITED,
                "Anthropic rate limit exceeded while generating tags."
            );
        }
        throw err;
    }

    const tags = parseTags(result.text);
    if (tags.length === 0) {
        console.warn(`Tag generation returned no valid tags: ${result.text.slice(0, 200)}`);
    }

    return { tags, model: result.model, usage: result.usage };
}

/**
 * Parse comma-separated tags from API response.
 * Validates against allowed tags and returns up to 3 tags.
 */
function parseTags(text: string): string[] {
    const validTags = getValidTags();

    const rawTags = text
        .split(",")
        .map((tag) => tag.trim().toLowerCase())
        .filter((tag) => tag.length > 0);

    const validatedTags = rawTags.filter((tag) => validTags.includes(tag as any));

    return validatedTags.slice(0, 3);
}
