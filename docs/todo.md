# TLDL — Project Checklist

---

## 🚨 Maintenance Mode Toggle

**Current Status**: 🟢 MAINTENANCE MODE DISABLED (endpoints active)

The worker is currently deployed with all endpoints enabled.

### How to Toggle

Maintenance mode is controlled by a single flag at the top of `src/index.ts`:

```typescript
const MAINTENANCE_MODE = false;  // Change to true to disable endpoints
```

### To DISABLE maintenance mode (restore normal operation):
```bash
# 1. Edit src/index.ts and change:
#    const MAINTENANCE_MODE = true;
#    to
#    const MAINTENANCE_MODE = false;

# 2. Deploy
npm run deploy
```

### To ENABLE maintenance mode (disable all HTTP endpoints):
```bash
# 1. Edit src/index.ts and change:
#    const MAINTENANCE_MODE = false;
#    to
#    const MAINTENANCE_MODE = true;

# 2. Deploy
npm run deploy
```

**Note**: 
- Maintenance mode only affects HTTP endpoints. The queue consumer continues processing jobs.
- All your code changes are preserved - just toggle the flag!

---

## Infrastructure Setup

- [ ] Create Cloudflare account/project
- [ ] Create KV namespace (`TLDL_DATA`)
- [ ] Create Queue (`tldl-jobs`)
- [ ] Set up Cloudflare Access application
- [ ] Configure Access policy (allowed emails)
- [ ] Set `OPENAI_API_KEY` secret via `wrangler secret put`
- [ ] (Optional) Custom domain setup

---

## Implementation Prompts

### Foundation
- [x] **Prompt 1**: Project scaffolding, types, constants
- [x] **Prompt 2**: KV storage layer

### External Integrations
- [x] **Prompt 3**: URL parser + iTunes API
- [x] **Prompt 4**: RSS feed parser
- [x] **Podcast Index Integration**: Replace iTunes API with Podcast Index to solve 403 errors (see `docs/podcast-index-integration.md`)


### Core Services
- [x] **Prompt 5**: OpenAI Whisper transcription
- [x] **Prompt 6**: GPT-5.2 summarization

### API Routes
- [x] **Prompt 7**: Public API (read-only)
- [x] **Prompt 8**: Authenticated API (mutations)

### Processing
- [x] **Prompt 9**: Queue consumer pipeline

### UI
- [x] **Prompt 10**: Public HTML pages (list, detail)
- [x] **Prompt 11**: Authenticated HTML pages (submit, status)

### Features & Polish
- [x] **Audio Chunking**: Large file transcription (>25MB) with MP3 frame-aware splitting
- [x] **Prompt 12**: PDF generation (button hidden, route functional)
- [x] **Prompt 13**: Error handling hardening
- [x] **Prompt 14**: Security + rate limiting
- [ ] **Prompt 15**: Integration tests + polish

---

## Key Milestones

- [x] Worker runs locally (`wrangler dev`)
- [x] Submit form accepts URL and creates job
- [x] Queue processes job and updates status
- [x] First episode processed end-to-end (with Whisper)
- [x] Large audio files chunked and transcribed
- [x] Episode displays on public list
- [x] PDF download works
- [x] Full flow works in production

---

## Test Coverage

- [ ] Unit tests passing
- [ ] Integration tests passing
- [ ] Manual test: submit → process → view → download PDF
- [ ] Manual test: regenerate with different template
- [ ] Manual test: delete episode
- [ ] Manual test: retry failed job
- [ ] Mobile responsiveness verified
- [ ] Cloudflare Access login flow tested

---

## Pre-Launch Checklist

- [ ] All tests pass
- [ ] `wrangler.toml` has production KV/Queue IDs
- [ ] Secrets configured in production
- [ ] Cloudflare Access paths correct
- [ ] Error messages user-friendly
- [ ] Rate limiting active
- [ ] Security headers present
- [ ] README updated with setup instructions
- [ ] Deployed via `wrangler deploy`
- [ ] Smoke test in production

---

## Post-Launch

- [ ] Monitor logs for first few real uses (`wrangler tail`)
- [ ] Verify KV TTLs working (content expires after 365 days)
- [ ] Check OpenAI API usage/costs
