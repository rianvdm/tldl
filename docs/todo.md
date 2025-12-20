# TLDL — Project Checklist

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


### Core Services
- [x] **Prompt 5**: OpenAI Whisper transcription
- [x] **Prompt 6**: GPT-5.2 summarization

### API Routes
- [x] **Prompt 7**: Public API (read-only)
- [ ] **Prompt 8**: Authenticated API (mutations)

### Processing
- [ ] **Prompt 9**: Queue consumer pipeline

### UI
- [ ] **Prompt 10**: Public HTML pages (list, detail)
- [ ] **Prompt 11**: Authenticated HTML pages (submit, status)

### Features & Polish
- [ ] **Prompt 12**: PDF generation
- [ ] **Prompt 13**: Error handling hardening
- [ ] **Prompt 14**: Security + rate limiting
- [ ] **Prompt 15**: Integration tests + polish

---

## Key Milestones

- [ ] Worker runs locally (`wrangler dev`)
- [ ] Submit form accepts URL and creates job
- [ ] Queue processes job and updates status
- [ ] First episode processed end-to-end (with Whisper)
- [ ] Episode displays on public list
- [ ] PDF download works
- [ ] Full flow works in production

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
