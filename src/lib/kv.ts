/**
 * KV Storage Layer for TLDL
 * Provides typed helpers for all KV operations with consistent key schemas and TTLs.
 */

import type { Job, JobStatus, Episode, Transcript, Summary, EpisodeIndexEntry, MonitoredPodcast, MonitorSettings, ActivityEvent } from "../types";

// Key generation functions for consistent naming
export const KV_KEYS = {
    job: (jobId: string) => `job:${jobId}`,
    episode: (episodeId: string) => `episode:${episodeId}`,
    transcript: (episodeId: string) => `transcript:${episodeId}`,
    summary: (episodeId: string, templateId: string) =>
        `summary:${episodeId}:${templateId}`,
    episodeIndex: "episodes:index",
    episodeRedirect: (fromEpisodeId: string) => `episode-redirect:${fromEpisodeId}`,
    // Podcast monitoring keys
    monitorSettings: "monitor:settings",
    monitoredList: "monitored:list",
    monitoredPodcast: (podcastId: string) => `monitored:${podcastId}`,
    monitoredProcessed: (podcastId: string) => `monitored:processed:${podcastId}`,
    activityLog: "activity:log",
};

// TTL constants in seconds
export const TTL = {
    JOB: 1 * 24 * 60 * 60, // 1 day
    CONTENT: 365 * 24 * 60 * 60, // 365 days
    ACTIVITY_LOG: 30 * 24 * 60 * 60, // 30 days
};

const ACTIVITY_LOG_MAX_ENTRIES = 50;

// ============================================================================
// Job Operations
// ============================================================================

/**
 * Create a new job record in KV
 */
export async function createJob(kv: KVNamespace, job: Job): Promise<void> {
    await kv.put(KV_KEYS.job(job.id), JSON.stringify(job), {
        expirationTtl: TTL.JOB,
    });
}

/**
 * Retrieve a job by ID
 */
export async function getJob(
    kv: KVNamespace,
    jobId: string
): Promise<Job | null> {
    const data = await kv.get(KV_KEYS.job(jobId));
    if (!data) return null;
    return JSON.parse(data) as Job;
}

/**
 * Update a job's status and optionally set an error message
 */
export async function updateJobStatus(
    kv: KVNamespace,
    jobId: string,
    status: JobStatus,
    error?: string
): Promise<void> {
    const job = await getJob(kv, jobId);
    if (!job) {
        throw new Error(`Job not found: ${jobId}`);
    }

    const updatedJob: Job = {
        ...job,
        status,
        updatedAt: new Date().toISOString(),
        ...(error !== undefined && { error }),
    };

    await kv.put(KV_KEYS.job(jobId), JSON.stringify(updatedJob), {
        expirationTtl: TTL.JOB,
    });

    console.log(
        JSON.stringify({
            event: "job_status_updated",
            jobId,
            previousStatus: job.status,
            newStatus: status,
            hasError: error !== undefined,
        })
    );
}

/**
 * Save a redirect alias from a (now-orphaned) submitted episode ID to the
 * canonical episode that owns the same audio. Used when cross-shape dedup
 * fires in the consumer — any cached link, social share, or pre-rendered
 * admin page that points at the submitted ID can 301 to the canonical via
 * `getEpisodeRedirect`.
 */
export async function saveEpisodeRedirect(
    kv: KVNamespace,
    fromEpisodeId: string,
    toEpisodeId: string
): Promise<void> {
    await kv.put(KV_KEYS.episodeRedirect(fromEpisodeId), toEpisodeId, {
        expirationTtl: TTL.CONTENT,
    });
}

export async function getEpisodeRedirect(
    kv: KVNamespace,
    fromEpisodeId: string
): Promise<string | null> {
    return await kv.get(KV_KEYS.episodeRedirect(fromEpisodeId));
}

/**
 * Update a job's `episodeId` to point at a different (canonical) record.
 * Used by the consumer when cross-shape dedup discovers the just-submitted
 * episode is the same audio as one we already have under a different ID
 * (typically a cron `_rss_<hash>` ↔ direct-submit `_<piEpisodeId>` collision).
 */
export async function updateJobEpisodeId(
    kv: KVNamespace,
    jobId: string,
    episodeId: string
): Promise<void> {
    const job = await getJob(kv, jobId);
    if (!job) return;
    const updatedJob: Job = {
        ...job,
        episodeId,
        updatedAt: new Date().toISOString(),
    };
    await kv.put(KV_KEYS.job(jobId), JSON.stringify(updatedJob), {
        expirationTtl: TTL.JOB,
    });
}

/**
 * Update a job's metadata (podcast name and episode title)
 * Called after fetching episode metadata to display on status page
 */
export async function updateJobMetadata(
    kv: KVNamespace,
    jobId: string,
    podcastName: string,
    episodeTitle: string
): Promise<void> {
    const job = await getJob(kv, jobId);
    if (!job) {
        // Job not found - this is non-critical, just log and skip
        console.log(
            JSON.stringify({
                event: "job_metadata_update_skipped",
                jobId,
                reason: "job_not_found",
            })
        );
        return;
    }

    const updatedJob: Job = {
        ...job,
        podcastName,
        episodeTitle,
        updatedAt: new Date().toISOString(),
    };

    await kv.put(KV_KEYS.job(jobId), JSON.stringify(updatedJob), {
        expirationTtl: TTL.JOB,
    });

    console.log(
        JSON.stringify({
            event: "job_metadata_updated",
            jobId,
            podcastName,
            episodeTitle,
        })
    );
}

/**
 * List all active (non-completed, non-failed) jobs, sorted by createdAt descending
 */
export async function listActiveJobs(kv: KVNamespace): Promise<Job[]> {
    const prefix = "job:";
    const keys = await kv.list({ prefix });

    if (keys.keys.length === 0) {
        return [];
    }

    // Batch fetch all job values
    const jobs = await Promise.all(
        keys.keys.map(async (key) => {
            const data = await kv.get(key.name);
            if (!data) return null;
            return JSON.parse(data) as Job;
        })
    );

    // Filter to only active jobs (not completed, not failed) and sort by createdAt descending
    return jobs
        .filter((job): job is Job =>
            job !== null &&
            job.status !== "completed" &&
            job.status !== "failed"
        )
        .sort(
            (a, b) =>
                new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
        );
}

// ============================================================================
// Episode Operations
// ============================================================================

/**
 * Save an episode record to KV
 */
export async function saveEpisode(
    kv: KVNamespace,
    episode: Episode
): Promise<void> {
    await kv.put(KV_KEYS.episode(episode.id), JSON.stringify(episode), {
        expirationTtl: TTL.CONTENT,
    });
}

/**
 * Retrieve an episode by ID
 */
export async function getEpisode(
    kv: KVNamespace,
    episodeId: string
): Promise<Episode | null> {
    const data = await kv.get(KV_KEYS.episode(episodeId));
    if (!data) return null;
    return JSON.parse(data) as Episode;
}

/**
 * Delete an episode and all related data (transcript, summaries)
 */
export async function deleteEpisode(
    kv: KVNamespace,
    episodeId: string
): Promise<void> {
    // Delete the episode itself
    await kv.delete(KV_KEYS.episode(episodeId));

    // Delete the transcript
    await kv.delete(KV_KEYS.transcript(episodeId));

    // Delete all summaries for this episode
    // We need to list and delete any summary keys matching the pattern
    const summaryPrefix = `summary:${episodeId}:`;
    const summaryKeys = await kv.list({ prefix: summaryPrefix });

    await Promise.all(summaryKeys.keys.map((key) => kv.delete(key.name)));

    // Remove from the episode index
    await removeFromEpisodeIndex(kv, episodeId);
}

/**
 * Update tags for an episode (admin-only operation)
 * Updates both the episode record and the index entry
 */
export async function updateEpisodeTags(
    kv: KVNamespace,
    episodeId: string,
    tags: string[]
): Promise<void> {
    // Get existing episode
    const episode = await getEpisode(kv, episodeId);
    if (!episode) {
        throw new Error(`Episode not found: ${episodeId}`);
    }

    // Update episode with new tags
    const updatedEpisode: Episode = {
        ...episode,
        tags: tags.length > 0 ? tags : undefined,
    };
    await saveEpisode(kv, updatedEpisode);

    // Update episode index
    const index = await getEpisodeIndex(kv);
    const entryIndex = index.findIndex(e => e.id === episodeId);

    if (entryIndex !== -1) {
        index[entryIndex] = {
            ...index[entryIndex],
            tags: tags.length > 0 ? tags : undefined,
        };

        await kv.put(KV_KEYS.episodeIndex, JSON.stringify(index), {
            expirationTtl: TTL.CONTENT,
        });
    }

    console.log(
        JSON.stringify({
            event: "episode_tags_updated",
            episodeId,
            tags,
        })
    );
}

export interface PaginatedEpisodes {
    episodes: EpisodeIndexEntry[];
    total: number;
    page: number;
    pageSize: number;
    totalPages: number;
}

/**
 * List episodes using the index (O(1) KV read instead of N reads)
 * Supports pagination and optional search query
 * Auto-rebuilds index if empty but episodes exist (migration fallback)
 */
export async function listEpisodes(
    kv: KVNamespace,
    options?: { page?: number; pageSize?: number; search?: string; tag?: string }
): Promise<PaginatedEpisodes> {
    const page = Math.max(1, options?.page ?? 1);
    const pageSize = options?.pageSize ?? 10;
    const search = options?.search?.toLowerCase().trim();
    const tagFilter = options?.tag?.toLowerCase().trim();

    // Read the episode index (single KV read)
    let index = await getEpisodeIndex(kv);

    // Fallback: if index is empty, check if episodes exist and rebuild
    if (index.length === 0) {
        const episodeKeys = await kv.list({ prefix: "episode:" });
        if (episodeKeys.keys.length > 0) {
            // Episodes exist but index doesn't - rebuild it
            console.log(JSON.stringify({
                event: "episode_index_auto_rebuild",
                episodeCount: episodeKeys.keys.length,
            }));
            await rebuildEpisodeIndex(kv);
            index = await getEpisodeIndex(kv);
        }
    }

    if (index.length === 0) {
        return { episodes: [], total: 0, page, pageSize, totalPages: 0 };
    }

    // Filter by search query and/or tag
    let filtered = index;

    if (search) {
        filtered = filtered.filter(
            (ep) =>
                ep.podcastName.toLowerCase().includes(search) ||
                ep.episodeTitle.toLowerCase().includes(search)
        );
    }

    if (tagFilter) {
        filtered = filtered.filter(
            (ep) => ep.tags?.includes(tagFilter)
        );
    }

    const total = filtered.length;
    const totalPages = Math.ceil(total / pageSize);
    const start = (page - 1) * pageSize;
    const episodes = filtered.slice(start, start + pageSize);

    return { episodes, total, page, pageSize, totalPages };
}

// ============================================================================
// Episode Index Operations
// ============================================================================

/**
 * Get the episode index (lightweight entries for home page listing)
 * Returns sorted array (most recent first)
 */
export async function getEpisodeIndex(
    kv: KVNamespace
): Promise<EpisodeIndexEntry[]> {
    const data = await kv.get(KV_KEYS.episodeIndex);
    if (!data) return [];
    return JSON.parse(data) as EpisodeIndexEntry[];
}

/**
 * List the template IDs that have a saved summary for this episode.
 * Used to denormalize summary presence onto the episode index entry, so the
 * /admin Episodes tab doesn't have to fan out a list+get per visible episode.
 */
async function listSummaryTemplateIds(kv: KVNamespace, episodeId: string): Promise<string[]> {
    const prefix = `summary:${episodeId}:`;
    const keys = await kv.list({ prefix });
    return keys.keys
        .map((k) => k.name.slice(prefix.length))
        .filter((id) => id.length > 0)
        .sort();
}

/**
 * Add an episode to the index (called when episode is saved)
 * Maintains sorted order by createdAt descending.
 * Populates `templateIds` from any summaries already saved for this episode.
 */
export async function addToEpisodeIndex(
    kv: KVNamespace,
    entry: EpisodeIndexEntry
): Promise<void> {
    const [index, templateIds] = await Promise.all([
        getEpisodeIndex(kv),
        listSummaryTemplateIds(kv, entry.id),
    ]);

    // Check if episode already exists (update case)
    const existingIdx = index.findIndex((e) => e.id === entry.id);
    if (existingIdx !== -1) {
        index.splice(existingIdx, 1);
    }

    // Add new entry and sort by createdAt descending
    index.push({ ...entry, templateIds: templateIds.length > 0 ? templateIds : entry.templateIds });
    index.sort(
        (a, b) =>
            new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );

    await kv.put(KV_KEYS.episodeIndex, JSON.stringify(index), {
        expirationTtl: TTL.CONTENT,
    });
}

/**
 * Add a summary template ID to an existing episode index entry (idempotent).
 * No-op if the entry doesn't exist yet — `addToEpisodeIndex` will pick up the
 * template the first time it's called for this episode.
 */
export async function addTemplateToEpisodeIndex(
    kv: KVNamespace,
    episodeId: string,
    templateId: string
): Promise<void> {
    const index = await getEpisodeIndex(kv);
    const entryIdx = index.findIndex((e) => e.id === episodeId);
    if (entryIdx === -1) return;

    const existing = index[entryIdx].templateIds ?? [];
    if (existing.includes(templateId)) return;

    index[entryIdx] = {
        ...index[entryIdx],
        templateIds: [...existing, templateId].sort(),
    };

    await kv.put(KV_KEYS.episodeIndex, JSON.stringify(index), {
        expirationTtl: TTL.CONTENT,
    });
}

/**
 * Remove an episode from the index (called when episode is deleted)
 */
export async function removeFromEpisodeIndex(
    kv: KVNamespace,
    episodeId: string
): Promise<void> {
    const index = await getEpisodeIndex(kv);
    const filtered = index.filter((e) => e.id !== episodeId);

    // Only write if something was removed
    if (filtered.length !== index.length) {
        await kv.put(KV_KEYS.episodeIndex, JSON.stringify(filtered), {
            expirationTtl: TTL.CONTENT,
        });
    }
}

/**
 * Rebuild the episode index from all existing episodes
 * Used for one-time backfill or recovery
 */
export async function rebuildEpisodeIndex(kv: KVNamespace): Promise<number> {
    const prefix = "episode:";
    const keys = await kv.list({ prefix });

    if (keys.keys.length === 0) {
        await kv.delete(KV_KEYS.episodeIndex);
        return 0;
    }

    // Fetch all episodes
    const allEpisodes = await Promise.all(
        keys.keys.map(async (key) => {
            const data = await kv.get(key.name);
            if (!data) return null;
            return JSON.parse(data) as Episode;
        })
    );

    const validEpisodes = allEpisodes.filter((ep): ep is Episode => ep !== null);

    // Look up the saved summary template IDs for each episode so the rebuilt
    // index can render the /admin Episodes tab without per-card fan-out.
    const templateIdsByEpisode = await Promise.all(
        validEpisodes.map((ep) => listSummaryTemplateIds(kv, ep.id))
    );

    // Build index entries and sort
    const index: EpisodeIndexEntry[] = validEpisodes
        .map((ep, i) => ({
            id: ep.id,
            podcastName: ep.podcastName,
            episodeTitle: ep.episodeTitle,
            episodeDate: ep.episodeDate,
            episodeDuration: ep.episodeDuration,
            createdAt: ep.createdAt,
            expiresAt: ep.expiresAt,
            tags: ep.tags,
            podcastAuthor: ep.podcastAuthor,
            audioUrl: ep.audioUrl,
            templateIds: templateIdsByEpisode[i].length > 0 ? templateIdsByEpisode[i] : undefined,
        }))
        .sort(
            (a, b) =>
                new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
        );

    await kv.put(KV_KEYS.episodeIndex, JSON.stringify(index), {
        expirationTtl: TTL.CONTENT,
    });

    return index.length;
}

// ============================================================================
// Transcript Operations
// ============================================================================

/**
 * Save a transcript record to KV
 */
export async function saveTranscript(
    kv: KVNamespace,
    transcript: Transcript
): Promise<void> {
    await kv.put(
        KV_KEYS.transcript(transcript.episodeId),
        JSON.stringify(transcript),
        {
            expirationTtl: TTL.CONTENT,
        }
    );
}

/**
 * Retrieve a transcript by episode ID
 */
export async function getTranscript(
    kv: KVNamespace,
    episodeId: string
): Promise<Transcript | null> {
    const data = await kv.get(KV_KEYS.transcript(episodeId));
    if (!data) return null;
    return JSON.parse(data) as Transcript;
}

// ============================================================================
// Summary Operations
// ============================================================================

/**
 * Save a summary record to KV.
 *
 * Also denormalizes the summary template ID onto the episode index entry so
 * the /admin Episodes tab can render template badges without reading every
 * summary key. The index update is a no-op if the index entry doesn't exist
 * yet — in that case `addToEpisodeIndex` will populate `templateIds` from
 * KV when it's eventually called.
 */
export async function saveSummary(
    kv: KVNamespace,
    summary: Summary
): Promise<void> {
    await kv.put(
        KV_KEYS.summary(summary.episodeId, summary.templateId),
        JSON.stringify(summary),
        {
            expirationTtl: TTL.CONTENT,
        }
    );
    await addTemplateToEpisodeIndex(kv, summary.episodeId, summary.templateId);
}

/**
 * Retrieve a summary by episode ID and template ID
 */
export async function getSummary(
    kv: KVNamespace,
    episodeId: string,
    templateId: string
): Promise<Summary | null> {
    const data = await kv.get(KV_KEYS.summary(episodeId, templateId));
    if (!data) return null;
    return JSON.parse(data) as Summary;
}

/**
 * List all summaries for an episode
 */
export async function listSummariesForEpisode(
    kv: KVNamespace,
    episodeId: string
): Promise<Summary[]> {
    const prefix = `summary:${episodeId}:`;
    const keys = await kv.list({ prefix });

    if (keys.keys.length === 0) {
        return [];
    }

    const summaries = await Promise.all(
        keys.keys.map(async (key) => {
            const data = await kv.get(key.name);
            if (!data) return null;
            return JSON.parse(data) as Summary;
        })
    );

    // Filter out nulls and sort by createdAt descending
    return summaries
        .filter((s): s is Summary => s !== null)
        .sort(
            (a, b) =>
                new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
        );
}

/**
 * Delete a job from KV
 */
export async function deleteJob(kv: KVNamespace, jobId: string): Promise<void> {
    await kv.delete(KV_KEYS.job(jobId));
}

// ============================================================================
// Podcast Operations
// ============================================================================

import { extractPodcastId } from "./url-parser";

/**
 * Podcast info for the browse podcasts page
 */
export interface PodcastInfo {
    id: string;
    name: string;
    author?: string;  // Podcast author/creator name
    episodeCount: number;
    latestEpisodeDate: string;  // createdAt of most recent episode submission
}

/**
 * Get a list of all podcasts with summarized episodes
 * Sorted by most recently updated (latest episode submission first)
 */
export async function getPodcastList(kv: KVNamespace): Promise<PodcastInfo[]> {
    const index = await getEpisodeIndex(kv);

    const podcasts = new Map<string, PodcastInfo>();

    for (const ep of index) {
        const podcastId = extractPodcastId(ep.id);
        if (!podcastId) continue;

        const existing = podcasts.get(podcastId);
        if (existing) {
            existing.episodeCount++;
            // Track latest by createdAt (submission date), not episodeDate
            if (ep.createdAt > existing.latestEpisodeDate) {
                existing.latestEpisodeDate = ep.createdAt;
                // Update author from most recent episode (in case it was added later)
                if (ep.podcastAuthor) {
                    existing.author = ep.podcastAuthor;
                }
            }
        } else {
            podcasts.set(podcastId, {
                id: podcastId,
                name: ep.podcastName,
                author: ep.podcastAuthor,
                episodeCount: 1,
                latestEpisodeDate: ep.createdAt,
            });
        }
    }

    // Sort by most recently updated
    return Array.from(podcasts.values())
        .sort((a, b) => b.latestEpisodeDate.localeCompare(a.latestEpisodeDate));
}

/**
 * Get paginated episodes for a specific podcast
 * Episodes are sorted by episodeDate descending (reverse chronological by air date)
 */
export async function getEpisodesForPodcast(
    kv: KVNamespace,
    podcastId: string,
    options?: { page?: number; pageSize?: number }
): Promise<PaginatedEpisodes> {
    const page = Math.max(1, options?.page ?? 1);
    const pageSize = options?.pageSize ?? 10;

    const index = await getEpisodeIndex(kv);
    const podcastEpisodes = index
        .filter(ep => ep.id.startsWith(`${podcastId}_`))
        .sort((a, b) =>
            new Date(b.episodeDate).getTime() - new Date(a.episodeDate).getTime()
        );

    const total = podcastEpisodes.length;
    const totalPages = Math.ceil(total / pageSize);
    const start = (page - 1) * pageSize;
    const episodes = podcastEpisodes.slice(start, start + pageSize);

    return { episodes, total, page, pageSize, totalPages };
}

// ============================================================================
// Podcast Monitoring Operations
// ============================================================================

const DEFAULT_MONITOR_SETTINGS: MonitorSettings = {
    maxEpisodesPerCheck: 5,
    enabled: true,
};

/**
 * Get global monitor settings
 */
export async function getMonitorSettings(kv: KVNamespace): Promise<MonitorSettings> {
    const data = await kv.get(KV_KEYS.monitorSettings);
    if (!data) return { ...DEFAULT_MONITOR_SETTINGS };
    return JSON.parse(data) as MonitorSettings;
}

/**
 * Save global monitor settings
 */
export async function saveMonitorSettings(
    kv: KVNamespace,
    settings: MonitorSettings
): Promise<void> {
    await kv.put(KV_KEYS.monitorSettings, JSON.stringify(settings));
}

/**
 * Get list of monitored podcast IDs
 */
export async function getMonitoredPodcastIds(kv: KVNamespace): Promise<string[]> {
    const data = await kv.get(KV_KEYS.monitoredList);
    if (!data) return [];
    return JSON.parse(data) as string[];
}

/**
 * Add a podcast ID to the monitored list
 */
export async function addToMonitoredList(
    kv: KVNamespace,
    podcastId: string
): Promise<void> {
    const list = await getMonitoredPodcastIds(kv);
    if (!list.includes(podcastId)) {
        list.push(podcastId);
        await kv.put(KV_KEYS.monitoredList, JSON.stringify(list));
    }
}

/**
 * Remove a podcast ID from the monitored list
 */
export async function removeFromMonitoredList(
    kv: KVNamespace,
    podcastId: string
): Promise<void> {
    const list = await getMonitoredPodcastIds(kv);
    const filtered = list.filter(id => id !== podcastId);
    if (filtered.length !== list.length) {
        await kv.put(KV_KEYS.monitoredList, JSON.stringify(filtered));
    }
}

/**
 * Get a monitored podcast by ID
 */
export async function getMonitoredPodcast(
    kv: KVNamespace,
    podcastId: string
): Promise<MonitoredPodcast | null> {
    const data = await kv.get(KV_KEYS.monitoredPodcast(podcastId));
    if (!data) return null;
    return JSON.parse(data) as MonitoredPodcast;
}

/**
 * Save a monitored podcast record
 */
export async function saveMonitoredPodcast(
    kv: KVNamespace,
    podcast: MonitoredPodcast
): Promise<void> {
    await kv.put(KV_KEYS.monitoredPodcast(podcast.id), JSON.stringify(podcast));
}

/**
 * Delete a monitored podcast record and its processed episodes list
 */
export async function deleteMonitoredPodcast(
    kv: KVNamespace,
    podcastId: string
): Promise<void> {
    await kv.delete(KV_KEYS.monitoredPodcast(podcastId));
    await kv.delete(KV_KEYS.monitoredProcessed(podcastId));
    await removeFromMonitoredList(kv, podcastId);
}

/**
 * List all monitored podcasts
 */
export async function listMonitoredPodcasts(
    kv: KVNamespace
): Promise<MonitoredPodcast[]> {
    const ids = await getMonitoredPodcastIds(kv);
    if (ids.length === 0) return [];

    const podcasts = await Promise.all(
        ids.map(id => getMonitoredPodcast(kv, id))
    );

    return podcasts
        .filter((p): p is MonitoredPodcast => p !== null)
        .sort((a, b) => (a.name ?? "").localeCompare(b.name ?? ""));
}

/**
 * Get processed episode GUIDs for a podcast
 */
export async function getProcessedEpisodes(
    kv: KVNamespace,
    podcastId: string
): Promise<string[]> {
    const data = await kv.get(KV_KEYS.monitoredProcessed(podcastId));
    if (!data) return [];
    return JSON.parse(data) as string[];
}

/**
 * Mark an episode GUID as processed for a podcast
 */
export async function markEpisodeProcessed(
    kv: KVNamespace,
    podcastId: string,
    episodeGuid: string
): Promise<void> {
    const processed = await getProcessedEpisodes(kv, podcastId);
    if (!processed.includes(episodeGuid)) {
        processed.push(episodeGuid);
        await kv.put(KV_KEYS.monitoredProcessed(podcastId), JSON.stringify(processed));
    }
}

/**
 * Mark multiple episode GUIDs as processed for a podcast (initial setup)
 */
export async function markEpisodesProcessed(
    kv: KVNamespace,
    podcastId: string,
    episodeGuids: string[]
): Promise<void> {
    const processed = await getProcessedEpisodes(kv, podcastId);
    const unique = [...new Set([...processed, ...episodeGuids])];
    await kv.put(KV_KEYS.monitoredProcessed(podcastId), JSON.stringify(unique));
}

/**
 * Update lastChecked timestamp and optionally other fields on a monitored podcast
 */
export async function updateMonitoredPodcastStatus(
    kv: KVNamespace,
    podcastId: string,
    updates: Partial<MonitoredPodcast>
): Promise<void> {
    const podcast = await getMonitoredPodcast(kv, podcastId);
    if (!podcast) return;

    const updated: MonitoredPodcast = {
        ...podcast,
        ...updates,
    };

    if (updates.status === "active" || updates.status === "paused") {
        delete updated.lastError;
    }

    await saveMonitoredPodcast(kv, updated);
}

// ============================================================================
// Activity Log Operations
// ============================================================================

/**
 * Append an event to the activity log.
 * The log is a capped array (max 50 entries) stored as a single KV value.
 * Newest entries are prepended so the array is sorted newest-first.
 */
export async function appendActivityEvent(
    kv: KVNamespace,
    event: ActivityEvent
): Promise<void> {
    const existing = await kv.get(KV_KEYS.activityLog);
    let log: ActivityEvent[] = [];

    if (existing) {
        try {
            log = JSON.parse(existing);
        } catch {
            // Corrupted log — start fresh
            log = [];
        }
    }

    // Prepend new event (newest first)
    log.unshift(event);

    // Cap at max entries
    if (log.length > ACTIVITY_LOG_MAX_ENTRIES) {
        log = log.slice(0, ACTIVITY_LOG_MAX_ENTRIES);
    }

    await kv.put(KV_KEYS.activityLog, JSON.stringify(log), {
        expirationTtl: TTL.ACTIVITY_LOG,
    });
}

/**
 * Remove a failed activity event by episodeId.
 */
export async function removeActivityEvent(
    kv: KVNamespace,
    episodeId: string
): Promise<boolean> {
    const data = await kv.get(KV_KEYS.activityLog);
    if (!data) return false;

    try {
        const log: ActivityEvent[] = JSON.parse(data);
        const idx = log.findIndex(
            (e) => e.type === "episode_failed" && e.episodeId === episodeId
        );
        if (idx === -1) return false;

        log.splice(idx, 1);
        await kv.put(KV_KEYS.activityLog, JSON.stringify(log), {
            expirationTtl: TTL.ACTIVITY_LOG,
        });
        return true;
    } catch {
        return false;
    }
}

/**
 * Read the activity log, optionally limited to the most recent N entries.
 */
export async function getActivityLog(
    kv: KVNamespace,
    limit?: number
): Promise<ActivityEvent[]> {
    const data = await kv.get(KV_KEYS.activityLog);
    if (!data) return [];

    try {
        const log: ActivityEvent[] = JSON.parse(data);
        return limit ? log.slice(0, limit) : log;
    } catch {
        return [];
    }
}

