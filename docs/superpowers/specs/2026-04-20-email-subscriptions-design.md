# Email subscriptions — design

**Date:** 2026-04-20
**Status:** Approved; implementation plan next.

## Problem

Today, anyone who wants to follow a monitored podcast has to poll the site or the RSS feed. There's no push channel for "a new summary was just published for a show you care about." The site is admin-curated, so we can't use a standard "create an account and subscribe" flow without adding account infrastructure that doesn't exist (no users table, no auth). We need a low-friction way to let visitors opt in to per-podcast email alerts that doesn't drag an account system in behind it.

## Summary

Per-podcast email subscriptions, account-free. A visitor enters an email, confirms via signed link, and gets one email per newly summarised episode on their chosen podcasts. All management flows (preferences, unsubscribe) use HMAC-signed URLs delivered by email. The feature reuses the existing Worker, adds one D1 database, and leans on Postmark for delivery and bounce/complaint handling.

## Goals

- Per-episode, transactional-feel emails (subject `{{podcastName}}: {{episodeTitle}}`).
- Entire subscriber lifecycle runs through signed email links. No login, no stored session.
- Clean deliverability: separate Postmark streams for transactional and broadcast traffic. Bounces and spam complaints are processed automatically.
- One-click per-podcast unsubscribe from the email footer, plus mailbox-provider `List-Unsubscribe` / `List-Unsubscribe-Post` headers for RFC 8058 one-click.
- Implementation fits inside the existing Worker. One new D1 binding; no new services.

## Non-goals (v1)

- Admin-submitted episodes do not trigger emails. Only the monitoring path.
- No digest mode (daily or weekly). Per-episode only.
- No read or click tracking. Postmark open tracking off by default.
- No batched Postmark send. One API call per recipient at v1 volumes.
- No subscriber admin UI. Direct D1 queries when needed.
- No in-repo source of truth for email HTML. Postmark-hosted templates are canonical; optional `docs/email-templates/` snapshots are advisory only.

## Trigger point

In `src/queue/consumer.ts` there are two places where an episode is persisted via `saveEpisode` + `addToEpisodeIndex` (lines 544/547 and 709/712). After each successful pair, call:

```ts
await notifySubscribers(env, { podcastId, episode });
```

The monitoring-vs-admin gate reuses the signal already in the codebase: monitor-driven submissions set `submittedBy = "monitor@tldl.app"` (`src/lib/monitor.ts:704,762`), admin submissions set it to the authenticated user email (`src/routes/admin.ts:1332`). The dispatcher is a no-op unless `episode.submittedBy === "monitor@tldl.app"` AND at least one confirmed active subscriber exists for `podcastId`. Any failure inside the dispatcher is logged and swallowed. Email is a best-effort side channel and must not block episode persistence.

## Data model — Cloudflare D1

New D1 database bound as `DB`. Three tables:

```sql
CREATE TABLE subscribers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    confirmed_at INTEGER,            -- unix seconds; NULL until first confirm
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,     -- bumped on status/confirm changes
    status TEXT NOT NULL DEFAULT 'active'  -- active | bounced | complained
);

CREATE TABLE subscriptions (
    subscriber_id INTEGER NOT NULL REFERENCES subscribers(id) ON DELETE CASCADE,
    podcast_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (subscriber_id, podcast_id)
);
CREATE INDEX idx_subscriptions_podcast ON subscriptions(podcast_id);

CREATE TABLE pending_confirmations (
    token TEXT PRIMARY KEY,          -- crypto.getRandomValues, 32 bytes hex
    email TEXT NOT NULL,
    podcast_ids TEXT NOT NULL,       -- JSON array
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL      -- created_at + 48h
);
CREATE INDEX idx_pending_email ON pending_confirmations(email);  -- for per-email throttle
```

Notes:

- `subscribers.email` is `COLLATE NOCASE`, so `Foo@bar.com` and `foo@bar.com` collapse to the same row.
- D1 enforces `ON DELETE CASCADE` by default (foreign keys on), so removing a subscriber wipes their subscriptions.
- `pending_confirmations` holds unverified signup intent. On confirmation, the row is deleted and the subscriber is upserted.
- Manage and unsubscribe URLs use **HMAC-signed tokens**, not stored tokens. They are stateless and don't expire; rotating `MANAGE_LINK_HMAC_SECRET` revokes all outstanding links at once (see "Secret rotation" below).
- `updated_at` gives us a minimal audit trail for status transitions without adding a separate audit table.

### Status transitions

```
active   -> bounced     (hard bounce via Postmark webhook)
active   -> complained  (spam complaint or SubscriptionChange webhook)
bounced  -> active      (user successfully re-confirms after POST /subscribe)
complained -> [blocked] (POST /subscribe refuses to send a new confirmation)
```

`POST /subscribe` logic:

1. If an existing subscriber row exists with `status = 'complained'`, return the standard "check your inbox" response but send no email. Complained addresses are a hard stop; we never email them again unless an operator manually flips `status` in D1.
2. If status is `bounced`, allow the flow — a successful re-confirm flips status back to `active` and clears the bounce.
3. If status is `active` or no row exists, create a `pending_confirmations` row and send the confirmation email.

This gate is the whole point of honoring complaints; the earlier version of this spec asserted a re-subscribe check without designing it, which would have re-spammed complained addresses.

## HTTP routes

All on the existing Worker under `src/routes/`.

| Method + path | Purpose |
|---|---|
| `GET /subscribe` | Form. Email input + checkbox list of monitored podcasts (read from `monitored:list` + per-podcast `monitored:{podcastId}` KV entries via `getMonitoredPodcastIds`). Cloudflare Turnstile widget. |
| `POST /subscribe` | Accepts `{ email, podcastIds[], turnstileToken }`. Validates, applies per-email throttle (see below), checks subscriber status, creates `pending_confirmations` row, sends confirm email via `outbound` stream. Always returns 200 "check your inbox". Never leaks email existence or status. |
| `GET /confirm?token=...` | Looks up pending row, upserts `subscribers` (sets `confirmed_at`, flips `bounced` back to `active` if applicable), writes `subscriptions` rows, deletes pending row, renders success page with inline manage link. Expired or unknown tokens render a generic error page that includes a "Subscribe again" link back to `/subscribe`. |
| `GET /preferences` | Same form as `/subscribe` but a single email input. Submitting always returns "check your inbox". If a confirmed subscriber exists, send a manage-link email. If not, treat as a new signup (confirmation email). The response is identical whether the address exists or not, so the endpoint cannot be used for enumeration. |
| `GET /preferences/manage?token=...&s=...` | Manage-link landing. Verifies HMAC over `(subscriber_id, email)`. Renders preferences UI pre-populated with current subscriptions, with "Unsubscribe from all" button. |
| `POST /preferences/manage` | Accepts signed token + updated `podcastIds[]`. Diffs and updates `subscriptions` rows. |
| `GET /unsubscribe?token=...&s=<id>&p=<podcastId>` | One-click (GET). HMAC token covers `(subscriber_id, podcast_id)`. Deletes matching `subscriptions` row. Idempotent. Renders "Done" page with link to `/preferences`. If `p` is omitted, the token is verified against the `unsuball|${subscriberId}` message instead, and all subscriptions for that subscriber are deleted. The handler checks which token shape is present (has `p` -> `unsub`; no `p` -> `unsuball`) and verifies the corresponding HMAC. |
| `POST /unsubscribe` | Same body/query parameters as GET. Required by RFC 8058 for mailbox-provider one-click unsubscribe triggered by the `List-Unsubscribe-Post` header. Returns 200 with no body on success. |
| `POST /webhooks/postmark` | Postmark bounce / complaint / subscription-change webhook. Verifies basic-auth credentials (see Webhook handling). Updates `subscribers.status` and cascades subscription deletion. Idempotent. |

### Token scheme

- **Algorithm:** HMAC-SHA-256, hex-encoded, first 32 chars truncated.
- **Secret:** `MANAGE_LINK_HMAC_SECRET` (32 random bytes, stored as a Worker secret).
- **Message formats:**
  - Manage link: `manage|${subscriberId}|${emailLowercase}`
  - Per-podcast unsub: `unsub|${subscriberId}|${podcastId}`
  - Unsub all: `unsuball|${subscriberId}`
- **No expiry.** Links remain valid until the subscriber record changes or the secret rotates. The two capabilities these tokens grant (unsubscribe, read own preferences) are low-value, so indefinite TTL is acceptable.
- **Verification:** compare via constant-time string equality using a pure-JS XOR accumulator. `crypto.subtle.timingSafeEqual` is a Cloudflare Workers extension (not part of Web Crypto), so code that calls it works under `wrangler deploy` but fails under Vitest when tests run outside the Workers pool. Pure-JS keeps the helper testable in both environments without pulling in `node:crypto` or the `nodejs_compat` flag.

### Secret rotation

Rotating `MANAGE_LINK_HMAC_SECRET` immediately invalidates every outstanding manage-, unsubscribe-, and `List-Unsubscribe`-header URL in every previously sent email. Mailbox providers cache `List-Unsubscribe` URLs, so cached one-click unsubscribes will start failing silently.

For v1, rotation is an **emergency-only** operation. If a rotation is ever required, follow this sequence:

1. Set a new secondary secret `MANAGE_LINK_HMAC_SECRET_NEXT` alongside the existing one.
2. Verification accepts tokens signed by either secret during the grace period.
3. Dispatch signs new emails with `MANAGE_LINK_HMAC_SECRET_NEXT`.
4. After 30 days (or one episode cycle per monitored podcast, whichever is longer), promote `_NEXT` to the primary and remove the old secret.

The dual-secret verify helper is a v1.1 follow-up; v1 ships with single-secret verify and a documented operational runbook.

### Anti-abuse (v1, light)

- Cloudflare Turnstile on `GET /subscribe` form; `POST /subscribe` rejects if token missing or invalid.
- **Per-IP rate limit:** Cloudflare zone rate-limit rule on `POST /subscribe` and `POST /preferences/manage` at 10 requests/min per IP. Configured in the dashboard, not in code. Note: matching on HTTP method requires Business plan or higher; if the site is on Pro, match on path only (`/subscribe` plus `/preferences/manage`) and accept that GET traffic counts toward the limit. Free plan is not viable (1-rule cap, 10-second counting period).
- **Per-email throttle:** `POST /subscribe` refuses to create a new `pending_confirmations` row for an email that already has a non-expired pending row. This prevents email-bombing a victim by rotating IPs. Implemented as a single D1 query: `SELECT 1 FROM pending_confirmations WHERE email = ? AND expires_at > ? LIMIT 1` before insert. If found, still return the generic "check your inbox" response.
- `pending_confirmations` sweep inside the existing scheduled handler (`src/index.ts::scheduledHandler`, cron `0 */2 * * *` in `wrangler.toml:47`): `DELETE FROM pending_confirmations WHERE expires_at < strftime('%s','now')`.

## Email delivery

### Postmark streams

- **`tldl`** (existing transactional stream, already used by the contact form via `POSTMARK_MESSAGE_STREAM` in `wrangler.toml:14`) — `confirm-subscription` and `manage-link` emails. Time-sensitive 1:1. Isolated from other tldl-Postmark-server projects (Elezea, Protea, Marketing). No separate "welcome" email is sent: the `/confirm` success page itself is the welcome surface, with a "Manage preferences" link inline.
- **`episode-summaries`** (new broadcast stream — must be created in Postmark before rollout) — per-episode summaries. Broadcast reputation; Postmark auto-adds `List-Unsubscribe` + `List-Unsubscribe-Post: List-Unsubscribe=One-Click` headers on broadcast streams by default, but the prerequisites checklist verifies this is enabled on the specific stream before shipping.

The transactional stream is read from `env.POSTMARK_MESSAGE_STREAM` (already a `[vars]` entry); the broadcast stream is a module-level constant `"episode-summaries"` in `notifications.ts` since it has no reason to be per-environment configurable.

### Sending domain

**Prerequisite:** verify `tldl-pod.com` as a sending domain in Postmark before rollout. Requires publishing DKIM CNAME and a custom Return-Path CNAME in DNS. Verify in Postmark's Sender Signatures section before shipping.

### Templates (Postmark-hosted aliases)

All three stored in Postmark, referenced by alias. The repo stores only the alias constants and their TypeScript model types.

1. **`confirm-subscription`** (transactional)
   - Subject: `Confirm your tldl subscription`
   - Model: `{ confirmUrl: string, podcastList: string, expiresIn: string }`
   - Body copy (advisory): "You asked to subscribe to tldl summaries for: {{podcastList}}. Click to confirm: {{confirmUrl}}. The link expires in {{expiresIn}}. If this wasn't you, ignore this email. No account was created."

2. **`manage-link`** (transactional)
   - Subject: `Manage your tldl preferences`
   - Model: `{ manageUrl: string }`
   - Body: "Use this link to change your podcast subscriptions or unsubscribe: {{manageUrl}}."

3. **`episode-summary`** (broadcast)
   - Subject: `{{podcastName}}: {{episodeTitle}}`
   - Model:
     ```ts
     {
         podcastName: string;
         podcastCoverUrl: string;     // from MonitoredPodcast.coverUrl; dispatcher substitutes a tldl-hosted placeholder if missing
         podcastWebsiteUrl?: string;  // from RSS <link> / PI, same field podcast page uses; omitted from template if absent
         episodeTitle: string;
         episodeDate: string;         // formatted in the dispatcher as "Mon D, YYYY" in UTC via Intl.DateTimeFormat('en-US', { timeZone: 'UTC' })
         summaryHtml: string;         // sanitised HTML (see "Summary rendering" below)
         episodeUrl: string;          // canonical tldl page: https://tldl-pod.com/episode/{id}
         unsubscribePodcastUrl: string;  // per-podcast footer link to GET /unsubscribe
         manageUrl: string;              // footer link to GET /preferences/manage
         // The `List-Unsubscribe` header URL is injected by Postmark's broadcast
         // stream and points to Postmark's hosted suppression page, not a tldl route.
         // Incoming unsubscribes from that header arrive via the SubscriptionChange webhook.
     }
     ```
   - Body structure:
     1. Header: podcast cover + name + episode title + date.
     2. Meta row, two links:
        - "Read full summary on tldl" -> `episodeUrl`
        - "Visit {{podcastName}} website" -> `podcastWebsiteUrl` (template omits the row entirely if the field is missing)
     3. Summary body (sanitised HTML from `summaryHtml`).
     4. Footer: "Unsubscribe from {{podcastName}}" and "Manage all preferences".

### Summary rendering

`summaryHtml` must be rendered through the same sanitising path the site uses, not a fresh `marked.parse()`. `src/routes/public.ts::renderMarkdown` (line 109) installs a custom `marked` renderer that strips raw HTML passthrough and rejects `javascript:` links; this was added in [2026-03-15-marked-xss-fix-design.md](./2026-03-15-marked-xss-fix-design.md) to close two confirmed XSS vectors. Email has no CSP, so an unsanitised path here would be strictly worse than the site.

Implementation: extract `renderMarkdown` into `src/lib/markdown.ts` so both `public.ts` and `notifications.ts` can import it. The function at `src/routes/public.ts:109` is a three-line wrapper around `marked.parse`, so extraction is mechanical.

### Dispatch loop

Inside `notifySubscribers`:

```
// 1. Verify the podcast is still monitored. If not, skip (subscriptions are orphans).
podcast = await getMonitoredPodcast(kv, podcastId)
if (!podcast) { log and return; }

// 2. Pull active confirmed subscribers.
rows = SELECT s.id, s.email FROM subscribers s
       JOIN subscriptions sub ON sub.subscriber_id = s.id
       WHERE sub.podcast_id = ?
         AND s.status = 'active'
         AND s.confirmed_at IS NOT NULL;

// 3. Render the summary once, reuse across recipients.
summaryHtml = renderMarkdown(episode.summaryText)

// 4. Send.
for each row:
    manageUrl = buildManageUrl(row.id, row.email)
    unsubscribePodcastUrl = buildUnsubUrl(row.id, podcastId)
    POST https://api.postmarkapp.com/email/withTemplate
      MessageStream: 'episode-summaries'
      TemplateAlias: 'episode-summary'
      TemplateModel: { ...episodeFields, manageUrl, unsubscribePodcastUrl }

// All sends via Promise.allSettled; log per-recipient success/failure.
```

Bounce/complaint filtering happens at query time (`status = 'active'`), so a webhook-driven status flip between webhook delivery and the next dispatch cannot cause a send to a known-bad address.

### Postmark failure policy

- **Per-recipient failures** (non-2xx response, timeout, network error): logged with `recipient_id`, `episode_id`, `podcast_id`, HTTP status, and error message. Not retried. The next episode for the same podcast is a fresh opportunity. This is an explicit v1 trade-off: retry machinery is out of scope.
- **Postmark outage / rate-limit (429, 5xx) across all recipients**: the dispatcher still uses `Promise.allSettled`, so a storm of failures doesn't throw. The calling path in `consumer.ts` swallows errors regardless, so episode persistence is unaffected. Failed dispatches are visible in the activity log and via `wrangler tail`.
- **No dead-letter queue in v1.** If we hit systemic Postmark failures, the recovery path is operator-initiated: triage in Postmark dashboard, then optionally replay by re-running the queue consumer for affected episodes (manual, rare).

## Webhook handling

**`POST /webhooks/postmark`** authenticates via HTTP basic auth. Postmark does not provide a separate credential field in its webhook UI; the credentials are embedded in the configured webhook URL (`https://user:pass@tldl-pod.com/webhooks/postmark`), and Postmark sends them in the `Authorization: Basic ...` header. The Worker compares the incoming header against `POSTMARK_WEBHOOK_AUTH` (stored as a Worker secret in the form `user:pass`).

Event handling:

| Event | `Type` | Action |
|---|---|---|
| `Bounce` | `HardBounce` | `UPDATE subscribers SET status='bounced', updated_at=? WHERE email=?`; `DELETE FROM subscriptions WHERE subscriber_id=?`. |
| `Bounce` | other (soft, transient) | Ignore. Postmark retries. |
| `SpamComplaint` | — | `status='complained'`, delete subscriptions. |
| `SubscriptionChange` (from `List-Unsubscribe`) | `SuppressSending=true` | Treat as unsubscribe-all: delete subscriptions. Keep the subscriber row with `status='complained'` so `POST /subscribe` will refuse new confirmation emails to that address. |

All handlers are idempotent (the `UPDATE` and `DELETE` statements are safe to replay), so Postmark retries don't cause state drift.

## Module layout

```
src/
    lib/
        db.ts                # D1 schema + all subscriber queries
        emailTokens.ts       # HMAC sign/verify, constant-time compare
        markdown.ts          # renderMarkdown extracted from routes/public.ts
    services/
        postmark.ts          # existing; extended with sendTemplate()
    routes/
        subscriptions.ts     # /subscribe, /confirm, /preferences,
                             # /preferences/manage, /unsubscribe (GET + POST)
        webhooks.ts          # /webhooks/postmark
    queue/
        consumer.ts          # 2 call sites added
    notifications.ts         # notifySubscribers()
```

Shared modules live under `src/lib/` per the existing convention (`src/lib/kv.ts`, `src/lib/audio.ts` etc.).

Net: 6 new files, 3 modifications (`postmark.ts`, `consumer.ts`, and `public.ts` to import the extracted `renderMarkdown`).

## Testing strategy

**Unit (Vitest):**

- `lib/emailTokens.ts` — sign/verify round-trip, wrong secret, tampering, constant-time compare.
- `lib/db.ts` query helpers against in-memory D1 — upsert, confirm, listByPodcast, unsubscribePodcast, markBounced, per-email pending-throttle query.
- `services/postmark.ts` — `sendTemplate` with `fetch` mocked; success, error, non-OK.
- `lib/markdown.ts` — sanitization round-trip (HTML strip, javascript: link rejection), to prevent regressions against the XSS fix.

**Route-level (`@cloudflare/vitest-pool-workers`):**

- `POST /subscribe` — validates Turnstile; rate-limit path (Turnstile failure); per-email throttle (second submit within window is silently deduped); status gate for `complained` (no email sent, same 200 response); returns 200 regardless of email existence.
- `GET /confirm?token=...` — happy path, expired token, unknown token, `bounced -> active` transition on re-confirm.
- `/preferences` happy paths for both existing-subscriber and new-email branches.
- `/preferences/manage` GET (load) and POST (diff apply).
- `/unsubscribe` — per-podcast and unsubscribe-all via GET; same via POST (RFC 8058); idempotence (second call is 200 no-op); token-shape discrimination (GET with `p` verifies `unsub|...`; GET without `p` verifies `unsuball|...`).
- `/webhooks/postmark` — hard bounce, spam complaint, subscription change, invalid auth, unknown event (ignored), **duplicate event delivery** (second identical webhook leaves state unchanged).

**Queue-level:**

- `consumer.ts` after `saveEpisode` + `addToEpisodeIndex` — mock `notifySubscribers` and assert it's called with the correct `(podcastId, episode, source)` at **both** call sites (544/547 and 709/712). Regression guard against forgetting one branch.
- `notifySubscribers` with `source === 'admin'` — asserts no Postmark calls.
- `notifySubscribers` with a `podcastId` that no longer has a `MonitoredPodcast` record — asserts no Postmark calls (orphan-podcast guard).

**Integration smoke (manual post-deploy):**

- Subscribe with a real address, confirm, force a monitor check on a canary podcast, verify the email renders in Gmail web, Apple Mail, and Outlook web.
- Trigger a hard bounce via Postmark's `bounce-testing@postmarkapp.com` test address and confirm `status='bounced'` in D1.
- Trigger one-click unsubscribe from Gmail's "Unsubscribe" link in the message header; confirm the subscription row is gone.

## Prerequisites (operator checklist, before rollout)

1. Verify `tldl-pod.com` as a sending domain in Postmark (DKIM + Return-Path DNS).
2. Create new Postmark broadcast stream `episode-summaries`. In the stream settings, confirm "List-Unsubscribe header" auto-injection is enabled (it is by default on broadcast streams, but verify).
3. Create three Postmark templates (`confirm-subscription`, `manage-link`, `episode-summary`) with the models above.
4. `wrangler d1 create tldl-subscribers`, then apply `schema.sql` to local + `--remote`.
5. **Add the D1 binding to `wrangler.toml`** (`[[d1_databases]]` block with `binding = "DB"`, `database_name = "tldl-subscribers"`, `database_id = "<from step 4>"`).
6. Run `npx wrangler types` to regenerate `worker-configuration.d.ts` so the `Env` type includes `DB` and the new secrets. Without this, TypeScript won't compile.
7. Set Worker secrets: `MANAGE_LINK_HMAC_SECRET` (32 random bytes), `POSTMARK_WEBHOOK_AUTH` (format `user:pass`). `TURNSTILE_SECRET` already exists in the repo (`src/types/index.ts:181`); reuse it. `TURNSTILE_SITE_KEY` is a `[vars]` entry in `wrangler.toml:11` (not a secret) — leave it there. Confirm `POSTMARK_API_KEY` has access to the new stream (may need a stream-enabled server token).
8. Configure Postmark webhook to `POST https://user:pass@tldl-pod.com/webhooks/postmark` for Bounce, SpamComplaint, and SubscriptionChange events. Credentials embedded in the URL; Postmark sends them as `Authorization: Basic`. `user` and `pass` must match `POSTMARK_WEBHOOK_AUTH`.
9. Add zone rate-limit rules in Cloudflare dashboard for `/subscribe` and `/preferences/manage`. If on Pro plan, match on path only (Method field requires Business).

## Rollout

1. **Ship dark.** Deploy the code with the D1 binding and all routes live but no link to `/subscribe` from anywhere on the site. Verify routes respond correctly via direct hits.
2. **Canary subscribe.** Subscribe a personal test address to one monitored podcast. Wait for the next scheduled monitor run to trigger a real episode. Verify the email lands in Gmail, Apple Mail, and Outlook web.
3. **Soft launch.** Add a "Subscribe to email" CTA on the podcast page and home page. Watch the activity log and `wrangler tail` for dispatch errors for 48 hours.
4. **Confirm webhook path.** Force a hard bounce (Postmark's `bounce-testing@postmarkapp.com`) and confirm the subscriber lands at `status='bounced'` within a few seconds.

### Rollback

- **Code rollback:** `wrangler rollback` reverts the Worker. D1 data persists; the routes return 404 but the tables are untouched. No data loss.
- **Disable only dispatch:** Set a feature flag secret `EMAIL_DISPATCH_ENABLED=false` (read by `notifySubscribers`; dispatcher returns early if unset or false). Keeps subscribe/manage flows alive while Postmark is paused.
- **Disable everything:** Remove the D1 binding from `wrangler.toml` and redeploy. Routes 500 on any D1 access. Worst-case option; use only if the DB itself is the problem.

### Post-ship monitoring

- Watch Postmark delivery rate and bounce rate for the `episode-summaries` stream for the first two weeks.
- Watch the activity log for `notifySubscribers` errors.
- Spot-check D1 row counts weekly: `SELECT COUNT(*) FROM subscribers WHERE status='active'` and `SELECT COUNT(*) FROM pending_confirmations WHERE expires_at > ?` to catch sweep regressions.

## Open questions

- Do we want a per-subscriber daily or weekly digest mode as a v1.1 follow-up, or leave it indefinitely as per-episode only? Depends on v1 email volume.
- Should the `/confirm` success page offer a "subscribe to more podcasts" affordance, or keep it to the single confirmed set?
- How do we surface "you subscribed to this podcast in 2024; it stopped being monitored" to long-dormant subscribers? Currently the orphan subscriptions just go silent.

## Follow-ups (explicitly out of v1)

- Dual-secret HMAC verify helper to support zero-downtime `MANAGE_LINK_HMAC_SECRET` rotation.
- "Notify me about newly added monitored podcasts" opt-in flag.
- Digest mode per-subscriber (immediate / daily / weekly toggle).
- Subscriber count and basic stats admin endpoint.
- Per-podcast subscribe CTA on individual episode pages.
- Admin-submitted episodes triggering emails (gated by a manual toggle).
- Per-podcast custom subjects or branding.
- In-repo source of truth for email HTML (MJML + CI render check).
