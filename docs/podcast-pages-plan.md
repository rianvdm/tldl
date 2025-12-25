# Podcast Pages Feature - Implementation Plan

**Goal**: Enable individual pages for each podcast (e.g., `/podcasts/1335892956`) that display all summarized episodes in reverse chronological order, plus a Browse Podcasts page.

## Final Decisions

| Decision | Choice |
|----------|--------|
| URL structure | `/podcasts` (browse) and `/podcasts/:id` (individual) |
| Navigation | Add "Podcasts" link to main nav |
| Episode cards on home | Link to episode pages (unchanged) |
| Episode detail page | Add "More from X" link to podcast page |
| Podcast page pagination | 10 episodes per page |
| Browse page sorting | **Most recently updated** (by latest episode submission) |

---

## Page Designs

### 1. Browse Podcasts (`/podcasts`)

Lists all podcasts sorted by most recently updated (podcasts with newer episode submissions appear first).

```
┌─────────────────────────────────────────────┐
│ TL;DL                  Podcasts About Login │
├─────────────────────────────────────────────┤
│                                             │
│  Browse Podcasts                            │
│  All podcasts with AI summaries             │
│                                             │
│  ─────────────────────────────────────────  │
│                                             │
│  ┌─────────────────────────────┐            │
│  │ 🎙️ This American Life      →│            │
│  │    12 episodes • Updated Dec 20          │
│  └─────────────────────────────┘            │
│                                             │
│  ┌─────────────────────────────┐            │
│  │ 🎙️ Huberman Lab            →│            │
│  │    8 episodes • Updated Dec 18           │
│  └─────────────────────────────┘            │
│                                             │
└─────────────────────────────────────────────┘
```

### 2. Individual Podcast (`/podcasts/:id`)

Shows all episodes from that podcast, paginated, in reverse chronological order.

```
┌─────────────────────────────────────────────┐
│ TL;DL                  Podcasts About Login │
├─────────────────────────────────────────────┤
│                                             │
│  ← Back to all podcasts                     │
│                                             │
│  This American Life                         │
│  12 episodes summarized                     │
│  [Visit Website ↗]                          │
│                                             │
│  ─────────────────────────────────────────  │
│                                             │
│  ┌─────────────────────────────┐            │
│  │ Episode Title Here         →│            │
│  │ Dec 20, 2024 • 45m          │            │
│  │ psychology • Key Takeaways  │            │
│  └─────────────────────────────┘            │
│                                             │
│  Page 1 of 2    [Previous] [Next]           │
│                                             │
└─────────────────────────────────────────────┘
```

### 3. Episode Detail (Modified)

Add a link below the episode header:

```
┌─────────────────────────────────────────────┐
│                                             │
│  This American Life                         │
│  Episode Title Here                         │
│  Dec 20, 2024 • 45 minutes                  │
│                                             │
│  🎙️ More from This American Life →          │  ← NEW
│                                             │
└─────────────────────────────────────────────┘
```

---

## Implementation Details

### Helper: Extract Podcast ID

```typescript
// In src/lib/url-parser.ts
export function extractPodcastId(episodeId: string): string | null {
    const match = episodeId.match(/^(\d+)_/);
    return match ? match[1] : null;
}
```

### Helper: Get Podcast List

```typescript
// In src/lib/kv.ts
export interface PodcastInfo {
    id: string;
    name: string;
    episodeCount: number;
    latestEpisodeDate: string;  // createdAt of most recent episode submission
}

export async function getPodcastList(kv: KVNamespace): Promise<PodcastInfo[]> {
    const index = await getEpisodeIndex(kv);
    
    const podcasts = new Map<string, PodcastInfo>();
    
    for (const ep of index) {
        const podcastId = extractPodcastId(ep.id);
        if (!podcastId) continue;
        
        const existing = podcasts.get(podcastId);
        if (existing) {
            existing.episodeCount++;
            // Track latest by createdAt (submission date), not episodeDate
            if (ep.createdAt > existing.latestEpisodeDate) {
                existing.latestEpisodeDate = ep.createdAt;
            }
        } else {
            podcasts.set(podcastId, {
                id: podcastId,
                name: ep.podcastName,
                episodeCount: 1,
                latestEpisodeDate: ep.createdAt,
            });
        }
    }
    
    // Sort by most recently updated
    return Array.from(podcasts.values())
        .sort((a, b) => b.latestEpisodeDate.localeCompare(a.latestEpisodeDate));
}
```

### Helper: Get Episodes for Podcast

```typescript
// In src/lib/kv.ts
export async function getEpisodesForPodcast(
    kv: KVNamespace,
    podcastId: string,
    options?: { page?: number; pageSize?: number }
): Promise<PaginatedEpisodes> {
    const page = Math.max(1, options?.page ?? 1);
    const pageSize = options?.pageSize ?? 10;
    
    const index = await getEpisodeIndex(kv);
    const podcastEpisodes = index.filter(ep => ep.id.startsWith(`${podcastId}_`));
    
    const total = podcastEpisodes.length;
    const totalPages = Math.ceil(total / pageSize);
    const start = (page - 1) * pageSize;
    const episodes = podcastEpisodes.slice(start, start + pageSize);
    
    return { episodes, total, page, pageSize, totalPages };
}
```

---

## File Changes Summary

| File | Change |
|------|--------|
| `src/lib/url-parser.ts` | Add `extractPodcastId()` |
| `src/lib/kv.ts` | Add `PodcastInfo` type, `getPodcastList()`, `getEpisodesForPodcast()` |
| `src/routes/public.ts` | Add `GET /podcasts` route |
| `src/routes/public.ts` | Add `GET /podcasts/:id` route |
| `src/routes/public.ts` | Modify episode detail with podcast link |
| `src/routes/public.ts` | Add "Podcasts" to nav in Layout |
| `src/lib/styles.ts` | Add podcast page/card styles |

---

## Verification Plan

### Manual Testing Checklist
- [ ] Nav shows "Podcasts" link
- [ ] `/podcasts` displays all podcasts sorted by most recently updated
- [ ] Clicking podcast card goes to `/podcasts/{id}`
- [ ] `/podcasts/{id}` shows episodes in reverse chronological order
- [ ] Pagination works on podcast page
- [ ] Episode detail shows "More from X" link
- [ ] "More from X" link navigates to correct podcast page
- [ ] "Back to all podcasts" link works
- [ ] 404 page for invalid podcast ID
- [ ] Mobile responsive
