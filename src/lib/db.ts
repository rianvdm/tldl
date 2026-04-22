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

export async function getSubscriberById(db: D1Database, id: number): Promise<Subscriber | null> {
    const row = await db.prepare(
        "SELECT id, email, confirmed_at, created_at, updated_at, status FROM subscribers WHERE id = ?"
    ).bind(id).first<{ id: number; email: string; confirmed_at: number | null; created_at: number; updated_at: number; status: SubscriberStatus }>();
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
 * Consumes the pending row, upserts the subscriber (flipping `bounced` back to `active`
 * if applicable), inserts the subscription rows, and deletes the pending row.
 * Returns the subscriber on success, null if the token does not exist or is expired.
 */
export async function confirmSubscriber(db: D1Database, token: string, now: number): Promise<Subscriber | null> {
    const pending = await findPendingByToken(db, token);
    if (!pending || pending.expiresAt < now) return null;

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
