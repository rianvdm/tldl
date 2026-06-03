/**
 * Render functions for each admin tab.
 *
 * Each function returns an HTML string for the tab's main content area.
 * The shared chrome (header + tab nav) is provided by AdminLayout.
 */

import { escapeHtml } from "../../lib/auth";
import { getValidTags } from "../../lib/constants";
import { formatDate, formatDuration, formatRelativeTime } from "./utils";
import type { EpisodeIndexEntry } from "../../types";
import type { SubscriberWithSubscriptions } from "../../lib/db";

interface ActivityEvent {
    type: string;
    title: string;
    details?: string;
    timestamp: string;
    episodeId?: string;
}

// ============================================================================
// Dashboard tab — stats grid + recent activity preview
// ============================================================================

interface DashboardProps {
    totalEpisodes: number;
    totalPodcasts: number;
    errorCount: number;
    lastChecked: string;
    activeJobsCount: number;
    activityLog: ActivityEvent[];
}

export function renderDashboardTab(p: DashboardProps): string {
    const activityHtml = renderActivityList(p.activityLog, { allowClear: true });

    const activeJobsHtml = p.activeJobsCount > 0
        ? `<div class="activity-item">
            <span class="activity-icon activity-icon-info">↻</span>
            <div class="activity-content">
                <span class="activity-title">${p.activeJobsCount} active job${p.activeJobsCount !== 1 ? "s" : ""}</span>
            </div>
        </div>`
        : "";

    return `
        <div class="admin-stats-grid">
            <div class="admin-stat-card">
                <span class="admin-stat-number">${p.totalEpisodes}</span>
                <span class="admin-stat-label">Episodes</span>
            </div>
            <div class="admin-stat-card">
                <span class="admin-stat-number">${p.totalPodcasts}</span>
                <span class="admin-stat-label">Podcasts</span>
            </div>
            <div class="admin-stat-card ${p.errorCount > 0 ? "admin-stat-error" : ""}">
                <span class="admin-stat-number">${p.errorCount}</span>
                <span class="admin-stat-label">Errors</span>
            </div>
            <div class="admin-stat-card">
                <span class="admin-stat-number">${p.lastChecked ? formatRelativeTime(p.lastChecked) : "—"}</span>
                <span class="admin-stat-label">Last check</span>
            </div>
        </div>

        <section class="card admin-activity-section">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 1rem;">
                <h2 style="margin: 0;">Recent Activity</h2>
                <a href="/admin?tab=activity" class="text-muted" style="font-size: 0.875rem;">View all →</a>
            </div>
            ${activeJobsHtml}
            ${activityHtml}
        </section>
        ${ACTIVITY_SCRIPT}
    `;
}

// ============================================================================
// Activity tab — full activity log
// ============================================================================

export function renderActivityTab(activityLog: ActivityEvent[]): string {
    const activityHtml = renderActivityList(activityLog, { allowClear: true });
    return `
        <section class="card admin-activity-section">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 1rem;">
                <h2 style="margin: 0;">Activity Log</h2>
                <p class="text-muted" style="margin: 0; font-size: 0.875rem;">Last ${activityLog.length} event${activityLog.length !== 1 ? "s" : ""} (30-day rolling window)</p>
            </div>
            ${activityHtml}
        </section>
        ${ACTIVITY_SCRIPT}
    `;
}

function renderActivityList(events: ActivityEvent[], opts: { allowClear: boolean }): string {
    if (events.length === 0) return `<p class="text-muted">No recent activity.</p>`;
    return events.map(event => {
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

        const clearBtn = (opts.allowClear && event.type === "episode_failed" && event.episodeId)
            ? `<button type="button" class="activity-clear-btn" onclick="clearFailedJob('${escapeHtml(event.episodeId)}', this)" title="Clear failed job">✕</button>`
            : "";

        return `<div class="activity-item">
            ${icon}
            <div class="activity-content">
                <span class="activity-title">${escapeHtml(event.title)}</span>
                ${detailsHtml}
            </div>
            <span class="activity-time">${formatRelativeTime(event.timestamp)}</span>
            ${clearBtn}
        </div>`;
    }).join("");
}

const ACTIVITY_SCRIPT = `<script>
async function clearFailedJob(episodeId, btn) {
    const item = btn.closest('.activity-item');
    btn.disabled = true;
    try {
        const res = await fetch('/admin/activity/' + encodeURIComponent(episodeId), { method: 'DELETE' });
        const data = await res.json();
        if (data.success) {
            item.style.transition = 'opacity 0.3s';
            item.style.opacity = '0';
            setTimeout(() => item.remove(), 300);
        } else {
            alert('Failed to clear job: ' + (data.error || 'Unknown error'));
            btn.disabled = false;
        }
    } catch (e) {
        alert('Failed to clear job');
        btn.disabled = false;
    }
}
</script>`;

// ============================================================================
// Episodes tab — paginated episode cards with admin controls
// ============================================================================

interface EpisodesProps {
    episodes: Array<EpisodeIndexEntry & { templateBadges: string }>;
    page: number;
    totalPages: number;
}

export function renderEpisodesTab(p: EpisodesProps): string {
    const episodeCards = p.episodes.map((episode) => `
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
                ${episode.templateBadges ? `<div class="episode-badges">${episode.templateBadges}</div>` : ""}
                <div class="tag-editor" data-episode-id="${escapeHtml(episode.id)}">
                    <div style="display: flex; justify-content: space-between; align-items: center;">
                        <label class="form-label" style="margin: 0;">Tags:</label>
                        <button type="button" class="button button-sm" onclick="saveTagsFor('${escapeHtml(episode.id)}')">Save Tags</button>
                    </div>
                    <div class="tag-editor-tags">
                        ${getValidTags().map(tag => {
                            const isSelected = episode.tags?.includes(tag);
                            return `<button type="button" class="tag-editor-badge ${isSelected ? 'selected' : ''}" data-tag="${escapeHtml(tag)}" onclick="toggleTag(this, '${escapeHtml(episode.id)}')">${escapeHtml(tag)}</button>`;
                        }).join('')}
                    </div>
                    <div class="tag-editor-message" id="tag-message-${escapeHtml(episode.id)}" style="display: none;"></div>
                </div>
            </div>
            <button type="button" class="button button-destructive button-sm" onclick="confirmDelete('${escapeHtml(episode.id)}', '${escapeHtml(episode.episodeTitle.replace(/'/g, "\\'"))}')">Delete</button>
            <button type="button" class="button button-secondary button-sm" onclick="openSummaryEditor('${escapeHtml(episode.id)}', '${escapeHtml(episode.episodeTitle.replace(/'/g, "\\\\'"))}')">Edit Summaries</button>
        </div>
    `).join("");

    const paginationHtml = p.totalPages > 1 ? `
        <nav class="pagination" aria-label="Episode pagination">
            ${p.page > 1
                ? `<a href="/admin?tab=episodes&page=${p.page - 1}" class="pagination-link pagination-prev">Previous</a>`
                : `<span class="pagination-link pagination-prev pagination-disabled">Previous</span>`}
            <span class="pagination-info">Page ${p.page} of ${p.totalPages}</span>
            ${p.page < p.totalPages
                ? `<a href="/admin?tab=episodes&page=${p.page + 1}" class="pagination-link pagination-next">Next</a>`
                : `<span class="pagination-link pagination-next pagination-disabled">Next</span>`}
        </nav>
    ` : "";

    return `
        <section class="section">
            <h2>All Episodes</h2>
            ${p.episodes.length > 0 ? `
                <div class="episode-list">${episodeCards}</div>
                ${paginationHtml}
            ` : `
                <div class="empty-state">
                    <p>No episodes yet.</p>
                    <a href="/admin/submit" class="button button-primary">Submit Your First Episode</a>
                </div>
            `}
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
                <div id="summary-edit-content"><p class="text-muted">Loading summaries...</p></div>
                <div id="summary-edit-status" style="display: none; margin-top: 1rem;"></div>
                <div class="modal-actions">
                    <button type="button" class="button" onclick="hideSummaryEditModal()">Close</button>
                </div>
            </div>
        </div>

        ${EPISODES_SCRIPT}
    `;
}

const EPISODES_SCRIPT = `<script>
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

function escapeHtmlForTextarea(text) {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function openSummaryEditor(episodeId, episodeTitle) {
    currentSummaryEpisodeId = episodeId;
    document.getElementById('summary-modal-title').textContent = 'Edit Summaries: ' + episodeTitle;
    document.getElementById('summary-edit-content').innerHTML = '<p class="text-muted">Loading summaries...</p>';
    document.getElementById('summary-edit-status').style.display = 'none';
    document.getElementById('summary-edit-modal').style.display = 'flex';

    try {
        const response = await fetch('/admin/episodes/' + episodeId + '/summaries', { credentials: 'include' });
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
            setTimeout(() => { messageEl.style.display = 'none'; }, 3000);
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
</script>`;

// ============================================================================
// Subscribers tab — read-only list of email subscribers
// ============================================================================

interface SubscribersProps {
    subscribers: SubscriberWithSubscriptions[];
    counts: { total: number; confirmed: number; pending: number; bounced: number };
}

export function renderSubscribersTab(p: SubscribersProps): string {
    const rows = p.subscribers.length === 0
        ? `<tr><td colspan="5" class="text-muted" style="text-align: center; padding: 2rem;">No subscribers yet.</td></tr>`
        : p.subscribers.map((s) => {
            const statusLabel = s.status !== "active"
                ? `<span class="subscriber-status subscriber-status-bounced">${escapeHtml(s.status)}</span>`
                : s.confirmedAt
                    ? `<span class="subscriber-status subscriber-status-confirmed">confirmed</span>`
                    : `<span class="subscriber-status subscriber-status-pending">pending</span>`;
            return `<tr>
                <td>${escapeHtml(s.email)}</td>
                <td>${statusLabel}</td>
                <td>${s.subscriptionCount}</td>
                <td>${s.confirmedAt ? formatDate(s.confirmedAt) : "—"}</td>
                <td>${formatDate(s.createdAt)}</td>
            </tr>`;
        }).join("");

    return `
        <div class="admin-stats-grid">
            <div class="admin-stat-card">
                <span class="admin-stat-number">${p.counts.total}</span>
                <span class="admin-stat-label">Total</span>
            </div>
            <div class="admin-stat-card">
                <span class="admin-stat-number">${p.counts.confirmed}</span>
                <span class="admin-stat-label">Confirmed</span>
            </div>
            <div class="admin-stat-card">
                <span class="admin-stat-number">${p.counts.pending}</span>
                <span class="admin-stat-label">Pending</span>
            </div>
            <div class="admin-stat-card ${p.counts.bounced > 0 ? "admin-stat-error" : ""}">
                <span class="admin-stat-number">${p.counts.bounced}</span>
                <span class="admin-stat-label">Bounced</span>
            </div>
        </div>

        <section class="card">
            <h2 style="margin-top: 0;">Subscribers</h2>
            <div style="overflow-x: auto;">
                <table class="subscribers-table">
                    <thead>
                        <tr>
                            <th>Email</th>
                            <th>Status</th>
                            <th>Podcasts</th>
                            <th>Confirmed</th>
                            <th>Created</th>
                        </tr>
                    </thead>
                    <tbody>${rows}</tbody>
                </table>
            </div>
        </section>
    `;
}

// ============================================================================
// Maintenance tab — admin tools (rebuild index, cleanup, backfills)
// ============================================================================

export function renderMaintenanceTab(): string {
    const tools: Array<{ id: string; label: string; description: string; confirm?: string; endpoint: string; reload?: boolean }> = [
        { id: "rebuild-index", label: "Rebuild Episode Index", description: "Rebuild the episode index. Use after database changes or if the home page is empty.", endpoint: "/admin/rebuild-index" },
        { id: "cleanup-jobs", label: "Clean Up Failed Jobs", description: "Remove all failed jobs from the home page. Use to clean up orphaned jobs.", endpoint: "/admin/cleanup-jobs" },
        { id: "backfill-tags", label: "Backfill Tags", description: "Generate tags for all episodes without tags using existing transcripts and summaries. Uses OpenAI API credits.", confirm: "Generate tags for all episodes without tags? This may take a few minutes and will use OpenAI API credits.", endpoint: "/admin/backfill-tags", reload: true },
        { id: "cleanup-tags", label: "Cleanup Invalid Tags", description: "Remove tags that are no longer in the predefined list. Run after removing tags from constants.", confirm: "Remove invalid tags from all episodes?", endpoint: "/admin/cleanup-tags", reload: true },
        { id: "backfill-podcast-info", label: "Backfill Podcast Info", description: "Fetch podcast author and website info from Podcast Index API for all episodes.", confirm: "Fetch podcast author and website info for all episodes? This may take a while.", endpoint: "/admin/backfill-podcast-info" },
        { id: "backfill-podcast-authors", label: "Backfill Monitored Podcast Authors", description: "Fetch missing author info for monitored podcasts.", endpoint: "/admin/backfill-monitored-podcast-authors" },
        { id: "backfill-episode-metadata", label: "Backfill Episode Podcast Metadata", description: "Backfill podcast metadata (author, website) on existing episodes.", endpoint: "/admin/backfill-episode-podcast-metadata" },
        { id: "backfill-episode-apple-urls", label: "Backfill Episode Apple URLs", description: "Fill in per-episode canonical Apple Podcasts URLs (?i={id}) and cleaned website URLs for RSS-cron episodes. Calls Podcast Index (cached per podcast).", confirm: "Backfill per-episode Apple URLs from Podcast Index? Cached per podcast, but still hits the PI API.", endpoint: "/admin/backfill-episode-apple-urls" },
        { id: "backfill-decode-entities", label: "Decode Title Entities", description: "Fix episode/podcast titles stored with raw HTML entities (e.g. “&#8220;” showing as literal text). Decodes titles in the index and episode records. No API calls; idempotent.", confirm: "Decode HTML entities in all episode titles?", endpoint: "/admin/backfill-decode-entities", reload: true },
    ];

    const toolItems = tools.map((t) => `
        <div class="admin-tool-item" style="margin-top: 1.5rem;">
            <p class="text-muted">${escapeHtml(t.description)}</p>
            <button type="button" class="button" data-tool="${t.id}" data-endpoint="${t.endpoint}" data-confirm="${t.confirm ? escapeHtml(t.confirm) : ""}" data-reload="${t.reload ? "1" : "0"}">${escapeHtml(t.label)}</button>
            <div class="alert" data-status="${t.id}" style="display: none; margin-top: 0.75rem;"></div>
        </div>
    `).join("");

    return `
        <section class="section">
            <h2>Maintenance</h2>
            <p class="text-muted">Run these only when needed. Most touch the database or call paid APIs.</p>
            <div class="admin-tools">${toolItems}</div>
        </section>
        ${MAINTENANCE_SCRIPT}
    `;
}

const MAINTENANCE_SCRIPT = `<script>
document.querySelectorAll('[data-tool]').forEach(function(btn) {
    btn.addEventListener('click', async function() {
        var endpoint = btn.getAttribute('data-endpoint');
        var confirmMsg = btn.getAttribute('data-confirm');
        var shouldReload = btn.getAttribute('data-reload') === '1';
        var toolId = btn.getAttribute('data-tool');
        var statusEl = document.querySelector('[data-status="' + toolId + '"]');
        if (confirmMsg && !confirm(confirmMsg)) return;
        var originalLabel = btn.textContent;
        btn.disabled = true;
        btn.textContent = 'Running...';
        statusEl.style.display = 'block';
        statusEl.className = 'alert alert-info';
        statusEl.textContent = 'Working...';
        try {
            var response = await fetch(endpoint, { method: 'POST', credentials: 'include' });
            var data = await response.json();
            if (response.ok) {
                statusEl.className = 'alert alert-success';
                statusEl.textContent = data.message || 'Success';
                if (shouldReload) setTimeout(function() { window.location.reload(); }, 2000);
            } else {
                statusEl.className = 'alert alert-error';
                statusEl.textContent = 'Error: ' + (data.error || 'Unknown error');
            }
        } catch (err) {
            statusEl.className = 'alert alert-error';
            statusEl.textContent = 'Request failed';
        }
        btn.disabled = false;
        btn.textContent = originalLabel;
    });
});
</script>`;
