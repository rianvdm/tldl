import type { Template } from "../types";

// ============================================================================
// Summary Templates
// ============================================================================

export const TEMPLATES: Record<string, Template> = {
    "key-takeaways": {
        id: "key-takeaways",
        name: "Key Takeaways & Practical Steps",
        description: "For craft and professional development podcasts",
        prompt: `Analyze this podcast transcript and provide:

1. A brief overview of the episode's main topic (2-3 sentences)

2. Key Takeaways: The most important insights and learnings from this conversation. Focus on novel ideas, counterintuitive points, and expert knowledge shared.

3. Practical Steps: Actionable advice listeners can implement. Be specific about what to do, not just what to think about.

4. Notable Quotes: 2-3 standout quotes that capture essential ideas (include speaker if identifiable).

Keep the tone professional but accessible. Use paragraphs for narrative sections and bullets only where they aid clarity. Total length: 400-600 words.`,
    },

    "narrative-summary": {
        id: "narrative-summary",
        name: "Narrative Summary",
        description: "For story-driven and interview podcasts",
        prompt: `Provide a cohesive narrative summary of this podcast episode.

Write in flowing paragraphs that capture:
- The arc of the conversation or story
- Key moments and turning points
- The main themes explored
- How ideas connect and build on each other

Avoid bullet points. Write as if you're telling a friend about a fascinating conversation you overheard. Capture the essence without losing the nuance.

Total length: 300-400 words.`,
    },

    eli5: {
        id: "eli5",
        name: "ELI5 (Explain Like I'm 5)",
        description: "For technical and complex topics",
        prompt: `Explain the main ideas from this podcast in simple, accessible language that anyone could understand.

Break down complex concepts using:
- Everyday analogies and comparisons
- Simple vocabulary (avoid jargon, or explain it plainly)
- Concrete examples

Structure your explanation as:
1. What's the big idea? (1-2 sentences)
2. Why does it matter? (1 paragraph)
3. Key concepts explained simply (2-3 paragraphs)
4. The bottom line (2-3 sentences)

Be accurate while being accessible. Total length: 400-600 words.`,
    },
};

/**
 * Get all template IDs
 */
export function getTemplateIds(): string[] {
    return Object.keys(TEMPLATES);
}

/**
 * Check if a template ID is valid
 */
export function isValidTemplateId(templateId: string): boolean {
    return templateId in TEMPLATES;
}

/**
 * Get a template by ID
 */
export function getTemplate(templateId: string): Template | undefined {
    return TEMPLATES[templateId];
}

// ============================================================================
// Error Codes
// ============================================================================

export const ERROR_CODES = {
    // URL/Input errors
    INVALID_URL: "INVALID_URL",
    INVALID_TEMPLATE: "INVALID_TEMPLATE",

    // Episode errors
    EPISODE_NOT_FOUND: "EPISODE_NOT_FOUND",
    EPISODE_TOO_LONG: "EPISODE_TOO_LONG",

    // Audio errors
    AUDIO_UNAVAILABLE: "AUDIO_UNAVAILABLE",
    AUDIO_TOO_LARGE: "AUDIO_TOO_LARGE",

    // Processing errors
    TRANSCRIPTION_FAILED: "TRANSCRIPTION_FAILED",
    SUMMARIZATION_FAILED: "SUMMARIZATION_FAILED",

    // External service errors
    RATE_LIMITED: "RATE_LIMITED",
    RSS_TIMEOUT: "RSS_TIMEOUT",
    ITUNES_API_ERROR: "ITUNES_API_ERROR",

    // Generic errors
    UNKNOWN_ERROR: "UNKNOWN_ERROR",
    NOT_FOUND: "NOT_FOUND",
    UNAUTHORIZED: "UNAUTHORIZED",
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

// ============================================================================
// TTL Constants (in seconds)
// ============================================================================

export const TTL = {
    JOB: 7 * 24 * 60 * 60,         // 7 days
    CONTENT: 365 * 24 * 60 * 60,    // 365 days
} as const;

// ============================================================================
// KV Key Prefixes
// ============================================================================

export const KV_PREFIXES = {
    JOB: "job:",
    EPISODE: "episode:",
    TRANSCRIPT: "transcript:",
    SUMMARY: "summary:",
} as const;
