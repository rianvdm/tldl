import type { Episode, EpisodeIndexEntry } from "../../types";
import { BROADSHEET_FONTS_LINK, BROADSHEET_TOKENS_CSS } from "./tokens.css";
import { BROADSHEET_SHARED_CSS } from "./shared.css";
import { BROADSHEET_INDEX_CSS } from "./index.css";
import { renderMasthead, renderSubnav, renderSectionBar, renderFooter, type SubnavKey } from "./chrome";
import { renderLead } from "./lead";
import { renderIndexRow } from "./index-row";

export interface IndexPageOptions {
    lead: Episode | null;
    rows: (EpisodeIndexEntry & { deck?: string })[];
    totalInArchive: number;
    sectionHeading: string;
    sectionCount: string;
    activeNav: SubnavKey;
    pageTitle: string;
    now?: Date;
}

export function renderIndexPage(opts: IndexPageOptions): string {
    const now = opts.now ?? new Date();
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeTitle(opts.pageTitle)}</title>
${BROADSHEET_FONTS_LINK}
<style>${BROADSHEET_TOKENS_CSS}${BROADSHEET_SHARED_CSS}${BROADSHEET_INDEX_CSS}</style>
</head>
<body>
<div class="bs-page">
${renderMasthead({ now, episodeCount: opts.totalInArchive })}
${renderSubnav(opts.activeNav)}
${opts.lead ? renderLead(opts.lead) : ""}
${renderSectionBar(opts.sectionHeading, opts.sectionCount)}
<div class="bs-index">
${opts.rows.map((ep, i) => renderIndexRow(ep, opts.lead ? i + 2 : i + 1)).join("\n")}
</div>
${renderFooter()}
</div>
</body>
</html>`;
}

function escapeTitle(s: string): string {
    return s.replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
