/**
 * XSS-safe Markdown rendering
 * Extracted from src/routes/public.ts — shared by the site renderer and email dispatcher.
 */

import { marked, Renderer, Parser } from "marked";
import { escapeHtml } from "./auth";

// ============================================================================
// Markdown Renderer (XSS-safe)
// Applied once at module scope — strips raw HTML and javascript: links
// ============================================================================
const sanitizingRenderer = new Renderer();

// Strip raw HTML blocks entirely (e.g. <script>, <img onerror=...>)
sanitizingRenderer.html = (_token) => "";

// Strip javascript:/data: link hrefs, keep link text; pass normal links through.
// - Uses Parser.parseInline to correctly render inline formatting in link text.
// - Decodes percent-encoded hrefs before checking to catch javascript%3A etc.
// - Escapes href and title to prevent attribute injection.
sanitizingRenderer.link = ({ href, title, tokens }) => {
    // Render inline tokens (handles **bold**, _italic_, `code` in link text)
    const text = Parser.parseInline(tokens);
    // Decode percent-encoding before protocol check (e.g. javascript%3A)
    const decodedHref = (() => { try { return decodeURIComponent(href ?? ""); } catch { return href ?? ""; } })();
    if (decodedHref && /^(javascript|data):/i.test(decodedHref.trim())) {
        return text; // drop the href entirely, keep visible text
    }
    const safeHref = escapeHtml(href ?? "");
    const titleAttr = title ? ` title="${escapeHtml(title)}"` : "";
    return `<a href="${safeHref}"${titleAttr}>${text}</a>`;
};

marked.use({ renderer: sanitizingRenderer });

/**
 * Render markdown to HTML using the marked library.
 * XSS-safe: raw HTML is stripped, javascript: links are sanitized.
 */
export function renderMarkdown(md: string): string {
    if (!md) return "";
    return marked.parse(md, { gfm: true, breaks: false }) as string;
}
