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

/** One nonempty path segment followed by a literal (not percent-encoded) `.png`. */
const RAW_CARD_PATH = /^\/og\/episode\/([^/]+)\.png$/;

/**
 * The episode ID from the request's raw pathname, decoded once; null when the
 * path isn't exactly `/og/episode/<one segment>.png`. Hono matches routes on a
 * decoded path, so its params would accept `<id>%2Epng` and `a/b.png`.
 */
function episodeIdFromPath(url: string): string | null {
    const match = RAW_CARD_PATH.exec(new URL(url).pathname);
    if (!match) return null;
    try {
        return decodeURIComponent(match[1]);
    } catch {
        return null; // a malformed percent escape
    }
}

export function createOgRoutes(deps: OgRouteDeps = {}): Hono<HonoEnv> {
    const render = deps.render ?? renderCardPng;
    const og = new Hono<HonoEnv>();

    // `:file{.+\.png}` requires the suffix, so a URL without `.png` falls through
    // to a 404. The raw-path check then rejects what Hono's decoded match lets in.
    og.get("/og/episode/:file{.+\\.png}", async (c) => {
        const kv = c.env.TLDL_DATA;
        const episodeId = episodeIdFromPath(c.req.url);
        if (episodeId === null) return c.notFound();

        // A failed read sends the default image rather than a 500, so a share
        // never shows a broken preview.
        let episode: Episode | null;
        let canonical: string | null = null;
        try {
            episode = await getEpisode(kv, episodeId);
            if (!episode) canonical = await getEpisodeRedirect(kv, episodeId);
        } catch {
            return redirect(DEFAULT_OG_IMAGE, 302);
        }
        if (!episode) {
            if (canonical) return redirect(cardPath(canonical), 301);
            return c.notFound();
        }

        let model: CardModel;
        let version: string;
        try {
            model = toCardModel(episode);
            version = await cardVersion(episode);
        } catch (error) {
            console.error(JSON.stringify({ event: "og_card_version_failed", episodeId, error: errorMessage(error) }));
            return redirect(DEFAULT_OG_IMAGE, 302);
        }
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
            png = await render(model);
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
