# Podcast Index Integration Plan

## Overview

Replace the iTunes Lookup API with Podcast Index API to solve the 403 Forbidden errors from Cloudflare Workers and get access to full episode archives.

## Problem

Apple's iTunes API blocks certain Cloudflare Workers IP addresses, causing inconsistent 403 errors. Additionally, some podcast RSS feeds only contain recent episodes (e.g., This American Life shows 14 episodes instead of 800+).

## Solution

Use [Podcast Index](https://podcastindex.org) as the primary episode lookup service. Podcast Index:
- Has no IP blocking issues with Cloudflare Workers
- Indexes **full episode archives** for podcasts
- Provides rich episode metadata (GUID, duration, enclosure URL)
- Is free with generous rate limits

## Prerequisites

1. **Register for API credentials** at https://podcastindex.org/signup (free, ~30 seconds)
2. Add secrets to Cloudflare:
   ```bash
   wrangler secret put PODCAST_INDEX_KEY
   wrangler secret put PODCAST_INDEX_SECRET
   ```
3. Add to `.dev.vars` for local development:
   ```
   PODCAST_INDEX_KEY=your_key_here
   PODCAST_INDEX_SECRET=your_secret_here
   ```

## API Authentication

Podcast Index uses HMAC-SHA1 authentication:

```typescript
// Required headers for every request
const apiKey = env.PODCAST_INDEX_KEY;
const apiSecret = env.PODCAST_INDEX_SECRET;
const apiHeaderTime = Math.floor(Date.now() / 1000);
const hash = sha1(apiKey + apiSecret + apiHeaderTime);

const headers = {
    "X-Auth-Date": apiHeaderTime.toString(),
    "X-Auth-Key": apiKey,
    "Authorization": hash,
    "User-Agent": "TLDL/1.0"
};
```

## API Endpoints We'll Use

### 1. Get Podcast by iTunes ID
```
GET https://api.podcastindex.org/api/1.0/podcasts/byitunesid?id={itunesId}
```

Returns:
- `feed.id` - Podcast Index feed ID
- `feed.url` - RSS feed URL  
- `feed.title` - Podcast name
- `feed.itunesId` - Confirms the iTunes ID

### 2. Get Episodes by iTunes ID
```
GET https://api.podcastindex.org/api/1.0/episodes/byitunesid?id={itunesId}&max=1000
```

Returns array of episodes with:
- `id` - Podcast Index episode ID
- `title` - Episode title
- `datePublished` - Unix timestamp
- `duration` - Seconds
- `enclosureUrl` - Audio file URL
- `guid` - Episode GUID (for RSS matching)
- `feedItunesId` - iTunes podcast ID
- `transcriptUrl` - If available (some podcasts have this!)

## Implementation Plan

### Step 1: Add Types (`src/types/index.ts`)

Add to `Env` interface:
```typescript
PODCAST_INDEX_KEY: string;
PODCAST_INDEX_SECRET: string;
```

### Step 2: Create Podcast Index Service (`src/services/podcast-index.ts`)

```typescript
// New file: src/services/podcast-index.ts

import { createHmac } from "node:crypto"; // Works in CF Workers

export interface PodcastIndexPodcast {
    id: number;
    url: string;           // RSS feed URL
    title: string;
    itunesId: number;
}

export interface PodcastIndexEpisode {
    id: number;
    title: string;
    datePublished: number;  // Unix timestamp
    duration: number;       // Seconds
    enclosureUrl: string;   // Audio URL
    guid: string;
    transcriptUrl?: string;
}

/**
 * Generate auth headers for Podcast Index API
 */
function getAuthHeaders(apiKey: string, apiSecret: string): HeadersInit {
    const apiHeaderTime = Math.floor(Date.now() / 1000);
    const data = apiKey + apiSecret + apiHeaderTime;
    const hash = createHmac('sha1', apiSecret).update(data).digest('hex');
    
    return {
        "X-Auth-Date": apiHeaderTime.toString(),
        "X-Auth-Key": apiKey,
        "Authorization": hash,
        "User-Agent": "TLDL/1.0 (Podcast Summary Service)"
    };
}

/**
 * Look up podcast by iTunes ID
 */
export async function lookupPodcastByItunesId(
    itunesId: string,
    apiKey: string,
    apiSecret: string
): Promise<PodcastIndexPodcast | null> {
    const url = `https://api.podcastindex.org/api/1.0/podcasts/byitunesid?id=${itunesId}`;
    
    const response = await fetch(url, {
        headers: getAuthHeaders(apiKey, apiSecret)
    });
    
    if (!response.ok) {
        console.error(`Podcast Index lookup failed: ${response.status}`);
        return null;
    }
    
    const data = await response.json();
    if (!data.feed) return null;
    
    return {
        id: data.feed.id,
        url: data.feed.url,
        title: data.feed.title,
        itunesId: data.feed.itunesId
    };
}

/**
 * Get all episodes for a podcast by iTunes ID
 */
export async function getEpisodesByItunesId(
    itunesId: string,
    apiKey: string,
    apiSecret: string,
    max: number = 1000
): Promise<PodcastIndexEpisode[]> {
    const url = `https://api.podcastindex.org/api/1.0/episodes/byitunesid?id=${itunesId}&max=${max}`;
    
    const response = await fetch(url, {
        headers: getAuthHeaders(apiKey, apiSecret)
    });
    
    if (!response.ok) {
        console.error(`Podcast Index episodes failed: ${response.status}`);
        return [];
    }
    
    const data = await response.json();
    return data.items || [];
}

/**
 * Find episode matching Apple episode ID
 * 
 * Apple episode IDs don't have a direct mapping, so we match by:
 * 1. GUID (if it contains the episode ID)
 * 2. Title + approximate date
 * 3. Enclosure URL patterns
 */
export function findEpisodeByAppleId(
    episodes: PodcastIndexEpisode[],
    appleEpisodeId: string,
    expectedTitle?: string,
    expectedDate?: string
): PodcastIndexEpisode | null {
    // Strategy 1: Check if GUID contains the Apple episode ID
    const byGuid = episodes.find(ep => 
        ep.guid?.includes(appleEpisodeId)
    );
    if (byGuid) return byGuid;
    
    // Strategy 2: Match by title (fuzzy)
    if (expectedTitle) {
        const normalizedExpected = expectedTitle.toLowerCase().trim();
        const byTitle = episodes.find(ep => {
            const normalizedTitle = ep.title.toLowerCase().trim();
            return normalizedTitle === normalizedExpected ||
                   normalizedTitle.includes(normalizedExpected) ||
                   normalizedExpected.includes(normalizedTitle);
        });
        if (byTitle) return byTitle;
    }
    
    // Strategy 3: Match by date
    if (expectedDate) {
        const expectedTimestamp = new Date(expectedDate).getTime() / 1000;
        const byDate = episodes.find(ep => {
            const diff = Math.abs(ep.datePublished - expectedTimestamp);
            return diff < 86400; // Within 24 hours
        });
        if (byDate) return byDate;
    }
    
    return null;
}
```

### Step 3: Update `apple-podcasts.ts`

Modify `getEpisodeMetadata()` to:
1. First try Podcast Index (primary)
2. Fall back to iTunes + RSS if Podcast Index fails (backup)

```typescript
export async function getEpisodeMetadata(
    parsedUrl: ParsedAppleUrl,
    env: Env,  // Add env parameter
    options?: GetEpisodeMetadataOptions
): Promise<EpisodeMetadata> {
    
    // Try Podcast Index first (primary)
    if (env.PODCAST_INDEX_KEY && env.PODCAST_INDEX_SECRET) {
        const result = await getEpisodeFromPodcastIndex(
            parsedUrl.podcastId,
            parsedUrl.episodeId,
            env.PODCAST_INDEX_KEY,
            env.PODCAST_INDEX_SECRET,
            options
        );
        if (result) return result;
    }
    
    // Fall back to iTunes + RSS (existing code)
    // ... existing implementation ...
}
```

### Step 4: Update Callers

Update these files to pass `env` to `getEpisodeMetadata()`:
- `src/queue/consumer.ts` - `processEpisode()`
- `src/index.ts` - Debug routes

### Step 5: Update wrangler.toml

No changes needed - secrets are added via CLI.

### Step 6: Tests

Create `test/podcast-index.test.ts`:
- Mock API responses
- Test auth header generation
- Test episode matching strategies
- Test fallback behavior

## File Changes Summary

| File | Change |
|------|--------|
| `src/types/index.ts` | Add `PODCAST_INDEX_KEY`, `PODCAST_INDEX_SECRET` to `Env` |
| `src/services/podcast-index.ts` | **NEW** - Podcast Index API client |
| `src/services/apple-podcasts.ts` | Add `prefetchEpisodeInfo` with Apple redirect fallback, `getEpisodeFromPodcastIndex` |
| `src/services/transcription.ts` | Accept `binary/octet-stream` content type for audio |
| `src/routes/authenticated.ts` | Pass `appleUrl` to `prefetchEpisodeInfo` |
| `src/routes/public.ts` | Pass `appleUrl` to `prefetchEpisodeInfo` |
| `src/queue/consumer.ts` | Pass `env` to `getEpisodeMetadata()` |
| `src/index.ts` | Pass `env` to debug route |
| `test/podcast-index.test.ts` | **NEW** - Tests for Podcast Index |

## Actual Implementation (Dec 2024)

The implementation differs slightly from the original plan:

### Episode Title Resolution Flow

1. **HTTP prefetch** (`prefetchEpisodeInfo`):
   - Try iTunes API → if works, use it
   - If iTunes 403s → fetch Apple Podcasts URL with `redirect: "manual"`
   - Extract episode title from redirect URL slug (e.g., `the-100-person-ai-lab` → `the 100 person ai lab`)
   - Match title in Podcast Index to get full metadata

2. **Queue consumer** (`getEpisodeMetadata`):
   - Try Podcast Index with prefetched `expectedTitle` → match by title
   - Falls back to iTunes + RSS if Podcast Index fails

### Key Insight

Apple Podcasts redirects to a canonical URL containing the episode title slug:
```
Input:  https://podcasts.apple.com/us/podcast/lennys-podcast/id123?i=456
Redirect: https://podcasts.apple.com/us/podcast/episode-title-here/id123?i=456
```

This allows us to get the episode title without the iTunes API.

## Rollback Plan

If issues occur:
1. Set `PODCAST_INDEX_KEY` to empty string
2. System automatically falls back to iTunes + RSS

## Notes

- Podcast Index sometimes has `transcriptUrl` in the episode data - free transcript!
- Episode matching uses fuzzy title matching since Apple IDs don't map directly
- Rate limit is 10 requests/second (very generous)
- API keys never expire
- Some audio URLs return `binary/octet-stream` instead of `audio/*` - this is now accepted

## Resources

- API Docs: https://podcastindex-org.github.io/docs-api/
- Sign up: https://podcastindex.org/signup
- GitHub: https://github.com/Podcastindex-org
