import { env, SELF, applyD1Migrations } from "cloudflare:test";
import { describe, it, expect, beforeAll, beforeEach, inject } from "vitest";

beforeAll(async () => {
    await applyD1Migrations(env.DB, inject("DB_MIGRATIONS"));
});

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

    it("rejects wrong credentials", async () => {
        const res = await SELF.fetch("https://tldl-pod.com/webhooks/postmark", {
            method: "POST",
            headers: { "content-type": "application/json", authorization: basicAuthHeader("wrong:creds") },
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

    it("SubscriptionChange (SuppressSending=true) marks complained + wipes subscriptions", async () => {
        const now = Math.floor(Date.now() / 1000);
        await env.DB.prepare(
            "INSERT INTO subscribers (id, email, confirmed_at, created_at, updated_at, status) VALUES (?, ?, ?, ?, ?, 'active')"
        ).bind(103, "sc@example.com", now, now, now).run();
        await env.DB.prepare(
            "INSERT INTO subscriptions (subscriber_id, podcast_id, created_at) VALUES (?, ?, ?)"
        ).bind(103, "p1", now).run();
        const res = await SELF.fetch("https://tldl-pod.com/webhooks/postmark", {
            method: "POST",
            headers: { "content-type": "application/json", authorization: basicAuthHeader("u:p") },
            body: JSON.stringify({ RecordType: "SubscriptionChange", Recipient: "sc@example.com", SuppressSending: true }),
        });
        expect(res.status).toBe(200);
        const sub = await env.DB.prepare("SELECT status FROM subscribers WHERE email=?").bind("sc@example.com").first();
        expect((sub as any).status).toBe("complained");
        const subs = await env.DB.prepare("SELECT COUNT(*) AS n FROM subscriptions WHERE subscriber_id=?").bind(103).first<{ n: number }>();
        expect(subs!.n).toBe(0);
    });

    it("SubscriptionChange with SuppressSending=false is ignored", async () => {
        const now = Math.floor(Date.now() / 1000);
        await env.DB.prepare(
            "INSERT INTO subscribers (id, email, confirmed_at, created_at, updated_at, status) VALUES (?, ?, ?, ?, ?, 'active')"
        ).bind(104, "r@example.com", now, now, now).run();
        const res = await SELF.fetch("https://tldl-pod.com/webhooks/postmark", {
            method: "POST",
            headers: { "content-type": "application/json", authorization: basicAuthHeader("u:p") },
            body: JSON.stringify({ RecordType: "SubscriptionChange", Recipient: "r@example.com", SuppressSending: false }),
        });
        expect(res.status).toBe(200);
        const sub = await env.DB.prepare("SELECT status FROM subscribers WHERE email=?").bind("r@example.com").first();
        expect((sub as any).status).toBe("active");
    });

    it("unknown event types are a no-op 200", async () => {
        const res = await SELF.fetch("https://tldl-pod.com/webhooks/postmark", {
            method: "POST",
            headers: { "content-type": "application/json", authorization: basicAuthHeader("u:p") },
            body: JSON.stringify({ RecordType: "Open", Email: "who@cares" }),
        });
        expect(res.status).toBe(200);
    });

    it("missing email is a no-op 200", async () => {
        const res = await SELF.fetch("https://tldl-pod.com/webhooks/postmark", {
            method: "POST",
            headers: { "content-type": "application/json", authorization: basicAuthHeader("u:p") },
            body: JSON.stringify({ RecordType: "Bounce", Type: "HardBounce" }),
        });
        expect(res.status).toBe(200);
    });

    it("malformed JSON returns 400", async () => {
        const res = await SELF.fetch("https://tldl-pod.com/webhooks/postmark", {
            method: "POST",
            headers: { "content-type": "application/json", authorization: basicAuthHeader("u:p") },
            body: "not json",
        });
        expect(res.status).toBe(400);
    });

    it("duplicate webhook is idempotent", async () => {
        const now = Math.floor(Date.now() / 1000);
        await env.DB.prepare(
            "INSERT INTO subscribers (id, email, confirmed_at, created_at, updated_at, status) VALUES (?, ?, ?, ?, ?, 'active')"
        ).bind(105, "d@example.com", now, now, now).run();
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
