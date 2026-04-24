import { escapeHtml } from "../auth";
import { BROADSHEET_FONTS_LINK, BROADSHEET_TOKENS_CSS } from "./tokens.css";
import { renderBroadsheetHead } from "./head";
import { BROADSHEET_SHARED_CSS } from "./shared.css";
import { renderMasthead, renderSubnav, renderSectionBar, renderFooter, type SubnavKey } from "./chrome";

export interface TagBrowsePageOptions {
    tags: Array<[string, number]>;
    totalInArchive: number;
    now?: Date;
}

const TAG_BROWSE_CSS = `
.bs-taglist-wrap { padding: 0 56px 48px; }
.bs-taglist {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 0 48px;
  border-bottom: 1px solid var(--bs-rule);
}
.bs-taglist a {
  display: flex; justify-content: space-between; align-items: baseline;
  padding: 22px 0;
  border-top: 1px solid var(--bs-rule);
  font-family: 'JetBrains Mono', ui-monospace, monospace;
  font-size: 13px; letter-spacing: 0.08em; text-transform: uppercase;
  color: var(--bs-ink);
  text-decoration: none;
}
.bs-taglist a .t { color: var(--bs-ink); transition: color 160ms ease; }
.bs-taglist a:hover .t { color: var(--bs-red); }
.bs-taglist a .n { color: var(--bs-ink-faint); font-size: 11px; }
@media (max-width: 767px) {
  .bs-taglist-wrap { padding: 0 20px 32px; }
  .bs-taglist { grid-template-columns: 1fr; }
}
`;

export function renderTagBrowsePage(opts: TagBrowsePageOptions): string {
    const now = opts.now ?? new Date();
    const activeNav: SubnavKey = "tags";
    const count = opts.tags.length;
    const sectionCount = `${count} ${count === 1 ? "Tag" : "Tags"} in Use`;

    const rows = opts.tags
        .map(([tag, n]) => `<a href="/tag/${encodeURIComponent(tag)}"><span class="t">${escapeHtml(tag)}</span><span class="n">${n}</span></a>`)
        .join("\n");

    return `<!doctype html>
<html lang="en">
<head>
${renderBroadsheetHead({ title: "Tags — TL;DL", canonicalUrl: "https://tldl-pod.com/tag" })}
${BROADSHEET_FONTS_LINK}
<style>${BROADSHEET_TOKENS_CSS}${BROADSHEET_SHARED_CSS}${TAG_BROWSE_CSS}</style>
</head>
<body>
<div class="bs-page">
${renderMasthead({ now, episodeCount: opts.totalInArchive })}
${renderSubnav(activeNav)}
${renderSectionBar("Tags — Browse by Subject", sectionCount)}
<div class="bs-taglist-wrap"><div class="bs-taglist">
${rows}
</div></div>
${renderFooter()}
</div>
</body>
</html>`;
}

