import { describe, it, expect } from "vitest";
import { buildCardTree, titleFontSize } from "../src/lib/og/card-tree";
import { renderCardPng, renderCardSvg } from "../src/lib/og/render";

const model = { podcast: "POD", date: "NOV 18, 2026", title: "A title", deck: "A deck.", runtime: "1H 12M" };

/** Right edge of the text column: the card width less the 56px side padding. */
const TEXT_RIGHT = 1200 - 56;

/**
 * Rightmost x of any glyph satori drew. satori writes text as <path> outlines
 * using only absolute M, L, Q and Z commands, so every number pair is an x,y point.
 */
function maxGlyphX(svg: string): number {
    let max = -Infinity;
    for (const [, d] of svg.matchAll(/<path[^>]* d="([^"]*)"/g)) {
        const nums = d.match(/-?\d+(?:\.\d+)?/g) ?? [];
        for (let i = 0; i < nums.length; i += 2) max = Math.max(max, Number(nums[i]));
    }
    return max;
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

    it("wraps an unbroken word inside the text column", async () => {
        const svg = await renderCardSvg({ ...model, title: "Supercalifragilisticexpialidocious".repeat(3),
            deck: "Pneumonoultramicroscopicsilicovolcanoconiosis".repeat(2) });
        expect(maxGlyphX(svg)).toBeLessThanOrEqual(TEXT_RIGHT);
    });
});
