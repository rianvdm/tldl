import type { Episode } from "../../types";
import { BROADSHEET_FONTS_LINK, BROADSHEET_TOKENS_CSS } from "./tokens.css";
import { BROADSHEET_SHARED_CSS } from "./shared.css";
import { BROADSHEET_DETAIL_CSS } from "./detail.css";

export type TemplateId = "key-takeaways" | "narrative-summary" | "eli5";

const TEMPLATE_LABELS: Record<TemplateId, string> = {
    "key-takeaways": "Key Takeaways",
    "narrative-summary": "Narrative",
    "eli5": "ELI5",
};

export interface DetailPageOptions {
    episode: Episode;
    summaryHtml: string;
    activeTemplate: TemplateId;
    availableTemplates: TemplateId[];
    transcriptText: string | null;
    now?: Date;
}

function escape(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function shortDate(iso: string): string {
    return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

function longDate(iso: string): string {
    return new Date(iso).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });
}

function formatDuration(seconds: number): string {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    return h > 0 ? `${h}h ${m.toString().padStart(2, "0")}m` : `${m}m`;
}

function formatTranscriptParagraphs(text: string): string {
    const lines = text.split(/\n+/).map(l => l.trim()).filter(Boolean);
    return lines.map(l => `<p>${escape(l)}</p>`).join("\n");
}

function renderTagChips(tags: readonly string[] | undefined): string {
    if (!tags || tags.length === 0) return "";
    const chips = tags.map(t => `<span class="chip">${escape(t)}</span>`).join("");
    return `<span class="sep">/</span>${chips}`;
}

export function renderDetailPage(opts: DetailPageOptions): string {
    const ep = opts.episode;
    const showPullQuote = opts.activeTemplate !== "eli5" && Boolean(ep.pullQuote);
    const kicker = `${escape(ep.podcastName).toUpperCase()}${
        ep.podcastAuthor ? ` · ${escape(ep.podcastAuthor).toUpperCase()}` : ""
    }`;

    const templates = opts.availableTemplates.map(t => {
        const active = t === opts.activeTemplate ? " active" : "";
        const href = `/episode/${encodeURIComponent(ep.id)}?template=${t}`;
        return `<a class="tmpl${active}" href="${href}">${TEMPLATE_LABELS[t]}</a>`;
    }).join("\n");

    const transcriptBody = opts.transcriptText
        ? `<div class="bsd-transcript-head">
             <span>Source: ${escape(ep.transcriptSource)}</span>
             <span>${formatDuration(ep.episodeDuration)} runtime</span>
           </div>
           ${formatTranscriptParagraphs(opts.transcriptText)}`
        : `<p class="bsd-transcript-missing">— transcript not available for this episode —</p>`;

    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(ep.episodeTitle)} — TL;DL</title>
${BROADSHEET_FONTS_LINK}
<style>${BROADSHEET_TOKENS_CSS}${BROADSHEET_SHARED_CSS}${BROADSHEET_DETAIL_CSS}</style>
</head>
<body>
<div class="bsd-root">
  <div class="bsd-topbar">
    <a class="back" href="/">← Return to Index</a>
    <span>Archived ${longDate(ep.episodeDate)}</span>
  </div>
  <div class="bsd-dateline">The Lead — ${shortDate(ep.episodeDate)}</div>
  <div class="bsd-pod">${kicker}</div>
  <h1 class="bsd-title">${escape(ep.episodeTitle)}</h1>
  ${ep.deck ? `<p class="bsd-deck">${escape(ep.deck)}</p>` : ""}
  <div class="bsd-meta">
    <span>${formatDuration(ep.episodeDuration)}</span>
    <span class="sep">/</span>
    <span>${longDate(ep.episodeDate)}</span>
    ${renderTagChips(ep.tags)}
    <span class="sep">/</span>
    <span>Transcript sourced from ${escape(ep.transcriptSource)}</span>
  </div>

  <div class="bsd-grid">
    <aside class="bsd-side">
      <h4>Summary</h4>
      ${templates}
    </aside>
    <article class="bsd-body">
      ${opts.summaryHtml}
      ${showPullQuote ? `<div class="bsd-pullquote">
        <span class="bsd-pullquote-q">${escape(ep.pullQuote!)}</span>
        <cite>— From the episode</cite>
      </div>` : ""}
      <h3>Full Transcript</h3>
      <div class="bsd-section-rule"></div>
      <div class="bsd-transcript">${transcriptBody}</div>
    </article>
  </div>
</div>
</body>
</html>`;
}
