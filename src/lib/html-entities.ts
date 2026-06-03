/**
 * HTML/XML character entity decoding.
 *
 * Podcast feeds routinely arrive with entity-encoded titles: named entities
 * (`&amp;` `&quot;`), decimal numeric references (`&#8220;`) and hex references
 * (`&#x201C;`), sometimes double-encoded (`&amp;#8220;`). `fast-xml-parser`
 * only resolves the five predefined XML entities, so numeric references survive
 * into stored titles and then render as literal `&#8220;` text once the view
 * layer HTML-escapes them. Decoding at ingest keeps clean Unicode in storage
 * while the render layer keeps doing its job (escaping for safety).
 *
 * Single pass by design: at the point this runs, `fast-xml-parser` has already
 * collapsed `&amp;` → `&`, so the input is single-level. One pass turns
 * `&#8220;` into `"`; it deliberately does NOT recursively decode, so a
 * double-encoded literal only unwinds one level rather than risking
 * over-decoding legitimate text.
 */

const NAMED_ENTITIES: Record<string, string> = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: " ",
};

// Matches `&#1234;` (decimal), `&#x1F600;` (hex), or `&name;` (named).
const ENTITY_RE = /&(?:#(\d+)|#[xX]([0-9a-fA-F]+)|([a-zA-Z][a-zA-Z0-9]*));/g;

const MAX_CODE_POINT = 0x10ffff;

/**
 * Decode HTML/XML character entities into their Unicode characters.
 * Unknown named entities and out-of-range/malformed numeric references are
 * left intact. Returns the input unchanged when it contains no `&`.
 */
export function decodeHtmlEntities(text: string): string {
    if (!text || text.indexOf("&") === -1) {
        return text;
    }

    return text.replace(ENTITY_RE, (match, dec?: string, hex?: string, named?: string) => {
        if (named !== undefined) {
            const mapped = NAMED_ENTITIES[named.toLowerCase()];
            return mapped !== undefined ? mapped : match;
        }

        const codePoint = dec !== undefined ? parseInt(dec, 10) : parseInt(hex!, 16);
        if (Number.isNaN(codePoint) || codePoint < 0 || codePoint > MAX_CODE_POINT) {
            return match;
        }

        try {
            return String.fromCodePoint(codePoint);
        } catch {
            // Surrogate-range or otherwise invalid code points throw — keep the raw text.
            return match;
        }
    });
}
