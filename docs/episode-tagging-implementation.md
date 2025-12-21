# Episode Tagging Implementation Guide

## Overview

This document provides a detailed implementation plan for adding AI-generated, filterable tags to podcast episodes in TLDL. This feature enables users to discover episodes by topic and provides better content categorization.

**Status:** 🟡 Planning Complete, Implementation Pending

**Last Updated:** 2025-12-21

---

## Requirements Summary

### User Requirements
- ✅ AI-generated tags during queue processing (2-4 tags per episode)
- ✅ Predefined tag list with 10 broad categories including "psychology"
- ✅ Tags easily editable in a central location (`src/lib/constants.ts`)
- ✅ Single tag filtering on home page (no multi-tag)
- ✅ Admin can edit tags on profile page
- ✅ No new fields in `/submit` flow (automatic generation)

### Technical Requirements
- Tags stored in both `Episode` and `EpisodeIndexEntry` for efficient filtering
- Backwards compatible with existing episodes (optional field)
- Non-critical tag generation (empty tags don't fail jobs)
- Clickable tag badges with `stopPropagation()` to maintain card clickability
- Blue-tinted styling to distinguish from gray template badges

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│ Queue Consumer (src/queue/consumer.ts)                      │
│                                                              │
│  1. Fetch metadata                                          │
│  2. Transcribe audio (if needed)                            │
│  3. Generate summary                                        │
│  4. Generate tags ← NEW (uses summary + transcript)         │
│  5. Save episode (with tags)                                │
│  6. Add to index (with tags)                                │
└─────────────────────────────────────────────────────────────┘
         │
         │ saves to
         ▼
┌─────────────────────────────────────────────────────────────┐
│ KV Storage                                                   │
│                                                              │
│  episode:{id}        - Full Episode (with tags)             │
│  episodes:index      - Lightweight index (with tags)        │
└─────────────────────────────────────────────────────────────┘
         │
         │ read by
         ▼
┌─────────────────────────────────────────────────────────────┐
│ Home Page (src/routes/public.ts)                            │
│                                                              │
│  • Display tags as clickable badges                         │
│  • Filter by tag: /?tag=psychology                          │
│  • Show tag filter bar                                      │
└─────────────────────────────────────────────────────────────┘
         │
         │ edited via
         ▼
┌─────────────────────────────────────────────────────────────┐
│ Profile Page (src/routes/authenticated.ts)                  │
│                                                              │
│  • Admin: inline tag editor (toggle buttons)                │
│  • Regular users: read-only badges                          │
│  • POST /episode/:id/update-tags                            │
└─────────────────────────────────────────────────────────────┘
```

---

## Implementation Steps

### Step 1: Data Model Changes

**File:** `src/types/index.ts`

**What to do:**
Add optional `tags?: string[]` field to both `Episode` and `EpisodeIndexEntry` interfaces.

**Code:**
```typescript
export interface Episode {
    id: string;
    appleUrl: string;
    podcastName: string;
    episodeTitle: string;
    episodeDuration: number;
    episodeDate: string;
    audioUrl: string;
    transcriptSource: TranscriptSource;
    createdAt: string;
    expiresAt: string;
    submittedBy?: string;
    tags?: string[]; // NEW: 2-4 tags per episode
}

export interface EpisodeIndexEntry {
    id: string;
    podcastName: string;
    episodeTitle: string;
    episodeDate: string;
    episodeDuration: number;
    createdAt: string;
    expiresAt: string;
    tags?: string[]; // NEW: Include in index for efficient filtering
}
```

**Why:**
- Optional field ensures backwards compatibility
- Including tags in `EpisodeIndexEntry` enables filtering without N KV reads
- The home page reads from the index, not individual episodes

---

### Step 2: Tag Definitions

**File:** `src/lib/constants.ts`

**Where to add:** After line 13 (after `ADMIN_EMAILS`)

**Code:**
```typescript
// ============================================================================
// Episode Tags
// ============================================================================

/**
 * Predefined episode tags for AI categorization.
 * Easy to edit - just add/remove tags from this array.
 * Keep between 8-12 tags total for optimal user experience.
 */
export const EPISODE_TAGS = [
    "psychology",
    "business",
    "technology",
    "health",
    "education",
    "creativity",
    "science",
    "personal-development",
    "storytelling",
    "interview",
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
```

**Design notes:**
- Using `as const` provides type safety
- Tags are lowercase with hyphens for URL-friendliness
- Validation functions prevent invalid tags from being stored
- Easy to add/remove tags by editing the array

---

### Step 3: Tag Generation Service

**New File:** `src/services/tag-generation.ts`

**Pattern:** Follow the same structure as `src/services/summarization.ts`

**Code structure:**
```typescript
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

    return `Analyze the following podcast episode content and select 2-4 most relevant tags from the list below. Choose tags that best describe the primary themes and subject matter of the episode.

AVAILABLE TAGS:
${tagList}

INSTRUCTIONS:
- Select between 2 and 4 tags
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
 * @returns Array of 2-4 tags
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
 * Validates against allowed tags and returns 2-4 tags
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

    // Ensure 2-4 tags
    if (validatedTags.length < 2) {
        console.warn(`Tag generation returned fewer than 2 valid tags: ${rawTags.join(', ')}`);
        return validatedTags; // Return what we have, even if < 2
    }

    // Take only first 4 if more were returned
    return validatedTags.slice(0, 4);
}
```

**Key differences from summarization service:**
- Much shorter prompt (tag selection, not long-form text)
- Non-critical: empty tags on error (return `{ tags: [], model }` instead of throwing)
- Validation: ensure returned tags are in predefined list
- Truncates transcript to 8000 chars to keep prompt size manageable

---

### Step 4: Queue Consumer Integration

**File:** `src/queue/consumer.ts`

**Import at top of file:**
```typescript
import { generateEpisodeTags, type TagGenerationResult } from "../services/tag-generation";
```

**Where to add:** After line 360 (after `saveSummary`, before `saveEpisode`)

**Code:**
```typescript
    // Step 4.5: Generate tags (non-critical - don't fail job if this fails)
    let tags: string[] = [];
    try {
        const tagResult = await generateEpisodeTags(
            summary.text,
            transcript.text,
            env.OPENAI_API_KEY
        );
        tags = tagResult.tags;

        console.log(
            JSON.stringify({
                event: "tags_generated",
                episodeId,
                tags: tags,
                model: tagResult.model,
            })
        );
    } catch (error) {
        // Log but don't fail the job
        console.error(
            JSON.stringify({
                event: "tag_generation_failed",
                episodeId,
                error: error instanceof Error ? error.message : "Unknown error",
            })
        );
        // Continue with empty tags
    }
```

**Update episode creation (lines 368-392):**
```typescript
    // Step 5: Save episode metadata (only if it doesn't exist)
    if (!existingEpisode) {
        const now = new Date();
        const expiresAt = new Date(now);
        expiresAt.setDate(expiresAt.getDate() + 365);

        const episode: Episode = {
            id: episodeId,
            appleUrl,
            podcastName: metadata.podcastName,
            episodeTitle: metadata.episodeTitle,
            episodeDuration: metadata.episodeDuration,
            episodeDate: metadata.episodeDate,
            audioUrl: metadata.audioUrl,
            transcriptSource,
            createdAt: now.toISOString(),
            expiresAt: expiresAt.toISOString(),
            submittedBy,
            tags: tags.length > 0 ? tags : undefined, // NEW: Include generated tags
        };
        await saveEpisode(kv, episode);

        // Add to episode index for efficient home page listing
        await addToEpisodeIndex(kv, {
            id: episode.id,
            podcastName: episode.podcastName,
            episodeTitle: episode.episodeTitle,
            episodeDate: episode.episodeDate,
            episodeDuration: episode.episodeDuration,
            createdAt: episode.createdAt,
            expiresAt: episode.expiresAt,
            tags: episode.tags, // NEW: Include tags in index
        });
    }
```

**Why this approach:**
- Tag generation happens after summarization (when we have the most context)
- If tag generation fails, job still succeeds (we just save empty tags)
- Tags included in both Episode and EpisodeIndexEntry for efficient filtering
- Try-catch ensures tag generation errors don't fail the entire job

---

### Step 5: Storage Layer Updates

**File:** `src/lib/kv.ts`

**Add new function (after line 243):**
```typescript
/**
 * Update tags for an episode (admin-only operation)
 * Updates both the episode record and the index entry
 */
export async function updateEpisodeTags(
    kv: KVNamespace,
    episodeId: string,
    tags: string[]
): Promise<void> {
    // Get existing episode
    const episode = await getEpisode(kv, episodeId);
    if (!episode) {
        throw new Error(`Episode not found: ${episodeId}`);
    }

    // Update episode with new tags
    const updatedEpisode: Episode = {
        ...episode,
        tags: tags.length > 0 ? tags : undefined,
    };
    await saveEpisode(kv, updatedEpisode);

    // Update episode index
    const index = await getEpisodeIndex(kv);
    const entryIndex = index.findIndex(e => e.id === episodeId);

    if (entryIndex !== -1) {
        index[entryIndex] = {
            ...index[entryIndex],
            tags: tags.length > 0 ? tags : undefined,
        };

        await kv.put(KV_KEYS.episodeIndex, JSON.stringify(index), {
            expirationTtl: TTL.CONTENT,
        });
    }

    console.log(
        JSON.stringify({
            event: "episode_tags_updated",
            episodeId,
            tags,
        })
    );
}
```

**Update `listEpisodes` function (lines 258-303):**

Find this section:
```typescript
export async function listEpisodes(
    kv: KVNamespace,
    options?: {
        page?: number;
        pageSize?: number;
        search?: string;
    }
): Promise<PaginatedEpisodes> {
```

Change to:
```typescript
export async function listEpisodes(
    kv: KVNamespace,
    options?: {
        page?: number;
        pageSize?: number;
        search?: string;
        tag?: string; // NEW: Filter by tag
    }
): Promise<PaginatedEpisodes> {
    const page = Math.max(1, options?.page ?? 1);
    const pageSize = options?.pageSize ?? 10;
    const search = options?.search?.toLowerCase().trim();
    const tagFilter = options?.tag?.toLowerCase().trim(); // NEW

    // ... existing code to read index ...

    // Filter by search query and/or tag
    let filtered = index;

    if (search) {
        filtered = filtered.filter(
            (ep) =>
                ep.podcastName.toLowerCase().includes(search) ||
                ep.episodeTitle.toLowerCase().includes(search)
        );
    }

    // NEW: Tag filtering
    if (tagFilter) {
        filtered = filtered.filter(
            (ep) => ep.tags?.includes(tagFilter)
        );
    }

    // ... rest of function remains the same ...
}
```

**Why:**
- `updateEpisodeTags` ensures both Episode and EpisodeIndexEntry stay in sync
- Tag filtering in `listEpisodes` is simple array filtering (efficient since we read full index anyway)
- No new KV keys needed (tags stored inline)

---

### Step 6: UI Styling

**File:** `src/lib/styles.ts`

**Where to add:** After line 307 (after the `.badge` styles)

**Code:**
```typescript
/* ============================================================================
   Episode Tags
   ============================================================================ */

.tag-badge {
    display: inline-flex;
    align-items: center;
    padding: 0.25rem 0.625rem;
    font-size: 0.75rem;
    font-weight: 500;
    background-color: rgba(59, 130, 246, 0.15);
    color: #60a5fa;
    border: 1px solid rgba(59, 130, 246, 0.3);
    border-radius: 9999px;
    transition: background-color 0.2s ease, border-color 0.2s ease, color 0.2s ease;
    cursor: pointer;
    text-decoration: none;
}

.tag-badge:hover {
    background-color: rgba(59, 130, 246, 0.25);
    border-color: rgba(59, 130, 246, 0.5);
    color: #93c5fd;
}

.tag-badge-selected {
    background-color: #3b82f6;
    color: white;
    border-color: #3b82f6;
}

.tag-badge-selected:hover {
    background-color: #2563eb;
    border-color: #2563eb;
}

.tag-filter-bar {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    margin-bottom: 1.5rem;
    padding: 1rem;
    background-color: var(--card);
    border: 1px solid var(--border);
    border-radius: var(--radius);
}

.tag-filter-label {
    font-size: 0.875rem;
    font-weight: 500;
    color: var(--muted-foreground);
    margin-right: 0.5rem;
    display: flex;
    align-items: center;
}

.tag-editor {
    margin-top: 1rem;
    padding: 1rem;
    background-color: var(--background);
    border: 1px solid var(--border);
    border-radius: var(--radius);
}

.tag-editor-tags {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    margin-top: 0.75rem;
}

.tag-editor-badge {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    padding: 0.375rem 0.625rem;
    font-size: 0.75rem;
    font-weight: 500;
    background-color: var(--muted);
    color: var(--foreground);
    border: 1px solid var(--border);
    border-radius: 9999px;
    cursor: pointer;
    transition: background-color 0.2s ease, border-color 0.2s ease;
}

.tag-editor-badge:hover {
    background-color: var(--accent);
    border-color: var(--muted-foreground);
}

.tag-editor-badge.selected {
    background-color: rgba(59, 130, 246, 0.2);
    border-color: #3b82f6;
    color: #60a5fa;
}

.tag-editor-badge.selected:hover {
    background-color: rgba(59, 130, 246, 0.3);
}

.tag-editor-message {
    font-size: 0.75rem;
    padding: 0.5rem;
    border-radius: 0.25rem;
    margin-top: 0.5rem;
}

.tag-editor-message.alert-success {
    background-color: rgba(34, 197, 94, 0.1);
    color: #22c55e;
    border: 1px solid rgba(34, 197, 94, 0.3);
}

.tag-editor-message.alert-error {
    background-color: rgba(239, 68, 68, 0.1);
    color: #ef4444;
    border: 1px solid rgba(239, 68, 68, 0.3);
}
```

**Design notes:**
- Blue color scheme (`#60a5fa`, `#3b82f6`) distinguishes tags from gray template badges
- Pill-shaped badges with rounded corners
- Hover states for interactivity
- Selected state for active tag filter
- Editor styles for admin tag editing interface

---

### Step 7: Home Page Updates

**File:** `src/routes/public.ts`

#### 7.1 Add imports

Add after line 24:
```typescript
import { getValidTags, isValidTag } from "../lib/constants";
```

#### 7.2 Update `EpisodeCard` function

Find the `EpisodeCard` function (lines 215-246) and update it:

```typescript
function EpisodeCard(
    episode: EpisodeIndexEntry,
    summaryTemplates: string[],
    currentTag?: string // NEW: Currently filtered tag
): string {
    const templateBadges = summaryTemplates
        .map((templateId) => {
            const template = getTemplate(templateId);
            const name = template?.name || templateId;
            return `<span class="badge">${escapeHtml(name)}</span>`;
        })
        .join("");

    // NEW: Render tag badges
    const tagBadges = episode.tags && episode.tags.length > 0
        ? episode.tags
            .map((tag) => {
                const isSelected = currentTag === tag;
                const badgeClass = isSelected ? "tag-badge tag-badge-selected" : "tag-badge";
                // stopPropagation prevents card click when clicking tag
                return `<a href="/?tag=${encodeURIComponent(tag)}" class="${badgeClass}" onclick="event.stopPropagation()">${escapeHtml(tag)}</a>`;
            })
            .join("")
        : "";

    return `
        <a href="/episode/${escapeHtml(episode.id)}" class="episode-card">
            <div class="episode-card-content">
                <div class="episode-podcast">${escapeHtml(episode.podcastName)}</div>
                <h3 class="episode-title">${escapeHtml(episode.episodeTitle)}</h3>
                <div class="episode-meta">
                    <span>${formatDate(episode.episodeDate)}</span>
                    <span class="meta-dot">•</span>
                    <span>${formatDuration(episode.episodeDuration)}</span>
                </div>
                ${tagBadges || templateBadges ? `<div class="episode-badges">
                    ${tagBadges}
                    ${tagBadges && templateBadges ? '<span class="meta-dot" style="margin: 0 0.25rem;">•</span>' : ''}
                    ${templateBadges}
                </div>` : ""}
            </div>
            <div class="episode-card-arrow">
                <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>
                </svg>
            </div>
        </a>
    `;
}
```

**Key points:**
- Tags render before template badges
- `onclick="event.stopPropagation()"` prevents card click when clicking a tag
- Card remains fully clickable for episode navigation
- Currently selected tag highlighted with `tag-badge-selected` class

#### 7.3 Update home route (`GET /`)

Find the home route handler (starts around line 316). Make these changes:

**Parse tag parameter:**
```typescript
publicRoutes.get("/", async (c) => {
    // Parse query params
    const pageParam = c.req.query("page");
    const page = Math.max(1, parseInt(pageParam || "1", 10) || 1);
    const pageSize = 10;
    const search = c.req.query("q") || "";
    const tagFilter = c.req.query("tag") || ""; // NEW

    // Validate tag if provided
    const isValidTagFilter = tagFilter ? isValidTag(tagFilter) : true;
    if (tagFilter && !isValidTagFilter) {
        // Invalid tag - redirect to home without tag filter
        return c.redirect("/");
    }
```

**Pass tag to listEpisodes:**
```typescript
    const [activeJobs, paginatedEpisodes] = await Promise.all([
        listActiveJobsWithDO(c.env, c.env.TLDL_DATA),
        listEpisodes(c.env.TLDL_DATA, {
            page,
            pageSize,
            search: search || undefined,
            tag: tagFilter || undefined, // NEW
        }),
    ]);
```

**Pass tag to EpisodeCard:**
```typescript
    const episodeCards = await Promise.all(
        episodes.map(async (episode) => {
            const summaries = await listSummariesForEpisode(
                c.env.TLDL_DATA,
                episode.id
            );
            const templateIds = summaries.map((s) => s.templateId);
            return EpisodeCard(episode, templateIds, tagFilter || undefined); // NEW
        })
    );
```

**Add tag filter bar:**

Add this before the episode list (after search form, before in-progress section):

```typescript
    // NEW: Build tag filter bar
    const allTags = getValidTags();
    const tagFilterBar = `
        <div class="tag-filter-bar">
            <span class="tag-filter-label">
                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="margin-right: 0.375rem;">
                    <path d="M4 7V4h16v3M9 20h6M12 4v16"/>
                </svg>
                Filter by topic:
            </span>
            ${tagFilter ? `<a href="/" class="tag-badge tag-badge-selected">
                ${escapeHtml(tagFilter)}
                <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="margin-left: 0.25rem;">
                    <path d="M18 6 6 18"/><path d="m6 6 12 12"/>
                </svg>
            </a>` : ""}
            ${allTags.map(tag => {
                if (tag === tagFilter) return ""; // Already shown as selected
                return `<a href="/?tag=${encodeURIComponent(tag)}" class="tag-badge">${escapeHtml(tag)}</a>`;
            }).join("")}
        </div>
    `;
```

Then include `${tagFilterBar}` in the HTML content after the search form.

**Update pagination links:**
```typescript
    const paginationParams = (pg: number) => {
        const params = new URLSearchParams();
        params.set("page", String(pg));
        if (search) params.set("q", search);
        if (tagFilter) params.set("tag", tagFilter); // NEW
        return params.toString();
    };
```

**Update empty states:**
```typescript
${search && episodes.length === 0 ? `
<div class="empty-state">
    <p>No episodes found matching "${escapeHtml(search)}"${tagFilter ? ` with tag "${escapeHtml(tagFilter)}"` : ""}</p>
    <a href="/" class="button">Clear Filters</a>
</div>
` : tagFilter && episodes.length === 0 ? `
<div class="empty-state">
    <p>No episodes found with tag "${escapeHtml(tagFilter)}"</p>
    <a href="/" class="button">Clear Filter</a>
</div>
` : ""}
```

#### 7.4 Update episode detail page

Find the episode detail route (`GET /episode/:episodeId`, starts around line 481).

Add tags to episode metadata (around line 616, in the `episode-meta` div):

```typescript
                ${episode.tags && episode.tags.length > 0 ? `
                <span class="meta-dot">•</span>
                <div style="display: inline-flex; gap: 0.375rem;">
                    ${episode.tags.map(tag =>
                        `<a href="/?tag=${encodeURIComponent(tag)}" class="tag-badge" style="text-decoration: none;">${escapeHtml(tag)}</a>`
                    ).join('')}
                </div>
                ` : ""}
```

---

### Step 8: Admin Tag Editing

**File:** `src/routes/authenticated.ts`

#### 8.1 Add imports

Add after line 35:
```typescript
import { getValidTags, validateTags, isValidTag } from "../lib/constants";
import { updateEpisodeTags } from "../lib/kv";
```

#### 8.2 Add tag update endpoint

Add after line 573 (before the `/submit` endpoint):

```typescript
// ============================================================================
// POST /episode/:episodeId/update-tags - Update episode tags (admin only)
// ============================================================================

authenticated.post("/episode/:episodeId/update-tags", async (c) => {
    // Auth check - reject unauthorized requests in production
    const authError = await requireAuth(c);
    if (authError) return authError;

    // Admin-only check
    const userEmail = c.get("userEmail");
    if (!isAdminUser(userEmail)) {
        return c.json({ error: "Admin access required" }, 403);
    }

    const episodeId = c.req.param("episodeId");

    // Parse request body
    let body: { tags: string[] };
    try {
        body = await c.req.json();
    } catch {
        return c.json({ error: "Invalid JSON body" }, 400);
    }

    if (!Array.isArray(body.tags)) {
        return c.json({ error: "tags must be an array" }, 400);
    }

    // Validate tags
    const validation = validateTags(body.tags);
    if (validation.invalid.length > 0) {
        return c.json({
            error: `Invalid tags: ${validation.invalid.join(', ')}`,
            validTags: getValidTags(),
        }, 400);
    }

    // Enforce 2-4 tags
    if (validation.valid.length < 2 || validation.valid.length > 4) {
        return c.json({
            error: "Must provide between 2 and 4 tags",
            provided: validation.valid.length,
        }, 400);
    }

    // Verify episode exists
    const episode = await getEpisode(c.env.TLDL_DATA, episodeId);
    if (!episode) {
        return c.json({ error: "Episode not found" }, 404);
    }

    // Update tags
    try {
        await updateEpisodeTags(c.env.TLDL_DATA, episodeId, validation.valid);
        return c.json({
            success: true,
            tags: validation.valid,
        });
    } catch (error) {
        return c.json({
            error: error instanceof Error ? error.message : "Failed to update tags",
        }, 500);
    }
});
```

#### 8.3 Update profile page

Find the profile page route (`GET /profile`, starts around line 276).

**Update episode card rendering** (around line 332):

Replace the episode card HTML with this version that includes tag editor:

```typescript
            return `
                <div class="episode-card" data-episode-id="${escapeHtml(episode.id)}">
                    <div class="episode-card-content">
                        <div class="episode-podcast">${escapeHtml(episode.podcastName)}</div>
                        <h3 class="episode-title">
                            <a href="/episode/${escapeHtml(episode.id)}">${escapeHtml(episode.episodeTitle)}</a>
                        </h3>
                        <div class="episode-meta">
                            <span>${formatDate(episode.episodeDate)}</span>
                            <span class="meta-dot">•</span>
                            <span>${formatDuration(episode.episodeDuration)}</span>
                        </div>
                        ${templateBadges ? `<div class="episode-badges">${templateBadges}</div>` : ""}
                        ${isAdmin ? `
                        <div class="tag-editor" data-episode-id="${escapeHtml(episode.id)}">
                            <div style="display: flex; justify-content: space-between; align-items: center;">
                                <label class="form-label" style="margin: 0;">Tags:</label>
                                <button type="button" class="button button-sm" onclick="saveTagsFor('${escapeHtml(episode.id)}')">
                                    Save Tags
                                </button>
                            </div>
                            <div class="tag-editor-tags">
                                ${getValidTags().map(tag => {
                                    const isSelected = episode.tags?.includes(tag);
                                    return `<button
                                        type="button"
                                        class="tag-editor-badge ${isSelected ? 'selected' : ''}"
                                        data-tag="${escapeHtml(tag)}"
                                        onclick="toggleTag(this, '${escapeHtml(episode.id)}')"
                                    >
                                        ${escapeHtml(tag)}
                                    </button>`;
                                }).join('')}
                            </div>
                            <div class="tag-editor-message" id="tag-message-${escapeHtml(episode.id)}" style="display: none;"></div>
                        </div>
                        ` : episode.tags && episode.tags.length > 0 ? `
                        <div style="margin-top: 0.75rem;">
                            <span style="font-size: 0.75rem; color: var(--muted-foreground); margin-right: 0.5rem;">Tags:</span>
                            ${episode.tags.map(tag => `<span class="badge">${escapeHtml(tag)}</span>`).join(' ')}
                        </div>
                        ` : ''}
                    </div>
                    <button type="button" class="button button-destructive button-sm" onclick="confirmDelete('${escapeHtml(episode.id)}', '${escapeHtml(episode.episodeTitle.replace(/'/g, "\\'"))}')">
                        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>
                        </svg>
                        Delete
                    </button>
                </div>
            `;
```

**Add JavaScript functions** (in the existing `<script>` tag, after the `confirmDelete` function and before the closing `</script>` tag):

```javascript
            function toggleTag(button, episodeId) {
                button.classList.toggle('selected');
            }

            async function saveTagsFor(episodeId) {
                const editor = document.querySelector(`[data-episode-id="${episodeId}"] .tag-editor`);
                const selectedButtons = editor.querySelectorAll('.tag-editor-badge.selected');
                const tags = Array.from(selectedButtons).map(btn => btn.getAttribute('data-tag'));
                const messageEl = document.getElementById(`tag-message-${episodeId}`);

                // Validate count
                if (tags.length < 2 || tags.length > 4) {
                    messageEl.className = 'tag-editor-message alert-error';
                    messageEl.textContent = `Please select 2-4 tags (currently ${tags.length} selected)`;
                    messageEl.style.display = 'block';
                    return;
                }

                try {
                    const response = await fetch(`/episode/${episodeId}/update-tags`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        credentials: 'include',
                        body: JSON.stringify({ tags }),
                    });

                    const data = await response.json();

                    if (response.ok) {
                        messageEl.className = 'tag-editor-message alert-success';
                        messageEl.textContent = 'Tags updated successfully!';
                        messageEl.style.display = 'block';
                        setTimeout(() => {
                            messageEl.style.display = 'none';
                        }, 3000);
                    } else {
                        messageEl.className = 'tag-editor-message alert-error';
                        messageEl.textContent = data.error || 'Failed to update tags';
                        messageEl.style.display = 'block';
                    }
                } catch (err) {
                    messageEl.className = 'tag-editor-message alert-error';
                    messageEl.textContent = 'Failed to save tags';
                    messageEl.style.display = 'block';
                }
            }
```

---

### Step 9: Backfill Strategy

**File:** `src/routes/authenticated.ts`

#### 9.1 Add backfill endpoint

Add this new admin endpoint (can go after the rebuild-index endpoint):

```typescript
// ============================================================================
// POST /admin/backfill-tags - Generate tags for episodes without them
// ============================================================================

authenticated.post("/admin/backfill-tags", async (c) => {
    const authError = await requireAuth(c);
    if (authError) return authError;

    const userEmail = c.get("userEmail");
    if (!isAdminUser(userEmail)) {
        return c.json({ error: "Admin access required" }, 403);
    }

    try {
        // Get all episodes from index
        // Note: This processes up to 1000 episodes. If you have more,
        // consider implementing pagination or increasing the limit.
        const allEpisodes = await listEpisodes(c.env.TLDL_DATA, {
            pageSize: 1000
        });

        // Filter to episodes without tags
        const episodesNeedingTags = allEpisodes.episodes.filter(
            ep => !ep.tags || ep.tags.length === 0
        );

        let processed = 0;
        let tagged = 0;
        let failed = 0;

        // Process in batches
        for (const ep of episodesNeedingTags) {
            try {
                processed++;

                // Read existing data from KV
                const [transcript, summary] = await Promise.all([
                    getTranscript(c.env.TLDL_DATA, ep.id),
                    getSummary(c.env.TLDL_DATA, ep.id, "key-takeaways"), // Use default template
                ]);

                if (!transcript || !summary) {
                    console.log(`Skipping ${ep.id}: missing transcript or summary`);
                    failed++;
                    continue;
                }

                // Generate tags
                const tagResult = await generateEpisodeTags(
                    summary.text,
                    transcript.text,
                    c.env.OPENAI_API_KEY
                );

                if (tagResult.tags.length === 0) {
                    console.log(`Warning: No tags generated for ${ep.id}`);
                    failed++;
                    continue;
                }

                // Update episode with tags
                await updateEpisodeTags(c.env.TLDL_DATA, ep.id, tagResult.tags);
                tagged++;

                console.log(
                    JSON.stringify({
                        event: "episode_tagged",
                        episodeId: ep.id,
                        tags: tagResult.tags,
                    })
                );
            } catch (error) {
                console.error(
                    JSON.stringify({
                        event: "backfill_failed",
                        episodeId: ep.id,
                        error: error instanceof Error ? error.message : "Unknown error",
                    })
                );
                failed++;
            }
        }

        return c.json({
            success: true,
            message: `Processed ${processed} episodes: ${tagged} tagged, ${failed} failed`,
            processed,
            tagged,
            failed,
            totalEpisodes: allEpisodes.episodes.length,
        });
    } catch (error) {
        return c.json(
            {
                error: error instanceof Error ? error.message : "Failed to backfill tags",
            },
            500
        );
    }
});
```

#### 9.2 Add backfill button to profile page

In the Admin Tools section of the profile page (around line 393), add this button:

```html
<button onclick="backfillTags()" class="button" style="margin-top: 1rem;">
    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M4 7V4h16v3M9 20h6M12 4v16"/>
    </svg>
    Backfill Tags for All Episodes
</button>
<div id="backfill-status" style="display: none; margin-top: 1rem;"></div>
```

#### 9.3 Add backfill JavaScript

Add this function to the profile page `<script>` tag:

```javascript
            async function backfillTags() {
                if (!confirm('Generate tags for all episodes without tags? This may take a few minutes and will use OpenAI API credits.')) {
                    return;
                }

                const button = event.target.closest('button');
                const statusEl = document.getElementById('backfill-status');

                // Show loading state
                button.disabled = true;
                button.innerHTML = '<span class="spinner"></span> Processing...';
                statusEl.style.display = 'block';
                statusEl.className = 'alert alert-info';
                statusEl.textContent = 'Generating tags for episodes...';

                try {
                    const response = await fetch('/admin/backfill-tags', {
                        method: 'POST',
                        credentials: 'include',
                    });

                    const data = await response.json();

                    if (response.ok) {
                        statusEl.className = 'alert alert-success';
                        statusEl.textContent = `Success! ${data.message}`;

                        // Reload page after 2 seconds to show new tags
                        setTimeout(() => {
                            window.location.reload();
                        }, 2000);
                    } else {
                        statusEl.className = 'alert alert-error';
                        statusEl.textContent = `Error: ${data.error}`;
                        button.disabled = false;
                        button.innerHTML = 'Backfill Tags for All Episodes';
                    }
                } catch (err) {
                    statusEl.className = 'alert alert-error';
                    statusEl.textContent = 'Failed to backfill tags';
                    button.disabled = false;
                    button.innerHTML = 'Backfill Tags for All Episodes';
                }
            }
```

**Why this approach:**
- Reads existing transcripts and summaries from KV (no audio re-processing!)
- Much faster than queue processing
- Processes only episodes without tags
- Continues on individual failures
- Shows clear progress and results

---

## Testing Strategy

### Manual Testing Checklist

**After each step, verify:**

1. **Data model changes**
   - [ ] TypeScript compiles without errors
   - [ ] Existing episodes still load correctly

2. **Tag generation service**
   - [ ] Create unit test that calls `generateEpisodeTags()` with sample data
   - [ ] Verify it returns 2-4 valid tags
   - [ ] Test with empty/invalid tags to ensure non-critical failure

3. **Queue consumer**
   - [ ] Submit new episode
   - [ ] Check logs for "tags_generated" event
   - [ ] Verify episode has tags in KV
   - [ ] Verify episode index entry has tags

4. **Home page**
   - [ ] Tags display on episode cards
   - [ ] Clicking tag filters episodes
   - [ ] Tag filter bar appears
   - [ ] Currently selected tag is highlighted
   - [ ] Card click still navigates to episode (tags don't break it)
   - [ ] Pagination preserves tag filter
   - [ ] Search + tag filtering work together

5. **Episode detail page**
   - [ ] Tags display in metadata section
   - [ ] Tags are clickable and filter home page

6. **Admin tag editing**
   - [ ] Admin sees tag editor on profile page
   - [ ] Regular users see read-only tags
   - [ ] Toggle tag selection works
   - [ ] Save validates 2-4 tags
   - [ ] Success message appears
   - [ ] Tags update in KV and index

7. **Backfill**
   - [ ] Backfill button appears for admin
   - [ ] Confirmation modal shows
   - [ ] Processing status displays
   - [ ] Success shows count of tagged episodes
   - [ ] Episodes get tags without re-processing audio

### Integration Tests

Consider adding tests in `test/integration/`:

```typescript
describe("Episode Tagging", () => {
    it("should generate tags during episode processing", async () => {
        // Submit episode → verify tags in KV
    });

    it("should filter episodes by tag", async () => {
        // Create episodes with different tags
        // Fetch home page with tag filter
        // Verify only matching episodes returned
    });

    it("should update tags via admin endpoint", async () => {
        // POST to /episode/:id/update-tags
        // Verify episode and index updated
    });
});
```

---

## Deployment Checklist

### Pre-deployment

- [ ] All TypeScript compiles without errors
- [ ] Tests pass locally
- [ ] Manual testing complete (see checklist above)
- [ ] Review git diff for any unintended changes

### Deployment Steps

1. **Deploy backend first (no UI changes yet)**
   ```bash
   npm run deploy
   ```
   - Includes: type changes, constants, tag generation service, queue consumer
   - New episodes will get tags, but they won't display yet

2. **Verify backend**
   - Submit test episode
   - Check Wrangler logs: `npx wrangler tail`
   - Look for "tags_generated" event
   - Verify tags in KV via Wrangler dashboard

3. **Deploy UI updates**
   - If backend works, deploy UI changes
   - Home page, episode detail, profile page

4. **Verify UI**
   - Check tags display on cards
   - Test tag filtering
   - Test admin tag editing
   - Test backfill (on test episodes first)

### Post-deployment

- [ ] Monitor logs for tag generation errors
- [ ] Check OpenAI API usage (tags add minimal cost)
- [ ] Optionally run backfill for existing episodes
- [ ] Monitor user feedback

### Rollback Plan

If issues occur:
1. Tags are optional fields - existing code continues to work
2. Can disable tag generation in queue consumer (comment out Step 4.5)
3. Can hide tags in UI (comment out tag rendering)
4. Full rollback: `git revert` and redeploy

---

## Cost Considerations

**OpenAI API Usage:**
- Tag generation uses GPT-5.2 Responses API
- Input: ~8000 chars transcript + ~500 chars summary = ~8500 chars
- Cost: Negligible compared to transcription ($0.06/minute) and summarization
- Estimated: <$0.01 per episode for tag generation

**Backfill:**
- 100 episodes × $0.01 = ~$1.00
- Much cheaper than re-transcribing

---

## Future Enhancements

**Not in scope for initial implementation:**

1. **Multi-tag filtering** - Show episodes matching ALL selected tags
2. **Tag analytics** - Most popular tags, tag co-occurrence
3. **User-suggested tags** - Allow users to suggest new tags
4. **Tag descriptions** - Hover tooltips explaining each tag
5. **Related episodes** - "More episodes like this" based on tags
6. **RSS feed tags** - Include tags in RSS/API responses
7. **Tag-based notifications** - Alert users when new episodes match their favorite tags

---

## Post-Implementation Tasks

### Update CLAUDE.md

After implementation is complete, update CLAUDE.md with:

1. **KV Storage Schema section** - Add note that tags are stored inline in Episode and EpisodeIndexEntry (no separate keys)

2. **Routes section** - Add to Authenticated routes:
   - `POST /episode/:id/update-tags` - Update episode tags (admin only)
   - `POST /admin/backfill-tags` - Generate tags for episodes without them (admin only)

3. **Key Components section** - Add note about tag generation in queue consumer:
   - Tag generation happens after summarization using GPT-5.2 Responses API
   - Non-critical: empty tags don't fail jobs
   - Tags stored in both Episode and EpisodeIndexEntry for filtering

4. **Architecture Overview** - Update Queue Consumer flow to include tag generation step

### Create Test Files

Add these new test files:
- `test/tag-generation.test.ts` - Unit tests for tag service
- `test/tag-filtering.test.ts` - Tests for filtering logic

---

## Known Limitations

1. **Backfill batch size:** The backfill endpoint processes up to 1000 episodes in a single request. If you have more episodes, you'll need to run it multiple times or increase the pageSize limit.

2. **Backfill timeout:** Processing many episodes synchronously could hit Worker timeout limits (CPU time limits). For large backlogs (>100 episodes), consider running backfill during low-traffic periods or implementing a queue-based approach.

3. **Tag count in filter bar:** Currently doesn't show how many episodes have each tag. This could be added as a future enhancement.

---

## Questions & Decisions

### Resolved

✅ **Where to generate tags?** - In queue consumer after summarization
✅ **What to use for tag generation?** - Summary + transcript excerpt
✅ **How to handle tag changes?** - Admin editing via profile page
✅ **How to handle existing episodes?** - Backfill from existing transcripts/summaries
✅ **How many tags?** - 2-4 per episode
✅ **Clickable cards?** - Use `stopPropagation()` on tag links
✅ **Which API/model?** - GPT-5.2 Responses API

### Open Questions

- Should we allow 1 tag minimum instead of 2? (Currently 2-4 required)
- Should backfill process all episodes or only untagged ones? (Currently only untagged)
- Should we show tag count on tag filter bar? (e.g., "psychology (12)")
- Should backfill be queue-based for large datasets (>100 episodes)?

---

## Contact & Support

**Implementation Support:**
- Review this document before starting each step
- Check CLAUDE.md for project structure and patterns
- Run `npm test` frequently to catch issues early
- Use `npx wrangler tail` to monitor production logs

**Code Review:**
- Each step can be committed separately for easier review
- Follow existing code style (see summarization.ts for API patterns)
- Add JSDoc comments to new functions

---

**Last Updated:** 2025-12-21
**Next Review:** After implementation complete
