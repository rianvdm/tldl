/**
 * Durable Object Helper Functions for Job Status
 * 
 * These helpers abstract the DO interactions and provide a clean API
 * for routes and the queue consumer to use. They also handle the
 * hybrid approach with KV fallback.
 */

import type { Env, Job, JobStatus } from "../types";
import { getJob } from "./kv";

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
