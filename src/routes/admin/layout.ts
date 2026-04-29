/**
 * Shared admin layout: header with action buttons + tab navigation.
 *
 * All admin pages render through this so the chrome stays consistent.
 */

import { Layout } from "../public";
import { escapeHtml } from "../../lib/auth";
import type { AdminTab } from "./utils";

interface AdminLayoutProps {
    title: string;
    activeTab: AdminTab;
    userEmail: string;
    children: string;
}

const TABS: Array<{ id: AdminTab; label: string; href: string }> = [
    { id: "dashboard", label: "Dashboard", href: "/admin" },
    { id: "episodes", label: "Episodes", href: "/admin?tab=episodes" },
    { id: "podcasts", label: "Podcasts", href: "/admin/podcasts" },
    { id: "subscribers", label: "Subscribers", href: "/admin?tab=subscribers" },
    { id: "activity", label: "Activity", href: "/admin?tab=activity" },
    { id: "maintenance", label: "Maintenance", href: "/admin?tab=maintenance" },
];

export function renderAdminHeader(userEmail: string): string {
    return `
        <header class="admin-header">
            <div class="admin-header-top">
                <div>
                    <h1 class="admin-header-title">Admin</h1>
                    <p class="admin-header-user">${escapeHtml(userEmail)} <span class="badge">Admin</span></p>
                </div>
                <div class="admin-header-actions">
                    <a href="/admin/submit" class="button button-primary">Submit Episode</a>
                    <a href="/admin/submit-manual" class="button button-primary">Submit Transcript</a>
                    <button type="button" class="button" onclick="checkAllNow()">Check All Now</button>
                    <a href="https://elezea.cloudflareaccess.com/cdn-cgi/access/logout?returnTo=https%3A%2F%2Ftldl-pod.com%2F" class="button">Log Out</a>
                </div>
            </div>
            <div id="check-all-status" class="alert" style="display: none; margin-top: 0.75rem;"></div>
        </header>
    `;
}

export function renderTabNav(active: AdminTab): string {
    const links = TABS.map((tab) => {
        const isActive = tab.id === active;
        return `<a href="${tab.href}" class="admin-tab ${isActive ? "admin-tab-active" : ""}" ${isActive ? 'aria-current="page"' : ""}>${tab.label}</a>`;
    }).join("");
    return `<nav class="admin-tabs" aria-label="Admin sections">${links}</nav>`;
}

const HEADER_SCRIPT = `
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
`;

const ADMIN_STYLES = `
<style>
.admin-header { margin-bottom: 1rem; }
.admin-header-top { display: flex; justify-content: space-between; align-items: flex-start; gap: 1rem; flex-wrap: wrap; }
.admin-header-title { margin: 0; }
.admin-header-user { margin: 0.25rem 0 0; color: var(--muted-foreground); font-size: 0.875rem; }
.admin-header-actions { display: flex; gap: 0.5rem; flex-wrap: wrap; }
.admin-tabs { display: flex; gap: 0.25rem; border-bottom: 1px solid var(--border, #e5e7eb); margin-bottom: 1.5rem; overflow-x: auto; }
.admin-tab { padding: 0.625rem 1rem; text-decoration: none; color: var(--muted-foreground); border-bottom: 2px solid transparent; white-space: nowrap; font-size: 0.9375rem; }
.admin-tab:hover { color: var(--foreground); }
.admin-tab-active { color: var(--foreground); border-bottom-color: currentColor; font-weight: 500; }
.subscribers-table { width: 100%; border-collapse: collapse; }
.subscribers-table th, .subscribers-table td { padding: 0.625rem 0.75rem; text-align: left; border-bottom: 1px solid var(--border, #e5e7eb); font-size: 0.9375rem; }
.subscribers-table th { font-weight: 600; color: var(--muted-foreground); font-size: 0.8125rem; text-transform: uppercase; letter-spacing: 0.025em; }
.subscriber-status { display: inline-block; padding: 0.125rem 0.5rem; border-radius: 9999px; font-size: 0.75rem; font-weight: 500; }
.subscriber-status-confirmed { background: #dcfce7; color: #15803d; }
.subscriber-status-pending { background: #fef3c7; color: #b45309; }
.subscriber-status-bounced { background: #fee2e2; color: #b91c1c; }
@media (prefers-color-scheme: dark) {
    .subscriber-status-confirmed { background: #14532d; color: #bbf7d0; }
    .subscriber-status-pending { background: #78350f; color: #fde68a; }
    .subscriber-status-bounced { background: #7f1d1d; color: #fecaca; }
}
</style>
`;

export function AdminLayout(props: AdminLayoutProps) {
    const body = `
        ${ADMIN_STYLES}
        ${renderAdminHeader(props.userEmail)}
        ${renderTabNav(props.activeTab)}
        <div class="admin-tab-content">
            ${props.children}
        </div>
        <script>${HEADER_SCRIPT}</script>
    `;
    return Layout({ title: props.title, children: body });
}
