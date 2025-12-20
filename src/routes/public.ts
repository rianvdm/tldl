/**
 * Public Routes
 * Server-rendered HTML pages accessible without authentication
 */

import { Hono } from "hono";
import { html, raw } from "hono/html";
import type { HonoEnv, Episode } from "../types";
import {
    listEpisodes,
    getEpisode,
    getTranscript,
    listSummariesForEpisode,
} from "../lib/kv";
import { getTemplate } from "../lib/constants";

const publicRoutes = new Hono<HonoEnv>();

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

/**
 * Calculate days remaining until expiration
 */
function calculateDaysRemaining(expiresAt: string): number {
    const now = new Date();
    const expires = new Date(expiresAt);
    const diffTime = expires.getTime() - now.getTime();
    const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
    return Math.max(0, diffDays);
}

/**
 * Escape HTML to prevent XSS
 */
function escapeHtml(text: string): string {
    return text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

/**
 * Simple markdown to HTML converter
 * Handles: headers, bold, italic, lists, code blocks, paragraphs, blockquotes
 */
function renderMarkdown(md: string): string {
    if (!md) return "";

    let html = escapeHtml(md);

    // Headers (h1-h4)
    html = html.replace(/^#### (.+)$/gm, "<h4>$1</h4>");
    html = html.replace(/^### (.+)$/gm, "<h3>$1</h3>");
    html = html.replace(/^## (.+)$/gm, "<h2>$1</h2>");
    html = html.replace(/^# (.+)$/gm, "<h1>$1</h1>");

    // Bold and italic
    html = html.replace(/\*\*\*(.+?)\*\*\*/g, "<strong><em>$1</em></strong>");
    html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
    html = html.replace(/\*(.+?)\*/g, "<em>$1</em>");

    // Code blocks
    html = html.replace(/```[\s\S]*?```/g, (match) => {
        const code = match.slice(3, -3).trim();
        return `<pre><code>${code}</code></pre>`;
    });

    // Inline code
    html = html.replace(/`(.+?)`/g, "<code>$1</code>");

    // Blockquotes
    html = html.replace(/^&gt; (.+)$/gm, "<blockquote>$1</blockquote>");

    // Unordered lists
    html = html.replace(/^- (.+)$/gm, "<li>$1</li>");
    html = html.replace(/(<li>.*<\/li>\n?)+/g, "<ul>$&</ul>");

    // Numbered lists
    html = html.replace(/^\d+\. (.+)$/gm, "<li>$1</li>");

    // Paragraphs - wrap text blocks that aren't already wrapped
    const lines = html.split("\n\n");
    html = lines
        .map((line) => {
            const trimmed = line.trim();
            if (!trimmed) return "";
            if (
                trimmed.startsWith("<h") ||
                trimmed.startsWith("<ul") ||
                trimmed.startsWith("<ol") ||
                trimmed.startsWith("<pre") ||
                trimmed.startsWith("<blockquote")
            ) {
                return trimmed;
            }
            return `<p>${trimmed}</p>`;
        })
        .join("\n");

    // Clean up extra line breaks
    html = html.replace(/\n/g, " ").replace(/\s+/g, " ");

    return html;
}

// ============================================================================
// Layout Component
// ============================================================================

function Layout(props: { title: string; children: string }) {
    return html`<!DOCTYPE html>
        <html lang="en" class="dark">
            <head>
                <meta charset="UTF-8" />
                <meta
                    name="viewport"
                    content="width=device-width, initial-scale=1.0"
                />
                <title>${props.title} - TLDL</title>
                <meta
                    name="description"
                    content="AI-powered podcast summaries from Apple Podcasts URLs"
                />
                <link rel="stylesheet" href="/styles.css" />
            </head>
            <body>
                <div class="container">
                    <nav class="nav">
                        <a href="/" class="nav-brand">TLDL</a>
                        <span class="nav-tagline"
                            >Too Long Didn't Listen</span
                        >
                    </nav>
                    <main class="main">${raw(props.children)}</main>
                    <footer class="footer">
                        <p>AI-powered podcast summaries</p>
                    </footer>
                </div>
            </body>
        </html>`;
}

// ============================================================================
// Episode Card Component
// ============================================================================

function EpisodeCard(
    episode: Episode,
    summaryTemplates: string[]
): string {
    const templateBadges = summaryTemplates
        .map((templateId) => {
            const template = getTemplate(templateId);
            const name = template?.name || templateId;
            return `<span class="badge">${escapeHtml(name)}</span>`;
        })
        .join("");

    return `
        <a href="/episode/${escapeHtml(episode.id)}" class="episode-card">
            <div class="episode-card-content">
                <div class="episode-podcast">${escapeHtml(episode.podcastName)}</div>
                <h3 class="episode-title">${escapeHtml(episode.episodeTitle)}</h3>
                <div class="episode-meta">
                    <span>${formatDate(episode.episodeDate)}</span>
                    <span class="meta-dot">•</span>
                    <span>${formatDuration(episode.episodeDuration)}</span>
                </div>
                ${templateBadges ? `<div class="episode-badges">${templateBadges}</div>` : ""}
            </div>
            <div class="episode-card-arrow">
                <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>
                </svg>
            </div>
        </a>
    `;
}

// ============================================================================
// GET / — Episode List (Home Page)
// ============================================================================

publicRoutes.get("/", async (c) => {
    const episodes = await listEpisodes(c.env.TLDL_DATA);

    // Get summary templates for each episode
    const episodeCards = await Promise.all(
        episodes.map(async (episode) => {
            const summaries = await listSummariesForEpisode(
                c.env.TLDL_DATA,
                episode.id
            );
            const templateIds = summaries.map((s) => s.templateId);
            return EpisodeCard(episode, templateIds);
        })
    );

    const content =
        episodes.length > 0
            ? `
        <div class="page-header">
            <h1>Recent Episodes</h1>
            <p class="page-subtitle">Browse AI-generated summaries from podcast episodes</p>
        </div>
        <div class="episode-list">
            ${episodeCards.join("")}
        </div>
    `
            : `
        <div class="page-header">
            <h1>Welcome to TLDL</h1>
            <p class="page-subtitle">AI-powered podcast summaries from Apple Podcasts URLs</p>
        </div>
        <div class="empty-state">
            <div class="empty-state-icon">
                <svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                    <circle cx="12" cy="12" r="10"/><path d="M8 12h8"/><path d="M12 8v8"/>
                </svg>
            </div>
            <p>No episodes yet.</p>
            <p class="text-muted">Submit your first podcast episode to get started!</p>
        </div>
    `;

    return c.html(Layout({ title: "Home", children: content }));
});

// ============================================================================
// GET /episode/:episodeId — Episode Detail Page
// ============================================================================

publicRoutes.get("/episode/:episodeId", async (c) => {
    const episodeId = c.req.param("episodeId");
    const selectedTemplate = c.req.query("template");

    // Fetch episode
    const episode = await getEpisode(c.env.TLDL_DATA, episodeId);
    if (!episode) {
        const content = `
            <div class="error-page">
                <h1>Episode Not Found</h1>
                <p>This episode doesn't exist or has expired.</p>
                <a href="/" class="button">Back to Home</a>
            </div>
        `;
        return c.html(Layout({ title: "Not Found", children: content }), 404);
    }

    // Fetch transcript and summaries
    const [transcript, summaries] = await Promise.all([
        getTranscript(c.env.TLDL_DATA, episodeId),
        listSummariesForEpisode(c.env.TLDL_DATA, episodeId),
    ]);

    // Determine which summary to show
    const activeTemplateId =
        selectedTemplate ||
        (summaries.length > 0 ? summaries[0].templateId : null);
    const activeSummary = activeTemplateId
        ? summaries.find((s) => s.templateId === activeTemplateId)
        : null;

    const daysRemaining = calculateDaysRemaining(episode.expiresAt);

    // Build summary tabs
    const summaryTabs = summaries
        .map((summary) => {
            const template = getTemplate(summary.templateId);
            const isActive = summary.templateId === activeTemplateId;
            return `
                <a href="/episode/${escapeHtml(episodeId)}?template=${escapeHtml(summary.templateId)}"
                   class="tab ${isActive ? "tab-active" : ""}">
                    ${escapeHtml(template?.name || summary.templateId)}
                </a>
            `;
        })
        .join("");

    // Build summary content
    const summaryContent = activeSummary
        ? `
        <div class="summary-header">
            <div class="summary-model">Generated with ${escapeHtml(activeSummary.model)}</div>
        </div>
        <div class="prose">
            ${renderMarkdown(activeSummary.text)}
        </div>
    `
        : `
        <div class="empty-state">
            <p>No summary available for this episode.</p>
        </div>
    `;

    // Build transcript content with collapse/expand
    // Collapse if transcript is longer than ~20 lines worth of characters
    const needsCollapse = transcript ? transcript.text.length > 2000 : false;

    const transcriptContent = transcript
        ? `
        <div class="transcript-source">
            <span class="source-indicator"></span>
            ${escapeHtml(transcript.source)} transcript
        </div>
        <div class="transcript-container${needsCollapse ? ' collapsed' : ''}" id="transcript-container">
            <div class="transcript-text" id="transcript-text">
                ${escapeHtml(transcript.text)}
            </div>
            ${needsCollapse ? '<div class="transcript-fade"></div>' : ''}
        </div>
        ${needsCollapse ? `
        <button class="transcript-toggle" id="transcript-toggle" onclick="toggleTranscript()">
            <span id="toggle-text">Show full transcript</span>
            <svg id="toggle-icon" xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="m6 9 6 6 6-6"/>
            </svg>
        </button>
        <script>
            function toggleTranscript() {
                const container = document.getElementById('transcript-container');
                const toggleText = document.getElementById('toggle-text');
                const toggleIcon = document.getElementById('toggle-icon');
                const isCollapsed = container.classList.contains('collapsed');

                if (isCollapsed) {
                    container.classList.remove('collapsed');
                    toggleText.textContent = 'Show less';
                    toggleIcon.style.transform = 'rotate(180deg)';
                } else {
                    container.classList.add('collapsed');
                    toggleText.textContent = 'Show full transcript';
                    toggleIcon.style.transform = 'rotate(0deg)';
                }
            }
        </script>
        ` : ''}
    `
        : `
        <div class="empty-state">
            <p>No transcript available for this episode.</p>
        </div>
    `;

    const content = `
        <div class="breadcrumb">
            <a href="/" class="breadcrumb-link">Episodes</a>
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="m9 18 6-6-6-6"/>
            </svg>
            <span>${escapeHtml(episode.podcastName)}</span>
        </div>

        <div class="episode-header">
            <div class="episode-podcast">${escapeHtml(episode.podcastName)}</div>
            <h1 class="episode-detail-title">${escapeHtml(episode.episodeTitle)}</h1>
            <div class="episode-meta">
                <span>${formatDate(episode.episodeDate)}</span>
                <span class="meta-dot">•</span>
                <span>${formatDuration(episode.episodeDuration)}</span>
                <span class="meta-dot">•</span>
                <span class="expiry">
                    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
                    </svg>
                    Expires in ${daysRemaining} days
                </span>
            </div>
        </div>

        <div class="actions">
            <a href="/episode/${escapeHtml(episodeId)}/pdf" class="button button-primary">
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
                </svg>
                Download PDF
            </a>
        </div>

        <div class="divider"></div>

        <section class="section">
            <h2>Summary</h2>
            ${summaries.length > 1 ? `<div class="tabs">${summaryTabs}</div>` : ""}
            <div class="card">
                ${summaryContent}
            </div>
        </section>

        <div class="divider"></div>

        <section class="section">
            <h2>Full Transcript</h2>
            <div class="card">
                ${transcriptContent}
            </div>
        </section>
    `;

    return c.html(
        Layout({ title: episode.episodeTitle, children: content })
    );
});

// ============================================================================
// GET /episode/:episodeId/pdf — PDF Download (placeholder until Prompt 12)
// ============================================================================

publicRoutes.get("/episode/:episodeId/pdf", async (c) => {
    const episodeId = c.req.param("episodeId");

    // Verify episode exists
    const episode = await getEpisode(c.env.TLDL_DATA, episodeId);
    if (!episode) {
        return c.json({ error: "Episode not found" }, 404);
    }

    // For now, return a placeholder response
    // PDF generation will be implemented in Prompt 12
    return c.json(
        {
            message: "PDF generation not yet implemented",
            episodeId,
            episodeTitle: episode.episodeTitle,
        },
        501
    );
});

export default publicRoutes;
