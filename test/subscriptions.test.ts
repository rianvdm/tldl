import { env, SELF } from "cloudflare:test";
import { describe, it, expect, beforeAll, beforeEach, vi, inject } from "vitest";
import { applyD1Migrations } from "cloudflare:test";
import { signToken, manageMessage, unsubMessage, unsubAllMessage } from "../src/lib/emailTokens";
import { listSubscriptionsForSubscriber } from "../src/lib/db";

beforeAll(async () => {
    await applyD1Migrations(env.DB, inject("DB_MIGRATIONS"));
});

async function resetDb() {
    await env.DB.exec("DELETE FROM subscriptions");
    await env.DB.exec("DELETE FROM pending_confirmations");
    await env.DB.exec("DELETE FROM subscribers");
    await env.TLDL_DATA.delete("monitored:list");
    // Remove per-podcast monitored keys if any — safe no-op if absent.
    const keys = await env.TLDL_DATA.list({ prefix: "monitored:" });
    for (const k of keys.keys) await env.TLDL_DATA.delete(k.name);
}

async function seedMonitoredPodcasts() {
    // The KV shape for monitored podcasts is what the existing `getMonitoredPodcast`
    // expects. Seed two podcasts so /subscribe has options to show, and /confirm
    // has something to attach subscriptions to.
    const p1 = { id: "p1", name: "Podcast One", websiteUrl: "https://one.example", coverUrl: "https://i/1", addedAt: Date.now() };
    const p2 = { id: "p2", name: "Podcast Two", websiteUrl: "https://two.example", coverUrl: "https://i/2", addedAt: Date.now() };
    await env.TLDL_DATA.put("monitored:p1", JSON.stringify(p1));
    await env.TLDL_DATA.put("monitored:p2", JSON.stringify(p2));
    await env.TLDL_DATA.put("monitored:list", JSON.stringify(["p1", "p2"]));
}

function mockPostmarkAndTurnstileOk() {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
        const u = typeof url === "string" ? url : url.toString();
        if (u.startsWith("https://challenges.cloudflare.com")) {
            return new Response(JSON.stringify({ success: true }), { status: 200 });
        }
        if (u.startsWith("https://api.postmarkapp.com")) {
            return new Response(JSON.stringify({ MessageID: "m1" }), { status: 200 });
        }
        return new Response("not stubbed", { status: 500 });
    });
}

describe("GET /subscribe", () => {
    beforeEach(async () => { await resetDb(); await seedMonitoredPodcasts(); vi.restoreAllMocks(); });

    it("renders a form with the monitored podcasts", async () => {
        const res = await SELF.fetch("https://tldl-pod.com/subscribe");
        expect(res.status).toBe(200);
        const body = await res.text();
        expect(body).toContain('name="email"');
        expect(body).toContain("Podcast One");
        expect(body).toContain("Podcast Two");
    });
});

describe("POST /subscribe", () => {
    beforeEach(async () => { await resetDb(); await seedMonitoredPodcasts(); vi.restoreAllMocks(); });

    it("creates a pending_confirmations row and sends confirmation email", async () => {
        mockPostmarkAndTurnstileOk();
        const res = await SELF.fetch("https://tldl-pod.com/subscribe", {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams([
                ["email", "alice@example.com"],
                ["cf-turnstile-response", "test-token"],
                ["podcastIds", "p1"],
                ["podcastIds", "p2"],
            ]),
        });
        expect(res.status).toBe(200);
        expect(await res.text()).toContain("check your inbox");
        const row = await env.DB.prepare("SELECT email, podcast_ids FROM pending_confirmations WHERE email=?")
            .bind("alice@example.com").first();
        expect(row).not.toBeNull();
        expect(JSON.parse((row as any).podcast_ids)).toEqual(["p1", "p2"]);
    });

    it("silently drops when a complained subscriber resubscribes", async () => {
        mockPostmarkAndTurnstileOk();
        const now = Math.floor(Date.now() / 1000);
        await env.DB.prepare(
            "INSERT INTO subscribers (email, confirmed_at, created_at, updated_at, status) VALUES (?, ?, ?, ?, 'complained')"
        ).bind("bad@example.com", now, now, now).run();

        const res = await SELF.fetch("https://tldl-pod.com/subscribe", {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams([
                ["email", "bad@example.com"],
                ["cf-turnstile-response", "test-token"],
                ["podcastIds", "p1"],
            ]),
        });
        expect(res.status).toBe(200);
        expect(await res.text()).toContain("check your inbox");
        const row = await env.DB.prepare("SELECT 1 FROM pending_confirmations WHERE email=?")
            .bind("bad@example.com").first();
        expect(row).toBeNull();
    });

    it("deduplicates a second submit within the pending window (per-email throttle)", async () => {
        mockPostmarkAndTurnstileOk();
        const submit = () => SELF.fetch("https://tldl-pod.com/subscribe", {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams([
                ["email", "c@example.com"],
                ["cf-turnstile-response", "test-token"],
                ["podcastIds", "p1"],
            ]),
        });
        await submit();
        await submit();
        const rows = await env.DB.prepare("SELECT COUNT(*) AS n FROM pending_confirmations WHERE email=?")
            .bind("c@example.com").first<{ n: number }>();
        expect(rows!.n).toBe(1);
    });

    it("rejects missing email", async () => {
        mockPostmarkAndTurnstileOk();
        const res = await SELF.fetch("https://tldl-pod.com/subscribe", {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams([
                ["cf-turnstile-response", "test-token"],
                ["podcastIds", "p1"],
            ]),
        });
        expect(res.status).toBe(400);
    });

    it("rejects when Turnstile fails", async () => {
        vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
            const u = typeof url === "string" ? url : url.toString();
            if (u.startsWith("https://challenges.cloudflare.com")) {
                return new Response(JSON.stringify({ success: false }), { status: 200 });
            }
            return new Response(JSON.stringify({ MessageID: "m1" }), { status: 200 });
        });
        const res = await SELF.fetch("https://tldl-pod.com/subscribe", {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams([
                ["email", "d@example.com"],
                ["cf-turnstile-response", "bad-token"],
                ["podcastIds", "p1"],
            ]),
        });
        expect(res.status).toBe(403);
    });
});

describe("GET /confirm", () => {
    beforeEach(async () => { await resetDb(); await seedMonitoredPodcasts(); vi.restoreAllMocks(); });

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

describe("GET /preferences", () => {
    beforeEach(async () => { await resetDb(); await seedMonitoredPodcasts(); vi.restoreAllMocks(); });

    it("renders an email-entry form", async () => {
        const res = await SELF.fetch("https://tldl-pod.com/preferences");
        expect(res.status).toBe(200);
        expect(await res.text()).toContain('name="email"');
    });
});

describe("POST /preferences", () => {
    beforeEach(async () => { await resetDb(); await seedMonitoredPodcasts(); vi.restoreAllMocks(); });

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
            body: new URLSearchParams([["email", "a@example.com"]]),
        });
        expect(res.status).toBe(200);
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
            body: new URLSearchParams([["email", "new@example.com"]]),
        });
        expect(res.status).toBe(200);
        const postmarkCall = fetchSpy.mock.calls.find(([url]) =>
            typeof url === "string" && url.includes("/email/withTemplate")
        );
        const body = JSON.parse((postmarkCall![1] as RequestInit).body as string);
        expect(body.TemplateAlias).toBe("confirm-subscription");
    });

    it("silently drops for complained subscribers", async () => {
        const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
            new Response(JSON.stringify({ MessageID: "m" }), { status: 200 })
        );
        const now = Math.floor(Date.now() / 1000);
        await env.DB.prepare(
            "INSERT INTO subscribers (email, confirmed_at, created_at, updated_at, status) VALUES (?, ?, ?, ?, 'complained')"
        ).bind("comp@example.com", now, now, now).run();

        const res = await SELF.fetch("https://tldl-pod.com/preferences", {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams([["email", "comp@example.com"]]),
        });
        expect(res.status).toBe(200);
        const postmarkCall = fetchSpy.mock.calls.find(([url]) =>
            typeof url === "string" && url.includes("/email/withTemplate")
        );
        expect(postmarkCall).toBeUndefined();
    });
});

describe("GET /preferences/manage", () => {
    beforeEach(async () => { await resetDb(); await seedMonitoredPodcasts(); vi.restoreAllMocks(); });

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
        // Pre-populated checkbox for p1 should be checked; p2 unchecked
        expect(html).toMatch(/value="p1"[^>]*checked/);
    });

    it("rejects an invalid token", async () => {
        const badToken = "deadbeef".padEnd(32, "0");
        const res = await SELF.fetch(`https://tldl-pod.com/preferences/manage?s=10&token=${badToken}`);
        expect(res.status).toBe(403);
    });

    it("rejects a token for a subscriber that doesn't exist", async () => {
        const secret = "test-hmac-secret-32-bytes-exactly!";
        const token = await signToken(secret, manageMessage(999, "ghost@example.com"));
        const res = await SELF.fetch(`https://tldl-pod.com/preferences/manage?s=999&token=${token}`);
        expect(res.status).toBe(403);
    });
});

describe("POST /preferences/manage", () => {
    beforeEach(async () => { await resetDb(); await seedMonitoredPodcasts(); vi.restoreAllMocks(); });

    it("replaces the subscriber's subscriptions atomically", async () => {
        const now = Math.floor(Date.now() / 1000);
        await env.DB.prepare(
            "INSERT INTO subscribers (id, email, confirmed_at, created_at, updated_at, status) VALUES (?, ?, ?, ?, ?, 'active')"
        ).bind(20, "u@example.com", now, now, now).run();
        await env.DB.prepare(
            "INSERT INTO subscriptions (subscriber_id, podcast_id, created_at) VALUES (?, ?, ?)"
        ).bind(20, "p1", now).run();

        const secret = "test-hmac-secret-32-bytes-exactly!";
        const token = await signToken(secret, manageMessage(20, "u@example.com"));
        const res = await SELF.fetch("https://tldl-pod.com/preferences/manage", {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams([
                ["s", "20"],
                ["token", token],
                ["podcastIds", "p2"],
            ]),
        });
        expect(res.status).toBe(200);
        const final = await listSubscriptionsForSubscriber(env.DB, 20);
        expect(final).toEqual(["p2"]);
    });

    it("rejects when status is not active", async () => {
        const now = Math.floor(Date.now() / 1000);
        await env.DB.prepare(
            "INSERT INTO subscribers (id, email, confirmed_at, created_at, updated_at, status) VALUES (?, ?, ?, ?, ?, 'bounced')"
        ).bind(21, "bounce@example.com", now, now, now).run();
        const secret = "test-hmac-secret-32-bytes-exactly!";
        const token = await signToken(secret, manageMessage(21, "bounce@example.com"));
        const res = await SELF.fetch("https://tldl-pod.com/preferences/manage", {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams([
                ["s", "21"],
                ["token", token],
                ["podcastIds", "p2"],
            ]),
        });
        expect(res.status).toBe(409);
    });
});

describe("GET /unsubscribe", () => {
    beforeEach(async () => { await resetDb(); await seedMonitoredPodcasts(); vi.restoreAllMocks(); });

    it("per-podcast: deletes the subscription and returns a done page", async () => {
        const now = Math.floor(Date.now() / 1000);
        await env.DB.prepare(
            "INSERT INTO subscribers (id, email, confirmed_at, created_at, updated_at, status) VALUES (?, ?, ?, ?, ?, 'active')"
        ).bind(30, "z@example.com", now, now, now).run();
        await env.DB.batch([
            env.DB.prepare("INSERT INTO subscriptions (subscriber_id, podcast_id, created_at) VALUES (?, ?, ?)").bind(30, "p1", now),
            env.DB.prepare("INSERT INTO subscriptions (subscriber_id, podcast_id, created_at) VALUES (?, ?, ?)").bind(30, "p2", now),
        ]);

        const secret = "test-hmac-secret-32-bytes-exactly!";
        const token = await signToken(secret, unsubMessage(30, "p1"));
        const res = await SELF.fetch(`https://tldl-pod.com/unsubscribe?s=30&p=p1&token=${token}`);
        expect(res.status).toBe(200);
        const remaining = await listSubscriptionsForSubscriber(env.DB, 30);
        expect(remaining).toEqual(["p2"]);
    });

    it("unsubscribe-all: deletes every subscription", async () => {
        const now = Math.floor(Date.now() / 1000);
        await env.DB.prepare(
            "INSERT INTO subscribers (id, email, confirmed_at, created_at, updated_at, status) VALUES (?, ?, ?, ?, ?, 'active')"
        ).bind(31, "y@example.com", now, now, now).run();
        await env.DB.batch([
            env.DB.prepare("INSERT INTO subscriptions (subscriber_id, podcast_id, created_at) VALUES (?, ?, ?)").bind(31, "p1", now),
            env.DB.prepare("INSERT INTO subscriptions (subscriber_id, podcast_id, created_at) VALUES (?, ?, ?)").bind(31, "p2", now),
        ]);

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

    it("rejects missing s or token", async () => {
        expect((await SELF.fetch("https://tldl-pod.com/unsubscribe?token=whatever")).status).toBe(403);
        expect((await SELF.fetch("https://tldl-pod.com/unsubscribe?s=1")).status).toBe(403);
    });
});

describe("POST /unsubscribe (RFC 8058)", () => {
    beforeEach(async () => { await resetDb(); await seedMonitoredPodcasts(); vi.restoreAllMocks(); });

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
            body: new URLSearchParams([["s", "40"], ["token", token]]),
        });
        expect(res.status).toBe(200);
        expect(await res.text()).toBe("");
    });

    it("POST per-podcast works", async () => {
        const now = Math.floor(Date.now() / 1000);
        await env.DB.prepare(
            "INSERT INTO subscribers (id, email, confirmed_at, created_at, updated_at, status) VALUES (?, ?, ?, ?, ?, 'active')"
        ).bind(41, "pp@example.com", now, now, now).run();
        await env.DB.prepare(
            "INSERT INTO subscriptions (subscriber_id, podcast_id, created_at) VALUES (?, ?, ?)"
        ).bind(41, "p1", now).run();
        const secret = "test-hmac-secret-32-bytes-exactly!";
        const token = await signToken(secret, unsubMessage(41, "p1"));
        const res = await SELF.fetch("https://tldl-pod.com/unsubscribe", {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams([["s", "41"], ["p", "p1"], ["token", token]]),
        });
        expect(res.status).toBe(200);
        expect(await listSubscriptionsForSubscriber(env.DB, 41)).toEqual([]);
    });
});
