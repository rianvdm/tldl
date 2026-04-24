import { escapeHtml } from "../auth";
import { BROADSHEET_FONTS_LINK, BROADSHEET_TOKENS_CSS } from "./tokens.css";
import { BROADSHEET_SHARED_CSS } from "./shared.css";
import {
    renderMasthead,
    renderSubnav,
    renderSectionBar,
    renderFooter,
    type SubnavKey,
} from "./chrome";

const BROADSHEET_STATIC_CSS = `
.bs-static {
    padding: 40px 56px 72px;
    max-width: 62ch;
    font-family: 'Fraunces', Georgia, serif;
    font-size: 19px; line-height: 1.55;
    color: var(--bs-ink);
}
.bs-static p { margin: 0 0 22px; text-wrap: pretty; }
.bs-static h2, .bs-static h3 {
    font-family: 'Fraunces', Georgia, serif;
    font-style: italic; font-weight: 500;
    color: var(--bs-ink);
    margin: 32px 0 14px;
}
.bs-static h2 { font-size: 28px; }
.bs-static h3 { font-size: 22px; }
.bs-static a { color: var(--bs-red); border-bottom: 1px solid currentColor; text-decoration: none; }
.bs-static a:hover { color: var(--bs-ink); }
.bs-static ul, .bs-static ol { padding-left: 24px; margin: 0 0 22px; }
.bs-static li { margin-bottom: 6px; }
.bs-static code { font-family: 'JetBrains Mono', monospace; font-size: 0.9em; color: var(--bs-ink-dim); }
@media (max-width: 1023px) { .bs-static { padding-left: 40px; padding-right: 40px; } }
@media (max-width: 767px) { .bs-static { padding: 24px 20px 48px; } }
`;

export interface StaticPageOptions {
    activeNav: SubnavKey;
    sectionHeading: string;
    sectionCount: string;
    bodyHtml: string;
    pageTitle: string;
    now?: Date;
    totalInArchive: number;
}

export function renderStaticPage(opts: StaticPageOptions): string {
    const now = opts.now ?? new Date();
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(opts.pageTitle)}</title>
${BROADSHEET_FONTS_LINK}
<style>${BROADSHEET_TOKENS_CSS}${BROADSHEET_SHARED_CSS}${BROADSHEET_STATIC_CSS}</style>
</head>
<body>
<div class="bs-page">
${renderMasthead({ now, episodeCount: opts.totalInArchive })}
${renderSubnav(opts.activeNav)}
${renderSectionBar(opts.sectionHeading, opts.sectionCount)}
<div class="bs-static">
${opts.bodyHtml}
</div>
${renderFooter()}
</div>
</body>
</html>`;
}
