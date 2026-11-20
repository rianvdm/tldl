import type { Episode } from "../../types";
import { formatDuration } from "../broadsheet/format";

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

// The card fonts have no emoji glyphs, so whole emoji sequences go: a keycap
// (base, optional U+FE0F, U+20E3), a regional-indicator flag pair, or a
// pictograph with its variation selectors, skin-tone modifiers and ZWJ-joined
// parts. Then any leftover component goes too: a lone selector, joiner,
// keycap mark, modifier or regional indicator, or a subdivision-flag tag.
const EMOJI_SEQUENCE = /[#*0-9]\u{FE0F}?\u{20E3}|\p{Regional_Indicator}{2}|\p{Extended_Pictographic}(?:\u{FE0F}|\p{Emoji_Modifier})*(?:\u{200D}\p{Extended_Pictographic}(?:\u{FE0F}|\p{Emoji_Modifier})*)*/gu;
const EMOJI_LEFTOVER = /[\u{FE0F}\u{200D}\u{20E3}\p{Emoji_Modifier}\p{Regional_Indicator}\u{E0020}-\u{E007F}]/gu;

/** Shown when an episode's title and podcast name both clean to nothing. */
const FALLBACK_TITLE = "TL;DL";

function cleanText(text: string): string {
    return text.replace(EMOJI_SEQUENCE, "").replace(EMOJI_LEFTOVER, "").replace(/\s+/g, " ").trim();
}

function kickerDate(episodeDate: string): string | null {
    if (Number.isNaN(Date.parse(episodeDate))) return null;
    return new Date(episodeDate)
        .toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })
        .toUpperCase();
}

/** The Broadsheet pages' runtime, uppercased; none when the duration is unknown. */
function formatRuntime(seconds: number): string | null {
    if (!Number.isFinite(seconds) || seconds <= 0) return null;
    return formatDuration(seconds).toUpperCase();
}

export function toCardModel(ep: Episode): CardModel {
    const podcastName = cleanText(ep.podcastName);
    const date = kickerDate(ep.episodeDate);
    const kicker = [podcastName.toUpperCase(), date].filter(Boolean).join(" — ");
    const deck = ep.deck === undefined ? "" : cleanText(ep.deck);
    return {
        kicker,
        title: cleanText(ep.episodeTitle) || podcastName || FALLBACK_TITLE,
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
