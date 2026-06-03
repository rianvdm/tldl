/**
 * Tests for the shared HTML/XML entity decoder.
 */

import { describe, it, expect } from "vitest";
import { decodeHtmlEntities } from "../src/lib/html-entities";

describe("decodeHtmlEntities", () => {
    it("decodes decimal numeric references (the curly-quote bug)", () => {
        expect(
            decodeHtmlEntities("How to Cultivate Your &#8220;Personal Power&#8221; as a Leader")
        ).toBe("How to Cultivate Your “Personal Power” as a Leader");
    });

    it("decodes a decimal apostrophe reference", () => {
        expect(
            decodeHtmlEntities("Communicating with Confidence When You&#8217;re Under Pressure")
        ).toBe("Communicating with Confidence When You’re Under Pressure");
    });

    it("decodes hex numeric references", () => {
        expect(decodeHtmlEntities("Tilde &#x201C;x&#x201D;")).toBe("Tilde “x”");
    });

    it("decodes named entities", () => {
        expect(decodeHtmlEntities("Foo &amp; Bar &lt;tag&gt; &quot;q&quot; it&apos;s")).toBe(
            'Foo & Bar <tag> "q" it\'s'
        );
        expect(decodeHtmlEntities("a&nbsp;b")).toBe("a b");
    });

    it("decodes astral code points above U+FFFF", () => {
        expect(decodeHtmlEntities("grin &#128512; and &#x1F600;")).toBe("grin \u{1F600} and \u{1F600}");
    });

    it("leaves clean text untouched and is a no-op when already decoded", () => {
        const clean = "Plain title “with real quotes”";
        expect(decodeHtmlEntities(clean)).toBe(clean);
        expect(decodeHtmlEntities("no entities here")).toBe("no entities here");
    });

    it("leaves unknown or malformed entities intact", () => {
        expect(decodeHtmlEntities("R&D and Q&A")).toBe("R&D and Q&A");
        expect(decodeHtmlEntities("price 5 &amp 6")).toBe("price 5 &amp 6");
        expect(decodeHtmlEntities("&notanentity;")).toBe("&notanentity;");
        expect(decodeHtmlEntities("&#xZZ;")).toBe("&#xZZ;");
    });

    it("does not over-decode double-encoded input (single pass)", () => {
        // fast-xml-parser already collapses &amp; -> & at parse time, so the
        // value reaching this decoder is single-level. A double-encoded literal
        // should only decode one level, never become a control character.
        expect(decodeHtmlEntities("&amp;#8220;")).toBe("&#8220;");
    });

    it("handles empty and entity-free strings cheaply", () => {
        expect(decodeHtmlEntities("")).toBe("");
    });
});
