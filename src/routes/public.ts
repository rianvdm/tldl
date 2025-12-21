/**
 * Public Routes
 * Server-rendered HTML pages accessible without authentication
 */

import { Hono } from "hono";
import { html, raw } from "hono/html";
import type { HonoEnv, EpisodeIndexEntry, Job, JobStatus } from "../types";
import {
    listEpisodes,
    getEpisode,
    getTranscript,
    listSummariesForEpisode,
    createJob,
    updateJobStatus,
} from "../lib/kv";
import {
    createJobDO,
    getJobWithFallback,
    updateJobStatusDO,
    listActiveJobsWithDO,
    deleteJobDO,
} from "../lib/job-status-do";
import { getTemplate, TEMPLATES, isValidTemplateId, TIMEOUTS, getValidTags, isValidTag } from "../lib/constants";
import { parseApplePodcastsUrl, deriveEpisodeId } from "../lib/url-parser";
import { enqueueJob, createProcessEpisodeMessage } from "../lib/queue";

import { generateEpisodePdf } from "../services/pdf";
import { getUserEmailFromJwt, escapeHtml } from "../lib/auth";

const publicRoutes = new Hono<HonoEnv>();

// ============================================================================
// JWT Email Extraction
// ============================================================================

/**
 * Extract user email from request (if Cloudflare Access JWT is present)
 */
function getUserEmail(c: import("hono").Context<HonoEnv>): string | undefined {
    const cfAccessJwt = c.req.header("Cf-Access-Jwt-Assertion");
    if (cfAccessJwt) {
        const email = getUserEmailFromJwt(cfAccessJwt);
        if (email) return email;
    }
    return undefined;
}

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

// escapeHtml imported from ../lib/auth

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
    // Split on single newlines to handle both single and double newline paragraph breaks
    const lines = html.split("\n");
    html = lines
        .map((line) => {
            const trimmed = line.trim();
            if (!trimmed) return "";
            if (
                trimmed.startsWith("<h") ||
                trimmed.startsWith("<ul") ||
                trimmed.startsWith("<ol") ||
                trimmed.startsWith("<pre") ||
                trimmed.startsWith("<blockquote") ||
                trimmed.startsWith("<li")
            ) {
                return trimmed;
            }
            return `<p>${trimmed}</p>`;
        })
        .join("\n");

    // Clean up excessive whitespace between tags only (don't collapse content)
    html = html.replace(/>\s+</g, "><").trim();

    return html;
}

// ============================================================================
// Layout Component
// ============================================================================

export function Layout(props: { title: string; children: string; headExtra?: string }) {
    // Use custom title for home page
    const pageTitle = props.title === "Home"
        ? "TL;DL - Too Long Didn't Listen"
        : `${props.title} - TL;DL`;

    const ogImage = "https://file.elezea.com/tldl-hero.png";

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
                    content="AI-powered podcast summaries from Apple Podcasts URLs"
                />
                <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
                <meta property="og:title" content="${pageTitle}" />
                <meta property="og:description" content="Get AI summaries of podcast episodes" />
                <meta property="og:type" content="website" />
                <meta property="og:image" content="${ogImage}" />
                <meta name="twitter:card" content="summary_large_image" />
                <meta name="twitter:title" content="${pageTitle}" />
                <meta name="twitter:description" content="Get AI summaries of podcast episodes" />
                <meta name="twitter:image" content="${ogImage}" />
                <link rel="stylesheet" href="/styles.css" />
                ${raw(props.headExtra || "")}
            </head>
            <body>
                <div class="container">
                    <nav class="nav">
                        <a href="/" class="nav-brand">TL;D<span class="text-accent">L</span></a>
                        <span class="nav-tagline"
                            >Too Long Didn't Listen</span
                        >
                        <a href="/about" class="nav-link">About</a>
                        <a href="/profile" class="nav-link">Profile</a>
                    </nav>
                    <main class="main">${raw(props.children)}</main>
                    <footer class="footer">
                        <p>TL;DL uses AI to generate summaries from podcast transcripts.</p>
                    </footer>
                </div>
            </body>
        </html>`;
}

// ============================================================================
// Episode Card Component
// ============================================================================

function EpisodeCard(
    episode: EpisodeIndexEntry,
    summaryTemplates: string[],
    currentTag?: string
): string {
    const templateBadges = summaryTemplates
        .map((templateId) => {
            const template = getTemplate(templateId);
            const name = template?.name || templateId;
            return `<span class="badge">${escapeHtml(name)}</span>`;
        })
        .join("");

    // Render tag badges (sorted alphabetically)
    const tagBadges = episode.tags && episode.tags.length > 0
        ? [...episode.tags].sort()
            .map((tag) => {
                const isSelected = currentTag === tag;
                const badgeClass = isSelected ? "tag-badge tag-badge-selected" : "tag-badge";
                // stopPropagation prevents card click when clicking tag
                return `<a href="/?tag=${encodeURIComponent(tag)}" class="${badgeClass}" onclick="event.stopPropagation()">${escapeHtml(tag)}</a>`;
            })
            .join("")
        : "";

    return `
        <div class="episode-card" onclick="window.location.href='/episode/${escapeHtml(episode.id)}'" style="cursor: pointer;">
            <div class="episode-card-content">
                <div class="episode-podcast">${escapeHtml(episode.podcastName)}</div>
                <h3 class="episode-title">${escapeHtml(episode.episodeTitle)}</h3>
                <div class="episode-meta">
                    <span>${formatDate(episode.episodeDate)}</span>
                    <span class="meta-dot">•</span>
                    <span>${formatDuration(episode.episodeDuration)}</span>
                </div>
                ${tagBadges || templateBadges ? `<div class="episode-badges">${tagBadges}${tagBadges && templateBadges ? '<span class="meta-dot" style="margin: 0 0.25rem;">•</span>' : ''}${templateBadges}</div>` : ""}
            </div>
            <div class="episode-card-arrow">
                <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>
                </svg>
            </div>
        </div>
    `;
}

// ============================================================================
// In Progress Card Component
// ============================================================================

const STATUS_LABELS_SHORT: Record<JobStatus, string> = {
    queued: "Waiting to start...",
    fetching_metadata: "Fetching metadata...",
    checking_transcript: "Checking transcript...",
    transcribing: "Transcribing audio...",
    summarizing: "Generating summary...",
    completed: "Completed",
    failed: "Failed",
};

function InProgressCard(job: Job): string {
    const statusLabel = STATUS_LABELS_SHORT[job.status] || job.status;
    const template = getTemplate(job.templateId);
    const templateName = template?.name || job.templateId;
    const isFailed = job.status === "failed";

    // Show metadata if available, otherwise show status
    const podcastDisplay = job.podcastName || (isFailed ? "Failed" : "Processing");
    const titleDisplay = job.episodeTitle || statusLabel;

    // Build metadata line
    const metaParts = [formatDate(job.createdAt), escapeHtml(templateName)];
    // If we have episode title, also show status
    if (job.episodeTitle) {
        metaParts.push(escapeHtml(statusLabel));
    }

    // For failed jobs, show error icon; for in-progress, show spinner
    const iconHtml = isFailed
        ? `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
            </svg>`
        : `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="spinner">
                <path d="M21 12a9 9 0 1 1-6.219-8.56"/>
            </svg>`;

    const cardClass = isFailed ? "episode-card episode-card-failed" : "episode-card episode-card-progress";
    const indicatorClass = isFailed ? "status-indicator status-indicator-failed" : "status-indicator status-indicator-active";

    return `
        <a href="/job/${escapeHtml(job.id)}" class="${cardClass}">
            <div class="episode-card-content">
                <div class="episode-podcast">
                    <span class="${indicatorClass}"></span>
                    ${escapeHtml(podcastDisplay)}
                </div>
                <h3 class="episode-title">${escapeHtml(titleDisplay)}</h3>
                <div class="episode-meta">
                    ${metaParts.map((part, i) =>
                        i > 0 ? `<span class="meta-dot">•</span><span>${part}</span>` : `<span>${part}</span>`
                    ).join('')}
                </div>
            </div>
            <div class="episode-card-arrow">
                ${iconHtml}
            </div>
        </a>
    `;
}

// ============================================================================
// GET / — Episode List (Home Page)
// ============================================================================

publicRoutes.get("/", async (c) => {
    // Parse query params
    const pageParam = c.req.query("page");
    const page = Math.max(1, parseInt(pageParam || "1", 10) || 1);
    const pageSize = 10;
    const search = c.req.query("q") || "";
    const tagFilter = c.req.query("tag") || "";

    // Validate tag if provided
    const isValidTagFilter = tagFilter ? isValidTag(tagFilter) : true;
    if (tagFilter && !isValidTagFilter) {
        // Invalid tag - redirect to home without tag filter
        return c.redirect("/");
    }

    // Fetch both active jobs and completed episodes
    // Use DO for active jobs (strong consistency) to show real-time status
    const [activeJobs, paginatedEpisodes] = await Promise.all([
        listActiveJobsWithDO(c.env, c.env.TLDL_DATA),
        listEpisodes(c.env.TLDL_DATA, {
            page,
            pageSize,
            search: search || undefined,
            tag: tagFilter || undefined,
        }),
    ]);

    const { episodes, totalPages } = paginatedEpisodes;

    // Build in-progress cards
    const inProgressCards = activeJobs.map((job) => InProgressCard(job)).join("");

    // Get summary templates for each episode
    const episodeCards = await Promise.all(
        episodes.map(async (episode) => {
            const summaries = await listSummariesForEpisode(
                c.env.TLDL_DATA,
                episode.id
            );
            const templateIds = summaries.map((s) => s.templateId);
            return EpisodeCard(episode, templateIds, tagFilter || undefined);
        })
    );

    // Build in-progress section if there are active jobs
    const inProgressSection = activeJobs.length > 0 ? `
        <div class="section-header">
            <h2>In Progress</h2>
        </div>
        <div class="episode-list">
            ${inProgressCards}
        </div>
        <div class="divider"></div>
    ` : "";

    // Intro text for the home page
    const introSection = `
        <div class="intro-section">
            <p><span class="text-accent">Get the key insights from your favorite podcasts.</span> Paste an Apple Podcasts link and choose how you want it summarized—key takeaways, narrative overview, or simplified explainer. Submissions are invite-only for now—browse existing summaries below.</p>
        </div>
    `;

    const content =
        episodes.length > 0 || activeJobs.length > 0 || search
            ? `
        ${introSection}
        <div class="page-header-with-action">
            <div class="page-header">
                <h1>Recent Episodes</h1>
                <p class="page-subtitle">Browse AI-generated summaries from podcast episodes</p>
            </div>
            <a href="/submit" class="button button-primary">
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <circle cx="12" cy="12" r="10"/><path d="M8 12h8"/><path d="M12 8v8"/>
                </svg>
                Submit Episode
            </a>
        </div>
        <form method="GET" action="/" class="search-form">
            <div class="search-input-wrapper">
                <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="search-icon">
                    <circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>
                </svg>
                <input type="text" name="q" value="${escapeHtml(search)}" placeholder="Search podcasts or episodes..." class="search-input" id="search-input">
                ${search ? `<a href="/" class="search-clear" title="Clear search">×</a>` : ""}
            </div>
            <button type="submit" class="button">Search</button>
        </form>
        <div class="tag-filter-bar">
            <span class="tag-filter-label">
                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="margin-right: 0.375rem;">
                    <path d="M4 7V4h16v3M9 20h6M12 4v16"/>
                </svg>
                Filter by topic:
            </span>
            ${tagFilter ? `<a href="/" class="tag-badge tag-badge-selected">
                ${escapeHtml(tagFilter)}
                <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="margin-left: 0.25rem;">
                    <path d="M18 6 6 18"/><path d="m6 6 12 12"/>
                </svg>
            </a>` : ""}
            ${getValidTags().map(tag => {
                if (tag === tagFilter) return ""; // Already shown as selected
                return `<a href="/?tag=${encodeURIComponent(tag)}" class="tag-badge">${escapeHtml(tag)}</a>`;
            }).join("")}
        </div>
        ${search && episodes.length === 0 ? `
        <div class="empty-state">
            <p>No episodes found matching "${escapeHtml(search)}"${tagFilter ? ` with tag "${escapeHtml(tagFilter)}"` : ""}</p>
            <a href="/" class="button">Clear Filters</a>
        </div>
        ` : tagFilter && episodes.length === 0 ? `
        <div class="empty-state">
            <p>No episodes found with tag "${escapeHtml(tagFilter)}"</p>
            <a href="/" class="button">Clear Filter</a>
        </div>
        ` : ""}
        ${inProgressSection}
        ${episodes.length > 0 ? `
        <div class="episode-list">
            ${episodeCards.join("")}
        </div>
        ${totalPages > 1 ? `
        <nav class="pagination" aria-label="Episode pagination">
            ${page > 1 ? `
            <a href="/?page=${page - 1}${search ? `&q=${encodeURIComponent(search)}` : ""}${tagFilter ? `&tag=${encodeURIComponent(tagFilter)}` : ""}" class="pagination-link pagination-prev">
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
            <a href="/?page=${page + 1}${search ? `&q=${encodeURIComponent(search)}` : ""}${tagFilter ? `&tag=${encodeURIComponent(tagFilter)}` : ""}" class="pagination-link pagination-next">
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
        ` : ""}
        ` : ""}
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
            <a href="/submit" class="button button-primary mt-4">
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z"/>
                </svg>
                Submit Your First Episode
            </a>
        </div>
    `;

    // Add auto-refresh only when there are truly in-progress jobs (not failed)
    const hasInProgressJobs = activeJobs.some(job => job.status !== "failed");
    const refreshMeta = hasInProgressJobs
        ? '<meta http-equiv="refresh" content="10">'
        : '';

    // Prevent caching when there are active or failed jobs to ensure fresh status
    if (activeJobs.length > 0) {
        c.header("Cache-Control", "no-cache, no-store, must-revalidate");
        c.header("Pragma", "no-cache");
        c.header("Expires", "0");
    }

    return c.html(Layout({
        title: "Home",
        children: content,
        headExtra: refreshMeta
    }));
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
                ${episode.tags && episode.tags.length > 0 ? `<span class="meta-dot">•</span><div style="display: inline-flex; gap: 0.375rem;">${[...episode.tags].sort().map(tag => `<a href="/?tag=${encodeURIComponent(tag)}" class="tag-badge" style="text-decoration: none;">${escapeHtml(tag)}</a>`).join('')}</div>` : ""}
            </div>
            <div class="platform-links">
                <a href="${escapeHtml(episode.appleUrl)}" target="_blank" rel="noopener noreferrer" class="apple-podcasts-badge" title="Listen on Apple Podcasts">
                    <img src="/apple-podcasts-badge.svg" alt="Listen on Apple Podcasts" height="32">
                </a>
            </div>
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
// GET /episode/:episodeId/pdf — PDF Download (hidden from UI, but functional)
// ============================================================================

publicRoutes.get("/episode/:episodeId/pdf", async (c) => {
    const episodeId = c.req.param("episodeId");
    const selectedTemplate = c.req.query("template");

    // Verify episode exists
    const episode = await getEpisode(c.env.TLDL_DATA, episodeId);
    if (!episode) {
        return c.json({ error: "Episode not found" }, 404);
    }

    // Fetch summaries (PDF only includes summary, not transcript)
    const summaries = await listSummariesForEpisode(c.env.TLDL_DATA, episodeId);

    // Determine which summary to use
    const templateId = selectedTemplate || (summaries.length > 0 ? summaries[0].templateId : "key-takeaways");
    const summary = summaries.find((s) => s.templateId === templateId);
    const template = getTemplate(templateId);

    // Generate PDF (summary only, no transcript)
    const pdfBuffer = generateEpisodePdf({
        podcastName: episode.podcastName,
        episodeTitle: episode.episodeTitle,
        episodeDate: episode.episodeDate,
        episodeDuration: episode.episodeDuration,
        summary: summary?.text || "",
        summaryTemplate: template?.name || templateId,
        expiresAt: episode.expiresAt,
    });

    // Sanitize filename - remove special characters
    const safeFilename = episode.episodeTitle
        .replace(/[^a-zA-Z0-9\s-]/g, "")
        .replace(/\s+/g, "_")
        .substring(0, 100);

    // Return as downloadable PDF
    return new Response(pdfBuffer, {
        headers: {
            "Content-Type": "application/pdf",
            "Content-Disposition": `attachment; filename="${safeFilename}.pdf"`,
        },
    });
});

// ============================================================================
// GET /submit — Episode Submission Form
// ============================================================================

publicRoutes.get("/submit", async (c) => {
    const content = SubmitFormPage({ error: null, url: "", templateId: "key-takeaways" });
    return c.html(Layout({ title: "Submit Episode", children: content }));
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
        </style>
        <div class="intro-section">
            <p>Submitting new episodes is currently invite-only. Browse existing summaries on the home page or contact the creator for access.</p>
        </div>
        <div class="card about-page">
            <h1>About TL;DL</h1>

            <section style="margin-top: 2rem;">
                <h2>What is TL;DL?</h2>
                <p>
                    TL;DL (Too Long; Didn't Listen) generates AI-powered summaries of podcast episodes.
                    Paste an Apple Podcasts URL, and get a concise summary along with the full transcript.
                </p>
                <p>
                    All summaries and transcripts are cached for 365 days, so if someone has already
                    processed an episode, you'll get instant results.
                </p>
            </section>

            <section style="margin-top: 2rem;">
                <h2>Summary Templates</h2>
                <p>Choose from three different summary styles depending on the type of content:</p>

                <div style="margin-top: 1rem;">
                    <h3 style="margin-bottom: 0.5rem;">Key Takeaways & Practical Steps</h3>
                    <p style="margin-top: 0; color: var(--muted-foreground);">
                        Best for craft and professional development podcasts. Includes an overview,
                        key insights, actionable steps, and notable quotes.
                    </p>
                </div>

                <div style="margin-top: 1rem;">
                    <h3 style="margin-bottom: 0.5rem;">Narrative Summary</h3>
                    <p style="margin-top: 0; color: var(--muted-foreground);">
                        Best for story-driven and interview podcasts. Captures the arc of the conversation
                        with flowing narrative and main themes.
                    </p>
                </div>

                <div style="margin-top: 1rem;">
                    <h3 style="margin-bottom: 0.5rem;">ELI5 (Explain Like I'm 5)</h3>
                    <p style="margin-top: 0; color: var(--muted-foreground);">
                        Best for technical and complex topics. Breaks down complex concepts using everyday
                        analogies and simple language.
                    </p>
                </div>
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
                    Transcription and summarization powered by
                    <a href="https://openai.com/" target="_blank" rel="noopener noreferrer">OpenAI</a>
                    (Whisper and GPT-5.2).
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
    return c.html(Layout({ title: "About", children: content }));
});

// ============================================================================
// POST /submit — Handle Form Submission
// ============================================================================

publicRoutes.post("/submit", async (c) => {
    const formData = await c.req.formData();
    const appleUrl = formData.get("appleUrl") as string || "";
    const templateId = formData.get("templateId") as string || "key-takeaways";

    // Validate URL
    if (!appleUrl.trim()) {
        const content = SubmitFormPage({
            error: "Please enter a podcast episode URL",
            url: appleUrl,
            templateId
        });
        return c.html(Layout({ title: "Submit Episode", children: content }), 400);
    }

    const parsed = parseApplePodcastsUrl(appleUrl);
    if (!parsed) {
        const content = SubmitFormPage({
            error: "Please enter a valid Apple Podcasts episode URL. It should look like: podcasts.apple.com/...?i=...",
            url: appleUrl,
            templateId
        });
        return c.html(Layout({ title: "Submit Episode", children: content }), 400);
    }

    // Validate template
    if (!isValidTemplateId(templateId)) {
        const content = SubmitFormPage({
            error: `Invalid summary template: ${templateId}`,
            url: appleUrl,
            templateId
        });
        return c.html(Layout({ title: "Submit Episode", children: content }), 400);
    }

    // Derive episode ID
    const episodeId = deriveEpisodeId(parsed.podcastId, parsed.episodeId);

    // Check if already cached
    const existingEpisode = await getEpisode(c.env.TLDL_DATA, episodeId);
    if (existingEpisode) {
        const summaries = await listSummariesForEpisode(c.env.TLDL_DATA, episodeId);
        const hasSummary = summaries.some(s => s.templateId === templateId);
        if (hasSummary) {
            // Already processed - redirect directly to episode page
            return c.redirect(`/episode/${episodeId}?template=${templateId}`);
        }
    }

    // Create new job (skip prefetch to speed up redirect - queue consumer handles via Podcast Index + Apple scraping)
    const jobId = crypto.randomUUID();
    const now = new Date().toISOString();

    const job: Job = {
        id: jobId,
        episodeId,
        appleUrl,
        status: "queued",
        templateId,
        createdAt: now,
        updatedAt: now,
    };

    // Create job in both DO (immediate consistency) and KV (backup)
    await createJobDO(c.env, job);
    await createJob(c.env.TLDL_DATA, job);

    // Queue the job for processing
    // Extract user email from JWT if available (for profile page tracking)
    const userEmail = getUserEmail(c);

    const message = createProcessEpisodeMessage({
        jobId,
        episodeId,
        appleUrl,
        templateId,
        submittedBy: userEmail,
    });
    await enqueueJob(c.env.TLDL_QUEUE, message);

    // Redirect to job status page
    return c.redirect(`/job/${jobId}`);
});

// ============================================================================
// Submit Form Component
// ============================================================================

interface SubmitFormProps {
    error: string | null;
    url: string;
    templateId: string;
}

function SubmitFormPage(props: SubmitFormProps): string {
    const templateOptions = Object.entries(TEMPLATES).map(([id, template]) => {
        const checked = props.templateId === id ? "checked" : "";
        return `
            <label class="radio-option">
                <input type="radio" name="templateId" value="${escapeHtml(id)}" ${checked}>
                <div class="radio-content">
                    <div class="radio-label">${escapeHtml(template.name)}</div>
                    <div class="radio-description">${escapeHtml(template.description)}</div>
                </div>
            </label>
        `;
    }).join("");

    const errorHtml = props.error ? `
        <div class="alert alert-error">
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
            </svg>
            <span>${escapeHtml(props.error)}</span>
        </div>
    ` : "";

    return `
        <div class="page-header">
            <h1>Submit Episode</h1>
            <p class="page-subtitle">Generate an AI summary from any Apple Podcasts episode</p>
        </div>

        <div class="card">
            <form method="POST" action="/submit" class="form">
                <div class="form-group">
                    <label for="appleUrl" class="form-label">Apple Podcasts Episode URL</label>
                    <input 
                        type="url" 
                        id="appleUrl"
                        name="appleUrl" 
                        value="${escapeHtml(props.url)}"
                        placeholder="https://podcasts.apple.com/us/podcast/..."
                        class="form-input"
                        required
                    >
                    <p class="form-hint">Paste the URL from an Apple Podcasts episode page</p>
                </div>

                <div class="form-group">
                    <fieldset class="form-fieldset">
                        <legend class="form-label">Summary Template</legend>
                        <div class="radio-group">
                            ${templateOptions}
                        </div>
                    </fieldset>
                </div>

                ${errorHtml}

                <div class="alert alert-info">
                    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z"/>
                    </svg>
                    <span>Episodes are limited to 1h45m. Transcripts and summaries are cached for 365 days.</span>
                </div>

                <div class="form-actions">
                    <button type="submit" class="button button-primary">
                        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z"/>
                        </svg>
                        Generate Summary
                    </button>
                    <a href="/" class="button">Cancel</a>
                </div>
            </form>
        </div>

        <div class="text-center mt-4">
            <button type="button" onclick="document.getElementById('appleUrl').value='https://podcasts.apple.com/us/podcast/the-knowledge-project/id990149481?i=1000638000000'" class="link-button">
                Try an example URL
            </button>
        </div>
    `;
}

// ============================================================================
// GET /job/:jobId — Job Status Page (HTML)
// ============================================================================

publicRoutes.get("/job/:jobId", async (c) => {
    const jobId = c.req.param("jobId");

    // Use DO with fallback to KV for strongly consistent status
    let job = await getJobWithFallback(c.env, c.env.TLDL_DATA, jobId);
    if (!job) {
        const content = `
            <div class="error-page">
                <h1>Job Not Found</h1>
                <p>This job doesn't exist or has expired.</p>
                <a href="/" class="button">Back to Home</a>
            </div>
        `;
        return c.html(Layout({ title: "Not Found", children: content }), 404);
    }

    // Check for job timeout - if job has been running for more than 20 minutes, mark as failed
    const isInProgressStatus = job.status !== "completed" && job.status !== "failed";
    if (isInProgressStatus) {
        const jobAge = Date.now() - new Date(job.createdAt).getTime();
        if (jobAge > TIMEOUTS.JOB_MS) {
            console.log(
                JSON.stringify({
                    event: "job_timeout_detected",
                    jobId,
                    status: job.status,
                    ageMinutes: Math.round(jobAge / 60000),
                    createdAt: job.createdAt,
                })
            );
            // Mark job as failed due to timeout
            const timeoutError = `Job timed out after ${Math.round(jobAge / 60000)} minutes. The transcription may have stalled. Please try again.`;
            await updateJobStatusDO(c.env, jobId, "failed", timeoutError);
            await updateJobStatus(c.env.TLDL_DATA, jobId, "failed", timeoutError);
            // Refresh job data
            job = { ...job, status: "failed", error: timeoutError };
        }
    }

    // Debug: log what status we're seeing
    console.log(
        JSON.stringify({
            event: "job_status_read",
            jobId,
            status: job.status,
            updatedAt: job.updatedAt,
        })
    );

    const content = JobStatusPage(job);

    // Add auto-refresh only for in-progress jobs (not completed or failed)
    const isInProgress = job.status !== "failed" && job.status !== "completed";
    const refreshMeta = isInProgress
        ? '<meta http-equiv="refresh" content="5">'
        : '';

    // Prevent caching to ensure fresh status on every request
    c.header("Cache-Control", "no-cache, no-store, must-revalidate");
    c.header("Pragma", "no-cache");
    c.header("Expires", "0");

    return c.html(Layout({
        title: job.status === "completed" ? "Episode Ready" : "Processing Episode",
        children: content,
        headExtra: refreshMeta
    }));
});

// ============================================================================
// POST /job/:jobId/retry — Retry Failed Job (HTML)
// ============================================================================

publicRoutes.post("/job/:jobId/retry", async (c) => {
    const jobId = c.req.param("jobId");

    // Use DO with fallback for job lookup
    const job = await getJobWithFallback(c.env, c.env.TLDL_DATA, jobId);
    if (!job) {
        return c.redirect("/");
    }

    if (job.status !== "failed") {
        return c.redirect(`/job/${jobId}`);
    }

    // Reset job status in both DO and KV
    await updateJobStatusDO(c.env, jobId, "queued");
    await updateJobStatus(c.env.TLDL_DATA, jobId, "queued");

    // Re-queue the job (include user email if available)
    const userEmail = getUserEmail(c);
    const message = createProcessEpisodeMessage({
        jobId,
        episodeId: job.episodeId,
        appleUrl: job.appleUrl,
        templateId: job.templateId,
        submittedBy: userEmail,
    });
    await enqueueJob(c.env.TLDL_QUEUE, message);

    return c.redirect(`/job/${jobId}`);
});

// ============================================================================
// POST /job/:jobId/delete — Remove Failed Job (HTML)
// ============================================================================

publicRoutes.post("/job/:jobId/delete", async (c) => {
    const jobId = c.req.param("jobId");

    // Use DO with fallback for job lookup
    const job = await getJobWithFallback(c.env, c.env.TLDL_DATA, jobId);
    if (!job) {
        return c.redirect("/");
    }

    // Only allow deletion of failed jobs
    if (job.status !== "failed") {
        return c.redirect(`/job/${jobId}`);
    }

    // Delete from both DO and KV
    await deleteJobDO(c.env, jobId);
    await c.env.TLDL_DATA.delete(`job:${jobId}`);

    return c.redirect("/");
});

// ============================================================================
// Job Status Component
// ============================================================================

const STATUS_LABELS: Record<JobStatus, string> = {
    queued: "Queued",
    fetching_metadata: "Fetching episode metadata",
    checking_transcript: "Checking for existing transcript",
    transcribing: "Transcribing audio",
    summarizing: "Generating summary",
    completed: "Completed",
    failed: "Failed",
};

const STATUS_PROGRESS: Record<JobStatus, number> = {
    queued: 5,
    fetching_metadata: 20,
    checking_transcript: 35,
    transcribing: 60,
    summarizing: 85,
    completed: 100,
    failed: 0,
};

const STATUS_ORDER: JobStatus[] = [
    "queued",
    "fetching_metadata",
    "checking_transcript",
    "transcribing",
    "summarizing",
    "completed",
];

function JobStatusPage(job: Job): string {
    const currentProgress = STATUS_PROGRESS[job.status];
    const isFailed = job.status === "failed";

    // Build progress steps
    const stepsHtml = STATUS_ORDER.filter(status => status !== "completed").map(status => {
        const label = STATUS_LABELS[status];
        const statusProgress = STATUS_PROGRESS[status];
        const isCurrentStep = job.status === status;
        const isPastStep = !isFailed && currentProgress > statusProgress;

        let stepClass = "step";
        let iconHtml = "";

        if (isPastStep) {
            stepClass += " step-complete";
            iconHtml = `
                <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="step-icon step-icon-check">
                    <circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>
                </svg>
            `;
        } else if (isCurrentStep && !isFailed) {
            stepClass += " step-current";
            iconHtml = `
                <div class="step-icon step-icon-spinner"></div>
            `;
        } else {
            stepClass += " step-pending";
            iconHtml = `
                <div class="step-icon step-icon-empty"></div>
            `;
        }

        return `
            <div class="${stepClass}">
                ${iconHtml}
                <span class="step-label">${escapeHtml(label)}</span>
            </div>
        `;
    }).join("");

    // Estimated time
    const estimatedTimeHtml = job.estimatedSeconds && job.estimatedSeconds > 0 && !isFailed ? `
        <div class="estimated-time">
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
            </svg>
            ~${Math.ceil(job.estimatedSeconds / 60)} minute${job.estimatedSeconds > 60 ? 's' : ''} remaining
        </div>
    ` : "";

    // Error display
    const errorHtml = isFailed ? `
        <div class="alert alert-error">
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
            </svg>
            <span>${escapeHtml(job.error || "An unknown error occurred")}</span>
        </div>
    ` : "";

    // Progress bar (only show when not failed and not completed)
    const isCompleted = job.status === "completed";
    const progressBarHtml = !isFailed && !isCompleted ? `
        <div class="progress-container">
            <div class="progress-bar">
                <div class="progress-fill" style="width: ${currentProgress}%"></div>
            </div>
            <div class="progress-info">
                <span class="progress-percent">${currentProgress}% complete</span>
                ${estimatedTimeHtml}
            </div>
        </div>
    ` : "";

    // Success message for completed jobs
    const successHtml = isCompleted ? `
        <div class="alert alert-success mb-4">
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>
            </svg>
            <span>Your episode summary is ready!</span>
        </div>
    ` : "";

    // Actions based on status
    let actionsHtml = "";
    if (isCompleted) {
        actionsHtml = `
            <div class="form-actions">
                <a href="/episode/${escapeHtml(job.episodeId)}?template=${escapeHtml(job.templateId)}" class="button button-primary">
                    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/>
                        <circle cx="12" cy="12" r="3"/>
                    </svg>
                    View Episode Summary
                </a>
                <a href="/" class="button">Back to Episodes</a>
            </div>
        `;
    } else if (isFailed) {
        actionsHtml = `
            <div class="form-actions">
                <form method="POST" action="/job/${escapeHtml(job.id)}/retry" style="display: contents;">
                    <button type="submit" class="button button-primary">
                        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/>
                            <path d="M3 3v5h5"/>
                            <path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"/>
                            <path d="M16 21h5v-5"/>
                        </svg>
                        Retry
                    </button>
                </form>
                <form method="POST" action="/job/${escapeHtml(job.id)}/delete" style="display: contents;">
                    <button type="submit" class="button" onclick="return confirm('Are you sure you want to remove this failed job?')">
                        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>
                        </svg>
                        Remove Job
                    </button>
                </form>
                <a href="/" class="button">Back to Episodes</a>
            </div>
        `;
    } else {
        actionsHtml = `
            <div class="form-actions">
                <a href="/" class="button">Back to Episodes</a>
            </div>
        `;
    }

    // Page title based on status
    const pageTitle = isCompleted ? "Episode Ready" : isFailed ? "Processing Failed" : "Processing Episode";

    return `
        <div class="page-header">
            <h1>${pageTitle}</h1>
            <p class="page-subtitle">Job ID: <code class="job-id">${escapeHtml(job.id)}</code></p>
        </div>

        <div class="card">
            ${progressBarHtml}

            ${!isCompleted ? `
            <div class="steps">
                ${stepsHtml}
            </div>
            ` : ""}

            ${successHtml}
            ${errorHtml}

            ${actionsHtml}
        </div>

        ${!isFailed && !isCompleted ? `
        <div class="text-center mt-4">
            <p class="text-muted text-sm">This page will automatically update. You can safely navigate away and return later.</p>
        </div>
        ` : ""}
    `;
}

export default publicRoutes;
