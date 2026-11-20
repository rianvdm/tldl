import { env, SELF } from "cloudflare:test";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createOgRoutes } from "../src/routes/og";
import { cardVersion } from "../src/lib/og/card-model";
import { saveEpisode, saveEpisodeRedirect, saveSummary } from "../src/lib/kv";
import { DEFAULT_OG_IMAGE } from "../src/lib/broadsheet/head";
import type { Episode } from "../src/types";

const ep: Episode = {
    id: "1769051199_rss_43abc3ee50",
    appleUrl: "https://podcasts.apple.com/us/podcast/scaling-slack/id1769051199?i=1000800061661",
    podcastName: "The Pragmatic Engineer",
    episodeTitle: "Scaling Slack and GitHub with Maude Lemaire",
    episodeDuration: 3600,
    episodeDate: "2026-11-05T15:58:00.000Z",
    audioUrl: "https://example.com/a.mp3",
    transcriptSource: "openai",
    createdAt: "2026-11-05T16:30:00.000Z",
    expiresAt: "2027-11-05T16:30:00.000Z",
    deck: "How two fast-growing companies kept their databases standing.",
};

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

let calls = 0;
const fake = async () => {
    calls++;
    return PNG_BYTES;
};
const app = createOgRoutes({ render: fake });

/** env with TLDL_DATA's `method` swapped for one that throws, optionally only for some keys. */
function kvFailing(method: "get" | "put", when: (key: string) => boolean = () => true) {
    const kv = env.TLDL_DATA;
    const broken = new Proxy(kv, {
        get: (t, p) => {
            const real = Reflect.get(t, p).bind(t);
            if (p !== method) return real;
            return async (key: string, ...rest: unknown[]) => {
                if (when(key)) throw new Error("kv down");
                return real(key, ...rest);
            };
        },
    });
    return { ...env, TLDL_DATA: broken };
}

let v: string;

beforeEach(async () => {
    calls = 0;
    for (const prefix of ["episode:", "episode-redirect:", "og:"]) {
        const { keys } = await env.TLDL_DATA.list({ prefix });
        for (const k of keys) await env.TLDL_DATA.delete(k.name);
    }
    await saveEpisode(env.TLDL_DATA, ep);
    v = await cardVersion(ep);
});

describe("GET /og/episode/:id.png", () => {
    it("miss: renders, caches in KV, returns the PNG with immutable caching", async () => {
        const res = await app.request(`/og/episode/${ep.id}.png?v=${v}`, {}, env);
        expect(res.status).toBe(200);
        expect(res.headers.get("content-type")).toBe("image/png");
        expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
        expect(new Uint8Array(await res.arrayBuffer())).toEqual(PNG_BYTES);
        expect(calls).toBe(1);
        expect(await env.TLDL_DATA.get(`og:${ep.id}:${v}`, "arrayBuffer")).not.toBeNull();
    });

    it("hit: serves cached bytes without rendering", async () => {
        await env.TLDL_DATA.put(`og:${ep.id}:${v}`, new Uint8Array([1, 2, 3]));
        const res = await app.request(`/og/episode/${ep.id}.png?v=${v}`, {}, env);
        expect(res.status).toBe(200);
        expect(res.headers.get("content-type")).toBe("image/png");
        expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
        expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
        expect(calls).toBe(0);
    });

    it.each(["", "?v=stale0000000"])("missing or stale v (%s) redirects to the current v", async (q) => {
        const res = await app.request(`/og/episode/${ep.id}.png${q}`, {}, env);
        expect(res.status).toBe(302);
        expect(res.headers.get("location")).toBe(`/og/episode/${encodeURIComponent(ep.id)}.png?v=${v}`);
        expect(res.headers.get("cache-control")).toBe("no-store");
        expect(calls).toBe(0);
    });

    it("aliased id 301s to the canonical card URL", async () => {
        await saveEpisodeRedirect(env.TLDL_DATA, "old_id", ep.id);
        const res = await app.request(`/og/episode/old_id.png?v=x`, {}, env);
        expect(res.status).toBe(301);
        expect(res.headers.get("location")).toBe(`/og/episode/${encodeURIComponent(ep.id)}.png`);
        expect(res.headers.get("cache-control")).toBe("no-store");
    });

    it("unknown id is a 404", async () => expect((await app.request(`/og/episode/nope.png?v=x`, {}, env)).status).toBe(404));

    it("URL without .png is a 404", async () => expect((await app.request(`/og/episode/${ep.id}?v=${v}`, {}, env)).status).toBe(404));

    it("a percent-encoded id is decoded once, so a literal % is a 404, not a 500", async () => {
        expect((await app.request(`/og/episode/%25.png?v=x`, {}, env)).status).toBe(404);
    });

    it("a malformed percent escape is a 404, not a 500", async () => {
        expect((await app.request(`/og/episode/%E0%A4%A.png?v=x`, {}, env)).status).toBe(404);
    });

    it("an encoded .png suffix is a 404, even for a stored episode at its current version", async () => {
        const res = await app.request(`/og/episode/${ep.id}%2Epng?v=${v}`, {}, env);
        expect(res.status).toBe(404);
        expect(calls).toBe(0);
    });

    it("an id spanning more than one path segment is a 404, even if stored", async () => {
        const slashed = { ...ep, id: "a/b" };
        await saveEpisode(env.TLDL_DATA, slashed);
        const res = await app.request(`/og/episode/a/b.png?v=${await cardVersion(slashed)}`, {}, env);
        expect(res.status).toBe(404);
        expect(calls).toBe(0);
    });

    it("redirect lookup failure 302s to the default image, uncached", async () => {
        const res = await app.request(`/og/episode/old_id.png?v=x`, {},
            kvFailing("get", (key) => key.startsWith("episode-redirect:")));
        expect(res.status).toBe(302);
        expect(res.headers.get("location")).toBe(DEFAULT_OG_IMAGE);
        expect(res.headers.get("cache-control")).toBe("no-store");
    });

    it("episode read failure 302s to the default image, uncached", async () => {
        const res = await app.request(`/og/episode/${ep.id}.png?v=${v}`, {}, kvFailing("get"));
        expect(res.status).toBe(302);
        expect(res.headers.get("location")).toBe(DEFAULT_OG_IMAGE);
        expect(res.headers.get("cache-control")).toBe("no-store");
        expect(calls).toBe(0);
    });

    it("card cache read failure is treated as a miss", async () => {
        const res = await app.request(`/og/episode/${ep.id}.png?v=${v}`, {},
            kvFailing("get", (key) => key.startsWith("og:")));
        expect(res.status).toBe(200);
        expect(res.headers.get("content-type")).toBe("image/png");
        expect(calls).toBe(1);
    });

    it("render failure 302s to the default image, uncached", async () => {
        const res = await createOgRoutes({ render: async () => { throw new Error("boom"); } })
            .request(`/og/episode/${ep.id}.png?v=${v}`, {}, env);
        expect(res.status).toBe(302);
        expect(res.headers.get("location")).toBe(DEFAULT_OG_IMAGE);
        expect(res.headers.get("cache-control")).toBe("no-store");
        expect(await env.TLDL_DATA.get(`og:${ep.id}:${v}`)).toBeNull();
    });

    it("KV write failure still returns the PNG", async () => {
        const res = await app.request(`/og/episode/${ep.id}.png?v=${v}`, {}, kvFailing("put"));
        expect(res.status).toBe(200);
        expect(res.headers.get("content-type")).toBe("image/png");
        expect(new Uint8Array(await res.arrayBuffer())).toEqual(PNG_BYTES);
    });

    it("HEAD behaves like GET", async () => {
        const res = await app.request(`/og/episode/${ep.id}.png?v=${v}`, { method: "HEAD" }, env);
        expect(res.status).toBe(200);
        expect(res.headers.get("content-type")).toBe("image/png");
    });

    it("an id containing a dot strips only the final .png", async () => {
        const dotted = { ...ep, id: "123_rss_a.b" };
        await saveEpisode(env.TLDL_DATA, dotted);
        const dv = await cardVersion(dotted);
        expect((await app.request(`/og/episode/123_rss_a.b.png?v=${dv}`, {}, env)).status).toBe(200);
    });
});

describe("the card route in the app", () => {
    it("is mounted and draws a real PNG", async () => {
        const res = await SELF.fetch(`https://tldl-pod.com/og/episode/${ep.id}.png?v=${v}`);
        expect(res.status).toBe(200);
        expect(res.headers.get("content-type")).toBe("image/png");
        const bytes = new Uint8Array(await res.arrayBuffer());
        expect(Array.from(bytes.subarray(0, 4))).toEqual(Array.from(PNG_BYTES));
    });

    it("draws a title with emoji as the same PNG as the title without them", async () => {
        const card = async (id: string, episodeTitle: string) => {
            const stored = { ...ep, id, episodeTitle };
            await saveEpisode(env.TLDL_DATA, stored);
            const res = await SELF.fetch(`https://tldl-pod.com/og/episode/${id}.png?v=${await cardVersion(stored)}`);
            expect(res.status).toBe(200);
            expect(res.headers.get("content-type")).toBe("image/png");
            return new Uint8Array(await res.arrayBuffer());
        };
        const withEmoji = await card("1769051199_rss_emoji", "AI 🤖 agents 🇺🇸 now 1️⃣");
        expect(Array.from(withEmoji.subarray(0, 4))).toEqual(Array.from(PNG_BYTES));
        expect(withEmoji).toEqual(await card("1769051199_rss_plain", "AI agents now"));
    });

    it("points the episode page's og:image at the episode's current card", async () => {
        await saveSummaryFor(ep.id);
        const res = await SELF.fetch(`https://tldl-pod.com/episode/${ep.id}`);
        expect(res.status).toBe(200);
        expect(ogImageOf(await res.text())).toBe(`https://tldl-pod.com/og/episode/${ep.id}.png?v=${v}`);
    });
});

describe("a stored record with deck: null", () => {
    const id = "1769051199_rss_nulldeck";

    beforeEach(async () => {
        // Raw JSON, as an older or hand-edited record could hold it; saveEpisode's type can't express it.
        await env.TLDL_DATA.put(`episode:${id}`, JSON.stringify({ ...ep, id, deck: null }));
        await saveSummaryFor(id);
    });

    it("still gets its card", async () => {
        const first = await SELF.fetch(`https://tldl-pod.com/og/episode/${id}.png`, { redirect: "manual" });
        expect(first.status).toBe(302);
        const res = await SELF.fetch(`https://tldl-pod.com${first.headers.get("location")}`);
        expect(res.status).toBe(200);
        expect(res.headers.get("content-type")).toBe("image/png");
    });

    it("still renders its episode page, pointing at the card", async () => {
        const res = await SELF.fetch(`https://tldl-pod.com/episode/${id}`);
        expect(res.status).toBe(200);
        expect(ogImageOf(await res.text())).toMatch(new RegExp(`^https://tldl-pod\\.com/og/episode/${id}\\.png\\?v=[0-9a-f]{12}$`));
    });
});

describe("when the card version can't be computed", () => {
    // cardVersion hashes with crypto.subtle; failing it stands in for any throw
    // while building the card's URL.
    beforeEach(() => {
        vi.spyOn(crypto.subtle, "digest").mockRejectedValue(new Error("digest down"));
    });
    afterEach(() => vi.restoreAllMocks());

    it("the episode page still renders, with the default image", async () => {
        const logged = vi.spyOn(console, "error").mockImplementation(() => {});
        await saveSummaryFor(ep.id);
        const res = await SELF.fetch(`https://tldl-pod.com/episode/${ep.id}`);
        expect(res.status).toBe(200);
        expect(ogImageOf(await res.text())).toBe(DEFAULT_OG_IMAGE);
        expect(logged).toHaveBeenCalledWith(JSON.stringify({ event: "og_card_version_failed", episodeId: ep.id, error: "digest down" }));
    });

    it("the card route 302s to the default image, uncached", async () => {
        const res = await app.request(`/og/episode/${ep.id}.png?v=${v}`, {}, env);
        expect(res.status).toBe(302);
        expect(res.headers.get("location")).toBe(DEFAULT_OG_IMAGE);
        expect(res.headers.get("cache-control")).toBe("no-store");
        expect(calls).toBe(0);
    });
});

async function saveSummaryFor(episodeId: string) {
    await saveSummary(env.TLDL_DATA, {
        episodeId,
        templateId: "key-takeaways",
        text: "Summary text.",
        model: "claude-opus-5-5",
        createdAt: "2026-11-05T16:30:00.000Z",
    });
}

function ogImageOf(html: string): string | undefined {
    return html.match(/<meta property="og:image" content="([^"]*)">/)?.[1];
}
