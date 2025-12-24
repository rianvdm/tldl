/**
 * Authenticated API Routes
 * Protected endpoints for mutations - submit, regenerate, delete, job status
 * These will be protected by Cloudflare Access in production.
 */

import { Hono } from "hono";
import type { HonoEnv, Job, EpisodeIndexEntry } from "../types";
import { Layout } from "./public";
import {
    createJob,
    updateJobStatus,
    getEpisode,
    getTranscript,
    getSummary,
    deleteEpisode,
    listEpisodesByUser,
    listEpisodes,
    listSummariesForEpisode,
    rebuildEpisodeIndex,
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
import { isValidTemplateId, RATE_LIMITS, getValidTags, validateTags } from "../lib/constants";
import { updateEpisodeTags } from "../lib/kv";
import { prefetchEpisodeInfo } from "../services/apple-podcasts";
import { generateEpisodeTags } from "../services/tag-generation";
import { getUserEmailFromJwt, escapeHtml, isAdminUser } from "../lib/auth";

const authenticated = new Hono<HonoEnv>();

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
    const hour = Math.floor(Date.now() / (RATE_LIMITS.WINDOW_SECONDS * 1000));
    const key = `ratelimit:${userEmail}:${hour}`;

    const current = await kv.get<RateLimitData>(key, "json");
    const count = (current?.count || 0) + 1;

    // Update the count
    await kv.put(key, JSON.stringify({ count }), {
        expirationTtl: RATE_LIMITS.WINDOW_SECONDS,
    });

    return {
        count,
        exceeded: count > RATE_LIMITS.MAX_SUBMISSIONS_PER_HOUR,
    };
}

/**
 * Add rate limit headers to response.
 */
function setRateLimitHeaders(
    c: { res: { headers: Headers } },
    count: number
): void {
    const hour = Math.floor(Date.now() / (RATE_LIMITS.WINDOW_SECONDS * 1000));
    c.res.headers.set("X-RateLimit-Limit", String(RATE_LIMITS.MAX_SUBMISSIONS_PER_HOUR));
    c.res.headers.set("X-RateLimit-Remaining", String(Math.max(0, RATE_LIMITS.MAX_SUBMISSIONS_PER_HOUR - count)));
    c.res.headers.set("X-RateLimit-Reset", String((hour + 1) * RATE_LIMITS.WINDOW_SECONDS));
}

// ============================================================================
// Middleware - Auth Check
// ============================================================================

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

// escapeHtml imported from ../lib/auth

// ============================================================================
// POST /profile/rebuild-index - Admin-only: Rebuild episode index
// ============================================================================

authenticated.post("/profile/rebuild-index", async (c) => {
    // Auth check - reject unauthorized requests in production
    const authError = await requireAuth(c);
    if (authError) return authError;

    // Admin-only check
    const userEmail = c.get("userEmail");
    if (!isAdminUser(userEmail)) {
        return c.json({ error: "Admin access required" }, 403);
    }

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

// ============================================================================
// POST /profile/backfill-tags - Generate tags for episodes without them (admin only)
// ============================================================================

authenticated.post("/profile/backfill-tags", async (c) => {
    const authError = await requireAuth(c);
    if (authError) return authError;

    const userEmail = c.get("userEmail");
    if (!isAdminUser(userEmail)) {
        return c.json({ error: "Admin access required" }, 403);
    }

    try {
        // Get all episodes from index
        // Note: This processes up to 1000 episodes. If you have more,
        // consider implementing pagination or increasing the limit.
        const allEpisodes = await listEpisodes(c.env.TLDL_DATA, {
            pageSize: 1000
        });

        // Filter to episodes without tags
        const episodesNeedingTags = allEpisodes.episodes.filter(
            ep => !ep.tags || ep.tags.length === 0
        );

        let processed = 0;
        let tagged = 0;
        let failed = 0;

        // Process in batches
        for (const ep of episodesNeedingTags) {
            try {
                processed++;

                // Read existing data from KV
                const [transcript, summary] = await Promise.all([
                    getTranscript(c.env.TLDL_DATA, ep.id),
                    getSummary(c.env.TLDL_DATA, ep.id, "key-takeaways"), // Use default template
                ]);

                if (!transcript || !summary) {
                    console.log(`Skipping ${ep.id}: missing transcript or summary`);
                    failed++;
                    continue;
                }

                // Generate tags
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

                // Update episode with tags
                await updateEpisodeTags(c.env.TLDL_DATA, ep.id, tagResult.tags);
                tagged++;

                console.log(
                    JSON.stringify({
                        event: "episode_tagged",
                        episodeId: ep.id,
                        tags: tagResult.tags,
                    })
                );
            } catch (error) {
                console.error(
                    JSON.stringify({
                        event: "backfill_failed",
                        episodeId: ep.id,
                        error: error instanceof Error ? error.message : "Unknown error",
                    })
                );
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
        return c.json(
            {
                error: error instanceof Error ? error.message : "Failed to backfill tags",
            },
            500
        );
    }
});

// ============================================================================
// POST /profile/cleanup-invalid-tags - Remove tags that are no longer in EPISODE_TAGS
// ============================================================================

authenticated.post("/profile/cleanup-invalid-tags", async (c) => {
    const authError = await requireAuth(c);
    if (authError) return authError;

    const userEmail = c.get("userEmail");
    if (!isAdminUser(userEmail)) {
        return c.json({ error: "Admin access required" }, 403);
    }

    try {
        const validTags = getValidTags();

        // Get all episodes from index
        const allEpisodes = await listEpisodes(c.env.TLDL_DATA, {
            pageSize: 1000
        });

        let processed = 0;
        let cleaned = 0;

        // Process each episode that has tags
        for (const ep of allEpisodes.episodes) {
            if (!ep.tags || ep.tags.length === 0) continue;

            processed++;

            // Filter to only valid tags
            const cleanedTags = ep.tags.filter(tag => validTags.includes(tag));

            // Only update if tags changed
            if (cleanedTags.length !== ep.tags.length) {
                await updateEpisodeTags(c.env.TLDL_DATA, ep.id, cleanedTags);
                cleaned++;

                console.log(
                    JSON.stringify({
                        event: "tags_cleaned",
                        episodeId: ep.id,
                        before: ep.tags,
                        after: cleanedTags,
                    })
                );
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
        return c.json(
            {
                error: error instanceof Error ? error.message : "Failed to cleanup tags",
            },
            500
        );
    }
});

// ============================================================================
// POST /profile/backfill-podcast-info - Backfill podcast author and website for all episodes
// ============================================================================

authenticated.post("/profile/backfill-podcast-info", async (c) => {
    const authError = await requireAuth(c);
    if (authError) return authError;

    const userEmail = c.get("userEmail");
    if (!isAdminUser(userEmail)) {
        return c.json({ error: "Admin access required" }, 403);
    }

    try {
        const { lookupPodcastByItunesId } = await import("../services/podcast-index");
        const { parseApplePodcastsUrl } = await import("../lib/url-parser");
        const { getEpisode, saveEpisode } = await import("../lib/kv");

        // Get all episodes from index
        const allEpisodes = await listEpisodes(c.env.TLDL_DATA, {
            pageSize: 1000
        });

        let processed = 0;
        let updated = 0;
        let failed = 0;
        let alreadyHasInfo = 0;

        // Track podcasts we've already looked up (by podcastId)
        const podcastCache: Map<string, { author?: string; link?: string } | null> = new Map();

        for (const ep of allEpisodes.episodes) {
            processed++;

            try {
                // Get full episode data
                const episode = await getEpisode(c.env.TLDL_DATA, ep.id);
                if (!episode) {
                    failed++;
                    continue;
                }

                // Helper to detect RSS-like URLs that need cleaning
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

                // Skip if already has both author AND a clean website URL
                const hasCleanWebsiteUrl = episode.podcastWebsiteUrl &&
                    !needsUrlCleaning(episode.podcastWebsiteUrl);
                if (episode.podcastAuthor && hasCleanWebsiteUrl) {
                    alreadyHasInfo++;
                    continue;
                }

                // Parse the Apple URL to get podcast ID
                const parsed = parseApplePodcastsUrl(episode.appleUrl);
                if (!parsed) {
                    failed++;
                    continue;
                }

                // Check cache first
                let podcastInfo = podcastCache.get(parsed.podcastId);
                if (podcastInfo === undefined) {
                    // Not in cache - look up podcast
                    const podcast = await lookupPodcastByItunesId(
                        parsed.podcastId,
                        c.env.PODCAST_INDEX_KEY,
                        c.env.PODCAST_INDEX_SECRET
                    );

                    if (podcast) {
                        podcastInfo = { author: podcast.author, link: podcast.link };
                    } else {
                        podcastInfo = null;
                    }
                    podcastCache.set(parsed.podcastId, podcastInfo);
                }

                // Helper to clean RSS feed URLs to base website
                const cleanUrl = (url: string) => {
                    try {
                        const parsed = new URL(url);
                        const lowerPath = parsed.pathname.toLowerCase();
                        if (
                            lowerPath.endsWith('.xml') ||
                            lowerPath.endsWith('.rss') ||
                            lowerPath.endsWith('/feed') ||
                            lowerPath.endsWith('/feed/') ||
                            lowerPath.includes('/rss') ||
                            lowerPath.includes('/feed')
                        ) {
                            return parsed.origin;
                        }
                        return url;
                    } catch {
                        return url;
                    }
                };

                // Update episode if we got info
                if (podcastInfo && (podcastInfo.author || podcastInfo.link)) {
                    episode.podcastAuthor = podcastInfo.author;
                    episode.podcastWebsiteUrl = podcastInfo.link ? cleanUrl(podcastInfo.link) : undefined;
                    await saveEpisode(c.env.TLDL_DATA, episode);
                    updated++;

                    console.log(
                        JSON.stringify({
                            event: "podcast_info_backfilled",
                            episodeId: ep.id,
                            podcastAuthor: podcastInfo.author,
                            podcastWebsiteUrl: podcastInfo.link,
                        })
                    );
                }
            } catch (error) {
                console.error(
                    JSON.stringify({
                        event: "backfill_podcast_info_failed",
                        episodeId: ep.id,
                        error: error instanceof Error ? error.message : "Unknown error",
                    })
                );
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
        return c.json(
            {
                error: error instanceof Error ? error.message : "Failed to backfill podcast info",
            },
            500
        );
    }
});

// ============================================================================
// POST /profile/cleanup-failed-jobs - Admin-only: Clean up all failed jobs
// ============================================================================

authenticated.post("/profile/cleanup-failed-jobs", async (c) => {
    // Auth check - reject unauthorized requests in production
    const authError = await requireAuth(c);
    if (authError) return authError;

    // Admin-only check
    const userEmail = c.get("userEmail");
    if (!isAdminUser(userEmail)) {
        return c.json({ error: "Admin access required" }, 403);
    }

    try {
        const { listActiveJobsWithDO, deleteJobDO } = await import("../lib/job-status-do");

        const jobs = await listActiveJobsWithDO(c.env, c.env.TLDL_DATA);
        const failedJobs = jobs.filter(job => job.status === "failed");

        const deletedJobs = [];
        for (const job of failedJobs) {
            // Delete from both DO and KV
            await deleteJobDO(c.env, job.id);
            await c.env.TLDL_DATA.delete(`job:${job.id}`);
            deletedJobs.push({
                id: job.id,
                podcastName: job.podcastName,
                episodeTitle: job.episodeTitle,
                error: job.error
            });
        }

        return c.json({
            success: true,
            message: `Cleaned up ${deletedJobs.length} failed job${deletedJobs.length !== 1 ? 's' : ''}`,
            deletedCount: deletedJobs.length,
            deletedJobs
        });
    } catch (error) {
        return c.json({
            success: false,
            error: error instanceof Error ? error.message : "Unknown error",
        }, 500);
    }
});

// ============================================================================
// GET /profile - User Profile Page (shows submitted episodes with delete)
// ============================================================================

authenticated.get("/profile", async (c) => {
    // Auth check - reject unauthorized requests in production
    const authError = await requireAuth(c);
    if (authError) return authError;

    const userEmail = c.get("userEmail") || "Unknown User";
    const isAdmin = isAdminUser(userEmail === "Unknown User" ? undefined : userEmail);

    // Parse pagination for admin view
    const pageParam = c.req.query("page");
    const page = Math.max(1, parseInt(pageParam || "1", 10) || 1);
    const pageSize = 10;

    // Get episodes - admin sees all (paginated), regular users see only their own
    // Both EpisodeIndexEntry and Episode have the properties we need for display
    let episodes: EpisodeIndexEntry[];
    let totalPages = 1;

    if (isAdmin) {
        const result = await listEpisodes(c.env.TLDL_DATA, { page, pageSize });
        episodes = result.episodes;
        totalPages = result.totalPages;
    } else {
        // listEpisodesByUser returns Episode[], which extends EpisodeIndexEntry
        episodes = await listEpisodesByUser(c.env.TLDL_DATA, userEmail);
    }

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
                        ${isAdmin ? `
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
                        ` : episode.tags && episode.tags.length > 0 ? `
                        <div style="margin-top: 0.75rem;">
                            <span style="font-size: 0.75rem; color: var(--muted-foreground); margin-right: 0.5rem;">Tags:</span>
                            ${[...episode.tags].sort().map(tag => `<span class="badge">${escapeHtml(tag)}</span>`).join(' ')}
                        </div>
                        ` : ''}
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

    // Build pagination controls (only for admin with multiple pages)
    const paginationHtml = isAdmin && totalPages > 1 ? `
        <nav class="pagination" aria-label="Episode pagination">
            ${page > 1 ? `
            <a href="/profile?page=${page - 1}" class="pagination-link pagination-prev">
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
            <a href="/profile?page=${page + 1}" class="pagination-link pagination-next">
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

    const content = `
        <div class="page-header">
            <h1>Your Profile</h1>
            <p class="page-subtitle">${escapeHtml(userEmail)}${isAdmin ? ' <span class="badge">Admin</span>' : ''}</p>
            <a href="https://elezea.cloudflareaccess.com/cdn-cgi/access/logout?returnTo=https%3A%2F%2Ftldl-pod.com%2F%3FloggedOut%3D1" class="button button-secondary">Log Out</a>
        </div>

        <div class="divider"></div>

        ${isAdmin ? `
        <section class="section">
            <h2>Admin Tools</h2>
            <div class="admin-tools">
                <div class="admin-tool-item">
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
        <div class="divider"></div>
        ` : ""}

        <section class="section">
            <h2>${isAdmin ? 'All Episodes (Admin View)' : 'Your Submitted Episodes'}</h2>
            ${episodes.length > 0 ? `
                <div class="episode-list">
                    ${episodeCards.join("")}
                </div>
                ${paginationHtml}
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
        const response = await fetch('/profile/delete/' + deleteEpisodeId, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include'
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

function toggleTag(button, episodeId) {
    button.classList.toggle('selected');
}

async function saveTagsFor(episodeId) {
    const editor = document.querySelector('[data-episode-id="' + episodeId + '"] .tag-editor');
    const selectedButtons = editor.querySelectorAll('.tag-editor-badge.selected');
    const tags = Array.from(selectedButtons).map(btn => btn.getAttribute('data-tag'));
    const messageEl = document.getElementById('tag-message-' + episodeId);

    // Validate count
    if (tags.length < 1 || tags.length > 4) {
        messageEl.className = 'tag-editor-message alert-error';
        messageEl.textContent = 'Please select 1-4 tags (currently ' + tags.length + ' selected)';
        messageEl.style.display = 'block';
        return;
    }

    try {
        const response = await fetch('/profile/update-tags/' + episodeId, {
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
        const response = await fetch('/profile/rebuild-index', {
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
        const response = await fetch('/profile/cleanup-failed-jobs', {
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

    // Show loading state
    button.disabled = true;
    button.textContent = 'Processing...';
    statusEl.style.display = 'block';
    statusEl.className = 'alert alert-info';
    statusEl.textContent = 'Generating tags for episodes...';

    try {
        const response = await fetch('/profile/backfill-tags', {
            method: 'POST',
            credentials: 'include',
        });

        const data = await response.json();

        if (response.ok) {
            statusEl.className = 'alert alert-success';
            statusEl.textContent = 'Success! ' + data.message;

            // Reload page after 2 seconds to show new tags
            setTimeout(() => {
                window.location.reload();
            }, 2000);
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

    // Show loading state
    button.disabled = true;
    button.textContent = 'Processing...';
    statusEl.style.display = 'block';
    statusEl.className = 'alert alert-info';
    statusEl.textContent = 'Cleaning up invalid tags...';

    try {
        const response = await fetch('/profile/cleanup-invalid-tags', {
            method: 'POST',
            credentials: 'include',
        });

        const data = await response.json();

        if (response.ok) {
            statusEl.className = 'alert alert-success';
            statusEl.textContent = 'Success! ' + data.message;

            // Reload page after 2 seconds to show updated tags
            setTimeout(() => {
                window.location.reload();
            }, 2000);
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

    // Show loading state
    button.disabled = true;
    button.textContent = 'Fetching...';
    statusEl.style.display = 'block';
    statusEl.className = 'alert alert-info';
    statusEl.textContent = 'Fetching podcast info from Podcast Index API...';

    try {
        const response = await fetch('/profile/backfill-podcast-info', {
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
</script>
    `;

    return c.html(Layout({
        title: "Profile",
        children: content
    }));
});

// ============================================================================
// POST /profile/delete/:episodeId - Delete episode from profile page
// ============================================================================

authenticated.post("/profile/delete/:episodeId", async (c) => {
    // Auth check - reject unauthorized requests in production
    const authError = await requireAuth(c);
    if (authError) return authError;

    const episodeId = c.req.param("episodeId");
    const userEmail = c.get("userEmail");

    // Verify episode exists
    const episode = await getEpisode(c.env.TLDL_DATA, episodeId);
    if (!episode) {
        return c.json({ error: "Episode not found" }, 404);
    }

    // Check authorization: admin can delete any, regular users only their own
    const isAdmin = isAdminUser(userEmail);
    if (!isAdmin && episode.submittedBy && episode.submittedBy !== userEmail) {
        return c.json({ error: "You can only delete episodes you submitted" }, 403);
    }

    // Delete episode and all related data (transcript, summaries)
    await deleteEpisode(c.env.TLDL_DATA, episodeId);

    return c.json({ deleted: true });
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
        return c.json({ error: `Invalid template ID: ${templateId} ` }, 400);
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
// POST /profile/update-tags/:episodeId - Update episode tags (admin only)
// ============================================================================

authenticated.post("/profile/update-tags/:episodeId", async (c) => {
    // Auth check - reject unauthorized requests in production
    const authError = await requireAuth(c);
    if (authError) return authError;

    // Admin-only check
    const userEmail = c.get("userEmail");
    if (!isAdminUser(userEmail)) {
        return c.json({ error: "Admin access required" }, 403);
    }

    const episodeId = c.req.param("episodeId");

    // Parse request body
    let body: { tags: string[] };
    try {
        body = await c.req.json();
    } catch {
        return c.json({ error: "Invalid JSON body" }, 400);
    }

    if (!Array.isArray(body.tags)) {
        return c.json({ error: "tags must be an array" }, 400);
    }

    // Validate tags
    const validation = validateTags(body.tags);
    if (validation.invalid.length > 0) {
        return c.json({
            error: `Invalid tags: ${validation.invalid.join(', ')} `,
            validTags: getValidTags(),
        }, 400);
    }

    // Enforce 1-4 tags
    if (validation.valid.length < 1 || validation.valid.length > 4) {
        return c.json({
            error: "Must provide between 1 and 4 tags",
            provided: validation.valid.length,
        }, 400);
    }

    // Verify episode exists
    const episode = await getEpisode(c.env.TLDL_DATA, episodeId);
    if (!episode) {
        return c.json({ error: "Episode not found" }, 404);
    }

    // Update tags
    try {
        await updateEpisodeTags(c.env.TLDL_DATA, episodeId, validation.valid);
        return c.json({
            success: true,
            tags: validation.valid,
        });
    } catch (error) {
        return c.json({
            error: error instanceof Error ? error.message : "Failed to update tags",
        }, 500);
    }
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
        return c.json({ error: `Invalid template ID: ${templateId} ` }, 400);
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

    // Check authorization: admin can delete any, regular users only their own
    const userEmail = c.get("userEmail");
    const isAdmin = isAdminUser(userEmail);
    if (!isAdmin && episode.submittedBy && episode.submittedBy !== userEmail) {
        return c.json({ error: "You can only delete episodes you submitted" }, 403);
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
