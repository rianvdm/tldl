# Improve Saved Podcast Episode Check Reliability

**Issue:** [rianvdm/tldl#19](https://github.com/rianvdm/tldl/issues/19)
**Date:** 2026-03-31

## Problem

The podcast monitoring cron fetches RSS feeds directly to discover new episodes. Several feed servers (Substack, etc.) return 429 errors to Cloudflare Workers IPs, breaking monitoring for those podcasts. Once broken, they stay broken because subsequent cron checks hit the same rate-limited origin.

## Solution

Switch from RSS-first to Podcast Index API-first for episode discovery. The PI `episodes/byitunesid` endpoint supports a `since` parameter that returns only episodes published after a given timestamp — exactly what the monitor needs. This eliminates direct RSS fetching during routine checks.

## Changes

### 1. `src/services/podcast-index.ts`

Add optional `since` parameter to `getEpisodesByItunesId()`:
- Accepts an epoch timestamp
- Appends `&since=<epoch>` to the API URL
- No other changes to the function

### 2. `src/lib/monitor.ts` — `checkPodcastForNewEpisodes()`

Replace the current RSS-first flow with PI-first:

1. Calculate `since` from `podcast.lastChecked` (ISO → epoch). Default to 7 days ago if no `lastChecked`.
2. Log strategy selection: `{"event": "monitor_check_strategy", "podcastId", "podcastName", "strategy": "podcast_index", "since"}`
3. Call `getEpisodesByItunesId(id, key, secret, max, since)`
4. Filter returned episodes against processed GUIDs (PI episodes include `guid`)
5. For each new episode, queue directly — PI provides episode ID, GUID, title, audio URL. No RSS matching needed.
6. Mark processed and update podcast status as today.

**Fallback to RSS:** If PI throws a rate limit error (429 `AppError`), catch it, log `{"event": "monitor_check_fallback_to_rss", "podcastId", "reason": "podcast_index_rate_limited"}`, and run the current RSS-based flow. This ensures graceful degradation.

### What doesn't change

- `addPodcastToMonitoring()` — still uses RSS for initial "mark all existing as processed" step
- Processed episode tracking (GUID-based, PI episodes have `guid` field)
- Job queuing, episode ID format (`podcastId_piEpisodeId`)
- `appleUrl` construction
- `checkAllPodcasts()` and `forceCheckAllPodcasts()` — they call `checkPodcastForNewEpisodes()` which changes internally

### Logging

Structured JSON logs at each decision point, following existing patterns:

- `monitor_check_strategy` — which path was chosen (podcast_index or rss_fallback) and the `since` value
- `monitor_check_fallback_to_rss` — logged when PI fails and we fall back, with `reason` field
- `monitor_pi_new_episodes` — count of new episodes found via PI (before GUID filtering)

## Out of scope

- Batch PI endpoint (checking multiple podcasts in one call) — premature for 7 podcasts
- Removing RSS parsing entirely — still needed for `addPodcastToMonitoring()`
- Changing the cron interval
