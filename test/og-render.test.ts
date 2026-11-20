import { describe, it, expect } from "vitest";
import { buildCardTree, titleFontSize } from "../src/lib/og/card-tree";
import { renderCardPng } from "../src/lib/og/render";

const model = { kicker: "POD — NOV 18, 2026", title: "A title", deck: "A deck.", runtime: "1H 12M" };

describe("buildCardTree", () => {
    it("tree contains the kicker, title, deck, runtime and domain", () => {
        const text = JSON.stringify(buildCardTree(model));
        for (const s of ["POD — NOV 18, 2026", "A title", "A deck.", "1H 12M", "TLDL-POD.COM"]) expect(text).toContain(s);
    });

    it("tree has no deck node when deck is null", () =>
        expect(JSON.stringify(buildCardTree({ ...model, deck: null }))).not.toContain("A deck."));

    it("tree omits runtime when null", () =>
        expect(JSON.stringify(buildCardTree({ ...model, runtime: null }))).not.toMatch(/\d+M/));

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
        const png = await renderCardPng({ kicker: "A VERY LONG PODCAST NAME THAT GOES ON — JAN 1, 2026",
            title: "word ".repeat(40).trim(), deck: "deck ".repeat(60).trim(), runtime: null });
        expect(png.byteLength).toBeGreaterThan(1000);
    });
});
