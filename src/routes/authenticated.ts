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
 * Middleware to validate authentication.
 * In production, Cloudflare Access adds CF-Access-Jwt-Assertion header.
 * FAIL-CLOSED: In production, requests without valid JWT are rejected.
 * For local dev, we skip auth checks.
 */
authenticated.use("*", async (c, next) => {
    // Check for Cloudflare Access JWT header
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

    await next();
});

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
