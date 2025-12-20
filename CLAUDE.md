# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build and Development Commands

```bash
npm install          # Install dependencies
npm run dev          # Start local Wrangler dev server
npm test             # Run all tests (Vitest)
npm run test:watch   # Run tests in watch mode
npm run typecheck    # TypeScript type checking
npx wrangler deploy  # Deploy to Cloudflare Workers
npx wrangler types   # Generate TypeScript types from wrangler.toml
```

To run a single test file:
```bash
npx vitest run test/kv.test.ts
```

## Architecture Overview

TLDL is a Cloudflare Workers application that generates AI summaries from Apple Podcasts URLs. It uses Hono as the web framework and Cloudflare Queues for background job processing.

### Request Flow

1. **Submit** (`POST /submit`): User submits Apple Podcasts URL → validates URL → checks KV cache → pre-fetches iTunes metadata → creates job in KV → enqueues to Cloudflare Queue
2. **Queue Consumer** (`src/queue/consumer.ts`): Processes jobs in background:
   - Fetches episode metadata via iTunes API + RSS feed parsing
   - Checks for existing transcript (RSS `<podcast:transcript>` tag or cached)
   - Falls back to OpenAI Whisper for transcription
   - Generates summary via OpenAI GPT
   - Stores all results in KV
3. **Read** (`GET /api/episode/:id`): Serves cached episodes, transcripts, and summaries from KV

### Key Data Flow

- **Episode ID derivation**: `deriveEpisodeId(podcastId, episodeId)` in `src/lib/url-parser.ts` creates deterministic storage keys
- **iTunes metadata pre-fetch**: HTTP routes fetch `episodeGuid` from iTunes API before queueing (queue context gets 403s from iTunes)
- **Episode matching**: `findEpisodeInFeed()` in `src/services/rss.ts` uses multi-strategy matching (GUID, title similarity, date proximity)

### KV Storage Schema

Keys follow patterns in `src/lib/kv.ts`:
- `job:{jobId}` - Processing job state (TTL: 7 days)
- `episode:{episodeId}` - Episode metadata (TTL: 365 days)
- `transcript:{episodeId}` - Full transcript text (TTL: 365 days)
- `summary:{episodeId}:{templateId}` - Generated summary (TTL: 365 days)

### Routes Structure

- `src/routes/api.ts` - Public read-only endpoints (`/api/episodes`, `/api/episode/:id`, `/api/templates`)
- `src/routes/authenticated.ts` - Protected mutation endpoints (`/submit`, `/job/:id`, `/episode/:id/regenerate`, `/episode/:id` DELETE)
- Authentication via Cloudflare Access (checks `Cf-Access-Jwt-Assertion` header)

### Summary Templates

Three templates defined in `src/lib/constants.ts`:
- `key-takeaways` - For professional/craft podcasts (default)
- `narrative-summary` - For story-driven content
- `eli5` - For technical topics explained simply

### Maintenance Mode

Toggle `MAINTENANCE_MODE` constant in `src/index.ts` to disable HTTP endpoints while queue consumer continues processing.

## Environment

- **Runtime**: Cloudflare Workers with `nodejs_compat` flag
- **KV Binding**: `TLDL_DATA`
- **Queue Binding**: `TLDL_QUEUE` (queue name: `tldl-jobs`)
- **Secret**: `OPENAI_API_KEY` (set via `wrangler secret put`)

## Testing

Tests use `@cloudflare/vitest-pool-workers` to run in Workers-like environment. Test files mirror source structure in `test/` directory.
