# Debugging Episode Matching Issue

**Date**: December 20, 2025  
**Status**: ✅ **RESOLVED**

## Problem Summary

The queue consumer fails to find episodes in RSS feeds, while the `/debug/episode` HTTP endpoint works correctly with the same code path.

**Error Message**: `"Episode not found in podcast feed. It may have been removed or the URL is incorrect."`

## Test Case

- **URL**: `https://podcasts.apple.com/us/podcast/conan-obrien-needs-a-friend/id1438054347?i=1000739383619`
- **Episode**: "It's A Small World In Here" (18 min, 1108 seconds)
- **Podcast ID**: `1438054347`
- **Episode ID**: `1000739383619`
- **Expected GUID** (from iTunes API): `c5e22f17-3bc0-4d4b-a58f-9e00f163e932`

## What Works

1. **Debug endpoint** (`/debug/episode?url=...`) successfully finds the episode
2. **iTunes API** returns the episode with `episodeGuid`:
   ```bash
   curl -s "https://itunes.apple.com/lookup?id=1438054347&entity=podcastEpisode&limit=5" | jq '.results[] | select(.trackId == 1000739383619)'
   ```
   Returns: `episodeGuid: "c5e22f17-3bc0-4d4b-a58f-9e00f163e932"`

3. **RSS Feed** contains the matching GUID:
   ```bash
   curl -s "https://feeds.simplecast.com/dHoohVNH" | grep -o '<guid[^>]*>[^<]*</guid>' | head -1
   ```
   Returns: `<guid isPermaLink="false">c5e22f17-3bc0-4d4b-a58f-9e00f163e932</guid>`

4. **All tests pass** (164 tests)

## What Fails

The **queue consumer** fails at the `getEpisodeMetadata()` call with the episode not found error.

## Key Discovery from Logs

Using `wrangler tail`, we captured this debug output from the queue consumer:

```json
{
  "event": "episode_lookup_debug",
  "podcastId": "1438054347",
  "episodeId": "1000739383619",
  "feedUrl": "https://feeds.simplecast.com/dHoohVNH",
  "feedEpisodeCount": 100,
  "firstFiveGuids": [
    "c5e22f17-3bc0-4d4b-a58f-9e00f163e932",
    "89f5a063-22de-4a1c-adcb-ad392efcff25",
    "974f3707-c854-4acb-8336-cadc30917ad3",
    "e1de7e17-63e9-4822-972d-e8d96705bc51",
    "5ef480de-1b1f-4ecd-be0e-7e86cfc41995"
  ],
  "episodeInfoFound": false   // <-- THIS IS THE PROBLEM
}
```

**The `episodeInfoFound: false` indicates that `lookupEpisodeInfo()` is returning `null`**, which means we're not getting the `episodeGuid` from iTunes API.

Without `episodeGuid`, the matching falls back to:
1. GUID contains Apple episode ID (numeric) - **fails** because RSS GUIDs are UUIDs
2. Title similarity match - **should work** but apparently not triggering
3. Date match - **should work** but apparently not triggering

## Root Cause - CONFIRMED ✅

**Apple iTunes API returns 403 Forbidden when called from queue consumer context**, but works fine from HTTP handler context.

Evidence from logs:
- HTTP handler: iTunes API returns 200 OK with episode data including `episodeGuid`
- Queue consumer: iTunes API returns 403 Forbidden, so `lookupEpisodeInfo()` returns `null`

This means:
1. iTunes API is likely blocking/rate-limiting based on IP address or request pattern
2. Queue consumers run on different Cloudflare infrastructure than HTTP handlers  
3. Without `episodeGuid`, the fallback matching strategies (1-5) fail because:
   - Strategy 1-2: GUID matching by numeric Apple episode ID fails (RSS uses UUID GUIDs)
   - Strategy 3-4: Title/date matching should work but isn't being reached or matching
   - Strategy 5: Index matching not applicable

## Code Location

The issue is in `src/services/apple-podcasts.ts`:

```typescript
export async function lookupEpisodeInfo(
    podcastId: string,
    episodeId: string
): Promise<ItunesEpisodeInfo | null> {
    const url = `https://itunes.apple.com/lookup?id=${podcastId}&entity=podcastEpisode&limit=200`;
    
    try {
        const response = await fetch(url, { ... });
        
        if (!response.ok) {
            return null;  // Could be rate limited here
        }
        
        const data = await response.json();
        const episodeIdNum = parseInt(episodeId, 10);
        const episode = data.results.find(
            (r) => r.trackId === episodeIdNum && r.wrapperType !== "collection"
        );
        
        if (!episode || !episode.trackName) {
            return null;  // Or episode not found in results
        }
        
        return { ... episodeGuid: episode.episodeGuid };
    } catch {
        return null;  // Or error caught silently here
    }
}
```

## Next Steps to Debug

1. **Add detailed logging** to `lookupEpisodeInfo()`:
   - Log the response status
   - Log the result count
   - Log sample trackIds from results
   - Log any caught errors

2. **Check if iTunes API is being rate limited** in queue context

3. **Test if title/date fallback matching** should have worked:
   - The episode title "It's A Small World In Here" should match
   - The release date "2025-12-18" should match

## Files Modified (Uncommitted)

- `src/services/apple-podcasts.ts` - Added `episodeGuid` support and debug logging
- `src/services/rss.ts` - Added Strategy 0 for episodeGuid matching
- `test/apple-podcasts.test.ts` - Updated test for User-Agent header
- `wrangler.toml` - Production KV/Queue IDs

## Commands for Testing

```bash
# Submit an episode
curl -X POST https://tldl.rian-db8.workers.dev/submit \
  -H "Content-Type: application/json" \
  -d '{"appleUrl": "https://podcasts.apple.com/us/podcast/conan-obrien-needs-a-friend/id1438054347?i=1000739383619", "templateId": "key-takeaways"}'

# Check job status
curl https://tldl.rian-db8.workers.dev/job/<job-id>

# Debug endpoint (works)
curl "https://tldl.rian-db8.workers.dev/debug/episode?url=https://podcasts.apple.com/us/podcast/conan-obrien-needs-a-friend/id1438054347?i=1000739383619"

# Tail worker logs
cd /Users/rian/Documents/GitHub/tldl && npx wrangler tail --format=json

# Test iTunes API directly
curl -s "https://itunes.apple.com/lookup?id=1438054347&entity=podcastEpisode&limit=200" | jq '.results[] | select(.trackId == 1000739383619)'
```

## Solution Implemented ✅

**Root cause**: Apple iTunes API returns 403 Forbidden when called from queue consumer context, but works from HTTP handler context.

**Solution**: Pre-fetch iTunes episode metadata during the `/submit` request (HTTP context where it works), then pass it through the queue message to the consumer.

### Changes Made:

1. **Extended `QueueMessage` type** to include pre-fetched metadata:
   ```typescript
   episodeGuid?: string;
   expectedTitle?: string;
   expectedDate?: string;
   ```

2. **Modified `/submit` endpoint** to call `lookupEpisodeInfo()` before queuing:
   - Fetches episode GUID, title, and date from iTunes API
   - Passes this data in the queue message

3. **Updated `getEpisodeMetadata()`** to accept pre-fetched metadata:
   - New `GetEpisodeMetadataOptions` parameter
   - Uses pre-fetched data instead of calling iTunes in queue context
   - Maintains backward compatibility with numeric `maxMinutes` parameter

4. **Modified queue consumer** to pass pre-fetched metadata to `getEpisodeMetadata()`

### Results:

✅ Episode matching now works reliably in queue consumer
✅ Job completed successfully: `1438054347_1000739383619`
✅ Episode found using pre-fetched GUID: `c5e22f17-3bc0-4d4b-a58f-9e00f163e932`
✅ Transcribed and summarized correctly

### Why This Works:

- iTunes API calls work fine in HTTP handler context
- By pre-fetching during submit, we avoid the 403 error in queue context
- The episode GUID is the most reliable matching strategy (Strategy 0)
- Fallback strategies (title/date matching) are still available if pre-fetch fails

## Environment

- Worker URL: `https://tldl.rian-db8.workers.dev`
- KV Namespace ID: `ee123158d5d54359b4257f8a1b678adf`
- Queue: `tldl-jobs`
- Current deployed version: `a8a1b591-d712-42af-b054-f10bc28e7869`
