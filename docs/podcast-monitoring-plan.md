# Auto-Monitor Podcasts Feature

Admin-only feature to monitor podcasts for new episodes and automatically queue them for processing via cron trigger.

## User Requirements

- Input: Apple Podcasts URL (system extracts podcast ID and looks up RSS URL via Podcast Index API)
- Global check interval (default 8 hours, configurable)
- Per-podcast template selection
- "Check Now" button for immediate check
- Automatic cron-triggered checking

---

## Files to Modify

### 1. `src/types/index.ts`

Add types:

```typescript
interface MonitoredPodcast {
    id: string;              // Apple podcast ID
    name: string;
    rssUrl: string;          // From Podcast Index API
    templateId: string;      // Per-podcast template
    addedAt: string;
    lastChecked?: string;
    episodesProcessed: number;
    status: "active" | "paused" | "error";
    lastError?: string;
}

interface MonitorSettings {
    checkIntervalHours: number;  // Default: 8
    maxEpisodesPerCheck: number; // Default: 5
    enabled: boolean;
}
```

### 2. `src/lib/kv.ts`

Add KV keys and helper functions:

**Keys:**
- `monitor:settings` - Global settings
- `monitored:list` - Array of monitored podcast IDs
- `monitored:{podcastId}` - Individual podcast config
- `monitored:processed:{podcastId}` - Array of processed episode GUIDs

**Functions:**
- `getMonitorSettings()` / `saveMonitorSettings()`
- `getMonitoredPodcastIds()` / `addToMonitoredList()` / `removeFromMonitoredList()`
- `getMonitoredPodcast()` / `saveMonitoredPodcast()` / `deleteMonitoredPodcast()`
- `listMonitoredPodcasts()`
- `getProcessedEpisodes()` / `markEpisodeProcessed()`

### 3. `src/lib/monitor.ts` (NEW FILE)

Core monitoring logic:

- `checkPodcastForNewEpisodes(env, podcast, maxEpisodes)` - Check single podcast
- `checkAllPodcasts(env)` - Check all monitored podcasts (for cron)
- `forceCheckAllPodcasts(env)` - Immediate check (for "Check Now" button)

**Episode Deduplication Strategy:**
1. Primary: Track processed episode GUIDs per podcast in `monitored:processed:{podcastId}`
2. Secondary: Check if `episode:{id}` already exists in KV

**Episode ID Derivation:**
Use `getEpisodesByItunesId()` from Podcast Index API to get episode IDs, then derive episode ID as `{podcastId}_{episodeId}`. This keeps IDs consistent with manually submitted episodes.

### 4. `src/routes/authenticated.ts`

Add admin routes under `/profile/*`:

**Page:**
- `GET /profile/podcasts` - Admin page with settings, add form, podcast list

**API:**
- `POST /profile/podcasts/add` - Add podcast (validates URL, fetches RSS from Podcast Index)
- `DELETE /profile/podcasts/:podcastId` - Remove podcast
- `PUT /profile/podcasts/:podcastId` - Update template
- `POST /profile/podcasts/check-now` - Force immediate check
- `PUT /profile/settings/monitor-interval` - Update global interval

### 5. `src/index.ts`

Add scheduled handler export:

```typescript
export default {
    fetch: app.fetch,
    queue: queueConsumer.queue,
    scheduled: scheduledHandler,  // NEW
};
```

### 6. `wrangler.toml`

Add cron trigger:

```toml
[triggers]
crons = ["0 */8 * * *"]  # Every 8 hours
```

---

## Add Podcast Flow

1. Parse Apple Podcasts URL → extract podcast ID
2. Check if already monitored
3. Call `lookupPodcastByItunesId()` → get RSS URL + podcast name
4. Verify RSS feed is accessible with `fetchAndParseFeed()`
5. Create `MonitoredPodcast` record with user-selected template
6. **First-add behavior:**
   - Get all episode GUIDs from the RSS feed
   - Mark all episodes as "processed" (to prevent backlog cascade)
   - Check if the **latest episode** already exists in KV
   - If not, queue only the latest episode for processing
7. Save to KV

---

## Check Flow (Cron or Manual)

1. Get list of monitored podcast IDs
2. For each podcast:
   - Fetch RSS feed with `fetchAndParseFeed()`
   - Get processed episode GUIDs for this podcast
   - Find new episodes (not in processed list, not already in KV)
   - For each new episode (up to `maxEpisodesPerCheck`):
     - Look up episode in Podcast Index to get Apple-compatible ID
     - Create job and enqueue (reuse existing pattern)
     - Mark GUID as processed
   - Update `lastChecked` timestamp
3. Return summary of results

---

## UI Design

**Page sections:**

1. **Global Settings Card** - Check interval input, "Check All Now" button
2. **Add Podcast Form** - Apple URL input, template dropdown
3. **Monitored Podcasts List** - Cards with name, template selector, last checked, episode count, remove button

---

## Implementation Order

1. Add types to `src/types/index.ts`
2. Add KV helpers to `src/lib/kv.ts`
3. Create `src/lib/monitor.ts` with core logic
4. Add routes to `src/routes/authenticated.ts`
5. Add scheduled handler to `src/index.ts`
6. Update `wrangler.toml` with cron trigger
7. Add "Monitor podcasts" link to `/profile` page, placed next to existing "View wantlist" link
8. Deploy and test
9. Update `CLAUDE.md` and `README.md` with:
   - New KV keys (`monitor:settings`, `monitored:list`, `monitored:{podcastId}`, `monitored:processed:{podcastId}`)
   - New routes (`GET /profile/podcasts`, `POST /profile/podcasts/add`, etc.)
   - Cron trigger documentation
   - Admin tools section update
