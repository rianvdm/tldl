# TLDL - Too Long Didn't Listen

## Product Specification v1.0

A web application that extracts transcripts from Apple Podcasts episodes and generates AI-powered summaries with configurable templates.

---

## Design

[Figma designs](https://www.figma.com/make/02o5xyaLA0LQXiqfaaDTta/TLDL?t=Eeo8zOk0EUbWs2p8-0) (generated via Figma Make from this spec)

**Exported components** in `design/`:
- `src/app/components/` - React components for all pages (EpisodeList, EpisodeDetail, SubmitForm, JobStatus)
- `src/app/components/ui/` - Full shadcn/ui component library (Tailwind + Radix UI)
- `src/styles/` - Tailwind config with dark theme, fonts, CSS variables
- `src/app/data/mockData.ts` - 5 example episodes with transcripts and summaries

Design decisions: Dark mode default, minimalist aesthetic, mobile-responsive. Use these components as reference for styling Hono server-rendered templates.

---

## Table of Contents

1. [Overview](#overview)
2. [User Stories](#user-stories)
3. [Architecture](#architecture)
4. [Data Models](#data-models)
5. [API Endpoints](#api-endpoints)
6. [Core Workflows](#core-workflows)
7. [UI/UX Requirements](#uiux-requirements)
8. [Configuration](#configuration)
9. [Error Handling](#error-handling)
10. [Security](#security)
11. [Testing Plan](#testing-plan)
12. [Future Considerations](#future-considerations)

---

## Overview

### Purpose

TLDL allows users to submit Apple Podcasts episode URLs and receive AI-generated summaries focused on key takeaways, practical steps, or simplified explanations. Transcripts and summaries are cached for one year and available publicly once completed.

### Target Users

- Primary: Small group of friends (authenticated via Cloudflare Access)
- Secondary: Public read-only access to completed summaries

### Tech Stack

| Component | Technology |
|-----------|------------|
| Runtime | Cloudflare Workers |
| Framework | Hono |
| Background Jobs | Cloudflare Queues |
| Storage | Cloudflare Workers KV |
| Episode Metadata | Podcast Index API (primary), iTunes API (fallback) |
| Transcription (primary) | Existing transcripts (Apple Podcasts, RSS) |
| Transcription (fallback) | OpenAI Whisper API |
| Summarization | OpenAI GPT-5.2 (Responses API) |
| Authentication | Cloudflare Access (Email OTP) |
| PDF Generation | jsPDF (in-Worker) |

---

## User Stories

### Authenticated Users

1. **Submit Episode**: As an authenticated user, I can paste an Apple Podcasts episode URL, select a summary template, and submit it for processing.

2. **View Job Status**: As an authenticated user, I can see the current status of my submitted job (queued, processing phase, estimated time, completed, failed).

3. **Regenerate Summary**: As an authenticated user, I can regenerate a summary using a different template without re-transcribing.

4. **Delete Episode**: As an authenticated user, I can delete any episode from the system.

### Public Users

5. **View Summary**: As a public user, I can view any completed episode's summary and transcript via its permalink.

6. **Browse Episodes**: As a public user, I can browse a list of all completed episode summaries.

7. **Download PDF**: As a public user, I can download a PDF containing the summary and transcript.

---

## Architecture

### System Diagram

```
┌─────────────────────────────────────────────────────────────────────┐
│                         Cloudflare Access                           │
│                        (Email OTP Auth)                             │
└─────────────────────────────────────────────────────────────────────┘
                                   │
                                   ▼
┌─────────────────────────────────────────────────────────────────────┐
│                          Hono Worker                                │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐                 │
│  │   Public    │  │ Authenticated│  │    API      │                 │
│  │   Routes    │  │   Routes     │  │   Routes    │                 │
│  └─────────────┘  └─────────────┘  └─────────────┘                 │
└─────────────────────────────────────────────────────────────────────┘
           │                │                    │
           ▼                ▼                    ▼
┌─────────────────┐ ┌─────────────────┐ ┌─────────────────┐
│  Workers KV     │ │ Cloudflare      │ │  External APIs  │
│  - transcripts  │ │ Queues          │ │  - OpenAI       │
│  - summaries    │ │                 │ │  - Podcast Index│
│  - jobs         │ │                 │ │  - iTunes API   │
│                 │ │                 │ │  - RSS Feeds    │
└─────────────────┘ └─────────────────┘ └─────────────────┘
```

### Request Flow

1. User submits episode URL → Worker validates and creates job
2. Job queued to Cloudflare Queues
3. Queue consumer processes job:
   - Fetch episode metadata from Apple/RSS
   - Check for existing transcript
   - If none, transcribe via OpenAI Whisper (with chunking)
   - Generate summary via GPT-5.2
   - Store results in KV
4. User polls for status or returns later to view results

### Monorepo Structure

```
tldl/
├── src/
│   ├── index.ts              # Hono app entry point
│   ├── routes/
│   │   ├── public.ts         # Public routes (list, view, PDF)
│   │   ├── authenticated.ts  # Protected routes (submit, delete, regenerate)
│   │   └── api.ts            # Internal API routes
│   ├── services/
│   │   ├── apple-podcasts.ts # Apple/iTunes API integration
│   │   ├── rss.ts            # RSS feed parsing
│   │   ├── transcription.ts  # Transcript fetching + OpenAI Whisper
│   │   ├── summarization.ts  # GPT-5.2 summary generation
│   │   └── pdf.ts            # PDF generation
│   ├── queue/
│   │   └── consumer.ts       # Queue message handler
│   ├── lib/
│   │   ├── kv.ts             # KV helpers
│   │   ├── audio.ts          # Audio chunking utilities
│   │   └── utils.ts          # Shared utilities
│   └── types/
│       └── index.ts          # TypeScript types
├── public/
│   └── styles.css            # CSS (reference listentomore repo)
├── wrangler.toml
├── package.json
├── tsconfig.json
└── README.md
```

---

## Data Models

### KV Namespaces

Single KV namespace: `TLDL_DATA`

### Key Schemas

#### Job Record

```
Key: job:{job_id}
TTL: 7 days (jobs are temporary)

Value: {
  id: string,                    // UUID
  episodeId: string,             // Derived from Apple Podcasts URL
  appleUrl: string,              // Original submitted URL
  status: "queued" | "fetching_metadata" | "checking_transcript" | 
          "transcribing" | "summarizing" | "completed" | "failed",
  templateId: string,            // Template used for this job
  error?: string,                // Error message if failed
  estimatedSeconds?: number,     // Rough time estimate
  createdAt: string,             // ISO timestamp
  updatedAt: string              // ISO timestamp
}
```

#### Episode Record

```
Key: episode:{episode_id}
TTL: 31536000 (365 days)

Value: {
  id: string,                    // Derived from Apple episode ID
  appleUrl: string,              // Original Apple Podcasts URL
  podcastName: string,
  episodeTitle: string,
  episodeDuration: number,       // Seconds
  episodeDate: string,           // Original publish date
  audioUrl: string,              // Source audio URL
  transcriptSource: "apple" | "rss" | "openai",
  createdAt: string,             // ISO timestamp
  expiresAt: string              // ISO timestamp (createdAt + 365 days)
}
```

#### Transcript Record

```
Key: transcript:{episode_id}
TTL: 31536000 (365 days)

Value: {
  episodeId: string,
  text: string,                  // Full transcript text
  source: "apple" | "rss" | "openai",
  createdAt: string
}
```

#### Summary Record

```
Key: summary:{episode_id}:{template_id}
TTL: 31536000 (365 days)

Value: {
  episodeId: string,
  templateId: string,
  text: string,                  // Generated summary (markdown)
  model: string,                 // e.g., "gpt-5.2"
  createdAt: string
}
```

### Summary Templates

```typescript
const TEMPLATES = {
  "key-takeaways": {
    id: "key-takeaways",
    name: "Key Takeaways & Practical Steps",
    description: "For craft and professional development podcasts",
    prompt: `Analyze this podcast transcript and provide:

1. A brief overview of the episode's main topic (2-3 sentences)

2. Key Takeaways: The most important insights and learnings from this conversation. Focus on novel ideas, counterintuitive points, and expert knowledge shared.

3. Practical Steps: Actionable advice listeners can implement. Be specific about what to do, not just what to think about.

4. Notable Quotes: 2-3 standout quotes that capture essential ideas (include speaker if identifiable).

Keep the tone professional but accessible. Use paragraphs for narrative sections and bullets only where they aid clarity. Total length: 400-600 words.`
  },
  
  "narrative-summary": {
    id: "narrative-summary",
    name: "Narrative Summary",
    description: "For story-driven and interview podcasts",
    prompt: `Provide a cohesive narrative summary of this podcast episode.

Write in flowing paragraphs that capture:
- The arc of the conversation or story
- Key moments and turning points
- The main themes explored
- How ideas connect and build on each other

Avoid bullet points. Write as if you're telling a friend about a fascinating conversation you overheard. Capture the essence without losing the nuance.

Total length: 400-600 words.`
  },
  
  "eli5": {
    id: "eli5",
    name: "ELI5 (Explain Like I'm 5)",
    description: "For technical and complex topics",
    prompt: `Explain the main ideas from this podcast in simple, accessible language that anyone could understand.

Break down complex concepts using:
- Everyday analogies and comparisons
- Simple vocabulary (avoid jargon, or explain it plainly)
- Concrete examples

Structure your explanation as:
1. What's the big idea? (1-2 sentences)
2. Why does it matter? (1 paragraph)
3. Key concepts explained simply (2-3 paragraphs)
4. The bottom line (2-3 sentences)

Be accurate while being accessible. Total length: 400-600 words.`
  }
};
```

---

## API Endpoints

### Public Routes (No Auth)

#### `GET /`
Episode list page showing all completed summaries.

**Response**: HTML page with episode cards sorted by most recent.

#### `GET /episode/:episodeId`
Episode detail page with summary and transcript.

**Response**: HTML page with:
- Episode metadata (podcast name, title, date, duration)
- Summary (most recent or specified template)
- All available summary templates for this episode
- Full transcript
- PDF download button
- Expiration countdown

#### `GET /episode/:episodeId/pdf`
Download PDF of summary + transcript.

**Response**: PDF file download

**PDF Structure**:
1. Header: Podcast name, episode title, date
2. Summary section
3. Transcript section
4. Footer: Generated by TLDL, expiration date

#### `GET /api/episodes`
JSON endpoint for episode list.

**Response**:
```json
{
  "episodes": [
    {
      "id": "string",
      "podcastName": "string",
      "episodeTitle": "string",
      "episodeDate": "string",
      "summaryTemplates": ["key-takeaways", "eli5"],
      "createdAt": "string",
      "expiresAt": "string"
    }
  ]
}
```

### Authenticated Routes (Behind Cloudflare Access)

#### `GET /submit`
Episode submission form.

**Response**: HTML form with URL input and template selector.

#### `POST /submit`
Submit new episode for processing.

**Request Body**:
```json
{
  "appleUrl": "https://podcasts.apple.com/...",
  "templateId": "key-takeaways"
}
```

**Response**:
```json
{
  "jobId": "uuid",
  "status": "queued",
  "episodeId": "string",       // If URL already cached
  "cached": boolean            // True if episode already processed
}
```

**Validation**:
- URL must be valid Apple Podcasts episode URL
- Template must be valid template ID

#### `GET /job/:jobId`
Job status page with progress updates.

**Response**: HTML page with:
- Current status
- Progress indicator
- Estimated time remaining (if available)
- Error message (if failed)
- Retry button (if failed)
- Link to episode (if completed)

#### `GET /api/job/:jobId`
JSON endpoint for job status (for polling).

**Response**:
```json
{
  "id": "string",
  "status": "transcribing",
  "episodeId": "string",
  "estimatedSeconds": 120,
  "error": null,
  "updatedAt": "string"
}
```

#### `POST /episode/:episodeId/regenerate`
Regenerate summary with different template.

**Request Body**:
```json
{
  "templateId": "eli5"
}
```

**Response**:
```json
{
  "jobId": "uuid",
  "status": "queued"
}
```

#### `DELETE /episode/:episodeId`
Delete episode and all associated data.

**Response**:
```json
{
  "deleted": true
}
```

#### `POST /job/:jobId/retry`
Retry a failed job.

**Response**:
```json
{
  "jobId": "uuid",
  "status": "queued"
}
```

---

## Core Workflows

### 1. Episode Submission Flow

```
User submits Apple Podcasts URL
         │
         ▼
┌─────────────────────────────┐
│ Validate URL format         │
│ Extract episode identifier  │
└─────────────────────────────┘
         │
         ▼
┌─────────────────────────────┐
│ Check KV for existing       │
│ episode + requested template│
└─────────────────────────────┘
         │
    ┌────┴────┐
    │         │
 Cached    Not Cached
    │         │
    ▼         ▼
 Return    Create job record
 cached    Queue for processing
 result    Return job ID
```

### 2. Queue Processing Flow

```
Queue receives job message
         │
         ▼
┌─────────────────────────────┐
│ Status: fetching_metadata   │
│ Fetch from iTunes API       │
│ Parse RSS feed              │
│ Extract episode metadata    │
└─────────────────────────────┘
         │
         ▼
┌─────────────────────────────┐
│ Validate duration           │
│ (reject if > 80 minutes)    │
└─────────────────────────────┘
         │
         ▼
┌─────────────────────────────┐
│ Status: checking_transcript │
│ Check Apple Podcasts API    │
│ Check RSS <podcast:transcript>│
└─────────────────────────────┘
         │
    ┌────┴────┐
    │         │
 Found     Not Found
    │         │
    ▼         ▼
 Store    ┌─────────────────────────────┐
 in KV    │ Status: transcribing        │
    │     │ Download audio              │
    │     │ Chunk if needed (25MB limit)│
    │     │ Send to OpenAI Whisper      │
    │     │ Stitch chunks together      │
    │     └─────────────────────────────┘
    │         │
    └────┬────┘
         │
         ▼
┌─────────────────────────────┐
│ Status: summarizing         │
│ Send transcript + template  │
│ prompt to GPT-5.2           │
│ (Responses API)             │
└─────────────────────────────┘
         │
         ▼
┌─────────────────────────────┐
│ Status: completed           │
│ Store episode, transcript,  │
│ summary in KV               │
│ Set TTL: 365 days           │
└─────────────────────────────┘
```

### 3. Apple Podcasts URL → Audio Flow

```typescript
// Step 1: Parse Apple Podcasts URL
// Expected format: https://podcasts.apple.com/us/podcast/{podcast-name}/id{podcast_id}?i={episode_id}
// Extract: podcast_id, episode_id

// Step 2: iTunes Lookup API
// GET https://itunes.apple.com/lookup?id={podcast_id}&entity=podcast
// Extract: feedUrl (RSS feed URL)

// Step 3: Fetch and parse RSS feed
// Find episode by matching:
//   - <guid> or <itunes:episode> matching episode_id
//   - Or fuzzy match on <title> as fallback

// Step 4: Extract from episode entry
// - <enclosure url="..."> → audio file URL
// - <itunes:duration> → duration in seconds
// - <title> → episode title
// - <pubDate> → publish date
// - <podcast:transcript> → transcript URL (if available)
```

### 4. Audio Chunking Flow (OpenAI Whisper)

```typescript
// OpenAI Whisper limit: 25MB per request

async function transcribeWithChunking(audioUrl: string): Promise<string> {
  const audioBuffer = await fetchAudio(audioUrl);
  
  if (audioBuffer.byteLength <= 25 * 1024 * 1024) {
    // Under limit, single request
    return await transcribeSingle(audioBuffer);
  }
  
  // Split into chunks
  // Strategy: Split by time segments to avoid cutting mid-word
  // Use ffmpeg (via WASM or external service) to:
  // 1. Downsample to 16kHz mono (reduces size)
  // 2. Split into ~20MB chunks with slight overlap
  
  const chunks = await splitAudio(audioBuffer, {
    maxSizeBytes: 20 * 1024 * 1024,
    overlapSeconds: 2  // Overlap to avoid lost words at boundaries
  });
  
  const transcripts = await Promise.all(
    chunks.map(chunk => transcribeSingle(chunk))
  );
  
  // Stitch together, removing duplicate overlap text
  return stitchTranscripts(transcripts);
}
```

### 5. Regenerate Flow

```
User requests regenerate with new template
         │
         ▼
┌─────────────────────────────┐
│ Check if transcript exists  │
│ in KV (should always exist) │
└─────────────────────────────┘
         │
         ▼
┌─────────────────────────────┐
│ Create new job              │
│ Skip to summarizing step    │
│ (no transcription needed)   │
└─────────────────────────────┘
         │
         ▼
┌─────────────────────────────┐
│ Store new summary with      │
│ template ID in key          │
│ summary:{episode}:{template}│
└─────────────────────────────┘
```

---

## UI/UX Requirements

### General

- Mobile-friendly responsive design
- Dark mode support
- Minimalist aesthetic
- Reference CSS patterns from `listentomore` repo (details TBD)

### Pages

#### Home / Episode List (`/`)

**Public view:**
- List of completed episode cards
- Sorted by most recent first
- Each card shows:
  - Podcast name
  - Episode title
  - Date submitted
  - Available summary templates (as pills/badges)
- Click card → episode detail page

**Authenticated banner:**
- "Submit new episode" button (visible when authenticated)

#### Submit Form (`/submit`) - Authenticated

- Single URL input field
- Placeholder: "Paste Apple Podcasts episode URL..."
- Template selector (radio buttons or dropdown)
  - Key Takeaways & Practical Steps (default)
  - Narrative Summary
  - ELI5
- Submit button
- Validation errors inline

#### Job Status (`/job/:jobId`) - Authenticated

- Episode info (if available): podcast name, episode title
- Current status with visual indicator
- Progress steps:
  - ○ Queued
  - ○ Fetching metadata
  - ○ Checking for transcript
  - ○ Transcribing (if needed)
  - ○ Summarizing
  - ● Completed
- Estimated time remaining (e.g., "~2-3 minutes")
- Auto-refresh via polling (every 5 seconds)
- On completion: redirect to episode page
- On failure: error message + "Retry" button

#### Episode Detail (`/episode/:episodeId`)

- Header:
  - Podcast name
  - Episode title
  - Original publish date
  - Duration
  - Expiration countdown (e.g., "Expires in 342 days")
- Summary section:
  - Template name badge
  - Summary content (rendered markdown)
  - Other available templates as tabs/buttons
- Transcript section:
  - Collapsible or in tab
  - Full text
- Actions:
  - Download PDF button
  - Regenerate with different template (authenticated only)
  - Delete episode (authenticated only, with confirmation)

### Components

#### Episode Card
```
┌─────────────────────────────────────┐
│ Podcast Name                        │
│ Episode Title That Might Be Long... │
│ Dec 15, 2024 · 45 min              │
│ [Key Takeaways] [ELI5]             │
└─────────────────────────────────────┘
```

#### Status Indicator
```
Processing: ████████░░░░░░░░ 52%
Transcribing... ~2 min remaining
```

#### Error State
```
┌─────────────────────────────────────┐
│ ⚠ Processing Failed                │
│                                     │
│ Unable to fetch episode audio.      │
│ The episode may be geo-restricted   │
│ or no longer available.             │
│                                     │
│ [Retry]                             │
└─────────────────────────────────────┘
```

---

## Configuration

### Environment Variables (wrangler.toml)

```toml
name = "tldl"
main = "src/index.ts"
compatibility_date = "2024-01-01"

[vars]
MAX_EPISODE_MINUTES = 80
CACHE_TTL_DAYS = 365
DEFAULT_TEMPLATE = "key-takeaways"

[[kv_namespaces]]
binding = "TLDL_DATA"
id = "<your-kv-namespace-id>"

[[queues.producers]]
binding = "TLDL_QUEUE"
queue = "tldl-jobs"

[[queues.consumers]]
queue = "tldl-jobs"
max_batch_size = 1
max_batch_timeout = 30
max_retries = 2
```

### Secrets (via `wrangler secret put`)

**IMPORTANT: Never store secrets in wrangler.toml. All secrets must be set via CLI:**

```bash
wrangler secret put OPENAI_API_KEY
wrangler secret put PODCAST_INDEX_KEY
wrangler secret put PODCAST_INDEX_SECRET
```

Required secrets:
- `OPENAI_API_KEY` - OpenAI API key for Whisper and GPT-5.2
- `PODCAST_INDEX_KEY` - Podcast Index API key (free at podcastindex.org)
- `PODCAST_INDEX_SECRET` - Podcast Index API secret

### Cloudflare Access Configuration

1. Create Access Application:
   - Name: TLDL
   - Application domain: `tldl.<your-subdomain>.workers.dev`
   - Path: `/submit*`, `/job/*`, `/episode/*/regenerate`, `/episode/*/delete`, `/api/job/*`

2. Create Access Policy:
   - Policy name: TLDL Users
   - Action: Allow
   - Include: Emails ending in (your allowed emails)
   - Authentication: One-time PIN

3. Public paths (no Access):
   - `/`
   - `/episode/:episodeId` (GET only)
   - `/episode/:episodeId/pdf`
   - `/api/episodes`

---

## Error Handling

### Error Types and User Messages

| Error Code | Internal Cause | User-Facing Message |
|------------|----------------|---------------------|
| `INVALID_URL` | URL doesn't match Apple Podcasts pattern | "Please enter a valid Apple Podcasts episode URL. It should look like: podcasts.apple.com/...?i=..." |
| `EPISODE_NOT_FOUND` | iTunes API returned no results | "Couldn't find this episode. Please check the URL and try again." |
| `EPISODE_TOO_LONG` | Duration exceeds MAX_EPISODE_MINUTES | "This episode is too long (over {MAX} minutes). Try a shorter episode." |
| `AUDIO_UNAVAILABLE` | Can't fetch audio file (403, 404, etc.) | "Unable to access the episode audio. It may be geo-restricted or no longer available." |
| `TRANSCRIPTION_FAILED` | OpenAI Whisper API error | "Transcription failed. Please try again in a few minutes." |
| `SUMMARIZATION_FAILED` | GPT-5.2 API error | "Summary generation failed. Please try again in a few minutes." |
| `RATE_LIMITED` | OpenAI rate limit hit | "We're processing too many requests. Please try again in a few minutes." |
| `UNKNOWN_ERROR` | Unexpected error | "Something went wrong. Please try again or contact support." |

### Retry Strategy

- Queue processing: Max 2 automatic retries with exponential backoff
- User-initiated retry: Available on job status page for failed jobs
- Retry resets job to `queued` status

### Logging

Log all errors with:
- Timestamp
- Job ID (if applicable)
- Error code
- Full error message/stack
- Request context (URL, user email from Access JWT)

Use `console.error()` for Workers logging, viewable in dashboard or `wrangler tail`.

---

## Security

### OpenAI API Protection (Critical)

Routes that trigger OpenAI API calls (costing money) MUST be protected:

| Route | OpenAI API | Protection Required |
|-------|-----------|---------------------|
| `POST /submit` | Whisper + GPT | Cloudflare Access JWT |
| `POST /episode/:id/regenerate` | GPT | Cloudflare Access JWT |
| `POST /job/:id/retry` | Whisper + GPT | Cloudflare Access JWT |
| `GET /debug/transcribe` | Whisper | Remove in production or gate behind secret |
| `GET /debug/summarize` | GPT | Remove in production or gate behind secret |

**Implementation**: Auth middleware must fail-closed in production (reject requests without valid JWT).

### Authentication & Authorization

| Route Pattern | Auth Required | Access Level |
|---------------|---------------|--------------|
| `GET /` | No | Public |
| `GET /episode/:id` | No | Public |
| `GET /episode/:id/pdf` | No | Public |
| `GET /api/episodes` | No | Public |
| `GET /submit` | Yes | Authenticated |
| `POST /submit` | Yes | Authenticated |
| `GET /job/:id` | Yes | Authenticated |
| `GET /api/job/:id` | Yes | Authenticated |
| `POST /episode/:id/regenerate` | Yes | Authenticated |
| `DELETE /episode/:id` | Yes | Authenticated |
| `POST /job/:id/retry` | Yes | Authenticated |

### Input Validation

- Apple Podcasts URLs: Validate format with regex, extract and sanitize IDs
- Template IDs: Whitelist validation against known templates
- Job/Episode IDs: UUID format validation

### Data Handling

- No PII stored beyond Access JWT claims (email) in logs
- Transcripts may contain sensitive content from podcasts—stored in KV with TTL
- API keys never exposed to client

### Rate Limiting

Consider implementing per-user rate limits:
- 10 submissions per hour per authenticated user
- Tracked via KV with short TTL

---

## Testing Plan

### Unit Tests

| Component | Test Cases |
|-----------|------------|
| URL Parser | Valid Apple Podcasts URLs (various formats), Invalid URLs, Edge cases (special characters, unicode) |
| Template Validator | Valid template IDs, Invalid/missing template IDs |
| Duration Validator | Under limit, At limit, Over limit |
| KV Helpers | Key generation, TTL calculation, Data serialization |

### Integration Tests

| Flow | Test Cases |
|------|------------|
| iTunes API | Successful lookup, Podcast not found, Rate limiting |
| RSS Parser | Standard RSS, iTunes extensions, Missing fields, Large feeds |
| Transcript Detection | Apple transcript present, RSS transcript tag, No transcript available |
| OpenAI Whisper | Successful transcription, Chunked audio, API errors |
| GPT-5.2 Summarization | Successful summary, Each template, API errors |
| Queue Processing | Full flow success, Failure at each stage, Retry behavior |

### E2E Tests

| Scenario | Steps |
|----------|-------|
| Happy Path | Submit URL → Wait for processing → View summary → Download PDF |
| Cache Hit | Submit already-processed URL → Immediate result |
| Regenerate | View cached episode → Regenerate with different template → New summary |
| Delete | Delete episode → Confirm removed from list and KV |
| Error Recovery | Submit invalid URL → See error → Fix and resubmit |
| Job Retry | Force failure → Retry → Success |

### Test Episodes

Maintain a list of test episodes for development:

```typescript
const TEST_EPISODES = [
  {
    name: "Short episode with Apple transcript",
    url: "https://podcasts.apple.com/...",
    expectedDuration: 600,  // 10 min
    hasAppleTranscript: true
  },
  {
    name: "Medium episode, RSS transcript",
    url: "https://podcasts.apple.com/...",
    expectedDuration: 2400,  // 40 min
    hasRssTranscript: true
  },
  {
    name: "Long episode, no transcript",
    url: "https://podcasts.apple.com/...",
    expectedDuration: 4500,  // 75 min
    requiresWhisper: true
  },
  {
    name: "Over limit episode",
    url: "https://podcasts.apple.com/...",
    expectedDuration: 7200,  // 120 min
    shouldReject: true
  }
];
```

### Manual Testing Checklist

- [ ] Submit form validation (empty, invalid URL, valid URL)
- [ ] Job status polling and updates
- [ ] Status page auto-refresh
- [ ] Completion redirect
- [ ] Error display and retry
- [ ] Episode list sorting
- [ ] Episode detail rendering
- [ ] PDF generation and download
- [ ] Regenerate with each template
- [ ] Delete confirmation and execution
- [ ] Mobile responsiveness
- [ ] Dark mode appearance
- [ ] Cloudflare Access login flow
- [ ] Public vs authenticated route access

---

## Future Considerations

### Out of Scope for v1

- User accounts/identity beyond Access
- Filtering/search on episode list
- Custom user-defined prompts
- Timestamps in transcripts
- Speaker diarization
- Multiple audio formats beyond MP3/M4A
- Podcast subscription/monitoring
- Email notifications

### Potential Enhancements

1. **Apple Podcasts API Integration**: Use Apple Developer account for more reliable episode data than iTunes Search API.

2. **Transcript Quality Indicators**: Show source (Apple/RSS/Whisper) and confidence score.

3. **Shareable Summary Links**: Short URLs for sharing specific summaries.

4. **Export Options**: Markdown export, Notion integration, etc.

5. **Usage Analytics**: Track popular podcasts, template usage, processing times.

6. **Cost Dashboard**: Show OpenAI API usage and costs for admin.

---

## Technical Risks & Implementation Notes

This section highlights areas that require early investigation or carry implementation risk. Address these before committing to the architecture.

### 1. Audio Chunking and Workers CPU Limits

**Risk**: Cloudflare Workers have CPU time limits (10ms on free tier, 30s on paid). Audio processing operations like downloading, chunking, and format conversion for long episodes may exceed these limits.

**Mitigation Options**:

1. **Durable Objects**: Offload audio processing to a Durable Object, which has no CPU time limit (only wall-clock billing). The DO can handle download, chunking, and coordination with OpenAI Whisper.

2. **External Service**: Use a lightweight external service (e.g., AWS Lambda with ffmpeg layer, or a dedicated transcoding service) to handle audio preprocessing.

3. **Stream Processing**: Download and process audio in streaming fashion, sending chunks to Whisper as they're ready rather than buffering the entire file.

**Recommendation**: Spike on Durable Objects first—keeps everything on Cloudflare. Test with an 80-minute MP3 to validate feasibility before committing.

**Code Consideration**: The queue consumer may need to delegate to a Durable Object for the transcription step:

```typescript
// In queue consumer
if (needsWhisperTranscription) {
  const doId = env.AUDIO_PROCESSOR.idFromName(jobId);
  const stub = env.AUDIO_PROCESSOR.get(doId);
  await stub.fetch('/process', {
    method: 'POST',
    body: JSON.stringify({ audioUrl, jobId })
  });
  // DO will update job status and KV directly
  return;
}
```

### 2. GPT-5.2 Responses API Format

**Note**: The Responses API is OpenAI's newer unified API that supersedes Chat Completions for new development. Key differences from Chat Completions:

- Uses `input` instead of `messages`
- Returns `output` array with typed items instead of `choices`
- Supports server-side conversation state management
- Response text accessible via `response.output_text` helper

**Verified Request Format**:

```typescript
// Using OpenAI SDK (recommended)
import OpenAI from 'openai';

const client = new OpenAI({ apiKey: env.OPENAI_API_KEY });

const response = await client.responses.create({
  model: 'gpt-5.2',
  input: [
    {
      role: 'system',
      content: TEMPLATES[templateId].prompt
    },
    {
      role: 'user', 
      content: transcript
    }
  ],
  // Optional: control reasoning behavior
  // reasoning: { effort: 'medium' }  // none | low | medium | high | xhigh
});

const summary = response.output_text;
```

**Raw HTTP equivalent**:

```bash
curl https://api.openai.com/v1/responses \
  -H "Authorization: Bearer $OPENAI_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-5.2",
    "input": [
      {"role": "system", "content": "...prompt..."},
      {"role": "user", "content": "...transcript..."}
    ]
  }'
```

**Response Structure**:

```json
{
  "id": "resp_...",
  "object": "response",
  "created_at": 1756315696,
  "model": "gpt-5.2-2025-12-11",
  "output": [
    {
      "type": "message",
      "status": "completed",
      "content": [
        {
          "type": "output_text",
          "text": "...the generated summary..."
        }
      ],
      "role": "assistant"
    }
  ]
}
```

**Pricing**: $1.75/1M input tokens, $14/1M output tokens (90% discount on cached inputs).

### 3. RSS Parsing Edge Cases

**Risk**: RSS feeds vary wildly in quality and size. Some podcasts have 1000+ episodes, malformed XML, or non-standard namespace usage.

**Known Issues**:

- Large feeds (500+ episodes) may timeout during fetch
- Some feeds use non-standard iTunes/Podcasting 2.0 tags
- Dynamic ad insertion can produce tokenized/time-limited audio URLs
- Character encoding issues (non-UTF8 feeds)

**Mitigation**:

1. **Streaming XML Parser**: Use a streaming parser (e.g., `sax` or `@xmldom/xmldom` with chunked parsing) rather than loading entire feed into memory.

2. **Timeouts**: Set aggressive fetch timeout (10s) and fail gracefully with user-friendly error.

3. **Episode Matching Strategy**: Match episode by multiple signals in order of reliability:
   - `<guid>` containing Apple episode ID
   - `<itunes:episode>` number
   - `<enclosure url>` hash
   - Fuzzy title match (last resort)

4. **Audio URL Validation**: Before queueing transcription, HEAD request the audio URL to verify it's accessible and check Content-Length against the 80-minute cap.

**Implementation Note**:

```typescript
// Timeout wrapper for RSS fetch
const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(), 10000);

try {
  const response = await fetch(feedUrl, { signal: controller.signal });
  // ...
} catch (e) {
  if (e.name === 'AbortError') {
    throw new AppError('RSS_TIMEOUT', 'Podcast feed took too long to load');
  }
  throw e;
} finally {
  clearTimeout(timeout);
}
```

### 4. OpenAI Whisper Chunking Details

**Constraint**: OpenAI Whisper API accepts max 25MB per request.

**Audio Math** (approximate):
- 128kbps MP3: ~1MB per minute → 25MB ≈ 25 minutes
- 64kbps MP3: ~0.5MB per minute → 25MB ≈ 50 minutes
- 256kbps MP3: ~2MB per minute → 25MB ≈ 12 minutes

**Strategy**:

1. Fetch audio, check file size
2. If under 25MB, transcribe directly
3. If over 25MB:
   - Downsample to 16kHz mono (reduces size ~4x)
   - If still over, split into time-based chunks with 2-second overlap
   - Transcribe each chunk
   - Stitch transcripts, deduplicating overlap

**Tooling**: Consider using ffmpeg via WASM (`@ffmpeg/ffmpeg`) for audio manipulation, but note this adds to bundle size and may have its own CPU constraints. Test thoroughly.

---

## Appendix

### Apple Podcasts URL Patterns

```
# Episode URL (primary target)
https://podcasts.apple.com/{country}/podcast/{podcast-slug}/id{podcast_id}?i={episode_id}

# Examples:
https://podcasts.apple.com/us/podcast/lenny-s-podcast-product-growth-career/id1627920305?i=1000680000000
https://podcasts.apple.com/gb/podcast/the-daily/id1200361736?i=1000640000000

# Show URL (not supported in v1)
https://podcasts.apple.com/us/podcast/id{podcast_id}
```

### OpenAI API Reference

**Whisper (Transcription)**
```
POST https://api.openai.com/v1/audio/transcriptions
Content-Type: multipart/form-data

file: <audio file, max 25MB>
model: whisper-1
response_format: text
```

**GPT-5.2 (Responses API)**

See [Technical Risks & Implementation Notes > GPT-5.2 Responses API Format](#2-gpt-52-responses-api-format) for complete request/response examples.

### RSS Transcript Standards

Check for transcripts in this order:

1. `<podcast:transcript>` tag (Podcasting 2.0)
```xml
<podcast:transcript 
  url="https://example.com/transcript.srt" 
  type="application/srt" />
```

2. `<content:encoded>` with transcript content

3. Link in `<description>` to external transcript

---

*Specification Version: 1.0*
*Last Updated: December 2024*
*Author: Rian + Claude*
