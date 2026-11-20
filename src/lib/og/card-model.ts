import type { Episode } from "../../types";

/**
 * Bump when the card's drawing changes (layout, fonts, colours), so every
 * episode gets a new `cardVersion` and scrapers fetch the redrawn card.
 */
export const CARD_TEMPLATE_VERSION = "1";

const BASE_URL = "https://tldl-pod.com";

/** The text drawn on an episode's share card, already cleaned for the renderer. */
export interface CardModel {
    kicker: string;          // "PODCAST NAME — NOV 18, 2026"
    title: string;
    deck: string | null;
    runtime: string | null;  // "1H 12M", "45M"
}

// An emoji with any variation selector (U+FE0F) or ZWJ-joined parts, then any
// stray selector or joiner left behind. The card fonts have no emoji glyphs.
const EMOJI = /\p{Extended_Pictographic}(?:️|‍\p{Extended_Pictographic})*/gu;
const STRAY_JOINERS = /[️‍]/g;

function cleanText(text: string): string {
    return text.replace(EMOJI, "").replace(STRAY_JOINERS, "").replace(/\s+/g, " ").trim();
}

function kickerDate(episodeDate: string): string | null {
    if (Number.isNaN(Date.parse(episodeDate))) return null;
    return new Date(episodeDate)
        .toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })
        .toUpperCase();
}

/** Same arithmetic and padding as `formatDuration` on the detail page, uppercased. */
function formatRuntime(seconds: number): string | null {
    if (!Number.isFinite(seconds) || seconds <= 0) return null;
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    return h > 0 ? `${h}H ${m.toString().padStart(2, "0")}M` : `${m}M`;
}

export function toCardModel(ep: Episode): CardModel {
    const podcastName = cleanText(ep.podcastName);
    const date = kickerDate(ep.episodeDate);
    const kicker = [podcastName.toUpperCase(), date].filter(Boolean).join(" — ");
    const deck = ep.deck === undefined ? "" : cleanText(ep.deck);
    return {
        kicker,
        title: cleanText(ep.episodeTitle) || podcastName,
        deck: deck || null,
        runtime: formatRuntime(ep.episodeDuration),
    };
}

/**
 * First 12 hex chars of SHA-256 over the template version and the card model.
 * Hashing the model, not raw episode fields, changes the version exactly when
 * the drawn card changes.
 */
export async function cardVersion(ep: Episode): Promise<string> {
    const input = new TextEncoder().encode(JSON.stringify([CARD_TEMPLATE_VERSION, toCardModel(ep)]));
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", input));
    return Array.from(digest.subarray(0, 6), (b) => b.toString(16).padStart(2, "0")).join("");
}

export function episodeCardUrl(episodeId: string, version: string): string {
    return `${BASE_URL}/og/episode/${encodeURIComponent(episodeId)}.png?v=${version}`;
}
