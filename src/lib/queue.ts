/**
 * Queue Helper for TLDL
 * Provides helpers for sending jobs to the Cloudflare Queue.
 */

import type { QueueMessage } from "../types";

/**
 * Send a job message to the queue for background processing
 */
export async function enqueueJob(
    queue: Queue<QueueMessage>,
    message: QueueMessage
): Promise<void> {
    await queue.send(message);
}

/**
 * Create a process_episode queue message
 */
export function createProcessEpisodeMessage(params: {
    jobId: string;
    episodeId: string;
    appleUrl: string;
    templateId: string;
    episodeGuid?: string;
    expectedTitle?: string;
    expectedDate?: string;
    submittedBy?: string;
}): QueueMessage {
    return {
        type: "process_episode",
        jobId: params.jobId,
        episodeId: params.episodeId,
        appleUrl: params.appleUrl,
        templateId: params.templateId,
        ...(params.episodeGuid && { episodeGuid: params.episodeGuid }),
        ...(params.expectedTitle && { expectedTitle: params.expectedTitle }),
        ...(params.expectedDate && { expectedDate: params.expectedDate }),
        ...(params.submittedBy && { submittedBy: params.submittedBy }),
    };
}

/**
 * Create a regenerate_summary queue message
 */
export function createRegenerateSummaryMessage(params: {
    jobId: string;
    episodeId: string;
    appleUrl: string;
    templateId: string;
}): QueueMessage {
    return {
        type: "regenerate_summary",
        jobId: params.jobId,
        episodeId: params.episodeId,
        appleUrl: params.appleUrl,
        templateId: params.templateId,
    };
}
