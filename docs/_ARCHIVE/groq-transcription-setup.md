# Groq Transcription Setup

TLDL supports two transcription providers: **OpenAI Whisper** (default) and **Groq Whisper**. Switching between them is a single env var change.

## Why Groq?

| | OpenAI Whisper | Groq Whisper |
|---|---|---|
| **Model** | `whisper-1` | `whisper-large-v3-turbo` |
| **Price** | $0.006/min (~$0.36/hr) | $0.04/hr |
| **Free tier** | No | Yes (rate-limited, no CC) |
| **Max file size** | 25 MB | 25 MB (free) / 100 MB (paid) |
| **API compatibility** | OpenAI API | OpenAI-compatible |

Groq is ~9x cheaper than OpenAI for transcription. The free tier is rate-limited but usable for low-volume testing.

## Setup Steps

### 1. Get a Groq API Key

1. Go to [console.groq.com](https://console.groq.com)
2. Sign up (free, no credit card required)
3. Navigate to **API Keys** and create a new key
4. Copy the key (starts with `gsk_`)

### 2. Add the Secret to Cloudflare Workers

```bash
# Production
npx wrangler secret put GROQ_API_KEY
# Paste your Groq API key when prompted

# Local development: add to .dev.vars
echo 'GROQ_API_KEY=gsk_your_key_here' >> .dev.vars
```

### 3. Switch the Provider

In `wrangler.toml`, change `TRANSCRIPTION_PROVIDER`:

```toml
[vars]
TRANSCRIPTION_PROVIDER = "groq"    # was "openai"
```

Or for just local dev:

```toml
[env.dev.vars]
TRANSCRIPTION_PROVIDER = "groq"    # was "openai"
```

### 4. Deploy

```bash
npm run deploy
```

That's it. The queue consumer will now use Groq for all new transcriptions. Existing transcripts in KV are unaffected.

## Switching Back to OpenAI

Change `TRANSCRIPTION_PROVIDER` back to `"openai"` in `wrangler.toml` and deploy. No other changes needed — the `OPENAI_API_KEY` is still set.

## How It Works

The transcription service (`src/services/transcription.ts`) uses a provider config pattern:

- `TRANSCRIPTION_PROVIDER` env var selects the provider (`"openai"` or `"groq"`)
- The queue consumer resolves the correct API key and base URL at transcription time
- Both providers use the same OpenAI-compatible API shape (same form data, same response format)
- The `TranscriptionResult.source` field records which provider was used (`"openai"` or `"groq"`)

Provider configs are defined in `src/services/transcription.ts`:

```
openai → https://api.openai.com/v1/audio/transcriptions  (model: whisper-1)
groq   → https://api.groq.com/openai/v1/audio/transcriptions  (model: whisper-large-v3-turbo)
```

## Groq Free Tier Limits

Groq doesn't publish exact free tier limits publicly — check your [Groq Console → Limits](https://console.groq.com/settings/limits) page after signup. Approximate limits from community sources:

- **File size**: 25 MB max per upload (TLDL already chunks at 25 MB, so this is fine)
- **Requests**: ~20-30 per minute
- **Audio**: ~7,200 audio-seconds per minute of wall-clock time

For TLDL's use case (processing one episode at a time via a queue), these limits are unlikely to be hit.

## Troubleshooting

**"GROQ_API_KEY is not defined"**: You need to set the secret via `wrangler secret put GROQ_API_KEY` (production) or add it to `.dev.vars` (local).

**Groq returns 413 (file too large)**: The free tier has a 25 MB limit. TLDL chunks audio at 25 MB boundaries, but if a single chunk exceeds this, you may need to upgrade to Groq's paid dev tier (100 MB limit).

**Groq returns 429 (rate limited)**: The free tier is rate-limited. TLDL has built-in retry with backoff, but if you're processing many episodes in quick succession, consider upgrading to the Groq dev tier or switching back to OpenAI.
