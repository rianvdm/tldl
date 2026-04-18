# RSS-First Monitoring Design

**Date:** 2026-04-17
**Status:** Draft

## Problem

The podcast monitoring feature is consistently ~12 hours late picking up new episodes. Root cause: both detection and enrichment go through the Podcast Index API, and PI's re-crawl cadence for some feeds is slow (sometimes >12h). Some feeds ("How I AI", `id1809663079`) appear to never get picked up at all via PI during a reasonable window.

Secondary cause: the monitoring cron runs every 8 hours, stacking additional latency on top of PI lag.

Target: new episodes detected and queued within **1 hour** of publish for 10–50 monitored podcasts.

## Design

RSS-sourced episodes bypass Podcast Index entirely. The monitor fetches the RSS feed directly, and the queue message carries enough pre-fetched metadata that the consumer never needs to call PI for enrichment. PI remains in the codebase for two narrower uses:

1. The initial bulk episode-list backfill in `addPodcastToMonitoring` (one-shot, lag-tolerant).
2. Admin submissions via Apple Podcasts URL (`getEpisodeMetadata` still uses PI first).

### Episode ID scheme

Two shapes, both valid KV keys and both handled by existing routes:

- `{podcastId}_{appleEpisodeId}` — admin submissions (unchanged)
- `{podcastId}_rss_{guidHash}` — monitor-sourced episodes. `guidHash` is the first 10 hex chars of SHA-256(guid), computed via `crypto.subtle.digest`

`extractPodcastId()` in `src/lib/url-parser.ts` already splits on the first `_`, so it returns the correct podcast ID for both shapes.

### Queue message

Extend `ProcessEpisodeMessage` with optional pre-fetched fields:

```ts
interface ProcessEpisodeMessage {
    // existing fields...
    audioUrl?: string;
    durationSeconds?: number;
    transcriptUrl?: string;
    transcriptType?: string;
    podcastTitle?: string;
    rssSourced?: boolean;  // true when monitor queued this via RSS
}
```

### Consumer branching

In `processEpisode` (`src/queue/consumer.ts`):

- If `rssSourced === true` and `audioUrl` is present, skip `getEpisodeMetadata` entirely and construct `EpisodeMetadata` directly from the queue message fields + `getMonitoredPodcast()` for podcast-level data (artwork, author).
- Otherwise, existing PI/iTunes path.

`appleUrl` becomes optional in this branch. The "View on Apple Podcasts" link on the episode page is rendered only when `appleUrl` is present in the stored `Episode` record.

### Monitor check flow

`checkPodcastForNewEpisodes` becomes:

1. Fetch RSS via `fetchAndParseFeed(podcast.rssUrl)` with conditional GET (see below).
2. On 304: update `lastChecked`, return early.
3. On 200: diff episodes against processed GUIDs.
4. For each new episode (up to `maxEpisodesPerCheck`):
   - Compute `episodeId = {podcastId}_rss_{hash(guid)}`
   - Dedupe against KV (`getEpisode`) and title-match (`episodeExistsByTitle`)
   - Enqueue with full RSS metadata attached, `rssSourced: true`
   - Mark GUID processed
5. Update `lastChecked`, `episodesProcessed`, `status`.
6. On RSS fetch error (network failure, non-2xx non-304): fall back to existing PI check flow as a safety net. Log the fallback.

### Conditional GET

Extend `MonitoredPodcast`:

```ts
interface MonitoredPodcast {
    // existing fields...
    etag?: string;
    lastModified?: string;  // Last-Modified header value
}
```

Extend `fetchAndParseFeed` (or add `fetchFeedIfChanged`) to:

- Send `If-None-Match: <etag>` and `If-Modified-Since: <lastModified>` when present.
- Return `{ status: "not_modified" }` on 304.
- Return `{ status: "ok", feed, etag, lastModified }` on 200.
- Return `{ status: "error", reason }` on 429 or network failure — monitor falls back to PI.

Persist `etag` and `lastModified` to the podcast record after each successful fetch.

### Request pacing

Process podcasts sequentially within each cron tick (existing behavior). With 10–50 podcasts across varied hosts and conditional GET returning 304 for most, this is naturally paced. No explicit jitter needed. If we later observe 429s from a single host (e.g. multiple Anchor.fm feeds), add a small delay between requests to the same host.

### Cron

`wrangler.toml`: change cron from `0 */8 * * *` to `*/30 * * * *`.

Stale-job sweep at start of each tick stays as-is.

### Display

- Episode page: "View on Apple Podcasts" link renders only when `appleUrl` is stored. For RSS-sourced episodes, no Apple link (acceptable tradeoff).
- `/feed` RSS output: continue to use the episode page as the link target.

### Retry for PI-dependent admin submissions

Unchanged. Admin submits go through `getEpisodeMetadata` which still tries PI first. Out of scope for this change.

## Non-goals

- WebSub / push notifications (future upside; several feeds advertise `pubsubhubbub.appspot.com` but not universal).
- Per-podcast custom cron frequencies.
- Refactoring `addPodcastToMonitoring` to use RSS for bulk backfill.
- Backfilling existing monitor-sourced episodes to the new ID scheme (new IDs only apply going forward).

## Testing

Unit tests (Vitest, existing patterns in `test/monitor.test.ts`):

- `fetchFeedIfChanged`: 200 path stores etag/lastModified; 304 returns `not_modified`; 429 returns `error`; error path returns `error`.
- Monitor check: RSS 304 → no-op, `lastChecked` updated.
- Monitor check: RSS 200 with 1 new episode → enqueues with `rssSourced: true` and full metadata; marks GUID processed.
- Monitor check: RSS error → falls back to PI flow.
- Episode ID hash: stable across calls, 10 chars, collision-safe for realistic volumes.
- `extractPodcastId` handles both ID shapes.

Consumer branch (`test/queue.test.ts` or new `test/consumer-rss-sourced.test.ts`):

- `rssSourced: true` with full metadata → skips `getEpisodeMetadata`, constructs `EpisodeMetadata` directly, proceeds to transcription.
- `rssSourced: true` but missing `audioUrl` → falls back to `getEpisodeMetadata` (defensive).

Integration (`test/integration/full-flow.test.ts`):

- End-to-end: add podcast → RSS has new episode → cron tick → episode queued with RSS metadata → consumer processes without PI → episode stored and renders on episode page.

Manual test plan:

1. Add "How I AI" (`id1809663079`) via admin UI.
2. Wait for next 30-min cron tick (or force check).
3. Verify the latest episode ("Claude Cowork 101...", guid `dd85426a-9b70-482f-94ed-d5afd61b7d56`) is picked up and processed without requiring PI to know about it.
4. Verify episode page renders correctly, no "View on Apple Podcasts" link present.
5. Verify subsequent cron ticks return 304 and no-op until a new episode publishes.

## Files touched

- `src/types/index.ts` — extend `MonitoredPodcast`, `ProcessEpisodeMessage`, `Episode`
- `src/services/rss.ts` — add `fetchFeedIfChanged` with conditional GET
- `src/lib/monitor.ts` — RSS-first flow, jitter, conditional GET plumbing
- `src/lib/kv.ts` — persist etag/lastModified on podcast record
- `src/lib/queue.ts` — extend message shape
- `src/queue/consumer.ts` — branch on `rssSourced` to skip enrichment
- `src/routes/public.ts` — conditionally render Apple link on episode page
- `wrangler.toml` — cron `*/30 * * * *`
- `test/monitor.test.ts`, `test/rss.test.ts`, `test/consumer*.test.ts`, `test/integration/full-flow.test.ts`

## Rollout

One deploy. No data migration needed (new ID shape only applies to future episodes; existing episodes continue to work). Keep PI fallback in the monitor check flow for the first week so we can observe logs and catch anything we missed; remove later if clean.
