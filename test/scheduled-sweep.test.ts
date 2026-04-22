import { env, applyD1Migrations } from "cloudflare:test";
import { describe, it, expect, beforeAll, beforeEach, inject } from "vitest";
import { sweepExpiredPending, upsertPendingConfirmation, findPendingByToken } from "../src/lib/db";

beforeAll(async () => {
    await applyD1Migrations(env.DB, inject("DB_MIGRATIONS"));
});

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

    it("returns 0 when nothing to delete", async () => {
        const now = Math.floor(Date.now() / 1000);
        expect(await sweepExpiredPending(env.DB, now)).toBe(0);
    });
});
