# Email subscriptions — design

**Date:** 2026-04-20
**Status:** Approved; implementation plan next.

## Summary

Let visitors subscribe to per-podcast email summaries without creating an account. Each monitored podcast's newly summarized episodes trigger one email per confirmed subscriber. Subscribers manage their list via signed links; no login, no password, no account.

## Goals

- Per-episode, transactional-feel emails (subject `{{podcastName}}: {{episodeTitle}}`).
- No login. Subscribe, confirm, manage, and unsubscribe entirely via email + signed URLs.
- Clean deliverability: separate Postmark streams for transactional vs bulk; honor bounces and spam complaints automatically.
- One-click per-podcast unsubscribe from the email footer, plus mailbox-provider `List-Unsubscribe` header.
- Minimal code surface: ~5 new files, ~550 LOC total.

## Non-goals (v1)

- Admin-submitted episodes do not trigger emails. Only the monitoring path.
- No digest mode (daily / weekly) — per-episode only.
- No read/click tracking. Postmark open tracking off by default.
- No batched Postmark send — one API call per recipient at v1 volumes.
- No subscriber admin UI. Direct D1 queries when needed.
- No in-repo source of truth for email HTML — Postmark-hosted templates are canonical. Optional `docs/email-templates/` snapshots are advisory only.

## Trigger point

In `src/queue/consumer.ts` there are two places where an episode is persisted via `saveEpisode` + `addToEpisodeIndex` (lines 544/547 and 709/712). After each successful pair, call:

```ts
await notifySubscribers(env, { podcastId, episode, source });
```

The dispatcher is a no-op unless `source === 'monitoring'` (not `'admin'`) AND at least one confirmed active subscriber exists for `podcastId`. Any failure inside the dispatcher is logged and swallowed — email is a best-effort side channel, never a data-integrity gate.

## Data model — Cloudflare D1

New D1 database bound as `DB`. Three tables:

```sql
CREATE TABLE subscribers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    confirmed_at INTEGER NOT NULL,  -- unix seconds; set at confirm time (unverified signups live in pending_confirmations)
    created_at INTEGER NOT NULL,
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
```

Notes:
- `subscribers.email` is `COLLATE NOCASE` — `Foo@bar.com` and `foo@bar.com` collapse.
- `pending_confirmations` holds unverified signup intent. On confirmation, row is deleted and subscriber is upserted.
- Manage and unsubscribe URLs use **HMAC-signed tokens**, not stored tokens — stateless, never expires, revocable by rotating `MANAGE_LINK_HMAC_SECRET`.

## HTTP routes

All on the existing Worker under `src/routes/`.

| Method + path | Purpose |
|---|---|
| `GET /subscribe` | Form. Email input + checkbox list of monitored podcasts (read from `monitored:*` KV). Cloudflare Turnstile widget. |
| `POST /subscribe` | Accepts `{ email, podcastIds[], turnstileToken }`. Validates, creates `pending_confirmations` row, sends confirm email via `outbound` (transactional). Always returns 200 "check your inbox" — never leaks email existence. |
| `GET /confirm?token=...` | Looks up pending row, upserts `subscribers` (sets `confirmed_at`), writes `subscriptions` rows, deletes pending row, renders success page with inline manage link. Rejects expired / unknown tokens with a generic error. |
| `GET /preferences` | Same form as `/subscribe` but a single email input. Submitting always returns "check your inbox". If a confirmed subscriber exists → send manage-link email. If not → treat as new signup (confirmation email). Identical UX → no enumeration leak. |
| `GET /preferences/manage?token=...&s=...` | Manage-link landing. Verifies HMAC over `(subscriber_id, email)`. Renders preferences UI pre-populated with current subscriptions, with "Unsubscribe from all" button. |
| `POST /preferences/manage` | Accepts signed token + updated `podcastIds[]`. Diffs and updates `subscriptions` rows. |
| `GET /unsubscribe?token=...&s=<id>&p=<podcastId>` | One-click. HMAC token covers `(subscriber_id, podcast_id)`. Deletes matching `subscriptions` row. Idempotent. Renders "Done" page with link to `/preferences`. If `p` omitted → unsubscribe-all (deletes all subscriptions for that subscriber, keeps the `subscribers` row). |
| `POST /webhooks/postmark` | Postmark bounce / complaint / subscription-change webhook. Verifies Postmark webhook basic-auth credentials. Updates `subscribers.status` and cascades subscription deletion. |

### Token scheme

- **Algorithm:** HMAC-SHA-256, hex-encoded, first 32 chars truncated.
- **Secret:** `MANAGE_LINK_HMAC_SECRET` (32 random bytes, stored as a Worker secret).
- **Message formats:**
  - Manage link: `manage|${subscriberId}|${emailLowercase}`
  - Per-podcast unsub: `unsub|${subscriberId}|${podcastId}`
  - Unsub all: `unsuball|${subscriberId}`
- **No expiry** — links remain valid until the subscriber record changes or the secret rotates. Low-value capability (unsubscribe / read own prefs), so no TTL pressure.
- **Verification:** compare via constant-time string equality (pure-JS XOR accumulator, per the corrections entry about `crypto.subtle.timingSafeEqual` not existing in all runtimes).

### Anti-abuse (v1, light)

- Cloudflare Turnstile on `GET /subscribe` form; `POST /subscribe` rejects if token missing / invalid.
- Cloudflare zone rate-limit rules: `POST /subscribe` and `POST /preferences/manage` → 10/min per IP. Configured in dashboard, not in code.
- `pending_confirmations` sweep inside the existing cron handler: `DELETE FROM pending_confirmations WHERE expires_at < strftime('%s','now')`.

## Email delivery

### Postmark streams

- **`outbound`** (existing transactional stream) — `confirm-subscription` and `manage-link` emails. Time-sensitive 1:1. No separate "welcome" email is sent: the `/confirm` success page itself is the welcome surface, with a "Manage preferences" link inline.
- **`episode-summaries`** (new broadcast stream — must be created in Postmark before rollout) — per-episode summaries. Broadcast reputation, Postmark auto-adds `List-Unsubscribe` + `List-Unsubscribe-Post: List-Unsubscribe=One-Click` headers.

### Sending domain

**Prerequisite:** add `tldl-pod.com` as a verified sending domain in Postmark before any emails go out. Requires publishing DKIM CNAME and a custom Return-Path CNAME in DNS. Verify in Postmark's Sender Signatures section before shipping.

### Templates (Postmark-hosted aliases)

All three stored in Postmark, referenced by alias. The repo stores only the alias constants and their TypeScript model types.

1. **`confirm-subscription`** — transactional.
   - Subject: `Confirm your tldl subscription`
   - Model: `{ confirmUrl: string, podcastList: string, expiresIn: string }`
   - Body copy (advisory): "You asked to subscribe to tldl summaries for: {{podcastList}}. Click to confirm: {{confirmUrl}}. The link expires in {{expiresIn}}. If this wasn't you, ignore this email — no account was created."

2. **`manage-link`** — transactional.
   - Subject: `Manage your tldl preferences`
   - Model: `{ manageUrl: string }`
   - Body: "Use this link to change your podcast subscriptions or unsubscribe: {{manageUrl}}."

3. **`episode-summary`** — broadcast.
   - Subject: `{{podcastName}}: {{episodeTitle}}`
   - Model:
     ```ts
     {
         podcastName: string;
         podcastCoverUrl: string;
         podcastWebsiteUrl?: string;  // from RSS <link> / PI, same field podcast page uses
         episodeTitle: string;
         episodeDate: string;         // formatted
         summaryHtml: string;         // full summary, rendered to HTML (marked)
         episodeUrl: string;          // canonical tldl page: https://tldl-pod.com/episodes/{id}
         unsubscribePodcastUrl: string;
         manageUrl: string;
     }
     ```
   - Body structure:
     1. Header: podcast cover + name + episode title + date.
     2. Meta row, two links:
        - **"Read full summary on tldl"** → `episodeUrl`
        - **"Visit {{podcastName}} website"** → `podcastWebsiteUrl` (omitted entirely if missing)
     3. Summary body (full HTML from `summaryHtml`).
     4. Footer: "Unsubscribe from {{podcastName}}" • "Manage all preferences".

### Dispatch loop

Inside `notifySubscribers`:

```
rows = SELECT s.id, s.email FROM subscribers s
       JOIN subscriptions sub ON sub.subscriber_id = s.id
       WHERE sub.podcast_id = ?
         AND s.status = 'active'
         AND s.confirmed_at IS NOT NULL;

for each row:
    manageUrl = buildManageUrl(row.id, row.email)
    unsubscribePodcastUrl = buildUnsubUrl(row.id, podcastId)
    POST https://api.postmarkapp.com/email/withTemplate
      MessageStream: 'episode-summaries'
      TemplateAlias: 'episode-summary'
      TemplateModel: { ...episodeFields, manageUrl, unsubscribePodcastUrl }

All sends via Promise.allSettled; log per-recipient success/failure.
```

Bounce/complaint filtering is at query time (`status = 'active'`), so the webhook never races with a send.

## Webhook handling

**`POST /webhooks/postmark`** validates Postmark's configured webhook basic-auth credentials (stored as `POSTMARK_WEBHOOK_SECRET`; Postmark adds an `Authorization: Basic ...` header).

Event handling:

| Event | `Type` | Action |
|---|---|---|
| `Bounce` | `HardBounce` | `UPDATE subscribers SET status='bounced' WHERE email=?`; `DELETE FROM subscriptions WHERE subscriber_id=?`. |
| `Bounce` | other (soft, transient) | Ignore. Postmark retries. |
| `SpamComplaint` | — | `status='complained'`, delete subscriptions. |
| `SubscriptionChange` (from `List-Unsubscribe`) | `SuppressSending=true` | Treat as unsubscribe-all: delete subscriptions. Keep the subscriber row with `status='complained'` so re-subscribe must go through confirm flow. |

## Module layout

```
src/
    db.ts                    # schema exports + all subscriber queries (~180 LOC)
    lib/
        emailTokens.ts       # HMAC sign/verify, constant-time compare (~30 LOC)
    services/
        postmark.ts          # existing; extended with sendTemplate() (~15 LOC added)
    routes/
        subscriptions.ts     # /subscribe, /confirm, /preferences,
                             # /preferences/manage, /unsubscribe (~250 LOC)
        webhooks.ts          # /webhooks/postmark (~60 LOC)
    queue/
        consumer.ts          # 2 call sites added
    notifications.ts         # notifySubscribers() (~40 LOC)
```

Net: 5 new files, 2 modifications, ~550 LOC.

## Testing strategy

**Unit (Vitest):**
- `lib/emailTokens.ts` — sign/verify round-trip, wrong secret, tampering, constant-time compare.
- `db.ts` query helpers against in-memory D1 — upsert, confirm, listByPodcast, unsubscribePodcast, markBounced.
- `services/postmark.ts` — `sendTemplate` with `fetch` mocked; success, error, non-OK.

**Route-level (`@cloudflare/vitest-pool-workers`):**
- `/subscribe` → validates Turnstile, rate-limit, creates pending, 200 regardless of email existence.
- `/confirm?token=...` — happy path, expired token, unknown token.
- `/preferences` happy paths for both existing-subscriber and new-email branches.
- `/preferences/manage` GET (load) and POST (diff apply).
- `/unsubscribe` per-podcast + unsubscribe-all, idempotence.
- `/webhooks/postmark` — hard bounce, spam complaint, subscription change, invalid auth, unknown event (ignored).

**Integration smoke (manual post-deploy):**
- Subscribe with real address, confirm, force a monitor check on a canary podcast, verify email renders in Gmail web, Apple Mail, Outlook web.
- Trigger a hard bounce via Postmark's test address and confirm `status='bounced'` in D1.

## Prerequisites (operator checklist, before rollout)

1. Add `tldl-pod.com` as a verified sending domain in Postmark (DKIM + Return-Path DNS).
2. Create new Postmark broadcast stream `episode-summaries`.
3. Create three Postmark templates (`confirm-subscription`, `manage-link`, `episode-summary`) with the models above.
4. `wrangler d1 create tldl-subscribers`, apply `schema.sql` to local + `--remote`.
5. Set Worker secrets: `MANAGE_LINK_HMAC_SECRET` (32 random bytes), `POSTMARK_WEBHOOK_SECRET`, `TURNSTILE_SECRET_KEY`, `TURNSTILE_SITE_KEY`. Confirm `POSTMARK_API_KEY` has access to the new stream (may need a stream-enabled server token).
6. Configure Postmark webhook to `POST https://tldl-pod.com/webhooks/postmark` for Bounce, SpamComplaint, SubscriptionChange events, with basic-auth credentials.
7. Add zone rate-limit rules in Cloudflare dashboard for `POST /subscribe` and `POST /preferences/manage`.

## Follow-ups (explicitly out of v1)

- "Notify me about newly added monitored podcasts" opt-in flag.
- Digest mode per-subscriber (immediate / daily / weekly toggle).
- Subscriber count + basic stats admin endpoint.
- Per-podcast subscribe CTA on individual episode pages.
- Admin-submitted episodes triggering emails (gated by a manual toggle).
- Per-podcast custom subjects / branding.
- In-repo source of truth for email HTML (MJML + CI render check).
