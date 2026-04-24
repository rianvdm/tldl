import type { Episode } from "../../types";

function escape(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function shortDate(iso: string): string {
    return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

function formatDuration(seconds: number): string {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    return h > 0 ? `${h}h ${m.toString().padStart(2, "0")}m` : `${m}m`;
}

function renderTagChips(tags: readonly string[] | undefined): string {
    if (!tags || tags.length === 0) return "";
    const chips = tags.map(t => `<span class="chip">${escape(t)}</span>`).join("");
    return `<span class="sep">/</span>${chips}`;
}

export function renderLead(ep: Episode): string {
    const hasPull = Boolean(ep.pullQuote);
    const deck = ep.deck ?? "";
    const podcastUc = escape(ep.podcastName).toUpperCase();
    const authorUc = ep.podcastAuthor ? ` · BY ${escape(ep.podcastAuthor).toUpperCase()}` : "";
    const href = `/episode/${encodeURIComponent(ep.id)}`;

    return `<div class="bs-lead${hasPull ? "" : " single"}">
  <div>
    <div class="bs-lead-dateline">The Lead — ${shortDate(ep.episodeDate)} Edition</div>
    <div class="bs-lead-kicker">${podcastUc}${authorUc}</div>
    <h1 class="bs-lead-title"><a href="${href}">${escape(ep.episodeTitle)}</a></h1>
    ${deck ? `<p class="bs-lead-deck">${escape(deck)}</p>` : ""}
    <div class="bs-lead-meta">
      <span>${formatDuration(ep.episodeDuration)}</span>
      <span class="sep">/</span>
      <span>${shortDate(ep.episodeDate)}</span>
      ${renderTagChips(ep.tags)}
    </div>
  </div>
  ${hasPull ? `<div class="bs-pull">
    <span class="q-mark">“</span>
    <span class="bs-pull-q">${escape(ep.pullQuote!)}</span>
    <span class="bs-pull-src">— From the episode</span>
  </div>` : ""}
</div>`;
}
