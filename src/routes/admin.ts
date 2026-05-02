/**
 * Admin Routes
 * All routes are protected by Cloudflare Access (admin-only emails).
 * Mounted at /admin in index.ts.
 */

import { Hono } from "hono";
import type { HonoEnv, Job, MonitorSettings, Episode, Transcript, QueueMessage } from "../types";
import { Layout } from "./public";
import { AdminLayout } from "./admin/layout";
import { renderDashboardTab, renderEpisodesTab, renderSubscribersTab, renderMaintenanceTab, renderActivityTab } from "./admin/tabs";
import { formatRelativeTime, generateUUID, isValidUrl } from "./admin/utils";
import { listAllSubscribers, countSubscribers } from "../lib/db";
import {
    createJob,
    getEpisode,
    getTranscript,
    getSummary,
    saveEpisode,
    saveTranscript,
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
    saveMonitoredPodcast,
    deleteMonitoredPodcast,
    updateEpisodeTags,
    getActivityLog,
    removeActivityEvent,
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
import { parseApplePodcastsUrl, parsePodcastUrl, deriveEpisodeId, deriveManualEpisodeId } from "../lib/url-parser";
import { isValidTemplateId, getValidTags, validateTags, TEMPLATES, isBlockedPodcast } from "../lib/constants";
import { prefetchEpisodeInfo } from "../services/apple-podcasts";
import { resolveAudioUrl } from "../services/transcription";
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
// Helper functions live in ./admin/utils.ts (imported above).
// ============================================================================

// ============================================================================
// GET / - Admin Dashboard (tabbed: dashboard | episodes | subscribers | activity | maintenance)
// ============================================================================

function renderTabError(activeTab: string, err: unknown): string {
    const message = err instanceof Error ? err.message : String(err);
    return `<div class="alert alert-error" style="margin-top: 1rem;">
        <strong>Failed to load ${escapeHtml(activeTab)} tab.</strong><br>
        ${escapeHtml(message)}
    </div>`;
}

admin.get("/", async (c) => {
    const authError = await requireAdmin(c);
    if (authError) return authError;

    const userEmail = c.get("userEmail") || "Unknown User";
    const tabParam = c.req.query("tab") || "dashboard";
    const validTabs = ["dashboard", "episodes", "subscribers", "activity", "maintenance"] as const;
    type Tab = typeof validTabs[number];
    const activeTab: Tab = (validTabs as readonly string[]).includes(tabParam) ? (tabParam as Tab) : "dashboard";

    const MAX_PAGE = 10000;
    const pageRaw = parseInt(c.req.query("page") || "1", 10) || 1;
    const page = Math.min(MAX_PAGE, Math.max(1, pageRaw));

    let title = "Admin";
    let body = "";

    try {
        if (activeTab === "dashboard") {
            const [podcasts, activityLog, activeJobs, episodeCount, monitoredPodcasts] = await Promise.all([
                getPodcastList(c.env.TLDL_DATA),
                getActivityLog(c.env.TLDL_DATA, 8),
                listActiveJobsWithDO(c.env, c.env.TLDL_DATA),
                listEpisodes(c.env.TLDL_DATA, { page: 1, pageSize: 1 }),
                listMonitoredPodcasts(c.env.TLDL_DATA),
            ]);
            const errorCount = monitoredPodcasts.filter(p => p.status === "error").length;
            const lastChecked = monitoredPodcasts.reduce((latest, p) => {
                if (!p.lastChecked) return latest;
                return !latest || p.lastChecked > latest ? p.lastChecked : latest;
            }, "" as string);
            title = "Dashboard";
            body = renderDashboardTab({
                totalEpisodes: episodeCount.total,
                totalPodcasts: podcasts.length,
                errorCount,
                lastChecked,
                activeJobsCount: activeJobs.length,
                activityLog,
            });
        } else if (activeTab === "episodes") {
            const pageSize = 10;
            const result = await listEpisodes(c.env.TLDL_DATA, { page, pageSize });
            // Template badges come straight from the index entry (templateIds is
            // denormalized at write-time), so no per-episode fan-out here.
            const episodes = result.episodes.map((episode) => {
                const templateBadges = (episode.templateIds ?? [])
                    .map((id) => `<span class="badge">${escapeHtml(id)}</span>`)
                    .join("");
                return { ...episode, templateBadges };
            });
            title = "Episodes";
            body = renderEpisodesTab({ episodes, page, totalPages: result.totalPages });
        } else if (activeTab === "subscribers") {
            const [subscribers, counts] = await Promise.all([
                listAllSubscribers(c.env.DB),
                countSubscribers(c.env.DB),
            ]);
            title = "Subscribers";
            body = renderSubscribersTab({ subscribers, counts });
        } else if (activeTab === "activity") {
            const activityLog = await getActivityLog(c.env.TLDL_DATA);
            title = "Activity";
            body = renderActivityTab(activityLog);
        } else {
            title = "Maintenance";
            body = renderMaintenanceTab();
        }
    } catch (err) {
        console.error(`admin tab "${activeTab}" failed:`, err);
        title = "Admin";
        body = renderTabError(activeTab, err);
    }

    return c.html(AdminLayout({
        title,
        activeTab,
        userEmail,
        children: body,
    }));
});


// ============================================================================
// GET /activity - Full activity log
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
            <p class="page-subtitle">Paste an Apple Podcasts episode URL to generate a summary.</p>
            <a href="/admin" class="button button-secondary">← Back to Dashboard</a>
        </div>

        <div class="divider"></div>

        <form method="POST" action="/admin/submit" class="card" style="display: flex; flex-direction: column; gap: 1.5rem;">
            <div class="form-group">
                <label class="form-label" for="appleUrl">Apple Podcasts Episode URL</label>
                <input type="url" id="appleUrl" name="appleUrl" class="form-input"
                    placeholder="https://podcasts.apple.com/us/podcast/...?i=..." required />
                <p class="form-help">Paste the full URL of an episode from Apple Podcasts</p>
            </div>

            <div class="form-group">
                <label class="form-label">Summary Style</label>
                <div class="radio-group">
                    ${templateOptions}
                </div>
            </div>

            <details style="margin-top: 0.5rem;">
                <summary style="cursor: pointer; font-size: 0.8rem; color: var(--muted-foreground);">Advanced options</summary>
                <div class="form-group" style="margin-top: 0.75rem;">
                    <label class="form-label" for="audioUrl">Audio URL (override)</label>
                    <input type="url" id="audioUrl" name="audioUrl" class="form-input"
                        placeholder="https://substackcdn.com/..." />
                    <p class="form-help">Optional. Direct CDN URL to bypass rate-limited origins.</p>
                </div>
            </details>

            <button type="submit" class="button button-primary">Submit Episode</button>
        </form>
    `;

    return c.html(AdminLayout({
        title: "Submit Episode",
        activeTab: "episodes",
        userEmail: c.get("userEmail") || "Unknown User",
        children: content,
    }));
});

// ============================================================================
// GET /submit-manual - Manual transcript submission form
// ============================================================================

admin.get("/submit-manual", async (c) => {
    const authError = await requireAdmin(c);
    if (authError) return authError;

    const content = `
        <div class="page-header">
            <h1>Submit Transcript</h1>
            <p class="page-subtitle">Upload a transcript manually when an episode can't be processed via Apple Podcasts URL.</p>
            <a href="/admin" class="button button-secondary">← Back to Dashboard</a>
        </div>

        <div class="divider"></div>

        <form method="POST" action="/admin/submit-manual" enctype="multipart/form-data" class="card" style="display: flex; flex-direction: column; gap: 1.5rem;">
            <p class="form-help">
                Use this form for transcripts that can't be processed via an Apple Podcasts URL.
                Only the title and a transcript (file or pasted text) are required — everything else is optional.
            </p>

            <div class="form-group">
                <label class="form-label" for="title">Episode Title</label>
                <input type="text" id="title" name="title" class="form-input" maxlength="300" required />
            </div>

            <div class="form-group">
                <label class="form-label" for="transcriptFile">Transcript File</label>
                <input type="file" id="transcriptFile" name="transcriptFile" class="form-input" accept=".txt,text/plain" />
                <p class="form-help">Upload a .txt file, or paste the transcript below.</p>
            </div>

            <div class="form-group">
                <label class="form-label" for="transcript">Transcript Text</label>
                <textarea id="transcript" name="transcript" class="form-input" rows="10" placeholder="Paste transcript text here..."></textarea>
            </div>

            <fieldset style="border: 1px solid var(--border); border-radius: 0.5rem; padding: 1rem; display: flex; flex-direction: column; gap: 1rem;">
                <legend style="padding: 0 0.5rem; font-weight: 600;">Optional metadata</legend>

                <div class="form-group">
                    <label class="form-label" for="podcastId">Podcast ID</label>
                    <input type="text" id="podcastId" name="podcastId" class="form-input" />
                </div>

                <div class="form-group">
                    <label class="form-label" for="podcastName">Podcast Name</label>
                    <input type="text" id="podcastName" name="podcastName" class="form-input" />
                </div>

                <div class="form-group">
                    <label class="form-label" for="pubDate">Publication Date</label>
                    <input type="date" id="pubDate" name="pubDate" class="form-input" />
                </div>

                <div class="form-group">
                    <label class="form-label" for="episodeUrl">Episode URL</label>
                    <input type="url" id="episodeUrl" name="episodeUrl" class="form-input" />
                </div>

                <div class="form-group">
                    <label class="form-label" for="durationMinutes">Duration (minutes)</label>
                    <input type="number" id="durationMinutes" name="durationMinutes" class="form-input" min="1" max="600" />
                </div>

                <div class="form-group">
                    <label class="form-label" for="description">Description</label>
                    <textarea id="description" name="description" class="form-input" rows="3"></textarea>
                </div>

                <div class="form-group">
                    <label class="form-label" for="imageUrl">Image URL</label>
                    <input type="url" id="imageUrl" name="imageUrl" class="form-input" />
                </div>
            </fieldset>

            <button type="submit" class="button button-primary">Submit Transcript</button>
        </form>
    `;

    return c.html(AdminLayout({
        title: "Submit Transcript",
        activeTab: "episodes",
        userEmail: c.get("userEmail") || "Unknown User",
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
    let appleUrl: string;
    let templateId: string;
    let audioUrlOverride: string | undefined;

    if (contentType.includes("application/json")) {
        const body = await c.req.json<{ appleUrl: string; templateId: string; audioUrl?: string }>();
        appleUrl = body.appleUrl;
        templateId = body.templateId;
        audioUrlOverride = body.audioUrl || undefined;
    } else {
        const formData = await c.req.parseBody();
        appleUrl = formData.appleUrl as string;
        templateId = formData.templateId as string;
        audioUrlOverride = (formData.audioUrl as string) || undefined;
    }

    // Validate URL
    if (!appleUrl) {
        return c.html(Layout({
            title: "Error",
            children: `<div class="alert alert-error">Please enter an Apple Podcasts URL.</div><a href="/admin/submit" class="button">Try Again</a>`,
        }));
    }

    const parsed = parseApplePodcastsUrl(appleUrl);
    if (!parsed) {
        return c.html(Layout({
            title: "Error",
            children: `<div class="alert alert-error">Invalid Apple Podcasts episode URL. It should look like: podcasts.apple.com/...?i=...</div><a href="/admin/submit" class="button">Try Again</a>`,
        }));
    }

    // Check blocked podcasts (creator opt-outs)
    if (isBlockedPodcast(appleUrl)) {
        return c.html(Layout({
            title: "Error",
            children: `<div class="alert alert-error">This podcast has opted out of TLDL.</div><a href="/admin/submit" class="button">Try Again</a>`,
        }));
    }

    // Validate template
    const effectiveTemplateId = templateId || c.env.DEFAULT_TEMPLATE;
    if (!isValidTemplateId(effectiveTemplateId)) {
        return c.html(Layout({
            title: "Error",
            children: `<div class="alert alert-error">Invalid summary template.</div><a href="/admin/submit" class="button">Try Again</a>`,
        }));
    }

    // Derive episode ID
    const episodeId = deriveEpisodeId(parsed.podcastId, parsed.episodeId);

    // Check cache
    const existingEpisode = await getEpisode(c.env.TLDL_DATA, episodeId);
    if (existingEpisode) {
        const existingSummary = await getSummary(c.env.TLDL_DATA, episodeId, effectiveTemplateId);
        if (existingSummary) {
            // Redirect to existing episode
            return c.redirect(`/episode/${episodeId}`);
        }
    }

    // Pre-fetch episode info
    const episodeInfo = await prefetchEpisodeInfo(parsed.podcastId, parsed.episodeId, c.env, appleUrl);

    console.log(JSON.stringify({
        event: "admin_submit_prefetch_complete",
        podcastId: parsed.podcastId,
        episodeId: parsed.episodeId,
        episodeInfoFound: !!episodeInfo,
        episodeGuid: episodeInfo?.episodeGuid,
    }));

    // Create job
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

    await createJobDO(c.env, job);
    await createJob(c.env.TLDL_DATA, job);

    // Pre-resolve audio URL redirects while in request handler context.
    // Queue consumers can't fetch some CDNs (Podbean, etc.) because the destination
    // Cloudflare WAF blocks server-originated requests without a connecting IP.
    // Resolving here follows the 302 → final CDN URL which may bypass the WAF.
    let preResolvedAudioUrl: string | undefined;
    if (audioUrlOverride) {
        const resolved = await resolveAudioUrl(audioUrlOverride);
        if (resolved !== audioUrlOverride) {
            preResolvedAudioUrl = resolved;
            console.log(JSON.stringify({
                event: "admin_preresolve_audio_url",
                original: audioUrlOverride,
                resolved,
            }));
        }
    }

    const message = createProcessEpisodeMessage({
        jobId,
        episodeId,
        appleUrl,
        templateId: effectiveTemplateId,
        episodeGuid: episodeInfo?.episodeGuid,
        expectedTitle: episodeInfo?.trackName,
        expectedDate: episodeInfo?.releaseDate,
        audioUrlOverride,
        preResolvedAudioUrl,
    });
    await enqueueJob(c.env.TLDL_QUEUE, message);

    // Redirect to admin dashboard (job shows as in-progress on home page)
    return c.redirect("/admin");
});

// ============================================================================
// POST /submit-manual - Process manual transcript submission
// ============================================================================

admin.post("/submit-manual", async (c) => {
    const authError = await requireAdmin(c);
    if (authError) return authError;

    const form = await c.req.formData();

    const getStr = (name: string): string => {
        const v = form.get(name);
        return typeof v === "string" ? v.trim() : "";
    };

    const title = getStr("title");
    const pastedTranscript = getStr("transcript");
    const podcastId = getStr("podcastId");
    const podcastName = getStr("podcastName");
    const pubDate = getStr("pubDate");
    const episodeUrl = getStr("episodeUrl");
    const imageUrl = getStr("imageUrl");
    const durationRaw = getStr("durationMinutes");

    // Transcript: prefer uploaded file if it has content, otherwise pasted text.
    let transcriptText = pastedTranscript;
    const transcriptFile = form.get("transcriptFile");
    if (transcriptFile instanceof File && transcriptFile.size > 0) {
        transcriptText = (await transcriptFile.text()).trim();
    }

    const errors: string[] = [];

    if (!title) {
        errors.push("Episode title is required.");
    } else if (title.length > 300) {
        errors.push("Episode title must be 300 characters or fewer.");
    }

    if (!transcriptText) {
        errors.push("Transcript is required (paste text or upload a .txt file).");
    } else if (transcriptText.length < 200) {
        errors.push("Transcript must be at least 200 characters.");
    } else if (transcriptText.length > 500_000) {
        errors.push("Transcript must be 500,000 characters or fewer.");
    }

    if (podcastId && !/^[a-zA-Z0-9_-]+$/.test(podcastId)) {
        errors.push("Podcast ID must only contain letters, numbers, hyphens, or underscores.");
    }

    if (pubDate && Number.isNaN(Date.parse(pubDate))) {
        errors.push("Publication date is not a valid date.");
    }

    if (episodeUrl && !isValidUrl(episodeUrl)) {
        errors.push("Episode URL is not a valid URL.");
    }

    if (imageUrl && !isValidUrl(imageUrl)) {
        errors.push("Cover image URL is invalid.");
    }

    let durationSeconds = 0;
    if (durationRaw) {
        const minutes = Number(durationRaw);
        if (!Number.isInteger(minutes) || minutes < 1 || minutes > 600) {
            errors.push("Duration must be an integer between 1 and 600 minutes.");
        } else {
            durationSeconds = minutes * 60;
        }
    }

    if (errors.length > 0) {
        const errorList = errors.map((e) => `<li>${escapeHtml(e)}</li>`).join("");
        return c.html(
            Layout({
                title: "Submission Error",
                children: `
                    <div class="alert alert-error">
                        <strong>Please fix the following:</strong>
                        <ul>${errorList}</ul>
                    </div>
                    <a href="/admin/submit-manual" class="button">Back to Form</a>
                `,
            }),
            400
        );
    }

    // Derive episode ID
    const episodeId = deriveManualEpisodeId(title, podcastId || undefined);

    // Collision check
    const existing = await getEpisode(c.env.TLDL_DATA, episodeId);
    if (existing) {
        return c.html(
            Layout({
                title: "Episode Already Exists",
                children: `
                    <div class="alert alert-error">An episode with this ID already exists: ${escapeHtml(episodeId)}</div>
                    <a href="/admin/submit-manual" class="button">Back to Form</a>
                `,
            }),
            409
        );
    }

    const submittedBy = c.get("userEmail");
    const now = new Date();
    const nowIso = now.toISOString();
    const expiresAt = new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000).toISOString();
    const episodeDate = pubDate ? new Date(pubDate).toISOString().slice(0, 10) : nowIso.slice(0, 10);

    const episode: Episode = {
        id: episodeId,
        appleUrl: episodeUrl || "",
        podcastName: podcastName || "Manual upload",
        episodeTitle: title,
        episodeDuration: durationSeconds,
        episodeDate,
        audioUrl: "",
        transcriptSource: "manual",
        createdAt: nowIso,
        expiresAt,
        ...(submittedBy && { submittedBy }),
    };

    await saveEpisode(c.env.TLDL_DATA, episode);

    const transcript: Transcript = {
        episodeId,
        text: transcriptText,
        source: "manual",
        createdAt: nowIso,
    };
    await saveTranscript(c.env.TLDL_DATA, transcript);

    // Create job record
    const jobId = generateUUID();
    const templateId = c.env.DEFAULT_TEMPLATE || "key-takeaways";
    const job: Job = {
        id: jobId,
        episodeId,
        appleUrl: episodeUrl || "",
        status: "queued",
        templateId,
        podcastName: episode.podcastName,
        episodeTitle: episode.episodeTitle,
        createdAt: nowIso,
        updatedAt: nowIso,
    };
    await createJobDO(c.env, job);
    await createJob(c.env.TLDL_DATA, job);

    // Enqueue message for background processing
    const msg: QueueMessage = {
        type: "process_manual",
        jobId,
        episodeId,
        templateId,
        ...(submittedBy && { submittedBy }),
    };
    await enqueueJob(c.env.TLDL_QUEUE, msg);

    return c.redirect("/admin", 303);
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
        appleUrl: episode.appleUrl,
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
        appleUrl: episode.appleUrl,
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
// DELETE /activity/:episodeId - Clear a failed job and its activity log entry
// ============================================================================

admin.delete("/activity/:episodeId", async (c) => {
    const authError = await requireAdmin(c);
    if (authError) return authError;

    const episodeId = c.req.param("episodeId");

    try {
        // Find the failed job by episodeId
        const jobs = await listActiveJobsWithDO(c.env, c.env.TLDL_DATA);
        const failedJob = jobs.find(
            (j) => j.episodeId === episodeId && j.status === "failed"
        );

        // Delete the job if it still exists
        if (failedJob) {
            await deleteJobDO(c.env, failedJob.id);
            await deleteJob(c.env.TLDL_DATA, failedJob.id);
        }

        // Always remove the activity log entry (job may have expired via TTL)
        await removeActivityEvent(c.env.TLDL_DATA, episodeId);

        return c.json({ success: true });
    } catch (error) {
        return c.json({
            success: false,
            error: error instanceof Error ? error.message : "Unknown error",
        }, 500);
    }
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

                const parsedUrl = parseUrl(episode.appleUrl);
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

// POST /backfill-episode-apple-urls
// Fills in per-episode canonical Apple URLs (`?i={piEpisodeId}`) and cleaned
// podcast website URLs for episodes ingested via the RSS-only cron path,
// which previously stored only a podcast-level Apple URL or none at all.
admin.post("/backfill-episode-apple-urls", async (c) => {
    const authError = await requireAdmin(c);
    if (authError) return authError;

    try {
        const { lookupPodcastByItunesId, getEpisodesByItunesId, findEpisodeByAppleId } = await import("../services/podcast-index");
        const { extractPodcastId } = await import("../lib/url-parser");

        const allEpisodes = await listEpisodes(c.env.TLDL_DATA, { pageSize: 1000 });

        let processed = 0;
        let updated = 0;
        let skippedAlreadySet = 0;
        let skippedNoMatch = 0;
        let skippedNonNumericPodcast = 0;
        let failed = 0;

        const podcastInfoCache: Map<string, { author?: string; link?: string } | null> = new Map();
        const piEpisodesCache: Map<string, Awaited<ReturnType<typeof getEpisodesByItunesId>>> = new Map();

        // Podcast-level fallback URL shape produced by consumer.ts when no
        // per-episode anchor is known: https://podcasts.apple.com/us/podcast/id{digits}
        const podcastLevelOnlyRe = /^https:\/\/podcasts\.apple\.com\/[^/]+\/podcast\/id\d+\/?$/i;

        const isFeedShapedUrl = (url: string): boolean => {
            try {
                const lowerPath = new URL(url).pathname.toLowerCase();
                return (
                    lowerPath.endsWith('.xml') ||
                    lowerPath.endsWith('.rss') ||
                    lowerPath.endsWith('/feed') ||
                    lowerPath.endsWith('/feed/') ||
                    lowerPath.includes('/rss') ||
                    lowerPath.includes('/feed')
                );
            } catch {
                return false;
            }
        };

        const cleanWebsiteUrl = (url: string): string => {
            try {
                const u = new URL(url);
                return isFeedShapedUrl(url) ? u.origin : url;
            } catch {
                return url;
            }
        };

        for (const ep of allEpisodes.episodes) {
            processed++;

            try {
                const episode = await getEpisode(c.env.TLDL_DATA, ep.id);
                if (!episode) {
                    failed++;
                    continue;
                }

                const needsAppleUrl =
                    !episode.appleUrl ||
                    podcastLevelOnlyRe.test(episode.appleUrl);
                const needsWebsite =
                    !episode.podcastWebsiteUrl ||
                    isFeedShapedUrl(episode.podcastWebsiteUrl);

                if (!needsAppleUrl && !needsWebsite) {
                    skippedAlreadySet++;
                    continue;
                }

                const podcastId = extractPodcastId(episode.id);
                if (!podcastId || !/^\d+$/.test(podcastId)) {
                    skippedNonNumericPodcast++;
                    continue;
                }

                let nextAppleUrl = episode.appleUrl;
                let nextWebsite = episode.podcastWebsiteUrl;

                if (needsAppleUrl) {
                    let piEpisodes = piEpisodesCache.get(podcastId);
                    if (piEpisodes === undefined) {
                        piEpisodes = await getEpisodesByItunesId(
                            podcastId,
                            c.env.PODCAST_INDEX_KEY,
                            c.env.PODCAST_INDEX_SECRET
                        );
                        piEpisodesCache.set(podcastId, piEpisodes);
                    }

                    const appleEpIdSuffix = episode.id.slice(podcastId.length + 1);
                    const match = findEpisodeByAppleId(
                        piEpisodes,
                        appleEpIdSuffix,
                        episode.episodeTitle,
                        episode.episodeDate
                    );

                    if (match) {
                        nextAppleUrl = `https://podcasts.apple.com/us/podcast/podcast/id${podcastId}?i=${match.id}`;
                    }
                }

                if (needsWebsite) {
                    let podcastInfo = podcastInfoCache.get(podcastId);
                    if (podcastInfo === undefined) {
                        const podcast = await lookupPodcastByItunesId(
                            podcastId,
                            c.env.PODCAST_INDEX_KEY,
                            c.env.PODCAST_INDEX_SECRET
                        );
                        podcastInfo = podcast ? { author: podcast.author, link: podcast.link } : null;
                        podcastInfoCache.set(podcastId, podcastInfo);
                    }

                    if (podcastInfo?.link) {
                        nextWebsite = cleanWebsiteUrl(podcastInfo.link);
                    }
                }

                const changedApple = needsAppleUrl && nextAppleUrl !== episode.appleUrl;
                const changedWebsite = needsWebsite && nextWebsite !== episode.podcastWebsiteUrl;

                if (!changedApple && !changedWebsite) {
                    skippedNoMatch++;
                    continue;
                }

                const patched: Episode = {
                    ...episode,
                    appleUrl: changedApple ? (nextAppleUrl ?? episode.appleUrl) : episode.appleUrl,
                    podcastWebsiteUrl: changedWebsite ? nextWebsite : episode.podcastWebsiteUrl,
                };
                await saveEpisode(c.env.TLDL_DATA, patched);
                updated++;

                console.log(JSON.stringify({
                    event: "episode_apple_url_backfilled",
                    episodeId: ep.id,
                    appleUrl: changedApple ? nextAppleUrl : undefined,
                    podcastWebsiteUrl: changedWebsite ? nextWebsite : undefined,
                }));
            } catch (error) {
                console.error(JSON.stringify({
                    event: "backfill_episode_apple_url_failed",
                    episodeId: ep.id,
                    error: error instanceof Error ? error.message : "Unknown error",
                }));
                failed++;
            }
        }

        return c.json({
            success: true,
            message: `Processed ${processed}: ${updated} updated, ${skippedAlreadySet} already set, ${skippedNoMatch} no PI match, ${skippedNonNumericPodcast} non-numeric podcastId, ${failed} failed`,
            processed,
            updated,
            skippedAlreadySet,
            skippedNoMatch,
            skippedNonNumericPodcast,
            failed,
            totalEpisodes: allEpisodes.episodes.length,
        });
    } catch (error) {
        return c.json({
            error: error instanceof Error ? error.message : "Failed to backfill episode Apple URLs",
        }, 500);
    }
});

// POST /backfill-monitored-podcast-authors
admin.post("/backfill-monitored-podcast-authors", async (c) => {
    const authError = await requireAdmin(c);
    if (authError) return authError;

    try {
        const { lookupPodcastByItunesId } = await import("../services/podcast-index");
        const podcasts = await listMonitoredPodcasts(c.env.TLDL_DATA);

        let processed = 0;
        let updated = 0;
        let alreadyHasAuthor = 0;
        let notFound = 0;
        let failed = 0;

        for (const podcast of podcasts) {
            processed++;
            try {
                if (podcast.author) {
                    alreadyHasAuthor++;
                    continue;
                }

                const info = await lookupPodcastByItunesId(
                    podcast.id,
                    c.env.PODCAST_INDEX_KEY,
                    c.env.PODCAST_INDEX_SECRET
                );

                if (!info?.author) {
                    notFound++;
                    continue;
                }

                await saveMonitoredPodcast(c.env.TLDL_DATA, { ...podcast, author: info.author });
                updated++;
                console.log(JSON.stringify({
                    event: "monitored_podcast_author_backfilled",
                    podcastId: podcast.id,
                    author: info.author,
                }));
            } catch (error) {
                console.error(JSON.stringify({
                    event: "backfill_monitored_podcast_author_failed",
                    podcastId: podcast.id,
                    error: error instanceof Error ? error.message : "Unknown error",
                }));
                failed++;
            }
        }

        return c.json({
            success: true,
            message: `Processed ${processed}: ${updated} updated, ${alreadyHasAuthor} already had author, ${notFound} not found in Podcast Index, ${failed} failed`,
            processed,
            updated,
            alreadyHasAuthor,
            notFound,
            failed,
        });
    } catch (error) {
        return c.json({
            error: error instanceof Error ? error.message : "Failed to backfill monitored podcast authors",
        }, 500);
    }
});

// POST /backfill-episode-podcast-metadata
// Walks episodes:index, finds episodes whose podcastId matches a monitored
// podcast, and fills in missing podcastAuthor / podcastWebsiteUrl / appleUrl
// from the MonitoredPodcast record. RSS-ingested episodes pre-redesign are
// missing these fields — this brings them up to current standards.
admin.post("/backfill-episode-podcast-metadata", async (c) => {
    const authError = await requireAdmin(c);
    if (authError) return authError;

    try {
        const podcasts = await listMonitoredPodcasts(c.env.TLDL_DATA);
        const byId = new Map<string, typeof podcasts[number]>();
        for (const p of podcasts) byId.set(p.id, p);

        const indexEntries = await c.env.TLDL_DATA.get<Array<{ id: string }>>("episodes:index", "json") ?? [];

        let processed = 0;
        let updated = 0;
        let skippedNoMatch = 0;
        let skippedAlreadySet = 0;
        let failed = 0;

        for (const entry of indexEntries) {
            processed++;
            const podcastId = entry.id.split("_")[0];
            const monitored = byId.get(podcastId);
            if (!monitored) { skippedNoMatch++; continue; }

            try {
                const ep = await getEpisode(c.env.TLDL_DATA, entry.id);
                if (!ep) { failed++; continue; }

                const desiredAuthor = monitored.author;
                const desiredWebsite = monitored.websiteUrl;
                const desiredApple = /^\d+$/.test(podcastId)
                    ? `https://podcasts.apple.com/us/podcast/id${podcastId}`
                    : "";

                const needsAuthor = !ep.podcastAuthor && desiredAuthor;
                const needsWebsite = !ep.podcastWebsiteUrl && desiredWebsite;
                const needsApple = !ep.appleUrl && desiredApple;

                if (!needsAuthor && !needsWebsite && !needsApple) {
                    skippedAlreadySet++;
                    continue;
                }

                const patched: Episode = {
                    ...ep,
                    podcastAuthor: needsAuthor ? desiredAuthor : ep.podcastAuthor,
                    podcastWebsiteUrl: needsWebsite ? desiredWebsite : ep.podcastWebsiteUrl,
                    appleUrl: needsApple ? desiredApple : ep.appleUrl,
                };
                await saveEpisode(c.env.TLDL_DATA, patched);
                updated++;
            } catch (error) {
                console.error(JSON.stringify({
                    event: "backfill_episode_podcast_metadata_failed",
                    episodeId: entry.id,
                    error: error instanceof Error ? error.message : "Unknown error",
                }));
                failed++;
            }
        }

        return c.json({
            success: true,
            message: `Processed ${processed}: ${updated} updated, ${skippedAlreadySet} already set, ${skippedNoMatch} no matching monitored podcast, ${failed} failed`,
            processed,
            updated,
            skippedAlreadySet,
            skippedNoMatch,
            failed,
        });
    } catch (error) {
        return c.json({
            error: error instanceof Error ? error.message : "Failed to backfill episode podcast metadata",
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
                        <label for="enabled">Auto-check</label>
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

    return c.html(AdminLayout({
        title: "Monitor Podcasts",
        activeTab: "podcasts",
        userEmail: c.get("userEmail") || "Unknown User",
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
