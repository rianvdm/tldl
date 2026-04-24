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
import { renderDetailPage, type TemplateId } from "../lib/broadsheet/detail-page";
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
function formatDuration(seconds: number): string {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);

    if (hours > 0) {
        return `${hours}h ${minutes}m`;
    }
    return `${minutes}m`;
}

/**
 * Format ISO date string to readable format
 */
function formatDate(dateString: string): string {
    const date = new Date(dateString);
    return new Intl.DateTimeFormat("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
    }).format(date);
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

    const ogImage = "https://file.elezea.com/tldl-hero.png";
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

    const leadEntry = selectLeadEpisode(sorted);
    const leadFull = leadEntry ? await c.env.TLDL_DATA.get<Episode>(`episode:${leadEntry.id}`, "json") : null;

    const rowsRaw = leadEntry ? sorted.filter(e => e.id !== leadEntry.id) : sorted;

    const MAX_ROWS = 50;
    const rowsSliced = rowsRaw.slice(0, MAX_ROWS);
    const hydrated = await Promise.all(rowsSliced.map(async r => {
        const ep = await c.env.TLDL_DATA.get<Episode>(`episode:${r.id}`, "json");
        return { ...r, deck: ep?.deck };
    }));

    const html = renderIndexPage({
        lead: leadFull,
        rows: hydrated,
        totalInArchive: indexEntries.length,
        sectionHeading: "The Index",
        sectionCount: `${hydrated.length} ${hydrated.length === 1 ? "Entry" : "Entries"} · Most Recent First`,
        activeNav: "index",
        pageTitle: "TL;DL — Too Long, Didn't Listen",
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
    if (!episode) return c.notFound();

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
    const summaryMarkdown = activeSummary?.text ?? "";
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
    const content = html`
        <style>
            .about-page p {
                margin-bottom: 1rem;
            }
            .about-page p:last-child {
                margin-bottom: 0;
            }
            .about-page a {
                color: var(--accent-red);
                text-decoration: underline;
                transition: opacity 0.2s ease;
            }
            .about-page a:hover {
                opacity: 0.8;
            }
            .about-page ul {
                margin: 0.5rem 0 1rem 1.5rem;
            }
            .about-page li {
                margin-bottom: 0.5rem;
            }
            
            /* Templates table - responsive design */
            .templates-table {
                width: 100%;
                border-collapse: collapse;
                margin-top: 1rem;
            }
            .templates-table th,
            .templates-table td {
                padding: 0.875rem 1rem;
                text-align: left;
                border-bottom: 1px solid var(--border);
            }
            .templates-table th {
                font-weight: 600;
                color: var(--muted-foreground);
                font-size: 0.875rem;
                text-transform: uppercase;
                letter-spacing: 0.03em;
            }
            .templates-table td {
                color: var(--foreground);
            }
            .templates-table td:first-child {
                white-space: nowrap;
            }
            .templates-table tbody tr:last-child td {
                border-bottom: none;
            }
            
            /* Mobile: stack rows as cards */
            @media (max-width: 640px) {
                .templates-table thead {
                    display: none;
                }
                .templates-table tbody tr {
                    display: block;
                    padding: 1rem 0;
                    border-bottom: 1px solid var(--border);
                }
                .templates-table tbody tr:last-child {
                    border-bottom: none;
                }
                .templates-table td {
                    display: block;
                    padding: 0.25rem 0;
                    border-bottom: none;
                }
                .templates-table td:first-child {
                    white-space: normal;
                    padding-bottom: 0.5rem;
                }
                .templates-table td:last-child {
                    color: var(--muted-foreground);
                    font-size: 0.9375rem;
                }
            }
        </style>
        <div class="card about-page">
            <h1>About TL;DL</h1>

            <section style="margin-top: 2rem;">
                <p>
                    TL;DL (Too Long; Didn't Listen) is a curated archive of AI-powered podcast summaries.
                    New podcasts and episodes are added regularly. Each episode includes a concise summary
                    and the full transcript. If there's a podcast you'd like to see here,
                    <a href="/request">send a request</a>.
                </p>
                <p>
                    All summaries and transcripts are cached for 365 days, so episodes are always
                    available for quick reference.
                </p>
            </section>

            <section style="margin-top: 2rem;">
                <h2>Summary Templates</h2>
                <p>Each episode is available in three different summary styles depending on the type of content:</p>

                <table class="templates-table">
                    <thead>
                        <tr>
                            <th>Template</th>
                            <th>Best For</th>
                        </tr>
                    </thead>
                    <tbody>
                        <tr>
                            <td data-label="Template"><strong>Key Takeaways & Practical Steps</strong></td>
                            <td data-label="Best For">Craft and professional development podcasts. Includes an overview, key insights, actionable steps, and notable quotes.</td>
                        </tr>
                        <tr>
                            <td data-label="Template"><strong>Narrative Summary</strong></td>
                            <td data-label="Best For">Story-driven and interview podcasts. Captures the arc of the conversation with flowing narrative and main themes.</td>
                        </tr>
                        <tr>
                            <td data-label="Template"><strong>ELI5 (Explain Like I'm 5)</strong></td>
                            <td data-label="Best For">Technical and complex topics. Breaks down complex concepts using everyday analogies and simple language.</td>
                        </tr>
                    </tbody>
                </table>
            </section>

            <section id="creator-opt-out" style="margin-top: 2rem;">
                <h2>A Note for Podcast Creators</h2>
                <p>
                    Attribution matters. Every episode page prominently displays the podcast name, creator names, and both a “Listen on Apple Podcasts” link and a “Website” link to the official podcast website. My hope is that TL;DL helps expand a podcast's audience by making the content more accessible. Summaries should bring people <em>to</em> a podcast, not replace the experience of listening—most podcasts have transcripts available already, after all.
                </p>
                <p>That said, if you'd prefer to opt out, please reach out at
                    <a href="https://elezea.com/contact" target="_blank" rel="noopener noreferrer">elezea.com/contact</a>
                    and I'll add your podcast to the blocklist.</p>
            </section>

            <section id="rss-feed" style="margin-top: 2rem;">
                <h2>RSS Feeds</h2>
                <p>
                    Subscribe to new episode summaries via the
                    <a href="/feed">global RSS feed</a>.
                    The feed includes the latest 50 episodes with their summaries.
                </p>
                <p>
                    You can filter the global feed by topic using the <code>tag</code> parameter. For example:
                </p>
                <ul>
                    <li><a href="/feed?tag=technology">/feed?tag=technology</a> — Technology episodes only</li>
                    <li><a href="/feed?tag=music">/feed?tag=music</a> — Music episodes only</li>
                    <li><a href="/feed?tag=business">/feed?tag=business</a> — Business episodes only</li>
                </ul>
                <p>
                    See the home page's "Filter by topic" dropdown for the full list of available tags.
                </p>
                <p>
                    Each podcast also has its own dedicated feed, scoped to that podcast's episodes only.
                    Visit any <a href="/podcasts">podcast page</a> and append <code>/feed</code> to the URL:
                </p>
                <ul>
                    <li><code>/podcasts/1088864895/feed</code> — All summarized episodes from a specific podcast</li>
                </ul>
                <p>
                    The podcast ID is visible in the URL when you browse to any podcast's page.
                    RSS readers that support autodiscovery will detect the feed automatically.
                </p>
            </section>

            <section style="margin-top: 2rem;">
                <h2>Technology</h2>
                <p>TL;DL is built entirely on Cloudflare's edge platform:</p>
                <ul>
                    <li>
                        <a href="https://developers.cloudflare.com/workers/" target="_blank" rel="noopener noreferrer">Cloudflare Workers</a>
                        — Serverless compute at the edge
                    </li>
                    <li>
                        <a href="https://developers.cloudflare.com/kv/" target="_blank" rel="noopener noreferrer">Workers KV</a>
                        — Global key-value storage
                    </li>
                    <li>
                        <a href="https://developers.cloudflare.com/queues/" target="_blank" rel="noopener noreferrer">Cloudflare Queues</a>
                        — Background job processing
                    </li>
                    <li>
                        <a href="https://developers.cloudflare.com/durable-objects/" target="_blank" rel="noopener noreferrer">Durable Objects</a>
                        — Strongly consistent coordination
                    </li>
                    <li>
                        <a href="https://developers.cloudflare.com/cloudflare-one/applications/configure-apps/" target="_blank" rel="noopener noreferrer">Cloudflare Access</a>
                        — Zero Trust authentication
                    </li>
                </ul>
                <p>
                    Transcription powered by
                    <a href="https://openai.com/" target="_blank" rel="noopener noreferrer">OpenAI</a>'s
                    gpt-4o-mini-transcribe model. Summarization and tagging by GPT-5.4.
                </p>
            </section>

            <section style="margin-top: 2rem;">
                <h2>Credits</h2>
                <p>
                    TL;DL was created by
                    <a href="https://elezea.com" target="_blank" rel="noopener noreferrer">Rian van der Merwe</a>.
                </p>
            </section>
        </div>
    `;
    return c.html(Layout({ title: "About", children: content.toString(), canonicalUrl: `${BASE_URL}/about` }));
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

    const content = success
        ? `
            <div class="page-header">
                <h1>Request Sent</h1>
            </div>
            <div class="card">
                <div class="alert alert-success" style="margin-bottom: 1rem;">
                    <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/>
                        <polyline points="22 4 12 14.01 9 11.01"/>
                    </svg>
                    <span>Thanks for the suggestion! I'll take a look and add it if it's a good fit.</span>
                </div>
                <a href="/" class="button button-primary">Back to Home</a>
            </div>
        `
        : `
            <div class="page-header">
                <h1>Request a Podcast</h1>
                <p class="page-subtitle">Know a podcast that should be on TL;DL? Let me know.</p>
            </div>

            ${errorMessage ? `
                <div class="alert alert-error" style="margin-bottom: 1.5rem;">
                    <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <circle cx="12" cy="12" r="10"/>
                        <line x1="12" y1="8" x2="12" y2="12"/>
                        <line x1="12" y1="16" x2="12.01" y2="16"/>
                    </svg>
                    <span>${escapeHtml(errorMessage)}</span>
                </div>
            ` : ""}

            <div class="card">
                <form method="POST" action="/request" class="form">
                    <div class="form-group">
                        <label for="podcastName" class="form-label">Podcast name</label>
                        <input type="text" id="podcastName" name="podcastName" class="form-input"
                            placeholder="e.g., The Ezra Klein Show" required />
                    </div>

                    <div class="form-group">
                        <label for="appleUrl" class="form-label">Apple Podcasts URL <span class="text-muted">(optional)</span></label>
                        <input type="url" id="appleUrl" name="appleUrl" class="form-input"
                            placeholder="https://podcasts.apple.com/us/podcast/..." />
                    </div>

                    <div class="form-group">
                        <label for="email" class="form-label">Your email <span class="text-muted">(optional, in case I need to follow up)</span></label>
                        <input type="email" id="email" name="email" class="form-input"
                            placeholder="you@example.com" autocomplete="email" />
                    </div>

                    <div class="form-group">
                        <label for="message" class="form-label">Message <span class="text-muted">(optional)</span></label>
                        <textarea id="message" name="message" class="form-input" rows="3"
                            placeholder="Any specific episodes you'd like to see?"></textarea>
                    </div>

                    <div class="cf-turnstile" data-sitekey="${escapeHtml(siteKey)}" data-theme="dark"></div>

                    <div class="form-actions" style="margin-top: 1rem;">
                        <button type="submit" class="button button-primary">Send Request</button>
                    </div>
                </form>
            </div>
        `;

    const turnstileScript = success
        ? ""
        : '<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>';

    return c.html(Layout({
        title: success ? "Request Sent" : "Request a Podcast",
        children: content,
        headExtra: turnstileScript,
        canonicalUrl: `${BASE_URL}/request`,
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
            const summaries = await listSummariesForEpisode(kv, ep.id);
            const summary = summaries.find(s => s.templateId === defaultTemplate) || summaries[0];
            return {
                ...ep,
                summaryText: summary?.text,
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
        
        // Build content with podcast info header and summary (converted to HTML)
        const podcastInfo = `${ep.podcastName} • ${formatDuration(ep.episodeDuration)}`;
        const summaryHtml = ep.summaryText
            ? `<p><strong>${escapeHtml(podcastInfo)}</strong></p>${renderMarkdown(ep.summaryText)}`
            : `<p>${escapeHtml(podcastInfo)}</p>`;

        // Use content:encoded for full content (prevents RSS readers from
        // fetching the page and showing the transcript instead of the summary).
        // description gets a plain-text excerpt for readers that don't support content:encoded.
        const plainExcerpt = ep.summaryText
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
    const pageParam = c.req.query("page");
    const page = Math.max(1, parseInt(pageParam || "1", 10) || 1);
    const pageSize = 10;
    const search = c.req.query("q") || "";

    const allPodcasts = await getPodcastList(c.env.TLDL_DATA);

    // Filter by search query (case-insensitive match on podcast name)
    const filteredPodcasts = search
        ? allPodcasts.filter(p => p.name.toLowerCase().includes(search.toLowerCase()))
        : allPodcasts;

    if (allPodcasts.length === 0) {
        const content = `
            <div class="page-header">
                <h1>Browse Podcasts</h1>
                <p class="page-subtitle">All podcasts with AI summaries</p>
            </div>
            <div class="empty-state">
                <p>No podcasts yet. Check back soon!</p>
            </div>
        `;
        return c.html(Layout({ title: "Browse Podcasts", children: content }));
    }

    // Paginate filtered podcasts
    const total = filteredPodcasts.length;
    const totalPages = Math.ceil(total / pageSize);
    const start = (page - 1) * pageSize;
    const podcasts = filteredPodcasts.slice(start, start + pageSize);

    // Redirect if page is out of bounds
    if (podcasts.length === 0 && page > 1) {
        return c.redirect(`/podcasts${search ? `?q=${encodeURIComponent(search)}` : ''}`);
    }

    const podcastCards = podcasts.map(podcast => `
        <div class="podcast-card" onclick="window.location.href='/podcasts/${escapeHtml(podcast.id)}'" style="cursor: pointer;">
            <div class="podcast-card-content">
                <div class="podcast-card-icon">
                    <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/>
                        <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
                        <line x1="12" x2="12" y1="19" y2="22"/>
                    </svg>
                </div>
                <div class="podcast-card-info">
                    <h3 class="podcast-card-name">${escapeHtml(podcast.name)}</h3>
                    ${podcast.author ? `<div class="podcast-card-author">by ${escapeHtml(podcast.author)}</div>` : ''}
                    <div class="podcast-card-meta">
                        <span>${podcast.episodeCount} episode${podcast.episodeCount !== 1 ? 's' : ''}</span>
                        <span class="meta-dot">•</span>
                        <span>Updated ${formatDate(podcast.latestEpisodeDate)}</span>
                    </div>
                </div>
            </div>
            <div class="podcast-card-arrow">
                <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>
                </svg>
            </div>
        </div>
    `).join("");

    // Build pagination with search query preserved
    const paginationHtml = totalPages > 1 ? `
        <nav class="pagination" aria-label="Podcast pagination">
            ${page > 1 ? `
            <a href="/podcasts?page=${page - 1}${search ? `&q=${encodeURIComponent(search)}` : ''}" class="pagination-link pagination-prev">
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="m15 18-6-6 6-6"/>
                </svg>
                Previous
            </a>
            ` : `<span class="pagination-link pagination-prev pagination-disabled">
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="m15 18-6-6 6-6"/>
                </svg>
                Previous
            </span>`}
            <span class="pagination-info">Page ${page} of ${totalPages}</span>
            ${page < totalPages ? `
            <a href="/podcasts?page=${page + 1}${search ? `&q=${encodeURIComponent(search)}` : ''}" class="pagination-link pagination-next">
                Next
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="m9 18 6-6-6-6"/>
                </svg>
            </a>
            ` : `<span class="pagination-link pagination-next pagination-disabled">
                Next
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="m9 18 6-6-6-6"/>
                </svg>
            </span>`}
        </nav>
    ` : "";

    // Search form (reuses home page styling)
    const searchForm = `
        <form method="GET" action="/podcasts" class="search-form">
            <div class="search-input-wrapper">
                <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="search-icon">
                    <circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>
                </svg>
                <input type="text" name="q" value="${escapeHtml(search)}" placeholder="Search podcasts..." class="search-input" id="search-input">
                ${search ? `<a href="/podcasts" class="search-clear" title="Clear search">×</a>` : ""}
            </div>
            <button type="submit" class="button">Search</button>
        </form>
    `;

    // Empty state for no search results
    const noResultsHtml = search && filteredPodcasts.length === 0 ? `
        <div class="empty-state">
            <p>No podcasts found matching "${escapeHtml(search)}"</p>
            <a href="/podcasts" class="button">Clear Search</a>
        </div>
    ` : "";

    const content = `
        <div class="page-header">
            <h1>Browse Podcasts</h1>
            <p class="page-subtitle">${allPodcasts.length} podcast${allPodcasts.length !== 1 ? 's' : ''} with AI summaries</p>
        </div>
        ${searchForm}
        ${noResultsHtml}
        ${filteredPodcasts.length > 0 ? `
        <div class="podcast-list">
            ${podcastCards}
        </div>
        ${paginationHtml}
        ` : ""}
    `;

    return c.html(Layout({ title: "Browse Podcasts", children: content, canonicalUrl: `${BASE_URL}/podcasts` }));
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

    const rowsSliced = rowsRaw.slice(0, 100);
    const hydrated = await Promise.all(rowsSliced.map(async r => {
        const ep = await c.env.TLDL_DATA.get<Episode>(`episode:${r.id}`, "json");
        return { ...r, deck: ep?.deck };
    }));

    const html = renderIndexPage({
        lead: null,
        rows: hydrated,
        totalInArchive: indexEntries.length,
        sectionHeading: `Podcast — ${podcastName}`,
        sectionCount: `${hydrated.length} ${hydrated.length === 1 ? "Entry" : "Entries"}`,
        activeNav: "index",
        pageTitle: `${podcastName} — TL;DL`,
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
