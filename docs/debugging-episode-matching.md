# Debugging Episode Matching Issue

**Date**: December 20, 2025  
**Status**: In Progress

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

## Root Cause Hypothesis

The `lookupEpisodeInfo()` function is returning `null` in the queue consumer context, but the same function works in the HTTP handler context. Possible causes:

1. **iTunes API rate limiting** in queue context (different IP/region?)
2. **Fetch behavior difference** between HTTP handler and queue handler
3. **Silent error** being caught and returning null

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

## Proposed Fix (After Root Cause Confirmed)

If the issue is that `lookupEpisodeInfo` fails silently, we should:

1. Make the title/date fallback matching more robust (it should work even without `episodeGuid`)
2. Add better error logging to understand why iTunes lookup fails in queue context
3. Consider caching iTunes lookup results to avoid repeated API calls

## Environment

- Worker URL: `https://tldl.rian-db8.workers.dev`
- KV Namespace ID: `ee123158d5d54359b4257f8a1b678adf`
- Queue: `tldl-jobs`
- Current deployed version: `a8a1b591-d712-42af-b054-f10bc28e7869`
