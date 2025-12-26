# Overcast.fm Link Support Implementation Plan

> **Status:** Proposed, not yet implemented  
> **Last updated:** 2025-12-26

## Overview

Allow users to submit Overcast.fm share links (e.g., `https://overcast.fm/+NvaKsZXMQ`) in addition to Apple Podcasts URLs.

---

## Key Challenges

### 1. Podcasts Not on Apple Podcasts

Overcast indexes podcasts by RSS feed, not Apple Podcasts. Some podcasts exist in Overcast but **not** on Apple Podcasts.

**Solution:** Use **RSS feed URL** as the canonical identifier, not Apple ID:
- Podcast Index can search by title → returns `feedUrl`
- Derive episode ID as `hash(feedUrl)_hash(episodeGuid)`
- Works for any podcast with an RSS feed

### 2. Blocklist Compatibility

Current blocklist matches URL patterns like `id1234567890` against the submitted URL. Overcast URLs don't contain Apple IDs.

**Solution:** Refactor blocklist to match on **podcast name** or **RSS feed URL**:

```typescript
// Before: URL pattern matching
const BLOCKED_PODCASTS = ["id1234567890"];

// After: Multiple matching strategies
const BLOCKED_PODCASTS = [
    { type: "name", pattern: "Some Podcast Name" },
    { type: "feedUrl", pattern: "feeds.example.com/podcast" },
    { type: "appleId", pattern: "1234567890" },
];
```

Blocklist check moves from pre-processing to post-scraping (after we have podcast name/feed URL).

---

## Proposed Architecture

### New Abstraction: `ParsedPodcastUrl`

```typescript
interface ParsedPodcastUrl {
    source: "apple" | "overcast";
    originalUrl: string;
    podcastName?: string;
    episodeTitle?: string;
    feedUrl?: string;
}
```

### Episode ID Strategy

```typescript
function deriveEpisodeId(feedUrl: string, episodeGuid: string): string {
    const feedHash = hashString(feedUrl).slice(0, 8);
    const guidHash = hashString(episodeGuid).slice(0, 12);
    return `${feedHash}_${guidHash}`;
}
```

Same episode from different sources = same cache entry.

---

## Implementation Phases

### Phase 1: Core Infrastructure
- `src/lib/constants.ts` - Refactor blocklist to support multiple match types
- `src/lib/url-parser.ts` - Add `parseOvercastUrl()` and unified `parsePodcastUrl()`
- `src/services/overcast.ts` [NEW] - Scrape Overcast pages for metadata

### Phase 2: Podcast Index
- `src/services/podcast-index.ts` - Add `searchPodcastByTitle()`

### Phase 3: Metadata Pipeline
- `src/services/episode-metadata.ts` [NEW] - Unified entry point

### Phase 4: Types & UI
- `src/types/index.ts` - Rename `appleUrl` → `sourceUrl`, add `sourceType`
- `src/routes/public.ts` - Update form and validation

---

## Estimated Effort

| Phase | Effort |
|-------|--------|
| Core infrastructure | 2 hours |
| Podcast Index search | 1 hour |
| Metadata pipeline | 2 hours |
| Types + UI | 2 hours |
| Testing | 1 hour |
| **Total** | **~8 hours** |
