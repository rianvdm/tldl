# TLDL — Too Long Didn't Listen

> AI-powered podcast summaries from Apple Podcasts URLs

Paste an Apple Podcasts episode URL, get an AI-generated summary. Transcripts and summaries are cached for a year and publicly accessible.

## Features

- **Automatic transcription** — Uses existing transcripts from RSS feeds, or falls back to OpenAI Whisper
- **Smart episode matching** — Multi-strategy matching handles various podcast feed formats
- **Large file support** — Audio files >25MB are automatically chunked at MP3 frame boundaries
- **Three summary templates** — Key Takeaways, Narrative Summary, or ELI5
- **PDF export** — Download summaries as formatted PDFs
- **Public access** — Anyone can view completed summaries; authenticated users can submit new episodes

## Tech Stack

| Component | Technology |
|-----------|------------|
| Runtime | [Cloudflare Workers](https://workers.cloudflare.com) |
| Framework | [Hono](https://hono.dev) |
| Background Jobs | Cloudflare Queues |
| Storage | Cloudflare Workers KV + Durable Objects |
| Podcast Metadata | [Podcast Index API](https://podcastindex.org) |
| Transcription | OpenAI Whisper API |
| Summarization | OpenAI GPT-5.2 |
| Authentication | Cloudflare Access (Email OTP) |

## Quick Start

### Prerequisites

- Node.js 18+
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/install-and-update/)
- Cloudflare account
- OpenAI API key
- Podcast Index API credentials (free at [podcastindex.org](https://podcastindex.org))

### Local Development

```bash
# Install dependencies
npm install

# Create .dev.vars file with your secrets
cat > .dev.vars << EOF
OPENAI_API_KEY=sk-...
PODCAST_INDEX_KEY=...
PODCAST_INDEX_SECRET=...
EOF

# Start local dev server
npm run dev
# → http://localhost:8787
```

### Running Tests

```bash
npm test                    # Run all 214+ tests
npm test -- test/kv.test.ts # Run single test file
```

### Deploy to Production

```bash
# Set secrets (one-time)
wrangler secret put OPENAI_API_KEY
wrangler secret put PODCAST_INDEX_KEY
wrangler secret put PODCAST_INDEX_SECRET

# Deploy
npm run deploy

# View logs
npx wrangler tail
```

## Project Structure

```
tldl/
├── src/
│   ├── index.ts                 # Hono app entry, exports fetch + queue handlers
│   ├── routes/
│   │   ├── public.ts            # HTML pages (list, detail, submit form, job status)
│   │   ├── api.ts               # JSON API endpoints
│   │   └── authenticated.ts     # Protected mutation endpoints
│   ├── services/
│   │   ├── podcast-index.ts     # Podcast Index API client
│   │   ├── rss.ts               # RSS feed parsing + episode matching
│   │   ├── transcription.ts     # OpenAI Whisper integration
│   │   ├── summarization.ts     # OpenAI GPT integration
│   │   └── pdf.ts               # PDF generation with jsPDF
│   ├── queue/
│   │   └── consumer.ts          # Background job processor
│   ├── durable-objects/
│   │   └── job-status.ts        # Strongly consistent job status
│   └── lib/
│       ├── kv.ts                # KV storage helpers
│       ├── audio.ts             # MP3 chunking for large files
│       ├── constants.ts         # Summary templates
│       └── errors.ts            # Error types and messages
├── test/                        # Vitest tests (mirrors src/ structure)
├── public/
│   ├── styles.css               # Dark mode CSS
│   └── favicon.svg
└── wrangler.toml                # Cloudflare Workers configuration
```

## Configuration

### Environment Variables

Set in `wrangler.toml`:

| Variable | Default | Description |
|----------|---------|-------------|
| `MAX_EPISODE_MINUTES` | 80 | Maximum episode duration (rejects longer) |
| `CACHE_TTL_DAYS` | 365 | How long to cache transcripts/summaries |
| `DEFAULT_TEMPLATE` | key-takeaways | Default summary template |
| `ENVIRONMENT` | production | `production` or `development` |

### Secrets

Set via `wrangler secret put <NAME>`:

| Secret | Description |
|--------|-------------|
| `OPENAI_API_KEY` | OpenAI API key for Whisper + GPT |
| `PODCAST_INDEX_KEY` | Podcast Index API key |
| `PODCAST_INDEX_SECRET` | Podcast Index API secret |

### Cloudflare Access Setup

To protect the submit functionality:

1. Create an Access Application in Cloudflare dashboard
2. Set application domain to your worker URL
3. Add paths: `/submit*`, `/job/*`, `/episode/*/regenerate`
4. Create a policy allowing specific email addresses
5. Choose "One-time PIN" as authentication method

## Summary Templates

| Template | Best For | Output Style |
|----------|----------|--------------|
| **Key Takeaways** | Professional/craft podcasts | Bullet points with actionable insights |
| **Narrative Summary** | Story-driven/interview podcasts | Flowing prose capturing the arc |
| **ELI5** | Technical topics | Simple language with analogies |

## API Endpoints

### Public (no auth)

- `GET /` — Episode list page
- `GET /episode/:id` — Episode detail with summary
- `GET /episode/:id/pdf` — Download PDF
- `GET /api/episodes` — JSON episode list
- `GET /api/episode/:id` — JSON episode detail
- `GET /api/templates` — Available templates

### Authenticated (Cloudflare Access)

- `POST /submit` — Submit new episode
- `POST /episode/:id/regenerate` — Regenerate with different template
- `DELETE /episode/:id` — Delete episode and all data
- `POST /job/:id/retry` — Retry failed job

## Maintenance Mode

To disable HTTP endpoints while keeping queue processing active:

```typescript
// In src/index.ts
const MAINTENANCE_MODE = true;  // Set to true to disable endpoints
```

## License

MIT
