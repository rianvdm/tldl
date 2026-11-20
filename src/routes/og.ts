/**
 * Per-episode Open Graph share cards: GET /og/episode/<episodeId>.png?v=<cardVersion>
 *
 * Only a request whose `v` matches the episode's current card version gets PNG
 * bytes, so the year-long immutable cache always covers the right image. Cards
 * are drawn on first request and cached in KV under `og:{episodeId}:{version}`.
 */

import { Hono } from "hono";
import type { HonoEnv, Episode } from "../types";
import { getEpisode, getEpisodeRedirect, KV_KEYS, TTL } from "../lib/kv";
import { cardVersion, toCardModel, type CardModel } from "../lib/og/card-model";
import { renderCardPng } from "../lib/og/render";
import { DEFAULT_OG_IMAGE } from "../lib/broadsheet/head";

export interface OgRouteDeps {
    /** Draws the card; tests swap in a fake so they don't run satori and resvg. */
    render?: (model: CardModel) => Promise<Uint8Array>;
}

const PNG_HEADERS = {
    "Content-Type": "image/png",
    "Cache-Control": "public, max-age=31536000, immutable",
};

function cardPath(episodeId: string): string {
    return `/og/episode/${encodeURIComponent(episodeId)}.png`;
}

/** Every redirect from the card route is uncached, so a crawler re-asks next time. */
function redirect(location: string, status: 301 | 302): Response {
    return new Response(null, { status, headers: { Location: location, "Cache-Control": "no-store" } });
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

export function createOgRoutes(deps: OgRouteDeps = {}): Hono<HonoEnv> {
    const render = deps.render ?? renderCardPng;
    const og = new Hono<HonoEnv>();

    // `:file{.+\.png}` requires the suffix, so a URL without `.png` falls through
    // to a 404. Hono has already percent-decoded the param, so don't decode again.
    og.get("/og/episode/:file{.+\\.png}", async (c) => {
        const kv = c.env.TLDL_DATA;
        const episodeId = c.req.param("file").slice(0, -".png".length);

        let episode: Episode | null;
        try {
            episode = await getEpisode(kv, episodeId);
        } catch {
            return redirect(DEFAULT_OG_IMAGE, 302);
        }
        if (!episode) {
            const canonical = await getEpisodeRedirect(kv, episodeId);
            if (canonical) return redirect(cardPath(canonical), 301);
            return c.notFound();
        }

        const version = await cardVersion(episode);
        if (c.req.query("v") !== version) return redirect(`${cardPath(episodeId)}?v=${version}`, 302);

        const key = KV_KEYS.ogCard(episodeId, version);
        let cached: ArrayBuffer | null = null;
        try {
            cached = await kv.get(key, "arrayBuffer");
        } catch {
            // A failed cache read is a miss: draw the card instead.
        }
        if (cached) return new Response(cached, { headers: PNG_HEADERS });

        let png: Uint8Array;
        try {
            png = await render(toCardModel(episode));
        } catch (error) {
            console.error(JSON.stringify({ event: "og_render_failed", episodeId, error: errorMessage(error) }));
            return redirect(DEFAULT_OG_IMAGE, 302);
        }

        // Awaited rather than waitUntil, so a crawler burst right after the first
        // draw finds the card in KV instead of drawing it again.
        try {
            await kv.put(key, png, { expirationTtl: TTL.CONTENT });
        } catch (error) {
            console.error(JSON.stringify({ event: "og_cache_write_failed", episodeId, error: errorMessage(error) }));
        }
        return new Response(png, { headers: PNG_HEADERS });
    });

    return og;
}

export default createOgRoutes();
