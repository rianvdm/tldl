/**
 * Apple Podcasts show page scraper.
 *
 * The iTunes Lookup API is what knows Apple's episode IDs, but it 403s from
 * Cloudflare Workers egress (re-measured 2026-11-07). The public show page,
 * podcasts.apple.com/us/podcast/id{podcastId}, loads fine from Workers and
 * embeds the show's most recent ~10 episodes as JSON, each with its RSS
 * `guid` and its Apple `storeUrl` (…?i={appleEpisodeId}). Matching on the
 * GUID is exact, so no title fuzzing is needed.
 *
 * This is undocumented markup. If Apple changes it, parsing yields an empty
 * map and episodes keep their show-level Apple URL, which is what they had
 * before this existed.
 */

import { USER_AGENT } from "../lib/constants";

const FETCH_TIMEOUT_MS = 10_000;
const DATA_BLOCK = /<script[^>]*\bid="serialized-server-data"[^>]*>([\s\S]*?)<\/script>/;

function isAppleEpisodeUrl(value: string): boolean {
    try {
        const url = new URL(value);
        return url.hostname === "podcasts.apple.com" && /^\d+$/.test(url.searchParams.get("i") ?? "");
    } catch {
        return false;
    }
}

/**
 * Extract GUID -> Apple episode URL pairs from a show page's HTML.
 * Walks the whole JSON tree rather than a fixed path, so a reshuffle of
 * Apple's shelf layout doesn't break it as long as the episode objects
 * still carry both fields.
 */
export function parseAppleShowPage(html: string): Map<string, string> {
    const urls = new Map<string, string>();
    const block = html.match(DATA_BLOCK)?.[1];
    if (!block) return urls;

    let data: unknown;
    try {
        data = JSON.parse(block);
    } catch {
        return urls;
    }

    const stack: unknown[] = [data];
    while (stack.length > 0) {
        const node = stack.pop();
        if (Array.isArray(node)) {
            stack.push(...node);
        } else if (node && typeof node === "object") {
            const record = node as Record<string, unknown>;
            const { guid, storeUrl } = record;
            if (typeof guid === "string" && typeof storeUrl === "string" && isAppleEpisodeUrl(storeUrl)) {
                urls.set(guid, storeUrl);
            }
            stack.push(...Object.values(record));
        }
    }
    return urls;
}

/**
 * Fetch a podcast's Apple show page and return its GUID -> episode URL map.
 * Never throws: any failure returns an empty map and is logged, because the
 * caller treats a missing Apple link as "try again next cron".
 */
export async function fetchAppleEpisodeUrls(podcastId: string): Promise<Map<string, string>> {
    const url = `https://podcasts.apple.com/us/podcast/id${podcastId}`;
    try {
        const response = await fetch(url, {
            headers: { "User-Agent": USER_AGENT, Accept: "text/html" },
            signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });
        if (!response.ok) {
            console.log(JSON.stringify({ event: "apple_show_page_http_error", podcastId, status: response.status }));
            return new Map();
        }
        const urls = parseAppleShowPage(await response.text());
        if (urls.size === 0) {
            console.log(JSON.stringify({ event: "apple_show_page_no_episodes", podcastId }));
        }
        return urls;
    } catch (error) {
        console.log(JSON.stringify({
            event: "apple_show_page_fetch_error",
            podcastId,
            error: error instanceof Error ? error.message : String(error),
        }));
        return new Map();
    }
}
