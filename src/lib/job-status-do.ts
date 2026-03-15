/**
 * Durable Object Helper Functions for Job Status
 * 
 * These helpers abstract the DO interactions and provide a clean API
 * for routes and the queue consumer to use. They also handle the
 * hybrid approach with KV fallback.
 */

import type { Env, Job, JobStatus } from "../types";
import { getJob, updateJobStatus, appendActivityEvent } from "./kv";
import { TIMEOUTS } from "./constants";
import { notifyDiscord, DISCORD_COLORS } from "./discord";

/**
 * Get the Durable Object stub for a job by its ID
 */
function getJobStub(env: Env, jobId: string): DurableObjectStub {
    const id = env.JOB_STATUS.idFromName(jobId);
    return env.JOB_STATUS.get(id);
}

/**
 * Create a new job in the Durable Object
 */
export async function createJobDO(env: Env, job: Job): Promise<void> {
    const stub = getJobStub(env, job.id);
    const response = await stub.fetch("https://do/job", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(job),
    });

    if (!response.ok) {
        const error = await response.text();
        throw new Error(`Failed to create job in DO: ${error}`);
    }
}

/**
 * Get job status from Durable Object
 * Returns null if job not found
 */
export async function getJobDO(env: Env, jobId: string): Promise<Job | null> {
    const stub = getJobStub(env, jobId);
    const response = await stub.fetch("https://do/job");

    if (response.status === 404) {
        return null;
    }

    if (!response.ok) {
        console.error(`Failed to get job from DO: ${response.status}`);
        return null;
    }

    return response.json<Job>();
}

/**
 * Update job status in Durable Object
 */
export async function updateJobStatusDO(
    env: Env,
    jobId: string,
    status: JobStatus,
    error?: string,
    estimatedSeconds?: number
): Promise<void> {
    const stub = getJobStub(env, jobId);
    const response = await stub.fetch("https://do/job", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status, error, estimatedSeconds }),
    });

    if (!response.ok) {
        const errorMsg = await response.text();
        console.error(`Failed to update job status in DO: ${errorMsg}`);
        // Don't throw - we want to continue even if DO update fails
        // KV backup will still work
    }
}

/**
 * Delete job from Durable Object
 */
export async function deleteJobDO(env: Env, jobId: string): Promise<void> {
    const stub = getJobStub(env, jobId);
    await stub.fetch("https://do/job", { method: "DELETE" });
}

/**
 * Get job with fallback to KV
 * 
 * This is the hybrid approach: try DO first (strongly consistent),
 * then fall back to KV for jobs created before the DO migration.
 */
export async function getJobWithFallback(
    env: Env,
    kv: KVNamespace,
    jobId: string
): Promise<Job | null> {
    // Try DO first (strongly consistent)
    try {
        const doJob = await getJobDO(env, jobId);
        if (doJob) {
            return doJob;
        }
    } catch (error) {
        console.error("DO lookup failed, falling back to KV:", error);
    }

    // Fallback to KV (for jobs created before migration or if DO fails)
    return getJob(kv, jobId);
}

/**
 * List all active jobs, fetching from DO for strong consistency
 *
 * Hybrid approach:
 * - Use KV to discover which jobs exist (list operation)
 * - Use DO to get actual job data (strong consistency)
 * - Fallback to KV if DO fails
 */
export async function listActiveJobsWithDO(
    env: Env,
    kv: KVNamespace
): Promise<import("../types").Job[]> {
    // Get list of job keys from KV
    const prefix = "job:";
    const keys = await kv.list({ prefix });

    if (keys.keys.length === 0) {
        return [];
    }

    // Extract job IDs from keys (format: "job:{jobId}")
    const jobIds = keys.keys.map(key => key.name.replace(prefix, ""));

    // Fetch each job from DO (with KV fallback)
    const jobs = await Promise.all(
        jobIds.map(jobId => getJobWithFallback(env, kv, jobId))
    );

    // Filter to non-completed jobs
    const activeJobs = jobs.filter(
        (job): job is Job => job !== null && job.status !== "completed"
    );

    // Check for timed-out jobs and mark them as failed
    const now = Date.now();
    for (const job of activeJobs) {
        if (job.status === "failed") continue;

        const jobAge = now - new Date(job.createdAt).getTime();
        if (jobAge > TIMEOUTS.JOB_MS) {
            const timeoutError = `Job timed out after ${Math.round(jobAge / 60000)} minutes. The transcription may have stalled.`;

            console.log(JSON.stringify({
                event: "job_timeout_detected",
                jobId: job.id,
                status: job.status,
                ageMinutes: Math.round(jobAge / 60000),
            }));

            // Mark as failed in both DO and KV (best effort)
            try {
                await updateJobStatusDO(env, job.id, "failed", timeoutError);
                await updateJobStatus(kv, job.id, "failed", timeoutError);

                await appendActivityEvent(kv, {
                    type: "episode_failed",
                    timestamp: new Date().toISOString(),
                    title: job.podcastName
                        ? `${job.podcastName}: ${job.episodeTitle || job.episodeId}`
                        : `Episode ${job.episodeId}`,
                    details: timeoutError,
                    episodeId: job.episodeId,
                });

                await notifyDiscord(env.DISCORD_WEBHOOK_URL, {
                    title: "🔴 Job timed out",
                    description: `**${job.podcastName || "Unknown"}: ${job.episodeTitle || job.episodeId}**\n\n${timeoutError}\n\nLast status: ${job.status}`,
                    color: DISCORD_COLORS.ERROR,
                });

                // Update the in-memory job object so the UI shows it as failed
                job.status = "failed";
                job.error = timeoutError;
            } catch (err) {
                console.error("Failed to mark timed-out job:", err);
            }
        }
    }

    return activeJobs.sort(
        (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );
}

/**
 * Update job estimate in Durable Object
 * Non-critical operation - logs errors but doesn't throw
 */
export async function updateJobEstimateDO(
    env: Env,
    jobId: string,
    estimatedSeconds: number
): Promise<void> {
    try {
        const stub = getJobStub(env, jobId);
        const response = await stub.fetch("https://do/job");

        if (!response.ok) {
            return; // Job not found, skip
        }

        const job = await response.json<Job>();

        await stub.fetch("https://do/job", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                status: job.status,
                estimatedSeconds
            }),
        });
    } catch {
        // Non-critical - don't fail job if estimate update fails
    }
}

/**
 * Update job metadata (podcastName, episodeTitle) in Durable Object
 * Called after fetching episode metadata to display on status page
 */
export async function updateJobMetadataDO(
    env: Env,
    jobId: string,
    podcastName: string,
    episodeTitle: string
): Promise<void> {
    try {
        const stub = getJobStub(env, jobId);
        const response = await stub.fetch("https://do/job");

        if (!response.ok) {
            return; // Job not found, skip
        }

        const job = await response.json<Job>();

        await stub.fetch("https://do/job", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                status: job.status,
                podcastName,
                episodeTitle
            }),
        });
    } catch {
        // Non-critical - don't fail job if metadata update fails
    }
}
