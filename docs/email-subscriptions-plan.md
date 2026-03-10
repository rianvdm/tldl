# Email Subscriptions Plan

Podcast-level email subscriptions via Postmark. Anyone can subscribe — no Cloudflare Access required. Subscribers get an email when a new episode of a followed podcast is summarized on tldl.

---

## Goals & Non-Goals

**In scope:**
- Subscribe to a specific podcast by email
- Email notification when that podcast has a new episode summarized
- Subscriber self-service management page (view/remove subscriptions)
- One-click unsubscribe from email
- Welcome email on first subscribe

**Out of scope (for now):**
- Tag-based subscriptions (AI tags are too inconsistent)
- Double opt-in / email verification
- Admin subscriber management UI
- Digest mode (daily/weekly rollup instead of per-episode)

---

## Architecture Overview

### Trigger point

The queue consumer (`src/queue/consumer.ts`) already runs the full pipeline. After a new episode is saved and indexed (end of `processEpisode`), call `notifySubscribers(env, episode, summary)` before marking the job completed. This is non-critical — errors are caught and logged but don't fail the job.

Only fires for **new** episodes. The `processEpisode` function already checks `if (!existingEpisode)` before saving — we send notifications inside that same block.

The `regenerateSummary` path does **not** send notifications (no new episode, just a different template).

### Email delivery

Postmark transactional API. Single API call per subscriber (no batching needed at this scale). Called directly from the Worker — no additional queue.

### Subscriber management auth

**Magic link approach** — stateless HMAC tokens. No database sessions.

Token = `HMAC-SHA256(email + ":" + expiryTimestamp, SUBSCRIPTION_SECRET)`, base64url-encoded. Passed as `?email=...&token=...&exp=...` in the URL. Valid for 7 days.

For per-subscription unsubscribe links in emails: `HMAC-SHA256(email + ":" + podcastId, SUBSCRIPTION_SECRET)` with no expiry. Permanent until the subscription is removed.

---

## KV Schema

New keys (all in existing `TLDL_DATA` namespace):

```
subscriber:{email}
  → { email, podcasts: string[], createdAt: string }
  TTL: none (permanent)

subscriptions:podcast:{podcastId}
  → string[]  (array of subscriber emails)
  TTL: none (permanent)
```

The `subscriptions:podcast:{podcastId}` inverted index is the hot path — when an episode completes, one read gives all emails to notify. No full-table scan needed.

No separate `subscribers:list` index for now — not needed unless we add admin tooling later.

### KV key additions to `KV_KEYS` in `kv.ts`:
```ts
subscriber: (email: string) => `subscriber:${email}`,
podcastSubscribers: (podcastId: string) => `subscriptions:podcast:${podcastId}`,
```

---

## New Types

Add to `src/types/index.ts`:

```ts
/**
 * Email subscriber record
 * Stored in KV with key: subscriber:{email}
 */
export interface Subscriber {
    email: string;
    podcasts: string[];   // podcast IDs subscribed to
    createdAt: string;    // ISO timestamp
}
```

Add to `Env` interface:
```ts
POSTMARK_API_KEY: string;       // secret
POSTMARK_FROM_EMAIL: string;    // var, e.g. "updates@tldl-pod.com"
SUBSCRIPTION_SECRET: string;    // secret, for HMAC signing
```

---

## New Files

### `src/services/email.ts`

Postmark client + email templates. Exports:

```ts
// Send new episode notification to a single subscriber
sendEpisodeNotification(env: Env, opts: {
    to: string;
    podcastName: string;
    podcastId: string;
    episodeTitle: string;
    episodeDate: string;
    episodeDuration: number;
    episodeId: string;
    summaryExcerpt: string;  // first ~400 chars of summary
}): Promise<void>

// Send welcome email when user first subscribes to anything
sendWelcomeEmail(env: Env, opts: {
    to: string;
    podcastName: string;
    manageUrl: string;
}): Promise<void>

// Send magic link for subscription management
sendMagicLink(env: Env, opts: {
    to: string;
    magicUrl: string;
}): Promise<void>
```

Email format for episode notifications:
- **Subject**: `New summary: {episodeTitle} — {podcastName}`
- **Body**: Plain text + HTML. Episode title, date, duration, summary excerpt (~400 chars), "Read full summary →" link, footer with unsubscribe link and manage-all link.
- Postmark `MessageStream`: `outbound` (default transactional stream)

### `src/lib/subscriptions.ts`

Subscription CRUD + token helpers. Exports:

```ts
// Token generation & verification
generateMagicToken(email: string, secret: string): { token: string, exp: number }
verifyMagicToken(email: string, token: string, exp: number, secret: string): boolean

generateUnsubToken(email: string, podcastId: string, secret: string): string
verifyUnsubToken(email: string, podcastId: string, token: string, secret: string): boolean

// Subscription management (call these from routes + kv helpers)
subscribeToPocast(kv, email, podcastId, podcastName): Promise<{ isNew: boolean }>
unsubscribeFromPodcast(kv, email, podcastId): Promise<void>
unsubscribeFromAll(kv, email): Promise<void>
getSubscriber(kv, email): Promise<Subscriber | null>
getPodcastSubscribers(kv, podcastId): Promise<string[]>  // returns emails

// Notify all subscribers for a newly completed episode
notifySubscribers(env, episode, summary): Promise<void>
```

`notifySubscribers` implementation:
1. `extractPodcastId(episode.id)` to get the podcast ID
2. Read `subscriptions:podcast:{podcastId}` from KV → list of emails
3. If empty, return early (no-op)
4. Build summary excerpt (strip markdown, truncate to ~400 chars)
5. For each email, call `sendEpisodeNotification()` — fire and forget with error logging per subscriber, don't abort on individual failure
6. Log aggregate result

---

## Route Changes

### `src/routes/api.ts` — new endpoints

**`POST /api/subscribe/podcast`**
- Body: `{ email, podcastId, podcastName }`
- Validates email format (reuse `isValidEmail` from `turnstile.ts`)
- Validates podcastId is non-empty alphanumeric
- Calls `subscribeToPocast(kv, email, podcastId, podcastName)`
- If `isNew` (first subscription ever): sends welcome email with manage link
- Returns `{ ok: true }`
- No Turnstile required here (low abuse risk, email is self-limiting)

**`POST /api/unsubscribe/podcast`**
- Body: `{ email, podcastId, token }`
- Verifies unsubToken with `verifyUnsubToken`
- Calls `unsubscribeFromPodcast(kv, email, podcastId)`
- Returns `{ ok: true }`

**`POST /api/unsubscribe/all`**
- Body: `{ email, token }`
- Verifies token (can use same unsubToken mechanism with `podcastId = "all"`)
- Calls `unsubscribeFromAll(kv, email)`
- Returns `{ ok: true }`

**`POST /api/subscriptions/request-link`**
- Body: `{ email }`
- Generates magic link, sends it via Postmark
- Always returns `{ ok: true }` (don't reveal if email exists)

### `src/routes/public.ts` — new pages + UI additions

**`GET /subscriptions`**
- If `?email=&token=&exp=` present and valid: show management page (list of subscribed podcasts with unsubscribe buttons, "unsubscribe from all" option)
- If no token: show "Enter your email to manage subscriptions" form
- On form submit: `POST /api/subscriptions/request-link` → show "Check your email" message

**Podcast page additions**
- On the podcast detail page (which lists episodes), add a subscribe section below the header
- Simple form: email input + "Notify me of new summaries" button
- On success: show confirmation message ("You're subscribed! Check your inbox for a welcome email.")
- On already-subscribed (detect via API response): show "You're already subscribed"
- The podcast page already knows `podcastId` and `podcastName`, so these are pre-filled hidden fields

---

## Queue Consumer Changes (`src/queue/consumer.ts`)

Inside `processEpisode`, in the `if (!existingEpisode)` block, after `addToEpisodeIndex`:

```ts
// Notify email subscribers (non-critical)
try {
    const { notifySubscribers } = await import("../lib/subscriptions");
    await notifySubscribers(env, episode, summary);
} catch (error) {
    console.error(JSON.stringify({
        event: "notify_subscribers_failed",
        episodeId,
        error: error instanceof Error ? error.message : "Unknown error",
    }));
    // Don't re-throw — job still succeeds
}
```

---

## Config Changes

### `wrangler.toml`
Add to `[vars]`:
```toml
POSTMARK_FROM_EMAIL = "updates@tldl-pod.com"
```

Add secrets (via `wrangler secret put`):
- `POSTMARK_API_KEY`
- `SUBSCRIPTION_SECRET`

### `src/types/index.ts`
Add `Subscriber` type and env vars as described above.

---

## Unsubscribe Link Design

Every notification email footer contains:
1. **"Unsubscribe from {podcastName}"** — one-click, hits `POST /api/unsubscribe/podcast` via a small HTML form (works without JS), includes pre-signed token in a hidden field
2. **"Manage all subscriptions"** — links to `/subscriptions?email=...&token=...&exp=...` (magic link, 7-day validity)

The "unsubscribe from podcast" link uses a permanent per-subscription token (HMAC of email+podcastId). No expiry is needed since removing a subscription is always safe.

---

## Postmark Setup (manual steps before deploy)

1. Add a sender signature for `updates@tldl-pod.com` (or whatever from address) in Postmark dashboard
2. Set up SPF/DKIM for `tldl-pod.com` in Postmark (if not already done)
3. Use the default `outbound` transactional message stream
4. Run `wrangler secret put POSTMARK_API_KEY` with the server API token
5. Run `wrangler secret put SUBSCRIPTION_SECRET` with a random 32-byte hex string

---

## Implementation Order

1. **Types** — add `Subscriber`, extend `Env` in `types/index.ts`
2. **KV helpers** — add subscription keys to `KV_KEYS`, add CRUD functions to `kv.ts`
3. **`src/lib/subscriptions.ts`** — token logic + KV helpers + `notifySubscribers`
4. **`src/services/email.ts`** — Postmark client + all email templates
5. **API routes** — subscribe, unsubscribe, request-link endpoints in `api.ts`
6. **Public routes** — `/subscriptions` management page + podcast page subscribe form in `public.ts`
7. **Queue consumer** — add `notifySubscribers` call in `processEpisode`
8. **Config** — `wrangler.toml` vars, secrets

---

## Open Questions

- **From address**: `updates@tldl-pod.com`? Need to confirm domain is configured in Postmark.
- **Summary excerpt length**: 400 chars feels right. Could be longer. Should we strip markdown before excerpting? Yes.
- **Rate limiting subscribe endpoint**: Low risk since each subscription goes to the subscriber's own inbox. Could add basic IP rate limiting if abuse becomes a problem.
- **Monitoring existing auto-processed podcasts**: The podcast monitor (`src/lib/monitor.ts`) already processes new episodes automatically. The queue consumer change will catch those too — subscriptions work regardless of whether a human or the monitor triggered the processing.
