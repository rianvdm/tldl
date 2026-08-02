# TLDL — Too Long Didn't Listen

A curated archive of AI-powered podcast summaries. New podcasts and episodes are added by the admin. Visitors browse, read, subscribe via RSS, or request a podcast to be added.

**Live at [tldl-pod.com](https://tldl-pod.com)**

## Tech Stack

| Layer | Technology |
|-------|------------|
| Runtime | [Cloudflare Workers](https://workers.cloudflare.com) |
| Framework | [Hono](https://hono.dev) |
| Background Jobs | Cloudflare Queues |
| Storage | Cloudflare KV + Durable Objects |
| Podcast Data | [Podcast Index API](https://podcastindex.org) |
| Transcription | OpenAI gpt-transcribe (whisper-1 fallback) |
| Summarization | OpenAI GPT-5.4 |
| Authentication | Cloudflare Access (admin-only) |
| Spam Protection | Cloudflare Turnstile |
| Notifications | Discord webhooks |
| Contact Form | Postmark transactional email |

## Quick Start

### Prerequisites

- Node.js 18+
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/)
- Cloudflare account with Workers, KV, Queues, and Durable Objects enabled
- API keys: OpenAI, Podcast Index (free at [podcastindex.org](https://podcastindex.org))

### Local Development

```bash
# Install dependencies
npm install

# Create .dev.vars with your secrets
cat > .dev.vars << 'EOF'
OPENAI_API_KEY=sk-...
PODCAST_INDEX_KEY=...
PODCAST_INDEX_SECRET=...
TURNSTILE_SECRET=...
EOF

# Start dev server
npm run dev
# → http://localhost:8787
```

### Seed Test Data

Populate local dev with sample episodes, podcasts, and tags:

```bash
npx tsx scripts/seed-local-data.ts
```

Reset everything and start fresh:

```bash
rm -rf .wrangler/state && npx tsx scripts/seed-local-data.ts
```

## Commands

| Command | Description |
|---------|-------------|
| `npm run dev` | Start local dev server |
| `npm test` | Run all tests |
| `npm test -- test/kv.test.ts` | Run single test file |
| `npm run deploy` | Deploy to production |
| `npx wrangler tail` | Stream live production logs |

## Project Structure

```
src/
├── index.ts                 # Hono app entry, cron handler, debug routes
├── types/index.ts           # All TypeScript interfaces
├── lib/
│   ├── constants.ts         # Tags, templates, error codes, timeouts
│   ├── kv.ts                # KV CRUD + activity log helpers
│   ├── url-parser.ts        # Apple Podcasts URL parsing
│   ├── audio.ts             # MP3 frame-aware chunking for large files
│   ├── styles.ts            # All CSS (embedded, Workers can't read files)
│   ├── job-status-do.ts     # Durable Object helpers + timeout detection
│   ├── monitor.ts           # Podcast monitoring logic
│   ├── discord.ts           # Discord webhook notifications
│   ├── turnstile.ts         # Spam protection verification
│   └── auth.ts              # JWT parsing, admin checks
├── services/
│   ├── apple-podcasts.ts    # Episode metadata lookup
│   ├── podcast-index.ts     # Podcast Index API client
│   ├── rss.ts               # RSS parsing + episode matching
│   ├── transcription.ts     # OpenAI gpt-transcribe (whisper-1 fallback)
│   ├── summarization.ts     # GPT-5.4 summary generation
│   ├── tag-generation.ts    # GPT-5.4 tag generation
│   └── postmark.ts          # Postmark email for request form
├── routes/
│   ├── public.ts            # Public pages + request form
│   ├── api.ts               # JSON API (read-only)
│   └── admin.ts             # Admin dashboard + mutations
├── queue/
│   └── consumer.ts          # Background job processor
└── durable-objects/
    └── job-status.ts        # Job status DO for consistency
```

## Architecture

### Episode Processing Flow

1. **Admin submits** (`POST /admin/submit`): Validates Apple Podcasts URL → checks cache → creates job → enqueues to Queue → redirects to dashboard
2. **Queue Consumer** (`src/queue/consumer.ts`): Background processing
   - Fetch episode metadata via Podcast Index + RSS
   - Check for existing transcript in RSS feed
   - Transcribe with OpenAI gpt-transcribe (chunking for >25MB)
   - Generate summary with GPT-5.4
   - Generate 2-3 tags with GPT-5.4 (non-critical)
   - Store in KV with 365-day TTL
   - Log to activity feed, notify Discord on failure
3. **View** (`GET /episode/:id`): Serve cached episode with summary
4. **Monitoring** (cron every 8h): Check monitored podcasts for new episodes, queue automatically

### Key Design Decisions

- **Admin-only model**: No public submission. One admin curates the archive. Visitors can request podcasts via a contact form.
- **Durable Objects for job status**: KV is eventually consistent; DOs provide strong consistency for real-time job tracking.
- **Timeout detection**: Jobs stuck >20 minutes are auto-marked as failed on home page render and in the cron handler.
- **Podcast Index over iTunes API**: iTunes returns 403s from Workers. Podcast Index is free and reliable.
- **Embedded CSS**: Workers can't read from filesystem. All styles live in `src/lib/styles.ts`.
- **Non-critical tag generation**: If tag generation fails, the job continues. Empty tags are acceptable.

### KV Storage Schema

| Key Pattern | TTL | Description |
|-------------|-----|-------------|
| `job:{jobId}` | 1 day | Job state and progress |
| `episode:{episodeId}` | 365 days | Episode metadata |
| `transcript:{episodeId}` | 365 days | Full transcript |
| `summary:{episodeId}:{templateId}` | 365 days | Generated summary |
| `episodes:index` | 365 days | Lightweight list for home page |
| `activity:log` | 30 days | Admin activity feed (last 50 events) |
| `monitor:settings` | none | Podcast monitoring settings |
| `monitored:list` | none | Monitored podcast IDs |
| `monitored:{podcastId}` | none | Monitored podcast config |
| `monitored:processed:{podcastId}` | none | Processed episode GUIDs |

## Routes

### Public

| Route | Description |
|-------|-------------|
| `GET /` | Episode list with search and tag filtering |
| `GET /episode/:id` | Episode detail with summary |
| `GET /podcasts` | Browse all podcasts |
| `GET /podcasts/:id` | Individual podcast page |
| `GET /about` | About page |
| `GET /feed` | RSS feed (with optional `?tag=` filter) |
| `GET /request` | Request a podcast form |

### Admin (Cloudflare Access protected)

| Route | Description |
|-------|-------------|
| `GET /admin` | Dashboard (stats, activity, episodes, tools) |
| `GET /admin/submit` | Submit episode form |
| `GET /admin/podcasts` | Podcast monitoring management |
| Full route list | See `AGENTS.md` |

### API

| Route | Description |
|-------|-------------|
| `GET /api/episodes` | JSON episode list |
| `GET /api/episode/:id` | JSON episode detail |
| `GET /api/templates` | Available summary templates |

## Configuration

### Secrets (via `wrangler secret put`)

| Secret | Required | Description |
|--------|----------|-------------|
| `OPENAI_API_KEY` | Yes | OpenAI API key |
| `PODCAST_INDEX_KEY` | Yes | Podcast Index API key |
| `PODCAST_INDEX_SECRET` | Yes | Podcast Index API secret |
| `TURNSTILE_SECRET` | Yes | Cloudflare Turnstile secret |
| `DISCORD_WEBHOOK_URL` | No | Discord webhook for failure alerts |
| `POSTMARK_API_KEY` | No | Postmark token for request form email |

### Environment Variables (in `wrangler.toml`)

| Variable | Default | Description |
|----------|---------|-------------|
| `MAX_EPISODE_MINUTES` | 121 | Maximum episode duration |
| `CACHE_TTL_DAYS` | 365 | Content cache TTL |
| `DEFAULT_TEMPLATE` | key-takeaways | Default summary template |
| `TURNSTILE_SITE_KEY` | — | Turnstile widget site key |
| `POSTMARK_FROM_EMAIL` | — | Sender for request form emails |
| `ADMIN_NOTIFICATION_EMAIL` | — | Recipient for request form emails |
| `POSTMARK_MESSAGE_STREAM` | — | Postmark message stream name |

## Testing

Uses `@cloudflare/vitest-pool-workers` for a Workers-like test environment. 305+ tests.

```bash
npm test                      # Run all tests
npm test -- test/kv.test.ts   # Run single file
```

**Note**: Durable Object tests may show "Isolated storage" warnings. This is a vitest-pool-workers infrastructure issue, not a test failure.

## Deployment

```bash
# Set secrets (first time only)
wrangler secret put OPENAI_API_KEY
wrangler secret put PODCAST_INDEX_KEY
wrangler secret put PODCAST_INDEX_SECRET
wrangler secret put TURNSTILE_SECRET
wrangler secret put DISCORD_WEBHOOK_URL     # optional
wrangler secret put POSTMARK_API_KEY        # optional

# Deploy
npm run deploy
```

### Cloudflare Access Setup

Create an Access application with two paths:
- `tldl-pod.com/admin` (exact)
- `tldl-pod.com/admin/*` (wildcard)

Policy: Allow only admin email addresses.

## Admin Tools

Available at `/admin` (protected by Cloudflare Access):

| Tool | Description |
|------|-------------|
| Submit Episode | Process a single Apple Podcasts URL |
| Manage Podcasts | Add/remove monitored podcasts, adjust settings |
| Check All Now | Force-check all podcasts for new episodes |
| Rebuild Index | Rebuild episode index from all KV data |
| Backfill Tags | Generate tags for episodes without them |
| Cleanup Tags | Remove tags no longer in the predefined list |
| Cleanup Jobs | Remove stale failed jobs |
| Backfill Podcast Info | Fetch podcast metadata from Podcast Index |

## Summary Templates

| Template | Best For |
|----------|----------|
| `key-takeaways` | Professional/craft podcasts — bullet points, actionable insights |
| `narrative-summary` | Story-driven content — flowing prose |
| `eli5` | Technical topics — simple language, analogies |

## More Documentation

- `AGENTS.md` — Detailed architecture docs for AI coding agents
- `docs/admin-pivot-plan.md` — Design plan for the v2.0 admin-first pivot
- `docs/` — Additional design documents and archived plans
