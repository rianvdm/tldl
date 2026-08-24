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

Compare summary models before adopting a new one (see [Model A/B harness](#model-ab-harness)):
```bash
npm run ab:summary                  # curated 6-episode sample, gpt-5.6-terra vs gpt-5.4
npm run ab:summary -- --random 8    # 8 random prod transcripts
npm run ab:summary -- --help
```

## Architecture Overview

TLDL is a Cloudflare Workers application that generates AI summaries of podcast episodes. It's an **admin-curated archive** — only admins can submit episodes and manage podcasts. Visitors browse, read, subscribe via RSS, or request a podcast to be added.

Built with Hono framework, Cloudflare Queues for background processing, and Durable Objects for job status consistency.

### Request Flow

1. **Admin submits** (`POST /admin/submit`): Validates Apple Podcasts URL → checks KV cache → creates job in Durable Object + KV → enqueues to Cloudflare Queue → redirects to admin dashboard
2. **Queue Consumer** (`src/queue/consumer.ts`): Processes jobs in background:
   - Fetches episode metadata via Podcast Index API + RSS feed parsing
   - Checks for existing transcript (RSS `<podcast:transcript>` tag)
   - Falls back to OpenAI gpt-transcribe for transcription (with chunking for >25MB files; whisper-1 fallback for rejected files)
   - Generates summary via OpenAI gpt-5.6-terra
   - Generates 2-3 AI tags using gpt-5.6-luna (non-critical: continues if fails)
   - Stores results in KV with 365-day TTL
   - Logs completion/failure to activity log
   - Sends Discord notification on failure
3. **View** (`GET /episode/:id`): Serves cached episodes with summary, transcript, and tags
4. **Monitoring** (cron every 2h): Checks monitored podcasts for new episodes, queues them automatically

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
- **Episode Tags**: AI-generated using gpt-5.6-luna via the Responses API during queue processing (2-3 tags per episode)
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
- **Cron trigger**: Runs every 2 hours (`0 */2 * * *`, configured in `wrangler.toml`)
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

**Changing a podcast's template for upcoming episodes:** each monitored podcast has its own `templateId` frozen into its `monitored:{podcastId}` KV record at add-time. The 2h cron summarizes new episodes with `podcast.templateId` (`src/lib/monitor.ts`), **not** the global `DEFAULT_TEMPLATE` env var — flipping that env var only affects *newly added* podcasts / manual submits, never existing monitored ones. There is **no `/admin` UI to edit a template after adding** (the dropdown only exists on "Add Podcast"). To retarget upcoming episodes, edit the KV record directly:
```bash
NS=ee123158d5d54359b4257f8a1b678adf
wrangler kv key get "monitored:<podcastId>" --namespace-id=$NS --remote   # read
# change "templateId" to key-takeaways | narrative-summary | eli5, preserve all other fields, then:
wrangler kv key put "monitored:<podcastId>" '<edited-json>' --namespace-id=$NS --remote
```
This is forward-only — already-processed episodes keep their existing `summary:{episodeId}:{templateId}` blobs; regenerate per-episode via `POST /admin/episodes/:id/summaries/:templateId` if you want them converted.

The summary model is a single constant: `MODEL` in `src/services/summarization.ts` (also `editorial-meta.ts` for deck/pull quote, `tag-generation.ts` for tags). Currently `gpt-5.6-terra` for summaries + editorial meta and `gpt-5.6-luna` for tags, via the OpenAI Responses API. Swapping is a one-line change per service.

### Model A/B harness

`scripts/ab-summary.ts` (run via `npm run ab:summary`) compares summary models head-to-head before you change that constant. It runs the **exact production prompt** over **real prod transcripts** (pulled from KV) through two or more models with fresh, cache-bypassed calls, and writes a side-by-side markdown report with per-run **token usage, word count, latency, and cost**. Output lands in `scripts/ab-results/` (gitignored). It's not wired into the Worker — it's a standalone decision tool.

```bash
npm run ab:summary                              # curated 6-episode sample, gpt-5.6-terra vs gpt-5.4
npm run ab:summary -- --random 8                # 8 random prod transcripts
npm run ab:summary -- <episodeId> <episodeId>   # specific episodes
npm run ab:summary -- --models gpt-5.6-terra,gpt-6  # compare against a newly released model
npm run ab:summary -- --template narrative-summary
```

When a new model ships, add its per-1M input/output price to the `PRICING` map at the top of the script (unknown models still run, cost just shows `n/a`), then run it against the curated sample. Watch the **Words** column — the `key-takeaways` template asks for 400–600 words, and length drift is a real differentiator (e.g. the 2026-06-21 run found gpt-5.5 cost ~2.3× more, ran ~2× slower, and overshot the word budget for marginal quality gains, so we stayed on gpt-5.4).

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

Uses `@cloudflare/vitest-pool-workers` for Workers-like environment. 523 tests (as of 2026-08-17) covering:
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
│   ├── transcription.ts  # OpenAI gpt-transcribe (whisper-1 fallback)
│   ├── summarization.ts  # OpenAI gpt-5.6-terra
│   ├── tag-generation.ts # OpenAI gpt-5.6-luna for episode tags
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
- **Job fails with `exceededWallTime` — check for a 429 first.** `exceededWallTime` is a *symptom* shared by two unrelated causes, and the rate-limit one is more common. Read the Workers logs before assuming the wall clock is the problem; filter for `validation_rate_limited_throw` and `audio_url_redirect_resolved`. See the two entries below.
- **Audio CDN rate limiting (`validation_rate_limited_throw`)**: Log line reads `Audio host rate-limited after redirect resolution; bubbling to queue retry` (older builds: `HEAD request rate-limited` / `Both origin and resolved URL rate-limited`). The podcast host is 429ing Cloudflare's egress on the audio HEAD, so every one of the 5 queue retries fails and the episode never transcribes. Broke Lenny's on 2026-08-16 and The Pragmatic Engineer on 2026-08-12 — both Substack, and 9 of 12 monitored podcasts are Substack-hosted. Root cause was that `resolveAudioUrl()` followed only **one** redirect hop: the real chain is `pscrb.fm` → `api.substack.com` → `substackcdn.com`, so one hop landed back on the rate-limited origin. Partially fixed 2026-08-17 — `resolveAudioUrl()` now follows the chain to the end (`AUDIO_LIMITS.MAX_REDIRECT_HOPS`), and `transcribeAudio()` resolves **before** validating so the throttled hosts see one cheap HEAD while validation and range reads hit the CDN.

  **Recurred 2026-08-23 on the same two podcasts**, because following the chain isn't enough when a hop *itself* 429s. `resolveAudioUrl()` treats any non-3xx status as "chain finished" (`if (response.status < 300 || response.status >= 400) return currentUrl`), and 429 is ≥400 — so a throttled hop is silently accepted as the final URL. The Worker resolved `pscrb.fm` → `prefix-v4.pscrb.fm` → `api.substack.com`, got 429 on the next HEAD, and returned `api.substack.com` — the rate-limited origin, one hop short of `substackcdn.com`. `validateAudioUrl()` then HEADs that same throttled host, correctly throws `RATE_LIMITED`, and all 5 queue retries repeat it. `MAX_REDIRECT_HOPS` (5) is **not** the constraint; don't raise it. Tracked in #52.

  Two tells that distinguish this from a genuine end-of-chain: the last `audio_url_redirect_resolved` line has a `toHost` that is an origin rather than a CDN (`api.substack.com`, not `substackcdn.com`), and — **on builds before 2026-08-24** — the 429 hop logs nothing, so the chain just stops mid-stream. There is now an `audio_url_hop_rate_limited` event, so a throttled hop is visible; a chain that stops with neither event is a genuine end-of-chain. Confirm by running the same chain from your laptop with `curl -sIL`: if it reaches the CDN with a 200 and the Worker didn't, the throttle is specific to Cloudflare's egress, not the URL.

  **Recurred a third time 2026-08-24 on Supra Insider** (`1737704130_rss_8f943af625`), in a shape worth understanding because it rules out the obvious fixes. That feed's enclosure is `api.substack.com` directly, with no `pscrb.fm` prefix — so the 429 landed on **hop zero**, where there is no `Location` header to follow and no earlier hop to fall back to. Following the chain harder cannot help that case; only retrying the throttled hop can.

  What the throttle actually is, measured from Cloudflare egress via `wrangler dev --remote` on 2026-08-24:

  * **It is probabilistic, not categorical.** 9 successes in 34 attempts (~26%). A 429 is a coin flip, not a verdict on the URL.
  * **Method, User-Agent and `Range` make no difference.** An early run showed a clean HEAD-429/GET-307 split that looked like HEAD being singled out; alternating the methods showed HEAD succeeding and GET failing. That split was coincidence — don't rebuild a fix on it.
  * **Spacing attempts out does not help.** 20 raw attempts 40s apart succeeded 3 times (15%). The limiter isn't a cooldown you can wait out on a per-job timescale.
  * The CDN (`substackcdn.com`) is never throttled — once resolution succeeds, validation and all the chunk range reads are fine.

  Mitigated 2026-08-24: `resolveAudioUrl()` retries a 429'd hop (`AUDIO_LIMITS.HOP_RATE_LIMIT_*`, 7 attempts over ~9s) rather than accepting the throttled origin as final. Measured live, that lifts per-attempt resolution from ~20% to ~33%; across the queue's 5 rate-limit retries the modelled per-episode failure rate drops from ~37% to ~13%. **That is a mitigation, not a fix** — roughly one Substack episode a week should still fail, and #52 stays open. The candidate real fix is to clear the two dedup signals on a final rate-limit failure so the next 2h cron tick retries the episode with fresh draws (`episodeGuid` is already on the queue message, so no feed re-hashing is needed). Note the tension before retrying harder still: `consumer.ts` warns that short retries extend the ban, and while the evidence says this is a probabilistic limiter rather than a hardening one, that was not measured over hours.

  Workaround when it recurs: use the **Audio URL (override)** field under Advanced options on `/admin/submit` with the resolved CDN URL — but note substackcdn.com URLs are signed with a short `Expires` (~1 day), so resolve and submit promptly. Otherwise do the manual rescue below, which sidesteps the audio path entirely.
- **Job "transcribing" forever / `updatedAt` jumping by exactly +15:00**: Queue consumer invocations have a hard 15-minute wall clock (Cloudflare platform limit). A long episode whose every chunk falls back to whisper-1 (~90–150s/chunk — happens when the primary model 400s the file as "corrupted or unsupported"; whisper-1 usually decodes it fine) gets killed (`exceededWallTime`) and the retry restarts from chunk 1, so it never converges (#48 tracks the fix: per-chunk KV cache). Killed invocations do NOT persist their console logs. Manual rescue: run `transcribeAudio` locally via `npx tsx` (no wall clock), write the `transcript:{episodeId}` record to KV, then requeue via the runbook below — the consumer finds the transcript and skips straight to summarizing. Because Step 3 of the consumer is guarded by `if (!transcript)`, a pre-seeded transcript also skips the audio fetch entirely, which is what makes this the right rescue for rate-limit failures too.
- **`OpenAI API returned empty or malformed response` / tags silently empty**: The Responses API does **not** put the assistant message at `output[0]` — reasoning-capable models (the gpt-5.6 tiers) emit a `reasoning` item first, so `output` is `["reasoning", "message"]`. Always extract via `extractOutputText()` in `src/lib/openai-response.ts` (searches `output` for the `message` item, then its content for `output_text`); never index `output[0]`. The behavior is **adaptive** — a short prompt returns `["message"]` but a real transcript returns `["reasoning", "message"]` — so a quick probe won't reproduce it. Broke every cron episode on 2026-08-03 after the gpt-5.4 → gpt-5.6 swap (fixed in `49bb738`); the same bug made tag generation return `[]` on every episode via its non-critical path. **Before adopting any new model, dump `data.output.map(o => o.type)` against a real production-sized transcript, and make sure the A/B harness and any test fixtures use the same extractor production does** (#50).
- **Invalid tags showing**: After removing tags from EPISODE_TAGS, run "Cleanup Invalid Tags" from admin tools to remove them from existing episodes
- **Admin endpoints 401/403**: Admin endpoints must be under `/admin` or `/admin/*` to work with Cloudflare Access. Both paths must be configured in the Access application.
- **Debug routes in production**: All `/debug/*` routes return 403 in production. Use admin tools instead.

## How to Re-queue a Failed Episode for the Next Cron

Use this when an episode failed processing and you want the next cron tick (`0 */2 * * *` UTC) to pick it up automatically — instead of resubmitting it manually from `/admin/submit`.

The cron's RSS path has **two independent dedup signals** that both need to be cleared:

1. **Processed-GUID list** (`monitored:processed:{podcastId}` in KV) — persists the GUID of every episode that has been queued. If the failed episode's GUID is in this list, the cron skips it.
2. **Conditional GET etag** (`etag` field on `monitored:{podcastId}`) — if the RSS feed returns 304 Not Modified, the cron exits early without iterating any episodes. Even removing the GUID won't help if the feed never gets re-read.

The episode KV record (`episode:{episodeId}`) is **not** an issue when transcription failed — `saveEpisode` only fires on success, so there's nothing to clean up there.

### First: find out why it failed

A failure notification gives you an episode ID and nothing else. Before requeuing, read the logs — a rate-limited episode and a wall-time-killed one look identical from KV, and requeuing a rate-limited one just burns another 5 retries. Workers Logs are retained a few days, so do this promptly. Query the observability API (`observability.enabled` is on at `head_sampling_rate: 1`):

```javascript
// via the cloudflare MCP execute tool, or POST with a scoped API token
cloudflare.request({
  method: "POST",
  path: `/accounts/${accountId}/workers/observability/telemetry/query`,
  body: {
    queryId: "tldl-fail-probe",
    timeframe: { from: <epochMs>, to: <epochMs> },
    limit: 1000,
    parameters: {
      datasets: ["cloudflare-workers"],
      // Filter on origin, NOT service. Episode processing is all queue-origin, so
      // this drops every page-view and DO-fetch row in one step instead of
      // regexing them out afterwards (`$metadata.service == "tldl"` returns ~90%
      // `GET http://tldl-pod.com/...` noise, and episode IDs appear in those URLs,
      // so naive grepping for an episode ID matches page views, not job logs).
      filters: [{ key: "$metadata.origin", operation: "eq", value: "queue", type: "string" }],
    },
    view: "events",
  },
})
```

**Read `source.event`, not `source.message`.** This is the trap — every structured log in this repo is a `console.log(JSON.stringify({event: "...", ...}))`, and the observability API parses that JSON and spreads it into `source` as its own fields. So a redirect log arrives as:

```json
{"source": {"event": "audio_url_redirect_resolved", "fromHost": "pscrb.fm",
            "toHost": "prefix-v4.pscrb.fm", "hop": 1},
 "$workers": {"event": {"queue": "tldl-jobs", "batchSize": 1}, "outcome": "ok"},
 "$metadata": {"origin": "queue", "service": "tldl"}}
```

`source.message` is **empty** for all of them — it is only populated for bare `console.log("some string")` calls, of which this repo has almost none. A probe that reads `source.message` comes back blank and looks like "no logs retained," which is wrong and wasted two query round-trips on 2026-08-23. Group by `source.event` to get the shape of a failure fast.

`$workers.outcome` is also absent (`undefined`) on most individual log rows — it is attached to the invocation summary row, not to every line. Don't treat a missing `outcome` as a missing failure.

Read the events together as a timeline — `exceededWallTime` shows up in **both** failure modes, so it does not identify the cause on its own. `validation_rate_limited_throw` means the CDN 429'd you; its absence with repeated +15:00 gaps means the wall clock. But see the next caveat: **a chain that dies on a 429 inside `resolveAudioUrl()` logs nothing at all**, so "no rate-limit event" is not proof it wasn't a 429 — check the last `audio_url_redirect_resolved` line and ask whether its `toHost` is actually a CDN. Note the account ID is the Elezea one, `db8ef1f4b492e4727e7fab0e12907871`.

### Steps

```bash
# 1a. Map the episode ID back to its feed GUID.
# Cron-queued IDs are {podcastId}_rss_{first 10 hex of SHA256(guid)} — see
# src/lib/rss-episode-id.ts. You can't reverse a hash, so hash every GUID in the
# feed and match. This is the path to use when all you have is the episode ID.
python3 - <<'PY'
import hashlib, re, urllib.request
TARGET_HASH = "51f2d1bae2"   # the part after _rss_
RSS_URL     = "<rssUrl>"     # from monitored:{podcastId}.rssUrl
xml = urllib.request.urlopen(urllib.request.Request(RSS_URL, headers={"User-Agent": "Mozilla/5.0"})).read().decode("utf-8", "replace")
for item in re.findall(r"<item>(.*?)</item>", xml, re.DOTALL):
    g = re.search(r"<guid[^>]*>(.*?)</guid>", item, re.DOTALL)
    if not g: continue
    guid = g.group(1).strip()
    if hashlib.sha256(guid.encode()).hexdigest()[:10] == TARGET_HASH:
        t = re.search(r"<title>(.*?)</title>", item, re.DOTALL)
        e = re.search(r'<enclosure[^>]*url="([^"]+)"', item)
        print("guid: ", guid)
        print("title:", re.sub(r"<!\[CDATA\[|\]\]>", "", t.group(1)).strip() if t else "?")
        print("audio:", e.group(1) if e else "?")
PY

# 1b. Or, if you already know the title, grep the feed for it
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
* **A missing key prints its 404 to *stdout*, so `2>/dev/null` does not hide it and a non-empty result does not mean the key exists.** `wrangler kv key get` on an absent key exits non-zero and writes `✘ [ERROR] Failed to fetch … 404: Not Found` plus wrangler's upgrade banner down the same pipe you were expecting JSON on. Measuring "did I get bytes back?" will report every missing key as present. **Check the exit code, or pipe to `python3 -c 'json.load(sys.stdin)'` and let it throw.** Tell to watch for: several different keys all returning the *same* byte count — that's the banner, not your data.
* **`wrangler kv key put` takes `--ttl`, not `--expiration-ttl`** (as of wrangler 4.87). The wrong flag hard-errors with `Unknown arguments: expiration-ttl, expirationTtl`, which at least fails loudly. Content keys want `--ttl 31536000` to match `TTL.CONTENT`; `monitored:*` keys take no TTL at all, so omit it there or you'll silently schedule your podcast config for deletion.

After both writes, the next cron tick will:
1. Fetch the RSS feed (no etag → 200 OK with full body).
2. See the GUID is no longer in the processed set → queue the episode.
3. Worker processes it normally.

### Variant: pre-seed the transcript (rescue for rate-limit or wall-time failures)

When the consumer can't get through the audio at all — the CDN is 429ing it, or every chunk falls back to whisper-1 and the 15-minute wall clock kills the invocation — transcribe locally and hand the result to the consumer. Step 3 of `processEpisode` is guarded by `if (!transcript)`, so a transcript already in KV makes the requeued job skip **the entire audio path** and go straight to summarizing. Your laptop has no wall clock and isn't the IP being throttled.

**Use `scripts/rescue-transcript.ts` — it does this entire runbook in one command.** It reverse-maps the episode ID to its feed GUID, transcribes locally with the repo's own `transcribeAudio()`, writes `transcript:{id}` to prod KV with the right TTL, and clears **both** dedup signals (processed-GUID list and etag). Run it from the repo root so `.dev.vars` loads:

```bash
npm run rescue -- <episodeId> [<episodeId> ...]
npm run rescue -- <episodeId> --dry-run          # transcribe only, write local JSON, touch no KV
npm run rescue -- <episodeId> --audio-url <url>  # skip feed lookup (episode aged out of the feed)
npm run rescue -- --help
```

It **refuses to write a partial transcript** to KV, and prints the last 90 characters so you can confirm the episode ends on a sign-off rather than mid-sentence. Then wait for the next cron tick; completion takes <60s because only the summary and tags still need generating.

Do it by hand only if the script can't help (e.g. the podcast is no longer monitored, so `monitored:{podcastId}` is gone). The manual path is: transcribe locally → `wrangler kv key put "transcript:$ID" --namespace-id=$NS --remote --ttl 31536000 --path ./transcript-$ID.json` → steps 2 + 3 above.

Done for two episodes on 2026-08-17 (~$1 of OpenAI transcription for 158 minutes of audio, ~2 min each), and again on 2026-08-23 for Lenny's `1627920305_rss_8586f646f6` (85 min → 87,105 chars, 5.0 min wall) and The Pragmatic Engineer `1769051199_rss_4c54613009` (92 min → 61,196 chars, 1.7 min wall). Verify afterwards that `episode:{id}` exists, `summary:{id}:{templateId}` exists, and the ID is in `episodes:index`.

Two things worth knowing before you run it:

* **Check `result.partial` and eyeball the tail of the text.** A partial transcript still writes a plausible-looking KV record and the summary will be generated from truncated content. A complete podcast transcript almost always ends on a sign-off ("see you in the next episode"); a mid-sentence ending means a chunk was dropped.
* **The wall-clock difference is mostly whisper-1 fallback, not network.** On 2026-08-23 all 6 of Lenny's chunks were rejected by `gpt-transcribe` as "corrupted or unsupported" and fell back to whisper-1 (~50s/chunk vs ~15s), while The Pragmatic Engineer needed only one fallback. That episode was failing **two** ways at once — the 429 above *and* the #48 wall-clock pattern — so a fix for either alone would not have rescued it.

### Variant: re-process a SUCCESSFUL episode (not failed)

When the episode finished cleanly but you want to re-run it (e.g., you switched models and want fresh summaries on existing episodes), the runbook above isn't enough — `episode:{id}`, `transcript:{id}`, `summary:{id}:*` already exist and the episode is in `episodes:index`. Steps 2 + 3 above plus delete those records:

1. `wrangler kv key delete "episode:$ID" --namespace-id=$NS --remote`
2. `wrangler kv key delete "transcript:$ID" --namespace-id=$NS --remote`
3. List + delete each `summary:$ID:*` key (`wrangler kv key list --prefix "summary:$ID:" ...`)
4. Pull `$ID` out of `episodes:index` (read, filter, write back)
5. Then steps 2 + 3 of the failed-episode runbook (processed list + etag).

Or: `deleteEpisode` in `src/lib/kv.ts:250` already does the first four — `POST /admin/episodes/{id}/delete` is the one-call form. Then still do the processed-list + etag clear manually.

### Variant: rewriting a monitored podcast record (data repair)

If you ever manually overwrite `monitored:{podcastId}` (e.g., to repair a record where Podcast Index returned a broken response and saved a podcast with missing `name`/`rssUrl`), you MUST also reconcile `monitored:processed:{podcastId}` against the current RSS feed BEFORE the next cron tick. Otherwise the cron sees every feed GUID not in the processed list as a "new episode" and grinds through up to `maxEpisodesPerCheck` per 2h cron — a podcast with 150 historical episodes and 6 processed will quietly transcribe 24/day for a week.

Backfill recipe (mark every current-feed GUID as processed so only genuinely new episodes get queued):

```bash
NS=ee123158d5d54359b4257f8a1b678adf
PODCAST_ID=<podcastId>
RSS_URL=<rssUrl>

# Fetch current feed GUIDs
curl -sL "$RSS_URL" | grep -oE '<guid[^>]*>[^<]+</guid>' | sed -E 's/<[^>]+>//g' > /tmp/feed-guids.txt

# Get current processed list
wrangler kv key get "monitored:processed:$PODCAST_ID" --namespace-id=$NS --remote 2>/dev/null > /tmp/processed-current.json

# Merge (preserve existing order, append missing feed GUIDs), write back
python3 -c "
import json
with open('/tmp/feed-guids.txt') as f: feed = [l.strip() for l in f if l.strip()]
with open('/tmp/processed-current.json') as f: cur = json.load(f)
seen = set(cur); merged = list(cur)
for g in feed:
    if g not in seen: merged.append(g); seen.add(g)
with open('/tmp/processed-merged.json', 'w') as f: json.dump(merged, f, separators=(',', ':'))
print(f'Added {len(merged) - len(cur)} GUIDs')
"
wrangler kv key put "monitored:processed:$PODCAST_ID" --namespace-id=$NS --remote --path /tmp/processed-merged.json
```

Root cause for why the gap exists: `addPodcastToMonitoring` at `src/lib/monitor.ts:117` trusts the Podcast Index API to return the full episode list. If PI returns 0 or a sparse subset, only those GUIDs get marked processed — every later cron treats the RSS-feed remainder as new. Until that's hardened (sparse-PI fallback to RSS GUID union), every PI-incomplete add is a latent backlog cascade waiting for the record to start being checked.

### Faster than this manual flow?

Mostly solved: `scripts/rescue-transcript.ts` (added 2026-08-23, after the fourth occurrence) does the clearing automatically, so the etag step — the painful one, easy to skip and then wait 2h confused about why nothing happened — can no longer be forgotten.

Still worth building if this keeps recurring: a `POST /admin/episodes/{podcastId}/{guid}/requeue` endpoint that clears both dedup signals from the admin UI, so a requeue that doesn't need a local transcribe doesn't require a laptop and a KV token at all.

## Important Notes

- **GPT-5.6 exists**: The project uses OpenAI gpt-5.6-terra for summarization/editorial meta and gpt-5.6-luna for tags. These are real models (5.6 ships as luna/sol/terra tiers) — do not change references to GPT-4o or other models unless explicitly instructed.
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
