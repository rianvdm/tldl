import type { PodcastInfo } from "../kv";
import { escapeHtml } from "../auth";
import { BROADSHEET_FONTS_LINK, BROADSHEET_TOKENS_CSS } from "./tokens.css";
import { renderBroadsheetHead } from "./head";
import { BROADSHEET_SHARED_CSS } from "./shared.css";
import { renderMasthead, renderSubnav, renderSectionBar, renderFooter, type SubnavKey } from "./chrome";

export interface PodcastBrowsePageOptions {
    podcasts: PodcastInfo[];
    totalInArchive: number;
    now?: Date;
}

const PODCAST_BROWSE_CSS = `
.bs-podcastlist-wrap { padding: 0 56px 48px; }
.bs-podcastlist {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 0 48px;
  border-bottom: 1px solid var(--bs-rule);
}
.bs-podcastlist a {
  display: flex; justify-content: space-between; align-items: baseline;
  gap: 16px;
  padding: 22px 0;
  border-top: 1px solid var(--bs-rule);
  color: var(--bs-ink);
  text-decoration: none;
}
.bs-podcastlist a:hover .bs-podcast-name { color: var(--bs-red); }
.bs-podcast-main { min-width: 0; flex: 1; }
.bs-podcast-name {
  font-family: 'Fraunces', Georgia, serif;
  font-weight: 500; font-size: 20px; line-height: 1.2;
  color: var(--bs-ink);
  transition: color 160ms ease;
}
.bs-podcast-author {
  font-family: 'JetBrains Mono', ui-monospace, monospace;
  font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase;
  color: var(--bs-ink-faint);
  margin-top: 4px;
}
.bs-podcastlist a .n {
  font-family: 'JetBrains Mono', ui-monospace, monospace;
  font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase;
  color: var(--bs-ink-faint);
  white-space: nowrap;
}
@media (max-width: 767px) {
  .bs-podcastlist-wrap { padding: 0 20px 32px; }
  .bs-podcastlist { grid-template-columns: 1fr; }
}
`;

export function renderPodcastBrowsePage(opts: PodcastBrowsePageOptions): string {
    const now = opts.now ?? new Date();
    const activeNav: SubnavKey = "podcasts";
    const count = opts.podcasts.length;
    const sectionCount = `${count} ${count === 1 ? "Podcast" : "Podcasts"} in the Archive`;

    const rows = opts.podcasts
        .map(p => {
            const epLabel = `${p.episodeCount} ${p.episodeCount === 1 ? "Ep" : "Eps"}`;
            const author = p.author ? `<div class="bs-podcast-author">${escapeHtml(p.author)}</div>` : "";
            return `<a href="/podcasts/${encodeURIComponent(p.id)}">
  <div class="bs-podcast-main">
    <div class="bs-podcast-name">${escapeHtml(p.name)}</div>
    ${author}
  </div>
  <span class="n">${epLabel}</span>
</a>`;
        })
        .join("\n");

    return `<!doctype html>
<html lang="en">
<head>
${renderBroadsheetHead({ title: "Podcasts — TL;DL", canonicalUrl: "https://tldl-pod.com/podcasts" })}
${BROADSHEET_FONTS_LINK}
<style>${BROADSHEET_TOKENS_CSS}${BROADSHEET_SHARED_CSS}${PODCAST_BROWSE_CSS}</style>
</head>
<body>
<div class="bs-page">
${renderMasthead({ now, episodeCount: opts.totalInArchive })}
${renderSubnav(activeNav)}
${renderSectionBar("Podcasts — All Shows", sectionCount)}
<div class="bs-podcastlist-wrap"><div class="bs-podcastlist">
${rows}
</div></div>
${renderFooter()}
</div>
</body>
</html>`;
}
