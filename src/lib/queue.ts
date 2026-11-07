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
    appleUrl?: string;
    appleUrlIsSynthetic?: boolean;
    templateId: string;
    episodeGuid?: string;
    expectedTitle?: string;
    expectedDate?: string;
    submittedBy?: string;
    audioUrlOverride?: string;
    preResolvedAudioUrl?: string;
    // RSS-sourced monitoring
    rssSourced?: boolean;
    audioUrl?: string;
    durationSeconds?: number;
    transcriptUrl?: string;
    transcriptType?: string;
    podcastTitle?: string;
    podcastWebsiteUrl?: string;
    episodePageUrl?: string;
}): QueueMessage {
    return {
        type: "process_episode",
        jobId: params.jobId,
        episodeId: params.episodeId,
        templateId: params.templateId,
        ...(params.appleUrl && { appleUrl: params.appleUrl }),
        ...(params.appleUrlIsSynthetic && { appleUrlIsSynthetic: true }),
        ...(params.episodeGuid && { episodeGuid: params.episodeGuid }),
        ...(params.expectedTitle && { expectedTitle: params.expectedTitle }),
        ...(params.expectedDate && { expectedDate: params.expectedDate }),
        ...(params.submittedBy && { submittedBy: params.submittedBy }),
        ...(params.audioUrlOverride && { audioUrlOverride: params.audioUrlOverride }),
        ...(params.preResolvedAudioUrl && { preResolvedAudioUrl: params.preResolvedAudioUrl }),
        ...(params.rssSourced && { rssSourced: true }),
        ...(params.audioUrl && { audioUrl: params.audioUrl }),
        ...(params.durationSeconds !== undefined && { durationSeconds: params.durationSeconds }),
        ...(params.transcriptUrl && { transcriptUrl: params.transcriptUrl }),
        ...(params.transcriptType && { transcriptType: params.transcriptType }),
        ...(params.podcastTitle && { podcastTitle: params.podcastTitle }),
        ...(params.podcastWebsiteUrl && { podcastWebsiteUrl: params.podcastWebsiteUrl }),
        ...(params.episodePageUrl && { episodePageUrl: params.episodePageUrl }),
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
