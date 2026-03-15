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
    getPodcastList,
    getEpisodesForPodcast,
} from "../lib/kv";
import {
    listActiveJobsWithDO,
} from "../lib/job-status-do";
import { getTemplate, getValidTags, isValidTag } from "../lib/constants";
import { extractPodcastId } from "../lib/url-parser";

import { escapeHtml } from "../lib/auth";
import { marked } from "marked";
import { Footer } from "../lib/components";
import { verifyTurnstile } from "../lib/turnstile";
import { sendEmail } from "../services/postmark";

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
 * Render markdown to HTML using the marked library
 * Configured for security (no raw HTML passthrough)
 */
function renderMarkdown(md: string): string {
    if (!md) return "";

    // Configure marked for safe output
    marked.setOptions({
        gfm: true,        // GitHub Flavored Markdown
        breaks: false,    // Don't convert single newlines to <br>
    });

    return marked.parse(md) as string;
}

/**
 * Extract the first sentence from text for use in meta descriptions
 * Skips markdown headings (lines starting with #)
 */
function getFirstSentence(text: string, maxLength: number = 160): string {
    if (!text) return "";

    // Skip markdown headings and find the first content line
    const lines = text.split('\n');
    let contentText = "";
    for (const line of lines) {
        const trimmed = line.trim();
        // Skip empty lines and markdown headings
        if (!trimmed || trimmed.startsWith('#')) continue;
        contentText = trimmed;
        break;
    }

    if (!contentText) return "";

    // Find the first sentence-ending punctuation
    const match = contentText.match(/^[^.!?]+[.!?]/);
    const firstSentence = match ? match[0].trim() : contentText.substring(0, maxLength);

    // Truncate if too long for meta descriptions
    if (firstSentence.length > maxLength) {
        return firstSentence.substring(0, maxLength - 3).trim() + "...";
    }

    return firstSentence;
}

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
                        <a href="/about" class="nav-link">About</a>
                    </nav>
                    <main class="main">${raw(props.children)}</main>
                    ${Footer}
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
                <div class="episode-podcast">${escapeHtml(episode.podcastName)}${episode.podcastAuthor ? ` <span class="podcast-author podcast-author-inline">by ${escapeHtml(episode.podcastAuthor)}</span>` : ''}</div>
                <h3 class="episode-title">${escapeHtml(episode.episodeTitle)}</h3>
                <div class="episode-meta">
                    <span>${formatDate(episode.episodeDate)}</span>
                    <span class="meta-dot">•</span>
                    <span>${formatDuration(episode.episodeDuration)}</span>
                </div>
                ${tagBadges || templateBadges ? `
                    <div class="episode-badges">
                        ${tagBadges}
                        ${tagBadges && templateBadges ? '<span class="meta-dot" style="margin: 0 0.25rem;">•</span>' : ''}
                        ${templateBadges}
                    </div>
                ` : ""}
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
        <div class="${cardClass}">
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
        </div>
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
        <div class="hero-section">
            <h1 class="hero-headline">Your favorite podcasts, <span class="text-accent">summarized</span>.</h1>
            <p class="hero-subtitle">Get key takeaways, a narrative overview, or a simplified explainer. Browse AI summaries below, or <a href="/request" class="hero-link">request a podcast</a> to be added.</p>
        </div>
    `;

    const content =
        episodes.length > 0 || activeJobs.length > 0 || search
            ? `
        ${introSection}
        <div class="page-header">
            <h2>Recently Added Episodes</h2>
            <p class="page-subtitle">Browse AI-generated summaries from podcast episodes</p>
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
        <div class="topic-filter" id="topic-filter">
            ${tagFilter ? `
            <a href="/" class="topic-filter-selected">
                ${escapeHtml(tagFilter)}
                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M18 6 6 18"/><path d="m6 6 12 12"/>
                </svg>
            </a>
            ` : ""}
            <div class="topic-filter-input-wrapper" ${tagFilter ? 'style="display: none;"' : ""}>
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="topic-filter-icon">
                    <path d="M4 7V4h16v3M9 20h6M12 4v16"/>
                </svg>
                <input 
                    type="text" 
                    class="topic-filter-input" 
                    id="topic-filter-input"
                    placeholder="Filter by topic..." 
                    autocomplete="off"
                />
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="topic-filter-chevron">
                    <path d="m6 9 6 6 6-6"/>
                </svg>
            </div>
            <div class="topic-filter-dropdown" id="topic-filter-dropdown">
                ${getValidTags().map(tag =>
                `<a href="/?tag=${encodeURIComponent(tag)}" class="topic-filter-option${tag === tagFilter ? ' selected' : ''}" data-tag="${escapeHtml(tag)}">${escapeHtml(tag)}</a>`
            ).join("")}
            </div>
        </div>
        <script>
        (function() {
            var filter = document.getElementById('topic-filter');
            var input = document.getElementById('topic-filter-input');
            var dropdown = document.getElementById('topic-filter-dropdown');
            var options = dropdown.querySelectorAll('.topic-filter-option');
            var allTags = ${JSON.stringify(getValidTags())};
            var highlightedIndex = -1;

            function openDropdown() {
                filter.classList.add('open');
                updateHighlight(-1);
            }

            function closeDropdown() {
                filter.classList.remove('open');
                highlightedIndex = -1;
            }

            function updateHighlight(index) {
                var visibleOptions = dropdown.querySelectorAll('.topic-filter-option:not([style*="display: none"])');
                visibleOptions.forEach(function(opt, i) {
                    opt.classList.toggle('highlighted', i === index);
                });
                highlightedIndex = index;
                if (index >= 0 && visibleOptions[index]) {
                    visibleOptions[index].scrollIntoView({ block: 'nearest' });
                }
            }

            function filterOptions(query) {
                var q = query.toLowerCase().trim();
                var visibleCount = 0;
                options.forEach(function(opt) {
                    var tag = opt.getAttribute('data-tag').toLowerCase();
                    var matches = !q || tag.includes(q);
                    opt.style.display = matches ? '' : 'none';
                    if (matches) visibleCount++;
                });
                updateHighlight(-1);
                // Show/hide empty state
                var existing = dropdown.querySelector('.topic-filter-empty');
                if (existing) existing.remove();
                if (visibleCount === 0) {
                    var empty = document.createElement('div');
                    empty.className = 'topic-filter-empty';
                    empty.textContent = 'No topics match "' + query + '"';
                    dropdown.appendChild(empty);
                }
            }

            input.addEventListener('focus', openDropdown);
            input.addEventListener('input', function() {
                filterOptions(this.value);
            });

            input.addEventListener('keydown', function(e) {
                var visibleOptions = dropdown.querySelectorAll('.topic-filter-option:not([style*="display: none"])');
                if (e.key === 'ArrowDown') {
                    e.preventDefault();
                    if (!filter.classList.contains('open')) openDropdown();
                    updateHighlight(Math.min(highlightedIndex + 1, visibleOptions.length - 1));
                } else if (e.key === 'ArrowUp') {
                    e.preventDefault();
                    updateHighlight(Math.max(highlightedIndex - 1, 0));
                } else if (e.key === 'Enter') {
                    e.preventDefault();
                    if (highlightedIndex >= 0 && visibleOptions[highlightedIndex]) {
                        window.location.href = visibleOptions[highlightedIndex].href;
                    }
                } else if (e.key === 'Escape') {
                    closeDropdown();
                    input.blur();
                }
            });

            // Close on outside click
            document.addEventListener('click', function(e) {
                if (!filter.contains(e.target)) {
                    closeDropdown();
                }
            });

            // Prevent dropdown from closing when clicking inside
            dropdown.addEventListener('mousedown', function(e) {
                e.preventDefault();
            });
        })();
        </script>
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
            <p>No episodes yet. Check back soon!</p>
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
        headExtra: refreshMeta,
        canonicalUrl: BASE_URL + "/"
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
    const transcribeModelLabel = transcript?.model
        ? `Audio transcribed with ${escapeHtml(transcript.model)}. `
        : "";
    const summaryContent = activeSummary
        ? `
        <div class="summary-header">
            <div class="summary-model">${transcribeModelLabel}Summary generated with ${escapeHtml(activeSummary.model)}</div>
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
            ${episode.podcastAuthor ? `<div class="podcast-author podcast-author-block">by ${escapeHtml(episode.podcastAuthor)}</div>` : ''}
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
                ${episode.tags && episode.tags.length > 0 ? `
                <span class="meta-dot">•</span>
                <div style="display: inline-flex; gap: 0.375rem;">
                    ${[...episode.tags].sort().map(tag =>
        `<a href="/?tag=${encodeURIComponent(tag)}" class="tag-badge" style="text-decoration: none;">${escapeHtml(tag)}</a>`
    ).join('')}
                </div>
                ` : ''}
            </div>
            <div class="platform-links">
                <a href="${escapeHtml(episode.appleUrl)}" target="_blank" rel="noopener noreferrer" class="apple-podcasts-badge" title="Listen on Apple Podcasts">
                    <img src="/apple-podcasts-badge.svg" alt="Listen on Apple Podcasts" height="32">
                </a>
                ${episode.podcastWebsiteUrl ? `
                <a href="${escapeHtml(episode.podcastWebsiteUrl)}" target="_blank" rel="noopener noreferrer" class="website-link" title="Visit podcast website">
                    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <circle cx="12" cy="12" r="10"/><path d="M2 12h20"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>
                    </svg>
                    Visit Website
                </a>
                ` : ''}
                ${(() => {
            const podId = extractPodcastId(episode.id);
            return podId ? `
                <a href="/podcasts/${podId}" class="website-link" title="More episodes from this podcast">
                    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <path d="m12 8-9.04 9.06a2.82 2.82 0 1 0 3.98 3.98L16 12"/>
                        <circle cx="17" cy="7" r="5"/>
                    </svg>
                    More from ${escapeHtml(episode.podcastName)}
                </a>
                    ` : '';
        })()}
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
            <div class="section-header-with-action">
                <h2>Full Transcript</h2>
                ${transcript ? `
                <a href="/api/episode/${escapeHtml(episodeId)}/transcript.txt" class="button button-sm" download>
                    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                        <polyline points="7 10 12 15 17 10"/>
                        <line x1="12" x2="12" y1="15" y2="3"/>
                    </svg>
                    Download
                </a>
                ` : ''}
            </div>
            <div class="card">
                ${transcriptContent}
            </div>
        </section>
    `;

    // Extract first sentence of summary for meta description
    const episodeDescription = activeSummary
        ? getFirstSentence(activeSummary.text)
        : `AI-generated summary of "${episode.episodeTitle}" from ${episode.podcastName}`;

    return c.html(
        Layout({ title: episode.episodeTitle, children: content, description: episodeDescription, canonicalUrl: `${BASE_URL}/episode/${episodeId}` })
    );
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
                <h2>RSS Feed</h2>
                <p>
                    Subscribe to new episode summaries via the
                    <a href="/feed">RSS feed</a>.
                    The feed includes the latest 50 episodes with their summaries.
                </p>
                <p>
                    You can also filter the feed by topic using the <code>tag</code> parameter. For example:
                </p>
                <ul>
                    <li><a href="/feed?tag=technology">/feed?tag=technology</a> — Technology episodes only</li>
                    <li><a href="/feed?tag=music">/feed?tag=music</a> — Music episodes only</li>
                    <li><a href="/feed?tag=business">/feed?tag=business</a> — Business episodes only</li>
                </ul>
                <p>
                    See the home page's "Filter by topic" dropdown for the full list of available tags.
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
 * Build RSS 2.0 feed XML with summaries
 */
function buildRssFeed(
    episodes: EpisodeWithSummary[],
    tagFilter: string | undefined,
    baseUrl: string
): string {
    const feedTitle = tagFilter
        ? `TL;DL - ${tagFilter} episodes`
        : "TL;DL - Too Long Didn't Listen";
    const feedDescription = tagFilter
        ? `AI-generated podcast summaries tagged with "${tagFilter}"`
        : "AI-generated podcast summaries from Apple Podcasts";
    const feedLink = tagFilter
        ? `${baseUrl}/?tag=${encodeURIComponent(tagFilter)}`
        : baseUrl;
    const selfLink = tagFilter
        ? `${baseUrl}/feed?tag=${encodeURIComponent(tagFilter)}`
        : `${baseUrl}/feed`;

    const items = episodes.map((ep) => {
        const itemLink = `${baseUrl}/episode/${ep.id}`;
        const categories = ep.tags
            ? ep.tags.map((tag) => `        <category>${escapeXml(tag)}</category>`).join("\n")
            : "";
        
        // Build description with podcast info header and summary (converted to HTML)
        const podcastInfo = `${ep.podcastName} • ${formatDuration(ep.episodeDuration)}`;
        const description = ep.summaryText
            ? `<![CDATA[<p><strong>${escapeHtml(podcastInfo)}</strong></p>${renderMarkdown(ep.summaryText)}]]>`
            : escapeXml(podcastInfo);

        return `    <item>
      <title>${escapeXml(ep.episodeTitle)}</title>
      <link>${itemLink}</link>
      <guid isPermaLink="true">${itemLink}</guid>
      <pubDate>${toRfc822Date(ep.createdAt)}</pubDate>
      <description>${description}</description>
      <source url="${baseUrl}/feed">${escapeXml(ep.podcastName)}</source>
${categories}
    </item>`;
    }).join("\n");

    return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
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
// GET /podcasts/:podcastId — Individual Podcast Page
// ============================================================================

publicRoutes.get("/podcasts/:podcastId", async (c) => {
    const podcastId = c.req.param("podcastId");
    const pageParam = c.req.query("page");
    const page = Math.max(1, parseInt(pageParam || "1", 10) || 1);
    const pageSize = 10;

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

    // Get paginated episodes for this podcast
    const { episodes, total, totalPages } = await getEpisodesForPodcast(
        c.env.TLDL_DATA,
        podcastId,
        { page, pageSize }
    );

    if (episodes.length === 0 && page === 1) {
        const content = `
            <div class="error-page">
                <h1>Podcast Not Found</h1>
                <p>No episodes have been summarized for this podcast yet.</p>
                <a href="/podcasts" class="button">Browse All Podcasts</a>
            </div>
        `;
        return c.html(Layout({ title: "Not Found", children: content }), 404);
    }

    // Get podcast info from first episode (or redirect if page is out of bounds)
    if (episodes.length === 0) {
        return c.redirect(`/podcasts/${podcastId}`);
    }

    const podcastName = episodes[0].podcastName;
    const podcastAuthor = episodes[0].podcastAuthor;

    // Get podcast website URL from full episode data
    const fullEpisode = await getEpisode(c.env.TLDL_DATA, episodes[0].id);
    const podcastWebsiteUrl = fullEpisode?.podcastWebsiteUrl;

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

    // Build pagination
    const paginationHtml = totalPages > 1 ? `
        <nav class="pagination" aria-label="Episode pagination">
            ${page > 1 ? `
            <a href="/podcasts/${escapeHtml(podcastId)}?page=${page - 1}" class="pagination-link pagination-prev">
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
            <a href="/podcasts/${escapeHtml(podcastId)}?page=${page + 1}" class="pagination-link pagination-next">
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

    const websiteLink = podcastWebsiteUrl && !podcastWebsiteUrl.includes('/rss') && !podcastWebsiteUrl.includes('.xml')
        ? `<a href="${escapeHtml(podcastWebsiteUrl)}" target="_blank" rel="noopener noreferrer" class="podcast-website-link">
             Visit Website
             <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                 <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
                 <polyline points="15 3 21 3 21 9"/>
                 <line x1="10" x2="21" y1="14" y2="3"/>
             </svg>
           </a>`
        : "";

    const content = `
        <a href="/podcasts" class="back-link">
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="m15 18-6-6 6-6"/>
            </svg>
            Back to all podcasts
        </a>
        <div class="podcast-header">
            <h1>${escapeHtml(podcastName)}</h1>
            ${podcastAuthor ? `<p class="podcast-header-author">by ${escapeHtml(podcastAuthor)}</p>` : ''}
            <p class="podcast-header-meta">${total} episode${total !== 1 ? 's' : ''} summarized</p>
            ${websiteLink}
        </div>
        <div class="divider"></div>
        <div class="episode-list">
            ${episodeCards.join("")}
        </div>
        ${paginationHtml}
    `;

    return c.html(Layout({
        title: podcastName,
        children: content,
        description: `AI-generated summaries for ${total} episode${total !== 1 ? 's' : ''} from ${podcastName}`,
        canonicalUrl: `${BASE_URL}/podcasts/${podcastId}`
    }));
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

    // Fetch summaries for each episode in parallel
    const episodesWithSummaries = await Promise.all(
        episodes.map(async (ep) => {
            const summaries = await listSummariesForEpisode(c.env.TLDL_DATA, ep.id);
            // Use the first (most recent) summary, or the default template if available
            const summary = summaries.find(s => s.templateId === c.env.DEFAULT_TEMPLATE) || summaries[0];
            return {
                ...ep,
                summaryText: summary?.text,
            };
        })
    );

    // Build the base URL from the request
    const url = new URL(c.req.url);
    const baseUrl = `${url.protocol}//${url.host}`;

    // Generate RSS feed
    const xml = buildRssFeed(episodesWithSummaries, tagFilter || undefined, baseUrl);

    // Return with proper content type and caching (1 hour cache)
    return c.text(xml, {
        headers: {
            "Content-Type": "application/rss+xml; charset=utf-8",
            "Cache-Control": "public, max-age=3600",
        },
    });
});

export default publicRoutes;
