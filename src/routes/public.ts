/**
 * Public Routes
 * Server-rendered HTML pages accessible without authentication
 */

import { Hono } from "hono";
import { html, raw } from "hono/html";
import type { HonoEnv, Episode, EpisodeIndexEntry } from "../types";
import {
    listEpisodes,
    getEpisode,
    getEpisodeRedirect,
    getTranscript,
    listSummariesForEpisode,
    getPodcastList,
    getEpisodesForPodcast,
} from "../lib/kv";
import { isValidTag } from "../lib/constants";

import { escapeHtml } from "../lib/auth";
import { renderMarkdown } from "../lib/markdown";
import { Footer } from "../lib/components";
import { verifyTurnstile } from "../lib/turnstile";
import { sendEmail } from "../services/postmark";
import { renderIndexPage } from "../lib/broadsheet/index-page";
import { renderTagBrowsePage } from "../lib/broadsheet/tag-browse-page";
import { renderPodcastBrowsePage } from "../lib/broadsheet/podcast-browse-page";
import { renderDetailPage, type TemplateId } from "../lib/broadsheet/detail-page";
import { renderStaticPage } from "../lib/broadsheet/static-page";
import { renderFormPage } from "../lib/broadsheet/form-page";
import { selectLeadEpisode } from "../lib/broadsheet/lead-picker";
import { marked } from "marked";

const publicRoutes = new Hono<HonoEnv>();

// Base URL for canonical links
const BASE_URL = "https://tldl-pod.com";

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Format duration in seconds to human readable string
 */
/**
 * If a summary's first heading (h1/h2/h3) references the episode title, strip
 * it — the detail page already renders the title as H1. Only strips when the
 * heading looks title-like (contains the episode title or a meaningful chunk
 * of it), so legitimate ## Overview / ## The Story headings stay intact.
 */
function stripDuplicateTitleHeading(md: string, episodeTitle: string): string {
    const match = md.match(/^\s*(#{1,3})\s+([^\n]+)\n+/);
    if (!match) return md;
    const headingLower = match[2].toLowerCase();
    const titleLower = episodeTitle.toLowerCase();
    const titleKey = titleLower.slice(0, Math.min(titleLower.length, 18));
    if (titleKey.length >= 6 && headingLower.includes(titleKey)) {
        return md.slice(match[0].length);
    }
    return md;
}

function formatDuration(seconds: number): string {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);

    if (hours > 0) {
        return `${hours}h ${minutes}m`;
    }
    return `${minutes}m`;
}

// escapeHtml imported from ../lib/auth

// ============================================================================
// Layout Component
// ============================================================================

export function Layout(props: { title: string; children: string; headExtra?: string; description?: string; canonicalUrl?: string }) {
    // Use custom title for home page
    const pageTitle = props.title === "Home"
        ? "TL;DL - Too Long Didn't Listen"
        : `${props.title} - TL;DL`;

    // Use custom description or default
    const defaultDescription = "AI-powered podcast summaries from Apple Podcasts URLs";
    const metaDescription = props.description || defaultDescription;
    const ogDescription = props.description || "Get AI summaries of podcast episodes";

    const ogImage = "https://file.elezea.com/tldl-og-1200x630.png";
    const canonicalUrl = props.canonicalUrl || null;

    return html`<!DOCTYPE html>
        <html lang="en" class="dark">
            <head>
                <meta charset="UTF-8" />
                <meta
                    name="viewport"
                    content="width=device-width, initial-scale=1.0"
                />
                <title>${pageTitle}</title>
                <meta
                    name="description"
                    content="${metaDescription}"
                />
                <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
                <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
                <link rel="manifest" href="/manifest.webmanifest" />
                <meta name="theme-color" content="#0a0a0a" />
                <meta property="og:title" content="${pageTitle}" />
                <meta property="og:description" content="${ogDescription}" />
                <meta property="og:type" content="website" />
                <meta property="og:image" content="${ogImage}" />
                ${raw(canonicalUrl ? `<meta property="og:url" content="${canonicalUrl}" />` : '')}
                ${raw(canonicalUrl ? `<link rel="canonical" href="${canonicalUrl}" />` : '')}
                <meta name="twitter:card" content="summary_large_image" />
                <meta name="twitter:title" content="${pageTitle}" />
                <meta name="twitter:description" content="${ogDescription}" />
                <meta name="twitter:image" content="${ogImage}" />
                <link rel="stylesheet" href="/styles.css" />
                <link rel="alternate" type="application/rss+xml" title="TL;DL RSS Feed" href="/feed" />
                ${raw(props.headExtra || "")}
            </head>
            <body>
                <div class="container">
                    <nav class="nav">
                        <a href="/" class="nav-brand">TL;D<span class="text-accent">L</span></a>
                        <span class="nav-tagline"
                            >Too Long Didn't Listen</span
                        >
                        <a href="/podcasts" class="nav-link">Podcasts</a>
                        <a href="/subscribe" class="nav-link">Subscribe</a>
                        <a href="/about" class="nav-link">About</a>
                    </nav>
                    <main class="main">${raw(props.children)}</main>
                    ${Footer}
                </div>
            </body>
        </html>`;
}

// ============================================================================
// GET / — Episode List (Home Page)
// ============================================================================

publicRoutes.get("/", async (c) => {
    const indexEntries = await c.env.TLDL_DATA.get<EpisodeIndexEntry[]>("episodes:index", "json") ?? [];

    const sorted = [...indexEntries].sort((a, b) => {
        if (a.episodeDate !== b.episodeDate) return b.episodeDate.localeCompare(a.episodeDate);
        return b.createdAt.localeCompare(a.createdAt);
    });

    const q = (c.req.query("q") ?? "").trim();
    const isSearch = q.length > 0;

    let rowsRaw: EpisodeIndexEntry[];
    let leadFull: Episode | null = null;

    if (isSearch) {
        const needle = q.toLowerCase();
        rowsRaw = sorted.filter(e =>
            e.episodeTitle.toLowerCase().includes(needle) ||
            e.podcastName.toLowerCase().includes(needle) ||
            (e.podcastAuthor ?? "").toLowerCase().includes(needle)
        );
    } else {
        const leadEntry = selectLeadEpisode(sorted);
        leadFull = leadEntry ? await c.env.TLDL_DATA.get<Episode>(`episode:${leadEntry.id}`, "json") : null;
        // Only exclude the lead from the row list when we successfully hydrated
        // it. If KV returns null (race on a fresh write, expired record, data
        // inconsistency), keep the entry in rows so the newest episode is still
        // visible on the home page.
        rowsRaw = leadFull ? sorted.filter(e => e.id !== leadEntry!.id) : sorted;
    }

    const PAGE_SIZE = 20;
    const totalMatching = rowsRaw.length;
    const totalPages = Math.max(1, Math.ceil(totalMatching / PAGE_SIZE));
    const currentPage = Math.max(1, Math.min(totalPages, parseInt(c.req.query("page") ?? "1", 10) || 1));
    const start = (currentPage - 1) * PAGE_SIZE;
    const rowsSliced = rowsRaw.slice(start, start + PAGE_SIZE);
    const hydrated = await Promise.all(rowsSliced.map(async r => {
        const ep = await c.env.TLDL_DATA.get<Episode>(`episode:${r.id}`, "json");
        return { ...r, deck: ep?.deck };
    }));

    const sectionHeading = isSearch ? `Search — "${q}"` : "The Index";
    const totalLabel = `${totalMatching} ${totalMatching === 1 ? "Entry" : "Entries"}`;
    const sectionCount = isSearch
        ? `${totalLabel} Matching`
        : `${totalLabel} · Most Recent First`;

    // Lead sits above row 1 only on page 1 of the unfiltered home
    const showLead = !isSearch && currentPage === 1;
    const leadForRender = showLead ? leadFull : null;
    const rowStartNumber = showLead ? 2 + start : 1 + start;

    const html = renderIndexPage({
        lead: leadForRender,
        rows: hydrated,
        totalInArchive: indexEntries.length,
        sectionHeading,
        sectionCount,
        activeNav: "index",
        pageTitle: isSearch ? `Search "${q}" — TL;DL` : "TL;DL — Podcast summaries that respect your time",
        searchQuery: q,
        rowStartNumber,
        pagination: {
            currentPage,
            totalPages,
            basePath: "/",
            extraParams: isSearch ? { q } : {},
        },
    });
    return c.html(html);
});

// ============================================================================
// GET /episode/:episodeId — Episode Detail Page
// ============================================================================

publicRoutes.get("/episode/:episodeId", async (c) => {
    const episodeId = c.req.param("episodeId");
    const requestedTemplate = (c.req.query("template") ?? "") as TemplateId;
    const validTemplates: TemplateId[] = ["key-takeaways", "narrative-summary", "eli5"];

    const episode = await getEpisode(c.env.TLDL_DATA, episodeId);
    if (!episode) {
        const canonical = await getEpisodeRedirect(c.env.TLDL_DATA, episodeId);
        if (canonical) return c.redirect(`/episode/${canonical}`, 301);
        return c.notFound();
    }

    // Discover which templates have summaries generated for this episode
    const summaries = await listSummariesForEpisode(c.env.TLDL_DATA, episodeId);
    const available: TemplateId[] = validTemplates.filter(t =>
        summaries.some(s => s.templateId === t)
    );
    if (available.length === 0) return c.notFound();

    const activeTemplate: TemplateId =
        validTemplates.includes(requestedTemplate) && available.includes(requestedTemplate)
            ? requestedTemplate
            : available[0];

    const activeSummary = summaries.find(s => s.templateId === activeTemplate);
    const summaryMarkdown = stripDuplicateTitleHeading(activeSummary?.text ?? "", episode.episodeTitle);
    const summaryHtml = marked.parse(summaryMarkdown) as string;

    const transcript = await getTranscript(c.env.TLDL_DATA, episodeId);
    const transcriptText = transcript?.text ?? null;

    const html = renderDetailPage({
        episode,
        summaryHtml,
        activeTemplate,
        availableTemplates: available,
        transcriptText,
    });
    return c.html(html);
});

// ============================================================================
// GET /about — About Page
// ============================================================================

publicRoutes.get("/about", async (c) => {
    const indexEntries = await c.env.TLDL_DATA.get<EpisodeIndexEntry[]>("episodes:index", "json") ?? [];

    const bodyHtml = `
<p>TL;DL (Too Long; Didn't Listen) is a curated archive of AI-powered podcast summaries. New podcasts and episodes are added regularly. Each episode includes a concise summary and the full transcript. If there's a podcast you'd like to see here, <a href="/request">send a request</a>.</p>

<p>All summaries and transcripts are cached for 365 days, so episodes are always available for quick reference.</p>

<h2>Summary Templates</h2>
<p>Each episode is available in three different summary styles depending on the type of content:</p>
<ul>
    <li><strong>Key Takeaways &amp; Practical Steps</strong> — Craft and professional development podcasts. Includes an overview, key insights, actionable steps, and notable quotes.</li>
    <li><strong>Narrative Summary</strong> — Story-driven and interview podcasts. Captures the arc of the conversation with flowing narrative and main themes.</li>
    <li><strong>ELI5 (Explain Like I'm 5)</strong> — Technical and complex topics. Breaks down complex concepts using everyday analogies and simple language.</li>
</ul>

<h2 id="creator-opt-out">A Note for Podcast Creators</h2>
<p>Attribution matters. Every episode page prominently displays the podcast name, creator names, and both a &ldquo;Listen on Apple Podcasts&rdquo; link and a &ldquo;Website&rdquo; link to the official podcast website. My hope is that TL;DL helps expand a podcast's audience by making the content more accessible. Summaries should bring people <em>to</em> a podcast, not replace the experience of listening&mdash;most podcasts have transcripts available already, after all.</p>
<p>That said, if you'd prefer to opt out, please reach out at <a href="https://elezea.com/contact" target="_blank" rel="noopener noreferrer">elezea.com/contact</a> and I'll add your podcast to the blocklist.</p>

<h2 id="rss-feed">RSS Feeds</h2>
<p>Subscribe to new episode summaries via the <a href="/feed">global RSS feed</a>. The feed includes the latest 50 episodes with their summaries.</p>
<p>You can filter the global feed by topic using the <code>tag</code> parameter. For example:</p>
<ul>
    <li><a href="/feed?tag=technology">/feed?tag=technology</a> — Technology episodes only</li>
    <li><a href="/feed?tag=music">/feed?tag=music</a> — Music episodes only</li>
    <li><a href="/feed?tag=business">/feed?tag=business</a> — Business episodes only</li>
</ul>
<p>See the home page's &ldquo;Filter by topic&rdquo; dropdown for the full list of available tags.</p>
<p>Each podcast also has its own dedicated feed, scoped to that podcast's episodes only. Visit any <a href="/podcasts">podcast page</a> and append <code>/feed</code> to the URL:</p>
<ul>
    <li><code>/podcasts/1088864895/feed</code> — All summarized episodes from a specific podcast</li>
</ul>
<p>The podcast ID is visible in the URL when you browse to any podcast's page. RSS readers that support autodiscovery will detect the feed automatically.</p>

<h2>Technology</h2>
<p>TL;DL is built entirely on Cloudflare's edge platform:</p>
<ul>
    <li><a href="https://developers.cloudflare.com/workers/" target="_blank" rel="noopener noreferrer">Cloudflare Workers</a> — Serverless compute at the edge</li>
    <li><a href="https://developers.cloudflare.com/kv/" target="_blank" rel="noopener noreferrer">Workers KV</a> — Global key-value storage</li>
    <li><a href="https://developers.cloudflare.com/queues/" target="_blank" rel="noopener noreferrer">Cloudflare Queues</a> — Background job processing</li>
    <li><a href="https://developers.cloudflare.com/durable-objects/" target="_blank" rel="noopener noreferrer">Durable Objects</a> — Strongly consistent coordination</li>
    <li><a href="https://developers.cloudflare.com/cloudflare-one/applications/configure-apps/" target="_blank" rel="noopener noreferrer">Cloudflare Access</a> — Zero Trust authentication</li>
</ul>
<p>Transcription powered by <a href="https://openai.com/" target="_blank" rel="noopener noreferrer">OpenAI</a>'s gpt-transcribe model. Summarization and tagging by GPT-5.4.</p>

<h2>Credits</h2>
<p>TL;DL was created by <a href="https://elezea.com" target="_blank" rel="noopener noreferrer">Rian van der Merwe</a>.</p>
`;

    return c.html(renderStaticPage({
        activeNav: "about",
        sectionHeading: "About — The Ledger",
        sectionCount: "Colophon & Notes",
        bodyHtml,
        pageTitle: "About — TL;DL",
        totalInArchive: indexEntries.length,
    }));
});

// ============================================================================
// GET /request — Request a Podcast Form
// ============================================================================

publicRoutes.get("/request", async (c) => {
    const success = c.req.query("success") === "1";
    const error = c.req.query("error");
    const siteKey = c.env.TURNSTILE_SITE_KEY;

    const errorMessage = error === "captcha"
        ? "Verification failed. Please try again."
        : error === "missing-name"
            ? "Please enter the podcast name."
            : error === "send-failed"
                ? "Something went wrong sending your request. Please try again."
                : null;

    const indexEntries = await c.env.TLDL_DATA.get<EpisodeIndexEntry[]>("episodes:index", "json") ?? [];
    const turnstileScript = '<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>';

    if (success) {
        const bodyHtml = `
<div class="bs-form-banner ok">
<p>Thanks for the suggestion! I'll take a look and add it if it's a good fit. <a href="/">Back home</a>.</p>
</div>
`;
        return c.html(renderFormPage({
            activeNav: "index",
            sectionHeading: "Request Sent",
            sectionCount: "Thanks",
            bodyHtml,
            pageTitle: "Request Sent — TL;DL",
            canonicalUrl: `${BASE_URL}/request`,
            totalInArchive: indexEntries.length,
        }));
    }

    const errorBanner = errorMessage
        ? `<div class="bs-form-banner err"><p>${escapeHtml(errorMessage)}</p></div>`
        : "";

    const bodyHtml = `
<div class="bs-form-intro">
    <p>Know a podcast that should be on TL;DL? Let me know.</p>
</div>
${errorBanner}
<form method="POST" action="/request" class="bs-form">
    <div class="bs-form-field">
        <label for="podcastName">Podcast name</label>
        <input type="text" id="podcastName" name="podcastName"
            placeholder="e.g., The Ezra Klein Show" required />
    </div>
    <div class="bs-form-field">
        <label for="appleUrl">Apple Podcasts URL <span class="field-hint">optional</span></label>
        <input type="url" id="appleUrl" name="appleUrl"
            placeholder="https://podcasts.apple.com/us/podcast/..." />
    </div>
    <div class="bs-form-field">
        <label for="email">Your email <span class="field-hint">optional, in case I need to follow up</span></label>
        <input type="email" id="email" name="email"
            placeholder="you@example.com" autocomplete="email" />
    </div>
    <div class="bs-form-field">
        <label for="message">Message <span class="field-hint">optional</span></label>
        <textarea id="message" name="message" rows="3"
            placeholder="Any specific episodes you'd like to see?"></textarea>
    </div>
    <div class="cf-turnstile" data-sitekey="${escapeHtml(siteKey)}" data-theme="dark"></div>
    <div class="bs-form-actions">
        <button type="submit" class="bs-form-submit">Send Request &rarr;</button>
    </div>
</form>
`;

    return c.html(renderFormPage({
        activeNav: "index",
        sectionHeading: "Request a Podcast",
        sectionCount: "Suggest a show",
        bodyHtml,
        pageTitle: "Request a Podcast — TL;DL",
        canonicalUrl: `${BASE_URL}/request`,
        totalInArchive: indexEntries.length,
        headExtra: turnstileScript,
    }));
});

// ============================================================================
// POST /request — Handle Podcast Request Submission
// ============================================================================

publicRoutes.post("/request", async (c) => {
    const body = await c.req.parseBody();
    const podcastName = (body.podcastName as string || "").trim();
    const appleUrl = (body.appleUrl as string || "").trim();
    const email = (body.email as string || "").trim();
    const message = (body.message as string || "").trim();
    const token = body["cf-turnstile-response"] as string;

    // Validate Turnstile
    const turnstileValid = await verifyTurnstile(token, c.env.TURNSTILE_SECRET);
    if (!turnstileValid) {
        return c.redirect("/request?error=captcha");
    }

    // Validate required field
    if (!podcastName) {
        return c.redirect("/request?error=missing-name");
    }

    // Check if Postmark is configured
    if (!c.env.POSTMARK_API_KEY) {
        console.error(JSON.stringify({ event: "postmark_not_configured" }));
        return c.redirect("/request?error=send-failed");
    }

    // Build email body
    const textParts = [
        `Podcast: ${podcastName}`,
        appleUrl ? `Apple Podcasts URL: ${appleUrl}` : null,
        email ? `Requester email: ${email}` : null,
        message ? `\nMessage:\n${message}` : null,
    ].filter(Boolean).join("\n");

    const result = await sendEmail(c.env.POSTMARK_API_KEY, {
        from: c.env.POSTMARK_FROM_EMAIL,
        to: c.env.ADMIN_NOTIFICATION_EMAIL,
        subject: `TLDL Request: ${podcastName}`,
        textBody: textParts,
        messageStream: c.env.POSTMARK_MESSAGE_STREAM,
    });

    if (!result.success) {
        console.error(JSON.stringify({
            event: "request_email_failed",
            error: result.errorMessage,
        }));
        return c.redirect("/request?error=send-failed");
    }

    console.log(JSON.stringify({
        event: "podcast_request_submitted",
        podcastName,
        hasUrl: !!appleUrl,
        hasEmail: !!email,
        hasMessage: !!message,
    }));

    return c.redirect("/request?success=1");
});

// ============================================================================
// GET /feed — RSS Feed (with optional tag filter)
// ============================================================================

/**
 * Escape XML special characters for RSS content
 */
function escapeXml(text: string): string {
    return text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&apos;");
}

/**
 * Format date to RFC 822 format for RSS pubDate
 */
function toRfc822Date(isoDate: string): string {
    const date = new Date(isoDate);
    return date.toUTCString();
}

/**
 * Episode with summary for RSS feed
 */
interface EpisodeWithSummary extends EpisodeIndexEntry {
    summaryText?: string;
    deck?: string;
}

/**
 * Enrich episodes with their best available summary text.
 * Shared by /feed and /podcasts/:podcastId/feed handlers.
 */
async function enrichWithSummaries(
    kv: KVNamespace,
    episodes: EpisodeIndexEntry[],
    defaultTemplate: string
): Promise<EpisodeWithSummary[]> {
    return Promise.all(
        episodes.map(async (ep) => {
            // The deck lives only on the full Episode record, not the index
            // entry, so fetch it alongside the summary. Mirrors how the home
            // page hydrates decks per row (see GET / in this file).
            const [summaries, fullEpisode] = await Promise.all([
                listSummariesForEpisode(kv, ep.id),
                getEpisode(kv, ep.id),
            ]);
            const summary = summaries.find(s => s.templateId === defaultTemplate) || summaries[0];
            return {
                ...ep,
                summaryText: summary?.text,
                deck: fullEpisode?.deck,
            };
        })
    );
}

/**
 * Options for scoping an RSS feed to a specific podcast
 */
interface PodcastFeedFilter {
    podcastId: string;
    podcastName: string;
}

/**
 * Build RSS 2.0 feed XML with summaries.
 * Pass `podcastFilter` to scope the feed to a single podcast (used by /podcasts/:id/feed).
 * Pass `tagFilter` to scope the global feed to a topic tag (used by /feed?tag=).
 */
function buildRssFeed(
    episodes: EpisodeWithSummary[],
    tagFilter: string | undefined,
    baseUrl: string,
    podcastFilter?: PodcastFeedFilter
): string {
    let feedTitle: string;
    let feedDescription: string;
    let feedLink: string;
    let selfLink: string;

    if (podcastFilter) {
        feedTitle = `TL;DL - ${podcastFilter.podcastName}`;
        feedDescription = `AI-generated summaries for ${podcastFilter.podcastName}`;
        feedLink = `${baseUrl}/podcasts/${podcastFilter.podcastId}`;
        selfLink = `${baseUrl}/podcasts/${podcastFilter.podcastId}/feed`;
    } else if (tagFilter) {
        feedTitle = `TL;DL - ${tagFilter} episodes`;
        feedDescription = `AI-generated podcast summaries tagged with "${tagFilter}"`;
        feedLink = `${baseUrl}/?tag=${encodeURIComponent(tagFilter)}`;
        selfLink = `${baseUrl}/feed?tag=${encodeURIComponent(tagFilter)}`;
    } else {
        feedTitle = "TL;DL - Too Long Didn't Listen";
        feedDescription = "AI-generated podcast summaries from Apple Podcasts";
        feedLink = baseUrl;
        selfLink = `${baseUrl}/feed`;
    }

    const items = episodes.map((ep) => {
        const itemLink = `${baseUrl}/episode/${ep.id}`;
        const categories = ep.tags
            ? ep.tags.map((tag) => `        <category>${escapeXml(tag)}</category>`).join("\n")
            : "";
        
        // Build content with the deck (when present), podcast info header, and
        // summary (converted to HTML). The deck sits above the summary as a
        // standfirst, mirroring the web ordering.
        const podcastInfo = `${ep.podcastName} • ${formatDuration(ep.episodeDuration)}`;
        const deckHtml = ep.deck ? `<p>${escapeHtml(ep.deck)}</p>` : "";
        const summaryHtml = ep.summaryText
            ? `${deckHtml}<p><strong>${escapeHtml(podcastInfo)}</strong></p>${renderMarkdown(ep.summaryText)}`
            : `${deckHtml}<p>${escapeHtml(podcastInfo)}</p>`;

        // Use content:encoded for full content (prevents RSS readers from
        // fetching the page and showing the transcript instead of the summary).
        // description gets a plain-text blurb for readers that don't support
        // content:encoded — prefer the deck (already a clean 1-2 sentence
        // summary), falling back to a stripped summary excerpt for pre-deck
        // episodes.
        const plainExcerpt = ep.deck
            ? ep.deck
            : ep.summaryText
                ? ep.summaryText.replace(/[#*_`\[\]]/g, "").substring(0, 500)
                : podcastInfo;

        return `    <item>
      <title>${escapeXml(`${ep.podcastName} - ${ep.episodeTitle}`)}</title>
      <link>${itemLink}</link>
      <guid isPermaLink="true">${itemLink}</guid>
      <pubDate>${toRfc822Date(ep.createdAt)}</pubDate>
      <description>${escapeXml(plainExcerpt)}</description>
      <content:encoded><![CDATA[${summaryHtml}]]></content:encoded>
      <source url="${selfLink}">${escapeXml(ep.podcastName)}</source>
${categories}
    </item>`;
    }).join("\n");

    return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:content="http://purl.org/rss/1.0/modules/content/">
  <channel>
    <title>${escapeXml(feedTitle)}</title>
    <link>${feedLink}</link>
    <description>${escapeXml(feedDescription)}</description>
    <language>en-us</language>
    <lastBuildDate>${toRfc822Date(new Date().toISOString())}</lastBuildDate>
    <atom:link href="${selfLink}" rel="self" type="application/rss+xml"/>
${items}
  </channel>
</rss>`;
}

// ============================================================================
// GET /podcasts — Browse All Podcasts
// ============================================================================

publicRoutes.get("/podcasts", async (c) => {
    const allPodcasts = await getPodcastList(c.env.TLDL_DATA);
    const indexEntries = await c.env.TLDL_DATA.get<EpisodeIndexEntry[]>("episodes:index", "json") ?? [];

    const html = renderPodcastBrowsePage({
        podcasts: allPodcasts,
        totalInArchive: indexEntries.length,
    });
    return c.html(html);
});

// ============================================================================
// GET /podcasts/:podcastId/feed — Per-Podcast RSS Feed
// Must be registered before /podcasts/:podcastId so that Hono does not treat
// "feed" as a podcastId when matching the parameterised route.
// ============================================================================

publicRoutes.get("/podcasts/:podcastId/feed", async (c) => {
    const podcastId = c.req.param("podcastId");

    // Validate podcast ID format (numeric only)
    if (!/^\d+$/.test(podcastId)) {
        return c.text("Invalid podcast ID", 400);
    }

    // Fetch up to 50 episodes for this podcast (no pagination needed for feed)
    const { episodes } = await getEpisodesForPodcast(
        c.env.TLDL_DATA,
        podcastId,
        { page: 1, pageSize: 50 }
    );

    if (episodes.length === 0) {
        return c.text("Podcast not found", 404);
    }

    const podcastName = episodes[0].podcastName;

    const episodesWithSummaries = await enrichWithSummaries(c.env.TLDL_DATA, episodes, c.env.DEFAULT_TEMPLATE);

    const url = new URL(c.req.url);
    const baseUrl = `${url.protocol}//${url.host}`;

    const xml = buildRssFeed(episodesWithSummaries, undefined, baseUrl, {
        podcastId,
        podcastName,
    });

    return c.text(xml, {
        headers: {
            "Content-Type": "application/rss+xml; charset=utf-8",
            "Cache-Control": "public, max-age=3600",
        },
    });
});

// ============================================================================
// GET /podcasts/:podcastId — Individual Podcast Page
// ============================================================================

publicRoutes.get("/podcasts/:podcastId", async (c) => {
    const podcastId = c.req.param("podcastId");

    // Validate podcast ID format (numeric only)
    if (!/^\d+$/.test(podcastId)) {
        const content = `
            <div class="error-page">
                <h1>Podcast Not Found</h1>
                <p>This podcast doesn't exist or the ID is invalid.</p>
                <a href="/podcasts" class="button">Browse All Podcasts</a>
            </div>
        `;
        return c.html(Layout({ title: "Not Found", children: content }), 404);
    }

    const indexEntries = await c.env.TLDL_DATA.get<EpisodeIndexEntry[]>("episodes:index", "json") ?? [];
    const rowsRaw = indexEntries
        .filter(e => e.id.startsWith(`${podcastId}_`))
        .sort((a, b) => {
            if (a.episodeDate !== b.episodeDate) return b.episodeDate.localeCompare(a.episodeDate);
            return b.createdAt.localeCompare(a.createdAt);
        });

    if (rowsRaw.length === 0) {
        const content = `
            <div class="error-page">
                <h1>Podcast Not Found</h1>
                <p>No episodes have been summarized for this podcast yet.</p>
                <a href="/podcasts" class="button">Browse All Podcasts</a>
            </div>
        `;
        return c.html(Layout({ title: "Not Found", children: content }), 404);
    }

    const podcastName = rowsRaw[0]?.podcastName ?? "Unknown Podcast";

    const PAGE_SIZE = 20;
    const total = rowsRaw.length;
    const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    const currentPage = Math.max(1, Math.min(totalPages, parseInt(c.req.query("page") ?? "1", 10) || 1));
    const start = (currentPage - 1) * PAGE_SIZE;
    const rowsSliced = rowsRaw.slice(start, start + PAGE_SIZE);
    const hydrated = await Promise.all(rowsSliced.map(async r => {
        const ep = await c.env.TLDL_DATA.get<Episode>(`episode:${r.id}`, "json");
        return { ...r, deck: ep?.deck };
    }));

    const html = renderIndexPage({
        lead: null,
        rows: hydrated,
        totalInArchive: indexEntries.length,
        sectionHeading: `Podcast — ${podcastName}`,
        sectionCount: `${total} ${total === 1 ? "Entry" : "Entries"}`,
        activeNav: "podcasts",
        pageTitle: `${podcastName} — TL;DL`,
        rowStartNumber: start + 1,
        pagination: { currentPage, totalPages, basePath: `/podcasts/${podcastId}` },
    });
    return c.html(html);
});

// ============================================================================
// GET /tag — Browse all tags
// ============================================================================

publicRoutes.get("/tag", async (c) => {
    const index = await c.env.TLDL_DATA.get<EpisodeIndexEntry[]>("episodes:index", "json") ?? [];
    const counts = new Map<string, number>();
    for (const e of index) {
        for (const t of e.tags ?? []) {
            const key = t.toLowerCase();
            counts.set(key, (counts.get(key) ?? 0) + 1);
        }
    }
    const tags = [...counts.entries()]
        .filter(([, n]) => n > 0)
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));

    const html = renderTagBrowsePage({
        tags,
        totalInArchive: index.length,
    });
    return c.html(html);
});

// ============================================================================
// GET /tag/:tag — Episodes filtered by tag
// ============================================================================

publicRoutes.get("/tag/:tag", async (c) => {
    const tag = c.req.param("tag");
    const tagLower = tag.toLowerCase();

    const indexEntries = await c.env.TLDL_DATA.get<EpisodeIndexEntry[]>("episodes:index", "json") ?? [];
    const rowsRaw = indexEntries
        .filter(e => (e.tags ?? []).map(t => t.toLowerCase()).includes(tagLower))
        .sort((a, b) => {
            if (a.episodeDate !== b.episodeDate) return b.episodeDate.localeCompare(a.episodeDate);
            return b.createdAt.localeCompare(a.createdAt);
        });

    const PAGE_SIZE = 20;
    const total = rowsRaw.length;
    const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    const currentPage = Math.max(1, Math.min(totalPages, parseInt(c.req.query("page") ?? "1", 10) || 1));
    const start = (currentPage - 1) * PAGE_SIZE;
    const rowsSliced = rowsRaw.slice(start, start + PAGE_SIZE);
    const hydrated = await Promise.all(rowsSliced.map(async r => {
        const ep = await c.env.TLDL_DATA.get<Episode>(`episode:${r.id}`, "json");
        return { ...r, deck: ep?.deck };
    }));

    const html = renderIndexPage({
        lead: null,
        rows: hydrated,
        totalInArchive: indexEntries.length,
        sectionHeading: `Tag — ${tag}`,
        sectionCount: `${total} ${total === 1 ? "Entry" : "Entries"}`,
        activeNav: "tags",
        pageTitle: `#${tag} — TL;DL`,
        rowStartNumber: start + 1,
        pagination: { currentPage, totalPages, basePath: `/tag/${encodeURIComponent(tag)}` },
    });
    return c.html(html);
});

publicRoutes.get("/feed", async (c) => {
    const tagFilter = c.req.query("tag") || "";

    // Validate tag if provided
    if (tagFilter && !isValidTag(tagFilter)) {
        return c.text("Invalid tag", 400);
    }

    // Get episodes (up to 50 for the feed)
    const { episodes } = await listEpisodes(c.env.TLDL_DATA, {
        pageSize: 50,
        tag: tagFilter || undefined,
    });

    const episodesWithSummaries = await enrichWithSummaries(c.env.TLDL_DATA, episodes, c.env.DEFAULT_TEMPLATE);

    const url = new URL(c.req.url);
    const baseUrl = `${url.protocol}//${url.host}`;

    const xml = buildRssFeed(episodesWithSummaries, tagFilter || undefined, baseUrl);

    // Return with proper content type and caching (1 hour cache)
    return c.text(xml, {
        headers: {
            "Content-Type": "application/rss+xml; charset=utf-8",
            "Cache-Control": "public, max-age=3600",
        },
    });
});

// GET /widget/latest — JSON endpoint for embedding latest episode on external sites
publicRoutes.get("/widget/latest", async (c) => {
    const { episodes } = await listEpisodes(c.env.TLDL_DATA, { pageSize: 1 });

    if (episodes.length === 0) {
        return c.json({ error: "No episodes found" }, 404);
    }

    const latest = episodes[0];
    const url = new URL(c.req.url);
    const baseUrl = `${url.protocol}//${url.host}`;

    return c.json(
        {
            title: `${latest.podcastName} - ${latest.episodeTitle}`,
            podcastName: latest.podcastName,
            episodeTitle: latest.episodeTitle,
            link: `${baseUrl}/episode/${latest.id}`,
        },
        {
            headers: {
                "Access-Control-Allow-Origin": "https://elezea.com",
                "Cache-Control": "public, max-age=3600",
            },
        }
    );
});

export default publicRoutes;
