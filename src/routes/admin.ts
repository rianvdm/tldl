/**
 * Admin Routes
 * All routes are protected by Cloudflare Access (admin-only emails).
 * Mounted at /admin in index.ts.
 */

import { Hono } from "hono";
import type { HonoEnv, Job, MonitorSettings } from "../types";
import { Layout } from "./public";
import {
    createJob,
    getEpisode,
    getTranscript,
    getSummary,
    saveSummary,
    deleteEpisode,
    deleteJob,
    listEpisodes,
    listSummariesForEpisode,
    rebuildEpisodeIndex,
    getMonitorSettings,
    saveMonitorSettings,
    listMonitoredPodcasts,
    getMonitoredPodcast,
    deleteMonitoredPodcast,
    updateEpisodeTags,
    getActivityLog,
    getPodcastList,
} from "../lib/kv";
import {
    createJobDO,
    deleteJobDO,
    getJobDO,
    listActiveJobsWithDO,
} from "../lib/job-status-do";
import {
    enqueueJob,
    createProcessEpisodeMessage,
    createRegenerateSummaryMessage,
} from "../lib/queue";
import { parseApplePodcastsUrl, parseYouTubeUrl, detectUrlType, parsePodcastUrl, deriveEpisodeId } from "../lib/url-parser";
import { isValidTemplateId, getValidTags, validateTags, TEMPLATES, isBlockedPodcast } from "../lib/constants";
import { prefetchEpisodeInfo } from "../services/apple-podcasts";
import { generateEpisodeTags } from "../services/tag-generation";
import { getUserEmailFromJwt, escapeHtml, isAdminUser } from "../lib/auth";
import {
    addPodcastToMonitoring,
    forceCheckAllPodcasts,
    checkPodcastForNewEpisodes,
} from "../lib/monitor";

const admin = new Hono<HonoEnv>();

// ============================================================================
// Middleware - Admin Auth Check
// ============================================================================

/**
 * Validates JWT and extracts user email.
 * FAIL-CLOSED: In production, requests without valid JWT are rejected.
 * For local dev, we mock the admin user.
 */
async function requireAdmin(c: import("hono").Context<HonoEnv>): Promise<Response | null> {
    const cfAccessJwt = c.req.header("Cf-Access-Jwt-Assertion");
    const isDevelopment = c.env.ENVIRONMENT === "development";

    // FAIL-CLOSED: In production, reject requests without valid JWT
    if (!isDevelopment && !cfAccessJwt) {
        return c.json({ error: "Unauthorized" }, 401);
    }

    if (cfAccessJwt) {
        const userEmail = getUserEmailFromJwt(cfAccessJwt);
        if (!userEmail) {
            // Malformed JWT or missing email — fail closed
            return c.json({ error: "Invalid token" }, 401);
        }
        if (!isAdminUser(userEmail)) {
            return c.json({ error: "Admin access required" }, 403);
        }
        c.set("userEmail", userEmail);
    } else if (isDevelopment) {
        // Mock admin user for local development
        c.set("userEmail", "rianvdm@gmail.com");
    }

    return null;
}

// ============================================================================
// Helper Functions
// ============================================================================

function generateUUID(): string {
    return crypto.randomUUID();
}

function formatDuration(seconds: number): string {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    if (hours > 0) {
        return `${hours}h ${minutes}m`;
    }
    return `${minutes}m`;
}

function formatRelativeTime(isoDate: string): string {
    const now = Date.now();
    const then = new Date(isoDate).getTime();
    const diffMs = now - then;
    const diffMinutes = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMinutes < 1) return "just now";
    if (diffMinutes < 60) return `${diffMinutes}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays < 7) return `${diffDays}d ago`;
    return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(new Date(isoDate));
}

function formatDate(dateString: string): string {
    const date = new Date(dateString);
    return new Intl.DateTimeFormat("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
    }).format(date);
}

// ============================================================================
// GET / - Admin Dashboard
// ============================================================================

admin.get("/", async (c) => {
    const authError = await requireAdmin(c);
    if (authError) return authError;

    const userEmail = c.get("userEmail") || "Unknown User";

    // Parse pagination
    const pageParam = c.req.query("page");
    const page = Math.max(1, parseInt(pageParam || "1", 10) || 1);
    const pageSize = 10;

    // Fetch dashboard data in parallel
    const [result, podcasts, activityLog, activeJobs] = await Promise.all([
        listEpisodes(c.env.TLDL_DATA, { page, pageSize }),
        getPodcastList(c.env.TLDL_DATA),
        getActivityLog(c.env.TLDL_DATA, 8),
        listActiveJobsWithDO(c.env, c.env.TLDL_DATA),
    ]);

    const episodes = result.episodes;
    const totalPages = result.totalPages;

    // Compute stats
    const totalEpisodes = result.total;
    const totalPodcasts = podcasts.length;
    const monitoredPodcasts = await listMonitoredPodcasts(c.env.TLDL_DATA);
    const errorCount = monitoredPodcasts.filter(p => p.status === "error").length;
    const lastChecked = monitoredPodcasts.reduce((latest, p) => {
        if (!p.lastChecked) return latest;
        return !latest || p.lastChecked > latest ? p.lastChecked : latest;
    }, "" as string);

    // Build episode cards with admin controls
    const episodeCards = await Promise.all(
        episodes.map(async (episode) => {
            const summaries = await listSummariesForEpisode(c.env.TLDL_DATA, episode.id);
            const templateBadges = summaries
                .map((s) => `<span class="badge">${escapeHtml(s.templateId)}</span>`)
                .join("");

            return `
                <div class="episode-card" data-episode-id="${escapeHtml(episode.id)}">
                    <div class="episode-card-content">
                        <div class="episode-podcast">${escapeHtml(episode.podcastName)}</div>
                        <h3 class="episode-title">
                            <a href="/episode/${escapeHtml(episode.id)}">${escapeHtml(episode.episodeTitle)}</a>
                        </h3>
                        <div class="episode-meta">
                            <span>${formatDate(episode.episodeDate)}</span>
                            <span class="meta-dot">•</span>
                            <span>${formatDuration(episode.episodeDuration)}</span>
                        </div>
                        ${templateBadges ? `<div class="episode-badges">${templateBadges}</div>` : ""}
                        <div class="tag-editor" data-episode-id="${escapeHtml(episode.id)}">
                            <div style="display: flex; justify-content: space-between; align-items: center;">
                                <label class="form-label" style="margin: 0;">Tags:</label>
                                <button type="button" class="button button-sm" onclick="saveTagsFor('${escapeHtml(episode.id)}')">
                                    Save Tags
                                </button>
                            </div>
                            <div class="tag-editor-tags">
                                ${getValidTags().map(tag => {
                const isSelected = episode.tags?.includes(tag);
                return `<button
                                        type="button"
                                        class="tag-editor-badge ${isSelected ? 'selected' : ''}"
                                        data-tag="${escapeHtml(tag)}"
                                        onclick="toggleTag(this, '${escapeHtml(episode.id)}')"
                                    >
                                        ${escapeHtml(tag)}
                                    </button>`;
            }).join('')}
                            </div>
                            <div class="tag-editor-message" id="tag-message-${escapeHtml(episode.id)}" style="display: none;"></div>
                        </div>
                    </div>
                    <button type="button" class="button button-destructive button-sm" onclick="confirmDelete('${escapeHtml(episode.id)}', '${escapeHtml(episode.episodeTitle.replace(/'/g, "\\'"))}')">
                        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>
                        </svg>
                        Delete
                    </button>
                    <button type="button" class="button button-secondary button-sm" onclick="openSummaryEditor('${escapeHtml(episode.id)}', '${escapeHtml(episode.episodeTitle.replace(/'/g, "\\\\'"))}')">
                        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/>
                            <path d="m15 5 4 4"/>
                        </svg>
                        Edit Summaries
                    </button>
                </div>
            `;
        })
    );

    // Pagination controls
    const paginationHtml = totalPages > 1 ? `
        <nav class="pagination" aria-label="Episode pagination">
            ${page > 1 ? `
            <a href="/admin?page=${page - 1}" class="pagination-link pagination-prev">
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
            <a href="/admin?page=${page + 1}" class="pagination-link pagination-next">
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

    // Build activity log HTML
    const activityHtml = activityLog.length > 0
        ? activityLog.map(event => {
            const icon = event.type === "episode_completed"
                ? `<span class="activity-icon activity-icon-success">✓</span>`
                : event.type === "episode_failed"
                    ? `<span class="activity-icon activity-icon-error">✗</span>`
                    : event.type === "monitor_error"
                        ? `<span class="activity-icon activity-icon-error">!</span>`
                        : `<span class="activity-icon activity-icon-info">↻</span>`;

            const detailsHtml = event.details
                ? `<span class="activity-details">${escapeHtml(event.details)}</span>`
                : "";

            return `<div class="activity-item">
                ${icon}
                <div class="activity-content">
                    <span class="activity-title">${escapeHtml(event.title)}</span>
                    ${detailsHtml}
                </div>
                <span class="activity-time">${formatRelativeTime(event.timestamp)}</span>
            </div>`;
        }).join("")
        : `<p class="text-muted">No recent activity.</p>`;

    // Active jobs section
    const activeJobsHtml = activeJobs.length > 0
        ? `<div class="activity-item">
            <span class="activity-icon activity-icon-info">
                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="spinner">
                    <path d="M21 12a9 9 0 1 1-6.219-8.56"/>
                </svg>
            </span>
            <div class="activity-content">
                <span class="activity-title">${activeJobs.length} active job${activeJobs.length !== 1 ? "s" : ""}</span>
            </div>
        </div>`
        : "";

    const content = `
        <div class="page-header">
            <h1>Admin Dashboard</h1>
            <p class="page-subtitle">${escapeHtml(userEmail)} <span class="badge">Admin</span></p>
        </div>

        <div class="admin-stats-grid">
            <div class="admin-stat-card">
                <span class="admin-stat-number">${totalEpisodes}</span>
                <span class="admin-stat-label">Episodes</span>
            </div>
            <div class="admin-stat-card">
                <span class="admin-stat-number">${totalPodcasts}</span>
                <span class="admin-stat-label">Podcasts</span>
            </div>
            <div class="admin-stat-card ${errorCount > 0 ? "admin-stat-error" : ""}">
                <span class="admin-stat-number">${errorCount}</span>
                <span class="admin-stat-label">Errors</span>
            </div>
            <div class="admin-stat-card">
                <span class="admin-stat-number">${lastChecked ? formatRelativeTime(lastChecked) : "—"}</span>
                <span class="admin-stat-label">Last check</span>
            </div>
        </div>

        <div class="admin-quick-actions">
            <a href="/admin/submit" class="button button-primary">Submit Episode</a>
            <a href="/admin/podcasts" class="button">Manage Podcasts</a>
            <button type="button" class="button" onclick="checkAllNow()">Check All Now</button>
            <a href="https://elezea.cloudflareaccess.com/cdn-cgi/access/logout?returnTo=https%3A%2F%2Ftldl-pod.com%2F" class="button" style="margin-left: auto;">Log Out</a>
        </div>
        <div id="check-all-status" class="alert" style="display: none; margin-bottom: 1rem;"></div>

        <section class="card admin-activity-section">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 1rem;">
                <h2 style="margin: 0;">Recent Activity</h2>
                <a href="/admin/activity" class="text-muted" style="font-size: 0.875rem;">View all →</a>
            </div>
            ${activeJobsHtml}
            ${activityHtml}
        </section>

        <section class="section">
            <h2>All Episodes</h2>
            ${episodes.length > 0 ? `
                <div class="episode-list">
                    ${episodeCards.join("")}
                </div>
                ${paginationHtml}
            ` : `
                <div class="empty-state">
                    <p>No episodes yet.</p>
                    <a href="/admin/submit" class="button button-primary">Submit Your First Episode</a>
                </div>
            `}
        </section>

        <div class="divider"></div>
        <section class="section">
            <h2>Admin Tools</h2>
            <div class="admin-tools">
                <div class="admin-tool-item">
                    <p class="text-muted">Automatically monitor podcasts for new episodes</p>
                    <a href="/admin/podcasts" class="button">
                        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>
                            <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
                            <line x1="12" x2="12" y1="19" y2="23"/>
                            <line x1="8" x2="16" y1="23" y2="23"/>
                        </svg>
                        Monitor Podcasts
                    </a>
                </div>
                <div class="admin-tool-item" style="margin-top: 1.5rem;">
                    <p class="text-muted">Rebuild the episode index (use after database changes or if home page is empty)</p>
                    <button type="button" class="button" id="rebuild-index-btn" onclick="rebuildIndex()">
                        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/>
                            <path d="M3 3v5h5"/>
                            <path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"/>
                            <path d="M16 21h5v-5"/>
                        </svg>
                        Rebuild Episode Index
                    </button>
                    <div id="rebuild-result" class="alert alert-success" style="display: none; margin-top: 1rem;"></div>
                </div>
                <div class="admin-tool-item" style="margin-top: 1.5rem;">
                    <p class="text-muted">Remove all failed jobs from the home page (use to clean up orphaned jobs)</p>
                    <button type="button" class="button" id="cleanup-jobs-btn" onclick="cleanupFailedJobs()">
                        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>
                        </svg>
                        Clean Up Failed Jobs
                    </button>
                    <div id="cleanup-result" class="alert alert-success" style="display: none; margin-top: 1rem;"></div>
                </div>
                <div class="admin-tool-item" style="margin-top: 1.5rem;">
                    <p class="text-muted">Generate tags for all episodes without tags using existing transcripts and summaries</p>
                    <button type="button" class="button" id="backfill-tags-btn" onclick="backfillTags()">
                        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <path d="M4 7V4h16v3M9 20h6M12 4v16"/>
                        </svg>
                        Backfill Tags for All Episodes
                    </button>
                    <div id="backfill-status" style="display: none; margin-top: 1rem;"></div>
                </div>
                <div class="admin-tool-item" style="margin-top: 1.5rem;">
                    <p class="text-muted">Remove tags that are no longer in the predefined tag list (cleanup after removing tags from constants)</p>
                    <button type="button" class="button" id="cleanup-tags-btn" onclick="cleanupInvalidTags()">
                        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/>
                        </svg>
                        Cleanup Invalid Tags
                    </button>
                    <div id="cleanup-tags-status" style="display: none; margin-top: 1rem;"></div>
                </div>
                <div class="admin-tool-item" style="margin-top: 1.5rem;">
                    <p class="text-muted">Fetch podcast author and website info from Podcast Index API for all episodes</p>
                    <button type="button" class="button" id="backfill-podcast-info-btn" onclick="backfillPodcastInfo()">
                        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <circle cx="12" cy="12" r="10"/><path d="M2 12h20"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>
                        </svg>
                        Backfill Podcast Info
                    </button>
                    <div id="backfill-podcast-info-status" style="display: none; margin-top: 1rem;"></div>
                </div>
            </div>
        </section>

        <div id="delete-modal" class="modal" style="display: none;">
            <div class="modal-backdrop" onclick="hideDeleteModal()"></div>
            <div class="modal-content">
                <h3>Delete Episode?</h3>
                <p id="delete-modal-message">This will permanently delete this episode, its transcript, and all summaries.</p>
                <div class="modal-actions">
                    <button type="button" class="button" onclick="hideDeleteModal()">Cancel</button>
                    <button type="button" class="button button-destructive" id="confirm-delete-btn">Delete</button>
                </div>
            </div>
        </div>

        <div id="summary-edit-modal" class="modal" style="display: none;">
            <div class="modal-backdrop" onclick="hideSummaryEditModal()"></div>
            <div class="modal-content modal-content-large">
                <h3 id="summary-modal-title">Edit Summaries</h3>
                <div id="summary-edit-content">
                    <p class="text-muted">Loading summaries...</p>
                </div>
                <div id="summary-edit-status" style="display: none; margin-top: 1rem;"></div>
                <div class="modal-actions">
                    <button type="button" class="button" onclick="hideSummaryEditModal()">Close</button>
                </div>
            </div>
        </div>

<script>
let deleteEpisodeId = null;
let currentSummaryEpisodeId = null;

function confirmDelete(episodeId, episodeTitle) {
    deleteEpisodeId = episodeId;
    document.getElementById('delete-modal-message').textContent =
        'Delete "' + episodeTitle + '"? This will permanently delete the episode, its transcript, and all summaries.';
    document.getElementById('delete-modal').style.display = 'flex';
    document.getElementById('confirm-delete-btn').onclick = doDelete;
}

function hideDeleteModal() {
    document.getElementById('delete-modal').style.display = 'none';
    deleteEpisodeId = null;
}

async function openSummaryEditor(episodeId, episodeTitle) {
    currentSummaryEpisodeId = episodeId;
    document.getElementById('summary-modal-title').textContent = 'Edit Summaries: ' + episodeTitle;
    document.getElementById('summary-edit-content').innerHTML = '<p class="text-muted">Loading summaries...</p>';
    document.getElementById('summary-edit-status').style.display = 'none';
    document.getElementById('summary-edit-modal').style.display = 'flex';

    try {
        const response = await fetch('/admin/episodes/' + episodeId + '/summaries', {
            credentials: 'include'
        });
        const data = await response.json();

        if (!response.ok) {
            document.getElementById('summary-edit-content').innerHTML = '<p class="text-muted">Error: ' + (data.error || 'Failed to load summaries') + '</p>';
            return;
        }

        if (data.summaries.length === 0) {
            document.getElementById('summary-edit-content').innerHTML = '<p class="text-muted">No summaries found for this episode.</p>';
            return;
        }

        let html = '';
        for (const summary of data.summaries) {
            html += '<div class="summary-edit-item" data-template-id="' + summary.templateId + '">';
            html += '<label class="form-label">' + summary.templateName + '</label>';
            html += '<textarea class="summary-textarea" id="summary-text-' + summary.templateId + '" rows="12">' + escapeHtmlForTextarea(summary.text) + '</textarea>';
            html += '<div style="display: flex; justify-content: space-between; align-items: center; margin-top: 0.5rem;">';
            html += '<span class="text-muted" style="font-size: 0.75rem;">Model: ' + summary.model + '</span>';
            html += '<button type="button" class="button button-sm" onclick="saveSummary(\\'' + summary.templateId + '\\')">Save ' + summary.templateName + '</button>';
            html += '</div>';
            html += '<div class="summary-save-status" id="summary-status-' + summary.templateId + '" style="display: none; margin-top: 0.5rem;"></div>';
            html += '</div>';
        }
        document.getElementById('summary-edit-content').innerHTML = html;
    } catch (err) {
        document.getElementById('summary-edit-content').innerHTML = '<p class="text-muted">Failed to load summaries</p>';
    }
}

function escapeHtmlForTextarea(text) {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function hideSummaryEditModal() {
    document.getElementById('summary-edit-modal').style.display = 'none';
    currentSummaryEpisodeId = null;
}

async function saveSummary(templateId) {
    if (!currentSummaryEpisodeId) return;

    const textarea = document.getElementById('summary-text-' + templateId);
    const statusEl = document.getElementById('summary-status-' + templateId);
    const text = textarea.value;

    statusEl.className = 'alert alert-info';
    statusEl.textContent = 'Saving...';
    statusEl.style.display = 'block';

    try {
        const response = await fetch('/admin/episodes/' + currentSummaryEpisodeId + '/summaries/' + templateId, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ text })
        });

        const data = await response.json();

        if (response.ok) {
            statusEl.className = 'alert alert-success';
            statusEl.textContent = 'Saved successfully!';
            setTimeout(() => { statusEl.style.display = 'none'; }, 3000);
        } else {
            statusEl.className = 'alert alert-error';
            statusEl.textContent = 'Error: ' + (data.error || 'Failed to save');
        }
    } catch (err) {
        statusEl.className = 'alert alert-error';
        statusEl.textContent = 'Failed to save summary';
    }
}

async function doDelete() {
    if (!deleteEpisodeId) return;
    try {
        const response = await fetch('/admin/episodes/' + deleteEpisodeId + '/delete', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include'
        });
        if (response.ok) {
            const card = document.querySelector('[data-episode-id="' + deleteEpisodeId + '"]');
            if (card) card.remove();
            hideDeleteModal();
        } else {
            const data = await response.json();
            alert('Failed to delete: ' + (data.error || 'Unknown error'));
        }
    } catch (err) {
        alert('Failed to delete episode');
    }
}

function toggleTag(button, episodeId) {
    button.classList.toggle('selected');
}

async function saveTagsFor(episodeId) {
    const editor = document.querySelector('[data-episode-id="' + episodeId + '"] .tag-editor');
    const selectedButtons = editor.querySelectorAll('.tag-editor-badge.selected');
    const tags = Array.from(selectedButtons).map(btn => btn.getAttribute('data-tag'));
    const messageEl = document.getElementById('tag-message-' + episodeId);

    if (tags.length < 1 || tags.length > 4) {
        messageEl.className = 'tag-editor-message alert-error';
        messageEl.textContent = 'Please select 1-4 tags (currently ' + tags.length + ' selected)';
        messageEl.style.display = 'block';
        return;
    }

    try {
        const response = await fetch('/admin/episodes/' + episodeId + '/tags', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ tags }),
        });

        const data = await response.json();

        if (response.ok) {
            messageEl.className = 'tag-editor-message alert-success';
            messageEl.textContent = 'Tags updated successfully!';
            messageEl.style.display = 'block';
            setTimeout(() => {
                messageEl.style.display = 'none';
            }, 3000);
        } else {
            messageEl.className = 'tag-editor-message alert-error';
            messageEl.textContent = data.error || 'Failed to update tags';
            messageEl.style.display = 'block';
        }
    } catch (err) {
        messageEl.className = 'tag-editor-message alert-error';
        messageEl.textContent = 'Failed to save tags';
        messageEl.style.display = 'block';
    }
}

async function rebuildIndex() {
    const btn = document.getElementById('rebuild-index-btn');
    const result = document.getElementById('rebuild-result');
    btn.disabled = true;
    btn.textContent = 'Rebuilding...';
    result.style.display = 'none';

    try {
        const response = await fetch('/admin/rebuild-index', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include'
        });
        const data = await response.json();
        if (response.ok) {
            result.className = 'alert alert-success';
            result.textContent = 'Index rebuilt successfully! ' + data.episodeCount + ' episodes indexed.';
        } else {
            result.className = 'alert alert-error';
            result.textContent = 'Failed: ' + (data.error || 'Unknown error');
        }
    } catch (err) {
        result.className = 'alert alert-error';
        result.textContent = 'Failed to rebuild index';
    }

    result.style.display = 'block';
    btn.disabled = false;
    btn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"/><path d="M16 21h5v-5"/></svg> Rebuild Episode Index';
}

async function cleanupFailedJobs() {
    const btn = document.getElementById('cleanup-jobs-btn');
    const result = document.getElementById('cleanup-result');
    btn.disabled = true;
    btn.textContent = 'Cleaning up...';
    result.style.display = 'none';

    try {
        const response = await fetch('/admin/cleanup-jobs', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include'
        });
        const data = await response.json();
        if (response.ok) {
            result.className = 'alert alert-success';
            result.textContent = 'Cleanup successful! ' + data.deletedCount + ' failed job' + (data.deletedCount !== 1 ? 's' : '') + ' removed.';
        } else {
            result.className = 'alert alert-error';
            result.textContent = 'Failed: ' + (data.error || 'Unknown error');
        }
    } catch (err) {
        result.className = 'alert alert-error';
        result.textContent = 'Failed to clean up jobs';
    }

    result.style.display = 'block';
    btn.disabled = false;
    btn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg> Clean Up Failed Jobs';
}

async function backfillTags() {
    if (!confirm('Generate tags for all episodes without tags? This may take a few minutes and will use OpenAI API credits.')) {
        return;
    }

    const button = document.getElementById('backfill-tags-btn');
    const statusEl = document.getElementById('backfill-status');

    button.disabled = true;
    button.textContent = 'Processing...';
    statusEl.style.display = 'block';
    statusEl.className = 'alert alert-info';
    statusEl.textContent = 'Generating tags for episodes...';

    try {
        const response = await fetch('/admin/backfill-tags', {
            method: 'POST',
            credentials: 'include',
        });

        const data = await response.json();

        if (response.ok) {
            statusEl.className = 'alert alert-success';
            statusEl.textContent = 'Success! ' + data.message;
            setTimeout(() => { window.location.reload(); }, 2000);
        } else {
            statusEl.className = 'alert alert-error';
            statusEl.textContent = 'Error: ' + (data.error || 'Unknown error');
            button.disabled = false;
            button.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7V4h16v3M9 20h6M12 4v16"/></svg> Backfill Tags for All Episodes';
        }
    } catch (err) {
        statusEl.className = 'alert alert-error';
        statusEl.textContent = 'Failed to backfill tags';
        button.disabled = false;
        button.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7V4h16v3M9 20h6M12 4v16"/></svg> Backfill Tags for All Episodes';
    }
}

async function cleanupInvalidTags() {
    if (!confirm('Remove invalid tags from all episodes? This will remove any tags that are no longer in the predefined tag list.')) {
        return;
    }

    const button = document.getElementById('cleanup-tags-btn');
    const statusEl = document.getElementById('cleanup-tags-status');

    button.disabled = true;
    button.textContent = 'Processing...';
    statusEl.style.display = 'block';
    statusEl.className = 'alert alert-info';
    statusEl.textContent = 'Cleaning up invalid tags...';

    try {
        const response = await fetch('/admin/cleanup-tags', {
            method: 'POST',
            credentials: 'include',
        });

        const data = await response.json();

        if (response.ok) {
            statusEl.className = 'alert alert-success';
            statusEl.textContent = 'Success! ' + data.message;
            setTimeout(() => { window.location.reload(); }, 2000);
        } else {
            statusEl.className = 'alert alert-error';
            statusEl.textContent = 'Error: ' + (data.error || 'Unknown error');
            button.disabled = false;
            button.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/></svg> Cleanup Invalid Tags';
        }
    } catch (err) {
        statusEl.className = 'alert alert-error';
        statusEl.textContent = 'Failed to cleanup tags';
        button.disabled = false;
        button.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/></svg> Cleanup Invalid Tags';
    }
}

async function backfillPodcastInfo() {
    if (!confirm('Fetch podcast author and website info from Podcast Index API for all episodes? This may take a while for many episodes.')) {
        return;
    }

    const button = document.getElementById('backfill-podcast-info-btn');
    const statusEl = document.getElementById('backfill-podcast-info-status');

    button.disabled = true;
    button.textContent = 'Fetching...';
    statusEl.style.display = 'block';
    statusEl.className = 'alert alert-info';
    statusEl.textContent = 'Fetching podcast info from Podcast Index API...';

    try {
        const response = await fetch('/admin/backfill-podcast-info', {
            method: 'POST',
            credentials: 'include',
        });

        const data = await response.json();

        if (response.ok) {
            statusEl.className = 'alert alert-success';
            statusEl.textContent = 'Success! ' + data.message;
            button.disabled = false;
            button.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M2 12h20"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg> Backfill Podcast Info';
        } else {
            statusEl.className = 'alert alert-error';
            statusEl.textContent = 'Error: ' + (data.error || 'Unknown error');
            button.disabled = false;
            button.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M2 12h20"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg> Backfill Podcast Info';
        }
    } catch (err) {
        statusEl.className = 'alert alert-error';
        statusEl.textContent = 'Failed to backfill podcast info';
        button.disabled = false;
        button.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M2 12h20"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg> Backfill Podcast Info';
    }
}

async function checkAllNow() {
    var status = document.getElementById('check-all-status');
    status.className = 'alert alert-info';
    status.textContent = 'Checking all podcasts...';
    status.style.display = 'block';

    try {
        var response = await fetch('/admin/podcasts/check-now', {
            method: 'POST',
            credentials: 'include',
        });
        var data = await response.json();
        if (response.ok) {
            status.className = 'alert alert-success';
            status.textContent = 'Checked ' + data.checked + ' podcasts. ' + data.totalNewEpisodes + ' new episode(s) queued.';
            if (data.totalNewEpisodes > 0) {
                setTimeout(function() { window.location.reload(); }, 2000);
            }
        } else {
            status.className = 'alert alert-error';
            status.textContent = data.error || 'Failed to check podcasts';
        }
    } catch (err) {
        status.className = 'alert alert-error';
        status.textContent = 'Failed to check podcasts';
    }
}
</script>
    `;

    return c.html(Layout({
        title: "Admin Dashboard",
        children: content
    }));
});

// ============================================================================
// GET /activity - Full activity log
// ============================================================================

admin.get("/activity", async (c) => {
    const authError = await requireAdmin(c);
    if (authError) return authError;

    const activityLog = await getActivityLog(c.env.TLDL_DATA);

    const activityHtml = activityLog.length > 0
        ? activityLog.map(event => {
            const icon = event.type === "episode_completed"
                ? `<span class="activity-icon activity-icon-success">✓</span>`
                : event.type === "episode_failed"
                    ? `<span class="activity-icon activity-icon-error">✗</span>`
                    : event.type === "monitor_error"
                        ? `<span class="activity-icon activity-icon-error">!</span>`
                        : `<span class="activity-icon activity-icon-info">↻</span>`;

            const detailsHtml = event.details
                ? `<span class="activity-details">${escapeHtml(event.details)}</span>`
                : "";

            return `<div class="activity-item">
                ${icon}
                <div class="activity-content">
                    <span class="activity-title">${escapeHtml(event.title)}</span>
                    ${detailsHtml}
                </div>
                <span class="activity-time">${formatRelativeTime(event.timestamp)}</span>
            </div>`;
        }).join("")
        : `<p class="text-muted">No activity recorded yet.</p>`;

    const content = `
        <div class="page-header">
            <h1>Activity Log</h1>
            <p class="page-subtitle"><a href="/admin">← Back to dashboard</a></p>
        </div>

        <section class="card admin-activity-section">
            <p class="text-muted" style="margin-top: 0; margin-bottom: 1rem;">Last ${activityLog.length} event${activityLog.length !== 1 ? "s" : ""} (30-day rolling window)</p>
            ${activityHtml}
        </section>
    `;

    return c.html(Layout({
        title: "Activity Log",
        children: content
    }));
});

// ============================================================================
// GET /submit - Admin submit form page
// ============================================================================

admin.get("/submit", async (c) => {
    const authError = await requireAdmin(c);
    if (authError) return authError;

    const defaultTemplate = c.env.DEFAULT_TEMPLATE || "key-takeaways";

    const templateOptions = Object.values(TEMPLATES).map(t =>
        `<div class="radio-option">
            <input type="radio" id="template-${escapeHtml(t.id)}" name="templateId" value="${escapeHtml(t.id)}"
                ${t.id === defaultTemplate ? 'checked' : ''} />
            <label for="template-${escapeHtml(t.id)}">
                <strong>${escapeHtml(t.name)}</strong>
                <span class="radio-description">${escapeHtml(t.description)}</span>
            </label>
        </div>`
    ).join("");

    const content = `
        <div class="page-header">
            <h1>Submit Episode</h1>
            <p class="page-subtitle">Paste an Apple Podcasts episode URL or YouTube video URL to generate a summary.</p>
            <a href="/admin" class="button button-secondary">← Back to Dashboard</a>
        </div>

        <div class="divider"></div>

        <form method="POST" action="/admin/submit" class="card">
            <div class="form-group">
                <label class="form-label" for="appleUrl">Episode URL</label>
                <input type="url" id="appleUrl" name="appleUrl" class="form-input"
                    placeholder="Apple Podcasts or YouTube URL" required />
                <p class="form-help">Paste the full URL of an Apple Podcasts episode or a YouTube video</p>
            </div>

            <div class="form-group">
                <label class="form-label">Summary Style</label>
                <div class="radio-group">
                    ${templateOptions}
                </div>
            </div>

            <button type="submit" class="button button-primary">Submit Episode</button>
        </form>
    `;

    return c.html(Layout({
        title: "Submit Episode",
        children: content,
    }));
});

// ============================================================================
// POST /submit - Process episode submission
// ============================================================================

admin.post("/submit", async (c) => {
    const authError = await requireAdmin(c);
    if (authError) return authError;

    // Handle both form and JSON submissions
    const contentType = c.req.header("Content-Type") || "";
    let url: string;
    let templateId: string;

    if (contentType.includes("application/json")) {
        const body = await c.req.json<{ appleUrl: string; templateId: string }>();
        url = body.appleUrl;
        templateId = body.templateId;
    } else {
        const formData = await c.req.parseBody();
        url = formData.appleUrl as string;
        templateId = formData.templateId as string;
    }

    // Validate URL
    if (!url) {
        return c.html(Layout({
            title: "Error",
            children: `<div class="alert alert-error">Please enter an Apple Podcasts URL.</div><a href="/admin/submit" class="button">Try Again</a>`,
        }));
    }

    const urlType = detectUrlType(url);
    if (urlType === "unknown") {
        return c.html(Layout({
            title: "Error",
            children: `<div class="alert alert-error">Invalid Apple Podcasts episode URL. Please enter an Apple Podcasts episode URL or a YouTube video URL.</div><a href="/admin/submit" class="button">Try Again</a>`,
        }));
    }

    let episodeId: string;
    let videoId: string | undefined;

    if (urlType === "apple") {
        const parsed = parseApplePodcastsUrl(url)!;

        // Check blocked podcasts (creator opt-outs)
        if (isBlockedPodcast(url)) {
            return c.html(Layout({
                title: "Error",
                children: `<div class="alert alert-error">This podcast has opted out of TLDL.</div><a href="/admin/submit" class="button">Try Again</a>`,
            }));
        }

        episodeId = deriveEpisodeId(parsed.podcastId, parsed.episodeId);
    } else {
        // youtube
        const parsed = parseYouTubeUrl(url)!;
        videoId = parsed.videoId;
        episodeId = `yt_${parsed.videoId}`;
    }

    // Validate template
    const effectiveTemplateId = templateId || c.env.DEFAULT_TEMPLATE;
    if (!isValidTemplateId(effectiveTemplateId)) {
        return c.html(Layout({
            title: "Error",
            children: `<div class="alert alert-error">Invalid summary template.</div><a href="/admin/submit" class="button">Try Again</a>`,
        }));
    }

    // Check cache
    const existingEpisode = await getEpisode(c.env.TLDL_DATA, episodeId);
    if (existingEpisode) {
        const existingSummary = await getSummary(c.env.TLDL_DATA, episodeId, effectiveTemplateId);
        if (existingSummary) {
            // Redirect to existing episode
            return c.redirect(`/episode/${episodeId}`);
        }
    }

    // Pre-fetch episode info (Apple only)
    let episodeInfo: Awaited<ReturnType<typeof prefetchEpisodeInfo>> = null;
    if (urlType === "apple") {
        const appleParsed = parseApplePodcastsUrl(url)!;
        episodeInfo = await prefetchEpisodeInfo(appleParsed.podcastId, appleParsed.episodeId, c.env, url);

        console.log(JSON.stringify({
            event: "admin_submit_prefetch_complete",
            podcastId: appleParsed.podcastId,
            episodeId: appleParsed.episodeId,
            episodeInfoFound: !!episodeInfo,
            episodeGuid: episodeInfo?.episodeGuid,
        }));
    }

    // Create job
    const jobId = generateUUID();
    const now = new Date().toISOString();

    const job: Job = {
        id: jobId,
        episodeId,
        sourceUrl: url,
        sourceType: urlType as "apple" | "youtube",
        status: "queued",
        templateId: effectiveTemplateId,
        createdAt: now,
        updatedAt: now,
    };

    await createJobDO(c.env, job);
    await createJob(c.env.TLDL_DATA, job);

    const message = createProcessEpisodeMessage({
        jobId,
        episodeId,
        sourceUrl: url,
        sourceType: urlType as "apple" | "youtube",
        videoId,
        templateId: effectiveTemplateId,
        episodeGuid: episodeInfo?.episodeGuid,
        expectedTitle: episodeInfo?.trackName,
        expectedDate: episodeInfo?.releaseDate,
    });
    await enqueueJob(c.env.TLDL_QUEUE, message);

    // Redirect to admin dashboard (job shows as in-progress on home page)
    return c.redirect("/admin");
});

// ============================================================================
// POST /episodes/:episodeId/delete - Delete episode
// ============================================================================

admin.post("/episodes/:episodeId/delete", async (c) => {
    const authError = await requireAdmin(c);
    if (authError) return authError;

    const episodeId = c.req.param("episodeId");

    const episode = await getEpisode(c.env.TLDL_DATA, episodeId);
    if (!episode) {
        return c.json({ error: "Episode not found" }, 404);
    }

    await deleteEpisode(c.env.TLDL_DATA, episodeId);
    return c.json({ deleted: true });
});

// ============================================================================
// POST /episodes/:episodeId/tags - Update episode tags
// ============================================================================

admin.post("/episodes/:episodeId/tags", async (c) => {
    const authError = await requireAdmin(c);
    if (authError) return authError;

    const episodeId = c.req.param("episodeId");

    let body: { tags: string[] };
    try {
        body = await c.req.json();
    } catch {
        return c.json({ error: "Invalid JSON body" }, 400);
    }

    if (!Array.isArray(body.tags)) {
        return c.json({ error: "tags must be an array" }, 400);
    }

    const validation = validateTags(body.tags);
    if (validation.invalid.length > 0) {
        return c.json({
            error: `Invalid tags: ${validation.invalid.join(', ')}`,
            validTags: getValidTags(),
        }, 400);
    }

    if (validation.valid.length < 1 || validation.valid.length > 4) {
        return c.json({
            error: "Must provide between 1 and 4 tags",
            provided: validation.valid.length,
        }, 400);
    }

    const episode = await getEpisode(c.env.TLDL_DATA, episodeId);
    if (!episode) {
        return c.json({ error: "Episode not found" }, 404);
    }

    try {
        await updateEpisodeTags(c.env.TLDL_DATA, episodeId, validation.valid);
        return c.json({ success: true, tags: validation.valid });
    } catch (error) {
        return c.json({
            error: error instanceof Error ? error.message : "Failed to update tags",
        }, 500);
    }
});

// ============================================================================
// GET /episodes/:episodeId/summaries - Get all summaries for episode
// ============================================================================

admin.get("/episodes/:episodeId/summaries", async (c) => {
    const authError = await requireAdmin(c);
    if (authError) return authError;

    const episodeId = c.req.param("episodeId");

    const episode = await getEpisode(c.env.TLDL_DATA, episodeId);
    if (!episode) {
        return c.json({ error: "Episode not found" }, 404);
    }

    const summaries = await listSummariesForEpisode(c.env.TLDL_DATA, episodeId);

    return c.json({
        episodeId,
        episodeTitle: episode.episodeTitle,
        summaries: summaries.map(s => ({
            templateId: s.templateId,
            templateName: TEMPLATES[s.templateId]?.name || s.templateId,
            text: s.text,
            model: s.model,
            createdAt: s.createdAt,
        })),
    });
});

// ============================================================================
// POST /episodes/:episodeId/summaries/:templateId - Update a summary
// ============================================================================

admin.post("/episodes/:episodeId/summaries/:templateId", async (c) => {
    const authError = await requireAdmin(c);
    if (authError) return authError;

    const episodeId = c.req.param("episodeId");
    const templateId = c.req.param("templateId");
    const userEmail = c.get("userEmail");

    if (!isValidTemplateId(templateId)) {
        return c.json({ error: `Invalid template ID: ${templateId}` }, 400);
    }

    const episode = await getEpisode(c.env.TLDL_DATA, episodeId);
    if (!episode) {
        return c.json({ error: "Episode not found" }, 404);
    }

    const existingSummary = await getSummary(c.env.TLDL_DATA, episodeId, templateId);
    if (!existingSummary) {
        return c.json({ error: "Summary not found for this template" }, 404);
    }

    let body: { text: string };
    try {
        body = await c.req.json();
    } catch {
        return c.json({ error: "Invalid JSON body" }, 400);
    }

    if (!body.text || typeof body.text !== "string") {
        return c.json({ error: "text field is required" }, 400);
    }

    await saveSummary(c.env.TLDL_DATA, {
        episodeId,
        templateId,
        text: body.text.trim(),
        model: existingSummary.model,
        createdAt: new Date().toISOString(),
    });

    console.log(JSON.stringify({
        event: "summary_updated",
        episodeId,
        templateId,
        updatedBy: userEmail,
    }));

    return c.json({ success: true, templateId });
});

// ============================================================================
// POST /episodes/:episodeId/regenerate - Regenerate summary with different template
// ============================================================================

admin.post("/episodes/:episodeId/regenerate", async (c) => {
    const authError = await requireAdmin(c);
    if (authError) return authError;

    const episodeId = c.req.param("episodeId");

    let body: { templateId: string };
    try {
        body = await c.req.json();
    } catch {
        return c.json({ error: "Invalid JSON body" }, 400);
    }

    const { templateId } = body;

    if (!templateId) {
        return c.json({ error: "Missing templateId field" }, 400);
    }
    if (!isValidTemplateId(templateId)) {
        return c.json({ error: `Invalid template ID: ${templateId}` }, 400);
    }

    const episode = await getEpisode(c.env.TLDL_DATA, episodeId);
    if (!episode) {
        return c.json({ error: "Episode not found" }, 404);
    }

    const transcript = await getTranscript(c.env.TLDL_DATA, episodeId);
    if (!transcript) {
        return c.json({ error: "Transcript not found. Cannot regenerate summary." }, 400);
    }

    // Check if summary already exists
    const existingSummary = await getSummary(c.env.TLDL_DATA, episodeId, templateId);
    if (existingSummary) {
        return c.json({ jobId: "", status: "completed", cached: true });
    }

    // Create regeneration job
    const jobId = generateUUID();
    const now = new Date().toISOString();

    const job: Job = {
        id: jobId,
        episodeId,
        sourceUrl: episode.sourceUrl,
        sourceType: episode.sourceType,
        status: "queued",
        templateId,
        createdAt: now,
        updatedAt: now,
    };

    await createJobDO(c.env, job);
    await createJob(c.env.TLDL_DATA, job);

    const message = createRegenerateSummaryMessage({
        jobId,
        episodeId,
        sourceUrl: episode.sourceUrl,
        sourceType: episode.sourceType,
        templateId,
    });
    await enqueueJob(c.env.TLDL_QUEUE, message);

    return c.json({ jobId, status: "queued", cached: false }, 201);
});

// ============================================================================
// DELETE /episodes/:episodeId - Delete episode (REST API)
// ============================================================================

admin.delete("/episodes/:episodeId", async (c) => {
    const authError = await requireAdmin(c);
    if (authError) return authError;

    const episodeId = c.req.param("episodeId");

    const episode = await getEpisode(c.env.TLDL_DATA, episodeId);
    if (!episode) {
        return c.json({ error: "Episode not found" }, 404);
    }

    await deleteEpisode(c.env.TLDL_DATA, episodeId);
    return c.json({ deleted: true });
});

// ============================================================================
// DELETE /jobs/:jobId - Delete a job (moved from unauthenticated api.ts)
// ============================================================================

admin.delete("/jobs/:jobId", async (c) => {
    const authError = await requireAdmin(c);
    if (authError) return authError;

    const jobId = c.req.param("jobId");

    const job = await getJobDO(c.env, jobId);

    console.log(JSON.stringify({
        event: "job_delete_request",
        jobId,
        exists: !!job,
        status: job?.status,
    }));

    await deleteJobDO(c.env, jobId);
    await deleteJob(c.env.TLDL_DATA, jobId);

    return c.json({
        success: true,
        message: `Job ${jobId} deleted`,
        previousStatus: job?.status || "not found",
    });
});

// ============================================================================
// Admin Tool API Routes
// ============================================================================

// POST /rebuild-index
admin.post("/rebuild-index", async (c) => {
    const authError = await requireAdmin(c);
    if (authError) return authError;

    try {
        const count = await rebuildEpisodeIndex(c.env.TLDL_DATA);
        return c.json({
            success: true,
            message: "Episode index rebuilt successfully",
            episodeCount: count,
        });
    } catch (error) {
        return c.json({
            success: false,
            error: error instanceof Error ? error.message : "Unknown error",
        }, 500);
    }
});

// POST /backfill-tags
admin.post("/backfill-tags", async (c) => {
    const authError = await requireAdmin(c);
    if (authError) return authError;

    try {
        const allEpisodes = await listEpisodes(c.env.TLDL_DATA, { pageSize: 1000 });
        const episodesNeedingTags = allEpisodes.episodes.filter(
            ep => !ep.tags || ep.tags.length === 0
        );

        let processed = 0;
        let tagged = 0;
        let failed = 0;

        for (const ep of episodesNeedingTags) {
            try {
                processed++;

                const [transcript, summary] = await Promise.all([
                    getTranscript(c.env.TLDL_DATA, ep.id),
                    getSummary(c.env.TLDL_DATA, ep.id, "key-takeaways"),
                ]);

                if (!transcript || !summary) {
                    console.log(`Skipping ${ep.id}: missing transcript or summary`);
                    failed++;
                    continue;
                }

                const tagResult = await generateEpisodeTags(
                    summary.text,
                    transcript.text,
                    c.env.OPENAI_API_KEY
                );

                if (tagResult.tags.length === 0) {
                    console.log(`Warning: No tags generated for ${ep.id}`);
                    failed++;
                    continue;
                }

                await updateEpisodeTags(c.env.TLDL_DATA, ep.id, tagResult.tags);
                tagged++;

                console.log(JSON.stringify({
                    event: "episode_tagged",
                    episodeId: ep.id,
                    tags: tagResult.tags,
                }));
            } catch (error) {
                console.error(JSON.stringify({
                    event: "backfill_failed",
                    episodeId: ep.id,
                    error: error instanceof Error ? error.message : "Unknown error",
                }));
                failed++;
            }
        }

        return c.json({
            success: true,
            message: `Processed ${processed} episodes: ${tagged} tagged, ${failed} failed`,
            processed,
            tagged,
            failed,
            totalEpisodes: allEpisodes.episodes.length,
        });
    } catch (error) {
        return c.json({
            error: error instanceof Error ? error.message : "Failed to backfill tags",
        }, 500);
    }
});

// POST /cleanup-tags
admin.post("/cleanup-tags", async (c) => {
    const authError = await requireAdmin(c);
    if (authError) return authError;

    try {
        const validTags = getValidTags();
        const allEpisodes = await listEpisodes(c.env.TLDL_DATA, { pageSize: 1000 });

        let processed = 0;
        let cleaned = 0;

        for (const ep of allEpisodes.episodes) {
            if (!ep.tags || ep.tags.length === 0) continue;
            processed++;

            const cleanedTags = ep.tags.filter(tag => validTags.includes(tag));

            if (cleanedTags.length !== ep.tags.length) {
                await updateEpisodeTags(c.env.TLDL_DATA, ep.id, cleanedTags);
                cleaned++;

                console.log(JSON.stringify({
                    event: "tags_cleaned",
                    episodeId: ep.id,
                    before: ep.tags,
                    after: cleanedTags,
                }));
            }
        }

        return c.json({
            success: true,
            message: `Processed ${processed} episodes with tags: ${cleaned} cleaned`,
            processed,
            cleaned,
            totalEpisodes: allEpisodes.episodes.length,
        });
    } catch (error) {
        return c.json({
            error: error instanceof Error ? error.message : "Failed to cleanup tags",
        }, 500);
    }
});

// POST /cleanup-jobs
admin.post("/cleanup-jobs", async (c) => {
    const authError = await requireAdmin(c);
    if (authError) return authError;

    try {
        const { listActiveJobsWithDO, deleteJobDO: deleteJobFromDO } = await import("../lib/job-status-do");

        const jobs = await listActiveJobsWithDO(c.env, c.env.TLDL_DATA);
        const failedJobs = jobs.filter(job => job.status === "failed");

        const deletedJobs = [];
        for (const job of failedJobs) {
            await deleteJobFromDO(c.env, job.id);
            await c.env.TLDL_DATA.delete(`job:${job.id}`);
            deletedJobs.push({
                id: job.id,
                podcastName: job.podcastName,
                episodeTitle: job.episodeTitle,
                error: job.error,
            });
        }

        return c.json({
            success: true,
            message: `Cleaned up ${deletedJobs.length} failed job${deletedJobs.length !== 1 ? 's' : ''}`,
            deletedCount: deletedJobs.length,
            deletedJobs,
        });
    } catch (error) {
        return c.json({
            success: false,
            error: error instanceof Error ? error.message : "Unknown error",
        }, 500);
    }
});

// POST /backfill-podcast-info
admin.post("/backfill-podcast-info", async (c) => {
    const authError = await requireAdmin(c);
    if (authError) return authError;

    try {
        const { lookupPodcastByItunesId } = await import("../services/podcast-index");
        const { parseApplePodcastsUrl: parseUrl } = await import("../lib/url-parser");
        const { getEpisode: getEp, saveEpisode } = await import("../lib/kv");

        const allEpisodes = await listEpisodes(c.env.TLDL_DATA, { pageSize: 1000 });

        let processed = 0;
        let updated = 0;
        let failed = 0;
        let alreadyHasInfo = 0;

        const podcastCache: Map<string, { author?: string; link?: string } | null> = new Map();

        for (const ep of allEpisodes.episodes) {
            processed++;

            try {
                const episode = await getEp(c.env.TLDL_DATA, ep.id);
                if (!episode) {
                    failed++;
                    continue;
                }

                const needsUrlCleaning = (url: string) => {
                    const lowerPath = new URL(url).pathname.toLowerCase();
                    return (
                        lowerPath.endsWith('.xml') ||
                        lowerPath.endsWith('.rss') ||
                        lowerPath.endsWith('/feed') ||
                        lowerPath.endsWith('/feed/') ||
                        lowerPath.includes('/rss') ||
                        lowerPath.includes('/feed')
                    );
                };

                const hasCleanWebsiteUrl = episode.podcastWebsiteUrl &&
                    !needsUrlCleaning(episode.podcastWebsiteUrl);
                if (episode.podcastAuthor && hasCleanWebsiteUrl) {
                    alreadyHasInfo++;
                    continue;
                }

                const parsedUrl = parseUrl(episode.sourceUrl);
                if (!parsedUrl) {
                    failed++;
                    continue;
                }

                let podcastInfo = podcastCache.get(parsedUrl.podcastId);
                if (podcastInfo === undefined) {
                    const podcast = await lookupPodcastByItunesId(
                        parsedUrl.podcastId,
                        c.env.PODCAST_INDEX_KEY,
                        c.env.PODCAST_INDEX_SECRET
                    );

                    podcastInfo = podcast ? { author: podcast.author, link: podcast.link } : null;
                    podcastCache.set(parsedUrl.podcastId, podcastInfo);
                }

                const cleanUrl = (url: string) => {
                    try {
                        const u = new URL(url);
                        const lowerPath = u.pathname.toLowerCase();
                        if (
                            lowerPath.endsWith('.xml') ||
                            lowerPath.endsWith('.rss') ||
                            lowerPath.endsWith('/feed') ||
                            lowerPath.endsWith('/feed/') ||
                            lowerPath.includes('/rss') ||
                            lowerPath.includes('/feed')
                        ) {
                            return u.origin;
                        }
                        return url;
                    } catch {
                        return url;
                    }
                };

                if (podcastInfo && (podcastInfo.author || podcastInfo.link)) {
                    episode.podcastAuthor = podcastInfo.author;
                    episode.podcastWebsiteUrl = podcastInfo.link ? cleanUrl(podcastInfo.link) : undefined;
                    await saveEpisode(c.env.TLDL_DATA, episode);
                    updated++;

                    console.log(JSON.stringify({
                        event: "podcast_info_backfilled",
                        episodeId: ep.id,
                        podcastAuthor: podcastInfo.author,
                        podcastWebsiteUrl: podcastInfo.link,
                    }));
                }
            } catch (error) {
                console.error(JSON.stringify({
                    event: "backfill_podcast_info_failed",
                    episodeId: ep.id,
                    error: error instanceof Error ? error.message : "Unknown error",
                }));
                failed++;
            }
        }

        return c.json({
            success: true,
            message: `Processed ${processed} episodes: ${updated} updated, ${alreadyHasInfo} already had info, ${failed} failed`,
            processed,
            updated,
            alreadyHasInfo,
            failed,
            totalEpisodes: allEpisodes.episodes.length,
        });
    } catch (error) {
        return c.json({
            error: error instanceof Error ? error.message : "Failed to backfill podcast info",
        }, 500);
    }
});

// ============================================================================
// Podcast Monitoring Routes
// ============================================================================

// GET /podcasts - Podcast monitoring admin page
admin.get("/podcasts", async (c) => {
    const authError = await requireAdmin(c);
    if (authError) return authError;

    const settings = await getMonitorSettings(c.env.TLDL_DATA);
    const podcasts = await listMonitoredPodcasts(c.env.TLDL_DATA);

    // Status summary
    const activeCount = podcasts.filter(p => p.status === "active").length;
    const errorCount = podcasts.filter(p => p.status === "error").length;
    const pausedCount = podcasts.filter(p => p.status === "paused").length;
    const lastCheckedGlobal = podcasts.reduce((latest, p) => {
        if (!p.lastChecked) return latest;
        return !latest || p.lastChecked > latest ? p.lastChecked : latest;
    }, "" as string);

    const statusSummaryHtml = `
        <div class="card" style="margin-bottom: 1rem;">
            <div style="display: flex; gap: 1.5rem; align-items: center; flex-wrap: wrap;">
                <span>Monitoring: <strong>${settings.enabled ? "● Active" : "○ Paused"}</strong></span>
                <span>${podcasts.length} podcast${podcasts.length !== 1 ? "s" : ""}</span>
                ${activeCount > 0 ? `<span class="status-badge status-active">${activeCount} active</span>` : ""}
                ${errorCount > 0 ? `<span class="status-badge status-error">${errorCount} error</span>` : ""}
                ${pausedCount > 0 ? `<span class="status-badge status-paused">${pausedCount} paused</span>` : ""}
                ${lastCheckedGlobal ? `<span>Last check: ${formatRelativeTime(lastCheckedGlobal)}</span>` : ""}
            </div>
        </div>
    `;

    const podcastCards = podcasts.length === 0
        ? `<div class="empty-state">No podcasts are being monitored yet.</div>`
        : podcasts.map(podcast => `
            <div class="card podcast-monitor-card" id="podcast-${escapeHtml(podcast.id)}">
                <div class="podcast-header">
                    <h3>${escapeHtml(podcast.name)}</h3>
                    <span class="status-badge status-${podcast.status}">${podcast.status}</span>
                </div>
                <div class="podcast-meta">
                    <span>Template: ${escapeHtml(podcast.templateId)}</span>
                    <span>Episodes: ${podcast.episodesProcessed}</span>
                    ${podcast.lastChecked ? `<span>Checked: ${formatRelativeTime(podcast.lastChecked)}</span>` : `<span>Never checked</span>`}
                    <a href="https://podcasts.apple.com/us/podcast/id${escapeHtml(podcast.id)}" target="_blank" rel="noopener" style="color: var(--muted-foreground);">Apple Podcasts ↗</a>
                </div>
                ${podcast.lastError ? `<div class="alert alert-error" style="margin-top: 0.5rem; font-size: 0.875rem;">${escapeHtml(podcast.lastError)}</div>` : ""}
                <div class="podcast-actions">
                    <button class="button" onclick="checkPodcast('${escapeHtml(podcast.id)}')">Check Now</button>
                    <button class="button button-danger" onclick="removePodcast('${escapeHtml(podcast.id)}')">Remove</button>
                </div>
            </div>
        `).join("");

    const content = `
        <section class="section">
            <div style="display: flex; justify-content: space-between; align-items: center;">
                <div>
                    <h1>Monitor Podcasts</h1>
                    <p>Automatically check podcasts for new episodes and queue them for processing.</p>
                </div>
                <a href="/admin" class="button button-secondary">← Dashboard</a>
            </div>
        </section>

        <section class="section">
            <div class="card">
                <h2 style="margin-top: 0;">Settings</h2>
                <form id="settings-form" style="display: flex; gap: 1rem; align-items: center; flex-wrap: wrap;">
                    <div class="form-group checkbox-group" style="margin: 0;">
                        <input type="checkbox" id="enabled" name="enabled" ${settings.enabled ? "checked" : ""} />
                        <label for="enabled">Auto-check (every 1h)</label>
                    </div>
                    <div style="display: flex; align-items: center; gap: 0.5rem;">
                        <label class="form-label" for="maxEpisodes" style="margin: 0; white-space: nowrap;">Max episodes/check:</label>
                        <input type="number" id="maxEpisodes" name="maxEpisodes" class="form-input" value="${settings.maxEpisodesPerCheck}" min="1" max="10" style="width: 60px; padding: 0.375rem 0.5rem;" />
                    </div>
                    <button type="submit" class="button button-primary">Save</button>
                    <button type="button" class="button" onclick="checkAllNow()">Check All Now</button>
                </form>
                <div id="settings-message" class="alert" style="display: none; margin-top: 0.75rem;"></div>
            </div>
        </section>

        <section class="section">
            <div class="card">
                <h2>Add Podcast</h2>
                <form id="add-podcast-form">
                    <div class="form-group">
                        <label class="form-label" for="appleUrl">Apple Podcasts URL</label>
                        <input type="url" id="appleUrl" name="appleUrl" class="form-input" placeholder="https://podcasts.apple.com/us/podcast/..." required />
                    </div>
                    <div class="form-group">
                        <label class="form-label" for="templateId">Summary Template</label>
                        <select id="templateId" name="templateId" class="form-select">
                            <option value="key-takeaways">Key Takeaways</option>
                            <option value="narrative-summary">Narrative Summary</option>
                            <option value="eli5">ELI5</option>
                        </select>
                    </div>
                    <div class="form-group checkbox-group">
                        <input type="checkbox" id="queueLatest" name="queueLatest" checked />
                        <label for="queueLatest">Queue latest episode immediately</label>
                    </div>
                    <button type="submit" class="button button-primary">Add Podcast</button>
                </form>
                <div id="add-message" class="alert" style="display: none; margin-top: 1rem;"></div>
            </div>
        </section>

        <section class="section">
            <h2>Monitored Podcasts</h2>
            ${statusSummaryHtml}
            <div id="podcasts-list">
                ${podcastCards}
            </div>
        </section>

        <style>
            #settings-form .form-group,
            #add-podcast-form .form-group {
                margin-bottom: 1.25rem;
            }
            #add-podcast-form button[type="submit"] {
                margin-top: 0.5rem;
            }
            .form-select {
                padding: 0.75rem 2.5rem 0.75rem 1rem;
                font-size: 0.875rem;
                background-color: var(--background);
                color: var(--foreground);
                border: 1px solid var(--border);
                border-radius: var(--radius);
                cursor: pointer;
                appearance: none;
                background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 24 24' fill='none' stroke='%239ca3af' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E");
                background-repeat: no-repeat;
                background-position: right 0.75rem center;
                transition: border-color 0.2s ease, box-shadow 0.2s ease;
            }
            .form-select:focus {
                outline: none;
                border-color: var(--accent-red);
                box-shadow: 0 0 0 3px rgba(230, 57, 70, 0.15);
            }
            .form-select option {
                background-color: var(--background);
                color: var(--foreground);
            }
            .checkbox-group {
                display: flex;
                flex-direction: row;
                align-items: center;
                gap: 0.75rem;
            }
            .checkbox-group label {
                margin-bottom: 0;
                cursor: pointer;
            }
            .checkbox-group input[type="checkbox"] {
                appearance: none;
                width: 1.25rem;
                height: 1.25rem;
                border: 2px solid var(--border);
                border-radius: 4px;
                background-color: var(--background);
                cursor: pointer;
                position: relative;
                transition: all 0.2s ease;
            }
            .checkbox-group input[type="checkbox"]:checked {
                background-color: var(--accent-red);
                border-color: var(--accent-red);
            }
            .checkbox-group input[type="checkbox"]:checked::after {
                content: '';
                position: absolute;
                left: 5px;
                top: 1px;
                width: 5px;
                height: 10px;
                border: solid white;
                border-width: 0 2px 2px 0;
                transform: rotate(45deg);
            }
            .checkbox-group input[type="checkbox"]:focus {
                outline: none;
                box-shadow: 0 0 0 3px rgba(230, 57, 70, 0.15);
            }
            .button-group {
                display: flex;
                gap: 0.5rem;
                flex-wrap: wrap;
            }
            .podcast-monitor-card {
                margin-bottom: 1rem;
            }
            .podcast-header {
                display: flex;
                justify-content: space-between;
                align-items: center;
                margin-bottom: 0.5rem;
            }
            .podcast-header h3 {
                margin: 0;
            }
            .status-badge {
                padding: 0.25rem 0.5rem;
                border-radius: 4px;
                font-size: 0.75rem;
                font-weight: 600;
                text-transform: uppercase;
            }
            .status-active { background: rgba(34, 197, 94, 0.15); color: #22c55e; }
            .status-paused { background: rgba(234, 179, 8, 0.15); color: #eab308; }
            .status-error { background: rgba(239, 68, 68, 0.15); color: #ef4444; }
            .podcast-meta {
                display: flex;
                gap: 1rem;
                flex-wrap: wrap;
                color: var(--text-secondary);
                font-size: 0.875rem;
                margin-bottom: 0.5rem;
            }
            .podcast-actions {
                display: flex;
                gap: 0.5rem;
                margin-top: 0.5rem;
            }
            .button-danger {
                background: #ef4444;
                color: white;
                border-color: #ef4444;
            }
            .button-danger:hover {
                background: #dc2626;
                border-color: #dc2626;
            }
        </style>

        <script>
            document.getElementById('settings-form').addEventListener('submit', async (e) => {
                e.preventDefault();
                const msg = document.getElementById('settings-message');
                
                try {
                    const response = await fetch('/admin/podcasts/settings', {
                        method: 'PUT',
                        headers: { 'Content-Type': 'application/json' },
                        credentials: 'include',
                        body: JSON.stringify({
                            maxEpisodesPerCheck: parseInt(document.getElementById('maxEpisodes').value),
                            enabled: document.getElementById('enabled').checked,
                        }),
                    });
                    
                    const data = await response.json();
                    msg.className = response.ok ? 'alert alert-success' : 'alert alert-error';
                    msg.textContent = response.ok ? 'Settings saved!' : (data.error || 'Failed to save');
                    msg.style.display = 'block';
                } catch (err) {
                    msg.className = 'alert alert-error';
                    msg.textContent = 'Failed to save settings';
                    msg.style.display = 'block';
                }
            });

            document.getElementById('add-podcast-form').addEventListener('submit', async (e) => {
                e.preventDefault();
                const msg = document.getElementById('add-message');
                const btn = e.target.querySelector('button[type="submit"]');
                btn.disabled = true;
                btn.textContent = 'Adding...';
                
                try {
                    const response = await fetch('/admin/podcasts/add', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        credentials: 'include',
                        body: JSON.stringify({
                            appleUrl: document.getElementById('appleUrl').value,
                            templateId: document.getElementById('templateId').value,
                            queueLatest: document.getElementById('queueLatest').checked,
                        }),
                    });
                    
                    const data = await response.json();
                    msg.className = response.ok ? 'alert alert-success' : 'alert alert-error';
                    msg.textContent = response.ok ? 'Podcast added!' + (data.queuedLatest ? ' Latest episode queued.' : '') : (data.error || 'Failed to add');
                    msg.style.display = 'block';
                    
                    if (response.ok) {
                        setTimeout(() => window.location.reload(), 1500);
                    }
                } catch (err) {
                    msg.className = 'alert alert-error';
                    msg.textContent = 'Failed to add podcast';
                    msg.style.display = 'block';
                }
                
                btn.disabled = false;
                btn.textContent = 'Add Podcast';
            });

            async function checkAllNow() {
                const msg = document.getElementById('settings-message');
                msg.className = 'alert alert-info';
                msg.textContent = 'Checking all podcasts...';
                msg.style.display = 'block';
                
                try {
                    const response = await fetch('/admin/podcasts/check-now', {
                        method: 'POST',
                        credentials: 'include',
                    });
                    
                    const data = await response.json();
                    msg.className = response.ok ? 'alert alert-success' : 'alert alert-error';
                    msg.textContent = response.ok 
                        ? 'Checked ' + data.checked + ' podcasts. ' + data.totalNewEpisodes + ' new episode(s) queued.'
                        : (data.error || 'Failed');
                    msg.style.display = 'block';
                    
                    if (response.ok && data.totalNewEpisodes > 0) {
                        setTimeout(() => window.location.reload(), 2000);
                    }
                } catch (err) {
                    msg.className = 'alert alert-error';
                    msg.textContent = 'Failed to check podcasts';
                    msg.style.display = 'block';
                }
            }

            async function checkPodcast(podcastId) {
                const card = document.getElementById('podcast-' + podcastId);
                const btn = card.querySelector('button');
                btn.disabled = true;
                btn.textContent = 'Checking...';
                
                try {
                    const response = await fetch('/admin/podcasts/' + podcastId + '/check', {
                        method: 'POST',
                        credentials: 'include',
                    });
                    
                    if (response.ok) {
                        window.location.reload();
                    } else {
                        const data = await response.json();
                        alert(data.error || 'Failed to check podcast');
                    }
                } catch (err) {
                    alert('Failed to check podcast');
                }
                
                btn.disabled = false;
                btn.textContent = 'Check Now';
            }

            async function removePodcast(podcastId) {
                if (!confirm('Remove this podcast from monitoring? This will not delete any existing summaries.')) {
                    return;
                }
                
                try {
                    const response = await fetch('/admin/podcasts/' + podcastId, {
                        method: 'DELETE',
                        credentials: 'include',
                    });
                    
                    if (response.ok) {
                        document.getElementById('podcast-' + podcastId).remove();
                    } else {
                        const data = await response.json();
                        alert(data.error || 'Failed to remove podcast');
                    }
                } catch (err) {
                    alert('Failed to remove podcast');
                }
            }
        </script>
    `;

    return c.html(Layout({
        title: "Monitor Podcasts",
        children: content,
    }));
});

// PUT /podcasts/settings
admin.put("/podcasts/settings", async (c) => {
    const authError = await requireAdmin(c);
    if (authError) return authError;

    let body: Partial<MonitorSettings>;
    try {
        body = await c.req.json();
    } catch {
        return c.json({ error: "Invalid JSON body" }, 400);
    }

    const current = await getMonitorSettings(c.env.TLDL_DATA);
    const updated: MonitorSettings = {
        checkIntervalHours: body.checkIntervalHours ?? current.checkIntervalHours,
        maxEpisodesPerCheck: body.maxEpisodesPerCheck ?? current.maxEpisodesPerCheck,
        enabled: body.enabled ?? current.enabled,
    };

    if (updated.checkIntervalHours < 1 || updated.checkIntervalHours > 24) {
        return c.json({ error: "Check interval must be 1-24 hours" }, 400);
    }
    if (updated.maxEpisodesPerCheck < 1 || updated.maxEpisodesPerCheck > 10) {
        return c.json({ error: "Max episodes must be 1-10" }, 400);
    }

    await saveMonitorSettings(c.env.TLDL_DATA, updated);
    return c.json({ success: true, settings: updated });
});

// POST /podcasts/add
admin.post("/podcasts/add", async (c) => {
    const authError = await requireAdmin(c);
    if (authError) return authError;

    let body: { appleUrl: string; templateId: string; queueLatest?: boolean };
    try {
        body = await c.req.json();
    } catch {
        return c.json({ error: "Invalid JSON body" }, 400);
    }

    if (!body.appleUrl) {
        return c.json({ error: "Missing appleUrl" }, 400);
    }

    const parsed = parsePodcastUrl(body.appleUrl);
    if (!parsed) {
        return c.json({ error: "Invalid Apple Podcasts URL. Please use a podcast URL like: https://podcasts.apple.com/us/podcast/podcast-name/id1234567890" }, 400);
    }

    const result = await addPodcastToMonitoring(
        c.env,
        parsed.podcastId,
        body.templateId || "key-takeaways",
        body.queueLatest !== false
    );

    if (!result.success) {
        return c.json({ error: result.error }, 400);
    }

    return c.json({
        success: true,
        podcast: result.podcast,
        queuedLatest: result.queuedLatest,
    });
});

// POST /podcasts/check-now
admin.post("/podcasts/check-now", async (c) => {
    const authError = await requireAdmin(c);
    if (authError) return authError;

    const result = await forceCheckAllPodcasts(c.env);
    return c.json(result);
});

// POST /podcasts/:podcastId/check
admin.post("/podcasts/:podcastId/check", async (c) => {
    const authError = await requireAdmin(c);
    if (authError) return authError;

    const podcastId = c.req.param("podcastId");
    const podcast = await getMonitoredPodcast(c.env.TLDL_DATA, podcastId);

    if (!podcast) {
        return c.json({ error: "Podcast not found" }, 404);
    }

    const settings = await getMonitorSettings(c.env.TLDL_DATA);
    const result = await checkPodcastForNewEpisodes(c.env, podcast, settings.maxEpisodesPerCheck);
    return c.json(result);
});

// DELETE /podcasts/:podcastId
admin.delete("/podcasts/:podcastId", async (c) => {
    const authError = await requireAdmin(c);
    if (authError) return authError;

    const podcastId = c.req.param("podcastId");
    await deleteMonitoredPodcast(c.env.TLDL_DATA, podcastId);
    return c.json({ success: true });
});

export default admin;
