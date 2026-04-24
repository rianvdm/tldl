import { describe, it, expect } from "vitest";
import { parseEditorialMeta } from "../../src/services/editorial-meta";

describe("parseEditorialMeta", () => {
    it("extracts deck and pullQuote from JSON response", () => {
        const raw = JSON.stringify({
            deck: "A four-hour conversation about compounding.",
            pullQuote: "Patience is the only moat that scales.",
        });
        expect(parseEditorialMeta(raw)).toEqual({
            deck: "A four-hour conversation about compounding.",
            pullQuote: "Patience is the only moat that scales.",
        });
    });

    it("strips surrounding whitespace and trailing ellipses", () => {
        const raw = JSON.stringify({
            deck: "  A deck...  ",
            pullQuote: "  A quote.  ",
        });
        expect(parseEditorialMeta(raw)).toEqual({
            deck: "A deck",
            pullQuote: "A quote.",
        });
    });

    it("returns null when JSON is malformed", () => {
        expect(parseEditorialMeta("not json")).toBeNull();
    });

    it("returns null when fields are missing", () => {
        expect(parseEditorialMeta(JSON.stringify({ deck: "x" }))).toBeNull();
        expect(parseEditorialMeta(JSON.stringify({ pullQuote: "x" }))).toBeNull();
    });

    it("returns null when fields are empty strings", () => {
        expect(parseEditorialMeta(JSON.stringify({ deck: "", pullQuote: "x" }))).toBeNull();
    });
});
