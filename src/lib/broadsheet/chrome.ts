import { computeVolume, computeIssueNumber, LAUNCH_YEAR } from "./masthead";

const ROMAN_LAUNCH = "MMXXV"; // 2025

export function renderMasthead(opts: { now: Date; episodeCount: number }): string {
    const { now, episodeCount } = opts;
    const vol = computeVolume(now.getUTCFullYear());
    const no = computeIssueNumber(now);
    const longDate = now.toLocaleDateString("en-US", {
        weekday: "long", year: "numeric", month: "long", day: "numeric",
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

export type SubnavKey = "index" | "podcasts" | "archive" | "tags" | "subscribe";

export function renderSubnav(active: SubnavKey, query: string = ""): string {
    const items: Array<{ key: SubnavKey; label: string; href: string }> = [
        { key: "index", label: "Today's Index", href: "/" },
        { key: "podcasts", label: "Podcasts", href: "/podcasts" },
        { key: "tags", label: "By Tag", href: "/tag" },
        { key: "subscribe", label: "Subscribe", href: "/subscribe" },
    ];
    return `<div class="bs-subhead">
  <div class="nav-items">
    ${items.map(i => `<a href="${i.href}" class="${i.key === active ? "active" : ""}">${i.label}</a>`).join("")}
  </div>
  <form class="bs-search" action="/" method="get" role="search">
    <input type="search" name="q" placeholder="Search episodes…" autocomplete="off" value="${escapeAttr(query)}">
  </form>
</div>`;
}

function escapeAttr(s: string): string {
    return s
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

function escapeText(s: string): string {
    return s
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

/**
 * Renders the italic-Fraunces section heading bar used across Index, Podcasts,
 * Tags, and Search pages. Treats both arguments as untrusted text — they're
 * escaped internally so callers can safely pass KV or query-param values.
 */
export function renderSectionBar(heading: string, count: string): string {
    return `<div class="bs-section-bar">
  <h2>${escapeText(heading)}</h2>
  <span class="rule"></span>
  <span class="count">${escapeText(count)}</span>
</div>`;
}

export function renderFooter(): string {
    return `<div class="bs-footer">
  <span>TL;DL · A curated audio ledger</span>
  <span>&nbsp;</span>
</div>`;
}

export { LAUNCH_YEAR };
