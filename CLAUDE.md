# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build and Development Commands

```bash
npm install          # Install dependencies
npm run dev          # Start local Wrangler dev server (http://localhost:8787)
npm test             # Run all tests (Vitest with Cloudflare Workers pool)
npm run deploy       # Deploy to Cloudflare Workers
npx wrangler types   # Generate TypeScript types from wrangler.toml
npx wrangler tail    # Stream live logs from production
```

To run a single test file:
```bash
npm test -- test/kv.test.ts
```

## Architecture Overview

TLDL is a Cloudflare Workers application that generates AI summaries from Apple Podcasts URLs. Built with Hono framework, Cloudflare Queues for background processing, and Durable Objects for job status consistency.

### Request Flow

1. **Submit** (`POST /submit`): Validates Apple Podcasts URL → checks KV cache → creates job in Durable Object + KV → enqueues to Cloudflare Queue → redirects to job status page
2. **Queue Consumer** (`src/queue/consumer.ts`): Processes jobs in background:
   - Fetches episode metadata via Podcast Index API + RSS feed parsing
   - Checks for existing transcript (RSS `<podcast:transcript>` tag)
   - Falls back to OpenAI Whisper for transcription (with chunking for >25MB files)
   - Generates summary via OpenAI GPT-4o
   - Stores results in KV with 365-day TTL
3. **View** (`GET /episode/:id`): Serves cached episodes with summary and transcript

### Key Components

- **Episode ID derivation**: `deriveEpisodeId(podcastId, episodeId)` in `src/lib/url-parser.ts`
- **Podcast Index API**: Primary metadata source (`src/services/podcast-index.ts`) — replaces iTunes API due to 403 errors in Workers
- **Apple Podcasts page scraping**: `getEpisodeTitleFromApplePage()` in `src/services/apple-podcasts.ts` extracts episode titles from HTML `<title>` tags when URL slugs are unreliable
- **Episode matching**: Multi-strategy in `src/services/rss.ts` (GUID, title similarity, date proximity)
- **Audio chunking**: `src/lib/audio.ts` handles MP3 frame-aware splitting for large files (>25MB)
- **Job status**: Durable Object (`src/durable-objects/job-status.ts`) for strong consistency; KV as fallback
  - Home page uses `listActiveJobsWithDO()` to fetch active jobs from DO for real-time updates
  - Job status page uses `getJobWithFallback()` for immediate status visibility
  - Both auto-refresh when jobs are active (home: 10s, job page: 5s)
- **Styling**: All CSS is in `src/lib/styles.ts` (not a `.css` file) — Cloudflare Workers can't read from the filesystem, so styles are embedded in TypeScript

### KV Storage Schema

Keys in `src/lib/kv.ts`:
- `job:{jobId}` - Job state (TTL: 7 days)
- `episode:{episodeId}` - Episode metadata (TTL: 365 days)
- `transcript:{episodeId}` - Full transcript (TTL: 365 days)
- `summary:{episodeId}:{templateId}` - Generated summary (TTL: 365 days)
- `ratelimit:{email}:{hour}` - Rate limiting (TTL: 1 hour)

### Routes

**Public** (`src/routes/public.ts`):
- `GET /` - Episode list with pagination
- `GET /episode/:id` - Episode detail with summary
- `GET /episode/:id/pdf` - PDF download
- `GET /submit` - Submit form
- `GET /job/:id` - Job status page

**API** (`src/routes/api.ts`):
- `GET /api/episodes` - JSON episode list
- `GET /api/episode/:id` - JSON episode detail
- `GET /api/templates` - Available summary templates

**Authenticated** (`src/routes/authenticated.ts`):
- `GET /profile` - User profile page (shows submitted episodes; public but intended for authenticated users)
- `POST /submit` - Create new job
- `POST /episode/:id/regenerate` - Regenerate with different template
- `DELETE /episode/:id` - Delete episode
- `POST /job/:id/retry` - Retry failed job
- `POST /profile/delete/:episodeId` - Delete episode from profile page
- `POST /profile/rebuild-index` - Admin only: Rebuild episode index

### Summary Templates

Defined in `src/lib/constants.ts`:
- `key-takeaways` - Professional/craft podcasts (default)
- `narrative-summary` - Story-driven content
- `eli5` - Technical topics explained simply

### Maintenance Mode

Toggle `MAINTENANCE_MODE` in `src/index.ts` to disable HTTP endpoints (queue continues processing).

## Environment & Secrets

**Bindings** (in `wrangler.toml`):
- `TLDL_DATA` - KV namespace
- `TLDL_QUEUE` - Queue (name: `tldl-jobs`)
- `JOB_STATUS` - Durable Object for job status consistency

**Secrets** (set via `wrangler secret put`):
- `OPENAI_API_KEY` - OpenAI API key
- `PODCAST_INDEX_KEY` - Podcast Index API key
- `PODCAST_INDEX_SECRET` - Podcast Index API secret

**Environment Variables**:
- `MAX_EPISODE_MINUTES` - Max duration (default: 80)
- `ENVIRONMENT` - `production` or `development`
- `CACHE_TTL_DAYS` - Content cache TTL (default: 365)
- `DEFAULT_TEMPLATE` - Default summary template (default: `key-takeaways`)

## Testing

Uses `@cloudflare/vitest-pool-workers` for Workers-like environment. 214+ tests covering:
- Unit tests for all services
- Integration tests in `test/integration/`
- Note: Tests involving Durable Objects may show "Isolated storage" warnings (infrastructure issue, not failures)

## Project Structure

```
src/
├── index.ts              # Hono app, routes, exports
├── types/                # TypeScript type definitions
├── lib/                  # Core utilities
│   ├── constants.ts      # Templates, error codes, TTLs
│   ├── kv.ts             # KV storage helpers
│   ├── url-parser.ts     # Apple Podcasts URL parsing
│   ├── audio.ts          # MP3 frame-aware chunking
│   ├── errors.ts         # Error handling
│   ├── retry.ts          # Retry logic with backoff
│   ├── job-status-do.ts  # Durable Object client helpers
│   └── ...
├── services/             # External API integrations
│   ├── apple-podcasts.ts # iTunes API + page scraping
│   ├── podcast-index.ts  # Podcast Index API
│   ├── rss.ts            # RSS feed parsing + episode matching
│   ├── transcription.ts  # OpenAI Whisper
│   ├── summarization.ts  # OpenAI GPT-4o
│   └── pdf.ts            # PDF generation
├── routes/               # Hono route handlers
│   ├── public.ts         # Public pages
│   ├── api.ts            # JSON API
│   └── authenticated.ts  # Protected mutations
├── queue/                # Queue consumer
│   └── consumer.ts       # Job processing pipeline
└── durable-objects/      # Durable Object classes
    └── job-status.ts     # Job status DO for consistency
```

## Common Issues

- **iTunes 403 errors**: Use Podcast Index API instead (already configured)
- **Episode title extraction**: URL slugs sometimes contain podcast name instead of episode title; `getEpisodeTitleFromApplePage()` scrapes the actual page to get reliable titles
- **Large audio files**: Automatically chunked at MP3 frame boundaries (>25MB)
- **Job status inconsistency**: Durable Object provides strong consistency, KV is fallback for reads
