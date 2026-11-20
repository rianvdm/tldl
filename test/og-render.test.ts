import { describe, it, expect } from "vitest";
import { buildCardTree, titleFontSize } from "../src/lib/og/card-tree";
import { renderCardPng, renderCardSvg } from "../src/lib/og/render";

const model = { podcast: "POD", date: "NOV 18, 2026", title: "A title", deck: "A deck.", runtime: "1H 12M" };

/** Right edge of the text column: the card width less the 56px side padding. */
const TEXT_RIGHT = 1200 - 56;

type Box = { left: number; top: number; right: number; bottom: number };

/** Bounding box of one glyph outline: satori uses only absolute M, L, Q and Z, so numbers pair up as x,y. */
function pathBox(d: string): Box {
    const nums = (d.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
    const xs = nums.filter((_, i) => i % 2 === 0);
    const ys = nums.filter((_, i) => i % 2 === 1);
    return { left: Math.min(...xs), top: Math.min(...ys), right: Math.max(...xs), bottom: Math.max(...ys) };
}

/**
 * Every glyph outline satori drew, with the clip rect that applies to it.
 * satori draws each text run as <g><path/></g> (groups are flat, never
 * nested); a run under overflow: hidden gets clip-path="url(#id)" pointing at
 * a <clipPath id> holding one <rect>.
 */
function glyphs(svg: string): { box: Box; clip: Box | null }[] {
    const clips = new Map<string, Box>();
    for (const [, id, x, y, w, h] of svg.matchAll(
        /<clipPath id="([^"]+)"><rect x="([^"]+)" y="([^"]+)" width="([^"]+)" height="([^"]+)"/g)) {
        clips.set(id, { left: +x, top: +y, right: +x + +w, bottom: +y + +h });
    }
    const out: { box: Box; clip: Box | null }[] = [];
    const outside = svg.replace(/<g\b([^>]*)>([\s\S]*?)<\/g>/g, (_, attrs: string, body: string) => {
        const clipId = attrs.match(/clip-path="url\(#([^)]+)\)"/)?.[1];
        const clip = clipId === undefined ? null : (clips.get(clipId) ?? null);
        for (const [, d] of body.matchAll(/<path[^>]* d="([^"]*)"/g)) out.push({ box: pathBox(d), clip });
        return "";
    });
    for (const [, d] of outside.matchAll(/<path[^>]* d="([^"]*)"/g)) out.push({ box: pathBox(d), clip: null });
    return out;
}

/** Rightmost x any glyph can paint: a clipped glyph paints no further right than its clip rect. */
function visibleRight(svg: string): number {
    return Math.max(...glyphs(svg).map(({ box, clip }) => Math.min(box.right, clip?.right ?? Infinity)));
}

describe("buildCardTree", () => {
    it("tree contains the podcast, date, title, deck, runtime and domain", () => {
        const text = JSON.stringify(buildCardTree(model));
        for (const s of ["POD", "NOV 18, 2026", "A title", "A deck.", "1H 12M", "TLDL-POD.COM"]) expect(text).toContain(s);
    });

    it("tree has no deck node when deck is null", () =>
        expect(JSON.stringify(buildCardTree({ ...model, deck: null }))).not.toContain("A deck."));

    it("tree omits runtime when null", () =>
        expect(JSON.stringify(buildCardTree({ ...model, runtime: null }))).not.toMatch(/\d+M/));

    it("tree keeps the date when the podcast name is very long", () => {
        const text = JSON.stringify(buildCardTree({ ...model, podcast: "P".repeat(120) }));
        expect(text).toContain("P".repeat(120));
        expect(text).toContain("— NOV 18, 2026");
    });

    it("tree has no dash or date when date is null", () =>
        expect(JSON.stringify(buildCardTree({ ...model, date: null }))).not.toContain("—"));

    it("tree shows the date without a dash when the podcast name is empty", () => {
        const text = JSON.stringify(buildCardTree({ ...model, podcast: "" }));
        expect(text).toContain("NOV 18, 2026");
        expect(text).not.toContain("—");
    });

    it("title font steps down for long titles", () => {
        const size = (t: string) => titleFontSize(t);
        expect(size("x".repeat(120))).toBeLessThan(size("Short title"));
    });
});

describe("renderCardPng", () => {
    it("renders a 1200x630 PNG", async () => {
        const png = await renderCardPng(model);
        expect([...png.slice(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
        const view = new DataView(png.buffer, png.byteOffset);
        expect(view.getUint32(16)).toBe(1200); // IHDR width
        expect(view.getUint32(20)).toBe(630);  // IHDR height
    });

    it("renders a long title, long deck and no runtime without throwing", async () => {
        const png = await renderCardPng({ podcast: "A VERY LONG PODCAST NAME THAT GOES ON", date: "JAN 1, 2026",
            title: "word ".repeat(40).trim(), deck: "deck ".repeat(60).trim(), runtime: null });
        expect(png.byteLength).toBeGreaterThan(1000);
    });

    it.each([
        ["unbroken words in the title and deck", { title: "Supercalifragilisticexpialidocious".repeat(3),
            deck: "Pneumonoultramicroscopicsilicovolcanoconiosis".repeat(2) }],
        // Long enough to clamp: the ellipsis on the last line must stay inside too.
        ["a clamped unbroken title", { title: "W".repeat(70) }],
        ["a clamped unbroken deck", { deck: "W".repeat(150) }],
        ["a clamped spaced title and deck", { title: "word ".repeat(40).trim(), deck: "deck ".repeat(60).trim() }],
        // Ǆ advances 1.443em, wider than the 1em reserve: only the clip keeps it in.
        ["a clamped title of glyphs wider than the reserve", { title: "ǄǄǄu".repeat(17) + "ǄǄ" }],
        ["a clamped deck of glyphs wider than the reserve", { deck: "ǄǄǄu".repeat(30) }],
    ])("keeps every glyph inside the text column for %s", async (_, overrides) => {
        const svg = await renderCardSvg({ ...model, ...overrides });
        expect(visibleRight(svg)).toBeLessThanOrEqual(TEXT_RIGHT);
    });

    it("clips only the right edge: accents, descenders and italic overhang stay whole", async () => {
        const svg = await renderCardSvg({ ...model,
            title: "ÅÉÎ Ǻngström Ḯle " + "gjpqy ".repeat(12) + "Qgjpqy gjpqy",
            deck: "ÅÉÎ Ǻngström fjord " + "gjpqy ".repeat(30) });
        const clipped = glyphs(svg).filter((g) => g.clip !== null && g.box.top > 200); // title and deck, not the kicker
        expect(clipped.length).toBeGreaterThanOrEqual(2);
        for (const { box, clip } of clipped) {
            expect(box.top).toBeGreaterThanOrEqual(clip!.top);
            expect(box.bottom).toBeLessThanOrEqual(clip!.bottom);
            expect(box.left).toBeGreaterThanOrEqual(clip!.left);
        }
    });
});
