# Email-First Pivot Plan

*Supersedes: `email-subscriptions-plan.md` (which covered per-podcast subscriptions as an add-on feature)*

## The Pivot

TLDL shifts from a user-submitted podcast summary tool to an **email digest service**. Users subscribe to podcasts from a curated list and receive summaries in their inbox when new episodes drop. The website stays as a public archive and discovery channel.

**What changes:**
* Primary engagement shifts from "visit site, paste URL" to "subscribe, receive emails"
* The submit flow is removed for regular users (admin retains it for adding new podcasts to monitoring)
* Podcast monitoring becomes the core engine, not a background feature
* Postmark handles email delivery

**What stays:**
* The full processing pipeline (RSS parsing, transcription, summarization, tagging)
* Episode pages, podcast pages, tag filtering, RSS feed
* The website as a read-only public archive
* KV storage for episodes, summaries, transcripts

## Why This Is Better

1. **Delivery matches content cadence.** Podcasts are periodic. Email is periodic. Forcing users to remember to visit a site doesn't fit.
2. **One processing cost, N subscribers.** Each episode is transcribed and summarized once. Additional subscribers cost fractions of a cent per Postmark API call.
3. **The hard part is already built.** Monitoring, RSS parsing, episode matching, transcription, summarization — all done. Email delivery is well-solved.
4. **No app, no push permissions, no downloads.** Email just shows up.

## Key Design Decisions

### Daily digest, not per-episode emails
If someone subscribes to 6 podcasts, they shouldn't get 6 separate emails on a busy day. Instead:
* Episodes are processed as they're detected (existing cron, every 8 hours)
* A **daily digest email** is compiled and sent once per day (e.g., 7am UTC)
* The digest contains all new summaries since the last send
* If there's nothing new, no email is sent (don't train users to ignore you)

### Email summaries are shorter than web summaries
Web summaries are 400-600 words. Email summaries should be **150-200 words** — an excerpt with a "Read full summary" link to the episode page on the site. This:
* Keeps emails scannable
* Drives traffic back to the site
* Avoids emails that feel like a wall of text

### Admin-curated podcast list for v1
Users choose from podcasts already being monitored. They can't add arbitrary podcasts. This:
* Avoids building a self-serve podcast addition flow
* Keeps processing costs predictable
* Lets you control quality (only podcasts that work well with the pipeline)

Podcast requests can come in via a simple "request a podcast" form or email — manual for now.

### KV for subscriptions, not D1
The earlier plan used KV with an inverted index (`subscriptions:podcast:{podcastId}` → array of emails). This is sufficient for the expected scale (tens to low hundreds of subscribers). The hot path — "which emails need this episode?" — is a single KV read. Adding D1 introduces migration complexity, SQL debugging, and a new binding for a problem that doesn't require relational queries yet.

**Revisit trigger:** If subscriber count exceeds ~500, or if you need queries like "show me all subscribers who haven't opened an email in 30 days," move to D1.

### Double opt-in
The earlier plan explicitly skipped double opt-in. The debate identified this as a mistake. Double opt-in is required because:
* Postmark's sending reputation depends on clean lists
* CAN-SPAM and GDPR compliance
* Prevents someone from subscribing another person's email
* It's one extra email template, not a major lift

### The submit flow goes away for public users
The current `GET /submit` and `POST /submit` routes are replaced by the subscription flow. The admin retains the ability to add podcasts to monitoring and manually trigger processing from `/profile/podcasts`. No public-facing "paste a URL" form.

## Architecture

### Subscription Flow

```
User visits site → Browses podcasts or home page
  → Clicks "Get email summaries" → Enters email, picks podcasts
  → POST /api/subscribe → Stores pending subscription in KV
  → Confirmation email sent via Postmark (double opt-in)
  → User clicks confirmation link
  → GET /subscribe/confirm?email=...&token=... → Marks subscription active
  → Welcome email sent
```

### Episode Processing + Email Flow

```
Cron (every 8h) → checkAllPodcasts()
  → New episode detected → Queued for processing
  → Queue consumer: transcribe → summarize → tag → store in KV
  → After storing: add to pending digest list in KV

Daily digest cron (new, once per day) → compileDailyDigests()
  → For each podcast with new episodes since last digest:
    → Read subscriptions:podcast:{podcastId} → list of confirmed emails
    → Group episodes by subscriber (a subscriber may follow multiple podcasts)
    → For each subscriber with new content:
      → Build digest email (all their new summaries)
      → Send via Postmark
      → Log to email_log KV key
```

### Unsubscribe Flow

```
Email footer → "Unsubscribe from {podcast}" link
  → GET /unsubscribe?email=...&podcast=...&token=...
  → Verifies HMAC token → Removes subscription → Shows confirmation page

Email footer → "Manage subscriptions" link
  → GET /subscriptions?email=...&token=...&exp=...
  → Magic link (7-day HMAC) → Shows all subscriptions with toggle/remove
```

## KV Schema Changes

### New keys

```
subscriber:{email}
  → { email, podcasts: [{ podcastId, confirmedAt }], status: "pending"|"active", createdAt }
  TTL: none

subscriptions:podcast:{podcastId}
  → string[]  (array of confirmed subscriber emails)
  TTL: none

digest:pending
  → { episodes: [{ episodeId, podcastId, processedAt }] }
  TTL: none (cleared after each digest send)

email:log:{email}:{date}
  → { sentAt, episodeIds: string[], status }
  TTL: 90 days

subscribe:confirm:{token}
  → { email, podcasts: string[] }
  TTL: 24 hours (confirmation link expiry)
```

### Existing keys (unchanged)
* `episode:{episodeId}`, `transcript:{episodeId}`, `summary:{episodeId}:{templateId}` — same as today
* `monitored:*` keys — same as today, but monitoring becomes the primary episode source
* `episodes:index` — same, powers the home page archive

### Keys to remove
* `job:{jobId}` — jobs are still used internally but TTL stays at 1 day; no user-facing job status page
* `waitlist:{email}` — replaced by subscriber system
* `ratelimit:{email}:{hour}` — no longer needed (no user-submitted episodes)

## New Files

### `src/services/email.ts`
Postmark client. Exports:
* `sendConfirmationEmail(env, to, confirmUrl)` — double opt-in
* `sendWelcomeEmail(env, to, podcasts, manageUrl)` — after confirmation
* `sendDigestEmail(env, to, digest)` — daily digest with multiple episode summaries
* `sendMagicLink(env, to, manageUrl)` — for subscription management

Email design:
* Plain text + HTML (Postmark supports both)
* Subject for digest: `TLDL: {n} new summaries` or `TLDL: {episodeTitle}` if only one
* Summary excerpt: ~150-200 words, stripped of markdown, with "Read full summary →" link
* Footer: unsubscribe per-podcast, manage all subscriptions, tldl-pod.com link
* From: `summaries@tldl-pod.com` (or `updates@tldl-pod.com`)

### `src/lib/subscriptions.ts`
Subscription CRUD + HMAC token helpers. Exports:
* `generateConfirmToken(email, podcasts, secret)` / `verifyConfirmToken(...)`
* `generateUnsubToken(email, podcastId, secret)` / `verifyUnsubToken(...)`
* `generateMagicToken(email, secret)` / `verifyMagicToken(...)`
* `createPendingSubscription(kv, email, podcasts)`
* `confirmSubscription(kv, email, podcasts)`
* `unsubscribeFromPodcast(kv, email, podcastId)`
* `unsubscribeFromAll(kv, email)`
* `getSubscriber(kv, email)`
* `getPodcastSubscribers(kv, podcastId)`

### `src/lib/digest.ts`
Daily digest compilation. Exports:
* `addToDigestQueue(kv, episodeId, podcastId)` — called after episode processing
* `compileDailyDigests(env)` — reads pending episodes, groups by subscriber, sends emails
* `clearDigestQueue(kv)` — called after successful digest send

## Route Changes

### New routes

**Public:**
* `GET /subscribe` — signup page: email input, podcast checklist (from monitored list)
* `GET /subscribe/confirm` — confirmation landing page (verifies token, activates subscription)
* `GET /unsubscribe` — single-podcast unsubscribe (verifies token, shows confirmation)
* `GET /subscriptions` — with valid magic link: manage subscriptions; without: "enter email" form

**API:**
* `POST /api/subscribe` — create pending subscription, send confirmation email
* `POST /api/subscriptions/request-link` — send magic link for management
* `POST /api/unsubscribe` — programmatic unsubscribe (for email one-click)

### Modified routes
* `GET /` — home page adds prominent "Get email summaries" CTA
* `GET /podcasts/:id` — podcast page adds "Subscribe to this podcast" email form
* Remove: `GET /submit`, `POST /submit` (public submit form)
* Remove: `GET /waitlist`, `POST /waitlist`
* Remove: `GET /job/:id` (job status page — no public job tracking)

### Admin routes (unchanged)
* `/profile/podcasts` — add/remove monitored podcasts (this becomes the primary way new podcasts enter the system)
* `/profile/*` admin tools — stay as-is

## Wrangler Config Changes

### `wrangler.toml`
```toml
[vars]
POSTMARK_FROM_EMAIL = "summaries@tldl-pod.com"
# Remove TURNSTILE_SITE_KEY if submit form is gone (or keep for subscribe form)
```

### Secrets (via `wrangler secret put`)
* `POSTMARK_API_KEY` — Postmark server API token
* `SUBSCRIPTION_SECRET` — random 32-byte hex for HMAC signing

### Cron triggers
```toml
[triggers]
crons = [
  "0 */8 * * *",   # Existing: check for new episodes every 8 hours
  "0 7 * * *",     # New: send daily digests at 7am UTC
]
```

## Postmark Setup (Manual)

1. Create Postmark account and server
2. Add sender signature for `summaries@tldl-pod.com`
3. Configure SPF, DKIM, DMARC on `tldl-pod.com` domain
4. Use the default `outbound` transactional message stream
5. Store server API token as `POSTMARK_API_KEY` secret

## Implementation Phases

### Phase 1: Subscription infrastructure (backend)
* Add `Subscriber` type to `types/index.ts`, extend `Env` with Postmark bindings
* Build `src/lib/subscriptions.ts` — all CRUD, token generation/verification
* Build `src/services/email.ts` — Postmark client, all email templates
* Add KV helpers for new keys
* Write tests for subscription logic and token verification

### Phase 2: Subscription routes + UI
* Build `/subscribe` signup page
* Build `/subscribe/confirm` confirmation page
* Build `/subscriptions` management page
* Build `/unsubscribe` page
* Add API routes for subscribe, unsubscribe, request-link
* Add "Get email summaries" CTA to home page and podcast pages

### Phase 3: Digest pipeline
* Build `src/lib/digest.ts` — pending queue + compilation logic
* Modify queue consumer: after episode processing, call `addToDigestQueue()`
* Add daily digest cron trigger in `wrangler.toml`
* Wire cron handler in `src/index.ts` to call `compileDailyDigests()` on the new schedule
* Test end-to-end: episode processed → appears in next digest → email sent

### Phase 4: Cleanup + launch
* Remove public submit flow (`GET /submit`, `POST /submit` for unauthenticated users)
* Remove waitlist routes
* Update home page, nav, about page to reflect email-first positioning
* Remove Turnstile if no longer needed (or keep for subscribe form spam protection)
* Update `AGENTS.md` to reflect new architecture
* DNS setup for Postmark (SPF, DKIM, DMARC)
* Deploy secrets, test with your own email first

## Kill Criteria

If fewer than 10 people (outside yourself) confirm their email subscription within 4 weeks of sharing with your network, revert to the current model. The hypothesis is that people want passive podcast summaries in their inbox. If they won't even confirm a double opt-in when you personally share it, the demand isn't there.

## Open Questions

* **Digest timing:** 7am UTC is noon in South Africa, early morning US East Coast. Should this be configurable per user eventually, or is a single global time fine for v1?
* **Podcast request flow:** When a subscriber wants a podcast that's not monitored, what's the UX? A "request a podcast" mailto link? A form? Manual for now is fine, but worth deciding where it lives.
* **Existing episode backfill:** When a new subscriber signs up for a podcast that already has 20 episodes, do they get the latest one in their first digest? Or just future episodes? Suggestion: include the most recent episode as a "here's the latest" in the welcome email.
* **Turnstile on subscribe form:** Low-risk since confirmation email gates activation, but bot-submitted emails still cost a Postmark send. Keep Turnstile on the subscribe form as cheap spam protection.
