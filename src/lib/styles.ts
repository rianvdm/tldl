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
   Intro Section
   ============================================================================ */

.intro-section {
    margin-bottom: 2rem;
    padding: 1.25rem 1.5rem;
    background: linear-gradient(135deg, rgba(38, 38, 38, 0.5) 0%, rgba(23, 23, 23, 0.8) 100%);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    border-left: 3px solid var(--accent-red);
}

.intro-section p {
    font-size: 1.0625rem;
    line-height: 1.7;
    color: var(--muted-foreground);
    margin: 0;
}

/* ============================================================================
   Hero Section (Home Page)
   ============================================================================ */

.hero-section {
    text-align: center;
    margin-bottom: 2rem;
    padding: 2rem 1.5rem;
    background: linear-gradient(135deg, rgba(38, 38, 38, 0.5) 0%, rgba(23, 23, 23, 0.8) 100%);
    border: 1px solid var(--border);
    border-radius: var(--radius);
}

.hero-headline {
    font-size: 2.25rem;
    font-weight: 600;
    letter-spacing: -0.025em;
    line-height: 1.2;
    margin-bottom: 0.75rem;
    color: var(--foreground);
}

.hero-subtitle {
    font-size: 1rem;
    line-height: 1.6;
    color: var(--muted-foreground);
    margin: 0;
    max-width: 36rem;
    margin-left: auto;
    margin-right: auto;
}

/* ============================================================================
   Page Header
   ============================================================================ */

.page-header {
    margin-bottom: 2rem;
}

.page-header-with-action {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 1rem;
    margin-bottom: 2rem;
}

.page-header-with-action .page-header {
    margin-bottom: 0;
}

.page-subtitle {
    color: var(--muted-foreground);
    margin-top: 0.5rem;
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

.episode-card-arrow {
    flex-shrink: 0;
    width: 40px;
    height: 40px;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 50%;
    background-color: var(--accent);
    color: var(--muted-foreground);
    transition: color 0.2s ease, background-color 0.2s ease;
}

.episode-card:hover .episode-card-arrow {
    color: var(--foreground);
    background-color: var(--accent-red);
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

/* ============================================================================
   Episode Tags
   ============================================================================ */

.tag-badge {
    display: inline-flex;
    align-items: center;
    padding: 0.25rem 0.625rem;
    font-size: 0.75rem;
    font-weight: 500;
    background-color: rgba(59, 130, 246, 0.15);
    color: #60a5fa;
    border: 1px solid rgba(59, 130, 246, 0.3);
    border-radius: 9999px;
    transition: background-color 0.2s ease, border-color 0.2s ease, color 0.2s ease;
    cursor: pointer;
    text-decoration: none;
}

.tag-badge:hover {
    background-color: rgba(59, 130, 246, 0.25);
    border-color: rgba(59, 130, 246, 0.5);
    color: #93c5fd;
}

.tag-badge-selected {
    background-color: #3b82f6;
    color: white;
    border-color: #3b82f6;
}

.tag-badge-selected:hover {
    background-color: #2563eb;
    border-color: #2563eb;
}

.tag-filter-bar {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    margin-bottom: 1.5rem;
    padding: 1rem;
    background-color: var(--card);
    border: 1px solid var(--border);
    border-radius: var(--radius);
}

.tag-filter-label {
    font-size: 0.875rem;
    font-weight: 500;
    color: var(--muted-foreground);
    margin-right: 0.5rem;
    display: flex;
    align-items: center;
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
   Episode Detail
   ============================================================================ */

.breadcrumb {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.875rem;
    color: var(--muted-foreground);
    margin-bottom: 1.5rem;
}

.breadcrumb-link {
    transition: color 0.2s ease;
}

.breadcrumb-link:hover {
    color: var(--foreground);
}

.episode-header {
    margin-bottom: 1.5rem;
}

.episode-detail-title {
    margin-top: 0.5rem;
    margin-bottom: 0.75rem;
}

.expiry {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
}

/* ============================================================================
   Actions
   ============================================================================ */

.actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.75rem;
    margin-bottom: 1.5rem;
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

.button-accent {
    background-color: var(--accent-red);
    color: white;
    border-color: var(--accent-red);
}

.button-accent:hover {
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
   Tabs
   ============================================================================ */

.tabs {
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem;
    padding: 0.25rem;
    background-color: var(--muted);
    border-radius: var(--radius);
    margin-bottom: 1rem;
}

.tab {
    padding: 0.5rem 1rem;
    font-size: 0.875rem;
    font-weight: 500;
    color: var(--muted-foreground);
    border-radius: calc(var(--radius) - 2px);
    transition: background-color 0.2s ease, color 0.2s ease;
}

.tab:hover {
    color: var(--foreground);
}

.tab-active {
    background-color: var(--card);
    color: var(--foreground);
    box-shadow: inset 0 -2px 0 var(--accent-red);
}

/* ============================================================================
   Summary
   ============================================================================ */

.summary-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 1rem;
    padding-bottom: 1rem;
    border-bottom: 1px solid var(--border);
}

.summary-model {
    font-size: 0.875rem;
    color: var(--muted-foreground);
}

/* ============================================================================
   Prose (Markdown Content)
   ============================================================================ */

.prose {
    line-height: 1.7;
}

.prose h1,
.prose h2,
.prose h3,
.prose h4 {
    margin-top: 1.5em;
    margin-bottom: 0.75em;
}

.prose h1:first-child,
.prose h2:first-child,
.prose h3:first-child,
.prose h4:first-child {
    margin-top: 0;
}

.prose p {
    margin-bottom: 1em;
}

.prose strong {
    font-weight: 600;
}

.prose ul,
.prose ol {
    margin: 1em 0;
    padding-left: 1.5em;
}

.prose li {
    margin: 0.5em 0;
}

.prose code {
    background-color: var(--muted);
    padding: 0.2em 0.4em;
    border-radius: 0.25rem;
    font-size: 0.875em;
    font-family: var(--font-mono);
}

.prose pre {
    background-color: var(--muted);
    padding: 1rem;
    border-radius: var(--radius);
    overflow-x: auto;
    margin: 1em 0;
}

.prose pre code {
    background-color: transparent;
    padding: 0;
}

.prose blockquote {
    border-left: 4px solid var(--border);
    padding-left: 1rem;
    font-style: italic;
    margin: 1.5em 0;
    color: var(--muted-foreground);
}

/* ============================================================================
   Transcript
   ============================================================================ */

.transcript-source {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.875rem;
    color: var(--muted-foreground);
    margin-bottom: 1rem;
    padding-bottom: 1rem;
    border-bottom: 1px solid var(--border);
}

.source-indicator {
    width: 0.5rem;
    height: 0.5rem;
    border-radius: 50%;
    background-color: #22c55e;
}

.transcript-container {
    position: relative;
}

.transcript-container.collapsed {
    max-height: 24em;
    overflow: hidden;
}

.transcript-text {
    font-family: var(--font-mono);
    font-size: 0.8125rem;
    line-height: 1.8;
    white-space: pre-wrap;
    color: var(--muted-foreground);
}

.transcript-fade {
    position: absolute;
    bottom: 0;
    left: 0;
    right: 0;
    height: 6rem;
    background: linear-gradient(to bottom, transparent, var(--card));
    pointer-events: none;
}

.transcript-container:not(.collapsed) .transcript-fade {
    display: none;
}

.transcript-toggle {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.5rem;
    width: 100%;
    margin-top: 1rem;
    padding: 0.75rem 1rem;
    font-size: 0.875rem;
    font-weight: 500;
    color: var(--muted-foreground);
    background-color: var(--muted);
    border: none;
    border-radius: var(--radius);
    cursor: pointer;
    transition: color 0.2s ease, background-color 0.2s ease;
}

.transcript-toggle:hover {
    color: var(--foreground);
    background-color: var(--accent);
}

.transcript-toggle svg {
    transition: transform 0.2s ease;
}

/* ============================================================================
   Empty State
   ============================================================================ */

.empty-state {
    text-align: center;
    padding: 3rem 1rem;
}

.empty-state-icon {
    color: var(--muted-foreground);
    margin-bottom: 1rem;
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

    .page-header-with-action {
        flex-direction: column;
    }

    .page-header-with-action .button {
        width: 100%;
    }

    .episode-meta {
        flex-direction: column;
        align-items: flex-start;
        gap: 0.25rem;
    }

    .meta-dot {
        display: none;
    }

    .tabs {
        flex-direction: column;
    }

    .tab {
        width: 100%;
        text-align: center;
    }

    .actions {
        flex-direction: column;
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

    .podcast-author-inline {
        margin-left: 0 !important;
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

.form-hint {
    font-size: 0.75rem;
    color: var(--muted-foreground);
}

.form-fieldset {
    border: 0;
    border: none;
    padding: 0;
    margin: 0;
    min-width: 0;
}

.form-fieldset legend {
    padding: 0;
    margin-bottom: 0.75rem;
    border: 0;
    float: none;
    width: 100%;
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

.radio-content {
    flex: 1;
}

.radio-label {
    font-weight: 500;
    margin-bottom: 0.25rem;
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

/* ============================================================================
   Progress Bar
   ============================================================================ */

.progress-container {
    margin-bottom: 1.5rem;
}

.progress-bar {
    height: 0.5rem;
    background-color: var(--muted);
    border-radius: 9999px;
    overflow: hidden;
}

.progress-fill {
    height: 100%;
    background-color: var(--accent-red);
    border-radius: 9999px;
    transition: width 0.5s ease;
}

.progress-info {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-top: 0.5rem;
    font-size: 0.875rem;
    color: var(--muted-foreground);
}

.progress-percent {
    font-weight: 500;
}

.estimated-time {
    display: flex;
    align-items: center;
    gap: 0.375rem;
}

/* ============================================================================
   Steps (Job Status)
   ============================================================================ */

.steps {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    margin-bottom: 1.5rem;
}

.step {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.875rem 1rem;
    border-radius: var(--radius);
    transition: background-color 0.2s ease;
}

.step-complete {
    background-color: transparent;
    color: var(--muted-foreground);
}

.step-current {
    background-color: rgba(59, 130, 246, 0.1);
    color: var(--foreground);
}

.step-pending {
    background-color: transparent;
    color: var(--muted-foreground);
    opacity: 0.5;
}

.step-icon {
    flex-shrink: 0;
    width: 1.25rem;
    height: 1.25rem;
}

.step-icon-check {
    color: #22c55e;
}

.step-icon-spinner {
    width: 1.25rem;
    height: 1.25rem;
    border: 2px solid var(--muted);
    border-top-color: #3b82f6;
    border-radius: 50%;
    animation: spin 1s linear infinite;
}

.step-icon-empty {
    width: 1.25rem;
    height: 1.25rem;
    border: 2px solid var(--border);
    border-radius: 50%;
}

.step-label {
    font-size: 0.875rem;
    font-weight: 500;
}

.step-current .step-label {
    font-weight: 600;
}

@keyframes spin {
    from {
        transform: rotate(0deg);
    }
    to {
        transform: rotate(360deg);
    }
}

/* ============================================================================
   Utility Classes
   ============================================================================ */

.text-center {
    text-align: center;
}

.text-sm {
    font-size: 0.875rem;
}

.mt-4 {
    margin-top: 1rem;
}

.link-button {
    background: none;
    border: none;
    color: var(--muted-foreground);
    font-size: 0.875rem;
    text-decoration: underline;
    cursor: pointer;
    transition: color 0.2s ease;
}

.link-button:hover {
    color: var(--foreground);
}

/* ============================================================================
   In Progress Cards
   ============================================================================ */

.episode-card-progress {
    border-color: #3b82f6;
    border-style: dashed;
}

.episode-card-progress:hover {
    border-color: #60a5fa;
}

.status-indicator {
    display: inline-block;
    width: 0.5rem;
    height: 0.5rem;
    border-radius: 50%;
    margin-right: 0.375rem;
}

.status-indicator-active {
    background-color: #3b82f6;
    animation: pulse 2s infinite;
}

.episode-card-failed {
    border-color: var(--destructive);
    border-style: dashed;
}

.episode-card-failed:hover {
    border-color: #ef4444;
}

.status-indicator-failed {
    background-color: var(--destructive);
}

@keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.5; }
}

.spinner {
    animation: spin 1s linear infinite;
}

@keyframes spin {
    from { transform: rotate(0deg); }
    to { transform: rotate(360deg); }
}

.section-header {
    margin-bottom: 1rem;
}

.section-header h2 {
    margin-bottom: 0;
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

/* ============================================================================
   Platform Links
   ============================================================================ */

.platform-links {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 0.75rem;
    margin-top: 1rem;
}

.apple-podcasts-badge {
    display: inline-flex;
    opacity: 0.85;
    transition: opacity 0.2s ease;
}

.apple-podcasts-badge:hover {
    opacity: 1;
}

.apple-podcasts-badge img {
    height: 32px;
    width: auto;
}

.podcast-author {
    font-size: 0.875rem;
    color: var(--muted-foreground);
}

.podcast-author-inline {
    margin-left: 0.375rem;
}

.podcast-author-block {
    margin-top: 0.25rem;
}

.website-link {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.5rem 0.875rem;
    font-size: 0.8125rem;
    font-weight: 500;
    color: var(--muted-foreground);
    background-color: var(--muted);
    border-radius: var(--radius);
    transition: color 0.2s ease, background-color 0.2s ease;
}

.website-link:hover {
    color: var(--foreground);
    background-color: var(--accent);
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

.job-id {
    font-family: var(--font-mono);
    font-size: 0.75rem;
    background-color: var(--muted);
    padding: 0.125rem 0.375rem;
    border-radius: 0.25rem;
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
`;
