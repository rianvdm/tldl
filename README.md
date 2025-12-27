# TLDL — Too Long Didn't Listen

AI-powered podcast summaries from Apple Podcasts URLs. Paste an episode link, get an AI-generated summary with key takeaways.

## Tech Stack

| Layer | Technology |
|-------|------------|
| Runtime | [Cloudflare Workers](https://workers.cloudflare.com) |
| Framework | [Hono](https://hono.dev) |
| Background Jobs | Cloudflare Queues |
| Storage | Cloudflare KV + Durable Objects |
| Podcast Data | [Podcast Index API](https://podcastindex.org) |
| Transcription | OpenAI Whisper |
| Summarization | OpenAI GPT-5.2 |
| Authentication | Cloudflare Access (Email OTP) |
| Spam Protection | Cloudflare Turnstile |

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
| `npm run dev` | Start local dev server (http://localhost:8787) |
| `npm test` | Run all tests |
| `npm test -- test/kv.test.ts` | Run single test file |
| `npm run typecheck` | TypeScript type checking |
| `npm run deploy` | Deploy to production |
| `npx wrangler tail` | Stream live production logs |

## Project Structure

```
src/
├── index.ts                 # Hono app entry, static routes, error handling
├── types/index.ts           # All TypeScript interfaces
├── lib/
│   ├── constants.ts         # Tags, templates, error codes, timeouts
│   ├── kv.ts                # All KV CRUD operations
│   ├── url-parser.ts        # Apple Podcasts URL parsing
│   ├── audio.ts             # MP3 frame-aware chunking for large files
│   ├── styles.ts            # All CSS (embedded, Workers can't read files)
│   ├── job-status-do.ts     # Durable Object client helpers
│   ├── turnstile.ts         # Spam protection verification
│   └── auth.ts              # JWT parsing, admin checks
├── services/
│   ├── apple-podcasts.ts    # Episode metadata lookup
│   ├── podcast-index.ts     # Podcast Index API client
│   ├── rss.ts               # RSS parsing + episode matching
│   ├── transcription.ts     # OpenAI Whisper integration
│   ├── summarization.ts     # GPT-5.2 summary generation
│   └── tag-generation.ts    # GPT-5.2 tag generation
├── routes/
│   ├── public.ts            # Public pages (home, episodes, podcasts)
│   ├── api.ts               # JSON API endpoints
│   └── authenticated.ts     # Protected mutations, admin tools
├── queue/
│   └── consumer.ts          # Background job processor
└── durable-objects/
    └── job-status.ts        # Job status DO for consistency
```

## Architecture

### Episode Processing Flow

1. **Submit** (`POST /submit`): User submits Apple Podcasts URL
   - URL parsed → episode ID derived
   - Check KV cache for existing episode
   - Create job in Durable Object + KV
   - Enqueue to Cloudflare Queue
   - Redirect to job status page

2. **Queue Consumer** (`src/queue/consumer.ts`): Background processing
   - Fetch episode metadata via Podcast Index + RSS
   - Check for existing transcript in RSS feed
   - Transcribe with OpenAI Whisper (chunking for >25MB)
   - Generate summary with GPT-5.2
   - Generate 1-4 tags with GPT-5.2 (non-critical)
   - Store in KV with 365-day TTL

3. **View** (`GET /episode/:id`): Serve cached episode with summary

### Key Design Decisions

**Durable Objects for Job Status**: KV is eventually consistent, which caused issues with job status pages showing stale data. Durable Objects provide strong consistency for real-time job tracking.

**Podcast Index over iTunes API**: iTunes API returns 403s from Workers. Podcast Index is a free, open alternative with better reliability.

**Embedded CSS**: Workers can't read from filesystem. All styles are in `src/lib/styles.ts`.

**MP3 Frame-Aware Chunking**: OpenAI Whisper has a 25MB limit. Large files are split at MP3 frame boundaries to avoid audio corruption.

**Non-Critical Tag Generation**: If tag generation fails, the job continues. Empty tags are acceptable.

### KV Storage Schema

| Key Pattern | TTL | Description |
|-------------|-----|-------------|
| `job:{jobId}` | 1 day | Job state and progress |
| `episode:{episodeId}` | 365 days | Episode metadata |
| `transcript:{episodeId}` | 365 days | Full transcript |
| `summary:{episodeId}:{templateId}` | 365 days | Generated summary |
| `episodes:index` | 365 days | Lightweight list for home page |
| `ratelimit:{email}:{hour}` | 1 hour | Rate limiting |
| `waitlist:{email}` | none | Waitlist signups |

## Configuration

### Secrets (set via `wrangler secret put`)

| Secret | Description |
|--------|-------------|
| `OPENAI_API_KEY` | OpenAI API key for Whisper + GPT |
| `PODCAST_INDEX_KEY` | Podcast Index API key |
| `PODCAST_INDEX_SECRET` | Podcast Index API secret |
| `TURNSTILE_SECRET` | Cloudflare Turnstile secret key |

### Environment Variables (in `wrangler.toml`)

| Variable | Default | Description |
|----------|---------|-------------|
| `MAX_EPISODE_MINUTES` | 106 | Maximum episode duration |
| `CACHE_TTL_DAYS` | 365 | How long to cache content |
| `DEFAULT_TEMPLATE` | key-takeaways | Default summary template |
| `TURNSTILE_SITE_KEY` | — | Turnstile widget site key |

## Testing

Uses `@cloudflare/vitest-pool-workers` for a Workers-like test environment.

```bash
npm test                      # Run all tests
npm test -- test/kv.test.ts   # Run single file
npm run test:watch            # Watch mode
```

Tests are organized to mirror `src/`:
- `test/kv.test.ts` — KV storage operations
- `test/rss.test.ts` — RSS parsing and episode matching
- `test/transcription.test.ts` — Whisper integration
- `test/integration/` — End-to-end flows

**Note**: Durable Object tests may show "Isolated storage" warnings. This is a Vitest pool infrastructure issue, not a test failure.

## Debugging

### Inspect KV Data

```bash
# View episode data
npx wrangler kv key get --namespace-id=ee123158d5d54359b4257f8a1b678adf "episode:<episodeId>"

# View summary
npx wrangler kv key get --namespace-id=ee123158d5d54359b4257f8a1b678adf "summary:<episodeId>:<templateId>"

# View transcript
npx wrangler kv key get --namespace-id=ee123158d5d54359b4257f8a1b678adf "transcript:<episodeId>"
```

### Debug Routes (Development Only)

| Route | Description |
|-------|-------------|
| `GET /debug/parse?url=...` | Test URL parsing |
| `GET /debug/episode?url=...` | Fetch episode metadata |
| `GET /debug/validate-audio?url=...` | Validate audio URL |
| `GET /debug/transcribe?url=...` | Test transcription (blocked in prod) |
| `GET /debug/summarize?text=...` | Test summarization (blocked in prod) |

### Live Logs

```bash
npx wrangler tail
```

## Deployment

```bash
# Set secrets (first time only)
wrangler secret put OPENAI_API_KEY
wrangler secret put PODCAST_INDEX_KEY
wrangler secret put PODCAST_INDEX_SECRET
wrangler secret put TURNSTILE_SECRET

# Deploy
npm run deploy
```

### Maintenance Mode

To disable HTTP endpoints while keeping queue processing:

```typescript
// src/index.ts
const MAINTENANCE_MODE = true;
```

## Admin Tools

Admin endpoints are under `/profile/*` (protected by Cloudflare Access). Available to users in `ADMIN_EMAILS` array in `src/lib/constants.ts`.

| Tool | Endpoint | Description |
|------|----------|-------------|
| Rebuild Index | `POST /profile/rebuild-index` | Rebuild episode index from all episodes |
| Update Tags | `POST /profile/update-tags/:id` | Manually edit episode tags |
| Edit Summary | `POST /profile/update-summary/:id/:templateId` | Edit summary text |
| Backfill Tags | `POST /profile/backfill-tags` | Generate tags for episodes without them |
| Cleanup Tags | `POST /profile/cleanup-invalid-tags` | Remove tags not in EPISODE_TAGS |
| View Waitlist | `GET /profile/waitlist` | View collected waitlist emails |

## Summary Templates

| Template | Best For |
|----------|----------|
| `key-takeaways` | Professional/craft podcasts — bullet points, actionable insights |
| `narrative-summary` | Story-driven content — flowing prose |
| `eli5` | Technical topics — simple language, analogies |

## Episode Tags

14 predefined tags in `src/lib/constants.ts`:

ai, business, creativity, education, entertainment, faith, health, music, politics, product, psychology, science, sport, technology

To add/remove tags:
1. Edit `EPISODE_TAGS` array in `src/lib/constants.ts`
2. After removing tags, use "Cleanup Invalid Tags" admin tool

## Best Practices

### Code Style

- **Keep it simple**: Avoid over-engineering. Only add what's directly needed.
- **Read before editing**: Always read existing code before modifying.
- **Prefer editing over creating**: Edit existing files rather than creating new ones.
- **No backward compatibility hacks**: Delete unused code completely.

### Testing

- Write tests for new functionality
- Run `npm test` before committing
- Keep tests focused and fast

### Security

- Never commit secrets to `.dev.vars`
- Validate all user input
- Be mindful of OWASP top 10 vulnerabilities

### Performance

- KV reads are fast; use them liberally
- Durable Objects are for consistency, not speed
- Queue processing has a 20-minute timeout

## Common Issues

| Issue | Solution |
|-------|----------|
| iTunes 403 errors | Use Podcast Index API (already configured) |
| Episode title wrong | URL slugs are unreliable; we scrape the actual page |
| Large audio fails | Files >25MB are automatically chunked |
| Job status stale | Durable Object handles consistency; KV is backup |
| Admin 401/403 | Endpoints must be under `/profile/*` for Cloudflare Access |

## More Documentation

See `CLAUDE.md` for detailed architecture documentation, including:
- Complete route reference
- All KV key patterns
- Durable Object implementation
- Queue consumer pipeline
- Authentication flow
- How to restore transcripts to UI

See `docs/` for design documents and archived plans.
