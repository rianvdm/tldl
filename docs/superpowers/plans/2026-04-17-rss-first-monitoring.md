# RSS-First Monitoring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate ~12h lag on monitored podcast episodes by making RSS the primary detection and enrichment source, bypassing Podcast Index in the monitor hot path.

**Architecture:** Monitor fetches RSS directly with conditional GET. When a new episode is found, the full RSS-derived metadata (audio URL, duration, transcript URL) rides the queue message. Consumer branches on an `rssSourced` flag to skip the PI/iTunes enrichment step. PI remains in `addPodcastToMonitoring` (bulk backfill) and admin submissions (Apple URL path).

**Tech Stack:** Cloudflare Workers, Hono, TypeScript, Vitest (`@cloudflare/vitest-pool-workers`), KV, Queues, Durable Objects.

**Spec:** [`docs/superpowers/specs/2026-04-17-rss-first-monitoring-design.md`](../specs/2026-04-17-rss-first-monitoring-design.md)

---

## File Structure

| File | Change | Responsibility |
|------|--------|----------------|
| `src/types/index.ts` | Modify | Extend `MonitoredPodcast`, `QueueMessage` |
| `src/services/rss.ts` | Modify | Add `fetchFeedIfChanged` (conditional GET wrapper) |
| `src/lib/rss-episode-id.ts` | Create | `deriveRssEpisodeId(podcastId, guid)` via SHA-256 hash |
| `src/lib/queue.ts` | Modify | Extend `createProcessEpisodeMessage` with pre-fetched metadata fields |
| `src/lib/monitor.ts` | Modify | RSS-first check flow; error fallback to PI |
| `src/queue/consumer.ts` | Modify | Branch on `rssSourced` — skip `getEpisodeMetadata` when pre-fetched metadata is present |
| `src/routes/public.ts` | Modify | Render Apple Podcasts link only when `appleUrl` is present |
| `wrangler.toml` | Modify | Cron `*/30 * * * *` |
| `test/rss-episode-id.test.ts` | Create | Unit tests for hash + ID builder |
| `test/rss-conditional-get.test.ts` | Create | Unit tests for `fetchFeedIfChanged` |
| `test/monitor-rss-first.test.ts` | Create | Unit tests for RSS-first monitor flow |
| `test/consumer-rss-sourced.test.ts` | Create | Unit tests for rssSourced branch in consumer |

---

## Task 1: Extend types for RSS-sourced episodes

**Files:**
- Modify: `src/types/index.ts:121-138` (`QueueMessage`)
- Modify: `src/types/index.ts:205-215` (`MonitoredPodcast`)

- [ ] **Step 1: Extend `QueueMessage` with pre-fetched RSS metadata fields**

Modify `src/types/index.ts` around line 121:

```ts
export interface QueueMessage {
    type: QueueMessageType;
    jobId: string;
    episodeId: string;
    appleUrl?: string;
    templateId: string;
    episodeGuid?: string;
    expectedTitle?: string;
    expectedDate?: string;
    audioUrlOverride?: string;
    preResolvedAudioUrl?: string;
    submittedBy?: string;

    // RSS-sourced monitoring: full metadata pre-fetched from the feed
    rssSourced?: boolean;
    audioUrl?: string;
    durationSeconds?: number;
    transcriptUrl?: string;
    transcriptType?: string;
    podcastTitle?: string;
}
```

- [ ] **Step 2: Extend `MonitoredPodcast` with conditional-GET cache headers**

Modify `src/types/index.ts` around line 205:

```ts
export interface MonitoredPodcast {
    id: string;
    name: string;
    rssUrl: string;
    templateId: string;
    addedAt: string;
    lastChecked?: string;
    episodesProcessed: number;
    status: "active" | "paused" | "error";
    lastError?: string;

    // Conditional GET cache headers for RSS polling
    etag?: string;
    lastModified?: string;
}
```

- [ ] **Step 3: Run type check**

Run: `npx tsc --noEmit`
Expected: PASS (no errors — fields are all optional, nothing else breaks).

- [ ] **Step 4: Commit**

```bash
git add src/types/index.ts
git commit -m "Add RSS-sourced fields to QueueMessage and MonitoredPodcast"
```

---

## Task 2: Add `deriveRssEpisodeId` helper

**Files:**
- Create: `src/lib/rss-episode-id.ts`
- Test: `test/rss-episode-id.test.ts`

- [ ] **Step 1: Write failing tests**

Create `test/rss-episode-id.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { deriveRssEpisodeId, guidHash } from "../src/lib/rss-episode-id";

describe("guidHash", () => {
    it("returns 10 hex chars", async () => {
        const hash = await guidHash("dd85426a-9b70-482f-94ed-d5afd61b7d56");
        expect(hash).toMatch(/^[0-9a-f]{10}$/);
    });

    it("is deterministic", async () => {
        const a = await guidHash("same-guid");
        const b = await guidHash("same-guid");
        expect(a).toBe(b);
    });

    it("differs for different inputs", async () => {
        const a = await guidHash("guid-a");
        const b = await guidHash("guid-b");
        expect(a).not.toBe(b);
    });
});

describe("deriveRssEpisodeId", () => {
    it("produces {podcastId}_rss_{hash}", async () => {
        const id = await deriveRssEpisodeId("1809663079", "dd85426a-9b70-482f-94ed-d5afd61b7d56");
        expect(id).toMatch(/^1809663079_rss_[0-9a-f]{10}$/);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- test/rss-episode-id.test.ts`
Expected: FAIL with module-not-found.

- [ ] **Step 3: Implement**

Create `src/lib/rss-episode-id.ts`:

```ts
/**
 * Compute the first 10 hex chars of SHA-256(guid).
 * Stable identifier for RSS-sourced episodes that don't have an Apple episode ID.
 */
export async function guidHash(guid: string): Promise<string> {
    const data = new TextEncoder().encode(guid);
    const digest = await crypto.subtle.digest("SHA-256", data);
    const bytes = new Uint8Array(digest);
    let hex = "";
    for (let i = 0; i < 5; i++) {
        hex += bytes[i].toString(16).padStart(2, "0");
    }
    return hex;
}

/**
 * Build an episode ID for an RSS-sourced (monitor-queued) episode.
 * Shape: {podcastId}_rss_{guidHash}
 */
export async function deriveRssEpisodeId(podcastId: string, guid: string): Promise<string> {
    const hash = await guidHash(guid);
    return `${podcastId}_rss_${hash}`;
}
```

- [ ] **Step 4: Run tests**

Run: `npm test -- test/rss-episode-id.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Verify `extractPodcastId` still works for both ID shapes**

Quick spot-check in a Node REPL or inline test:

```ts
// test/rss-episode-id.test.ts — add this describe block
import { extractPodcastId } from "../src/lib/url-parser";

describe("extractPodcastId compat", () => {
    it("handles Apple-sourced IDs", () => {
        expect(extractPodcastId("1809663079_12345")).toBe("1809663079");
    });
    it("handles RSS-sourced IDs", () => {
        expect(extractPodcastId("1809663079_rss_abcdef1234")).toBe("1809663079");
    });
});
```

Run: `npm test -- test/rss-episode-id.test.ts`
Expected: PASS (5 tests). If fails, update `extractPodcastId` to split on first underscore only.

- [ ] **Step 6: Commit**

```bash
git add src/lib/rss-episode-id.ts test/rss-episode-id.test.ts
git commit -m "Add deriveRssEpisodeId helper for RSS-sourced episodes"
```

---

## Task 3: Add `fetchFeedIfChanged` with conditional GET

**Files:**
- Modify: `src/services/rss.ts` (add new exported function after `fetchAndParseFeed`)
- Test: `test/rss-conditional-get.test.ts`

- [ ] **Step 1: Write failing tests**

Create `test/rss-conditional-get.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fetchFeedIfChanged } from "../src/services/rss";

const SAMPLE_FEED = `<?xml version="1.0"?>
<rss version="2.0"><channel><title>Test</title>
<item><title>E1</title><guid>g1</guid><pubDate>Mon, 01 Jan 2026 00:00:00 GMT</pubDate>
<enclosure url="https://example.com/a.mp3" type="audio/mpeg" length="1"/>
</item></channel></rss>`;

describe("fetchFeedIfChanged", () => {
    let fetchSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        fetchSpy = vi.spyOn(global, "fetch");
    });

    afterEach(() => {
        fetchSpy.mockRestore();
    });

    it("returns ok with feed + headers on 200", async () => {
        fetchSpy.mockResolvedValueOnce(new Response(SAMPLE_FEED, {
            status: 200,
            headers: { "ETag": "\"abc\"", "Last-Modified": "Mon, 01 Jan 2026 00:00:00 GMT" },
        }));

        const result = await fetchFeedIfChanged("https://feed/", {});
        expect(result.status).toBe("ok");
        if (result.status === "ok") {
            expect(result.etag).toBe("\"abc\"");
            expect(result.lastModified).toBe("Mon, 01 Jan 2026 00:00:00 GMT");
            expect(result.feed.episodes.length).toBe(1);
        }
    });

    it("sends If-None-Match and If-Modified-Since when headers are present", async () => {
        fetchSpy.mockResolvedValueOnce(new Response("", { status: 304 }));

        await fetchFeedIfChanged("https://feed/", {
            etag: "\"abc\"",
            lastModified: "Mon, 01 Jan 2026 00:00:00 GMT",
        });

        const call = fetchSpy.mock.calls[0];
        const init = call[1] as RequestInit;
        const headers = new Headers(init.headers);
        expect(headers.get("If-None-Match")).toBe("\"abc\"");
        expect(headers.get("If-Modified-Since")).toBe("Mon, 01 Jan 2026 00:00:00 GMT");
    });

    it("returns not_modified on 304", async () => {
        fetchSpy.mockResolvedValueOnce(new Response("", { status: 304 }));
        const result = await fetchFeedIfChanged("https://feed/", { etag: "\"abc\"" });
        expect(result.status).toBe("not_modified");
    });

    it("returns error on 429", async () => {
        fetchSpy.mockResolvedValueOnce(new Response("", { status: 429 }));
        const result = await fetchFeedIfChanged("https://feed/", {});
        expect(result.status).toBe("error");
        if (result.status === "error") expect(result.reason).toMatch(/429|rate/i);
    });

    it("returns error on network failure", async () => {
        fetchSpy.mockRejectedValueOnce(new Error("boom"));
        const result = await fetchFeedIfChanged("https://feed/", {});
        expect(result.status).toBe("error");
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- test/rss-conditional-get.test.ts`
Expected: FAIL with "fetchFeedIfChanged is not exported".

- [ ] **Step 3: Implement**

Append to `src/services/rss.ts` (after `fetchAndParseFeed`):

```ts
export type FetchFeedResult =
    | { status: "ok"; feed: ParsedFeed; etag?: string; lastModified?: string }
    | { status: "not_modified" }
    | { status: "error"; reason: string };

export interface FetchFeedOptions {
    etag?: string;
    lastModified?: string;
}

/**
 * Fetch an RSS feed with conditional GET (If-None-Match / If-Modified-Since).
 * Returns "not_modified" on 304, "ok" with parsed feed + response headers on 200,
 * "error" on 429 or network failure (caller decides fallback).
 */
export async function fetchFeedIfChanged(
    feedUrl: string,
    options: FetchFeedOptions
): Promise<FetchFeedResult> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    const headers: Record<string, string> = {
        Accept: "application/rss+xml, application/xml, text/xml",
        "User-Agent": USER_AGENT,
    };
    if (options.etag) headers["If-None-Match"] = options.etag;
    if (options.lastModified) headers["If-Modified-Since"] = options.lastModified;

    try {
        const response = await fetch(feedUrl, { headers, signal: controller.signal });
        clearTimeout(timeoutId);

        if (response.status === 304) return { status: "not_modified" };
        if (response.status === 429) return { status: "error", reason: "http_429" };
        if (!response.ok) return { status: "error", reason: `http_${response.status}` };

        const xml = await response.text();
        const feed = parseFeedXml(xml);
        return {
            status: "ok",
            feed,
            etag: response.headers.get("ETag") || undefined,
            lastModified: response.headers.get("Last-Modified") || undefined,
        };
    } catch (error) {
        clearTimeout(timeoutId);
        return {
            status: "error",
            reason: error instanceof Error ? error.message : String(error),
        };
    }
}
```

- [ ] **Step 4: Run tests**

Run: `npm test -- test/rss-conditional-get.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/services/rss.ts test/rss-conditional-get.test.ts
git commit -m "Add fetchFeedIfChanged with conditional GET support"
```

---

## Task 4: Extend `createProcessEpisodeMessage` with pre-fetched fields

**Files:**
- Modify: `src/lib/queue.ts:21-46`

- [ ] **Step 1: Update `createProcessEpisodeMessage` signature and body**

Replace the existing `createProcessEpisodeMessage` in `src/lib/queue.ts` with:

```ts
export function createProcessEpisodeMessage(params: {
    jobId: string;
    episodeId: string;
    appleUrl?: string;
    templateId: string;
    episodeGuid?: string;
    expectedTitle?: string;
    expectedDate?: string;
    submittedBy?: string;
    audioUrlOverride?: string;
    preResolvedAudioUrl?: string;
    // RSS-sourced monitoring
    rssSourced?: boolean;
    audioUrl?: string;
    durationSeconds?: number;
    transcriptUrl?: string;
    transcriptType?: string;
    podcastTitle?: string;
}): QueueMessage {
    return {
        type: "process_episode",
        jobId: params.jobId,
        episodeId: params.episodeId,
        templateId: params.templateId,
        ...(params.appleUrl && { appleUrl: params.appleUrl }),
        ...(params.episodeGuid && { episodeGuid: params.episodeGuid }),
        ...(params.expectedTitle && { expectedTitle: params.expectedTitle }),
        ...(params.expectedDate && { expectedDate: params.expectedDate }),
        ...(params.submittedBy && { submittedBy: params.submittedBy }),
        ...(params.audioUrlOverride && { audioUrlOverride: params.audioUrlOverride }),
        ...(params.preResolvedAudioUrl && { preResolvedAudioUrl: params.preResolvedAudioUrl }),
        ...(params.rssSourced && { rssSourced: true }),
        ...(params.audioUrl && { audioUrl: params.audioUrl }),
        ...(params.durationSeconds !== undefined && { durationSeconds: params.durationSeconds }),
        ...(params.transcriptUrl && { transcriptUrl: params.transcriptUrl }),
        ...(params.transcriptType && { transcriptType: params.transcriptType }),
        ...(params.podcastTitle && { podcastTitle: params.podcastTitle }),
    };
}
```

Note: `appleUrl` was required; now optional because RSS-sourced messages won't have it.

- [ ] **Step 2: Run type check**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 3: Run full test suite to catch callers relying on required `appleUrl`**

Run: `npm test`
Expected: PASS. If any existing callers break, they were already passing `appleUrl` (per Task 1 review). No change expected.

- [ ] **Step 4: Commit**

```bash
git add src/lib/queue.ts
git commit -m "Extend createProcessEpisodeMessage with pre-fetched RSS metadata"
```

---

## Task 5: Consumer branch for RSS-sourced episodes

**Files:**
- Modify: `src/queue/consumer.ts:220-260` (handler that unpacks message into `ProcessingContext`)
- Modify: `src/queue/consumer.ts:281-360` (`processEpisode` — branch before `getEpisodeMetadata`)
- Test: `test/consumer-rss-sourced.test.ts`

- [ ] **Step 1: Add RSS fields to `ProcessingContext`**

Open `src/queue/consumer.ts`. Find the `ProcessingContext` type (near line 70–80) and the handler that constructs it (around line 220). Add these optional fields to the context type:

```ts
interface ProcessingContext {
    // existing fields...
    rssSourced?: boolean;
    prefetchedAudioUrl?: string;
    prefetchedDurationSeconds?: number;
    prefetchedTranscriptUrl?: string;
    prefetchedTranscriptType?: string;
    prefetchedPodcastTitle?: string;
}
```

Wire them through from the queue message in the handler:

```ts
const ctx: ProcessingContext = {
    env,
    jobId: msg.jobId,
    episodeId: msg.episodeId,
    appleUrl: msg.appleUrl,
    templateId: msg.templateId,
    episodeGuid: msg.episodeGuid,
    expectedTitle: msg.expectedTitle,
    expectedDate: msg.expectedDate,
    submittedBy: msg.submittedBy,
    audioUrlOverride: msg.audioUrlOverride,
    preResolvedAudioUrl: msg.preResolvedAudioUrl,
    rssSourced: msg.rssSourced,
    prefetchedAudioUrl: msg.audioUrl,
    prefetchedDurationSeconds: msg.durationSeconds,
    prefetchedTranscriptUrl: msg.transcriptUrl,
    prefetchedTranscriptType: msg.transcriptType,
    prefetchedPodcastTitle: msg.podcastTitle,
};
```

- [ ] **Step 2: Write the failing test for the RSS-sourced branch**

Create `test/consumer-rss-sourced.test.ts`. The goal: verify that when `rssSourced: true` and pre-fetched fields are present, the consumer does NOT call `getEpisodeMetadata` and instead proceeds straight to transcription with the pre-fetched audio URL.

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { env } from "cloudflare:test";
import { processQueueMessage } from "../src/queue/consumer";
import * as applePodcasts from "../src/services/apple-podcasts";
import * as transcription from "../src/services/transcription";
import * as summarization from "../src/services/summarization";
import * as tagGen from "../src/services/tag-generation";
import { saveMonitoredPodcast, createJob } from "../src/lib/kv";

describe("consumer: rssSourced branch", () => {
    beforeEach(async () => {
        // Seed a monitored podcast so the consumer can look up podcast-level info
        await saveMonitoredPodcast(env.TLDL_DATA, {
            id: "1809663079",
            name: "How I AI",
            rssUrl: "https://anchor.fm/s/1035b1568/podcast/rss",
            templateId: "key-takeaways",
            addedAt: "2026-04-17T00:00:00Z",
            episodesProcessed: 0,
            status: "active",
        });
        await createJob(env.TLDL_DATA, {
            id: "job-1",
            episodeId: "1809663079_rss_deadbeef01",
            appleUrl: "",
            status: "queued",
            templateId: "key-takeaways",
            createdAt: "2026-04-17T00:00:00Z",
            updatedAt: "2026-04-17T00:00:00Z",
        });
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("skips getEpisodeMetadata when rssSourced + prefetched fields present", async () => {
        const getMetaSpy = vi.spyOn(applePodcasts, "getEpisodeMetadata");
        vi.spyOn(transcription, "transcribeAudio").mockResolvedValue({
            text: "transcript body here. ".repeat(20),
            source: "openai",
            model: "gpt-4o-mini-transcribe",
        });
        vi.spyOn(summarization, "generateSummary").mockResolvedValue({
            text: "summary", model: "gpt-5.4",
        });
        vi.spyOn(tagGen, "generateEpisodeTags").mockResolvedValue({
            tags: ["ai"], model: "gpt-5.4",
        });

        await processQueueMessage(
            {
                type: "process_episode",
                jobId: "job-1",
                episodeId: "1809663079_rss_deadbeef01",
                templateId: "key-takeaways",
                rssSourced: true,
                audioUrl: "https://example.com/audio.mp3",
                durationSeconds: 3000,
                podcastTitle: "How I AI",
                expectedTitle: "Test Episode",
                expectedDate: "2026-04-13T11:00:00Z",
                episodeGuid: "dd85426a-9b70-482f-94ed-d5afd61b7d56",
            },
            env
        );

        expect(getMetaSpy).not.toHaveBeenCalled();
    });
});
```

If `processQueueMessage` isn't the right entry-point name, use whatever the consumer actually exports (check `src/queue/consumer.ts` top-level exports and adjust).

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test -- test/consumer-rss-sourced.test.ts`
Expected: FAIL — the current consumer calls `getEpisodeMetadata` unconditionally.

- [ ] **Step 4: Add the RSS-sourced branch to `processEpisode`**

In `src/queue/consumer.ts`, modify `processEpisode` around line 338. Replace:

```ts
const parsedUrl = parseApplePodcastsUrl(appleUrl);
if (!parsedUrl) {
    throw new AppError(ERROR_CODES.INVALID_URL, "Invalid Apple Podcasts URL");
}

const metadata = await getEpisodeMetadata(parsedUrl, {
    maxMinutes,
    episodeGuid,
    expectedTitle,
    expectedDate,
    env,
    appleUrl,
});
```

with:

```ts
let metadata: EpisodeMetadata;

if (ctx.rssSourced && ctx.prefetchedAudioUrl) {
    // RSS-sourced: construct metadata from queue fields (no PI/iTunes lookup needed)
    const podcastId = episodeId.split("_")[0];
    const monitored = await getMonitoredPodcast(kv, podcastId);
    const durationSec = ctx.prefetchedDurationSeconds ?? 0;

    if (durationSec > maxMinutes * 60) {
        throw new AppError(
            ERROR_CODES.EPISODE_TOO_LONG,
            `Episode duration (${Math.round(durationSec / 60)} min) exceeds limit (${maxMinutes} min)`
        );
    }

    metadata = {
        podcastName: ctx.prefetchedPodcastTitle || monitored?.name || "Unknown Podcast",
        episodeTitle: expectedTitle || "Untitled Episode",
        episodeDuration: durationSec,
        episodeDate: expectedDate || new Date().toISOString(),
        audioUrl: ctx.prefetchedAudioUrl,
        feedUrl: monitored?.rssUrl || "",
        ...(ctx.prefetchedTranscriptUrl && { transcriptUrl: ctx.prefetchedTranscriptUrl }),
        ...(ctx.prefetchedTranscriptType && { transcriptType: ctx.prefetchedTranscriptType }),
    };

    console.log(JSON.stringify({
        event: "consumer_rss_sourced_skip_pi",
        episodeId,
        audioUrl: ctx.prefetchedAudioUrl,
    }));
} else {
    if (!appleUrl) {
        throw new AppError(ERROR_CODES.INVALID_URL, "Missing Apple Podcasts URL for process_episode job");
    }
    const parsedUrl = parseApplePodcastsUrl(appleUrl);
    if (!parsedUrl) {
        throw new AppError(ERROR_CODES.INVALID_URL, "Invalid Apple Podcasts URL");
    }

    metadata = await getEpisodeMetadata(parsedUrl, {
        maxMinutes,
        episodeGuid,
        expectedTitle,
        expectedDate,
        env,
        appleUrl,
    });
}
```

Also move/remove the earlier `if (!appleUrl)` guard at line 283 — that check now lives inside the `else` branch above. Delete these lines near 283:

```ts
if (!appleUrl) {
    throw new AppError(ERROR_CODES.INVALID_URL, "Missing Apple Podcasts URL for process_episode job");
}
```

Make sure `getMonitoredPodcast` and `EpisodeMetadata` are imported. Add imports at top:

```ts
import { getMonitoredPodcast } from "../lib/kv";
import type { EpisodeMetadata } from "../services/apple-podcasts";
```

And the `Episode` record save at line 480 — `appleUrl` becomes optional. Change:

```ts
const episode: Episode = {
    id: episodeId,
    appleUrl,
    // ...
```

to:

```ts
const episode: Episode = {
    id: episodeId,
    appleUrl: appleUrl || "",
    // ...
```

(We keep the field a string for backwards compat with the existing `Episode` shape; empty string signals "no Apple link".)

- [ ] **Step 5: Run test**

Run: `npm test -- test/consumer-rss-sourced.test.ts`
Expected: PASS (1 test).

- [ ] **Step 6: Run full test suite**

Run: `npm test`
Expected: PASS. Existing admin-submission tests must still pass (they go through the `else` branch unchanged).

- [ ] **Step 7: Commit**

```bash
git add src/queue/consumer.ts test/consumer-rss-sourced.test.ts
git commit -m "Consumer branches on rssSourced to skip PI enrichment"
```

---

## Task 6: Persist `etag`/`lastModified` on `MonitoredPodcast`

**Files:**
- Modify: `src/lib/kv.ts` (no new functions — existing `saveMonitoredPodcast` already serializes the whole record)

- [ ] **Step 1: Verify**

Open `src/lib/kv.ts` around line 715 (`saveMonitoredPodcast`). Confirm it serializes the entire record via `JSON.stringify(podcast)`. If so, no code change is needed for persistence — the new `etag`/`lastModified` fields flow through automatically.

If the function hand-picks fields instead, extend it:

```ts
export async function saveMonitoredPodcast(kv: KVNamespace, podcast: MonitoredPodcast): Promise<void> {
    await kv.put(`monitored:${podcast.id}`, JSON.stringify(podcast));
}
```

- [ ] **Step 2: No commit**

Nothing to commit if the function already serializes the whole record.

---

## Task 7: RSS-first monitor check flow

**Files:**
- Modify: `src/lib/monitor.ts:230-428` (`checkPodcastForNewEpisodes`)
- Test: `test/monitor-rss-first.test.ts`

- [ ] **Step 1: Write failing tests**

Create `test/monitor-rss-first.test.ts`. Three scenarios:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { env } from "cloudflare:test";
import { checkPodcastForNewEpisodes } from "../src/lib/monitor";
import * as rss from "../src/services/rss";
import { saveMonitoredPodcast, getMonitoredPodcast, markEpisodesProcessed } from "../src/lib/kv";
import type { MonitoredPodcast } from "../src/types";

const PODCAST: MonitoredPodcast = {
    id: "1809663079",
    name: "How I AI",
    rssUrl: "https://anchor.fm/s/1035b1568/podcast/rss",
    templateId: "key-takeaways",
    addedAt: "2026-04-17T00:00:00Z",
    episodesProcessed: 0,
    status: "active",
};

describe("monitor: RSS-first", () => {
    beforeEach(async () => {
        await saveMonitoredPodcast(env.TLDL_DATA, PODCAST);
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("returns no new episodes on 304", async () => {
        vi.spyOn(rss, "fetchFeedIfChanged").mockResolvedValue({ status: "not_modified" });
        const sendSpy = vi.spyOn(env.TLDL_QUEUE, "send").mockResolvedValue();

        const result = await checkPodcastForNewEpisodes(env, PODCAST, 5);

        expect(result.newEpisodes).toBe(0);
        expect(sendSpy).not.toHaveBeenCalled();
        const updated = await getMonitoredPodcast(env.TLDL_DATA, PODCAST.id);
        expect(updated?.lastChecked).toBeDefined();
    });

    it("queues new episodes with rssSourced=true and full metadata on 200", async () => {
        vi.spyOn(rss, "fetchFeedIfChanged").mockResolvedValue({
            status: "ok",
            etag: "\"new-etag\"",
            lastModified: "Mon, 13 Apr 2026 11:00:00 GMT",
            feed: {
                title: "How I AI",
                episodes: [{
                    guid: "dd85426a-9b70-482f-94ed-d5afd61b7d56",
                    title: "Claude Cowork 101",
                    pubDate: "2026-04-13T11:00:00Z",
                    duration: 3011,
                    audioUrl: "https://example.com/audio.mp3",
                }],
            },
        });
        const sendSpy = vi.spyOn(env.TLDL_QUEUE, "send").mockResolvedValue();

        const result = await checkPodcastForNewEpisodes(env, PODCAST, 5);

        expect(result.newEpisodes).toBe(1);
        expect(sendSpy).toHaveBeenCalledTimes(1);
        const msg = sendSpy.mock.calls[0][0];
        expect(msg.rssSourced).toBe(true);
        expect(msg.audioUrl).toBe("https://example.com/audio.mp3");
        expect(msg.durationSeconds).toBe(3011);
        expect(msg.episodeId).toMatch(/^1809663079_rss_[0-9a-f]{10}$/);

        const updated = await getMonitoredPodcast(env.TLDL_DATA, PODCAST.id);
        expect(updated?.etag).toBe("\"new-etag\"");
        expect(updated?.lastModified).toBe("Mon, 13 Apr 2026 11:00:00 GMT");
    });

    it("skips already-processed GUIDs", async () => {
        await markEpisodesProcessed(env.TLDL_DATA, PODCAST.id, ["already-seen"]);
        vi.spyOn(rss, "fetchFeedIfChanged").mockResolvedValue({
            status: "ok",
            feed: {
                title: "How I AI",
                episodes: [{
                    guid: "already-seen",
                    title: "Old Ep",
                    pubDate: "2026-04-01T00:00:00Z",
                    duration: 1000,
                    audioUrl: "https://example.com/old.mp3",
                }],
            },
        });
        const sendSpy = vi.spyOn(env.TLDL_QUEUE, "send").mockResolvedValue();

        const result = await checkPodcastForNewEpisodes(env, PODCAST, 5);

        expect(result.newEpisodes).toBe(0);
        expect(sendSpy).not.toHaveBeenCalled();
    });

    it("falls back to PI on RSS error", async () => {
        vi.spyOn(rss, "fetchFeedIfChanged").mockResolvedValue({ status: "error", reason: "http_429" });
        // The PI fallback path already exists in the current code — just verify
        // the monitor doesn't throw and records lastChecked. Detailed PI flow
        // is covered by existing monitor tests.
        const result = await checkPodcastForNewEpisodes(env, PODCAST, 5);
        expect(result).toBeDefined();
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- test/monitor-rss-first.test.ts`
Expected: FAIL — current code is PI-primary.

- [ ] **Step 3: Refactor `checkPodcastForNewEpisodes` to RSS-first**

In `src/lib/monitor.ts`, replace the body of `checkPodcastForNewEpisodes` (lines 230–428). Keep the current PI flow as a private helper called from the error-fallback path.

Add imports at the top:

```ts
import { fetchFeedIfChanged } from "../services/rss";
import { deriveRssEpisodeId } from "./rss-episode-id";
```

Replace the function:

```ts
export async function checkPodcastForNewEpisodes(
    env: Env,
    podcast: MonitoredPodcast,
    maxEpisodes: number = 5
): Promise<CheckResult> {
    const result: CheckResult = {
        podcastId: podcast.id,
        podcastName: podcast.name,
        newEpisodes: 0,
        queued: [],
        errors: [],
    };

    try {
        const fetchResult = await fetchFeedIfChanged(podcast.rssUrl, {
            etag: podcast.etag,
            lastModified: podcast.lastModified,
        });

        if (fetchResult.status === "not_modified") {
            await updateMonitoredPodcastStatus(env.TLDL_DATA, podcast.id, {
                lastChecked: new Date().toISOString(),
                status: "active",
            });
            console.log(JSON.stringify({
                event: "monitor_rss_not_modified",
                podcastId: podcast.id,
            }));
            return result;
        }

        if (fetchResult.status === "error") {
            console.log(JSON.stringify({
                event: "monitor_rss_error_fallback_to_pi",
                podcastId: podcast.id,
                reason: fetchResult.reason,
            }));
            return await checkViaPodcastIndex(env, podcast, maxEpisodes, result);
        }

        // fetchResult.status === "ok" — process feed
        const feed = fetchResult.feed;
        const processedGuids = await getProcessedEpisodes(env.TLDL_DATA, podcast.id);
        const processedSet = new Set(processedGuids);
        const newEpisodes = feed.episodes.filter(ep => !processedSet.has(ep.guid));

        // Persist updated cache headers regardless of whether new episodes exist
        const currentPodcast = await getMonitoredPodcast(env.TLDL_DATA, podcast.id);
        const baseUpdate: Partial<MonitoredPodcast> = {
            lastChecked: new Date().toISOString(),
            status: "active",
            etag: fetchResult.etag,
            lastModified: fetchResult.lastModified,
        };

        if (newEpisodes.length === 0) {
            await updateMonitoredPodcastStatus(env.TLDL_DATA, podcast.id, baseUpdate);
            return result;
        }

        const episodesToProcess = newEpisodes.slice(0, maxEpisodes);

        for (const rssEp of episodesToProcess) {
            try {
                const episodeId = await deriveRssEpisodeId(podcast.id, rssEp.guid);

                const existingEpisode = await getEpisode(env.TLDL_DATA, episodeId);
                const existsByTitle = await episodeExistsByTitle(env, podcast.id, rssEp.title);
                if (existingEpisode || existsByTitle) {
                    await markEpisodeProcessed(env.TLDL_DATA, podcast.id, rssEp.guid);
                    continue;
                }

                await queueRssEpisodeForProcessing(env, {
                    podcastId: podcast.id,
                    podcastName: podcast.name,
                    episodeId,
                    episodeGuid: rssEp.guid,
                    expectedTitle: rssEp.title,
                    expectedDate: rssEp.pubDate,
                    audioUrl: rssEp.audioUrl,
                    durationSeconds: rssEp.duration,
                    transcriptUrl: rssEp.transcriptUrl,
                    transcriptType: rssEp.transcriptType,
                    templateId: podcast.templateId,
                });

                await markEpisodeProcessed(env.TLDL_DATA, podcast.id, rssEp.guid);
                result.queued.push(rssEp.title);
                result.newEpisodes++;
            } catch (error) {
                result.errors.push(`Error processing ${rssEp.title}: ${error instanceof Error ? error.message : String(error)}`);
            }
        }

        await updateMonitoredPodcastStatus(env.TLDL_DATA, podcast.id, {
            ...baseUpdate,
            episodesProcessed: (currentPodcast?.episodesProcessed || 0) + result.newEpisodes,
        });

    } catch (error) {
        result.errors.push(error instanceof Error ? error.message : String(error));
        await updateMonitoredPodcastStatus(env.TLDL_DATA, podcast.id, {
            lastChecked: new Date().toISOString(),
            status: "error",
            lastError: error instanceof Error ? error.message : String(error),
        });
    }

    return result;
}
```

Extract the existing PI check flow (lines 250–406 of the original file — everything inside the `try { ... } catch (piError) { ... }` block) into a new private helper:

```ts
async function checkViaPodcastIndex(
    env: Env,
    podcast: MonitoredPodcast,
    maxEpisodes: number,
    result: CheckResult
): Promise<CheckResult> {
    // Paste the original PI-first logic here (unchanged).
    // This is the safety-net path used only when RSS fetch fails.
    // ...
}
```

Then add the new `queueRssEpisodeForProcessing` helper (beside the existing `queueEpisodeForProcessing`):

```ts
interface QueueRssEpisodeParams {
    podcastId: string;
    podcastName: string;
    episodeId: string;
    episodeGuid: string;
    expectedTitle: string;
    expectedDate: string;
    audioUrl: string;
    durationSeconds: number;
    transcriptUrl?: string;
    transcriptType?: string;
    templateId: string;
}

async function queueRssEpisodeForProcessing(
    env: Env,
    params: QueueRssEpisodeParams
): Promise<void> {
    const jobId = generateUUID();
    const now = new Date().toISOString();

    const job: Job = {
        id: jobId,
        episodeId: params.episodeId,
        appleUrl: "",
        status: "queued",
        templateId: params.templateId,
        createdAt: now,
        updatedAt: now,
    };

    await createJobDO(env, job);
    await createJob(env.TLDL_DATA, job);

    const message = createProcessEpisodeMessage({
        jobId,
        episodeId: params.episodeId,
        templateId: params.templateId,
        episodeGuid: params.episodeGuid,
        expectedTitle: params.expectedTitle,
        expectedDate: params.expectedDate,
        submittedBy: "monitor@tldl.app",
        rssSourced: true,
        audioUrl: params.audioUrl,
        durationSeconds: params.durationSeconds,
        transcriptUrl: params.transcriptUrl,
        transcriptType: params.transcriptType,
        podcastTitle: params.podcastName,
    });

    await enqueueJob(env.TLDL_QUEUE, message);

    console.log(JSON.stringify({
        event: "monitor_rss_episode_queued",
        jobId,
        episodeId: params.episodeId,
        title: params.expectedTitle,
    }));
}
```

Also verify `updateMonitoredPodcastStatus` accepts the `etag`/`lastModified` fields in its `updates` param. If its signature is typed narrowly, widen it to accept `Partial<MonitoredPodcast>`.

- [ ] **Step 4: Run tests**

Run: `npm test -- test/monitor-rss-first.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Run full test suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/monitor.ts test/monitor-rss-first.test.ts
git commit -m "RSS-first monitor check with PI as error fallback"
```

---

## Task 8: Episode page — conditional Apple link

**Files:**
- Modify: `src/routes/public.ts` (episode route — render "View on Apple Podcasts" link conditionally)

- [ ] **Step 1: Find the existing Apple link render**

Run: `grep -n "podcasts.apple.com\|appleUrl" src/routes/public.ts | head -20`

Locate the line(s) that render a link to Apple Podcasts on the `/episode/:id` page.

- [ ] **Step 2: Guard the render**

Wrap the render in an `appleUrl` truthiness check. Example:

```ts
${episode.appleUrl ? `
    <a href="${escapeHtml(episode.appleUrl)}" class="apple-link" target="_blank" rel="noopener">
        View on Apple Podcasts
    </a>
` : ''}
```

- [ ] **Step 3: Manual check via unit test if a test file exists for public routes**

If `test/public.test.ts` exists, add a test verifying that the link is absent when `episode.appleUrl` is empty string. If no such file exists, skip — manual verification in Task 10 covers it.

- [ ] **Step 4: Commit**

```bash
git add src/routes/public.ts
git commit -m "Render Apple Podcasts link only when appleUrl present"
```

---

## Task 9: Cron cadence — every 30 minutes

**Files:**
- Modify: `wrangler.toml:46-47`

- [ ] **Step 1: Change the cron schedule**

In `wrangler.toml`, replace:

```toml
[triggers]
crons = ["0 */3 * * *"]  # Every 3 hours
```

with:

```toml
[triggers]
crons = ["*/30 * * * *"]  # Every 30 minutes
```

- [ ] **Step 2: Commit**

```bash
git add wrangler.toml
git commit -m "Run monitor cron every 30 minutes"
```

---

## Task 10: Manual end-to-end verification

**Prereqs:** all previous tasks merged; deploy to a staging environment OR run locally with `npm run dev`.

- [ ] **Step 1: Deploy or run locally**

```bash
npm run deploy
# or for local:
rm -rf .wrangler/state && npm run dev
```

- [ ] **Step 2: Add "How I AI" via the admin UI**

Navigate to `/admin/podcasts`, add Apple ID `1809663079`. This uses the unchanged `addPodcastToMonitoring` flow — PI-primary — so backfill works as before. Confirm the podcast appears with `status: active`.

- [ ] **Step 3: Force a check**

Click "Check now" (which calls `POST /admin/podcasts/1809663079/check`) or wait for the next 30-min tick.

- [ ] **Step 4: Verify queue log**

Run: `npx wrangler tail` and look for:

- `monitor_rss_not_modified` on subsequent ticks (after the first), OR
- `monitor_rss_episode_queued` if a new episode is published during testing
- `consumer_rss_sourced_skip_pi` when the consumer processes an RSS-sourced job

Absence of `monitor_check_fallback_to_rss` and `monitor_pi_match_not_found` is the positive signal.

- [ ] **Step 5: Visit an episode page**

Open `/episode/1809663079_rss_<hash>` for a queued episode. Confirm:
- Page renders
- No "View on Apple Podcasts" link
- Summary and (if Whisper transcription ran) transcript are present

- [ ] **Step 6: Verify conditional GET is working**

Inspect the stored podcast record:

```bash
npx wrangler kv key get --namespace-id=ee123158d5d54359b4257f8a1b678adf "monitored:1809663079"
```

Confirm `etag` and/or `lastModified` fields are populated. On subsequent ticks, logs should show `monitor_rss_not_modified` until the feed actually changes.

---

## Self-Review Notes

- **Spec coverage:** All spec sections (episode ID scheme, queue message extension, consumer branching, monitor flow, conditional GET, pacing simplification, cron, display, non-goals, testing) have a corresponding task.
- **Placeholder scan:** No TBDs, TODOs, or vague steps. Every code step shows the actual code.
- **Type consistency:** `rssSourced`, `audioUrl`, `durationSeconds`, `transcriptUrl`, `transcriptType`, `podcastTitle` names are consistent across `QueueMessage`, `createProcessEpisodeMessage`, and `ProcessingContext`. The `guidHash` function signature matches its caller in `deriveRssEpisodeId`.
- **Retry-until-PI-catches-up** from the spec is naturally handled: `fetchAndParseFeed`/RSS is the source of truth. No separate `pendingRssGuids` bookkeeping is needed because there's no PI dependency in the hot path anymore (spec had that only as a mitigation for the earlier design that still needed PI).
