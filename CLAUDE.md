# AGENTS.md

This file provides guidance to AI coding agents when working with code in this repository.

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

Seed local dev environment with rich test data (12 episodes, 6 podcasts, tags, authors):
```bash
npx tsx scripts/seed-local-data.ts
```

Clear all local state (KV + Durable Objects) and start fresh:
```bash
rm -rf .wrangler/state && npx tsx scripts/seed-local-data.ts
```

## Architecture Overview

TLDL is a Cloudflare Workers application that generates AI summaries of podcast episodes. It's an **admin-curated archive** — only admins can submit episodes and manage podcasts. Visitors browse, read, subscribe via RSS, or request a podcast to be added.

Built with Hono framework, Cloudflare Queues for background processing, and Durable Objects for job status consistency.

### Request Flow

1. **Admin submits** (`POST /admin/submit`): Validates Apple Podcasts URL → checks KV cache → creates job in Durable Object + KV → enqueues to Cloudflare Queue → redirects to admin dashboard
2. **Queue Consumer** (`src/queue/consumer.ts`): Processes jobs in background:
   - Fetches episode metadata via Podcast Index API + RSS feed parsing
   - Checks for existing transcript (RSS `<podcast:transcript>` tag)
   - Falls back to OpenAI gpt-4o-mini-transcribe for transcription (with chunking for >25MB files)
   - Generates summary via OpenAI GPT-5.4
   - Generates 2-3 AI tags using GPT-5.4 (non-critical: continues if fails)
   - Stores results in KV with 365-day TTL
   - Logs completion/failure to activity log
   - Sends Discord notification on failure
3. **View** (`GET /episode/:id`): Serves cached episodes with summary, transcript, and tags
4. **Monitoring** (cron every 8h): Checks monitored podcasts for new episodes, queues them automatically

### Key Components

- **Episode ID derivation**: `deriveEpisodeId(podcastId, episodeId)` in `src/lib/url-parser.ts`
- **Podcast Index API**: Primary metadata source (`src/services/podcast-index.ts`) — replaces iTunes API due to 403 errors in Workers
- **Apple Podcasts page scraping**: `getEpisodeTitleFromApplePage()` in `src/services/apple-podcasts.ts` extracts episode titles from HTML `<title>` tags when URL slugs are unreliable
- **Episode matching**: Multi-strategy in `src/services/rss.ts` (GUID, title similarity, date proximity)
- **Audio chunking**: `src/lib/audio.ts` handles MP3 frame-aware splitting for large files (>25MB, up to 300MB)
- **Job status**: Durable Object (`src/durable-objects/job-status.ts`) for strong consistency; KV as fallback
  - Home page uses `listActiveJobsWithDO()` to fetch active jobs from DO for real-time updates
  - `listActiveJobsWithDO()` also detects timed-out jobs (>20 min) and marks them as failed + notifies Discord
  - Home page auto-refreshes every 10s when jobs are active
- **Activity log**: `activity:log` KV key stores last 50 events (completions, failures, monitoring checks). Written by queue consumer and scheduled handler. Displayed on admin dashboard.
- **Discord notifications**: `src/lib/discord.ts` sends webhook notifications on job failures and monitoring errors. No-op when `DISCORD_WEBHOOK_URL` is not set.
- **Postmark email**: `src/services/postmark.ts` sends email for the "Request a Podcast" form. No-op when `POSTMARK_API_KEY` is not set.
- **Styling**: All CSS is in `src/lib/styles.ts` (not a `.css` file) — Cloudflare Workers can't read from the filesystem, so styles are embedded in TypeScript
- **Episode Tags**: AI-generated using GPT-5.4 Responses API during queue processing (2-3 tags per episode)
  - Tags stored inline in both Episode and EpisodeIndexEntry for efficient filtering
  - Predefined tag list in `src/lib/constants.ts` (EPISODE_TAGS)
  - Tag generation is non-critical: empty tags don't fail jobs
  - Home page supports single-tag filtering with `/?tag=tagname`
- **Podcast Pages**: Browse and individual podcast pages (`/podcasts`, `/podcasts/:id`)
  - `extractPodcastId()` in `src/lib/url-parser.ts` extracts podcast ID from episode ID format `{podcastId}_{episodeId}`
  - `getPodcastList()` in `src/lib/kv.ts` aggregates podcasts from episode index, sorted by most recently updated
  - `getEpisodesForPodcast()` in `src/lib/kv.ts` returns paginated episodes for a specific podcast
  - No separate podcast index needed — computed on-demand from existing episode index

### Authentication & Access Control

Authentication is handled by **Cloudflare Access** at the edge. Two Access application paths protect admin routes:
- `/admin` (exact path)
- `/admin/*` (all sub-paths)

Only admin emails (defined in the Access policy) can authenticate. There are no "regular users" — only admins and anonymous visitors.

**Admin auth in code** (`src/routes/admin.ts`):
- `requireAdmin()` validates the `Cf-Access-Jwt-Assertion` header
- Fail-closed: no JWT → 401, JWT but no email → 401, non-admin email → 403
- In development mode (`ENVIRONMENT=development`), mocks admin user as `rianvdm@gmail.com`
- Admin check uses `isAdminUser()` from `src/lib/auth.ts`

**No auth on public pages**: Public pages have no login button, no auth detection scripts, no client-side auth state. The nav shows only: TL;DL | Podcasts | About.

### Spam Protection (Turnstile)

The "Request a Podcast" form (`/request`) uses **Cloudflare Turnstile** for spam protection:
- Widget embedded in the form (`src/routes/public.ts`)
- Server-side verification in `src/lib/turnstile.ts`
- Requires `TURNSTILE_SITE_KEY` (env var) and `TURNSTILE_SECRET` (secret)

### KV Storage Schema

Keys in `src/lib/kv.ts`:
- `job:{jobId}` — Job state (TTL: 1 day)
- `episode:{episodeId}` — Episode metadata with optional tags (TTL: 365 days)
- `transcript:{episodeId}` — Full transcript (TTL: 365 days)
- `summary:{episodeId}:{templateId}` — Generated summary (TTL: 365 days)
- `episodes:index` — Lightweight episode list with tags for home page (TTL: 365 days)
- `activity:log` — Admin dashboard activity log, last 50 events (TTL: 30 days)
- `monitor:settings` — Global podcast monitoring settings (no TTL)
- `monitored:list` — Array of monitored podcast IDs (no TTL)
- `monitored:{podcastId}` — Individual monitored podcast config (no TTL)
- `monitored:processed:{podcastId}` — Array of processed episode GUIDs (no TTL)

### Routes

**Public** (`src/routes/public.ts`):
- `GET /` — Episode list with pagination and tag filtering (`?tag=tagname`)
- `GET /episode/:id` — Episode detail with summary and tags
- `GET /podcasts` — Browse all podcasts with pagination (10 per page)
- `GET /podcasts/:id` — Individual podcast page with all episodes
- `GET /about` — About page
- `GET /feed` — RSS feed of recent episodes (with optional `?tag=` filter)
- `GET /request` — "Request a Podcast" form (Turnstile protected)
- `POST /request` — Handle request submission (sends email via Postmark)

**API** (`src/routes/api.ts`):
- `GET /api/episodes` — JSON episode list
- `GET /api/episode/:id` — JSON episode detail
- `GET /api/episode/:id/transcript.txt` — Download transcript
- `GET /api/templates` — Available summary templates

**Admin** (`src/routes/admin.ts`, protected by Cloudflare Access):
- `GET /admin` — Admin dashboard (stats, activity log, episode list, admin tools)
- `GET /admin/submit` — Submit episode form
- `POST /admin/submit` — Process episode submission
- `POST /admin/episodes/:id/delete` — Delete episode
- `POST /admin/episodes/:id/tags` — Update episode tags
- `GET /admin/episodes/:id/summaries` — Get all summaries for episode
- `POST /admin/episodes/:id/summaries/:templateId` — Update summary text
- `POST /admin/episodes/:id/regenerate` — Regenerate with different template
- `DELETE /admin/episodes/:id` — Delete episode (REST)
- `DELETE /admin/jobs/:id` — Delete a job
- `POST /admin/rebuild-index` — Rebuild episode index
- `POST /admin/backfill-tags` — Generate tags for untagged episodes
- `POST /admin/cleanup-tags` — Remove invalid tags
- `POST /admin/cleanup-jobs` — Clean up failed jobs
- `POST /admin/backfill-podcast-info` — Backfill podcast metadata
- `GET /admin/podcasts` — Podcast monitoring management page
- `PUT /admin/podcasts/settings` — Update monitoring settings
- `POST /admin/podcasts/add` — Add podcast to monitoring
- `POST /admin/podcasts/check-now` — Force check all podcasts
- `POST /admin/podcasts/:id/check` — Check single podcast
- `DELETE /admin/podcasts/:id` — Remove podcast from monitoring

**Important**: Admin endpoints must be under `/admin` or `/admin/*` paths to be protected by Cloudflare Access. Do not create admin endpoints under other paths.

**Debug** (`src/index.ts`, disabled in production):
- `GET /debug/parse` — Parse an Apple Podcasts URL
- `GET /debug/validate-audio` — Validate audio URL
- `GET /debug/transcribe` — Test transcription
- `GET /debug/episode` — Fetch episode metadata
- `GET /debug/summarize` — Test summarization
- `POST /debug/rebuild-index` — Rebuild episode index

All debug routes return 403 in production (`ENVIRONMENT !== "development"`).

### Podcast Monitoring

Automatically monitors podcasts for new episodes and queues them for processing:
- **Core logic**: `src/lib/monitor.ts` — Functions for adding podcasts, checking for new episodes
- **Cron trigger**: Runs every 8 hours (configured in `wrangler.toml`)
- **Stale job sweep**: Runs at the start of each cron cycle, marks jobs >20 min as failed
- **Admin UI**: `/admin/podcasts` — Add/remove podcasts, configure settings, manual check
- **Episode deduplication**: Tracks processed episode GUIDs per podcast to avoid re-processing
- **Settings**: `enabled` (global on/off), `maxEpisodesPerCheck` (cap per podcast per cycle)
- **Failure notifications**: Discord webhook on monitoring errors and job failures

### Summary Templates

Defined in `src/lib/constants.ts`:
- `key-takeaways` — Professional/craft podcasts (default)
- `narrative-summary` — Story-driven content
- `eli5` — Technical topics explained simply

### Episode Tags

Defined in `src/lib/constants.ts` (EPISODE_TAGS array):
- 15 predefined tags: ai, business, creativity, education, entertainment, faith, health, music, politics, product, psychology, science, sport, startup, technology
- Tags are alphabetically sorted for consistency
- Easy to add/remove tags — just edit the EPISODE_TAGS array
- After removing tags, use "Cleanup Invalid Tags" admin tool to remove them from existing episodes
- Tags generated automatically during episode processing (2-3 tags per episode)
- Admin can manually edit tags via admin dashboard

### Maintenance Mode

Toggle `MAINTENANCE_MODE` in `src/index.ts` to disable HTTP endpoints (queue continues processing).

## Environment & Secrets

**Bindings** (in `wrangler.toml`):
- `TLDL_DATA` — KV namespace
- `TLDL_QUEUE` — Queue (name: `tldl-jobs`)
- `JOB_STATUS` — Durable Object for job status consistency

**Secrets** (set via `wrangler secret put`):
- `OPENAI_API_KEY` — OpenAI API key
- `PODCAST_INDEX_KEY` — Podcast Index API key
- `PODCAST_INDEX_SECRET` — Podcast Index API secret
- `TURNSTILE_SECRET` — Cloudflare Turnstile secret key (spam protection)
- `DISCORD_WEBHOOK_URL` — Discord webhook for failure notifications (optional)
- `POSTMARK_API_KEY` — Postmark server token for request form email (optional)

**Environment Variables** (in `wrangler.toml` `[vars]`):
- `MAX_EPISODE_MINUTES` — Max duration (default: 121)
- `ENVIRONMENT` — `production` or `development`
- `CACHE_TTL_DAYS` — Content cache TTL (default: 365)
- `DEFAULT_TEMPLATE` — Default summary template (default: `key-takeaways`)
- `TURNSTILE_SITE_KEY` — Cloudflare Turnstile site key (spam protection)
- `POSTMARK_FROM_EMAIL` — Sender address for request form emails
- `ADMIN_NOTIFICATION_EMAIL` — Where request form emails are sent
- `POSTMARK_MESSAGE_STREAM` — Postmark message stream name

## Testing

Uses `@cloudflare/vitest-pool-workers` for Workers-like environment. 305+ tests covering:
- Unit tests for all services and admin routes (`test/admin.test.ts`, `test/discord.test.ts`, etc.)
- Integration tests in `test/integration/full-flow.test.ts` (CRUD lifecycle, access control, request form)
- Note: Tests involving Durable Objects may show "Isolated storage" warnings (infrastructure issue in vitest-pool-workers, not failures)
- Tests run with `ENVIRONMENT=development` so admin auth is mocked. Production auth rejection is tested structurally (fail-closed pattern in `requireAdmin`).

## Project Structure

```
src/
├── index.ts              # Hono app, route mounting, cron handler, debug routes
├── types/                # TypeScript type definitions
├── lib/                  # Core utilities
│   ├── constants.ts      # Templates, error codes, TTLs, tags
│   ├── kv.ts             # KV storage helpers + activity log
│   ├── url-parser.ts     # Apple Podcasts URL parsing
│   ├── audio.ts          # MP3 frame-aware chunking
│   ├── errors.ts         # Error handling
│   ├── retry.ts          # Retry logic with backoff
│   ├── job-status-do.ts  # Durable Object client helpers + timeout detection
│   ├── monitor.ts        # Podcast monitoring logic
│   ├── turnstile.ts      # Cloudflare Turnstile verification
│   ├── discord.ts        # Discord webhook notifications
│   ├── components.ts     # Reusable UI components (Footer)
│   ├── styles.ts         # All CSS (embedded in TypeScript)
│   ├── assets.ts         # SVG assets (favicon, Apple Podcasts badge)
│   └── auth.ts           # JWT parsing and auth helpers
├── services/             # External API integrations
│   ├── apple-podcasts.ts # iTunes API + page scraping
│   ├── podcast-index.ts  # Podcast Index API
│   ├── rss.ts            # RSS feed parsing + episode matching
│   ├── transcription.ts  # OpenAI gpt-4o-mini-transcribe
│   ├── summarization.ts  # OpenAI GPT-5.4
│   ├── tag-generation.ts # OpenAI GPT-5.4 for episode tags
│   └── postmark.ts       # Postmark email for request form
├── routes/               # Hono route handlers
│   ├── public.ts         # Public pages + request form
│   ├── api.ts            # JSON API (read-only)
│   └── admin.ts          # Admin dashboard + mutations (Access-protected)
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
- **Stuck jobs**: Jobs running >20 minutes are auto-detected and marked as failed by `listActiveJobsWithDO()` (runs on home page render and in cron handler). Discord notification is sent.
- **Invalid tags showing**: After removing tags from EPISODE_TAGS, run "Cleanup Invalid Tags" from admin tools to remove them from existing episodes
- **Admin endpoints 401/403**: Admin endpoints must be under `/admin` or `/admin/*` to work with Cloudflare Access. Both paths must be configured in the Access application.
- **Debug routes in production**: All `/debug/*` routes return 403 in production. Use admin tools instead.

## How to Re-queue a Failed Episode for the Next Cron

Use this when an episode failed processing and you want the next cron tick (`0 */2 * * *` UTC) to pick it up automatically — instead of resubmitting it manually from `/admin/submit`.

The cron's RSS path has **two independent dedup signals** that both need to be cleared:

1. **Processed-GUID list** (`monitored:processed:{podcastId}` in KV) — persists the GUID of every episode that has been queued. If the failed episode's GUID is in this list, the cron skips it.
2. **Conditional GET etag** (`etag` field on `monitored:{podcastId}`) — if the RSS feed returns 304 Not Modified, the cron exits early without iterating any episodes. Even removing the GUID won't help if the feed never gets re-read.

The episode KV record (`episode:{episodeId}`) is **not** an issue when transcription failed — `saveEpisode` only fires on success, so there's nothing to clean up there.

### Steps

```bash
# 1. Find the failed episode's RSS GUID — fetch the feed and grep by title
curl -s "<rssUrl>" | python3 -c "import sys, re; xml = sys.stdin.read(); items = re.findall(r'<item>(.*?)</item>', xml, re.DOTALL); [print(re.search(r'<title>(.*?)</title>', i).group(1)[:80], '|', re.search(r'<guid[^>]*>(.*?)</guid>', i).group(1)) for i in items[:5]]"

# 2. Remove the GUID from the processed list
NS=ee123158d5d54359b4257f8a1b678adf  # TLDL_DATA
PODCAST_ID=<podcastId>
GUID=<guid-from-step-1>

wrangler kv key get "monitored:processed:$PODCAST_ID" --namespace-id=$NS --remote 2>/dev/null \
  | python3 -c "import sys, json; arr=json.loads(sys.stdin.read()); arr=[g for g in arr if g != '$GUID']; sys.stdout.write(json.dumps(arr))" \
  > /tmp/processed.json
wrangler kv key put "monitored:processed:$PODCAST_ID" --namespace-id=$NS --remote --path /tmp/processed.json

# 3. Strip the etag (and lastModified, if present) from the monitored podcast record
wrangler kv key get "monitored:$PODCAST_ID" --namespace-id=$NS --remote 2>/dev/null \
  | python3 -c "import sys, json; r=json.loads(sys.stdin.read()); r.pop('etag', None); r.pop('lastModified', None); sys.stdout.write(json.dumps(r))" \
  > /tmp/podcast.json
wrangler kv key put "monitored:$PODCAST_ID" --namespace-id=$NS --remote --path /tmp/podcast.json
```

**Gotchas — both have bitten in past sessions:**

* **`wrangler kv` defaults to the local `.wrangler/state` simulator.** Always pass `--remote` for production reads/writes — without it you'll silently hit empty local KV.
* **Never use `2>&1` when piping to a temp file you'll write back to KV.** Any python `print(..., file=sys.stderr)` debug lines will get redirected into the file, prepended to the JSON, and corrupt the KV value. The dashboard will then fail with `Unexpected token 'b', "before key"... is not valid JSON`. Either drop the stderr debug entirely, OR use `2>/dev/null` to suppress stderr in the pipeline.

After both writes, the next cron tick will:
1. Fetch the RSS feed (no etag → 200 OK with full body).
2. See the GUID is no longer in the processed set → queue the episode.
3. Worker processes it normally.

### Faster than this manual flow?

Worth building if it happens more than 2-3 times: a `POST /admin/episodes/{podcastId}/{guid}/requeue` endpoint that performs both deletions in one call. Would also enforce that we never forget the etag step (the painful one — easy to skip and then wait 2h confused about why nothing happened).

## Important Notes

- **GPT-5.4 exists**: The project uses OpenAI GPT-5.4 for both summarization and tag generation. This is a real model — do not change references to GPT-4o or other models unless explicitly instructed.
- **Admin-only model**: There are no "regular users." Only admins can submit episodes. Visitors can request podcasts via `/request`.
- **No auth on public pages**: Public pages have zero auth detection, no login buttons, no client-side auth scripts.
- **Discord and Postmark are optional**: Both degrade gracefully when their secrets are not configured. The app works without them.

## How to Restore Transcripts on Episode Pages

Transcripts are still saved in KV (`transcript:{episodeId}`) but currently hidden from the UI. To restore them:

### 1. Add the import in `src/routes/public.ts`

```typescript
import {
    listEpisodes,
    getEpisode,
    getTranscript,  // Add this
    listSummariesForEpisode,
    // ...
} from "../lib/kv";
```

### 2. Fetch the transcript in the episode route

Replace:
```typescript
// Fetch summaries
const summaries = await listSummariesForEpisode(c.env.TLDL_DATA, episodeId);
```

With:
```typescript
// Fetch transcript and summaries
const [transcript, summaries] = await Promise.all([
    getTranscript(c.env.TLDL_DATA, episodeId),
    listSummariesForEpisode(c.env.TLDL_DATA, episodeId),
]);
```

### 3. Build the transcript content (add before `const content = ...`)

```typescript
// Build transcript content with collapse/expand
// Collapse if transcript is longer than ~20 lines worth of characters
const needsCollapse = transcript ? transcript.text.length > 2000 : false;

const transcriptContent = transcript
    ? `
    <div class="transcript-source">
        <span class="source-indicator"></span>
        ${escapeHtml(transcript.source)} transcript
    </div>
    <div class="transcript-container${needsCollapse ? ' collapsed' : ''}" id="transcript-container">
        <div class="transcript-text" id="transcript-text">
            ${escapeHtml(transcript.text)}
        </div>
        ${needsCollapse ? '<div class="transcript-fade"></div>' : ''}
    </div>
    ${needsCollapse ? `
    <button class="transcript-toggle" id="transcript-toggle" onclick="toggleTranscript()">
        <span id="toggle-text">Show full transcript</span>
        <svg id="toggle-icon" xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="m6 9 6 6 6-6"/>
        </svg>
    </button>
    <script>
        function toggleTranscript() {
            const container = document.getElementById('transcript-container');
            const toggleText = document.getElementById('toggle-text');
            const toggleIcon = document.getElementById('toggle-icon');
            const isCollapsed = container.classList.contains('collapsed');

            if (isCollapsed) {
                container.classList.remove('collapsed');
                toggleText.textContent = 'Show less';
                toggleIcon.style.transform = 'rotate(180deg)';
            } else {
                container.classList.add('collapsed');
                toggleText.textContent = 'Show full transcript';
                toggleIcon.style.transform = 'rotate(0deg)';
            }
        }
    </script>
    ` : ''}
`
    : `
    <div class="empty-state">
        <p>No transcript available for this episode.</p>
    </div>
`;
```

### 4. Add the transcript section in the HTML (after the summary section)

```typescript
        </section>

        <div class="divider"></div>

        <section class="section">
            <h2>Full Transcript</h2>
            <div class="card">
                ${transcriptContent}
            </div>
        </section>
    `;
```

The CSS for `.transcript-source`, `.transcript-container`, `.transcript-text`, `.transcript-toggle`, and `.transcript-fade` is already in `src/lib/styles.ts`.
