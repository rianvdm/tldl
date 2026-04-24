import type { Episode } from "../../types";
import { escapeHtml as escape } from "../auth";
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
    const podcastId = ep.id.split("_")[0];
    const podcastHref = `/podcasts/${encodeURIComponent(podcastId)}`;
    const kicker = `<a href="${podcastHref}">${escape(ep.podcastName).toUpperCase()}</a>${
        ep.podcastAuthor ? ` · ${escape(ep.podcastAuthor).toUpperCase()}` : ""
    }`;
    const moreLinks: string[] = [
        `<a href="${podcastHref}">All episodes from ${escape(ep.podcastName)} →</a>`,
    ];
    if (ep.podcastWebsiteUrl) {
        moreLinks.push(`<a href="${escape(ep.podcastWebsiteUrl)}" target="_blank" rel="noopener noreferrer">Podcast website →</a>`);
    }

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
           <div class="bsd-transcript-body" data-collapsed="true">
             ${formatTranscriptParagraphs(opts.transcriptText)}
             <div class="bsd-transcript-fade"></div>
           </div>
           <button type="button" class="bsd-transcript-toggle" data-role="transcript-toggle" aria-expanded="false">Expand transcript →</button>`
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
  <div class="bsd-morefrom">
    ${moreLinks.join(`<span class="sep">·</span>`)}
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
<script>
(function () {
  var btn = document.querySelector('[data-role="transcript-toggle"]');
  if (!btn) return;
  var body = document.querySelector('.bsd-transcript-body');
  if (!body) return;
  btn.addEventListener('click', function () {
    var collapsed = body.getAttribute('data-collapsed') === 'true';
    body.setAttribute('data-collapsed', String(!collapsed));
    btn.setAttribute('aria-expanded', String(collapsed));
    btn.textContent = collapsed ? 'Collapse transcript ↑' : 'Expand transcript →';
  });
})();
</script>
</body>
</html>`;
}
