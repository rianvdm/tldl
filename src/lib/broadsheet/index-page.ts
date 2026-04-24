import type { Episode, EpisodeIndexEntry } from "../../types";
import { BROADSHEET_FONTS_LINK, BROADSHEET_TOKENS_CSS } from "./tokens.css";
import { BROADSHEET_SHARED_CSS } from "./shared.css";
import { BROADSHEET_INDEX_CSS } from "./index.css";
import { renderMasthead, renderSubnav, renderSectionBar, renderFooter, renderPagination, type SubnavKey, type PaginationOptions } from "./chrome";
import { renderLead } from "./lead";
import { renderIndexRow } from "./index-row";
import { renderBroadsheetHead } from "./head";

export interface IndexPageOptions {
    lead: Episode | null;
    rows: (EpisodeIndexEntry & { deck?: string })[];
    totalInArchive: number;
    sectionHeading: string;
    sectionCount: string;
    activeNav: SubnavKey;
    pageTitle: string;
    searchQuery?: string;
    pagination?: PaginationOptions;
    rowStartNumber?: number;  // first row's "№" (1 on page 1, 21 on page 2 with size 20)
    description?: string;
    canonicalUrl?: string;
    now?: Date;
}

export function renderIndexPage(opts: IndexPageOptions): string {
    const now = opts.now ?? new Date();
    return `<!doctype html>
<html lang="en">
<head>
${renderBroadsheetHead({ title: opts.pageTitle, description: opts.description, canonicalUrl: opts.canonicalUrl })}
${BROADSHEET_FONTS_LINK}
<style>${BROADSHEET_TOKENS_CSS}${BROADSHEET_SHARED_CSS}${BROADSHEET_INDEX_CSS}</style>
</head>
<body>
<div class="bs-page">
${renderMasthead({ now, episodeCount: opts.totalInArchive })}
${renderSubnav(opts.activeNav, opts.searchQuery ?? "")}
${opts.lead ? renderLead(opts.lead) : ""}
${renderSectionBar(opts.sectionHeading, opts.sectionCount)}
<div class="bs-index">
${opts.rows.map((ep, i) => renderIndexRow(ep, (opts.rowStartNumber ?? (opts.lead ? 2 : 1)) + i)).join("\n")}
</div>
${opts.pagination ? renderPagination(opts.pagination) : ""}
${renderFooter()}
</div>
</body>
</html>`;
}
