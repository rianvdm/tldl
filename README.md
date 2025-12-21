# TLDL — Too Long Didn't Listen

> AI-powered podcast summaries from Apple Podcasts URLs

## Current Status

✅ **Production Ready** — All core features implemented and tested.

| Component | Status |
|-----------|--------|
| Project scaffolding | ✅ Complete |
| TypeScript types & constants | ✅ Complete |
| KV storage layer | ✅ Complete |
| URL parser + Podcast Index API | ✅ Complete |
| RSS feed parser | ✅ Complete |
| Episode matching (multi-strategy) | ✅ Complete |
| OpenAI Whisper transcription | ✅ Complete |
| Audio chunking (>25MB files) | ✅ Complete |
| GPT summarization | ✅ Complete |
| Public API routes | ✅ Complete |
| Authenticated API routes | ✅ Complete |
| Queue consumer pipeline | ✅ Complete |
| HTML pages (public) | ✅ Complete |
| HTML pages (authenticated) | ✅ Complete |
| PDF generation | ✅ Complete |
| Error handling | ✅ Complete |
| Security & rate limiting | ✅ Complete |
| Integration tests | ✅ Complete |

---

## What is TLDL?

TLDL lets you paste an Apple Podcasts episode URL and get an AI-generated summary. It:

1. **Fetches the transcript** — checks Apple Podcasts, RSS feeds, or falls back to OpenAI Whisper
2. **Generates a summary** — using GPT with customizable templates (key takeaways, narrative, ELI5)
3. **Caches everything** — transcripts and summaries stored for 365 days
4. **Serves publicly** — anyone can read completed summaries; only authenticated users can submit

## Tech Stack

| Component | Technology |
|-----------|------------|
| Runtime | Cloudflare Workers |
| Framework | [Hono](https://hono.dev) |
| Background Jobs | Cloudflare Queues |
| Storage | Cloudflare Workers KV |
| Transcription | OpenAI Whisper API |
| Summarization | OpenAI GPT-5.2 (Responses API) |
| Authentication | Cloudflare Access (Email OTP) |
| PDF Generation | jsPDF |

## Summary Templates

**Key Takeaways & Practical Steps** — For craft and professional development podcasts. Extracts insights, actionable advice, and notable quotes.

**Narrative Summary** — For story-driven and interview podcasts. Captures the arc and themes in flowing prose.

**ELI5** — For technical topics. Explains complex ideas using simple language and analogies.

## Project Structure

```
tldl/
├── src/
│   ├── index.ts              # Hono app entry point
│   ├── routes/               # HTTP route handlers
│   ├── services/             # External API integrations
│   ├── queue/                # Background job processing
│   ├── lib/                  # Shared utilities (KV, errors, etc.)
│   └── types/                # TypeScript type definitions
├── test/                     # Vitest tests
├── wrangler.toml             # Cloudflare Workers config
└── package.json
```

## Development

```bash
# Install dependencies
npm install

# Run tests
npm test

# Start local dev server
npm run dev

# Generate TypeScript types from wrangler.toml
npx wrangler types

# Deploy to Cloudflare
npx wrangler deploy
```

## Configuration

Environment variables are set in `wrangler.toml`:

| Variable | Default | Description |
|----------|---------|-------------|
| `MAX_EPISODE_MINUTES` | 80 | Maximum episode duration to process |
| `CACHE_TTL_DAYS` | 365 | How long to cache transcripts/summaries |
| `DEFAULT_TEMPLATE` | key-takeaways | Default summary template |

Secrets must be set via CLI:

```bash
wrangler secret put OPENAI_API_KEY
```

## License

MIT
