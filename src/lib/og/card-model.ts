import type { Episode } from "../../types";
import { formatDuration } from "../broadsheet/format";

/**
 * Bump when the card's drawing changes (layout, fonts, colours), so every
 * episode gets a new `cardVersion` and scrapers fetch the redrawn card.
 */
export const CARD_TEMPLATE_VERSION = "2";

const BASE_URL = "https://tldl-pod.com";

/** The text drawn on an episode's share card, already cleaned for the renderer. */
export interface CardModel {
    podcast: string;         // "PODCAST NAME"
    date: string | null;     // "NOV 18, 2026"; none when the episode date doesn't parse
    title: string;
    deck: string | null;
    runtime: string | null;  // "1H 12M", "45M"
}

// The card fonts have no emoji glyphs, so whole emoji sequences go: a keycap
// (base, optional U+FE0F, U+20E3), a regional-indicator flag pair, or a
// pictograph with its variation selectors, skin-tone modifiers and ZWJ-joined
// parts. A pictograph counts as emoji when it defaults to emoji presentation,
// sits outside the BMP, or carries U+FE0F or a modifier; a BMP symbol that
// defaults to text (™, ©, ↔) stays. Each sequence becomes a space, so an
// emoji between two words still separates them. Then any leftover component
// goes too: a lone selector, joiner, keycap mark, modifier or regional
// indicator, or a subdivision-flag tag.
const WITH_SELECTORS = String.raw`(?:\u{FE0F}|\p{Emoji_Modifier})`;
const EMOJI_PICTOGRAPH = String.raw`(?:\p{Emoji_Presentation}|(?=[\u{10000}-\u{10FFFF}])\p{Extended_Pictographic})${WITH_SELECTORS}*`
    + String.raw`|\p{Extended_Pictographic}${WITH_SELECTORS}+`;
const ZWJ_PART = String.raw`\u{200D}\p{Extended_Pictographic}${WITH_SELECTORS}*`;
const EMOJI_SEQUENCE = new RegExp(
    String.raw`[#*0-9]\u{FE0F}?\u{20E3}|\p{Regional_Indicator}{2}|(?:${EMOJI_PICTOGRAPH})(?:${ZWJ_PART})*`, "gu");
const EMOJI_LEFTOVER = /[\u{FE0F}\u{200D}\u{20E3}\p{Emoji_Modifier}\p{Regional_Indicator}\u{E0020}-\u{E007F}]/gu;

/** Shown when an episode's title and podcast name both clean to nothing. */
const FALLBACK_TITLE = "TL;DL";

/** The text with emoji removed and whitespace collapsed; "" for a non-string. */
function cleanText(text: unknown): string {
    if (typeof text !== "string") return "";
    return text.replace(EMOJI_SEQUENCE, " ").replace(EMOJI_LEFTOVER, "").replace(/\s+/g, " ").trim();
}

function kickerDate(episodeDate: unknown): string | null {
    if (typeof episodeDate !== "string" || Number.isNaN(Date.parse(episodeDate))) return null;
    return new Date(episodeDate)
        .toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })
        .toUpperCase();
}

/** The Broadsheet pages' runtime, uppercased; none when the duration is unknown. */
function formatRuntime(seconds: unknown): string | null {
    if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) return null;
    return formatDuration(seconds).toUpperCase();
}

/**
 * The card's text for an episode. The record is JSON from KV and can drift
 * from the Episode type (an older record with `deck: null`), so a field of
 * the wrong type counts as absent rather than throwing.
 */
export function toCardModel(ep: Episode): CardModel {
    const podcastName = cleanText(ep.podcastName);
    const deck = cleanText(ep.deck);
    return {
        podcast: podcastName.toUpperCase(),
        date: kickerDate(ep.episodeDate),
        title: cleanText(ep.episodeTitle) || podcastName || FALLBACK_TITLE,
        deck: deck || null,
        runtime: formatRuntime(ep.episodeDuration),
    };
}

/**
 * First 12 hex chars of SHA-256 over CARD_TEMPLATE_VERSION and the normalized
 * card model. Hashing the model, not raw episode fields, ignores edits the card
 * doesn't use (tags, summary). It isn't a hash of the pixels: text past a
 * clamp's ellipsis still changes the version while the image looks the same.
 */
export async function cardVersion(ep: Episode): Promise<string> {
    const input = new TextEncoder().encode(JSON.stringify([CARD_TEMPLATE_VERSION, toCardModel(ep)]));
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", input));
    return Array.from(digest.subarray(0, 6), (b) => b.toString(16).padStart(2, "0")).join("");
}

export function episodeCardUrl(episodeId: string, version: string): string {
    return `${BASE_URL}/og/episode/${encodeURIComponent(episodeId)}.png?v=${version}`;
}
