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

## Helpful Commands

Inspect raw data stored in KV (useful for debugging expiry dates, episode data, etc.):
```bash
npx wrangler kv key get --namespace-id=ee123158d5d54359b4257f8a1b678adf "episode:<episodeId>"
npx wrangler kv key get --namespace-id=ee123158d5d54359b4257f8a1b678adf "summary:<episodeId>:<templateId>"
npx wrangler kv key get --namespace-id=ee123158d5d54359b4257f8a1b678adf "transcript:<episodeId>"
```

## Architecture Overview

TLDL is a Cloudflare Workers application that generates AI summaries from Apple Podcasts URLs. Built with Hono framework, Cloudflare Queues for background processing, and Durable Objects for job status consistency.

### Request Flow

1. **Submit** (`POST /submit`): Validates Apple Podcasts URL → checks KV cache → creates job in Durable Object + KV → enqueues to Cloudflare Queue → redirects to job status page
2. **Queue Consumer** (`src/queue/consumer.ts`): Processes jobs in background:
   - Fetches episode metadata via Podcast Index API + RSS feed parsing
   - Checks for existing transcript (RSS `<podcast:transcript>` tag)
   - Falls back to OpenAI Whisper for transcription (with chunking for >25MB files)
   - Generates summary via OpenAI GPT-5.2
   - Generates 1-4 AI tags using GPT-5.2 (non-critical: continues if fails)
   - Stores results in KV with 365-day TTL
3. **View** (`GET /episode/:id`): Serves cached episodes with summary, transcript, and tags

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
- **Episode Tags**: AI-generated using GPT-5.2 Responses API during queue processing (1-4 tags per episode)
  - Tags stored inline in both Episode and EpisodeIndexEntry for efficient filtering
  - Predefined tag list in `src/lib/constants.ts` (EPISODE_TAGS)
  - Tag generation is non-critical: empty tags don't fail jobs
  - Home page supports single-tag filtering with `/?tag=tagname`

### Authentication & Auth-Conditional UI

Authentication is handled by **Cloudflare Access** at the edge. Protected routes (under `/profile/*`, `/submit*`) require login before requests reach the Worker.

**Auth-Conditional UI** shows different UI elements for logged-in vs logged-out users on public pages:
- Nav shows "Log in" (logged out) or "Profile" (logged in)
- Submit button is disabled with tooltip (logged out) or enabled (logged in)

**How it works** (see `docs/auth-conditional-ui-plan.md` for details):
1. Script in `<head>` starts fetch to `/profile/auth-check` (protected endpoint)
2. Also checks `localStorage` cache (`tldl-auth`) for instant UI on returning visits
3. Script before `</body>` updates DOM based on cache hit and fetch result
4. If session expired (cache wrong), page reloads to show correct state

**Key files**:
- `src/routes/authenticated.ts` - `/profile/auth-check` endpoint returns `{ authenticated: true, email }`
- `src/routes/public.ts` - Layout component with auth scripts, nav link (`#nav-auth-link`), Submit buttons (`.auth-logged-out` / `.auth-logged-in`)
- `src/lib/styles.ts` - `.hidden`, `.auth-disabled` CSS classes

**Why client-side**: Cloudflare Access only sends the `Cf-Access-Jwt-Assertion` header on protected paths. On public pages, we can't detect auth state server-side, so we probe a protected endpoint via JavaScript.

### KV Storage Schema

Keys in `src/lib/kv.ts`:
- `job:{jobId}` - Job state (TTL: 7 days)
- `episode:{episodeId}` - Episode metadata with optional tags (TTL: 365 days)
- `transcript:{episodeId}` - Full transcript (TTL: 365 days)
- `summary:{episodeId}:{templateId}` - Generated summary (TTL: 365 days)
- `ratelimit:{email}:{hour}` - Rate limiting (TTL: 1 hour)
- `episodes:index` - Lightweight episode list with tags for home page (TTL: 365 days)

### Routes

**Public** (`src/routes/public.ts`):
- `GET /` - Episode list with pagination and tag filtering (`?tag=tagname`)
- `GET /episode/:id` - Episode detail with summary, transcript, and tags
- `GET /episode/:id/pdf` - PDF download
- `GET /submit` - Submit form
- `GET /job/:id` - Job status page

**API** (`src/routes/api.ts`):
- `GET /api/episodes` - JSON episode list
- `GET /api/episode/:id` - JSON episode detail
- `GET /api/templates` - Available summary templates

**Authenticated** (`src/routes/authenticated.ts`):
- `GET /profile/auth-check` - Auth probe for client-side detection (returns `{ authenticated, email }`)
- `GET /profile` - User profile page (shows submitted episodes; public but intended for authenticated users)
- `POST /submit` - Create new job
- `POST /episode/:id/regenerate` - Regenerate with different template
- `DELETE /episode/:id` - Delete episode
- `POST /job/:id/retry` - Retry failed job
- `POST /profile/delete/:episodeId` - Delete episode from profile page
- `POST /profile/rebuild-index` - Admin only: Rebuild episode index
- `POST /profile/update-tags/:episodeId` - Admin only: Update episode tags
- `POST /profile/backfill-tags` - Admin only: Generate tags for episodes without them
- `POST /profile/cleanup-invalid-tags` - Admin only: Remove tags no longer in EPISODE_TAGS

**Important**: Admin endpoints must be under `/profile/*` path to be protected by Cloudflare Access. Do not create admin endpoints under `/admin/*` or other paths - they won't be properly authenticated in production.

### Summary Templates

Defined in `src/lib/constants.ts`:
- `key-takeaways` - Professional/craft podcasts (default)
- `narrative-summary` - Story-driven content
- `eli5` - Technical topics explained simply

### Episode Tags

Defined in `src/lib/constants.ts` (EPISODE_TAGS array):
- 12 predefined tags: business, creativity, education, faith, health, music, politics, product, psychology, science, sport, technology
- Tags are alphabetically sorted for consistency
- Easy to add/remove tags - just edit the EPISODE_TAGS array
- After removing tags, use "Cleanup Invalid Tags" admin tool to remove them from existing episodes
- Tags generated automatically during episode processing (1-4 tags per episode)
- Admin can manually edit tags via profile page

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
│   ├── tag-generation.ts # OpenAI GPT-5.2 for episode tags
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
- **Invalid tags showing**: After removing tags from EPISODE_TAGS, run "Cleanup Invalid Tags" from admin tools to remove them from existing episodes
- **Admin endpoints 401/403**: Admin endpoints must be under `/profile/*` path to work with Cloudflare Access configuration

## Important Notes

- **GPT-5.2 exists**: The project uses OpenAI GPT-5.2 for both summarization and tag generation. This is a real model - do not change references to GPT-4o or other models unless explicitly instructed.
