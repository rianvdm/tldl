/**
 * Authenticated API Routes
 * Protected endpoints for mutations - submit, regenerate, delete, job status
 * These will be protected by Cloudflare Access in production.
 */

import { Hono } from "hono";
import type { HonoEnv, Job } from "../types";
import {
    createJob,
    updateJobStatus,
    getEpisode,
    getTranscript,
    getSummary,
    deleteEpisode,
    listEpisodesByUser,
    listSummariesForEpisode,
} from "../lib/kv";
import {
    createJobDO,
    getJobWithFallback,
    updateJobStatusDO,
} from "../lib/job-status-do";
import {
    enqueueJob,
    createProcessEpisodeMessage,
    createRegenerateSummaryMessage,
} from "../lib/queue";
import { parseApplePodcastsUrl, deriveEpisodeId } from "../lib/url-parser";
import { isValidTemplateId } from "../lib/constants";
import { prefetchEpisodeInfo } from "../services/apple-podcasts";

const authenticated = new Hono<HonoEnv>();

// ============================================================================
// Rate Limiting Constants
// ============================================================================

const RATE_LIMIT_MAX_REQUESTS = 10;  // Max submissions per hour
const RATE_LIMIT_WINDOW_SECONDS = 3600;  // 1 hour

// ============================================================================
// Rate Limiting Helper
// ============================================================================

interface RateLimitData {
    count: number;
}

/**
 * Check and update rate limit for a user.
 * Returns the current count and whether the limit is exceeded.
 */
async function checkRateLimit(
    kv: KVNamespace,
    userEmail: string
): Promise<{ count: number; exceeded: boolean }> {
    const hour = Math.floor(Date.now() / (RATE_LIMIT_WINDOW_SECONDS * 1000));
    const key = `ratelimit:${userEmail}:${hour}`;

    const current = await kv.get<RateLimitData>(key, "json");
    const count = (current?.count || 0) + 1;

    // Update the count
    await kv.put(key, JSON.stringify({ count }), {
        expirationTtl: RATE_LIMIT_WINDOW_SECONDS,
    });

    return {
        count,
        exceeded: count > RATE_LIMIT_MAX_REQUESTS,
    };
}

/**
 * Add rate limit headers to response.
 */
function setRateLimitHeaders(
    c: { res: { headers: Headers } },
    count: number
): void {
    const hour = Math.floor(Date.now() / (RATE_LIMIT_WINDOW_SECONDS * 1000));
    c.res.headers.set("X-RateLimit-Limit", String(RATE_LIMIT_MAX_REQUESTS));
    c.res.headers.set("X-RateLimit-Remaining", String(Math.max(0, RATE_LIMIT_MAX_REQUESTS - count)));
    c.res.headers.set("X-RateLimit-Reset", String((hour + 1) * RATE_LIMIT_WINDOW_SECONDS));
}

// ============================================================================
// Middleware - Auth Check
// ============================================================================

/**
 * Extract user email from Cloudflare Access JWT.
 * CF Access validates the signature, we just decode the payload.
 */
function getUserEmailFromJwt(jwt: string): string | null {
    try {
        const payload = JSON.parse(atob(jwt.split(".")[1]));
        return payload.email || null;
    } catch {
        return null;
    }
}

/**
 * Auth check helper - validates JWT and extracts user email.
 * FAIL-CLOSED: In production, requests without valid JWT are rejected.
 * For local dev, we skip auth checks.
 * Returns null if auth passes, or a Response if auth fails.
 */
async function requireAuth(c: import("hono").Context<HonoEnv>): Promise<Response | null> {
    const cfAccessJwt = c.req.header("Cf-Access-Jwt-Assertion");
    const isDevelopment = c.env.ENVIRONMENT === "development";

    // FAIL-CLOSED: In production, reject requests without valid JWT
    if (!isDevelopment && !cfAccessJwt) {
        return c.json({ error: "Unauthorized" }, 401);
    }

    // Extract user email for rate limiting (if JWT present)
    if (cfAccessJwt) {
        const userEmail = getUserEmailFromJwt(cfAccessJwt);
        if (userEmail) {
            c.set("userEmail", userEmail);
        }
    }

    return null;
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Generate a UUID v4
 */
function generateUUID(): string {
    return crypto.randomUUID();
}

// ============================================================================
// Request/Response Types
// ============================================================================

interface SubmitRequest {
    appleUrl: string;
    templateId: string;
}

interface SubmitResponse {
    jobId: string;
    status: string;
    episodeId: string;
    cached: boolean;
}

interface JobStatusResponse {
    id: string;
    status: string;
    episodeId: string;
    estimatedSeconds?: number;
    error?: string;
    updatedAt: string;
}

interface RegenerateRequest {
    templateId: string;
}

interface RegenerateResponse {
    jobId: string;
    status: string;
    cached: boolean;
}

interface DeleteResponse {
    deleted: boolean;
}

interface RetryResponse {
    jobId: string;
    status: string;
}

// ============================================================================
// Helper Functions
// ============================================================================

function formatDuration(seconds: number): string {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    if (hours > 0) {
        return `${hours}h ${minutes}m`;
    }
    return `${minutes}m`;
}

function formatDate(dateString: string): string {
    const date = new Date(dateString);
    return new Intl.DateTimeFormat("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
    }).format(date);
}

function escapeHtml(text: string): string {
    return text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

// ============================================================================
// GET /profile - User Profile Page (shows submitted episodes with delete)
// ============================================================================

authenticated.get("/profile", async (c) => {
    // Auth check - reject unauthorized requests in production
    const authError = await requireAuth(c);
    if (authError) return authError;

    const userEmail = c.get("userEmail") || "Unknown User";

    // Get episodes submitted by this user
    const episodes = await listEpisodesByUser(c.env.TLDL_DATA, userEmail);

    // Build episode cards with delete buttons
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
                    </div>
                    <button type="button" class="button button-destructive button-sm" onclick="confirmDelete('${escapeHtml(episode.id)}', '${escapeHtml(episode.episodeTitle.replace(/'/g, "\\'"))}')">
                        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>
                        </svg>
                        Delete
                    </button>
                </div>
            `;
        })
    );

    const content = `
        <div class="page-header">
            <h1>Your Profile</h1>
            <p class="page-subtitle">${escapeHtml(userEmail)}</p>
        </div>

        <div class="divider"></div>

        <section class="section">
            <h2>Your Submitted Episodes</h2>
            ${episodes.length > 0 ? `
                <div class="episode-list">
                    ${episodeCards.join("")}
                </div>
            ` : `
                <div class="empty-state">
                    <p>You haven't submitted any episodes yet.</p>
                    <a href="/submit" class="button button-primary">Submit Your First Episode</a>
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

        <script>
            let deleteEpisodeId = null;

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

            async function doDelete() {
                if (!deleteEpisodeId) return;
                try {
                    const response = await fetch('/episode/' + deleteEpisodeId, {
                        method: 'DELETE',
                        headers: { 'Content-Type': 'application/json' }
                    });
                    if (response.ok) {
                        // Remove the card from the page
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
        </script>
    `;

    return c.html(`<!DOCTYPE html>
<html lang="en" class="dark">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Profile - TLDL</title>
    <link rel="stylesheet" href="/styles.css">
</head>
<body>
    <div class="container">
        <nav class="nav">
            <a href="/" class="nav-brand">TLDL</a>
            <span class="nav-tagline">Too Long Didn't Listen</span>
        </nav>
        <main class="main">
            ${content}
        </main>
        <footer class="footer">
            <p>AI-powered podcast summaries</p>
        </footer>
    </div>
</body>
</html>`);
});

// ============================================================================
// POST /submit - Submit new episode for processing (JSON API)
// This only handles JSON requests; form submissions fall through to public routes
// ============================================================================

authenticated.post("/submit", async (c, next) => {
    // Check if client is sending JSON
    const contentType = c.req.header("Content-Type") || "";

    // If not JSON, let the HTML form handler handle it
    if (!contentType.includes("application/json")) {
        return next();
    }

    // Auth check - reject unauthorized requests in production
    const authError = await requireAuth(c);
    if (authError) return authError;

    // Rate limiting check (only if user email is available)
    const userEmail = c.get("userEmail");
    if (userEmail) {
        const rateLimit = await checkRateLimit(c.env.TLDL_DATA, userEmail);
        setRateLimitHeaders(c, rateLimit.count);

        if (rateLimit.exceeded) {
            return c.json(
                { error: "Rate limit exceeded. Maximum 10 submissions per hour." },
                429
            );
        }
    }

    let body: SubmitRequest;
    try {
        body = await c.req.json<SubmitRequest>();
    } catch {
        return c.json({ error: "Invalid JSON body" }, 400);
    }

    const { appleUrl, templateId } = body;

    // Validate URL
    if (!appleUrl) {
        return c.json({ error: "Missing appleUrl field" }, 400);
    }

    const parsed = parseApplePodcastsUrl(appleUrl);
    if (!parsed) {
        return c.json(
            {
                error: "Please enter a valid Apple Podcasts episode URL. It should look like: podcasts.apple.com/...?i=...",
            },
            400
        );
    }

    // Validate template
    const effectiveTemplateId = templateId || c.env.DEFAULT_TEMPLATE;
    if (!isValidTemplateId(effectiveTemplateId)) {
        return c.json({ error: `Invalid template ID: ${templateId}` }, 400);
    }

    // Derive episode ID
    const episodeId = deriveEpisodeId(parsed.podcastId, parsed.episodeId);

    // Check if episode + template already exists (cached)
    const existingEpisode = await getEpisode(c.env.TLDL_DATA, episodeId);
    if (existingEpisode) {
        const existingSummary = await getSummary(
            c.env.TLDL_DATA,
            episodeId,
            effectiveTemplateId
        );
        if (existingSummary) {
            // Return cached result
            const response: SubmitResponse = {
                jobId: "",
                status: "completed",
                episodeId,
                cached: true,
            };
            return c.json(response);
        }
    }

    // Pre-fetch episode info (tries iTunes, then Apple redirect + Podcast Index)
    // This provides episodeGuid for reliable RSS matching
    const episodeInfo = await prefetchEpisodeInfo(parsed.podcastId, parsed.episodeId, c.env, appleUrl);

    console.log(JSON.stringify({
        event: "submit_prefetch_complete",
        podcastId: parsed.podcastId,
        episodeId: parsed.episodeId,
        episodeInfoFound: !!episodeInfo,
        episodeGuid: episodeInfo?.episodeGuid
    }));

    // Create new job
    const jobId = generateUUID();
    const now = new Date().toISOString();

    const job: Job = {
        id: jobId,
        episodeId,
        appleUrl,
        status: "queued",
        templateId: effectiveTemplateId,
        createdAt: now,
        updatedAt: now,
    };

    // Create job in both DO (immediate consistency) and KV (backup)
    await createJobDO(c.env, job);
    await createJob(c.env.TLDL_DATA, job);

    // Queue the job for processing with pre-fetched iTunes metadata
    const message = createProcessEpisodeMessage({
        jobId,
        episodeId,
        appleUrl,
        templateId: effectiveTemplateId,
        episodeGuid: episodeInfo?.episodeGuid,
        expectedTitle: episodeInfo?.trackName,
        expectedDate: episodeInfo?.releaseDate,
        submittedBy: userEmail,
    });
    await enqueueJob(c.env.TLDL_QUEUE, message);

    const response: SubmitResponse = {
        jobId,
        status: "queued",
        episodeId,
        cached: false,
    };

    return c.json(response, 201);
});

// GET /job/:jobId - Get job status (JSON API)
// This only handles JSON requests; HTML requests fall through to public routes
// ============================================================================

authenticated.get("/job/:jobId", async (c, next) => {
    // Check if client wants JSON (explicit Accept header or Content-Type: application/json)
    const accept = c.req.header("Accept") || "";
    const contentType = c.req.header("Content-Type") || "";

    // If not explicitly requesting JSON, let the HTML route handle it
    if (!accept.includes("application/json") && !contentType.includes("application/json")) {
        return next();
    }

    // Auth check - reject unauthorized requests in production
    const authError = await requireAuth(c);
    if (authError) return authError;

    const jobId = c.req.param("jobId");

    // Use DO with fallback to KV for job status
    const job = await getJobWithFallback(c.env, c.env.TLDL_DATA, jobId);
    if (!job) {
        return c.json({ error: "Job not found" }, 404);
    }

    const response: JobStatusResponse = {
        id: job.id,
        status: job.status,
        episodeId: job.episodeId,
        estimatedSeconds: job.estimatedSeconds,
        error: job.error,
        updatedAt: job.updatedAt,
    };

    return c.json(response);
});

// ============================================================================
// POST /episode/:episodeId/regenerate - Regenerate summary with different template
// ============================================================================

authenticated.post("/episode/:episodeId/regenerate", async (c) => {
    // Auth check - reject unauthorized requests in production
    const authError = await requireAuth(c);
    if (authError) return authError;

    // Rate limiting check (only if user email is available)
    const userEmail = c.get("userEmail");
    if (userEmail) {
        const rateLimit = await checkRateLimit(c.env.TLDL_DATA, userEmail);
        setRateLimitHeaders(c, rateLimit.count);

        if (rateLimit.exceeded) {
            return c.json(
                { error: "Rate limit exceeded. Maximum 10 submissions per hour." },
                429
            );
        }
    }

    const episodeId = c.req.param("episodeId");

    let body: RegenerateRequest;
    try {
        body = await c.req.json<RegenerateRequest>();
    } catch {
        return c.json({ error: "Invalid JSON body" }, 400);
    }

    const { templateId } = body;

    // Validate template
    if (!templateId) {
        return c.json({ error: "Missing templateId field" }, 400);
    }
    if (!isValidTemplateId(templateId)) {
        return c.json({ error: `Invalid template ID: ${templateId}` }, 400);
    }

    // Verify episode exists
    const episode = await getEpisode(c.env.TLDL_DATA, episodeId);
    if (!episode) {
        return c.json({ error: "Episode not found" }, 404);
    }

    // Verify transcript exists (required for regeneration)
    const transcript = await getTranscript(c.env.TLDL_DATA, episodeId);
    if (!transcript) {
        return c.json(
            { error: "Transcript not found. Cannot regenerate summary." },
            400
        );
    }

    // Check if summary already exists for this template
    const existingSummary = await getSummary(
        c.env.TLDL_DATA,
        episodeId,
        templateId
    );
    if (existingSummary) {
        const response: RegenerateResponse = {
            jobId: "",
            status: "completed",
            cached: true,
        };
        return c.json(response);
    }

    // Create regeneration job
    const jobId = generateUUID();
    const now = new Date().toISOString();

    const job: Job = {
        id: jobId,
        episodeId,
        appleUrl: episode.appleUrl,
        status: "queued",
        templateId,
        createdAt: now,
        updatedAt: now,
    };

    // Create job in both DO (immediate consistency) and KV (backup)
    await createJobDO(c.env, job);
    await createJob(c.env.TLDL_DATA, job);

    // Queue regeneration job
    const message = createRegenerateSummaryMessage({
        jobId,
        episodeId,
        appleUrl: episode.appleUrl,
        templateId,
    });
    await enqueueJob(c.env.TLDL_QUEUE, message);

    const response: RegenerateResponse = {
        jobId,
        status: "queued",
        cached: false,
    };

    return c.json(response, 201);
});

// ============================================================================
// DELETE /episode/:episodeId - Delete episode and all related data
// ============================================================================

authenticated.delete("/episode/:episodeId", async (c) => {
    // Auth check - reject unauthorized requests in production
    const authError = await requireAuth(c);
    if (authError) return authError;

    const episodeId = c.req.param("episodeId");

    // Verify episode exists
    const episode = await getEpisode(c.env.TLDL_DATA, episodeId);
    if (!episode) {
        return c.json({ error: "Episode not found" }, 404);
    }

    // Delete episode and all related data (transcript, summaries)
    await deleteEpisode(c.env.TLDL_DATA, episodeId);

    const response: DeleteResponse = {
        deleted: true,
    };

    return c.json(response);
});

// ============================================================================
// POST /job/:jobId/retry - Retry a failed job (JSON API)
// This only handles JSON requests; form submissions fall through to public routes
// ============================================================================

authenticated.post("/job/:jobId/retry", async (c, next) => {
    // Check if client wants JSON
    const accept = c.req.header("Accept") || "";
    const contentType = c.req.header("Content-Type") || "";

    // If not explicitly requesting JSON, let the HTML form handler handle it
    if (!accept.includes("application/json") && !contentType.includes("application/json")) {
        return next();
    }

    // Auth check - reject unauthorized requests in production
    const authError = await requireAuth(c);
    if (authError) return authError;

    const jobId = c.req.param("jobId");

    // Get existing job using DO with fallback
    const job = await getJobWithFallback(c.env, c.env.TLDL_DATA, jobId);
    if (!job) {
        return c.json({ error: "Job not found" }, 404);
    }

    // Verify job is in failed status
    if (job.status !== "failed") {
        return c.json(
            { error: `Cannot retry job with status: ${job.status}. Only failed jobs can be retried.` },
            400
        );
    }

    // Reset job status to queued in both DO and KV
    await updateJobStatusDO(c.env, jobId, "queued");
    await updateJobStatus(c.env.TLDL_DATA, jobId, "queued");

    // Re-queue the job
    // Determine message type based on whether it's a regeneration
    const existingEpisode = await getEpisode(c.env.TLDL_DATA, job.episodeId);
    const existingTranscript = await getTranscript(c.env.TLDL_DATA, job.episodeId);

    // If episode and transcript exist, treat as regeneration
    const messageType = existingEpisode && existingTranscript
        ? createRegenerateSummaryMessage
        : createProcessEpisodeMessage;

    const message = messageType({
        jobId,
        episodeId: job.episodeId,
        appleUrl: job.appleUrl,
        templateId: job.templateId,
    });
    await enqueueJob(c.env.TLDL_QUEUE, message);

    const response: RetryResponse = {
        jobId,
        status: "queued",
    };

    return c.json(response);
});

export default authenticated;
