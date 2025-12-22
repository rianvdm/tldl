import type { Template } from "../types";

// ============================================================================
// Admin Users
// ============================================================================

/**
 * Admin users can view and delete ALL episodes on the profile page.
 * Add email addresses to this array to grant admin access.
 */
export const ADMIN_EMAILS: string[] = [
    "rianvdm@gmail.com",
];

// ============================================================================
// Blocked Podcasts
// ============================================================================

/**
 * Podcasts that have opted out of being processed.
 * Add URL patterns here (partial matches against the submitted URL).
 * Example: "id1234567890" will block any URL containing that podcast ID.
 */
export const BLOCKED_PODCASTS: string[] = [
    // Add podcast URL patterns here, e.g.:
    // "id1234567890",
    // "some-podcast-name",
];

/**
 * Check if a URL is blocked from submission
 */
export function isBlockedPodcast(url: string): boolean {
    const lowerUrl = url.toLowerCase();
    return BLOCKED_PODCASTS.some(pattern =>
        lowerUrl.includes(pattern.toLowerCase())
    );
}

// ============================================================================
// Episode Tags
// ============================================================================

/**
 * Predefined episode tags for AI categorization.
 * Easy to edit - just add/remove tags from this array.
 * Keep between 8-12 tags total for optimal user experience.
 */
export const EPISODE_TAGS = [
    "business",
    "creativity",
    "education",
    "health",
    "politics",
    "product",
    "psychology",
    "science",
    "sport",
    "technology",
    "music",
    "faith",
] as const;

export type EpisodeTag = (typeof EPISODE_TAGS)[number];

/**
 * Get all valid episode tags
 */
export function getValidTags(): readonly string[] {
    return EPISODE_TAGS;
}

/**
 * Check if a tag is valid
 */
export function isValidTag(tag: string): tag is EpisodeTag {
    return EPISODE_TAGS.includes(tag as EpisodeTag);
}

/**
 * Validate an array of tags
 */
export function validateTags(tags: string[]): { valid: string[]; invalid: string[] } {
    const valid = tags.filter(tag => isValidTag(tag));
    const invalid = tags.filter(tag => !isValidTag(tag));
    return { valid, invalid };
}

// ============================================================================
// Summary Templates
// ============================================================================

export const TEMPLATES: Record<string, Template> = {
    "key-takeaways": {
        id: "key-takeaways",
        name: "Key Takeaways & Practical Steps",
        description: "For craft and professional development podcasts",
        prompt: `Analyze this podcast transcript and provide a summary using the following structure. Use ## headings (not numbered) to introduce each section.

## Overview
A brief overview of the episode's main topic (2-3 sentences).

## Key Takeaways
The most important insights and learnings from this conversation. Focus on novel ideas, counterintuitive points, and expert knowledge shared.

## Practical Steps
Actionable advice listeners can implement. Be specific about what to do, not just what to think about.

## Notable Quotes
2-3 standout quotes that capture essential ideas (include speaker if identifiable).

Keep the tone professional but accessible. Use paragraphs for narrative sections and bullets only where they aid clarity. Total length: 400-600 words.`,
    },

    "narrative-summary": {
        id: "narrative-summary",
        name: "Narrative Summary",
        description: "For story-driven and interview podcasts",
        prompt: `Provide a cohesive narrative summary of this podcast episode. Use ## headings (not numbered) to introduce each section.

## The Story
Write in flowing paragraphs that capture the arc of the conversation or story, including key moments and turning points.

## Main Themes
The central ideas and themes explored throughout the episode, and how they connect and build on each other.

Avoid bullet points. Write as if you're telling a friend about a fascinating conversation you overheard. Capture the essence without losing the nuance.

Total length: 400-500 words.`,
    },

    eli5: {
        id: "eli5",
        name: "ELI5 (Explain Like I'm 5)",
        description: "For technical and complex topics",
        prompt: `Explain the main ideas from this podcast in simple, accessible language that anyone could understand. Use ## headings (not numbered) to introduce each section.

Break down complex concepts using everyday analogies, simple vocabulary (avoid jargon, or explain it plainly), and concrete examples.

## The Big Idea
What is this episode fundamentally about?

## Why It Matters
Why should listeners care about this topic?

## Key Concepts
The main ideas explained simply, with analogies where helpful.

## The Bottom Line
The essential takeaway in plain language.

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

// ============================================================================
// Timeout Constants (in milliseconds)
// ============================================================================

export const TIMEOUTS = {
    // Audio validation HEAD request
    AUDIO_HEAD_MS: 10 * 1000,           // 10 seconds

    // Full audio file fetch (for small files)
    AUDIO_FETCH_MS: 2 * 60 * 1000,      // 2 minutes

    // Audio chunk fetch (for chunked transcription)
    CHUNK_FETCH_MS: 60 * 1000,          // 1 minute

    // Delay between audio chunk fetches (avoid CDN rate limits)
    CHUNK_FETCH_DELAY_MS: 500,          // 500ms between chunks

    // OpenAI Whisper API call (per chunk)
    WHISPER_API_MS: 10 * 60 * 1000,     // 10 minutes

    // Overall job timeout (marks job as failed if exceeded)
    JOB_MS: 20 * 60 * 1000,             // 20 minutes
} as const;

// ============================================================================
// Rate Limiting Constants
// ============================================================================

export const RATE_LIMITS = {
    MAX_SUBMISSIONS_PER_HOUR: 10,       // Max episode submissions per hour per user
    WINDOW_SECONDS: 3600,               // 1 hour window
} as const;

// ============================================================================
// Audio Processing Limits
// ============================================================================

export const AUDIO_LIMITS = {
    MAX_SIZE_BYTES: 25 * 1024 * 1024,   // 25MB (OpenAI Whisper limit)
    CHUNK_SIZE_BYTES: 20 * 1024 * 1024, // 20MB chunks for large files
    CHUNK_OVERLAP_BYTES: 32 * 1024,     // 32KB overlap for transcript stitching
} as const;

