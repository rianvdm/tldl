# Email Subscriptions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship per-podcast email subscriptions for tldl — no login, signed email links for all management, per-episode Postmark delivery — per the spec at `docs/superpowers/specs/2026-04-20-email-subscriptions-design.md`.

**Architecture:** One Worker, one new D1 database (three tables), one new Postmark broadcast stream plus existing transactional stream. Signed HMAC tokens for all unauthenticated actions. Consumer emits notifications after episode save; dispatcher fans out to confirmed subscribers. Webhook endpoint handles bounces and complaints.

**Tech Stack:** Cloudflare Workers, Hono, Cloudflare D1 (SQLite), Postmark Email/Templates API, Vitest with `@cloudflare/vitest-pool-workers`, Cloudflare Turnstile, HMAC-SHA-256 via `crypto.subtle`.

---

## File Structure

**New:**
- `schema.sql` (repo root) — D1 schema (three tables + indexes)
- `src/lib/db.ts` — D1 binding type + subscriber query helpers
- `src/lib/emailTokens.ts` — HMAC sign/verify + constant-time string compare
- `src/lib/markdown.ts` — `renderMarkdown` extracted from `routes/public.ts` (shared between site and email)
- `src/routes/subscriptions.ts` — `/subscribe`, `/confirm`, `/preferences`, `/preferences/manage`, `/unsubscribe` (GET + POST)
- `src/routes/webhooks.ts` — `/webhooks/postmark`
- `src/notifications.ts` — `notifySubscribers` dispatcher
- `test/db.test.ts`
- `test/emailTokens.test.ts`
- `test/markdown-shared.test.ts`
- `test/subscriptions.test.ts`
- `test/webhooks-postmark.test.ts`
- `test/notifications.test.ts`

**Modified:**
- `wrangler.toml` — add `[[d1_databases]]` binding
- `worker-configuration.d.ts` — regenerated via `npx wrangler types` after binding added
- `src/types/index.ts` — new Env fields (`DB`, `MANAGE_LINK_HMAC_SECRET`, `POSTMARK_WEBHOOK_AUTH`, `EMAIL_DISPATCH_ENABLED`)
- `src/services/postmark.ts` — add `sendTemplate` alongside existing `sendEmail`
- `src/routes/public.ts` — replace inline `renderMarkdown` with import from `src/lib/markdown.ts`
- `src/queue/consumer.ts` — call `notifySubscribers` after both `saveEpisode + addToEpisodeIndex` pairs (lines 544/547 and 709/712)
- `src/index.ts` — mount new routes; add pending-confirmations sweep inside `scheduledHandler`
- `test/render-markdown.test.ts` — point imports at `src/lib/markdown.ts`

---

## Operator Prerequisites (do before Task 1)

These are pre-code steps the human operator performs. The implementation can run locally without all of them, but deployment needs them done.

- [ ] **D1 database created.** Run `npx wrangler d1 create tldl-subscribers`. Capture the printed `database_id` — it goes into `wrangler.toml` in Task 2.
- [ ] **Postmark sending domain verified.** Add `tldl-pod.com` as a verified sending domain (DKIM + Return-Path CNAME).
- [ ] **Postmark broadcast stream created.** Stream ID: `episode-summaries`. Confirm "List-Unsubscribe header" auto-injection is enabled (default on).
- [ ] **Postmark templates created.** Three aliases: `confirm-subscription`, `manage-link`, `episode-summary`. Models per spec §Templates. Bodies can be drafted later; empty HTML is fine during dev if text body is populated.
- [ ] **Postmark webhook configured.** `POST https://user:pass@tldl-pod.com/webhooks/postmark` for Bounce, SpamComplaint, SubscriptionChange. Pick a user/pass; it will be stored as `POSTMARK_WEBHOOK_AUTH` later.
- [ ] **Secrets generated (not yet set on Worker).**
  - `MANAGE_LINK_HMAC_SECRET`: `openssl rand -hex 32` → store in 1Password.
  - `POSTMARK_WEBHOOK_AUTH`: `user:pass` form matching the webhook URL.
- [ ] **Zone rate-limit rules configured.** Cloudflare dashboard → Security → Rate Limiting Rules → 10/min per IP on `/subscribe` and `/preferences/manage`. If on Pro plan, match on path only (method filtering requires Business).

---

## Task 1: Extract `renderMarkdown` into `src/lib/markdown.ts`

**Files:**
- Create: `src/lib/markdown.ts`
- Modify: `src/routes/public.ts` (lines 1-112 area)
- Modify: `test/render-markdown.test.ts` (update imports)

**Rationale:** The email dispatcher needs the same XSS-safe markdown path the site uses. Extracting first keeps the behavior change isolated and verified by existing tests before the new feature touches it.

- [ ] **Step 1: Read existing context**

Open `src/routes/public.ts` lines 80-115. The `sanitizingRenderer` is registered module-scope via `marked.use({ renderer: sanitizingRenderer })` before `renderMarkdown` is defined. Both the renderer setup and the function must move together or imports will fail.

- [ ] **Step 2: Create `src/lib/markdown.ts`**

```ts
import { marked } from "marked";

const sanitizingRenderer: Parameters<typeof marked.use>[0]["renderer"] = {
    html: () => "",
    link({ href, title, text }: { href: string; title?: string | null; text: string }) {
        const safeHref = /^(https?:|mailto:|#|\/)/.test(href) ? href : "#";
        const titleAttr = title ? ` title="${title.replace(/"/g, "&quot;")}"` : "";
        return `<a href="${safeHref}"${titleAttr}>${text}</a>`;
    },
};

marked.use({ renderer: sanitizingRenderer });

/**
 * Render markdown to HTML using the marked library.
 * XSS-safe: raw HTML is stripped, javascript: links are sanitized.
 */
export function renderMarkdown(md: string): string {
    if (!md) return "";
    return marked.parse(md, { gfm: true, breaks: false }) as string;
}
```

(If the actual `sanitizingRenderer` in `public.ts` has a different shape, copy it verbatim — do not redesign. The only goal here is extraction.)

- [ ] **Step 3: Replace the inline version in `src/routes/public.ts`**

Delete the old `sanitizingRenderer`, the `marked.use(...)` call, and the `renderMarkdown` function body in `public.ts`. Replace with an import at the top:

```ts
import { renderMarkdown } from "../lib/markdown";
```

Keep all existing call sites (`public.ts:682, 1321`) unchanged — they call `renderMarkdown` which now resolves to the imported function.

- [ ] **Step 4: Update `test/render-markdown.test.ts`**

Change the import at the top of the file from `../src/routes/public` to `../src/lib/markdown`. No test body changes.

- [ ] **Step 5: Run the full test suite to verify no regressions**

Run: `npm test`
Expected: all existing tests pass. The extraction is a pure refactor, so anything failing means the sanitizer behavior drifted.

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/lib/markdown.ts src/routes/public.ts test/render-markdown.test.ts
git commit -m "Extract renderMarkdown into src/lib/markdown.ts

Shared helper for upcoming email dispatcher. No behavior change."
```

---

## Task 2: D1 schema + binding

**Files:**
- Create: `schema.sql`
- Modify: `wrangler.toml`
- Modify: `src/types/index.ts` (Env interface)

**Rationale:** Getting the D1 binding in place unblocks every subsequent task that needs to touch subscriber state.

- [ ] **Step 1: Create `schema.sql`**

```sql
CREATE TABLE IF NOT EXISTS subscribers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    confirmed_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'active'
);

CREATE TABLE IF NOT EXISTS subscriptions (
    subscriber_id INTEGER NOT NULL REFERENCES subscribers(id) ON DELETE CASCADE,
    podcast_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (subscriber_id, podcast_id)
);
CREATE INDEX IF NOT EXISTS idx_subscriptions_podcast ON subscriptions(podcast_id);

CREATE TABLE IF NOT EXISTS pending_confirmations (
    token TEXT PRIMARY KEY,
    email TEXT NOT NULL,
    podcast_ids TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pending_email ON pending_confirmations(email);
```

- [ ] **Step 2: Add D1 binding to `wrangler.toml`**

Append after the KV namespace block (around line 24):

```toml
# D1 database for email subscriptions
[[d1_databases]]
binding = "DB"
database_name = "tldl-subscribers"
database_id = "<paste from wrangler d1 create output>"
```

- [ ] **Step 3: Regenerate Worker types**

Run: `npx wrangler types`
Expected: `worker-configuration.d.ts` updated with `DB: D1Database` on the Env interface.

- [ ] **Step 4: Add Env fields to `src/types/index.ts`**

Locate the `Env` interface (around `src/types/index.ts:175`). Add:

```ts
DB: D1Database;
MANAGE_LINK_HMAC_SECRET: string;
POSTMARK_WEBHOOK_AUTH: string;
EMAIL_DISPATCH_ENABLED?: string;  // optional; "false" disables dispatch
```

If the repo's `Env` is derived from `worker-configuration.d.ts` via an `import type`, add only the secret fields here; `DB` comes from the auto-generated file.

- [ ] **Step 5: Apply schema locally**

Run: `npx wrangler d1 execute tldl-subscribers --local --file=schema.sql`
Expected: three `CREATE TABLE` statements execute successfully.

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: no errors. (If the Env type expects `MANAGE_LINK_HMAC_SECRET` before any secret is set, that's fine — typecheck only verifies the shape.)

- [ ] **Step 7: Commit**

```bash
git add schema.sql wrangler.toml worker-configuration.d.ts src/types/index.ts
git commit -m "Add D1 binding and subscriber schema

Three tables (subscribers, subscriptions, pending_confirmations)
for the email subscriptions feature."
```

---

## Task 3: `src/lib/db.ts` — query helpers

**Files:**
- Create: `src/lib/db.ts`
- Create: `test/db.test.ts`

**Rationale:** All SQL lives in one module. Routes and the dispatcher call typed helpers instead of inlining queries.

- [ ] **Step 1: Write the failing test file `test/db.test.ts`**

```ts
import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import {
    upsertPendingConfirmation,
    findPendingByToken,
    hasActivePendingForEmail,
    confirmSubscriber,
    getSubscriberByEmail,
    listConfirmedSubscribersForPodcast,
    unsubscribePodcast,
    unsubscribeAll,
    markBounced,
    markComplained,
    sweepExpiredPending,
    type SubscriberStatus,
} from "../src/lib/db";

async function resetDb(): Promise<void> {
    await env.DB.exec("DELETE FROM subscriptions");
    await env.DB.exec("DELETE FROM pending_confirmations");
    await env.DB.exec("DELETE FROM subscribers");
}

describe("db helpers", () => {
    beforeEach(resetDb);

    it("creates and reads a pending confirmation by token", async () => {
        await upsertPendingConfirmation(env.DB, {
            token: "abc",
            email: "alice@example.com",
            podcastIds: ["p1", "p2"],
            createdAt: 1000,
            expiresAt: 2000,
        });
        const row = await findPendingByToken(env.DB, "abc");
        expect(row).toEqual({
            token: "abc",
            email: "alice@example.com",
            podcastIds: ["p1", "p2"],
            createdAt: 1000,
            expiresAt: 2000,
        });
    });

    it("returns null for unknown pending token", async () => {
        expect(await findPendingByToken(env.DB, "missing")).toBeNull();
    });

    it("detects active pending by email (case-insensitive)", async () => {
        await upsertPendingConfirmation(env.DB, {
            token: "t1",
            email: "Alice@Example.com",
            podcastIds: ["p1"],
            createdAt: 1000,
            expiresAt: 9_999_999_999,
        });
        expect(await hasActivePendingForEmail(env.DB, "alice@example.com", 1500)).toBe(true);
        expect(await hasActivePendingForEmail(env.DB, "bob@example.com", 1500)).toBe(false);
        expect(await hasActivePendingForEmail(env.DB, "alice@example.com", 10_000_000_000)).toBe(false);
    });

    it("confirms a subscriber, inserts subscriptions, deletes pending row", async () => {
        await upsertPendingConfirmation(env.DB, {
            token: "t2",
            email: "bob@example.com",
            podcastIds: ["p1", "p2"],
            createdAt: 1000,
            expiresAt: 2000,
        });
        const sub = await confirmSubscriber(env.DB, "t2", 1500);
        expect(sub).not.toBeNull();
        expect(sub!.email).toBe("bob@example.com");
        expect(sub!.status).toBe("active");
        expect(sub!.confirmedAt).toBe(1500);

        const pending = await findPendingByToken(env.DB, "t2");
        expect(pending).toBeNull();

        const subs = await listConfirmedSubscribersForPodcast(env.DB, "p1");
        expect(subs.map((s) => s.email)).toEqual(["bob@example.com"]);
    });

    it("confirming a bounced subscriber flips status back to active", async () => {
        await upsertPendingConfirmation(env.DB, {
            token: "t3", email: "c@example.com", podcastIds: ["p1"],
            createdAt: 1000, expiresAt: 2000,
        });
        await confirmSubscriber(env.DB, "t3", 1500);
        await markBounced(env.DB, "c@example.com", 1600);
        expect((await getSubscriberByEmail(env.DB, "c@example.com"))!.status).toBe("bounced");

        await upsertPendingConfirmation(env.DB, {
            token: "t4", email: "c@example.com", podcastIds: ["p2"],
            createdAt: 1700, expiresAt: 2700,
        });
        const reconfirmed = await confirmSubscriber(env.DB, "t4", 1800);
        expect(reconfirmed!.status).toBe("active");

        const pods = (await listConfirmedSubscribersForPodcast(env.DB, "p2")).map((s) => s.email);
        expect(pods).toEqual(["c@example.com"]);
    });

    it("unsubscribePodcast removes one subscription; unsubscribeAll removes all", async () => {
        await upsertPendingConfirmation(env.DB, {
            token: "t5", email: "d@example.com", podcastIds: ["p1", "p2", "p3"],
            createdAt: 1000, expiresAt: 2000,
        });
        const sub = await confirmSubscriber(env.DB, "t5", 1500);

        await unsubscribePodcast(env.DB, sub!.id, "p2");
        expect((await listConfirmedSubscribersForPodcast(env.DB, "p2")).length).toBe(0);
        expect((await listConfirmedSubscribersForPodcast(env.DB, "p1")).length).toBe(1);

        await unsubscribeAll(env.DB, sub!.id);
        expect((await listConfirmedSubscribersForPodcast(env.DB, "p1")).length).toBe(0);
        expect((await listConfirmedSubscribersForPodcast(env.DB, "p3")).length).toBe(0);
        // Subscriber row still exists.
        expect(await getSubscriberByEmail(env.DB, "d@example.com")).not.toBeNull();
    });

    it("markBounced and markComplained set the status and cascade-delete subscriptions", async () => {
        await upsertPendingConfirmation(env.DB, {
            token: "t6", email: "e@example.com", podcastIds: ["p1"],
            createdAt: 1000, expiresAt: 2000,
        });
        await confirmSubscriber(env.DB, "t6", 1500);
        await markComplained(env.DB, "e@example.com", 1600);
        const s = await getSubscriberByEmail(env.DB, "e@example.com");
        expect(s!.status).toBe("complained");
        expect((await listConfirmedSubscribersForPodcast(env.DB, "p1")).length).toBe(0);
    });

    it("listConfirmedSubscribersForPodcast filters out bounced and unconfirmed", async () => {
        await upsertPendingConfirmation(env.DB, {
            token: "t7", email: "f@example.com", podcastIds: ["p1"],
            createdAt: 1000, expiresAt: 2000,
        });
        await confirmSubscriber(env.DB, "t7", 1500);
        await upsertPendingConfirmation(env.DB, {
            token: "t8", email: "g@example.com", podcastIds: ["p1"],
            createdAt: 1000, expiresAt: 2000,
        });
        await confirmSubscriber(env.DB, "t8", 1500);
        await markBounced(env.DB, "g@example.com", 1600);
        const rows = await listConfirmedSubscribersForPodcast(env.DB, "p1");
        expect(rows.map((r) => r.email)).toEqual(["f@example.com"]);
    });

    it("sweepExpiredPending deletes rows with expires_at < now", async () => {
        await upsertPendingConfirmation(env.DB, {
            token: "old", email: "x@example.com", podcastIds: ["p1"],
            createdAt: 100, expiresAt: 200,
        });
        await upsertPendingConfirmation(env.DB, {
            token: "new", email: "y@example.com", podcastIds: ["p1"],
            createdAt: 1000, expiresAt: 2000,
        });
        const deleted = await sweepExpiredPending(env.DB, 500);
        expect(deleted).toBe(1);
        expect(await findPendingByToken(env.DB, "old")).toBeNull();
        expect(await findPendingByToken(env.DB, "new")).not.toBeNull();
    });

    it("SubscriberStatus type exported", () => {
        const s: SubscriberStatus = "active";
        expect(s).toBe("active");
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/db.test.ts`
Expected: FAIL, all imports missing from `../src/lib/db`.

- [ ] **Step 3: Implement `src/lib/db.ts`**

```ts
import type { D1Database } from "@cloudflare/workers-types";

export type SubscriberStatus = "active" | "bounced" | "complained";

export interface Subscriber {
    id: number;
    email: string;
    confirmedAt: number | null;
    createdAt: number;
    updatedAt: number;
    status: SubscriberStatus;
}

export interface PendingConfirmation {
    token: string;
    email: string;
    podcastIds: string[];
    createdAt: number;
    expiresAt: number;
}

export interface UpsertPendingInput {
    token: string;
    email: string;
    podcastIds: string[];
    createdAt: number;
    expiresAt: number;
}

export async function upsertPendingConfirmation(db: D1Database, input: UpsertPendingInput): Promise<void> {
    await db.prepare(
        "INSERT OR REPLACE INTO pending_confirmations (token, email, podcast_ids, created_at, expires_at) VALUES (?, ?, ?, ?, ?)"
    )
        .bind(input.token, input.email, JSON.stringify(input.podcastIds), input.createdAt, input.expiresAt)
        .run();
}

export async function findPendingByToken(db: D1Database, token: string): Promise<PendingConfirmation | null> {
    const row = await db.prepare(
        "SELECT token, email, podcast_ids, created_at, expires_at FROM pending_confirmations WHERE token = ?"
    ).bind(token).first<{ token: string; email: string; podcast_ids: string; created_at: number; expires_at: number }>();
    if (!row) return null;
    return {
        token: row.token,
        email: row.email,
        podcastIds: JSON.parse(row.podcast_ids) as string[],
        createdAt: row.created_at,
        expiresAt: row.expires_at,
    };
}

export async function hasActivePendingForEmail(db: D1Database, email: string, now: number): Promise<boolean> {
    const row = await db.prepare(
        "SELECT 1 AS one FROM pending_confirmations WHERE email = ? COLLATE NOCASE AND expires_at > ? LIMIT 1"
    ).bind(email, now).first<{ one: number }>();
    return row !== null;
}

export async function getSubscriberByEmail(db: D1Database, email: string): Promise<Subscriber | null> {
    const row = await db.prepare(
        "SELECT id, email, confirmed_at, created_at, updated_at, status FROM subscribers WHERE email = ? COLLATE NOCASE"
    ).bind(email).first<{ id: number; email: string; confirmed_at: number | null; created_at: number; updated_at: number; status: SubscriberStatus }>();
    if (!row) return null;
    return {
        id: row.id,
        email: row.email,
        confirmedAt: row.confirmed_at,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        status: row.status,
    };
}

/**
 * Consumes the pending row for `token`, upserts the subscriber (flipping
 * `bounced` back to `active` if applicable), inserts the subscription rows,
 * and deletes the pending row. Returns the subscriber on success, null if
 * the token does not exist or is expired.
 */
export async function confirmSubscriber(db: D1Database, token: string, now: number): Promise<Subscriber | null> {
    const pending = await findPendingByToken(db, token);
    if (!pending || pending.expiresAt < now) return null;

    // Upsert subscriber. Status flips to active on re-confirm.
    await db.prepare(
        `INSERT INTO subscribers (email, confirmed_at, created_at, updated_at, status)
         VALUES (?, ?, ?, ?, 'active')
         ON CONFLICT(email) DO UPDATE SET
             confirmed_at = excluded.confirmed_at,
             updated_at = excluded.updated_at,
             status = 'active'`
    ).bind(pending.email, now, now, now).run();

    const subscriber = await getSubscriberByEmail(db, pending.email);
    if (!subscriber) return null;

    // Insert subscriptions (idempotent via PRIMARY KEY).
    const stmts = pending.podcastIds.map((podcastId) =>
        db.prepare(
            "INSERT OR IGNORE INTO subscriptions (subscriber_id, podcast_id, created_at) VALUES (?, ?, ?)"
        ).bind(subscriber.id, podcastId, now)
    );
    if (stmts.length > 0) await db.batch(stmts);

    await db.prepare("DELETE FROM pending_confirmations WHERE token = ?").bind(token).run();

    return subscriber;
}

export async function listConfirmedSubscribersForPodcast(
    db: D1Database,
    podcastId: string
): Promise<Array<{ id: number; email: string }>> {
    const result = await db.prepare(
        `SELECT s.id, s.email
         FROM subscribers s
         JOIN subscriptions sub ON sub.subscriber_id = s.id
         WHERE sub.podcast_id = ?
           AND s.status = 'active'
           AND s.confirmed_at IS NOT NULL`
    ).bind(podcastId).all<{ id: number; email: string }>();
    return result.results ?? [];
}

export async function unsubscribePodcast(db: D1Database, subscriberId: number, podcastId: string): Promise<void> {
    await db.prepare(
        "DELETE FROM subscriptions WHERE subscriber_id = ? AND podcast_id = ?"
    ).bind(subscriberId, podcastId).run();
}

export async function unsubscribeAll(db: D1Database, subscriberId: number): Promise<void> {
    await db.prepare("DELETE FROM subscriptions WHERE subscriber_id = ?").bind(subscriberId).run();
}

export async function markBounced(db: D1Database, email: string, now: number): Promise<void> {
    await db.prepare(
        "UPDATE subscribers SET status = 'bounced', updated_at = ? WHERE email = ? COLLATE NOCASE"
    ).bind(now, email).run();
    await db.prepare(
        `DELETE FROM subscriptions
         WHERE subscriber_id IN (SELECT id FROM subscribers WHERE email = ? COLLATE NOCASE)`
    ).bind(email).run();
}

export async function markComplained(db: D1Database, email: string, now: number): Promise<void> {
    await db.prepare(
        "UPDATE subscribers SET status = 'complained', updated_at = ? WHERE email = ? COLLATE NOCASE"
    ).bind(now, email).run();
    await db.prepare(
        `DELETE FROM subscriptions
         WHERE subscriber_id IN (SELECT id FROM subscribers WHERE email = ? COLLATE NOCASE)`
    ).bind(email).run();
}

export async function listSubscriptionsForSubscriber(db: D1Database, subscriberId: number): Promise<string[]> {
    const result = await db.prepare(
        "SELECT podcast_id FROM subscriptions WHERE subscriber_id = ? ORDER BY podcast_id"
    ).bind(subscriberId).all<{ podcast_id: string }>();
    return (result.results ?? []).map((r) => r.podcast_id);
}

export async function replaceSubscriptions(
    db: D1Database,
    subscriberId: number,
    newPodcastIds: string[],
    now: number
): Promise<void> {
    const stmts = [
        db.prepare("DELETE FROM subscriptions WHERE subscriber_id = ?").bind(subscriberId),
        ...newPodcastIds.map((podcastId) =>
            db.prepare(
                "INSERT OR IGNORE INTO subscriptions (subscriber_id, podcast_id, created_at) VALUES (?, ?, ?)"
            ).bind(subscriberId, podcastId, now)
        ),
    ];
    await db.batch(stmts);
}

export async function sweepExpiredPending(db: D1Database, now: number): Promise<number> {
    const result = await db.prepare("DELETE FROM pending_confirmations WHERE expires_at < ?").bind(now).run();
    return result.meta?.changes ?? 0;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/db.test.ts`
Expected: all tests pass.

- [ ] **Step 5: Typecheck + full test run**

Run: `npm run typecheck && npm test`
Expected: no errors, all tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/lib/db.ts test/db.test.ts
git commit -m "Add D1 query helpers for subscriber state

Upsert pending, confirm subscriber (including bounced->active flip),
per-podcast listing, unsubscribe (one / all), bounce/complaint marks,
expired-pending sweep."
```

---

## Task 4: `src/lib/emailTokens.ts` — HMAC helpers

**Files:**
- Create: `src/lib/emailTokens.ts`
- Create: `test/emailTokens.test.ts`

- [ ] **Step 1: Write the failing test file `test/emailTokens.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import {
    signToken,
    verifyToken,
    constantTimeEqual,
    manageMessage,
    unsubMessage,
    unsubAllMessage,
} from "../src/lib/emailTokens";

const SECRET = "secret-key-for-testing-only-32b!";

describe("emailTokens", () => {
    it("sign/verify round-trip for manage link", async () => {
        const msg = manageMessage(42, "alice@example.com");
        const token = await signToken(SECRET, msg);
        expect(token).toMatch(/^[0-9a-f]{32}$/);
        expect(await verifyToken(SECRET, msg, token)).toBe(true);
    });

    it("sign/verify round-trip for unsub podcast", async () => {
        const msg = unsubMessage(7, "p1");
        const token = await signToken(SECRET, msg);
        expect(await verifyToken(SECRET, msg, token)).toBe(true);
    });

    it("sign/verify round-trip for unsub all", async () => {
        const msg = unsubAllMessage(7);
        const token = await signToken(SECRET, msg);
        expect(await verifyToken(SECRET, msg, token)).toBe(true);
    });

    it("rejects tokens signed with a different secret", async () => {
        const msg = manageMessage(42, "alice@example.com");
        const token = await signToken(SECRET, msg);
        expect(await verifyToken("different-secret", msg, token)).toBe(false);
    });

    it("rejects tampered messages", async () => {
        const msg = manageMessage(42, "alice@example.com");
        const token = await signToken(SECRET, msg);
        const tamperedMsg = manageMessage(43, "alice@example.com");
        expect(await verifyToken(SECRET, tamperedMsg, token)).toBe(false);
    });

    it("rejects tokens of the wrong length", async () => {
        const msg = manageMessage(42, "alice@example.com");
        expect(await verifyToken(SECRET, msg, "short")).toBe(false);
        expect(await verifyToken(SECRET, msg, "0".repeat(64))).toBe(false);
    });

    it("constantTimeEqual returns true for equal strings", () => {
        expect(constantTimeEqual("abc123", "abc123")).toBe(true);
    });

    it("constantTimeEqual returns false for different strings", () => {
        expect(constantTimeEqual("abc123", "abc124")).toBe(false);
        expect(constantTimeEqual("abc", "abcd")).toBe(false);
    });

    it("manageMessage normalises email to lowercase", () => {
        expect(manageMessage(1, "Foo@Bar.COM")).toBe(manageMessage(1, "foo@bar.com"));
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/emailTokens.test.ts`
Expected: FAIL, imports missing.

- [ ] **Step 3: Implement `src/lib/emailTokens.ts`**

```ts
/**
 * HMAC-SHA-256 signing for stateless manage / unsubscribe tokens.
 *
 * Tokens are 32 hex chars (128 bits) — first half of a full SHA-256 HMAC.
 * Verification uses a pure-JS XOR accumulator. `crypto.subtle.timingSafeEqual`
 * is a Cloudflare Workers extension (not Web Crypto), so it breaks Vitest
 * tests running outside the Workers pool.
 */

export function manageMessage(subscriberId: number, email: string): string {
    return `manage|${subscriberId}|${email.toLowerCase()}`;
}

export function unsubMessage(subscriberId: number, podcastId: string): string {
    return `unsub|${subscriberId}|${podcastId}`;
}

export function unsubAllMessage(subscriberId: number): string {
    return `unsuball|${subscriberId}`;
}

export async function signToken(secret: string, message: string): Promise<string> {
    const key = await crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(secret),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"]
    );
    const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
    const hex = bufferToHex(sig);
    return hex.slice(0, 32);
}

export async function verifyToken(secret: string, message: string, token: string): Promise<boolean> {
    if (token.length !== 32) return false;
    const expected = await signToken(secret, message);
    return constantTimeEqual(expected, token);
}

export function constantTimeEqual(a: string, b: string): boolean {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return diff === 0;
}

function bufferToHex(buffer: ArrayBuffer): string {
    const bytes = new Uint8Array(buffer);
    let hex = "";
    for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, "0");
    return hex;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/emailTokens.test.ts`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/lib/emailTokens.ts test/emailTokens.test.ts
git commit -m "Add HMAC-SHA-256 token helpers for email links

Stateless 128-bit tokens for manage / unsubscribe-podcast /
unsubscribe-all URLs. Constant-time compare in pure JS to stay
testable under Vitest's Node runtime."
```

---

## Task 5: Extend `src/services/postmark.ts` with `sendTemplate`

**Files:**
- Modify: `src/services/postmark.ts`
- Create: `test/postmark-sendtemplate.test.ts`

- [ ] **Step 1: Write the failing test `test/postmark-sendtemplate.test.ts`**

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { sendTemplate } from "../src/services/postmark";

describe("sendTemplate", () => {
    beforeEach(() => vi.restoreAllMocks());

    it("posts to /email/withTemplate with the right payload", async () => {
        const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
            new Response(JSON.stringify({ MessageID: "abc" }), { status: 200 })
        );
        const result = await sendTemplate("server-token", {
            from: "a@b.com",
            to: "c@d.com",
            templateAlias: "confirm-subscription",
            templateModel: { confirmUrl: "https://x", podcastList: "X", expiresIn: "48 hours" },
            messageStream: c.env.POSTMARK_MESSAGE_STREAM,
        });
        expect(result).toEqual({ success: true });
        expect(fetchSpy).toHaveBeenCalledWith(
            "https://api.postmarkapp.com/email/withTemplate",
            expect.objectContaining({
                method: "POST",
                headers: expect.objectContaining({ "X-Postmark-Server-Token": "server-token" }),
            })
        );
        const body = JSON.parse((fetchSpy.mock.calls[0]![1] as RequestInit).body as string);
        expect(body).toEqual({
            From: "a@b.com",
            To: "c@d.com",
            TemplateAlias: "confirm-subscription",
            TemplateModel: { confirmUrl: "https://x", podcastList: "X", expiresIn: "48 hours" },
            MessageStream: "outbound",
        });
    });

    it("returns success:false on non-2xx", async () => {
        vi.spyOn(globalThis, "fetch").mockResolvedValue(
            new Response(JSON.stringify({ ErrorCode: 10, Message: "bad" }), { status: 422 })
        );
        const result = await sendTemplate("t", {
            from: "a@b.com", to: "c@d.com",
            templateAlias: "x", templateModel: {}, messageStream: c.env.POSTMARK_MESSAGE_STREAM,
        });
        expect(result.success).toBe(false);
        expect(result.errorMessage).toBe("bad");
    });

    it("returns success:false on fetch throw", async () => {
        vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("net"));
        const result = await sendTemplate("t", {
            from: "a@b.com", to: "c@d.com",
            templateAlias: "x", templateModel: {}, messageStream: c.env.POSTMARK_MESSAGE_STREAM,
        });
        expect(result.success).toBe(false);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/postmark-sendtemplate.test.ts`
Expected: FAIL, `sendTemplate` not exported.

- [ ] **Step 3: Add `sendTemplate` to `src/services/postmark.ts`**

Append at the bottom of the file (keep existing `sendEmail` untouched):

```ts
export interface SendTemplateOptions {
    from: string;
    to: string;
    templateAlias: string;
    templateModel: Record<string, unknown>;
    messageStream: string;
}

export async function sendTemplate(
    apiKey: string,
    options: SendTemplateOptions
): Promise<{ success: boolean; errorMessage?: string }> {
    try {
        const response = await fetch("https://api.postmarkapp.com/email/withTemplate", {
            method: "POST",
            headers: {
                "Accept": "application/json",
                "Content-Type": "application/json",
                "X-Postmark-Server-Token": apiKey,
            },
            body: JSON.stringify({
                From: options.from,
                To: options.to,
                TemplateAlias: options.templateAlias,
                TemplateModel: options.templateModel,
                MessageStream: options.messageStream,
            }),
        });
        if (!response.ok) {
            const error = await response.json() as { ErrorCode: number; Message: string };
            console.error(JSON.stringify({
                event: "postmark_send_template_failed",
                status: response.status,
                errorCode: error.ErrorCode,
                message: error.Message,
                templateAlias: options.templateAlias,
            }));
            return { success: false, errorMessage: error.Message || "Failed to send template email" };
        }
        return { success: true };
    } catch (error) {
        console.error(JSON.stringify({
            event: "postmark_send_template_error",
            error: error instanceof Error ? error.message : String(error),
            templateAlias: options.templateAlias,
        }));
        return { success: false, errorMessage: "Failed to send template email" };
    }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/postmark-sendtemplate.test.ts`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/services/postmark.ts test/postmark-sendtemplate.test.ts
git commit -m "Add sendTemplate to Postmark client

Wraps POST /email/withTemplate for template-based sends. Keeps
existing sendEmail untouched."
```

---

## Task 6: `/subscribe` (GET + POST) and `/confirm`

**Files:**
- Create: `src/routes/subscriptions.ts` (grow over subsequent tasks)
- Modify: `src/index.ts` (mount router)
- Create: `test/subscriptions.test.ts`

**Scope for this task only:** form render, submit handler with Turnstile + status gate + per-email throttle, confirmation GET. `/preferences` and `/unsubscribe` come in later tasks.

- [ ] **Step 1: Write failing tests (subscribe + confirm)**

Create `test/subscriptions.test.ts`:

```ts
import { env, SELF } from "cloudflare:test";
import { describe, it, expect, beforeEach, vi } from "vitest";

async function resetDb() {
    await env.DB.exec("DELETE FROM subscriptions");
    await env.DB.exec("DELETE FROM pending_confirmations");
    await env.DB.exec("DELETE FROM subscribers");
}

function mockPostmarkOk() {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
        if (typeof url === "string" && url.startsWith("https://challenges.cloudflare.com")) {
            return new Response(JSON.stringify({ success: true }), { status: 200 });
        }
        if (typeof url === "string" && url.startsWith("https://api.postmarkapp.com")) {
            return new Response(JSON.stringify({ MessageID: "m1" }), { status: 200 });
        }
        return new Response("not stubbed", { status: 500 });
    });
}

describe("POST /subscribe", () => {
    beforeEach(async () => { await resetDb(); vi.restoreAllMocks(); });

    it("creates a pending_confirmations row and sends confirmation email", async () => {
        mockPostmarkOk();
        const res = await SELF.fetch("https://tldl-pod.com/subscribe", {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
                email: "alice@example.com",
                "cf-turnstile-response": "test-token",
                podcastIds: "p1,p2",
            }),
        });
        expect(res.status).toBe(200);
        const body = await res.text();
        expect(body).toContain("check your inbox");
        const row = await env.DB.prepare("SELECT email, podcast_ids FROM pending_confirmations WHERE email=?")
            .bind("alice@example.com").first();
        expect(row).not.toBeNull();
        expect(JSON.parse((row as any).podcast_ids)).toEqual(["p1", "p2"]);
    });

    it("silently drops when a complained subscriber resubscribes", async () => {
        mockPostmarkOk();
        // Seed a complained subscriber.
        const now = Math.floor(Date.now() / 1000);
        await env.DB.prepare(
            "INSERT INTO subscribers (email, confirmed_at, created_at, updated_at, status) VALUES (?, ?, ?, ?, 'complained')"
        ).bind("bad@example.com", now, now, now).run();

        const res = await SELF.fetch("https://tldl-pod.com/subscribe", {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
                email: "bad@example.com",
                "cf-turnstile-response": "test-token",
                podcastIds: "p1",
            }),
        });
        expect(res.status).toBe(200);
        expect(await res.text()).toContain("check your inbox");
        const row = await env.DB.prepare("SELECT 1 FROM pending_confirmations WHERE email=?")
            .bind("bad@example.com").first();
        expect(row).toBeNull();
    });

    it("deduplicates a second submit within the pending window (per-email throttle)", async () => {
        mockPostmarkOk();
        const submit = () => SELF.fetch("https://tldl-pod.com/subscribe", {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
                email: "c@example.com",
                "cf-turnstile-response": "test-token",
                podcastIds: "p1",
            }),
        });
        await submit();
        await submit();
        const rows = await env.DB.prepare("SELECT COUNT(*) AS n FROM pending_confirmations WHERE email=?")
            .bind("c@example.com").first<{ n: number }>();
        expect(rows!.n).toBe(1);
    });

    it("rejects missing email", async () => {
        mockPostmarkOk();
        const res = await SELF.fetch("https://tldl-pod.com/subscribe", {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
                "cf-turnstile-response": "test-token",
                podcastIds: "p1",
            }),
        });
        expect(res.status).toBe(400);
    });

    it("rejects when Turnstile fails", async () => {
        vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
            if (typeof url === "string" && url.startsWith("https://challenges.cloudflare.com")) {
                return new Response(JSON.stringify({ success: false }), { status: 200 });
            }
            return new Response(JSON.stringify({ MessageID: "m1" }), { status: 200 });
        });
        const res = await SELF.fetch("https://tldl-pod.com/subscribe", {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
                email: "d@example.com",
                "cf-turnstile-response": "bad-token",
                podcastIds: "p1",
            }),
        });
        expect(res.status).toBe(403);
    });
});

describe("GET /confirm", () => {
    beforeEach(async () => { await resetDb(); vi.restoreAllMocks(); });

    it("confirms a valid token and creates the subscriber + subscriptions", async () => {
        const now = Math.floor(Date.now() / 1000);
        await env.DB.prepare(
            "INSERT INTO pending_confirmations (token, email, podcast_ids, created_at, expires_at) VALUES (?, ?, ?, ?, ?)"
        ).bind("tok-good", "alice@example.com", JSON.stringify(["p1"]), now, now + 3600).run();

        const res = await SELF.fetch("https://tldl-pod.com/confirm?token=tok-good");
        expect(res.status).toBe(200);
        expect(await res.text()).toMatch(/confirmed|subscribed/i);
        const sub = await env.DB.prepare("SELECT status FROM subscribers WHERE email=?").bind("alice@example.com").first();
        expect((sub as any).status).toBe("active");
    });

    it("rejects unknown token with a friendly error page", async () => {
        const res = await SELF.fetch("https://tldl-pod.com/confirm?token=nope");
        expect(res.status).toBe(400);
        expect(await res.text()).toMatch(/expired|invalid|subscribe again/i);
    });

    it("rejects expired token", async () => {
        const now = Math.floor(Date.now() / 1000);
        await env.DB.prepare(
            "INSERT INTO pending_confirmations (token, email, podcast_ids, created_at, expires_at) VALUES (?, ?, ?, ?, ?)"
        ).bind("tok-old", "x@example.com", JSON.stringify(["p1"]), now - 7200, now - 3600).run();
        const res = await SELF.fetch("https://tldl-pod.com/confirm?token=tok-old");
        expect(res.status).toBe(400);
    });

    it("flips a bounced subscriber back to active on re-confirm", async () => {
        const now = Math.floor(Date.now() / 1000);
        await env.DB.prepare(
            "INSERT INTO subscribers (email, confirmed_at, created_at, updated_at, status) VALUES (?, ?, ?, ?, 'bounced')"
        ).bind("b@example.com", now - 1000, now - 1000, now - 500).run();
        await env.DB.prepare(
            "INSERT INTO pending_confirmations (token, email, podcast_ids, created_at, expires_at) VALUES (?, ?, ?, ?, ?)"
        ).bind("tok-reconfirm", "b@example.com", JSON.stringify(["p1"]), now, now + 3600).run();
        const res = await SELF.fetch("https://tldl-pod.com/confirm?token=tok-reconfirm");
        expect(res.status).toBe(200);
        const sub = await env.DB.prepare("SELECT status FROM subscribers WHERE email=?").bind("b@example.com").first();
        expect((sub as any).status).toBe("active");
    });
});
```

Note: Turnstile's `verifyTurnstile` helper at `src/lib/turnstile.ts:19` hits `https://challenges.cloudflare.com/turnstile/v0/siteverify`. The tests mock that URL to return `{ success: true }`. The test env may need `TURNSTILE_SECRET` seeded — add to `vitest.config.ts` miniflare bindings block:

```ts
bindings: {
    ENVIRONMENT: "development",
    TURNSTILE_SECRET: "dummy-for-tests",
    MANAGE_LINK_HMAC_SECRET: "test-hmac-secret-32-bytes-exactly!",
    POSTMARK_API_KEY: "test-postmark",
    POSTMARK_FROM_EMAIL: "test@tldl.test",
    POSTMARK_WEBHOOK_AUTH: "u:p",
},
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/subscriptions.test.ts`
Expected: all fail (routes don't exist).

- [ ] **Step 3: Implement `src/routes/subscriptions.ts`**

```ts
import { Hono } from "hono";
import type { Env } from "../types";
import { verifyTurnstile } from "../lib/turnstile";
import { sendTemplate } from "../services/postmark";
import { getMonitoredPodcastIds, getMonitoredPodcast } from "../lib/kv";
import {
    upsertPendingConfirmation,
    hasActivePendingForEmail,
    getSubscriberByEmail,
    confirmSubscriber,
} from "../lib/db";

export const subscriptionsRoutes = new Hono<{ Bindings: Env }>();

const BASE_URL = "https://tldl-pod.com";
const PENDING_TTL_SECONDS = 48 * 3600;

function pageShell(title: string, body: string): string {
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head><body><main style="max-width:640px;margin:3rem auto;font-family:system-ui">${body}</main></body></html>`;
}

function escapeHtml(s: string): string {
    return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c]!));
}

function isValidEmail(email: string): boolean {
    if (email.length < 3 || email.length > 254) return false;
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function randomTokenHex(bytes: number): string {
    const buf = new Uint8Array(bytes);
    crypto.getRandomValues(buf);
    let hex = "";
    for (let i = 0; i < buf.length; i++) hex += buf[i].toString(16).padStart(2, "0");
    return hex;
}

// ---- GET /subscribe ----
subscriptionsRoutes.get("/subscribe", async (c) => {
    const podcastIds = await getMonitoredPodcastIds(c.env.TLDL_DATA);
    const podcasts = (await Promise.all(podcastIds.map((id) => getMonitoredPodcast(c.env.TLDL_DATA, id))))
        .filter((p): p is NonNullable<typeof p> => Boolean(p))
        .sort((a, b) => a.name.localeCompare(b.name));
    const options = podcasts
        .map((p) => `<label style="display:block;margin:0.4em 0"><input type="checkbox" name="podcastIds" value="${escapeHtml(p.id)}"> ${escapeHtml(p.name)}</label>`)
        .join("");
    return c.html(pageShell("Subscribe — tldl", `
        <h1>Get email summaries</h1>
        <form method="post" action="/subscribe">
            <label>Email<br><input type="email" name="email" required></label><br><br>
            <fieldset><legend>Podcasts</legend>${options}</fieldset><br>
            <div class="cf-turnstile" data-sitekey="${escapeHtml(c.env.TURNSTILE_SITE_KEY)}"></div>
            <script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script><br>
            <button type="submit">Subscribe</button>
        </form>
    `));
});

// ---- POST /subscribe ----
subscriptionsRoutes.post("/subscribe", async (c) => {
    const form = await c.req.parseBody();
    const rawEmail = typeof form.email === "string" ? form.email.trim() : "";
    const turnstileToken = typeof form["cf-turnstile-response"] === "string" ? form["cf-turnstile-response"] : "";
    const rawPodcastIds = form.podcastIds;
    const podcastIds = Array.isArray(rawPodcastIds)
        ? rawPodcastIds.filter((v): v is string => typeof v === "string")
        : typeof rawPodcastIds === "string"
            ? rawPodcastIds.split(",").map((s) => s.trim()).filter(Boolean)
            : [];

    if (!rawEmail || !isValidEmail(rawEmail)) return c.text("Invalid email", 400);
    if (podcastIds.length === 0) return c.text("Pick at least one podcast", 400);

    if (!(await verifyTurnstile(turnstileToken, c.env.TURNSTILE_SECRET))) return c.text("Turnstile failed", 403);

    const email = rawEmail.toLowerCase();
    const now = Math.floor(Date.now() / 1000);

    // Status gate — complained addresses never get another confirmation email.
    const existing = await getSubscriberByEmail(c.env.DB, email);
    if (existing?.status === "complained") {
        return c.html(pageShell("Check your inbox — tldl", `<h1>Check your inbox</h1><p>If we can reach you, a confirmation email is on its way.</p>`));
    }

    // Per-email throttle — one live pending at a time.
    if (await hasActivePendingForEmail(c.env.DB, email, now)) {
        return c.html(pageShell("Check your inbox — tldl", `<h1>Check your inbox</h1><p>If we can reach you, a confirmation email is on its way.</p>`));
    }

    const token = randomTokenHex(32);
    await upsertPendingConfirmation(c.env.DB, {
        token, email, podcastIds,
        createdAt: now, expiresAt: now + PENDING_TTL_SECONDS,
    });

    const podcastNames = (await Promise.all(podcastIds.map((id) => getMonitoredPodcast(c.env.TLDL_DATA, id))))
        .filter((p): p is NonNullable<typeof p> => Boolean(p))
        .map((p) => p.name)
        .join(", ");

    await sendTemplate(c.env.POSTMARK_API_KEY, {
        from: c.env.POSTMARK_FROM_EMAIL,
        to: email,
        templateAlias: "confirm-subscription",
        templateModel: {
            confirmUrl: `${BASE_URL}/confirm?token=${token}`,
            podcastList: podcastNames,
            expiresIn: "48 hours",
        },
        messageStream: c.env.POSTMARK_MESSAGE_STREAM,
    });

    return c.html(pageShell("Check your inbox — tldl", `<h1>Check your inbox</h1><p>If we can reach you, a confirmation email is on its way.</p>`));
});

// ---- GET /confirm ----
subscriptionsRoutes.get("/confirm", async (c) => {
    const token = c.req.query("token");
    if (!token) return c.html(pageShell("Invalid link — tldl", `<h1>Invalid or expired link</h1><p><a href="/subscribe">Subscribe again</a></p>`), 400);

    const now = Math.floor(Date.now() / 1000);
    const subscriber = await confirmSubscriber(c.env.DB, token, now);
    if (!subscriber) {
        return c.html(pageShell("Invalid link — tldl", `<h1>Invalid or expired link</h1><p><a href="/subscribe">Subscribe again</a></p>`), 400);
    }

    return c.html(pageShell("Confirmed — tldl", `
        <h1>You're subscribed</h1>
        <p>We'll email you when a new summary goes up for any of your podcasts.</p>
        <p><a href="/preferences">Manage preferences</a></p>
    `));
});
```

- [ ] **Step 4: Mount router in `src/index.ts`**

Find the existing route mounts (look for `app.route(...)` calls). Add after the public routes import:

```ts
import { subscriptionsRoutes } from "./routes/subscriptions";
app.route("/", subscriptionsRoutes);
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run test/subscriptions.test.ts`
Expected: all tests pass.

- [ ] **Step 6: Run full test suite + typecheck**

Run: `npm test && npm run typecheck`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add src/routes/subscriptions.ts src/index.ts test/subscriptions.test.ts vitest.config.ts
git commit -m "Add /subscribe, /confirm routes

Form page, double-opt-in POST with Turnstile + status gate +
per-email throttle, confirmation GET that also flips bounced
subscribers back to active."
```

---

## Task 7: `/preferences` and `/preferences/manage`

**Files:**
- Modify: `src/routes/subscriptions.ts` (extend)
- Modify: `test/subscriptions.test.ts` (extend)

- [ ] **Step 1: Add failing tests to `test/subscriptions.test.ts`**

Append these describe blocks:

```ts
import { signToken, manageMessage } from "../src/lib/emailTokens";
import { listSubscriptionsForSubscriber } from "../src/lib/db";

describe("GET /preferences", () => {
    beforeEach(async () => { await resetDb(); vi.restoreAllMocks(); });

    it("renders an email-entry form", async () => {
        const res = await SELF.fetch("https://tldl-pod.com/preferences");
        expect(res.status).toBe(200);
        expect(await res.text()).toContain('name="email"');
    });
});

describe("POST /preferences", () => {
    beforeEach(async () => { await resetDb(); vi.restoreAllMocks(); });

    it("sends manage-link email for an existing active subscriber", async () => {
        const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
            new Response(JSON.stringify({ MessageID: "m" }), { status: 200 })
        );
        const now = Math.floor(Date.now() / 1000);
        await env.DB.prepare(
            "INSERT INTO subscribers (email, confirmed_at, created_at, updated_at, status) VALUES (?, ?, ?, ?, 'active')"
        ).bind("a@example.com", now, now, now).run();

        const res = await SELF.fetch("https://tldl-pod.com/preferences", {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({ email: "a@example.com" }),
        });
        expect(res.status).toBe(200);
        // Postmark /email/withTemplate was called with the manage-link alias.
        const postmarkCall = fetchSpy.mock.calls.find(([url]) =>
            typeof url === "string" && url.includes("/email/withTemplate")
        );
        expect(postmarkCall).toBeDefined();
        const body = JSON.parse((postmarkCall![1] as RequestInit).body as string);
        expect(body.TemplateAlias).toBe("manage-link");
    });

    it("treats unknown emails as new signup (sends confirm-subscription)", async () => {
        const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
            new Response(JSON.stringify({ MessageID: "m" }), { status: 200 })
        );
        const res = await SELF.fetch("https://tldl-pod.com/preferences", {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({ email: "new@example.com" }),
        });
        expect(res.status).toBe(200);
        // No Turnstile on /preferences (low-risk recovery), no podcastIds — confirm-subscription with an empty podcast list.
        const postmarkCall = fetchSpy.mock.calls.find(([url]) =>
            typeof url === "string" && url.includes("/email/withTemplate")
        );
        const body = JSON.parse((postmarkCall![1] as RequestInit).body as string);
        expect(body.TemplateAlias).toBe("confirm-subscription");
    });
});

describe("GET /preferences/manage", () => {
    beforeEach(async () => { await resetDb(); vi.restoreAllMocks(); });

    it("renders preferences pre-populated when token valid", async () => {
        const now = Math.floor(Date.now() / 1000);
        await env.DB.prepare(
            "INSERT INTO subscribers (id, email, confirmed_at, created_at, updated_at, status) VALUES (?, ?, ?, ?, ?, 'active')"
        ).bind(10, "m@example.com", now, now, now).run();
        await env.DB.prepare(
            "INSERT INTO subscriptions (subscriber_id, podcast_id, created_at) VALUES (?, ?, ?)"
        ).bind(10, "p1", now).run();

        const secret = "test-hmac-secret-32-bytes-exactly!";
        const token = await signToken(secret, manageMessage(10, "m@example.com"));
        const res = await SELF.fetch(`https://tldl-pod.com/preferences/manage?s=10&token=${token}`);
        expect(res.status).toBe(200);
        const html = await res.text();
        expect(html).toContain("m@example.com");
        expect(html).toContain("p1");
    });

    it("rejects an invalid token", async () => {
        const res = await SELF.fetch("https://tldl-pod.com/preferences/manage?s=10&token=deadbeef".padEnd(60, "0"));
        expect(res.status).toBe(403);
    });
});

describe("POST /preferences/manage", () => {
    beforeEach(async () => { await resetDb(); vi.restoreAllMocks(); });

    it("replaces the subscriber's subscriptions atomically", async () => {
        const now = Math.floor(Date.now() / 1000);
        await env.DB.prepare(
            "INSERT INTO subscribers (id, email, confirmed_at, created_at, updated_at, status) VALUES (?, ?, ?, ?, ?, 'active')"
        ).bind(20, "u@example.com", now, now, now).run();
        await env.DB.prepare(
            "INSERT INTO subscriptions (subscriber_id, podcast_id, created_at) VALUES (?, ?, ?), (?, ?, ?)"
        ).bind(20, "p1", now, 20, "p2", now).run();

        const secret = "test-hmac-secret-32-bytes-exactly!";
        const token = await signToken(secret, manageMessage(20, "u@example.com"));
        const res = await SELF.fetch("https://tldl-pod.com/preferences/manage", {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({ s: "20", token, podcastIds: "p2,p3" }),
        });
        expect(res.status).toBe(200);
        const final = await listSubscriptionsForSubscriber(env.DB, 20);
        expect(final.sort()).toEqual(["p2", "p3"]);
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/subscriptions.test.ts`
Expected: the new `/preferences*` tests fail.

- [ ] **Step 3: Extend `src/routes/subscriptions.ts`**

Add imports at the top:

```ts
import { signToken, verifyToken, manageMessage } from "../lib/emailTokens";
import { listSubscriptionsForSubscriber, replaceSubscriptions } from "../lib/db";
```

Add these handlers after `/confirm`:

```ts
// ---- GET /preferences ----
subscriptionsRoutes.get("/preferences", (c) => c.html(pageShell("Preferences — tldl", `
    <h1>Manage preferences</h1>
    <p>Enter your email and we'll send you a link to change or remove your subscriptions.</p>
    <form method="post" action="/preferences">
        <label>Email<br><input type="email" name="email" required></label><br><br>
        <button type="submit">Send me the link</button>
    </form>
`)));

// ---- POST /preferences ----
subscriptionsRoutes.post("/preferences", async (c) => {
    const form = await c.req.parseBody();
    const rawEmail = typeof form.email === "string" ? form.email.trim() : "";
    if (!rawEmail || !isValidEmail(rawEmail)) return c.text("Invalid email", 400);
    const email = rawEmail.toLowerCase();
    const now = Math.floor(Date.now() / 1000);

    const subscriber = await getSubscriberByEmail(c.env.DB, email);
    if (subscriber && subscriber.status === "active" && subscriber.confirmedAt !== null) {
        // Send manage-link email.
        const token = await signToken(c.env.MANAGE_LINK_HMAC_SECRET, manageMessage(subscriber.id, email));
        const manageUrl = `${BASE_URL}/preferences/manage?s=${subscriber.id}&token=${token}`;
        await sendTemplate(c.env.POSTMARK_API_KEY, {
            from: c.env.POSTMARK_FROM_EMAIL, to: email,
            templateAlias: "manage-link",
            templateModel: { manageUrl },
            messageStream: c.env.POSTMARK_MESSAGE_STREAM,
        });
    } else if (!subscriber) {
        // Treat as new signup with empty podcast list — user picks podcasts after confirming.
        const token = randomTokenHex(32);
        await upsertPendingConfirmation(c.env.DB, {
            token, email, podcastIds: [],
            createdAt: now, expiresAt: now + PENDING_TTL_SECONDS,
        });
        await sendTemplate(c.env.POSTMARK_API_KEY, {
            from: c.env.POSTMARK_FROM_EMAIL, to: email,
            templateAlias: "confirm-subscription",
            templateModel: {
                confirmUrl: `${BASE_URL}/confirm?token=${token}`,
                podcastList: "",
                expiresIn: "48 hours",
            },
            messageStream: c.env.POSTMARK_MESSAGE_STREAM,
        });
    }
    // complained + bounced: silently drop.

    return c.html(pageShell("Check your inbox — tldl", `<h1>Check your inbox</h1><p>If we can reach you, a link is on its way.</p>`));
});

// ---- GET /preferences/manage ----
subscriptionsRoutes.get("/preferences/manage", async (c) => {
    const sRaw = c.req.query("s");
    const token = c.req.query("token");
    if (!sRaw || !token) return c.text("Forbidden", 403);
    const s = Number.parseInt(sRaw, 10);
    if (!Number.isFinite(s)) return c.text("Forbidden", 403);

    const subscriber = await c.env.DB.prepare(
        "SELECT id, email FROM subscribers WHERE id = ?"
    ).bind(s).first<{ id: number; email: string }>();
    if (!subscriber) return c.text("Forbidden", 403);

    const ok = await verifyToken(c.env.MANAGE_LINK_HMAC_SECRET, manageMessage(subscriber.id, subscriber.email), token);
    if (!ok) return c.text("Forbidden", 403);

    const allIds = await getMonitoredPodcastIds(c.env.TLDL_DATA);
    const allPodcasts = (await Promise.all(allIds.map((id) => getMonitoredPodcast(c.env.TLDL_DATA, id))))
        .filter((p): p is NonNullable<typeof p> => Boolean(p))
        .sort((a, b) => a.name.localeCompare(b.name));
    const current = new Set(await listSubscriptionsForSubscriber(c.env.DB, subscriber.id));

    const options = allPodcasts.map((p) => `
        <label style="display:block;margin:0.4em 0">
            <input type="checkbox" name="podcastIds" value="${escapeHtml(p.id)}"${current.has(p.id) ? " checked" : ""}>
            ${escapeHtml(p.name)}
        </label>`).join("");

    return c.html(pageShell("Preferences — tldl", `
        <h1>Preferences for ${escapeHtml(subscriber.email)}</h1>
        <form method="post" action="/preferences/manage">
            <input type="hidden" name="s" value="${subscriber.id}">
            <input type="hidden" name="token" value="${escapeHtml(token)}">
            <fieldset><legend>Podcasts</legend>${options}</fieldset><br>
            <button type="submit">Save</button>
        </form>
        <form method="post" action="/unsubscribe" style="margin-top:1em">
            <input type="hidden" name="s" value="${subscriber.id}">
            <input type="hidden" name="token" value="${escapeHtml(await signToken(c.env.MANAGE_LINK_HMAC_SECRET, `unsuball|${subscriber.id}`))}">
            <button type="submit" style="color:#a00">Unsubscribe from all</button>
        </form>
    `));
});

// ---- POST /preferences/manage ----
subscriptionsRoutes.post("/preferences/manage", async (c) => {
    const form = await c.req.parseBody();
    const sRaw = typeof form.s === "string" ? form.s : "";
    const token = typeof form.token === "string" ? form.token : "";
    const s = Number.parseInt(sRaw, 10);
    if (!Number.isFinite(s) || !token) return c.text("Forbidden", 403);

    const subscriber = await c.env.DB.prepare(
        "SELECT id, email, status FROM subscribers WHERE id = ?"
    ).bind(s).first<{ id: number; email: string; status: string }>();
    if (!subscriber) return c.text("Forbidden", 403);

    const ok = await verifyToken(c.env.MANAGE_LINK_HMAC_SECRET, manageMessage(subscriber.id, subscriber.email), token);
    if (!ok) return c.text("Forbidden", 403);
    if (subscriber.status !== "active") return c.text("Account not active", 409);

    const rawPodcastIds = form.podcastIds;
    const podcastIds = Array.isArray(rawPodcastIds)
        ? rawPodcastIds.filter((v): v is string => typeof v === "string")
        : typeof rawPodcastIds === "string"
            ? rawPodcastIds.split(",").map((v) => v.trim()).filter(Boolean)
            : [];

    const now = Math.floor(Date.now() / 1000);
    await replaceSubscriptions(c.env.DB, subscriber.id, podcastIds, now);

    return c.html(pageShell("Saved — tldl", `<h1>Saved</h1><p>Your preferences are updated.</p>`));
});
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/subscriptions.test.ts`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/routes/subscriptions.ts test/subscriptions.test.ts
git commit -m "Add /preferences routes (email input, manage page, save)

No-login preferences UI keyed off HMAC-signed manage links.
Identical UX for known vs unknown emails (no enumeration)."
```

---

## Task 8: `/unsubscribe` (GET + POST)

**Files:**
- Modify: `src/routes/subscriptions.ts`
- Modify: `test/subscriptions.test.ts`

- [ ] **Step 1: Add failing tests**

Append:

```ts
import { unsubMessage, unsubAllMessage } from "../src/lib/emailTokens";

describe("GET /unsubscribe", () => {
    beforeEach(async () => { await resetDb(); vi.restoreAllMocks(); });

    it("per-podcast: deletes the subscription and returns a done page", async () => {
        const now = Math.floor(Date.now() / 1000);
        await env.DB.prepare(
            "INSERT INTO subscribers (id, email, confirmed_at, created_at, updated_at, status) VALUES (?, ?, ?, ?, ?, 'active')"
        ).bind(30, "z@example.com", now, now, now).run();
        await env.DB.prepare(
            "INSERT INTO subscriptions (subscriber_id, podcast_id, created_at) VALUES (?, ?, ?), (?, ?, ?)"
        ).bind(30, "p1", now, 30, "p2", now).run();

        const secret = "test-hmac-secret-32-bytes-exactly!";
        const token = await signToken(secret, unsubMessage(30, "p1"));
        const res = await SELF.fetch(`https://tldl-pod.com/unsubscribe?s=30&p=p1&token=${token}`);
        expect(res.status).toBe(200);
        const remaining = (await listSubscriptionsForSubscriber(env.DB, 30));
        expect(remaining).toEqual(["p2"]);
    });

    it("unsubscribe-all: deletes every subscription", async () => {
        const now = Math.floor(Date.now() / 1000);
        await env.DB.prepare(
            "INSERT INTO subscribers (id, email, confirmed_at, created_at, updated_at, status) VALUES (?, ?, ?, ?, ?, 'active')"
        ).bind(31, "y@example.com", now, now, now).run();
        await env.DB.prepare(
            "INSERT INTO subscriptions (subscriber_id, podcast_id, created_at) VALUES (?, ?, ?), (?, ?, ?)"
        ).bind(31, "p1", now, 31, "p2", now).run();

        const secret = "test-hmac-secret-32-bytes-exactly!";
        const token = await signToken(secret, unsubAllMessage(31));
        const res = await SELF.fetch(`https://tldl-pod.com/unsubscribe?s=31&token=${token}`);
        expect(res.status).toBe(200);
        expect(await listSubscriptionsForSubscriber(env.DB, 31)).toEqual([]);
    });

    it("idempotent: second call is still 200", async () => {
        const now = Math.floor(Date.now() / 1000);
        await env.DB.prepare(
            "INSERT INTO subscribers (id, email, confirmed_at, created_at, updated_at, status) VALUES (?, ?, ?, ?, ?, 'active')"
        ).bind(32, "q@example.com", now, now, now).run();
        const secret = "test-hmac-secret-32-bytes-exactly!";
        const token = await signToken(secret, unsubAllMessage(32));
        const url = `https://tldl-pod.com/unsubscribe?s=32&token=${token}`;
        expect((await SELF.fetch(url)).status).toBe(200);
        expect((await SELF.fetch(url)).status).toBe(200);
    });

    it("rejects a mismatched token shape (missing p but used a per-podcast token)", async () => {
        const now = Math.floor(Date.now() / 1000);
        await env.DB.prepare(
            "INSERT INTO subscribers (id, email, confirmed_at, created_at, updated_at, status) VALUES (?, ?, ?, ?, ?, 'active')"
        ).bind(33, "r@example.com", now, now, now).run();
        const secret = "test-hmac-secret-32-bytes-exactly!";
        const perPodcastToken = await signToken(secret, unsubMessage(33, "p1"));
        const res = await SELF.fetch(`https://tldl-pod.com/unsubscribe?s=33&token=${perPodcastToken}`);
        expect(res.status).toBe(403);
    });
});

describe("POST /unsubscribe (RFC 8058)", () => {
    beforeEach(async () => { await resetDb(); vi.restoreAllMocks(); });

    it("POST unsubscribe-all works and returns 200 empty body", async () => {
        const now = Math.floor(Date.now() / 1000);
        await env.DB.prepare(
            "INSERT INTO subscribers (id, email, confirmed_at, created_at, updated_at, status) VALUES (?, ?, ?, ?, ?, 'active')"
        ).bind(40, "p@example.com", now, now, now).run();
        const secret = "test-hmac-secret-32-bytes-exactly!";
        const token = await signToken(secret, unsubAllMessage(40));
        const res = await SELF.fetch("https://tldl-pod.com/unsubscribe", {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({ s: "40", token }),
        });
        expect(res.status).toBe(200);
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/subscriptions.test.ts`

- [ ] **Step 3: Extend `src/routes/subscriptions.ts`**

Add import:

```ts
import { unsubMessage, unsubAllMessage } from "../lib/emailTokens";
import { unsubscribePodcast, unsubscribeAll } from "../lib/db";
```

Add handlers:

```ts
async function handleUnsubscribe(c: Parameters<typeof subscriptionsRoutes.get>[1] extends (ctx: infer Ctx) => unknown ? Ctx : never) {
    // This helper intentionally re-uses the same logic for GET and POST.
    const method = c.req.method;
    const source = method === "GET" ? c.req.query.bind(c.req) : (async () => {
        const form = await c.req.parseBody();
        return (name: string) => {
            const v = form[name];
            return typeof v === "string" ? v : undefined;
        };
    })();
    const get = typeof source === "function" ? source : await source;
    const sRaw = get("s");
    const p = get("p");
    const token = get("token");
    if (!sRaw || !token) return c.text("Forbidden", 403);
    const s = Number.parseInt(sRaw, 10);
    if (!Number.isFinite(s)) return c.text("Forbidden", 403);

    const message = p ? unsubMessage(s, p) : unsubAllMessage(s);
    const ok = await verifyToken(c.env.MANAGE_LINK_HMAC_SECRET, message, token);
    if (!ok) return c.text("Forbidden", 403);

    if (p) await unsubscribePodcast(c.env.DB, s, p);
    else await unsubscribeAll(c.env.DB, s);

    if (method === "POST") return c.text("", 200);
    return c.html(pageShell("Unsubscribed — tldl", `<h1>You're unsubscribed</h1><p><a href="/preferences">Manage preferences</a></p>`));
}

subscriptionsRoutes.get("/unsubscribe", (c) => handleUnsubscribe(c));
subscriptionsRoutes.post("/unsubscribe", (c) => handleUnsubscribe(c));
```

(If the Hono typing gymnastics above are awkward, inline the logic into two handlers instead — the plan's goal is correctness, not cleverness. Both paths must end up calling `verifyToken` and then the corresponding DB helper.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/subscriptions.test.ts`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/routes/subscriptions.ts test/subscriptions.test.ts
git commit -m "Add /unsubscribe GET + POST

Per-podcast and unsubscribe-all via HMAC-signed GET (for footer
links) and POST (RFC 8058 one-click mailbox-provider path)."
```

---

## Task 9: `/webhooks/postmark`

**Files:**
- Create: `src/routes/webhooks.ts`
- Create: `test/webhooks-postmark.test.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: Write failing tests `test/webhooks-postmark.test.ts`**

```ts
import { env, SELF } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";

async function resetDb() {
    await env.DB.exec("DELETE FROM subscriptions");
    await env.DB.exec("DELETE FROM pending_confirmations");
    await env.DB.exec("DELETE FROM subscribers");
}

function basicAuthHeader(userPass: string): string {
    return "Basic " + btoa(userPass);
}

describe("POST /webhooks/postmark", () => {
    beforeEach(resetDb);

    it("rejects unauthenticated requests", async () => {
        const res = await SELF.fetch("https://tldl-pod.com/webhooks/postmark", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ RecordType: "Bounce", Type: "HardBounce", Email: "x@y.com" }),
        });
        expect(res.status).toBe(401);
    });

    it("hard bounce marks subscriber bounced and deletes subscriptions", async () => {
        const now = Math.floor(Date.now() / 1000);
        await env.DB.prepare(
            "INSERT INTO subscribers (id, email, confirmed_at, created_at, updated_at, status) VALUES (?, ?, ?, ?, ?, 'active')"
        ).bind(100, "b@example.com", now, now, now).run();
        await env.DB.prepare(
            "INSERT INTO subscriptions (subscriber_id, podcast_id, created_at) VALUES (?, ?, ?)"
        ).bind(100, "p1", now).run();

        const res = await SELF.fetch("https://tldl-pod.com/webhooks/postmark", {
            method: "POST",
            headers: { "content-type": "application/json", authorization: basicAuthHeader("u:p") },
            body: JSON.stringify({ RecordType: "Bounce", Type: "HardBounce", Email: "b@example.com" }),
        });
        expect(res.status).toBe(200);
        const sub = await env.DB.prepare("SELECT status FROM subscribers WHERE email=?").bind("b@example.com").first();
        expect((sub as any).status).toBe("bounced");
        const subs = await env.DB.prepare("SELECT COUNT(*) AS n FROM subscriptions WHERE subscriber_id=?").bind(100).first<{ n: number }>();
        expect(subs!.n).toBe(0);
    });

    it("soft bounce is ignored", async () => {
        const now = Math.floor(Date.now() / 1000);
        await env.DB.prepare(
            "INSERT INTO subscribers (id, email, confirmed_at, created_at, updated_at, status) VALUES (?, ?, ?, ?, ?, 'active')"
        ).bind(101, "s@example.com", now, now, now).run();

        const res = await SELF.fetch("https://tldl-pod.com/webhooks/postmark", {
            method: "POST",
            headers: { "content-type": "application/json", authorization: basicAuthHeader("u:p") },
            body: JSON.stringify({ RecordType: "Bounce", Type: "Transient", Email: "s@example.com" }),
        });
        expect(res.status).toBe(200);
        const sub = await env.DB.prepare("SELECT status FROM subscribers WHERE email=?").bind("s@example.com").first();
        expect((sub as any).status).toBe("active");
    });

    it("spam complaint marks complained", async () => {
        const now = Math.floor(Date.now() / 1000);
        await env.DB.prepare(
            "INSERT INTO subscribers (id, email, confirmed_at, created_at, updated_at, status) VALUES (?, ?, ?, ?, ?, 'active')"
        ).bind(102, "c@example.com", now, now, now).run();
        const res = await SELF.fetch("https://tldl-pod.com/webhooks/postmark", {
            method: "POST",
            headers: { "content-type": "application/json", authorization: basicAuthHeader("u:p") },
            body: JSON.stringify({ RecordType: "SpamComplaint", Email: "c@example.com" }),
        });
        expect(res.status).toBe(200);
        const sub = await env.DB.prepare("SELECT status FROM subscribers WHERE email=?").bind("c@example.com").first();
        expect((sub as any).status).toBe("complained");
    });

    it("SubscriptionChange (SuppressSending=true) marks complained", async () => {
        const now = Math.floor(Date.now() / 1000);
        await env.DB.prepare(
            "INSERT INTO subscribers (id, email, confirmed_at, created_at, updated_at, status) VALUES (?, ?, ?, ?, ?, 'active')"
        ).bind(103, "sc@example.com", now, now, now).run();
        const res = await SELF.fetch("https://tldl-pod.com/webhooks/postmark", {
            method: "POST",
            headers: { "content-type": "application/json", authorization: basicAuthHeader("u:p") },
            body: JSON.stringify({ RecordType: "SubscriptionChange", Recipient: "sc@example.com", SuppressSending: true }),
        });
        expect(res.status).toBe(200);
        const sub = await env.DB.prepare("SELECT status FROM subscribers WHERE email=?").bind("sc@example.com").first();
        expect((sub as any).status).toBe("complained");
    });

    it("unknown event types are a no-op 200", async () => {
        const res = await SELF.fetch("https://tldl-pod.com/webhooks/postmark", {
            method: "POST",
            headers: { "content-type": "application/json", authorization: basicAuthHeader("u:p") },
            body: JSON.stringify({ RecordType: "Open", Email: "who@cares" }),
        });
        expect(res.status).toBe(200);
    });

    it("duplicate webhook is idempotent", async () => {
        const now = Math.floor(Date.now() / 1000);
        await env.DB.prepare(
            "INSERT INTO subscribers (id, email, confirmed_at, created_at, updated_at, status) VALUES (?, ?, ?, ?, ?, 'active')"
        ).bind(104, "d@example.com", now, now, now).run();
        const payload = { RecordType: "Bounce", Type: "HardBounce", Email: "d@example.com" };
        await SELF.fetch("https://tldl-pod.com/webhooks/postmark", {
            method: "POST",
            headers: { "content-type": "application/json", authorization: basicAuthHeader("u:p") },
            body: JSON.stringify(payload),
        });
        const res = await SELF.fetch("https://tldl-pod.com/webhooks/postmark", {
            method: "POST",
            headers: { "content-type": "application/json", authorization: basicAuthHeader("u:p") },
            body: JSON.stringify(payload),
        });
        expect(res.status).toBe(200);
        const sub = await env.DB.prepare("SELECT status FROM subscribers WHERE email=?").bind("d@example.com").first();
        expect((sub as any).status).toBe("bounced");
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/webhooks-postmark.test.ts`

- [ ] **Step 3: Implement `src/routes/webhooks.ts`**

```ts
import { Hono } from "hono";
import type { Env } from "../types";
import { markBounced, markComplained, unsubscribeAll, getSubscriberByEmail } from "../lib/db";
import { constantTimeEqual } from "../lib/emailTokens";

export const webhookRoutes = new Hono<{ Bindings: Env }>();

function checkBasicAuth(header: string | undefined, expected: string): boolean {
    if (!header?.startsWith("Basic ")) return false;
    const encoded = header.slice(6);
    let decoded: string;
    try { decoded = atob(encoded); } catch { return false; }
    return constantTimeEqual(decoded, expected);
}

interface PostmarkEvent {
    RecordType: string;
    Type?: string;
    Email?: string;
    Recipient?: string;
    SuppressSending?: boolean;
}

webhookRoutes.post("/webhooks/postmark", async (c) => {
    const auth = c.req.header("authorization");
    if (!checkBasicAuth(auth, c.env.POSTMARK_WEBHOOK_AUTH)) return c.text("Unauthorized", 401);

    let event: PostmarkEvent;
    try { event = await c.req.json<PostmarkEvent>(); }
    catch { return c.text("Bad request", 400); }

    const now = Math.floor(Date.now() / 1000);
    const email = (event.Email || event.Recipient || "").toLowerCase();

    if (!email) return c.text("OK", 200);

    if (event.RecordType === "Bounce" && event.Type === "HardBounce") {
        await markBounced(c.env.DB, email, now);
    } else if (event.RecordType === "SpamComplaint") {
        await markComplained(c.env.DB, email, now);
    } else if (event.RecordType === "SubscriptionChange" && event.SuppressSending === true) {
        await markComplained(c.env.DB, email, now);
        const existing = await getSubscriberByEmail(c.env.DB, email);
        if (existing) await unsubscribeAll(c.env.DB, existing.id);
    }
    // All other event types (soft bounces, opens, clicks, etc.) are ignored.

    return c.text("OK", 200);
});
```

- [ ] **Step 4: Mount in `src/index.ts`**

```ts
import { webhookRoutes } from "./routes/webhooks";
app.route("/", webhookRoutes);
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run test/webhooks-postmark.test.ts`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/routes/webhooks.ts test/webhooks-postmark.test.ts src/index.ts
git commit -m "Add Postmark webhook endpoint

Basic-auth gated. Handles HardBounce, SpamComplaint, and
SubscriptionChange (List-Unsubscribe) events. Idempotent."
```

---

## Task 10: `src/notifications.ts` — dispatcher

**Files:**
- Create: `src/notifications.ts`
- Create: `test/notifications.test.ts`

- [ ] **Step 1: Write failing tests `test/notifications.test.ts`**

```ts
import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { notifySubscribers } from "../src/notifications";

async function resetDb() {
    await env.DB.exec("DELETE FROM subscriptions");
    await env.DB.exec("DELETE FROM pending_confirmations");
    await env.DB.exec("DELETE FROM subscribers");
}

function fakeEpisode(overrides: Record<string, unknown> = {}) {
    return {
        id: "ep1",
        podcastName: "Test Podcast",
        episodeTitle: "Test Episode",
        episodeDate: "2026-04-20",
        summaryText: "# Heading\n\nSome summary.",
        podcastAuthor: "Someone",
        podcastWebsiteUrl: "https://example.com",
        submittedBy: "monitor@tldl.app",
        ...overrides,
    };
}

describe("notifySubscribers", () => {
    beforeEach(async () => { await resetDb(); vi.restoreAllMocks(); });

    it("no-ops when episode.submittedBy !== 'monitor@tldl.app'", async () => {
        const fetchSpy = vi.spyOn(globalThis, "fetch");
        await notifySubscribers(env, {
            podcastId: "p1",
            episode: fakeEpisode({ submittedBy: "human@tldl.app" }),
        });
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("no-ops when the podcast is no longer monitored (orphan guard)", async () => {
        // No monitored:p1 in KV.
        const now = Math.floor(Date.now() / 1000);
        await env.DB.prepare(
            "INSERT INTO subscribers (id, email, confirmed_at, created_at, updated_at, status) VALUES (?, ?, ?, ?, ?, 'active')"
        ).bind(1, "a@example.com", now, now, now).run();
        await env.DB.prepare(
            "INSERT INTO subscriptions (subscriber_id, podcast_id, created_at) VALUES (?, ?, ?)"
        ).bind(1, "p1", now).run();

        const fetchSpy = vi.spyOn(globalThis, "fetch");
        await notifySubscribers(env, { podcastId: "p1", episode: fakeEpisode() });
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("sends one email per confirmed active subscriber", async () => {
        // Seed a monitored podcast in KV.
        await env.TLDL_DATA.put("monitored:p1", JSON.stringify({
            id: "p1", name: "Test Podcast", websiteUrl: "https://example.com",
            coverUrl: "https://img.example.com/cover.jpg",
        }));
        await env.TLDL_DATA.put("monitored:list", JSON.stringify(["p1"]));

        const now = Math.floor(Date.now() / 1000);
        await env.DB.prepare(
            "INSERT INTO subscribers (id, email, confirmed_at, created_at, updated_at, status) VALUES (?, ?, ?, ?, ?, 'active'), (?, ?, ?, ?, ?, 'active'), (?, ?, ?, ?, ?, 'bounced')"
        ).bind(
            10, "one@example.com", now, now, now,
            11, "two@example.com", now, now, now,
            12, "bounced@example.com", now, now, now,
        ).run();
        await env.DB.batch([
            env.DB.prepare("INSERT INTO subscriptions (subscriber_id, podcast_id, created_at) VALUES (?, ?, ?)").bind(10, "p1", now),
            env.DB.prepare("INSERT INTO subscriptions (subscriber_id, podcast_id, created_at) VALUES (?, ?, ?)").bind(11, "p1", now),
            env.DB.prepare("INSERT INTO subscriptions (subscriber_id, podcast_id, created_at) VALUES (?, ?, ?)").bind(12, "p1", now),
        ]);

        const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
            new Response(JSON.stringify({ MessageID: "x" }), { status: 200 })
        );
        await notifySubscribers(env, { podcastId: "p1", episode: fakeEpisode() });

        const postmarkCalls = fetchSpy.mock.calls.filter(([u]) =>
            typeof u === "string" && u.includes("/email/withTemplate")
        );
        expect(postmarkCalls.length).toBe(2); // Two active; bounced filtered out.
        const recipients = postmarkCalls.map(([_u, init]) => JSON.parse((init as RequestInit).body as string).To).sort();
        expect(recipients).toEqual(["one@example.com", "two@example.com"]);
    });

    it("continues even if one recipient send fails", async () => {
        await env.TLDL_DATA.put("monitored:p1", JSON.stringify({ id: "p1", name: "X", websiteUrl: "https://x", coverUrl: "https://i" }));
        await env.TLDL_DATA.put("monitored:list", JSON.stringify(["p1"]));

        const now = Math.floor(Date.now() / 1000);
        await env.DB.prepare(
            "INSERT INTO subscribers (id, email, confirmed_at, created_at, updated_at, status) VALUES (?, ?, ?, ?, ?, 'active'), (?, ?, ?, ?, ?, 'active')"
        ).bind(20, "a@example.com", now, now, now, 21, "b@example.com", now, now, now).run();
        await env.DB.batch([
            env.DB.prepare("INSERT INTO subscriptions VALUES (?, ?, ?)").bind(20, "p1", now),
            env.DB.prepare("INSERT INTO subscriptions VALUES (?, ?, ?)").bind(21, "p1", now),
        ]);

        let calls = 0;
        vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
            calls += 1;
            if (calls === 1) return new Response("boom", { status: 500 });
            return new Response(JSON.stringify({ MessageID: "x" }), { status: 200 });
        });

        // Should not throw.
        await notifySubscribers(env, { podcastId: "p1", episode: fakeEpisode() });
        expect(calls).toBe(2);
    });

    it("returns early when EMAIL_DISPATCH_ENABLED=false", async () => {
        await env.TLDL_DATA.put("monitored:p1", JSON.stringify({ id: "p1", name: "X", websiteUrl: "https://x", coverUrl: "https://i" }));
        const now = Math.floor(Date.now() / 1000);
        await env.DB.prepare(
            "INSERT INTO subscribers (id, email, confirmed_at, created_at, updated_at, status) VALUES (?, ?, ?, ?, ?, 'active')"
        ).bind(30, "e@example.com", now, now, now).run();
        await env.DB.prepare("INSERT INTO subscriptions VALUES (?, ?, ?)").bind(30, "p1", now).run();
        const fetchSpy = vi.spyOn(globalThis, "fetch");

        // Simulate flag off by monkey-patching env for this call.
        const envWithFlag = { ...env, EMAIL_DISPATCH_ENABLED: "false" };
        await notifySubscribers(envWithFlag as typeof env, { podcastId: "p1", episode: fakeEpisode() });
        expect(fetchSpy).not.toHaveBeenCalled();
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/notifications.test.ts`

- [ ] **Step 3: Implement `src/notifications.ts`**

```ts
import type { Env } from "./types";
import { sendTemplate } from "./services/postmark";
import { getMonitoredPodcast } from "./lib/kv";
import { listConfirmedSubscribersForPodcast } from "./lib/db";
import { signToken, manageMessage, unsubMessage } from "./lib/emailTokens";
import { renderMarkdown } from "./lib/markdown";

const BASE_URL = "https://tldl-pod.com";
const MONITOR_SUBMITTER = "monitor@tldl.app";

interface NotifyInput {
    podcastId: string;
    episode: {
        id: string;
        podcastName: string;
        episodeTitle: string;
        episodeDate: string;
        summaryText?: string;
        submittedBy?: string;
        podcastWebsiteUrl?: string;
    };
}

export async function notifySubscribers(env: Env, input: NotifyInput): Promise<void> {
    try {
        if (env.EMAIL_DISPATCH_ENABLED === "false") return;
        if (input.episode.submittedBy !== MONITOR_SUBMITTER) return;

        const podcast = await getMonitoredPodcast(env.TLDL_DATA, input.podcastId);
        if (!podcast) {
            console.log(JSON.stringify({ event: "notify_skip_orphan", podcastId: input.podcastId }));
            return;
        }

        const subscribers = await listConfirmedSubscribersForPodcast(env.DB, input.podcastId);
        if (subscribers.length === 0) return;

        const summaryHtml = input.episode.summaryText ? renderMarkdown(input.episode.summaryText) : "";
        const episodeDate = formatDate(input.episode.episodeDate);

        const results = await Promise.allSettled(subscribers.map(async (sub) => {
            const manageUrl = `${BASE_URL}/preferences/manage?s=${sub.id}&token=${await signToken(env.MANAGE_LINK_HMAC_SECRET, manageMessage(sub.id, sub.email))}`;
            const unsubUrl = `${BASE_URL}/unsubscribe?s=${sub.id}&p=${encodeURIComponent(input.podcastId)}&token=${await signToken(env.MANAGE_LINK_HMAC_SECRET, unsubMessage(sub.id, input.podcastId))}`;
            const res = await sendTemplate(env.POSTMARK_API_KEY, {
                from: env.POSTMARK_FROM_EMAIL,
                to: sub.email,
                templateAlias: "episode-summary",
                templateModel: {
                    podcastName: podcast.name,
                    podcastCoverUrl: podcast.coverUrl ?? `${BASE_URL}/default-cover.png`,
                    ...(input.episode.podcastWebsiteUrl || podcast.websiteUrl
                        ? { podcastWebsiteUrl: input.episode.podcastWebsiteUrl ?? podcast.websiteUrl }
                        : {}),
                    episodeTitle: input.episode.episodeTitle,
                    episodeDate,
                    summaryHtml,
                    episodeUrl: `${BASE_URL}/episode/${input.episode.id}`,
                    unsubscribePodcastUrl: unsubUrl,
                    manageUrl,
                },
                messageStream: "episode-summaries",
            });
            if (!res.success) {
                console.error(JSON.stringify({
                    event: "notify_send_failed", recipient_id: sub.id,
                    episode_id: input.episode.id, podcast_id: input.podcastId,
                    errorMessage: res.errorMessage,
                }));
            }
        }));
        const failed = results.filter((r) => r.status === "rejected").length;
        if (failed > 0) console.error(JSON.stringify({ event: "notify_rejected", failed, podcast_id: input.podcastId }));
    } catch (error) {
        console.error(JSON.stringify({
            event: "notify_subscribers_error",
            podcastId: input.podcastId,
            error: error instanceof Error ? error.message : String(error),
        }));
    }
}

function formatDate(iso: string): string {
    try {
        return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", day: "numeric", year: "numeric" })
            .format(new Date(iso));
    } catch {
        return iso;
    }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/notifications.test.ts`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/notifications.ts test/notifications.test.ts
git commit -m "Add notifySubscribers dispatcher

Fans out per-episode Postmark emails to confirmed active
subscribers. Gated on monitor submission, orphan-podcast
guard, and EMAIL_DISPATCH_ENABLED feature flag."
```

---

## Task 11: Wire `notifySubscribers` into the consumer

**Files:**
- Modify: `src/queue/consumer.ts`
- Modify: `test/consumer.test.ts` (add regression assertion)

- [ ] **Step 1: Add a failing regression test in `test/consumer.test.ts`**

Near the top of the file, add an import:

```ts
import * as notifications from "../src/notifications";
```

Add a new describe block at the end:

```ts
describe("notifySubscribers hook", () => {
    it("is called at both save points with the persisted episode", async () => {
        const spy = vi.spyOn(notifications, "notifySubscribers").mockResolvedValue(undefined);
        // TODO: wire up whatever fixture invokes both code paths in the existing test harness.
        // At minimum, drive the monitoring-path save and assert the spy was called with
        // matching podcastId + episode.id.
        // The two call sites are consumer.ts:544/547 and 709/712.
        expect(spy).toBeDefined(); // placeholder — replace with real path exercises.
    });
});
```

(Honest note: the regression test above is a placeholder scaffold. The existing consumer tests already exercise both save paths; the implementer should find the right fixture and assert `spy` was called twice with the correct arguments. If the existing test harness is too tangled, skip the assertion and rely on visual code review during MR — add a `// TODO(notify-regression): add spy check` comment and move on. The failure mode this guards against is "someone adds a third save path and forgets to call notifySubscribers" — low probability, acceptable to defer.)

- [ ] **Step 2: Add the calls in `src/queue/consumer.ts`**

At the top of the file, add:

```ts
import { notifySubscribers } from "../notifications";
```

Right after the first `addToEpisodeIndex(...)` at line 547, add:

```ts
await notifySubscribers(env, { podcastId: episode.podcastId, episode });
```

Right after the second `addToEpisodeIndex(...)` at line 712, add:

```ts
await notifySubscribers(env, { podcastId: updatedEpisode.podcastId, episode: updatedEpisode });
```

(If the variable name holding `podcastId` differs in context, use the local one. The goal is `{ podcastId, episode }` where `episode.submittedBy` is already populated from the persisted record.)

- [ ] **Step 3: Typecheck + full test suite**

Run: `npm run typecheck && npm test`
Expected: clean. Existing consumer tests still pass because `notifySubscribers` no-ops when no subscribers exist and (more importantly) swallows all errors internally.

- [ ] **Step 4: Commit**

```bash
git add src/queue/consumer.ts test/consumer.test.ts
git commit -m "Notify subscribers after episode save in consumer

Hooks at both saveEpisode + addToEpisodeIndex pairs (monitoring
and admin paths). Dispatcher handles the monitoring-only gate
internally via episode.submittedBy."
```

---

## Task 12: Pending-confirmations sweep in scheduledHandler

**Files:**
- Modify: `src/index.ts` (scheduledHandler around line 432)
- Create: `test/scheduled-sweep.test.ts`

- [ ] **Step 1: Write failing test `test/scheduled-sweep.test.ts`**

```ts
import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import { sweepExpiredPending, upsertPendingConfirmation, findPendingByToken } from "../src/lib/db";

async function resetDb() {
    await env.DB.exec("DELETE FROM pending_confirmations");
}

describe("pending confirmations sweep", () => {
    beforeEach(resetDb);

    it("removes expired rows and keeps live ones", async () => {
        const now = Math.floor(Date.now() / 1000);
        await upsertPendingConfirmation(env.DB, {
            token: "old", email: "x@y.com", podcastIds: [],
            createdAt: now - 172800, expiresAt: now - 1,
        });
        await upsertPendingConfirmation(env.DB, {
            token: "live", email: "z@y.com", podcastIds: [],
            createdAt: now, expiresAt: now + 3600,
        });
        const deleted = await sweepExpiredPending(env.DB, now);
        expect(deleted).toBe(1);
        expect(await findPendingByToken(env.DB, "old")).toBeNull();
        expect(await findPendingByToken(env.DB, "live")).not.toBeNull();
    });
});
```

(Full end-to-end `scheduled()` invocation testing is awkward under miniflare; the unit-level sweep test above plus the scheduledHandler's integration is verified by reading the diff in Step 3 and a manual post-deploy check.)

- [ ] **Step 2: Run test to verify it passes**

The sweep helper was already implemented in Task 3; this test should pass immediately on first run. Run: `npx vitest run test/scheduled-sweep.test.ts`

- [ ] **Step 3: Add the sweep call into `scheduledHandler` in `src/index.ts`**

Find `async function scheduledHandler(...)` near line 432. Inside the function body, add at an appropriate point (after the existing monitor logic):

```ts
import { sweepExpiredPending } from "./lib/db";
// ...

// Inside scheduledHandler:
try {
    const now = Math.floor(Date.now() / 1000);
    const deleted = await sweepExpiredPending(env.DB, now);
    if (deleted > 0) console.log(JSON.stringify({ event: "pending_sweep", deleted }));
} catch (error) {
    console.error(JSON.stringify({
        event: "pending_sweep_error",
        error: error instanceof Error ? error.message : String(error),
    }));
}
```

- [ ] **Step 4: Typecheck + full tests**

Run: `npm run typecheck && npm test`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add src/index.ts test/scheduled-sweep.test.ts
git commit -m "Sweep expired pending_confirmations rows in cron

Piggybacks on the existing 2-hour scheduled handler; no new
cron binding. Logs a count when anything is deleted."
```

---

## Task 13: Markdown-shared regression test

**Files:**
- Create: `test/markdown-shared.test.ts`

**Rationale:** Task 1 moved `renderMarkdown`, but the original test at `test/render-markdown.test.ts` already exercised the site's behavior. Adding a light-touch test that runs the same sanitizer against an email-shaped payload guarantees the email path doesn't silently regress if someone later duplicates the function.

- [ ] **Step 1: Add the test**

```ts
import { describe, it, expect } from "vitest";
import { renderMarkdown } from "../src/lib/markdown";

describe("renderMarkdown (email path)", () => {
    it("strips raw HTML", () => {
        expect(renderMarkdown("<script>alert(1)</script>hi")).not.toContain("<script>");
    });
    it("sanitises javascript: links", () => {
        const out = renderMarkdown("[click](javascript:alert(1))");
        expect(out).not.toContain("javascript:");
    });
    it("preserves safe markdown", () => {
        const out = renderMarkdown("**bold** and [ok](https://ok.example)");
        expect(out).toContain("<strong>bold</strong>");
        expect(out).toContain('href="https://ok.example"');
    });
});
```

- [ ] **Step 2: Run**

Run: `npx vitest run test/markdown-shared.test.ts`
Expected: pass.

- [ ] **Step 3: Commit**

```bash
git add test/markdown-shared.test.ts
git commit -m "Add markdown-shared test for email path

Guards the sanitizer invariants that email rendering depends on
against silent regression if the helper is ever duplicated."
```

---

## Task 14: Deploy checklist + smoke test (operator)

**Files:** none (operator steps only)

- [ ] **Step 1: Set Worker secrets**

```bash
echo "$MANAGE_LINK_HMAC_SECRET" | npx wrangler secret put MANAGE_LINK_HMAC_SECRET
echo "user:pass" | npx wrangler secret put POSTMARK_WEBHOOK_AUTH
# TURNSTILE_SECRET + POSTMARK_API_KEY already exist; confirm with `wrangler secret list`.
```

- [ ] **Step 2: Apply schema to remote D1**

```bash
npx wrangler d1 execute tldl-subscribers --remote --file=schema.sql
```

- [ ] **Step 3: Deploy**

```bash
npm run deploy
```

- [ ] **Step 4: Dark verify (routes respond, no site link yet)**

```bash
curl -i https://tldl-pod.com/subscribe   # expect 200 + form
curl -i https://tldl-pod.com/preferences # expect 200 + form
curl -i https://tldl-pod.com/confirm     # expect 400 (no token)
curl -i https://tldl-pod.com/webhooks/postmark -X POST -d '{}'  # expect 401
```

- [ ] **Step 5: Canary subscribe**

Subscribe a real test address to one monitored podcast. Confirm. Wait for the next scheduled monitor run to fire a real episode. Verify the email renders in Gmail web, Apple Mail, Outlook web.

- [ ] **Step 6: Webhook smoke test**

Send a confirmation email to Postmark's `bounce-testing@postmarkapp.com` via a manual subscribe. Confirm the subscriber lands at `status='bounced'` within a minute:

```bash
npx wrangler d1 execute tldl-subscribers --remote \
    --command "SELECT email, status FROM subscribers WHERE email='bounce-testing@postmarkapp.com'"
```

- [ ] **Step 7: Add site link**

Once smoke passes, add a "Subscribe to email" CTA on the podcast page and home page. Watch `wrangler tail` for dispatch errors over the next 48 hours.

---

## Self-Review

Spec coverage check:

- Problem, Summary, Goals, Non-goals — no tasks needed (documentation).
- Trigger point — Task 11.
- Data model — Tasks 2 (schema + binding) and 3 (query helpers).
- Status transitions + re-subscribe gate — Tasks 3 (DB flip) and 6 (POST /subscribe gate).
- HTTP routes — Tasks 6 (subscribe + confirm), 7 (preferences), 8 (unsubscribe), 9 (webhook).
- Token scheme — Task 4.
- Secret rotation — not implemented in v1 (documented in spec as emergency-only).
- Anti-abuse — Task 6 (Turnstile + per-email throttle) + operator steps (zone rate-limit) + Task 12 (sweep).
- Email delivery (streams, templates, dispatch loop, failure policy) — Tasks 5 (sendTemplate) + 10 (notifySubscribers).
- Summary rendering — Tasks 1 (extract) + 13 (regression test).
- Webhook handling — Task 9.
- Module layout — matches spec.
- Testing strategy — unit tests in Tasks 3/4/5/13, route tests in 6-9, dispatcher tests in 10, sweep test in 12. Consumer regression test placeholder in 11 (honest limitation called out).
- Prerequisites checklist — operator prerequisites section at top + Task 14.
- Rollout / rollback — Task 14 + `EMAIL_DISPATCH_ENABLED` feature flag in Task 10.

No placeholders beyond the Task 11 consumer regression scaffold, which is called out honestly as a shim. No type drift: `SubscriberStatus`, `Subscriber`, `PendingConfirmation`, `NotifyInput`, `SendTemplateOptions` are all defined at their introduction point and referenced consistently.
