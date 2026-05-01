import { escapeHtml } from "../auth";

const OG_IMAGE = "https://file.elezea.com/tldl-og-1200x630.png";

export interface HeadOptions {
    title: string;                  // full <title> content, already formed
    description?: string;           // meta description + OG description
    canonicalUrl?: string;          // absolute URL — emits canonical + og:url
    ogImage?: string;               // defaults to the hero image
    extra?: string;                 // extra tags to append verbatim (trusted HTML)
}

/**
 * Shared <head> block for every Broadsheet page. Covers favicon, manifest,
 * theme color, description, canonical URL, Open Graph, Twitter cards, and the
 * RSS alternate link.
 */
export function renderBroadsheetHead(opts: HeadOptions): string {
    const title = escapeHtml(opts.title);
    const description = escapeHtml(opts.description ?? "Podcast summaries that respect your time. Read long-form podcast episodes as scannable takeaways, narratives, or ELI5 explanations.");
    const ogImage = escapeHtml(opts.ogImage ?? OG_IMAGE);
    const canonical = opts.canonicalUrl ? escapeHtml(opts.canonicalUrl) : "";

    return `<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<meta name="description" content="${description}">
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<link rel="manifest" href="/manifest.webmanifest">
<meta name="theme-color" content="#10100e">
<meta property="og:title" content="${title}">
<meta property="og:description" content="${description}">
<meta property="og:type" content="website">
<meta property="og:image" content="${ogImage}">
${canonical ? `<meta property="og:url" content="${canonical}">\n<link rel="canonical" href="${canonical}">` : ""}
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${title}">
<meta name="twitter:description" content="${description}">
<meta name="twitter:image" content="${ogImage}">
<link rel="alternate" type="application/rss+xml" title="TL;DL RSS Feed" href="/feed">
${opts.extra ?? ""}`;
}
