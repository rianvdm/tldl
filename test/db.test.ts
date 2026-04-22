import { env, applyD1Migrations } from "cloudflare:test";
import { describe, it, expect, beforeEach, beforeAll, inject } from "vitest";
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
    listSubscriptionsForSubscriber,
    replaceSubscriptions,
    type SubscriberStatus,
} from "../src/lib/db";

async function resetDb(): Promise<void> {
    await env.DB.exec("DELETE FROM subscriptions");
    await env.DB.exec("DELETE FROM pending_confirmations");
    await env.DB.exec("DELETE FROM subscribers");
}

describe("db helpers", () => {
    beforeAll(async () => {
        const migrations = inject("DB_MIGRATIONS");
        await applyD1Migrations(env.DB, migrations);
    });

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

    it("listSubscriptionsForSubscriber returns sorted podcast ids", async () => {
        await upsertPendingConfirmation(env.DB, {
            token: "t9", email: "h@example.com", podcastIds: ["pB", "pA", "pC"],
            createdAt: 1000, expiresAt: 2000,
        });
        const sub = await confirmSubscriber(env.DB, "t9", 1500);
        expect(await listSubscriptionsForSubscriber(env.DB, sub!.id)).toEqual(["pA", "pB", "pC"]);
    });

    it("replaceSubscriptions wipes and inserts atomically", async () => {
        await upsertPendingConfirmation(env.DB, {
            token: "t10", email: "i@example.com", podcastIds: ["p1", "p2"],
            createdAt: 1000, expiresAt: 2000,
        });
        const sub = await confirmSubscriber(env.DB, "t10", 1500);
        await replaceSubscriptions(env.DB, sub!.id, ["p2", "p3"], 1600);
        expect((await listSubscriptionsForSubscriber(env.DB, sub!.id)).sort()).toEqual(["p2", "p3"]);
    });

    it("SubscriberStatus type exported", () => {
        const s: SubscriberStatus = "active";
        expect(s).toBe("active");
    });
});
