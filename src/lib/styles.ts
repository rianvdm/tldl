/**
 * Embedded CSS styles for the TLDL application
 * This allows serving CSS without filesystem access in Cloudflare Workers
 */

export const CSS = `/**
 * TLDL Styles
 * Dark mode theme based on Figma design
 */

/* ============================================================================
   CSS Variables (Dark Mode)
   ============================================================================ */

:root {
    --background: #0a0a0a;
    --foreground: #fafafa;
    --card: #171717;
    --card-foreground: #fafafa;
    --muted: #262626;
    --muted-foreground: #a3a3a3;
    --accent: #262626;
    --accent-foreground: #fafafa;
    --accent-red: #e63946;
    --accent-red-hover: #d62839;
    --border: #262626;
    --primary: #fafafa;
    --primary-foreground: #171717;
    --destructive: #dc2626;
    --radius: 0.5rem;
    --font-sans: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI",
        Roboto, "Helvetica Neue", Arial, sans-serif;
    --font-mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas,
        "Liberation Mono", monospace;
}

/* ============================================================================
   Base Styles
   ============================================================================ */

*,
*::before,
*::after {
    box-sizing: border-box;
    margin: 0;
    padding: 0;
}

html {
    font-size: 16px;
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
}

body {
    font-family: var(--font-sans);
    background-color: var(--background);
    color: var(--foreground);
    line-height: 1.6;
    min-height: 100vh;
}

a {
    color: inherit;
    text-decoration: none;
}

/* ============================================================================
   Layout
   ============================================================================ */

.container {
    max-width: 48rem;
    margin: 0 auto;
    padding: 0 1rem;
    min-height: 100vh;
    display: flex;
    flex-direction: column;
}

.nav {
    display: flex;
    align-items: baseline;
    gap: 0.75rem;
    padding: 1.5rem 0;
    border-bottom: 1px solid var(--border);
}

.nav-brand {
    font-size: 1.25rem;
    font-weight: 600;
    letter-spacing: -0.025em;
}

.nav-tagline {
    font-size: 0.875rem;
    color: var(--muted-foreground);
    flex: 1;
}

.nav-link {
    font-size: 0.875rem;
    color: var(--muted-foreground);
    transition: color 0.2s ease;
}

.nav-link:hover {
    color: var(--accent-red);
}

.main {
    flex: 1;
    padding: 2rem 0;
}

.footer {
    padding: 2rem 0;
    border-top: 1px solid var(--border);
    text-align: center;
    color: var(--muted-foreground);
    font-size: 0.875rem;
}

.footer a {
    color: var(--muted-foreground);
    text-decoration: none;
    transition: color 0.2s ease;
}

.footer a:hover {
    color: var(--accent-red);
}

/* ============================================================================
   Typography
   ============================================================================ */

h1 {
    font-size: 1.875rem;
    font-weight: 600;
    line-height: 1.3;
    letter-spacing: -0.025em;
}

h2 {
    font-size: 1.25rem;
    font-weight: 600;
    line-height: 1.4;
    margin-bottom: 1rem;
}

h3 {
    font-size: 1.125rem;
    font-weight: 500;
    line-height: 1.4;
}

h4 {
    font-size: 1rem;
    font-weight: 500;
    line-height: 1.5;
}

.text-muted {
    color: var(--muted-foreground);
}

.text-accent {
    color: var(--accent-red);
}

/* ============================================================================
   Page Header
   ============================================================================ */

.page-header {
    margin-bottom: 2rem;
}

.page-header h2 {
    font-size: 1.5rem;
    margin-bottom: 0;
}

.page-subtitle {
    color: var(--muted-foreground);
    margin-top: 0.25rem;
}

/* ============================================================================
   Episode Cards
   ============================================================================ */

.episode-list {
    display: flex;
    flex-direction: column;
    gap: 1rem;
}

.episode-card {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 1rem;
    padding: 1.25rem;
    background-color: var(--card);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    transition: background-color 0.2s ease, border-color 0.2s ease;
}

.episode-card:hover {
    background-color: var(--accent);
    border-color: var(--muted-foreground);
}

.episode-card-content {
    flex: 1;
    min-width: 0;
}

.episode-podcast {
    font-size: 0.875rem;
    font-weight: 500;
    color: var(-foreground);
    margin-bottom: 0.25rem;
    display: flex;
    align-items: center;
}

.episode-title {
    margin-bottom: 0.5rem;
    font-weight: 600;
    transition: color 0.2s ease;
}

.episode-card:hover .episode-title {
    color: var(--primary);
}

.episode-meta {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.875rem;
    color: var(--muted-foreground);
    margin-bottom: 0.75rem;
}

.meta-dot {
    color: var(--muted-foreground);
}

.episode-badges {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem;
}

/* ============================================================================
   Badges
   ============================================================================ */

.badge {
    display: inline-flex;
    align-items: center;
    padding: 0.25rem 0.625rem;
    font-size: 0.75rem;
    font-weight: 500;
    background-color: var(--muted);
    color: var(--foreground);
    border-radius: 9999px;
}

.tag-editor {
    margin-top: 1rem;
    padding: 1rem;
    background-color: var(--background);
    border: 1px solid var(--border);
    border-radius: var(--radius);
}

.tag-editor-tags {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    margin-top: 0.75rem;
}

.tag-editor-badge {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    padding: 0.375rem 0.625rem;
    font-size: 0.75rem;
    font-weight: 500;
    background-color: var(--muted);
    color: var(--foreground);
    border: 1px solid var(--border);
    border-radius: 9999px;
    cursor: pointer;
    transition: background-color 0.2s ease, border-color 0.2s ease;
}

.tag-editor-badge:hover {
    background-color: var(--accent);
    border-color: var(--muted-foreground);
}

.tag-editor-badge.selected {
    background-color: rgba(59, 130, 246, 0.2);
    border-color: #3b82f6;
    color: #60a5fa;
}

.tag-editor-badge.selected:hover {
    background-color: rgba(59, 130, 246, 0.3);
}

.tag-editor-message {
    font-size: 0.75rem;
    padding: 0.5rem;
    border-radius: 0.25rem;
    margin-top: 0.5rem;
}

.tag-editor-message.alert-success {
    background-color: rgba(34, 197, 94, 0.1);
    color: #22c55e;
    border: 1px solid rgba(34, 197, 94, 0.3);
}

.tag-editor-message.alert-error {
    background-color: rgba(239, 68, 68, 0.1);
    color: #ef4444;
    border: 1px solid rgba(239, 68, 68, 0.3);
}

/* ============================================================================
   Buttons
   ============================================================================ */

.button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 0.5rem;
    padding: 0.625rem 1rem;
    font-size: 0.875rem;
    font-weight: 500;
    border-radius: var(--radius);
    border: 1px solid var(--border);
    background-color: var(--card);
    color: var(--foreground);
    cursor: pointer;
    transition: background-color 0.2s ease, border-color 0.2s ease;
}

.button:hover {
    background-color: var(--accent);
    border-color: var(--muted-foreground);
}

.button-primary {
    background-color: var(--accent-red);
    color: white;
    border-color: var(--accent-red);
}

.button-primary:hover {
    background-color: var(--accent-red-hover);
    border-color: var(--accent-red-hover);
}

/* ============================================================================
   Divider
   ============================================================================ */

.divider {
    height: 1px;
    background-color: var(--border);
    margin: 2rem 0;
}

/* ============================================================================
   Sections
   ============================================================================ */

.section {
    margin-bottom: 2rem;
}

/* ============================================================================
   Cards
   ============================================================================ */

.card {
    padding: 1.5rem;
    background-color: var(--card);
    border: 1px solid var(--border);
    border-radius: var(--radius);
}

/* ============================================================================
   Empty State
   ============================================================================ */

.empty-state {
    text-align: center;
    padding: 3rem 1rem;
}

.empty-state p {
    margin: 0.5rem 0;
}

/* ============================================================================
   Error Page
   ============================================================================ */

.error-page {
    text-align: center;
    padding: 4rem 1rem;
    max-width: 500px;
    margin: 0 auto;
}

.error-icon {
    color: var(--muted-foreground);
    margin-bottom: 1.5rem;
}

.error-page h1 {
    margin-bottom: 1rem;
    font-size: 1.75rem;
}

.error-message {
    color: var(--muted-foreground);
    margin-bottom: 2rem;
    line-height: 1.6;
}

.error-actions {
    display: flex;
    gap: 1rem;
    justify-content: center;
    flex-wrap: wrap;
}

.error-page p {
    color: var(--muted-foreground);
    margin-bottom: 2rem;
}

/* ============================================================================
   Responsive
   ============================================================================ */

@media (max-width: 640px) {
    h1 {
        font-size: 1.5rem;
    }

    .nav {
        flex-direction: row;
    }

    .nav-tagline {
        display: none;
    }

    /* Push About link (and Profile after it) to the right */
    .nav-tagline + .nav-link {
        margin-left: auto;
    }

    .episode-meta {
        flex-direction: column;
        align-items: flex-start;
        gap: 0.25rem;
    }

    .meta-dot {
        display: none;
    }

    .button {
        width: 100%;
    }

    .episode-card {
        flex-direction: column;
        align-items: stretch;
        gap: 1rem;
    }

    .episode-card .button {
        width: auto;
        align-self: flex-start;
    }

    .episode-podcast {
        flex-direction: column;
        align-items: flex-start;
    }
}

/* ============================================================================
   Forms
   ============================================================================ */

.form {
    display: flex;
    flex-direction: column;
    gap: 1.5rem;
}

.form-group {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
}

.form-label {
    font-weight: 500;
    font-size: 0.875rem;
}

.form-help {
    font-size: 0.8rem;
    color: var(--muted-foreground);
    margin: 0;
}

.form-input {
    padding: 0.75rem 1rem;
    font-size: 0.875rem;
    font-family: var(--font-mono);
    background-color: var(--background);
    color: var(--foreground);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    transition: border-color 0.2s ease, box-shadow 0.2s ease;
}

.form-input::placeholder {
    color: var(--muted-foreground);
}

.form-input:focus {
    outline: none;
    border-color: var(--accent-red);
    box-shadow: 0 0 0 3px rgba(230, 57, 70, 0.15);
}

.form-actions {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding-top: 0.5rem;
}

/* ============================================================================
   Search Form
   ============================================================================ */

.search-form {
    display: flex;
    gap: 0.75rem;
    margin-bottom: 1.5rem;
}

.search-input-wrapper {
    position: relative;
    flex: 1;
}

.search-icon {
    position: absolute;
    left: 0.875rem;
    top: 50%;
    transform: translateY(-50%);
    color: var(--muted-foreground);
    pointer-events: none;
}

.search-input {
    width: 100%;
    padding: 0.75rem 1rem 0.75rem 2.75rem;
    font-size: 0.875rem;
    background-color: var(--background);
    color: var(--foreground);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    transition: border-color 0.2s ease, box-shadow 0.2s ease;
}

.search-input::placeholder {
    color: var(--muted-foreground);
}

.search-input:focus {
    outline: none;
    border-color: var(--accent-red);
    box-shadow: 0 0 0 3px rgba(230, 57, 70, 0.15);
}

.search-clear {
    position: absolute;
    right: 0.75rem;
    top: 50%;
    transform: translateY(-50%);
    width: 1.25rem;
    height: 1.25rem;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--muted-foreground);
    font-size: 1.25rem;
    line-height: 1;
    border-radius: 50%;
    transition: color 0.2s ease, background-color 0.2s ease;
}

.search-clear:hover {
    color: var(--foreground);
    background-color: var(--muted);
}

@media (max-width: 640px) {
    .search-form {
        flex-direction: column;
    }

    .search-form .button {
        width: 100%;
    }
}

/* ============================================================================
   Radio Group
   ============================================================================ */

.radio-group {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
}

.radio-option {
    display: flex;
    align-items: flex-start;
    gap: 0.75rem;
    padding: 1rem;
    background-color: var(--background);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    cursor: pointer;
    transition: background-color 0.2s ease, border-color 0.2s ease;
}

.radio-option:hover {
    background-color: var(--muted);
    border-color: var(--muted-foreground);
}

.radio-option input[type="radio"] {
    margin-top: 0.25rem;
    width: 1rem;
    height: 1rem;
    accent-color: var(--primary);
}

.radio-description {
    font-size: 0.75rem;
    color: var(--muted-foreground);
}

/* ============================================================================
   Alerts
   ============================================================================ */

.alert {
    display: flex;
    align-items: flex-start;
    gap: 0.75rem;
    padding: 1rem;
    font-size: 0.875rem;
    background-color: var(--muted);
    border: 1px solid var(--border);
    border-radius: var(--radius);
}

.alert svg {
    flex-shrink: 0;
    margin-top: 0.125rem;
}

.alert-info {
    background-color: rgba(59, 130, 246, 0.1);
    border-color: rgba(59, 130, 246, 0.3);
    color: #93c5fd;
}

.alert-info svg {
    color: #3b82f6;
}

.alert-error {
    background-color: rgba(220, 38, 38, 0.1);
    border-color: rgba(220, 38, 38, 0.3);
    color: #fca5a5;
}

.alert-error svg {
    color: #dc2626;
}

.alert-success {
    background-color: rgba(34, 197, 94, 0.1);
    border-color: rgba(34, 197, 94, 0.3);
    color: #86efac;
}

.alert-success svg {
    color: #22c55e;
}

.spinner {
    animation: spin 1s linear infinite;
}

@keyframes spin {
    from { transform: rotate(0deg); }
    to { transform: rotate(360deg); }
}

/* ============================================================================
   Pagination
   ============================================================================ */

.pagination {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 1rem;
    margin-top: 2rem;
    padding-top: 1.5rem;
    border-top: 1px solid var(--border);
}

.pagination-link {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    padding: 0.5rem 0.75rem;
    font-size: 0.875rem;
    font-weight: 500;
    color: var(--muted-foreground);
    border-radius: var(--radius);
    transition: color 0.2s ease, background-color 0.2s ease;
}

.pagination-link:hover:not(.pagination-disabled) {
    color: var(--foreground);
    background-color: var(--accent);
}

.pagination-disabled {
    opacity: 0.4;
    cursor: not-allowed;
}

.pagination-info {
    font-size: 0.875rem;
    color: var(--muted-foreground);
}

.podcast-author {
    font-size: 0.875rem;
    color: var(--muted-foreground);
}

/* ============================================================================
   Destructive Button
   ============================================================================ */

.button-destructive {
    background-color: var(--destructive);
    color: white;
    border-color: var(--destructive);
}

.button-destructive:hover {
    background-color: #b91c1c;
    border-color: #b91c1c;
}

.button-sm {
    padding: 0.375rem 0.75rem;
    font-size: 0.8125rem;
}

/* ============================================================================
   Modal
   ============================================================================ */

.modal {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1000;
}

.modal-backdrop {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background-color: rgba(0, 0, 0, 0.7);
}

.modal-content {
    position: relative;
    background-color: var(--card);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 1.5rem;
    max-width: 400px;
    width: 90%;
}

.modal-content h3 {
    margin-bottom: 0.75rem;
}

.modal-content p {
    color: var(--muted-foreground);
    margin-bottom: 1.5rem;
}

.modal-actions {
    display: flex;
    gap: 0.75rem;
    justify-content: flex-end;
}

.modal-content-large {
    max-width: 700px;
    max-height: 85vh;
    overflow-y: auto;
}

.summary-edit-item {
    margin-bottom: 1.5rem;
    padding-bottom: 1.5rem;
    border-bottom: 1px solid var(--border);
}

.summary-edit-item:last-child {
    margin-bottom: 0;
    padding-bottom: 0;
    border-bottom: none;
}

.summary-textarea {
    width: 100%;
    padding: 0.75rem;
    font-size: 0.875rem;
    font-family: var(--font-mono);
    line-height: 1.5;
    background-color: var(--background);
    color: var(--foreground);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    resize: vertical;
}

.summary-textarea:focus {
    outline: none;
    border-color: var(--accent-red);
    box-shadow: 0 0 0 3px rgba(230, 57, 70, 0.15);
}

/* ============================================================================
   Responsive - Forms
   ============================================================================ */

@media (max-width: 640px) {
    .form-actions {
        flex-direction: column;
    }

    .radio-option {
        padding: 0.875rem;
    }
}

/* ============================================================================
   Admin Dashboard
   ============================================================================ */

.admin-stats-grid {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 0.75rem;
    margin-bottom: 1rem;
}

.admin-stat-card {
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: 1rem;
    background-color: var(--card);
    border: 1px solid var(--border);
    border-radius: var(--radius);
}

.admin-stat-card.admin-stat-error .admin-stat-number {
    color: #ef4444;
}

.admin-stat-number {
    font-size: 1.5rem;
    font-weight: 700;
    line-height: 1.2;
    color: var(--foreground);
}

.admin-stat-label {
    font-size: 0.75rem;
    color: var(--muted-foreground);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    margin-top: 0.25rem;
}

.admin-quick-actions {
    display: flex;
    gap: 0.5rem;
    flex-wrap: wrap;
    align-items: center;
    margin-bottom: 1rem;
}

.admin-activity-section {
    margin-bottom: 1.5rem;
}

.activity-item {
    display: flex;
    align-items: flex-start;
    gap: 0.75rem;
    padding: 0.625rem 0;
    border-bottom: 1px solid var(--border);
}

.activity-item:last-child {
    border-bottom: none;
}

.activity-icon {
    flex-shrink: 0;
    width: 1.25rem;
    height: 1.25rem;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 50%;
    font-size: 0.75rem;
    font-weight: 700;
    line-height: 1;
}

.activity-icon-success {
    color: #22c55e;
}

.activity-icon-error {
    color: #ef4444;
}

.activity-icon-info {
    color: var(--muted-foreground);
}

.activity-content {
    flex: 1;
    min-width: 0;
}

.activity-title {
    font-size: 0.875rem;
    color: var(--foreground);
    display: block;
}

.activity-details {
    font-size: 0.75rem;
    color: var(--muted-foreground);
    display: block;
    margin-top: 0.125rem;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}

.activity-time {
    flex-shrink: 0;
    font-size: 0.75rem;
    color: var(--muted-foreground);
    white-space: nowrap;
}

.activity-clear-btn {
    flex-shrink: 0;
    background: none;
    border: none;
    color: var(--muted-foreground);
    cursor: pointer;
    padding: 0.125rem 0.25rem;
    font-size: 0.75rem;
    line-height: 1;
    border-radius: 0.25rem;
    transition: color 0.15s, background-color 0.15s;
}

.activity-clear-btn:hover {
    color: #ef4444;
    background-color: rgba(239, 68, 68, 0.1);
}

.activity-clear-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
}

@media (max-width: 640px) {
    .admin-stats-grid {
        grid-template-columns: repeat(2, 1fr);
    }

    .admin-quick-actions {
        flex-direction: column;
        align-items: stretch;
    }

    .admin-quick-actions .button {
        margin-left: 0 !important;
    }
}

/* ============================================================================
   Podcast Pages
   ============================================================================ */

.podcast-list {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
}

.podcast-card {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 1rem 1.25rem;
    background-color: var(--card);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    transition: border-color 0.2s ease, background-color 0.2s ease;
}

.podcast-card:hover {
    border-color: var(--muted-foreground);
    background-color: var(--accent);
}

.podcast-card-content {
    display: flex;
    align-items: center;
    gap: 1rem;
    flex: 1;
    min-width: 0;
}

.podcast-card-icon {
    flex-shrink: 0;
    width: 2.5rem;
    height: 2.5rem;
    display: flex;
    align-items: center;
    justify-content: center;
    background-color: var(--muted);
    border-radius: var(--radius);
    color: var(--muted-foreground);
}

.podcast-card-info {
    flex: 1;
    min-width: 0;
}

.podcast-card-name {
    font-size: 1rem;
    font-weight: 600;
    margin: 0 0 0.25rem 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.podcast-card:hover .podcast-card-name {
    color: var(--primary);
}

.podcast-card-author {
    font-size: 0.8125rem;
    color: var(--muted-foreground);
    margin-bottom: 0.25rem;
}

.podcast-card-meta {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.875rem;
    color: var(--muted-foreground);
}

.podcast-card-arrow {
    color: var(--muted-foreground);
    transition: transform 0.2s ease, color 0.2s ease;
}

.podcast-card:hover .podcast-card-arrow {
    color: var(--foreground);
    transform: translateX(4px);
}

/* Podcast Header (Individual Podcast Page) */

.podcast-header {
    margin-bottom: 1.5rem;
}

.podcast-header h1 {
    margin-bottom: 0.25rem;
}

/* Responsive - Podcast Pages */

@media (max-width: 640px) {
    .podcast-card-icon {
        display: none;
    }

    .podcast-card-meta {
        flex-direction: column;
        align-items: flex-start;
        gap: 0.125rem;
    }

    .podcast-card-meta .meta-dot {
        display: none;
    }
}
`;
