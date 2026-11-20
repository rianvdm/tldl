import type { EpisodeIndexEntry } from "../../types";
import { escapeHtml as escape } from "../auth";
import { formatDuration } from "./format";

function shortDate(iso: string): string {
    return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

export function renderIndexRow(ep: EpisodeIndexEntry & { deck?: string }, rowNumber: number): string {
    const num = String(rowNumber).padStart(2, "0");
    const tagList = (ep.tags ?? []).map(t => escape(t)).join(", ");
    const deck = ep.deck;
    const href = `/episode/${encodeURIComponent(ep.id)}`;
    const authorPart = ep.podcastAuthor ? ` · ${escape(ep.podcastAuthor)}` : "";

    const mobileMetaParts = [
        shortDate(ep.episodeDate),
        formatDuration(ep.episodeDuration),
        tagList,
    ].filter(Boolean);

    return `<a href="${href}" class="bs-row">
  <div class="bs-row-num">№ ${num}</div>
  <div class="bs-row-body">
    <div class="bs-row-pod"><b>${escape(ep.podcastName)}</b>${authorPart}</div>
    <div class="bs-row-title">${escape(ep.episodeTitle)}</div>
    ${deck ? `<div class="bs-row-blurb">${escape(deck)}</div>` : ""}
    <div class="bs-row-meta-mobile">${mobileMetaParts.join(" · ")}</div>
  </div>
  <div class="bs-row-date">${shortDate(ep.episodeDate)}</div>
  <div class="bs-row-dur">${formatDuration(ep.episodeDuration)}</div>
  <div class="bs-row-tag">${tagList}</div>
  <div class="bs-row-arrow">→</div>
</a>`;
}
