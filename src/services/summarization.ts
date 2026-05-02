/**
 * Summarization Service — Anthropic Claude Opus 4.7
 *
 * Generates AI-powered summaries of podcast transcripts using
 * configurable templates (key-takeaways, narrative-summary, eli5).
 */

import { AppError } from "../lib/errors";
import { ERROR_CODES, getTemplate, isValidTemplateId } from "../lib/constants";
import { createAnthropicMessage, type AnthropicUsage } from "./anthropic-client";

export interface SummarizationResult {
    text: string;
    model: string;
    usage: AnthropicUsage;
}

/**
 * Generate a summary of a transcript using the specified template.
 *
 * @throws AppError with INVALID_TEMPLATE if templateId is not valid
 * @throws AppError with RATE_LIMITED on 429 responses
 * @throws AppError with SUMMARIZATION_FAILED on other errors
 */
export async function generateSummary(
    transcript: string,
    templateId: string,
    anthropicApiKey: string
): Promise<SummarizationResult> {
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

    return createAnthropicMessage({
        apiKey: anthropicApiKey,
        system: template.prompt,
        user: transcript,
    });
}
