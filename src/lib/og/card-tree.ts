import type { CardModel } from "./card-model";
import { MONO, SERIF } from "./fonts";

/** satori's plain-object element: the React element shape without React. */
export type SatoriNode = {
    type: string;
    props: { style?: Record<string, unknown>; children?: SatoriNode | SatoriNode[] | string };
};

export const CARD_WIDTH = 1200;
export const CARD_HEIGHT = 630;

// Broadsheet tokens (src/lib/broadsheet/tokens.css.ts).
const PAPER = "#10100e";
const INK = "#f1ece3";
const INK_DIM = "#b8b0a3";
const INK_FAINT = "#6f685d";
const RED = "#e63946";
const RULE = "#4a4a40";

const SIDE_PADDING = 56;
/** Every text block is laid out against this fixed width, not a character count. */
const TEXT_WIDTH = CARD_WIDTH - SIDE_PADDING * 2; // 1088

/**
 * Title size in px, stepped down by length so a 3-line title fits the text
 * column. Starting values; Task 4's visual check on real episodes may tune them.
 */
export function titleFontSize(title: string): number {
    const length = [...title].length;
    if (length <= 40) return 76;
    if (length <= 70) return 64;
    if (length <= 100) return 54;
    return 46;
}

function el(type: string, style: Record<string, unknown>, children?: SatoriNode | SatoriNode[] | string): SatoriNode {
    return { type, props: children === undefined ? { style } : { style, children } };
}

function rule(color: string, thickness: number): SatoriNode {
    return el("div", { width: TEXT_WIDTH, height: thickness, backgroundColor: color });
}

function wordmark(): SatoriNode {
    const part = (text: string, color: string) => el("span", { color }, text);
    return el(
        "div",
        {
            display: "flex",
            justifyContent: "center",
            width: TEXT_WIDTH,
            fontFamily: SERIF,
            fontWeight: 900,
            fontStyle: "italic",
            fontSize: 88,
            lineHeight: 1,
            paddingBottom: 14,
        },
        [part("T", INK), part("L", RED), part(";D", INK), part("L", RED)],
    );
}

const KICKER_TEXT = {
    fontFamily: MONO,
    fontWeight: 500,
    fontSize: 20,
    letterSpacing: 2.4, // 0.12em
    color: RED,
    whiteSpace: "nowrap",
};

/**
 * Podcast name, then "— date", then a rule filling the row. Only the podcast
 * name shrinks and takes the ellipsis, so a long name never hides the date.
 */
function kickerRow(podcast: string, date: string | null): SatoriNode {
    const children: SatoriNode[] = [];
    if (podcast !== "") {
        children.push(el("div", { ...KICKER_TEXT, flexShrink: 1, overflow: "hidden", textOverflow: "ellipsis" }, podcast));
    }
    if (date !== null) {
        const dateText = podcast === "" ? date : `— ${date}`;
        children.push(el("div", { ...KICKER_TEXT, flexShrink: 0, marginLeft: podcast === "" ? 0 : 14 }, dateText));
    }
    children.push(el("div", { flexGrow: 1, flexShrink: 0, minWidth: 40, height: 1, marginLeft: 20, backgroundColor: RULE }));
    return el("div", { display: "flex", alignItems: "center", width: TEXT_WIDTH }, children);
}

/**
 * Right padding, in em, on the line-clamped title and deck. satori lays out
 * the clamped last line, then always keeps at least one character before its
 * ellipsis, so the ellipsis can land past the content box: by up to the
 * ellipsis's own width (0.91em in Fraunces 600) when a word sits near the
 * edge, or by one glyph less a space when a broken word fills the line.
 * Wrapping 1em short of the column keeps the ellipsis visible for every
 * ordinary Latin glyph (W is 1.06em). A rarer, wider glyph (Ǆ is 1.443em) can
 * still overshoot, so both nodes also clip at the column edge; see clipToColumn.
 */
const CLAMP_RESERVE_EM = 1;

/**
 * How far, in em, the clip extends above, below and left of the text, so it
 * only ever cuts on the right. Fraunces outlines reach 1.10em above the
 * baseline and 0.28em below it, and the italic leans 0.14em left of its
 * origin: at the title's 1.08 line height that is 0.20em over the line box's
 * top and 0.10em under its bottom, all inside 0.25em.
 */
const CLIP_BLEED_EM = 0.25;

const DECK_FONT_SIZE = 30;

/**
 * Box styles for a clamped text node whose glyphs must never paint past the
 * column's right edge. overflow: hidden makes satori draw a clipPath at the
 * node's padding box; padding plus an equal negative margin grows that box
 * by the bleed on the top, bottom and left without moving the text, and
 * width stays pinned so the box's right edge is the column edge.
 */
function clipToColumn(fontSize: number, spaceAbove = 0): Record<string, unknown> {
    const bleed = CLIP_BLEED_EM * fontSize;
    return {
        width: TEXT_WIDTH + bleed,
        marginLeft: -bleed,
        marginTop: spaceAbove - bleed,
        marginBottom: -bleed,
        paddingLeft: bleed,
        paddingTop: bleed,
        paddingBottom: bleed,
        paddingRight: CLAMP_RESERVE_EM * fontSize,
        overflow: "hidden",
    };
}

function titleBlock(title: string, deck: string | null): SatoriNode {
    const fontSize = titleFontSize(title);
    const children: SatoriNode[] = [
        el(
            "div",
            {
                display: "block",
                ...clipToColumn(fontSize),
                fontFamily: SERIF,
                fontWeight: 600,
                fontSize,
                lineHeight: 1.08,
                letterSpacing: -0.01 * fontSize,
                color: INK,
                lineClamp: 3,
                textOverflow: "ellipsis",
                wordBreak: "break-word", // an unbroken word wraps instead of running off the card
            },
            title,
        ),
    ];
    if (deck !== null) {
        children.push(
            el(
                "div",
                {
                    display: "block",
                    ...clipToColumn(DECK_FONT_SIZE, 22),
                    fontFamily: SERIF,
                    fontWeight: 400,
                    fontStyle: "italic",
                    fontSize: DECK_FONT_SIZE,
                    lineHeight: 1.3,
                    color: INK_DIM,
                    lineClamp: 2,
                    textOverflow: "ellipsis",
                    wordBreak: "break-word",
                },
                deck,
            ),
        );
    }
    // Centred in the space below the kicker, so a card without a deck gives
    // the title the deck's room and it sits a little lower.
    return el("div", { display: "flex", flexDirection: "column", justifyContent: "center", flexGrow: 1 }, children);
}

function footer(runtime: string | null): SatoriNode {
    const label = (text: string) => el("div", {}, text);
    const right = runtime === null ? "TLDL-POD.COM" : `${runtime} · TLDL-POD.COM`;
    return el("div", { display: "flex", flexDirection: "column" }, [
        rule(INK, 2),
        el(
            "div",
            {
                display: "flex",
                justifyContent: "space-between",
                width: TEXT_WIDTH,
                paddingTop: 16,
                fontFamily: MONO,
                fontWeight: 500,
                fontSize: 18,
                letterSpacing: 1.8, // 0.1em
                color: INK_FAINT,
            },
            [label("TLDL · PODCAST SUMMARIES"), label(right)],
        ),
    ]);
}

/** The card's element tree: pure, so the layout is testable without drawing. */
export function buildCardTree(model: CardModel): SatoriNode {
    return el(
        "div",
        {
            display: "flex",
            flexDirection: "column",
            width: CARD_WIDTH,
            height: CARD_HEIGHT,
            padding: `30px ${SIDE_PADDING}px 30px`,
            backgroundColor: PAPER,
            color: INK,
        },
        [
            wordmark(),
            rule(INK, 2),
            el("div", { display: "flex", flexDirection: "column", flexGrow: 1, paddingTop: 30, paddingBottom: 26 }, [
                kickerRow(model.podcast, model.date),
                titleBlock(model.title, model.deck),
            ]),
            footer(model.runtime),
        ],
    );
}
