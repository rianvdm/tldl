# YouTube URL Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add YouTube URL support to tldl so users can submit a YouTube video link and receive an AI-generated summary using the video's captions as the transcript source.

**Architecture:** URL type detection routes YouTube submissions through a new `youtube.ts` service that fetches the YouTube watch page, extracts metadata and captions from embedded JSON blobs, and returns a plain-text transcript directly to the queue consumer — skipping the RSS and transcription steps. Type changes rename `appleUrl` to `sourceUrl` across the codebase with a backwards-compat shim in KV read paths.

**Tech Stack:** TypeScript, Cloudflare Workers, Hono, KV, Cloudflare Queues, Vitest (with `@cloudflare/vitest-pool-workers`)

**Spec:** `docs/superpowers/specs/2026-03-18-youtube-support-design.md`

---

## File Map

| File | Action | Purpose |
|------|--------|---------|
| `src/lib/url-parser.ts` | Modify | Add `parseYouTubeUrl()` and `detectUrlType()` |
| `test/url-parser.test.ts` | Modify | Tests for new URL parser functions |
| `src/types/index.ts` | Modify | Rename `appleUrl→sourceUrl`, add `sourceType`, `YouTubeEpisodeData`, extend `TranscriptSource` |
| `src/lib/constants.ts` | Modify | Add `FETCH_FAILED` error code |
| `src/lib/errors.ts` | Modify | Add `FETCH_FAILED` to `ERROR_MESSAGES` and `ERROR_HTTP_STATUS`; update `INVALID_URL` message |
| `src/lib/kv.ts` | Modify | Backwards-compat shim on all deserialization points including `rebuildEpisodeIndex` |
| `test/kv.test.ts` | Modify | Update fixtures to use `sourceUrl`/`sourceType`, add shim tests |
| `src/lib/queue.ts` | Modify | Update `createProcessEpisodeMessage` to use `sourceUrl`, `sourceType`, `videoId` |
| `src/services/youtube.ts` | Create | Watch page fetch, metadata + caption extraction |
| `test/youtube.test.ts` | Create | Tests for YouTube service with mocked fetch |
| `src/queue/consumer.ts` | Modify | Add YouTube routing in `processEpisode()` |
| `src/routes/admin.ts` | Modify | Episode submission POST: URL type detection, `episodeId` derivation, job/queue creation |
| `src/routes/public.ts` | Modify | Episode display page: conditional icon/link based on `sourceType` |

---

## Task 1: URL Parser — `parseYouTubeUrl` and `detectUrlType`

**Files:**
- Modify: `src/lib/url-parser.ts`
- Modify: `test/url-parser.test.ts`

- [ ] **Step 1: Write failing tests for `parseYouTubeUrl` and `detectUrlType`**

Add to `test/url-parser.test.ts`:

```typescript
import {
    parseApplePodcastsUrl,
    parseYouTubeUrl,
    detectUrlType,
    deriveEpisodeId,
    type ParsedAppleUrl,
} from "../src/lib/url-parser";

describe("parseYouTubeUrl", () => {
    describe("valid URLs", () => {
        it("should parse a youtube.com/watch URL", () => {
            const result = parseYouTubeUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
            expect(result).toEqual({ videoId: "dQw4w9WgXcQ" });
        });

        it("should parse a youtu.be short URL", () => {
            const result = parseYouTubeUrl("https://youtu.be/dQw4w9WgXcQ");
            expect(result).toEqual({ videoId: "dQw4w9WgXcQ" });
        });

        it("should parse a youtu.be URL with share params", () => {
            const result = parseYouTubeUrl("https://youtu.be/a2aYd-XHzsI?si=Ix4VfQJ5GnX8VnN5");
            expect(result).toEqual({ videoId: "a2aYd-XHzsI" });
        });

        it("should parse a youtube.com/shorts URL", () => {
            const result = parseYouTubeUrl("https://www.youtube.com/shorts/dQw4w9WgXcQ");
            expect(result).toEqual({ videoId: "dQw4w9WgXcQ" });
        });

        it("should parse a youtube.com/watch URL without www", () => {
            const result = parseYouTubeUrl("https://youtube.com/watch?v=dQw4w9WgXcQ");
            expect(result).toEqual({ videoId: "dQw4w9WgXcQ" });
        });
    });

    describe("invalid URLs", () => {
        it("should return null for Apple Podcasts URLs", () => {
            expect(parseYouTubeUrl("https://podcasts.apple.com/us/podcast/test/id123?i=456")).toBeNull();
        });

        it("should return null for random URLs", () => {
            expect(parseYouTubeUrl("https://example.com/watch?v=dQw4w9WgXcQ")).toBeNull();
        });

        it("should return null for youtube.com without video ID", () => {
            expect(parseYouTubeUrl("https://www.youtube.com/channel/UCtest")).toBeNull();
        });

        it("should return null for empty string", () => {
            expect(parseYouTubeUrl("")).toBeNull();
        });

        it("should return null for null/undefined", () => {
            expect(parseYouTubeUrl(null as unknown as string)).toBeNull();
            expect(parseYouTubeUrl(undefined as unknown as string)).toBeNull();
        });
    });
});

describe("detectUrlType", () => {
    it("should return 'apple' for Apple Podcasts episode URLs", () => {
        expect(detectUrlType("https://podcasts.apple.com/us/podcast/test/id123?i=456")).toBe("apple");
    });

    it("should return 'youtube' for YouTube watch URLs", () => {
        expect(detectUrlType("https://www.youtube.com/watch?v=dQw4w9WgXcQ")).toBe("youtube");
    });

    it("should return 'youtube' for youtu.be URLs", () => {
        expect(detectUrlType("https://youtu.be/dQw4w9WgXcQ")).toBe("youtube");
    });

    it("should return 'unknown' for Spotify URLs", () => {
        expect(detectUrlType("https://open.spotify.com/episode/abc123")).toBe("unknown");
    });

    it("should return 'unknown' for empty string", () => {
        expect(detectUrlType("")).toBe("unknown");
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /Users/rian/Documents/GitHub/tldl && npx vitest run test/url-parser.test.ts 2>&1 | tail -20
```

Expected: FAIL — `parseYouTubeUrl is not exported`, `detectUrlType is not exported`

- [ ] **Step 3: Implement `parseYouTubeUrl` and `detectUrlType` in `src/lib/url-parser.ts`**

Add after the existing functions:

```typescript
/**
 * Result of parsing a YouTube URL
 */
export interface ParsedYouTubeUrl {
    videoId: string;
}

/**
 * Parse a YouTube URL and extract the video ID.
 *
 * Accepts:
 * - https://www.youtube.com/watch?v=VIDEO_ID
 * - https://youtu.be/VIDEO_ID
 * - https://www.youtube.com/shorts/VIDEO_ID
 */
export function parseYouTubeUrl(url: string): ParsedYouTubeUrl | null {
    if (!url || typeof url !== "string") {
        return null;
    }

    try {
        const parsed = new URL(url);
        const hostname = parsed.hostname.replace(/^www\./, "");

        if (hostname === "youtube.com") {
            if (parsed.pathname === "/watch") {
                const videoId = parsed.searchParams.get("v");
                if (videoId && /^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
                    return { videoId };
                }
            }
            const shortsMatch = parsed.pathname.match(/^\/shorts\/([a-zA-Z0-9_-]{11})\/?$/);
            if (shortsMatch) {
                return { videoId: shortsMatch[1] };
            }
        }

        if (hostname === "youtu.be") {
            const videoId = parsed.pathname.slice(1).split("/")[0];
            if (videoId && /^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
                return { videoId };
            }
        }

        return null;
    } catch {
        return null;
    }
}

/**
 * Detect the type of a submitted URL.
 *
 * @returns "apple" | "youtube" | "unknown"
 */
export function detectUrlType(url: string): "apple" | "youtube" | "unknown" {
    if (parseApplePodcastsUrl(url)) return "apple";
    if (parseYouTubeUrl(url)) return "youtube";
    return "unknown";
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd /Users/rian/Documents/GitHub/tldl && npx vitest run test/url-parser.test.ts 2>&1 | tail -20
```

Expected: all tests PASS

- [ ] **Step 5: Commit**

```bash
cd /Users/rian/Documents/GitHub/tldl && git add src/lib/url-parser.ts test/url-parser.test.ts && git commit -m "feat: add YouTube URL parsing and detectUrlType"
```

---

## Task 2: Type Changes

**Files:**
- Modify: `src/types/index.ts`
- Modify: `src/lib/constants.ts`
- Modify: `src/lib/errors.ts`

No new tests — TypeScript compilation verifies correctness. Downstream compile errors will surface in Tasks 3–6 and are expected until those files are updated.

- [ ] **Step 1: Rename `appleUrl` → `sourceUrl`, add `sourceType` to `Job`**

In `src/types/index.ts`, update the `Job` interface:

```typescript
export interface Job {
    id: string;
    episodeId: string;
    sourceUrl: string;                    // renamed from appleUrl
    sourceType: "apple" | "youtube";      // new
    status: JobStatus;
    templateId: string;
    error?: string;
    estimatedSeconds?: number;
    podcastName?: string;
    episodeTitle?: string;
    createdAt: string;
    updatedAt: string;
}
```

- [ ] **Step 2: Update `Episode`, `TranscriptSource`, `QueueMessage`, add `YouTubeEpisodeData`**

```typescript
export interface Episode {
    id: string;
    sourceUrl: string;                    // renamed from appleUrl
    sourceType: "apple" | "youtube";      // new
    podcastName: string;
    episodeTitle: string;
    episodeDuration: number;
    episodeDate: string;
    audioUrl?: string;                    // now optional (empty for YouTube)
    transcriptSource: TranscriptSource;
    createdAt: string;
    expiresAt: string;
    submittedBy?: string;
    tags?: string[];
    podcastAuthor?: string;
    podcastWebsiteUrl?: string;
}

// Update TranscriptSource union
export type TranscriptSource = "apple" | "rss" | "openai" | "youtube";

// Update QueueMessage
export interface QueueMessage {
    type: QueueMessageType;
    jobId: string;
    episodeId: string;
    sourceUrl: string;                    // renamed from appleUrl
    sourceType: "apple" | "youtube";      // new
    videoId?: string;                     // populated for YouTube jobs
    templateId: string;
    episodeGuid?: string;
    expectedTitle?: string;
    expectedDate?: string;
    submittedBy?: string;
}

// Add new type
export interface YouTubeEpisodeData {
    videoTitle: string;
    channelName: string;
    durationSeconds: number;
    publishDate: string;    // YYYY-MM-DD (no time precision from YouTube watch page)
    transcriptText: string; // plain text from captions
}
```

- [ ] **Step 3: Add `FETCH_FAILED` to `src/lib/constants.ts`**

Open `src/lib/constants.ts` and look for the `ERROR_CODES` object. Add `FETCH_FAILED`:

```typescript
export const ERROR_CODES = {
    // ... existing codes ...
    FETCH_FAILED: "FETCH_FAILED",
} as const;
```

- [ ] **Step 4: Add `FETCH_FAILED` to `src/lib/errors.ts` and update `INVALID_URL` message**

Open `src/lib/errors.ts` and find the `ERROR_MESSAGES` and `ERROR_HTTP_STATUS` maps. Add entries for `FETCH_FAILED` and update the `INVALID_URL` message:

```typescript
// In ERROR_MESSAGES:
FETCH_FAILED: "Could not load the video. It may be private, unavailable, or region-restricted.",
// Update existing:
INVALID_URL: "Please enter an Apple Podcasts episode URL or a YouTube video URL.",

// In ERROR_HTTP_STATUS:
FETCH_FAILED: 502,
```

- [ ] **Step 5: Check TypeScript compile errors (expected in other files)**

```bash
cd /Users/rian/Documents/GitHub/tldl && npx tsc --noEmit 2>&1 | head -40
```

Expected: errors in `kv.ts`, `queue.ts`, `consumer.ts`, `admin.ts`, `public.ts`, `kv.test.ts` — these are expected and will be fixed in subsequent tasks.

- [ ] **Step 6: Commit**

```bash
cd /Users/rian/Documents/GitHub/tldl && git add src/types/index.ts src/lib/constants.ts src/lib/errors.ts && git commit -m "feat: add sourceUrl/sourceType types, YouTubeEpisodeData, FETCH_FAILED error code"
```

---

## Task 3: KV Backwards-Compat Shim

**Files:**
- Modify: `src/lib/kv.ts`
- Modify: `test/kv.test.ts`

- [ ] **Step 1: Update `test/kv.test.ts` fixtures and add shim tests**

Update the `createSampleJob` and `createSampleEpisode` helpers to use `sourceUrl`/`sourceType`:

```typescript
function createSampleJob(overrides: Partial<Job> = {}): Job {
    return {
        id: "job-123",
        episodeId: "podcast_episode",
        sourceUrl: "https://podcasts.apple.com/us/podcast/test/id123?i=456",
        sourceType: "apple",
        status: "queued",
        templateId: "key-takeaways",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        ...overrides,
    };
}

function createSampleEpisode(overrides: Partial<Episode> = {}): Episode {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000);
    return {
        id: "123_456",
        sourceUrl: "https://podcasts.apple.com/us/podcast/test/id123?i=456",
        sourceType: "apple",
        podcastName: "Test Podcast",
        episodeTitle: "Test Episode",
        episodeDuration: 2700,
        episodeDate: "2024-01-15",
        audioUrl: "https://example.com/audio.mp3",
        transcriptSource: "rss",
        createdAt: now.toISOString(),
        expiresAt: expiresAt.toISOString(),
        ...overrides,
    };
}
```

Then add backwards-compat shim tests:

```typescript
describe("backwards compat: appleUrl → sourceUrl", () => {
    it("should read legacy Episode records that have appleUrl instead of sourceUrl", async () => {
        const legacyRecord = {
            id: "legacy_episode",
            appleUrl: "https://podcasts.apple.com/us/podcast/test/id123?i=456",
            podcastName: "Legacy Podcast",
            episodeTitle: "Legacy Episode",
            episodeDuration: 3600,
            episodeDate: "2024-01-01",
            audioUrl: "https://example.com/audio.mp3",
            transcriptSource: "rss",
            createdAt: new Date().toISOString(),
            expiresAt: new Date().toISOString(),
        };
        await env.TLDL_DATA.put("episode:legacy_episode", JSON.stringify(legacyRecord));

        const episode = await getEpisode(env.TLDL_DATA, "legacy_episode");
        expect(episode).not.toBeNull();
        expect(episode!.sourceUrl).toBe("https://podcasts.apple.com/us/podcast/test/id123?i=456");
        expect(episode!.sourceType).toBe("apple");
    });

    it("should prefer sourceUrl over appleUrl when both are present", async () => {
        const record = {
            id: "both_fields",
            sourceUrl: "https://new-source-url.com",
            appleUrl: "https://old-apple-url.com",
            sourceType: "apple",
            podcastName: "Test",
            episodeTitle: "Test",
            episodeDuration: 1800,
            episodeDate: "2024-01-01",
            audioUrl: "https://example.com/audio.mp3",
            transcriptSource: "rss",
            createdAt: new Date().toISOString(),
            expiresAt: new Date().toISOString(),
        };
        await env.TLDL_DATA.put("episode:both_fields", JSON.stringify(record));

        const episode = await getEpisode(env.TLDL_DATA, "both_fields");
        expect(episode!.sourceUrl).toBe("https://new-source-url.com");
    });
});
```

- [ ] **Step 2: Run tests to see current failures**

```bash
cd /Users/rian/Documents/GitHub/tldl && npx vitest run test/kv.test.ts 2>&1 | tail -20
```

- [ ] **Step 3: Apply the shim in `src/lib/kv.ts` at all deserialization points**

Find every `JSON.parse(raw)` or `JSON.parse(data)` cast to `Episode` or `Job`. Apply the shim at **each** location. The key functions to update are:

- `getEpisode` — reads a single episode
- `getJob` — reads a single job
- `listEpisodes` — reads all episodes from the index
- `rebuildEpisodeIndex` — reads all episodes to rebuild the index (important: this must also get the shim, otherwise index rebuilds will produce records without `sourceUrl`)

Pattern for Episode deserialization:

```typescript
const rawRecord = JSON.parse(raw) as any;
const episode: Episode = {
    ...rawRecord,
    sourceUrl: rawRecord.sourceUrl ?? rawRecord.appleUrl,
    sourceType: rawRecord.sourceType ?? "apple",
};
```

Pattern for Job deserialization:

```typescript
const rawRecord = JSON.parse(raw) as any;
const job: Job = {
    ...rawRecord,
    sourceUrl: rawRecord.sourceUrl ?? rawRecord.appleUrl,
    sourceType: rawRecord.sourceType ?? "apple",
};
```

Also ensure all **writes** use `sourceUrl` (not `appleUrl`). Search for `appleUrl` in `kv.ts` and rename all occurrences.

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd /Users/rian/Documents/GitHub/tldl && npx vitest run test/kv.test.ts 2>&1 | tail -20
```

Expected: all tests PASS including the new shim tests

- [ ] **Step 5: Commit**

```bash
cd /Users/rian/Documents/GitHub/tldl && git add src/lib/kv.ts test/kv.test.ts && git commit -m "feat: KV backwards-compat shim for appleUrl → sourceUrl migration"
```

---

## Task 4: Update Queue Message Constructor

**Files:**
- Modify: `src/lib/queue.ts`

The `createProcessEpisodeMessage` function in `queue.ts` builds `QueueMessage` objects. It needs to accept and pass through `sourceUrl`, `sourceType`, and `videoId`.

- [ ] **Step 1: Read the current `createProcessEpisodeMessage` signature**

```bash
cd /Users/rian/Documents/GitHub/tldl && grep -n "createProcessEpisodeMessage\|appleUrl" src/lib/queue.ts
```

- [ ] **Step 2: Update the function signature and body**

Replace `appleUrl` with `sourceUrl` in the function parameter and the returned object. Add `sourceType` and `videoId` as parameters:

```typescript
// Before (approximate — match the actual existing signature)
export function createProcessEpisodeMessage(params: {
    jobId: string;
    episodeId: string;
    appleUrl: string;
    templateId: string;
    // ...
}): QueueMessage

// After
export function createProcessEpisodeMessage(params: {
    jobId: string;
    episodeId: string;
    sourceUrl: string;
    sourceType: "apple" | "youtube";
    videoId?: string;
    templateId: string;
    // ... (keep any other existing params)
}): QueueMessage
```

- [ ] **Step 3: Check TypeScript compiles cleanly for this file**

```bash
cd /Users/rian/Documents/GitHub/tldl && npx tsc --noEmit 2>&1 | grep "queue.ts"
```

Expected: no errors in `queue.ts`

- [ ] **Step 4: Commit**

```bash
cd /Users/rian/Documents/GitHub/tldl && git add src/lib/queue.ts && git commit -m "feat: update queue message constructor for sourceUrl/sourceType/videoId"
```

---

## Task 5: YouTube Service

**Files:**
- Create: `src/services/youtube.ts`
- Create: `test/youtube.test.ts`

- [ ] **Step 1: Write failing tests**

Create `test/youtube.test.ts`:

```typescript
/**
 * Tests for YouTube service
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fetchYouTubeEpisodeData, parseCaptionXml } from "../src/services/youtube";
import { AppError } from "../src/lib/errors";
import { ERROR_CODES } from "../src/lib/constants";

function makePlayerResponse(overrides: Record<string, unknown> = {}): string {
    const base = {
        videoDetails: {
            title: "Test Video Title",
            author: "Test Channel",
            lengthSeconds: "3600",
        },
        microformat: {
            playerMicroformatRenderer: {
                publishDate: "2024-01-15",
            },
        },
        captions: {
            playerCaptionsTracklistRenderer: {
                captionTracks: [
                    {
                        baseUrl: "https://www.youtube.com/api/timedtext?v=test&lang=en",
                        languageCode: "en",
                        kind: "asr",
                        name: { simpleText: "English (auto-generated)" },
                    },
                ],
            },
        },
        ...overrides,
    };
    return `var ytInitialPlayerResponse = ${JSON.stringify(base)};`;
}

const sampleCaptionXml = `<?xml version="1.0" encoding="utf-8" ?><transcript><text start="0.5" dur="2.3">Hello &amp; welcome</text><text start="3.0" dur="1.5"><b>to</b> this <c>video</c></text></transcript>`;

describe("fetchYouTubeEpisodeData", () => {
    beforeEach(() => {
        vi.stubGlobal("fetch", vi.fn());
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("should return metadata and transcript for a video with captions", async () => {
        const mockFetch = vi.fn()
            .mockResolvedValueOnce({ ok: true, text: async () => makePlayerResponse() })
            .mockResolvedValueOnce({ ok: true, text: async () => sampleCaptionXml });
        vi.stubGlobal("fetch", mockFetch);

        const result = await fetchYouTubeEpisodeData("testVideoId");

        expect(result.videoTitle).toBe("Test Video Title");
        expect(result.channelName).toBe("Test Channel");
        expect(result.durationSeconds).toBe(3600);
        expect(result.publishDate).toBe("2024-01-15");
        expect(result.transcriptText).toContain("Hello & welcome");
        expect(result.transcriptText).toContain("to this");
        expect(result.transcriptText).not.toContain("<b>");
        expect(result.transcriptText).not.toContain("<c>");
        expect(result.transcriptText).not.toContain("&amp;");
    });

    it("should prefer manually-uploaded track over auto-generated", async () => {
        const playerResponse = makePlayerResponse({
            captions: {
                playerCaptionsTracklistRenderer: {
                    captionTracks: [
                        {
                            baseUrl: "https://youtube.com/timedtext?lang=en&kind=asr",
                            languageCode: "en",
                            kind: "asr",
                            name: { simpleText: "English (auto-generated)" },
                        },
                        {
                            baseUrl: "https://youtube.com/timedtext?lang=en-US",
                            languageCode: "en-US",
                            name: { simpleText: "English (United States)" },
                        },
                    ],
                },
            },
        });

        const mockFetch = vi.fn()
            .mockResolvedValueOnce({ ok: true, text: async () => playerResponse })
            .mockResolvedValueOnce({ ok: true, text: async () => sampleCaptionXml });
        vi.stubGlobal("fetch", mockFetch);

        await fetchYouTubeEpisodeData("testVideoId");

        const captionFetchUrl = mockFetch.mock.calls[1][0] as string;
        expect(captionFetchUrl).toContain("en-US");
        expect(captionFetchUrl).not.toContain("kind=asr");
    });

    it("should throw FETCH_FAILED if page cannot be parsed", async () => {
        vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
            ok: true,
            text: async () => "<html>Some page without player response</html>",
        }));

        await expect(fetchYouTubeEpisodeData("badVideoId"))
            .rejects.toMatchObject({ code: ERROR_CODES.FETCH_FAILED });
    });

    it("should throw TRANSCRIPTION_FAILED if no captionTracks present", async () => {
        const playerResponse = makePlayerResponse({
            captions: {
                playerCaptionsTracklistRenderer: { captionTracks: [] },
            },
        });
        vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
            ok: true,
            text: async () => playerResponse,
        }));

        await expect(fetchYouTubeEpisodeData("noCaptionsId"))
            .rejects.toMatchObject({ code: ERROR_CODES.TRANSCRIPTION_FAILED });
    });

    it("should throw TRANSCRIPTION_FAILED if caption fetch fails", async () => {
        const mockFetch = vi.fn()
            .mockResolvedValueOnce({ ok: true, text: async () => makePlayerResponse() })
            .mockResolvedValueOnce({ ok: false, status: 403, text: async () => "Forbidden" });
        vi.stubGlobal("fetch", mockFetch);

        await expect(fetchYouTubeEpisodeData("expiredCaptionId"))
            .rejects.toMatchObject({ code: ERROR_CODES.TRANSCRIPTION_FAILED });
    });
});

describe("parseCaptionXml", () => {
    it("should strip XML tags and decode HTML entities", () => {
        const xml = `<transcript><text start="0">Hello &amp; world</text><text start="1"><b>bold</b> and <c>timed</c></text></transcript>`;
        const result = parseCaptionXml(xml);
        expect(result).toBe("Hello & world bold and timed");
    });

    it("should handle empty transcript", () => {
        expect(parseCaptionXml("<transcript></transcript>")).toBe("");
    });

    it("should strip <font> tags", () => {
        const xml = `<transcript><text start="0"><font color="#ccc">colored text</font></text></transcript>`;
        expect(parseCaptionXml(xml)).toBe("colored text");
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /Users/rian/Documents/GitHub/tldl && npx vitest run test/youtube.test.ts 2>&1 | tail -20
```

Expected: FAIL — `fetchYouTubeEpisodeData is not defined`

- [ ] **Step 3: Implement `src/services/youtube.ts`**

```typescript
/**
 * YouTube Service
 *
 * Fetches video metadata and captions from the YouTube watch page.
 * No API key required — extracts data from embedded JSON blobs.
 */

import { AppError } from "../lib/errors";
import { ERROR_CODES } from "../lib/constants";
import { withRetry, isServerError } from "../lib/retry";
import type { YouTubeEpisodeData } from "../types";

const BROWSER_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
};

/**
 * Fetch YouTube video metadata and captions from the watch page.
 *
 * @param videoId - YouTube video ID (e.g. "dQw4w9WgXcQ")
 * @throws AppError FETCH_FAILED if page cannot be parsed or video is unavailable
 * @throws AppError TRANSCRIPTION_FAILED if no captions available or caption fetch fails
 */
export async function fetchYouTubeEpisodeData(videoId: string): Promise<YouTubeEpisodeData> {
    const watchUrl = `https://www.youtube.com/watch?v=${videoId}`;

    const html = await withRetry(
        async () => {
            const response = await fetch(watchUrl, { headers: BROWSER_HEADERS });
            if (!response.ok) {
                throw new Error(`YouTube page fetch failed: HTTP ${response.status}`);
            }
            return response.text();
        },
        { maxRetries: 2, baseDelayMs: 2000, shouldRetry: isServerError }
    );

    const playerResponse = extractPlayerResponse(html);
    if (!playerResponse || !playerResponse.videoDetails) {
        throw new AppError(
            ERROR_CODES.FETCH_FAILED,
            "Could not load video data. The video may be private, unavailable, or region-restricted."
        );
    }

    const { videoDetails, microformat, captions } = playerResponse;

    const videoTitle = videoDetails.title ?? "Unknown Title";
    const channelName = videoDetails.author ?? "Unknown Channel";
    const durationSeconds = parseInt(videoDetails.lengthSeconds ?? "0", 10);
    const publishDate = microformat?.playerMicroformatRenderer?.publishDate
        ?? new Date().toISOString().split("T")[0];

    const captionTracks: CaptionTrack[] =
        captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];

    if (captionTracks.length === 0) {
        throw new AppError(
            ERROR_CODES.TRANSCRIPTION_FAILED,
            "This video doesn't have captions available. Only videos with captions can be processed."
        );
    }

    const captionTrack = selectBestCaptionTrack(captionTracks);
    const transcriptText = await fetchCaptionText(captionTrack.baseUrl);

    return { videoTitle, channelName, durationSeconds, publishDate, transcriptText };
}

// ============================================================================
// Internal types
// ============================================================================

interface CaptionTrack {
    baseUrl: string;
    languageCode: string;
    kind?: string;
    name?: { simpleText?: string };
}

interface PlayerResponse {
    videoDetails?: { title?: string; author?: string; lengthSeconds?: string };
    microformat?: { playerMicroformatRenderer?: { publishDate?: string } };
    captions?: { playerCaptionsTracklistRenderer?: { captionTracks?: CaptionTrack[] } };
}

// ============================================================================
// Internal helpers
// ============================================================================

function extractPlayerResponse(html: string): PlayerResponse | null {
    const match = html.match(/var ytInitialPlayerResponse\s*=\s*(\{.+?\});\s*(?:var|<\/script>)/s);
    if (!match) return null;
    try {
        return JSON.parse(match[1]) as PlayerResponse;
    } catch {
        return null;
    }
}

function selectBestCaptionTrack(tracks: CaptionTrack[]): CaptionTrack {
    const englishTracks = tracks.filter((t) => t.languageCode.startsWith("en"));
    const searchSet = englishTracks.length > 0 ? englishTracks : tracks;
    const manual = searchSet.find((t) => !t.kind || t.kind !== "asr");
    return manual ?? searchSet[0];
}

async function fetchCaptionText(baseUrl: string): Promise<string> {
    let response: Response;
    try {
        response = await fetch(baseUrl, { headers: BROWSER_HEADERS });
    } catch {
        throw new AppError(
            ERROR_CODES.TRANSCRIPTION_FAILED,
            "Could not retrieve captions for this video."
        );
    }
    if (!response.ok) {
        throw new AppError(
            ERROR_CODES.TRANSCRIPTION_FAILED,
            "Could not retrieve captions for this video."
        );
    }
    const xml = await response.text();
    return parseCaptionXml(xml);
}

/**
 * Parse YouTube caption XML into plain text.
 * Strips all XML/HTML tags (including <c>, <font>), decodes HTML entities.
 */
export function parseCaptionXml(xml: string): string {
    const textMatches = [...xml.matchAll(/<text[^>]*>([\s\S]*?)<\/text>/g)];
    if (textMatches.length === 0) return "";

    const segments = textMatches.map((m) => {
        let text = m[1];
        text = text.replace(/<[^>]+>/g, "");
        text = text
            .replace(/&amp;/g, "&")
            .replace(/&lt;/g, "<")
            .replace(/&gt;/g, ">")
            .replace(/&quot;/g, '"')
            .replace(/&#39;/g, "'")
            .replace(/&apos;/g, "'");
        return text.trim();
    });

    return segments.filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd /Users/rian/Documents/GitHub/tldl && npx vitest run test/youtube.test.ts 2>&1 | tail -30
```

Expected: all tests PASS

- [ ] **Step 5: Commit**

```bash
cd /Users/rian/Documents/GitHub/tldl && git add src/services/youtube.ts test/youtube.test.ts && git commit -m "feat: add YouTube service for metadata and caption extraction"
```

---

## Task 6: Queue Consumer Routing

**Files:**
- Modify: `src/queue/consumer.ts`
- Modify: `test/consumer.test.ts`

Note: `regenerateSummary` does NOT need changes — it only uses `episodeId` and `templateId`, both of which are source-agnostic.

Note: `getPodcastList` groups episodes by podcast. YouTube episodes use `yt_{videoId}` IDs which `extractPodcastId` cannot parse, so they will be excluded from the podcast browse page. This is expected and intentional for this iteration.

- [ ] **Step 1: Read the consumer test to understand mock patterns**

```bash
cd /Users/rian/Documents/GitHub/tldl && head -100 test/consumer.test.ts
```

- [ ] **Step 2: Update `ProcessingContext` in `consumer.ts`**

```typescript
interface ProcessingContext {
    env: Env;
    jobId: string;
    episodeId: string;
    sourceUrl: string;                  // renamed from appleUrl
    sourceType: "apple" | "youtube";    // new
    videoId?: string;                   // new, populated for YouTube jobs
    templateId: string;
    episodeGuid?: string;
    expectedTitle?: string;
    expectedDate?: string;
    submittedBy?: string;
}
```

- [ ] **Step 3: Update `processMessage` to populate context from new fields**

```typescript
const context: ProcessingContext = {
    env,
    jobId: msg.jobId,
    episodeId: msg.episodeId,
    sourceUrl: msg.sourceUrl,
    sourceType: msg.sourceType,
    videoId: msg.videoId,
    templateId: msg.templateId,
    episodeGuid: msg.episodeGuid,
    expectedTitle: msg.expectedTitle,
    expectedDate: msg.expectedDate,
    submittedBy: msg.submittedBy,
};
```

- [ ] **Step 4: Add YouTube routing at top of `processEpisode`**

After the fast-path check (existing episode + transcript) and before the Apple metadata fetch, add:

```typescript
// YouTube path: fetch metadata + captions directly, skip Apple and RSS steps
if (ctx.sourceType === "youtube") {
    await processYouTubeEpisode(ctx);
    return;
}
```

- [ ] **Step 5: Add `processYouTubeEpisode` function**

Add after `processEpisode`. Import `fetchYouTubeEpisodeData` at the top of the file:

```typescript
import { fetchYouTubeEpisodeData } from "../services/youtube";
```

```typescript
async function processYouTubeEpisode(ctx: ProcessingContext): Promise<void> {
    const { env, jobId, episodeId, sourceUrl, videoId, templateId, submittedBy } = ctx;
    const kv = env.TLDL_DATA;

    if (!videoId) {
        throw new AppError(ERROR_CODES.INVALID_URL, "Missing videoId for YouTube job");
    }

    // Step 1: Fetch metadata and captions
    await updateJobStatusBoth(env, kv, jobId, "fetching_metadata");
    await updateJobEstimateBoth(env, kv, jobId, 60);

    const youtubeData = await fetchYouTubeEpisodeData(videoId);

    await updateJobMetadataDO(env, jobId, youtubeData.channelName, youtubeData.videoTitle);
    await updateJobMetadata(kv, jobId, youtubeData.channelName, youtubeData.videoTitle);

    // Step 2: Store transcript
    const transcript: Transcript = {
        episodeId,
        text: youtubeData.transcriptText,
        source: "youtube",
        createdAt: new Date().toISOString(),
    };
    await saveTranscript(kv, transcript);

    // Step 3: Generate summary
    await updateJobStatusBoth(env, kv, jobId, "summarizing");
    await updateJobEstimateBoth(env, kv, jobId, 30);

    const summaryResult = await generateSummary(
        youtubeData.transcriptText,
        templateId,
        env.OPENAI_API_KEY
    );

    const summary: Summary = {
        episodeId,
        templateId,
        text: summaryResult.text,
        model: summaryResult.model,
        createdAt: new Date().toISOString(),
    };
    await saveSummary(kv, summary);

    // Step 4: Save episode
    const now = new Date();
    const expiresAt = new Date(now);
    expiresAt.setDate(expiresAt.getDate() + 365);

    const episode: Episode = {
        id: episodeId,
        sourceUrl,
        sourceType: "youtube",
        podcastName: youtubeData.channelName,
        episodeTitle: youtubeData.videoTitle,
        episodeDuration: youtubeData.durationSeconds,
        episodeDate: youtubeData.publishDate,
        transcriptSource: "youtube",
        createdAt: now.toISOString(),
        expiresAt: expiresAt.toISOString(),
        submittedBy,
    };
    await saveEpisode(kv, episode);

    await addToEpisodeIndex(kv, {
        id: episode.id,
        podcastName: episode.podcastName,
        episodeTitle: episode.episodeTitle,
        episodeDate: episode.episodeDate,
        episodeDuration: episode.episodeDuration,
        createdAt: episode.createdAt,
        expiresAt: episode.expiresAt,
    });

    await updateJobStatusBoth(env, kv, jobId, "completed");
}
```

- [ ] **Step 6: Fix remaining `appleUrl` references in `consumer.ts`**

```bash
cd /Users/rian/Documents/GitHub/tldl && grep -n "appleUrl" src/queue/consumer.ts
```

Rename each occurrence to `sourceUrl`.

- [ ] **Step 7: Run all tests**

```bash
cd /Users/rian/Documents/GitHub/tldl && npx vitest run 2>&1 | tail -30
```

Expected: all tests PASS

- [ ] **Step 8: Commit**

```bash
cd /Users/rian/Documents/GitHub/tldl && git add src/queue/consumer.ts test/consumer.test.ts && git commit -m "feat: add YouTube routing in queue consumer"
```

---

## Task 7: UI Changes

**Files:**
- Modify: `src/routes/admin.ts` — episode submission POST handler (URL validation, job creation, queue send)
- Modify: `src/routes/public.ts` — episode display page (conditional icon/link)

- [ ] **Step 1: Find the submission POST handler in `admin.ts`**

```bash
cd /Users/rian/Documents/GitHub/tldl && grep -n "parseApplePodcastsUrl\|appleUrl\|episodeId\|TLDL_QUEUE" src/routes/admin.ts | head -30
```

This will show you the lines where URL parsing, `episodeId` derivation, and queue send happen.

- [ ] **Step 2: Update imports in `admin.ts`**

Add `detectUrlType` and `parseYouTubeUrl` to the imports from `../lib/url-parser`.

- [ ] **Step 3: Replace Apple-only URL validation with `detectUrlType`**

Find the block that calls `parseApplePodcastsUrl` and returns an error if null. Replace:

```typescript
// Before
const parsed = parseApplePodcastsUrl(url);
if (!parsed) {
    return c.html(renderError("Please enter a valid Apple Podcasts episode URL."), 400);
}
const episodeId = deriveEpisodeId(parsed.podcastId, parsed.episodeId);
// ... creates job with appleUrl: url ...

// After
const urlType = detectUrlType(url);
if (urlType === "unknown") {
    return c.html(renderError("Please enter an Apple Podcasts episode URL or a YouTube video URL."), 400);
}

let episodeId: string;
let videoId: string | undefined;

if (urlType === "apple") {
    const parsed = parseApplePodcastsUrl(url)!;
    episodeId = deriveEpisodeId(parsed.podcastId, parsed.episodeId);
} else {
    // youtube
    const parsed = parseYouTubeUrl(url)!;
    videoId = parsed.videoId;
    episodeId = `yt_${parsed.videoId}`;
}
```

- [ ] **Step 4: Update job creation in `admin.ts` to use `sourceUrl`/`sourceType`**

Find where the `Job` object is constructed (it will have `appleUrl`). Update:

```typescript
// Before
appleUrl: url,

// After
sourceUrl: url,
sourceType: urlType as "apple" | "youtube",
```

- [ ] **Step 5: Update queue message send in `admin.ts`**

Find where `createProcessEpisodeMessage` (or direct queue send) is called. Pass `sourceUrl`, `sourceType`, and `videoId`:

```typescript
// Add videoId to the queue message params for YouTube jobs
videoId,  // undefined for Apple, set for YouTube
sourceUrl: url,
sourceType: urlType as "apple" | "youtube",
```

- [ ] **Step 6: Update the form `<input>` placeholder in `admin.ts`**

Find the `<input>` element for URL submission and update `placeholder`:

```html
<!-- Before -->
placeholder="https://podcasts.apple.com/..."

<!-- After -->
placeholder="Apple Podcasts or YouTube URL"
```

- [ ] **Step 7: Update episode display page in `public.ts`**

Find the section in `public.ts` that renders the "Listen on Apple Podcasts" link. Make it conditional on `sourceType`:

```typescript
// YouTube SVG icon (YouTube brand guidelines)
const YouTubeIcon = html`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z"/></svg>`;

// Conditional source link
const sourceLink = episode.sourceType === "youtube"
    ? html`<a href="${escapeHtml(episode.sourceUrl)}" target="_blank" rel="noopener noreferrer">${YouTubeIcon} Watch on YouTube</a>`
    : html`<a href="${escapeHtml(episode.sourceUrl ?? episode.appleUrl ?? '')}" target="_blank" rel="noopener noreferrer">${ApplePodcastsIcon} Listen on Apple Podcasts</a>`;
```

Note: use `episode.sourceUrl` (the renamed field). The `escapeHtml` function is already imported in `public.ts`.

- [ ] **Step 8: Check TypeScript compiles cleanly**

```bash
cd /Users/rian/Documents/GitHub/tldl && npx tsc --noEmit 2>&1
```

Expected: no errors

- [ ] **Step 9: Run full test suite**

```bash
cd /Users/rian/Documents/GitHub/tldl && npx vitest run 2>&1 | tail -20
```

Expected: all tests PASS

- [ ] **Step 10: Commit**

```bash
cd /Users/rian/Documents/GitHub/tldl && git add src/routes/admin.ts src/routes/public.ts && git commit -m "feat: update submission form and episode page for YouTube URL support"
```

---

## Task 8: Final Check and Deploy

- [ ] **Step 1: Run full test suite**

```bash
cd /Users/rian/Documents/GitHub/tldl && npx vitest run 2>&1
```

Expected: all tests PASS, zero failures

- [ ] **Step 2: Deploy to production**

```bash
cd /Users/rian/Documents/GitHub/tldl && npx wrangler deploy
```

- [ ] **Step 3: Manual smoke tests on live app**

Test these URLs through the live submission form:

| URL | Expected result |
|-----|----------------|
| `https://youtu.be/a2aYd-XHzsI?si=Ix4VfQJ5GnX8VnN5` | Processes successfully, shows YouTube icon |
| `https://youtu.be/BlGLp_cmgKo?si=H_qJDs1B2aFLPOn2` | Processes successfully, shows YouTube icon |
| Any Apple Podcasts episode URL | Works as before, shows Apple icon |
| `https://open.spotify.com/episode/abc123` | Shows updated error message |

- [ ] **Step 4: Close GitHub issue**

```bash
gh issue close 16 --repo rianvdm/tldl --comment "Implemented. Captions-only for this iteration; audio transcription fallback for videos without captions is tracked as future work."
```

- [ ] **Step 5: Push to GitHub**

```bash
cd /Users/rian/Documents/GitHub/tldl && git push
```
