# YouTube URL Support — Design Spec

*Date: 2026-03-18*
*Status: Draft*

## Overview

Add support for YouTube URLs alongside Apple Podcasts URLs. Users can submit a YouTube video link and receive an AI-generated summary, using the video's captions as the transcript source. If no captions are available, a clear error is shown. Audio transcription fallback is out of scope for this iteration.

## Scope

**In scope:**
- YouTube URL detection and parsing
- Metadata and caption extraction from YouTube watch page (no API key required)
- Summary generation using existing pipeline
- UI updates: form validation, episode page source link and icon

**Out of scope:**
- Audio download and transcription fallback for videos without captions
- YouTube playlist or channel support
- Non-English caption tracks (English preferred, auto-generated acceptable)

---

## Section 1: URL Detection & Routing

### New functions in `src/lib/url-parser.ts`

**`parseYouTubeUrl(url: string): { videoId: string } | null`**
- Accepts `youtube.com/watch?v=ID`, `youtu.be/ID`, and `youtube.com/shorts/ID`
- Returns `{ videoId }` or `null` if not a valid YouTube URL

**`detectUrlType(url: string): "apple" | "youtube" | "unknown"`**
- Calls `parseApplePodcastsUrl()` and `parseYouTubeUrl()` in sequence
- Returns the matched type or `"unknown"`

### Episode ID scheme

YouTube episodes use `yt_{videoId}` as their stable ID (e.g., `yt_dQw4w9WgXcQ`), namespaced away from Apple episode IDs.

---

## Section 2: Type Changes

### `src/types/index.ts`

**Renamed field:** `appleUrl` → `sourceUrl` on `Job`, `Episode`, and `QueueMessage`.

**New field:** `sourceType: "apple" | "youtube"` on `Job`, `Episode`, and `QueueMessage`.

**Updated union:** `TranscriptSource` gains `"youtube"` — `"apple" | "rss" | "openai" | "youtube"`.

### `QueueMessage` update

`QueueMessage` gains `videoId?: string` — populated for YouTube jobs, absent for Apple jobs. The consumer uses this directly rather than re-parsing `sourceUrl`.

### Backwards compatibility

`src/lib/kv.ts` read functions apply a shim at all KV deserialization points when reading `Episode` and `Job` records:

```ts
sourceUrl: record.sourceUrl ?? record.appleUrl
```

New writes always use `sourceUrl` only — `appleUrl` is never written on new records. Old records that have only `appleUrl` read correctly via the shim. If both fields are present (not expected but possible), `sourceUrl` takes precedence.

---

## Section 3: YouTube Service (`src/services/youtube.ts`)

### Return type

`fetchYouTubeEpisodeData()` returns a `YouTubeEpisodeData` type (not `EpisodeMetadata`), defined as:

```ts
interface YouTubeEpisodeData {
    videoTitle: string;
    channelName: string;
    durationSeconds: number;
    publishDate: string;       // ISO 8601
    transcriptText: string;    // Plain text from captions
}
```

The queue consumer maps this to the existing `Episode` shape at the callsite:
- `podcastName` ← `channelName`
- `episodeTitle` ← `videoTitle`
- `episodeDuration` ← `durationSeconds`
- `episodeDate` ← `publishDate`
- `audioUrl` ← `""` (field made optional in `Episode` type; empty string for YouTube)
- transcript stored directly from `transcriptText`, skipping the `transcriptUrl` path

### Approach

1. Fetch `https://www.youtube.com/watch?v={videoId}` with standard browser headers (`User-Agent`, `Accept-Language: en-US`)
2. Extract `ytInitialPlayerResponse` JSON blob from the page HTML via regex
3. Parse metadata: `videoDetails.title`, `videoDetails.author`, `videoDetails.lengthSeconds` (string, convert to number), `microformat.playerMicroformatRenderer.publishDate` — note: this field returns `YYYY-MM-DD` only, no time-of-day precision; this is acceptable for display purposes
4. Extract `captionTracks` from `ytInitialPlayerResponse.captions.playerCaptionsTracklistRenderer.captionTracks`
5. Prefer manually-uploaded English track (`kind` absent or not `"asr"`) over auto-generated ASR; fall back to any English ASR track
6. Fetch the caption track `baseUrl` to retrieve raw caption XML
7. Parse caption XML: decode HTML entities, strip all XML/HTML tags (not just named ones — YouTube ASR also emits `<c>` timing cues and `<font>` tags), join `text` elements with spaces, collapse whitespace

### Error handling

**Page parsing failure** — if `ytInitialPlayerResponse` cannot be extracted or parsed (video unavailable, private, region-blocked, or YouTube page structure changed):
```
AppError(ERROR_CODES.FETCH_FAILED, "Could not load video data. The video may be private, unavailable, or region-restricted.")
```

**No captions** — if `captionTracks` is absent or empty:
```
AppError(ERROR_CODES.TRANSCRIPTION_FAILED, "This video doesn't have captions available. Only videos with captions can be processed.")
```

**Caption fetch failure** — if the `baseUrl` fetch fails or returns unparseable XML:
```
AppError(ERROR_CODES.TRANSCRIPTION_FAILED, "Could not retrieve captions for this video.")
```

Note: caption `baseUrl` values are signed, time-limited Google URLs valid at the moment of the watch page fetch. If queue backpressure delays the caption fetch and the URL expires, this is treated as a standard caption fetch failure — no re-fetch of the watch page is attempted. The job can be resubmitted by the user.

### Operational note

Cloudflare Workers egress IPs are known data center ranges. YouTube may rate-limit or CAPTCHA repeated requests from the same IP. The service should apply the existing `withRetry()` utility (already used in `summarization.ts`) with conservative delays. This is a known risk of the watch-page approach; acceptable for the current scale.

---

## Section 4: Queue Consumer Changes (`src/queue/consumer.ts`)

### `ProcessingContext` update

Add `sourceType: "apple" | "youtube"` and `videoId?: string` to `ProcessingContext`, derived from the queue message.

### `processEpisode()` routing

```
if sourceType === "youtube":
    status → "fetching_metadata"
    call fetchYouTubeEpisodeData(videoId)
    → returns YouTubeEpisodeData (metadata + transcriptText)
    status → "summarizing"
    call generateSummary(transcriptText)
    store Transcript (source: "youtube"), Summary, Episode
    status → "completed"

if sourceType === "apple":
    existing pipeline unchanged
```

The YouTube path skips the RSS transcript check and transcription steps entirely.

Job status messages (`fetching_metadata`, `summarizing`, `completed`, `failed`) are the same as Apple. The existing error display path on the status page renders `AppError` user messages generically, so no new UI work is needed for YouTube-specific error cases.

---

## Section 5: Form & UI Changes (`src/routes/public.ts`)

### Form validation

`detectUrlType()` replaces the Apple-only URL check. Accepted: `"apple"` and `"youtube"`. Error message for invalid URLs:

> "Please enter an Apple Podcasts episode URL or a YouTube video URL."

### Input placeholder

Updated to reflect both URL types:
> "Apple Podcasts or YouTube URL"

### Episode page

Source link and icon render conditionally based on `sourceType`:

| `sourceType` | Icon | Link text |
|---|---|---|
| `apple` | Apple Podcasts SVG (existing) | "Listen on Apple Podcasts" |
| `youtube` | YouTube SVG (inline, new) | "Watch on YouTube" |

---

## Data Flow Summary

```
User submits URL
  → detectUrlType()
  → "youtube": parseYouTubeUrl() → videoId → episodeId = "yt_{videoId}"
  → queue job: { sourceType: "youtube", videoId, sourceUrl, ... }

Queue consumer:
  → fetchYouTubeEpisodeData(videoId)
      → fetch watch page
      → parse ytInitialPlayerResponse → metadata + captionTracks
      → fetch caption XML → plain text transcript
  → generateSummary(transcriptText)
  → store Transcript (source: "youtube"), Summary, Episode in KV
  → status → completed
```

---

## Files Changed

| File | Change |
|------|--------|
| `src/lib/url-parser.ts` | Add `parseYouTubeUrl()`, `detectUrlType()` |
| `src/types/index.ts` | Rename `appleUrl→sourceUrl`, add `sourceType`, extend `TranscriptSource`, add `YouTubeEpisodeData`, make `audioUrl` optional on `Episode` |
| `src/lib/kv.ts` | Backwards-compat shim on all read/deserialization points |
| `src/services/youtube.ts` | New file — watch page fetch, metadata + caption extraction |
| `src/queue/consumer.ts` | Add `sourceType` + `videoId` to context, YouTube routing in `processEpisode()` |
| `src/routes/public.ts` | URL validation, placeholder, episode page icon/link |

---

## Out of Scope / Future Work

- Audio transcription fallback for videos without captions (requires external audio extraction service)
- Non-English caption support
- YouTube playlist/channel monitoring
- Handling YouTube's potential rate-limiting with smarter egress (e.g., rotating headers, caching watch page responses)
