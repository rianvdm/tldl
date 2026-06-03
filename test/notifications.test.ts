import { env, applyD1Migrations } from "cloudflare:test";
import { describe, it, expect, beforeAll, beforeEach, vi, inject } from "vitest";
import type { Env } from "../src/types";
import { notifySubscribers } from "../src/notifications";

function testEnv(overrides: Record<string, unknown> = {}): Env {
    return { ...env, ...overrides } as unknown as Env;
}

beforeAll(async () => {
    await applyD1Migrations(env.DB, inject("DB_MIGRATIONS"));
});

async function resetDb() {
    await env.DB.exec("DELETE FROM subscriptions");
    await env.DB.exec("DELETE FROM pending_confirmations");
    await env.DB.exec("DELETE FROM subscribers");
    const keys = await env.TLDL_DATA.list({ prefix: "monitored:" });
    for (const k of keys.keys) await env.TLDL_DATA.delete(k.name);
}

async function seedMonitoredPodcast(id: string, extra: Record<string, unknown> = {}) {
    await env.TLDL_DATA.put(`monitored:${id}`, JSON.stringify({
        id, name: "Test Podcast",
        websiteUrl: "https://example.com",
        coverUrl: "https://img.example.com/cover.jpg",
        addedAt: Date.now(),
        ...extra,
    }));
    const existing = await env.TLDL_DATA.get("monitored:list");
    const list: string[] = existing ? JSON.parse(existing) : [];
    if (!list.includes(id)) list.push(id);
    await env.TLDL_DATA.put("monitored:list", JSON.stringify(list));
}

function fakeEpisode(overrides: Record<string, unknown> = {}) {
    return {
        id: "ep1",
        podcastId: "p1",
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
        await notifySubscribers(testEnv(), {
            podcastId: "p1",
            episode: fakeEpisode({ submittedBy: "human@tldl.app" }),
        });
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("no-ops when the podcast is no longer monitored (orphan guard)", async () => {
        const now = Math.floor(Date.now() / 1000);
        await env.DB.prepare(
            "INSERT INTO subscribers (id, email, confirmed_at, created_at, updated_at, status) VALUES (?, ?, ?, ?, ?, 'active')"
        ).bind(1, "a@example.com", now, now, now).run();
        await env.DB.prepare(
            "INSERT INTO subscriptions (subscriber_id, podcast_id, created_at) VALUES (?, ?, ?)"
        ).bind(1, "p1", now).run();

        const fetchSpy = vi.spyOn(globalThis, "fetch");
        await notifySubscribers(testEnv(), { podcastId: "p1", episode: fakeEpisode() });
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("sends one email per confirmed active subscriber; bounced filtered out", async () => {
        await seedMonitoredPodcast("p1");
        const now = Math.floor(Date.now() / 1000);
        await env.DB.batch([
            env.DB.prepare("INSERT INTO subscribers (id, email, confirmed_at, created_at, updated_at, status) VALUES (?, ?, ?, ?, ?, 'active')").bind(10, "one@example.com", now, now, now),
            env.DB.prepare("INSERT INTO subscribers (id, email, confirmed_at, created_at, updated_at, status) VALUES (?, ?, ?, ?, ?, 'active')").bind(11, "two@example.com", now, now, now),
            env.DB.prepare("INSERT INTO subscribers (id, email, confirmed_at, created_at, updated_at, status) VALUES (?, ?, ?, ?, ?, 'bounced')").bind(12, "bounced@example.com", now, now, now),
        ]);
        await env.DB.batch([
            env.DB.prepare("INSERT INTO subscriptions (subscriber_id, podcast_id, created_at) VALUES (?, ?, ?)").bind(10, "p1", now),
            env.DB.prepare("INSERT INTO subscriptions (subscriber_id, podcast_id, created_at) VALUES (?, ?, ?)").bind(11, "p1", now),
            env.DB.prepare("INSERT INTO subscriptions (subscriber_id, podcast_id, created_at) VALUES (?, ?, ?)").bind(12, "p1", now),
        ]);

        const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
            new Response(JSON.stringify({ MessageID: "x" }), { status: 200 })
        );
        await notifySubscribers(testEnv(), { podcastId: "p1", episode: fakeEpisode() });

        const postmarkCalls = fetchSpy.mock.calls.filter(([u]) => {
            const url = typeof u === "string" ? u : (u as URL).toString();
            return url.includes("/email/withTemplate");
        });
        expect(postmarkCalls.length).toBe(2);
        const recipients = postmarkCalls.map(([_u, init]) => JSON.parse((init as RequestInit).body as string).To).sort();
        expect(recipients).toEqual(["one@example.com", "two@example.com"]);
    });

    it("uses the episode-summaries broadcast stream", async () => {
        await seedMonitoredPodcast("p1");
        const now = Math.floor(Date.now() / 1000);
        await env.DB.prepare(
            "INSERT INTO subscribers (id, email, confirmed_at, created_at, updated_at, status) VALUES (?, ?, ?, ?, ?, 'active')"
        ).bind(20, "e@example.com", now, now, now).run();
        await env.DB.prepare("INSERT INTO subscriptions VALUES (?, ?, ?)").bind(20, "p1", now).run();

        const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
            new Response(JSON.stringify({ MessageID: "x" }), { status: 200 })
        );
        await notifySubscribers(testEnv(), { podcastId: "p1", episode: fakeEpisode() });
        const body = JSON.parse((fetchSpy.mock.calls[0]![1] as RequestInit).body as string);
        expect(body.MessageStream).toBe("episode-summaries");
        expect(body.TemplateAlias).toBe("episode-summary");
        expect(body.TemplateModel.podcastName).toBe("Test Podcast");
        expect(body.TemplateModel.episodeUrl).toContain("/episode/ep1");
        expect(body.TemplateModel.summaryHtml).toContain("<h1>");
    });

    it("threads deck and pullQuote into the template model when present (#34)", async () => {
        await seedMonitoredPodcast("p1");
        const now = Math.floor(Date.now() / 1000);
        await env.DB.prepare(
            "INSERT INTO subscribers (id, email, confirmed_at, created_at, updated_at, status) VALUES (?, ?, ?, ?, ?, 'active')"
        ).bind(40, "deck@example.com", now, now, now).run();
        await env.DB.prepare("INSERT INTO subscriptions VALUES (?, ?, ?)").bind(40, "p1", now).run();

        const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
            new Response(JSON.stringify({ MessageID: "x" }), { status: 200 })
        );
        await notifySubscribers(testEnv(), {
            podcastId: "p1",
            episode: fakeEpisode({ deck: "A sharp editorial deck.", pullQuote: "The one quote." }),
        });
        const body = JSON.parse((fetchSpy.mock.calls[0]![1] as RequestInit).body as string);
        expect(body.TemplateModel.episodeDeck).toBe("A sharp editorial deck.");
        expect(body.TemplateModel.pullQuote).toBe("The one quote.");
    });

    it("passes empty strings for missing deck/pullQuote so the sections collapse (#34)", async () => {
        await seedMonitoredPodcast("p1");
        const now = Math.floor(Date.now() / 1000);
        await env.DB.prepare(
            "INSERT INTO subscribers (id, email, confirmed_at, created_at, updated_at, status) VALUES (?, ?, ?, ?, ?, 'active')"
        ).bind(41, "nodeck@example.com", now, now, now).run();
        await env.DB.prepare("INSERT INTO subscriptions VALUES (?, ?, ?)").bind(41, "p1", now).run();

        const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
            new Response(JSON.stringify({ MessageID: "x" }), { status: 200 })
        );
        await notifySubscribers(testEnv(), { podcastId: "p1", episode: fakeEpisode() });
        const body = JSON.parse((fetchSpy.mock.calls[0]![1] as RequestInit).body as string);
        expect(body.TemplateModel.episodeDeck).toBe("");
        expect(body.TemplateModel.pullQuote).toBe("");
    });

    it("continues even if one recipient send fails", async () => {
        await seedMonitoredPodcast("p1");
        const now = Math.floor(Date.now() / 1000);
        await env.DB.batch([
            env.DB.prepare("INSERT INTO subscribers (id, email, confirmed_at, created_at, updated_at, status) VALUES (?, ?, ?, ?, ?, 'active')").bind(30, "a@example.com", now, now, now),
            env.DB.prepare("INSERT INTO subscribers (id, email, confirmed_at, created_at, updated_at, status) VALUES (?, ?, ?, ?, ?, 'active')").bind(31, "b@example.com", now, now, now),
        ]);
        await env.DB.batch([
            env.DB.prepare("INSERT INTO subscriptions VALUES (?, ?, ?)").bind(30, "p1", now),
            env.DB.prepare("INSERT INTO subscriptions VALUES (?, ?, ?)").bind(31, "p1", now),
        ]);

        let calls = 0;
        vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
            calls += 1;
            if (calls === 1) return new Response("boom", { status: 500 });
            return new Response(JSON.stringify({ MessageID: "x" }), { status: 200 });
        });

        await expect(notifySubscribers(testEnv(), { podcastId: "p1", episode: fakeEpisode() })).resolves.toBeUndefined();
        expect(calls).toBe(2);
    });

    it("returns early when EMAIL_DISPATCH_ENABLED=false", async () => {
        await seedMonitoredPodcast("p1");
        const now = Math.floor(Date.now() / 1000);
        await env.DB.prepare(
            "INSERT INTO subscribers (id, email, confirmed_at, created_at, updated_at, status) VALUES (?, ?, ?, ?, ?, 'active')"
        ).bind(40, "kill@example.com", now, now, now).run();
        await env.DB.prepare("INSERT INTO subscriptions VALUES (?, ?, ?)").bind(40, "p1", now).run();
        const fetchSpy = vi.spyOn(globalThis, "fetch");

        await notifySubscribers(testEnv({ EMAIL_DISPATCH_ENABLED: "false" }), { podcastId: "p1", episode: fakeEpisode() });
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("no-ops when zero confirmed subscribers", async () => {
        await seedMonitoredPodcast("p1");
        const fetchSpy = vi.spyOn(globalThis, "fetch");
        await notifySubscribers(testEnv(), { podcastId: "p1", episode: fakeEpisode() });
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("omits podcastWebsiteUrl when neither episode nor podcast has one", async () => {
        await seedMonitoredPodcast("p1", { websiteUrl: undefined });
        const now = Math.floor(Date.now() / 1000);
        await env.DB.prepare(
            "INSERT INTO subscribers (id, email, confirmed_at, created_at, updated_at, status) VALUES (?, ?, ?, ?, ?, 'active')"
        ).bind(50, "f@example.com", now, now, now).run();
        await env.DB.prepare("INSERT INTO subscriptions VALUES (?, ?, ?)").bind(50, "p1", now).run();

        const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
            new Response(JSON.stringify({ MessageID: "x" }), { status: 200 })
        );
        await notifySubscribers(testEnv(), {
            podcastId: "p1",
            episode: fakeEpisode({ podcastWebsiteUrl: undefined }),
        });
        const body = JSON.parse((fetchSpy.mock.calls[0]![1] as RequestInit).body as string);
        expect(body.TemplateModel.podcastWebsiteUrl).toBeUndefined();
    });
});
