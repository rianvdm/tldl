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
- **Podcast Index API**: Primary metadata source (replaces iTunes API due to 403 issues in Workers)
- **Episode matching**: Multi-strategy in `src/services/rss.ts` (GUID, title similarity, date proximity)
- **Audio chunking**: `src/lib/audio.ts` handles MP3 frame-aware splitting for large files
- **Job status**: Durable Object (`src/durable-objects/job-status.ts`) for strong consistency

### KV Storage Schema

Keys in `src/lib/kv.ts`:
- `job:{jobId}` - Job state (TTL: 7 days)
- `episode:{episodeId}` - Episode metadata (TTL: 365 days)
- `transcript:{episodeId}` - Full transcript (TTL: 365 days)
- `summary:{episodeId}:{templateId}` - Generated summary (TTL: 365 days)
- `ratelimit:{email}:{hour}` - Rate limiting (TTL: 1 hour)

### Routes

**Public** (`src/routes/public.ts`):
- `GET /` - Episode list
- `GET /episode/:id` - Episode detail with summary
- `GET /episode/:id/pdf` - PDF download
- `GET /submit` - Submit form
- `GET /job/:id` - Job status page

**API** (`src/routes/api.ts`):
- `GET /api/episodes` - JSON episode list
- `GET /api/episode/:id` - JSON episode detail
- `GET /api/templates` - Available summary templates

**Authenticated** (`src/routes/authenticated.ts`):
- `POST /submit` - Create new job
- `POST /episode/:id/regenerate` - Regenerate with different template
- `DELETE /episode/:id` - Delete episode
- `POST /job/:id/retry` - Retry failed job

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
- `JOB_STATUS` - Durable Object

**Secrets** (set via `wrangler secret put`):
- `OPENAI_API_KEY` - OpenAI API key
- `PODCAST_INDEX_KEY` - Podcast Index API key
- `PODCAST_INDEX_SECRET` - Podcast Index API secret

**Environment Variables**:
- `MAX_EPISODE_MINUTES` - Max duration (default: 80)
- `ENVIRONMENT` - `production` or `development`

## Testing

Uses `@cloudflare/vitest-pool-workers` for Workers-like environment. 214+ tests covering:
- Unit tests for all services
- Integration tests in `test/integration/`
- Note: Tests involving Durable Objects may show "Isolated storage" warnings (infrastructure issue, not failures)

## Common Issues

- **iTunes 403 errors**: Use Podcast Index API instead (already configured)
- **Large audio files**: Automatically chunked at MP3 frame boundaries
- **Job status inconsistency**: Durable Object provides strong consistency, KV is fallback
