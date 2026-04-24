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

    it("returns null when fields are non-string types", () => {
        expect(parseEditorialMeta(JSON.stringify({ deck: 123, pullQuote: "x" }))).toBeNull();
        expect(parseEditorialMeta(JSON.stringify({ deck: "x", pullQuote: null }))).toBeNull();
    });

    it("returns null when fields are whitespace-only (trim to empty)", () => {
        expect(parseEditorialMeta(JSON.stringify({ deck: "   ", pullQuote: "x" }))).toBeNull();
    });

    it("leaves single-period endings alone (ellipsis regex is 3+ dots)", () => {
        const raw = JSON.stringify({ deck: "A deck.", pullQuote: "A quote.." });
        // "A deck." → unchanged; "A quote.." → unchanged (2 dots, not 3)
        expect(parseEditorialMeta(raw)).toEqual({ deck: "A deck.", pullQuote: "A quote.." });
    });

    it("treats empty pullQuote as invalid", () => {
        expect(parseEditorialMeta(JSON.stringify({ deck: "x", pullQuote: "" }))).toBeNull();
    });
});
