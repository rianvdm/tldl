/**
 * KV Storage Layer for TLDL
 * Provides typed helpers for all KV operations with consistent key schemas and TTLs.
 */

import type { Job, JobStatus, Episode, Transcript, Summary } from "../types";

// Key generation functions for consistent naming
export const KV_KEYS = {
    job: (jobId: string) => `job:${jobId}`,
    episode: (episodeId: string) => `episode:${episodeId}`,
    transcript: (episodeId: string) => `transcript:${episodeId}`,
    summary: (episodeId: string, templateId: string) =>
        `summary:${episodeId}:${templateId}`,
};

// TTL constants in seconds
export const TTL = {
    JOB: 7 * 24 * 60 * 60, // 7 days
    CONTENT: 365 * 24 * 60 * 60, // 365 days
};

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
}

/**
 * List all episodes, sorted by createdAt descending (most recent first)
 */
export async function listEpisodes(kv: KVNamespace): Promise<Episode[]> {
    const prefix = "episode:";
    const keys = await kv.list({ prefix });

    if (keys.keys.length === 0) {
        return [];
    }

    // Batch fetch all episode values
    const episodes = await Promise.all(
        keys.keys.map(async (key) => {
            const data = await kv.get(key.name);
            if (!data) return null;
            return JSON.parse(data) as Episode;
        })
    );

    // Filter out nulls and sort by createdAt descending
    return episodes
        .filter((ep): ep is Episode => ep !== null)
        .sort(
            (a, b) =>
                new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
        );
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
 * Save a summary record to KV
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
