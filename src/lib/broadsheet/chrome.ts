import { escapeHtml } from "../auth";
import { computeVolume, computeIssueNumber, LAUNCH_YEAR } from "./masthead";

const ROMAN_LAUNCH = "MMXXV"; // 2025
const TLDL_TZ = "America/Los_Angeles";

/** Convert a Date to a UTC-midnight Date whose y/m/d match the Pacific-time calendar date. */
function pacificCalendarDate(d: Date): Date {
    const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: TLDL_TZ, year: "numeric", month: "2-digit", day: "2-digit",
    }).formatToParts(d);
    const get = (t: string) => Number(parts.find(p => p.type === t)?.value ?? "0");
    return new Date(Date.UTC(get("year"), get("month") - 1, get("day")));
}

export function renderMasthead(opts: { now: Date; episodeCount: number }): string {
    const { now, episodeCount } = opts;
    const ptDate = pacificCalendarDate(now);
    const vol = computeVolume(ptDate.getUTCFullYear());
    const no = computeIssueNumber(ptDate);
    const longDate = now.toLocaleDateString("en-US", {
        weekday: "long", year: "numeric", month: "long", day: "numeric",
        timeZone: TLDL_TZ,
    });
    return `<div class="bs-mast">
  <div class="bs-mast-left">
    <div><b>Vol. ${vol} — No. ${no}</b></div>
    <div>${longDate}</div>
    <div>Est. ${ROMAN_LAUNCH}</div>
  </div>
  <div class="bs-wordmark" aria-label="TL;DL — Too Long, Didn't Listen">T<span class="dot">L</span>;D<span class="l">L</span></div>
  <div class="bs-mast-right">
    <div><b>Too Long, Didn't Listen</b></div>
    <div>A Weekly Ledger of Long-Form Audio</div>
    <div>${episodeCount} ${episodeCount === 1 ? "Episode" : "Episodes"} in the Archive</div>
  </div>
</div>`;
}

export type SubnavKey = "index" | "podcasts" | "archive" | "tags" | "about" | "subscribe";

export function renderSubnav(active: SubnavKey, query: string = ""): string {
    const items: Array<{ key: SubnavKey; label: string; href: string }> = [
        { key: "index", label: "Today's Index", href: "/" },
        { key: "podcasts", label: "Podcasts", href: "/podcasts" },
        { key: "tags", label: "By Tag", href: "/tag" },
        { key: "about", label: "About", href: "/about" },
        { key: "subscribe", label: "Subscribe", href: "/subscribe" },
    ];
    return `<div class="bs-subhead">
  <div class="nav-items">
    ${items.map(i => `<a href="${i.href}" class="${i.key === active ? "active" : ""}">${i.label}</a>`).join("")}
  </div>
  <form class="bs-search" action="/" method="get" role="search">
    <input type="search" name="q" placeholder="Search episodes…" autocomplete="off" value="${escapeHtml(query)}">
  </form>
</div>`;
}

/**
 * Renders the italic-Fraunces section heading bar used across Index, Podcasts,
 * Tags, and Search pages. Treats both arguments as untrusted text — they're
 * escaped internally so callers can safely pass KV or query-param values.
 */
export function renderSectionBar(heading: string, count: string): string {
    return `<div class="bs-section-bar">
  <h2>${escapeHtml(heading)}</h2>
  <span class="rule"></span>
  <span class="count">${escapeHtml(count)}</span>
</div>`;
}

export interface PaginationOptions {
    currentPage: number;
    totalPages: number;
    basePath: string;                      // e.g. "/", "/podcasts/123", "/tag/ai"
    extraParams?: Record<string, string>;  // e.g. {q: "term"} — preserved across pages
}

export function renderPagination(opts: PaginationOptions): string {
    if (opts.totalPages <= 1) return "";
    const { currentPage, totalPages, basePath } = opts;
    const buildHref = (page: number) => {
        const params = new URLSearchParams();
        if (page > 1) params.set("page", String(page));
        for (const [k, v] of Object.entries(opts.extraParams ?? {})) {
            if (v) params.set(k, v);
        }
        const qs = params.toString();
        return qs ? `${basePath}?${qs}` : basePath;
    };
    const prev = currentPage > 1
        ? `<a href="${escapeHtml(buildHref(currentPage - 1))}">← Previous</a>`
        : `<span class="disabled">← Previous</span>`;
    const next = currentPage < totalPages
        ? `<a href="${escapeHtml(buildHref(currentPage + 1))}">Next →</a>`
        : `<span class="disabled">Next →</span>`;
    return `<div class="bs-pagination">
  ${prev}
  <span class="page-info">Page ${currentPage} of ${totalPages}</span>
  ${next}
</div>`;
}

export function renderFooter(): string {
    return `<div class="bs-footer">
  <span>TL;DL · A curated audio ledger</span>
  <span><a href="/request">Request a Podcast</a></span>
</div>`;
}

export { LAUNCH_YEAR };
