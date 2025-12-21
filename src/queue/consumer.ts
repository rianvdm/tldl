/**
 * Queue Consumer for TLDL Background Job Processing
 *
 * Handles the full pipeline for podcast episode processing:
 * 1. Fetch episode metadata from Apple/RSS
 * 2. Check for existing transcript (RSS or previous processing)
 * 3. Transcribe via OpenAI Whisper if needed
 * 4. Generate summary via GPT-5.2
 * 5. Store results in KV
 */

import type { Env, QueueMessage, Episode, Transcript, Summary, TranscriptSource } from "../types";
import { AppError } from "../lib/errors";
import { ERROR_CODES } from "../lib/constants";
import { generateEpisodeTags } from "../services/tag-generation";
import { parseApplePodcastsUrl } from "../lib/url-parser";
import {
    getJob,
    updateJobStatus,
    updateJobMetadata,
    getEpisode,
    saveEpisode,
    getTranscript,
    saveTranscript,
    saveSummary,
    addToEpisodeIndex,
} from "../lib/kv";
import {
    updateJobStatusDO,
    updateJobEstimateDO,
    updateJobMetadataDO,
} from "../lib/job-status-do";
import { getEpisodeMetadata } from "../services/apple-podcasts";
import { fetchTranscript as fetchRssTranscript } from "../services/rss";
import { transcribeAudio } from "../services/transcription";
import { generateSummary } from "../services/summarization";

// ============================================================================
// Helper: Update status in both DO (immediate) and KV (backup)
// ============================================================================

async function updateJobStatusBoth(
    env: Env,
    kv: KVNamespace,
    jobId: string,
    status: import("../types").JobStatus,
    error?: string
): Promise<void> {
    // Write to DO first for immediate visibility
    await updateJobStatusDO(env, jobId, status, error);
    // Also write to KV as backup
    await updateJobStatus(kv, jobId, status, error);
}

async function updateJobEstimateBoth(
    env: Env,
    kv: KVNamespace,
    jobId: string,
    estimatedSeconds: number
): Promise<void> {
    // Update DO (non-critical, logs errors internally)
    await updateJobEstimateDO(env, jobId, estimatedSeconds);
    // Update KV as backup
    await updateJobEstimate(kv, jobId, estimatedSeconds);
}

// ============================================================================
// Types
// ============================================================================

interface ProcessingContext {
    env: Env;
    jobId: string;
    episodeId: string;
    appleUrl: string;
    templateId: string;
    // Pre-fetched iTunes metadata (avoids 403 errors from iTunes API)
    episodeGuid?: string;
    expectedTitle?: string;
    expectedDate?: string;
    // User who submitted the episode
    submittedBy?: string;
}

// ============================================================================
// Main Queue Handler Export
// ============================================================================

const queueHandler = {
    /**
     * Cloudflare Queue batch handler
     * Processes messages one at a time (max_batch_size = 1 in wrangler.toml)
     */
    async queue(
        batch: MessageBatch<QueueMessage>,
        env: Env
    ): Promise<void> {
        for (const message of batch.messages) {
            try {
                await processMessage(message.body, env);
                message.ack();
            } catch (error) {
                // Log the error with context
                console.error(
                    JSON.stringify({
                        event: "job_error",
                        jobId: message.body.jobId,
                        episodeId: message.body.episodeId,
                        type: message.body.type,
                        error: error instanceof Error ? error.message : "Unknown error",
                        stack: error instanceof Error ? error.stack : undefined,
                        attempts: message.attempts,
                    })
                );

                // Check if we've exhausted retries (max_retries = 2 in wrangler.toml means 3 total attempts)
                const maxAttempts = 3;
                if (message.attempts >= maxAttempts) {
                    // Final attempt failed - mark job as failed and acknowledge
                    try {
                        const errorMessage = mapErrorToUserMessage(error);
                        // Write to both DO (immediate) and KV (backup)
                        await updateJobStatusDO(env, message.body.jobId, "failed", errorMessage);
                        await updateJobStatus(env.TLDL_DATA, message.body.jobId, "failed", errorMessage);
                        console.log(
                            JSON.stringify({
                                event: "job_marked_failed",
                                jobId: message.body.jobId,
                                errorMessage,
                            })
                        );
                    } catch (updateError) {
                        console.error("Failed to update job status:", updateError);
                    }
                    message.ack(); // Don't retry anymore
                } else {
                    // Determine retry delay - use longer delay for rate limits
                    const isRateLimited = error instanceof AppError && error.code === ERROR_CODES.RATE_LIMITED;
                    const delaySeconds = isRateLimited ? 15 : 5; // 15s for rate limit, 5s for other errors

                    console.log(
                        JSON.stringify({
                            event: "job_retry",
                            jobId: message.body.jobId,
                            attempt: message.attempts,
                            maxAttempts,
                            delaySeconds,
                            isRateLimited,
                        })
                    );
                    message.retry({ delaySeconds });
                }
            }
        }
    },
};

export default queueHandler;

// ============================================================================
// Message Processing
// ============================================================================

/**
 * Route message to appropriate handler based on type
 */
async function processMessage(msg: QueueMessage, env: Env): Promise<void> {
    const context: ProcessingContext = {
        env,
        jobId: msg.jobId,
        episodeId: msg.episodeId,
        appleUrl: msg.appleUrl,
        templateId: msg.templateId,
        episodeGuid: msg.episodeGuid,
        expectedTitle: msg.expectedTitle,
        expectedDate: msg.expectedDate,
        submittedBy: msg.submittedBy,
    };

    console.log(
        JSON.stringify({
            event: "job_started",
            jobId: msg.jobId,
            type: msg.type,
            episodeId: msg.episodeId,
            hasPreFetchedMetadata: !!(msg.episodeGuid || msg.expectedTitle),
        })
    );

    if (msg.type === "process_episode") {
        await processEpisode(context);
    } else if (msg.type === "regenerate_summary") {
        await regenerateSummary(context);
    } else {
        throw new Error(`Unknown message type: ${(msg as QueueMessage).type}`);
    }

    console.log(
        JSON.stringify({
            event: "job_completed",
            jobId: msg.jobId,
            type: msg.type,
            episodeId: msg.episodeId,
        })
    );
}

// ============================================================================
// Process Episode Pipeline
// ============================================================================

/**
 * Full episode processing pipeline:
 * 1. Check for existing episode/transcript (fast path for regeneration)
 * 2. Fetch metadata if needed
 * 3. Check RSS for transcript if needed
 * 4. Transcribe via Whisper if needed
 * 5. Generate summary
 * 6. Store all data
 */
async function processEpisode(ctx: ProcessingContext): Promise<void> {
    const { env, jobId, episodeId, appleUrl, templateId, episodeGuid, expectedTitle, expectedDate, submittedBy } = ctx;
    const kv = env.TLDL_DATA;
    const maxMinutes = parseInt(env.MAX_EPISODE_MINUTES, 10) || 80;

    // Step 1: Quick check for existing episode and transcript (fast path)
    // Don't update status yet - check silently first
    const existingEpisode = await getEpisode(kv, episodeId);
    let transcript: Transcript | null = await getTranscript(kv, episodeId);
    let transcriptSource: TranscriptSource = "openai";

    // Fast path: If we have both episode and transcript, skip to summarization
    if (existingEpisode && transcript) {
        // Show "checking transcript" briefly since we found cached data
        await updateJobStatusBoth(env, kv, jobId, "checking_transcript");

        console.log(
            JSON.stringify({
                event: "fast_path_summarization",
                episodeId,
                transcriptSource: transcript.source,
            })
        );

        transcriptSource = transcript.source;

        // Jump straight to summary generation
        await updateJobStatusBoth(env, kv, jobId, "summarizing");
        await updateJobEstimateBoth(env, kv, jobId, 30); // ~30 seconds for summary

        const summaryResult = await generateSummary(
            transcript.text,
            templateId,
            env.OPENAI_API_KEY
        );

        const summary: Summary = {
            episodeId,
            templateId,
            text: summaryResult.text,
            model: summaryResult.model,
            createdAt: new Date().toISOString(),
        };
        await saveSummary(kv, summary);

        // Mark job as completed
        await updateJobStatusBoth(env, kv, jobId, "completed");
        return;
    }

    // Standard path: Need to fetch metadata first
    await updateJobStatusBoth(env, kv, jobId, "fetching_metadata");
    await updateJobEstimateBoth(env, kv, jobId, 180); // ~3 minutes initial estimate

    const parsedUrl = parseApplePodcastsUrl(appleUrl);
    if (!parsedUrl) {
        throw new AppError(ERROR_CODES.INVALID_URL, "Invalid Apple Podcasts URL");
    }

    // Use pre-fetched iTunes metadata from queue message (avoids 403 errors)
    // Pass env for Podcast Index API access (primary source)
    // Pass appleUrl for redirect-based title extraction when no pre-fetched metadata
    const metadata = await getEpisodeMetadata(parsedUrl, {
        maxMinutes,
        episodeGuid,
        expectedTitle,
        expectedDate,
        env,
        appleUrl,
    });

    // Update job with metadata so it shows on the status page
    await updateJobMetadataDO(env, jobId, metadata.podcastName, metadata.episodeTitle);
    await updateJobMetadata(kv, jobId, metadata.podcastName, metadata.episodeTitle);

    // Step 2: Check RSS for transcript if we don't have one
    if (!transcript) {
        await updateJobStatusBoth(env, kv, jobId, "checking_transcript");

        if (metadata.transcriptUrl && metadata.transcriptType) {
            const rssTranscriptText = await fetchRssTranscript(
                metadata.transcriptUrl,
                metadata.transcriptType
            );
            if (rssTranscriptText && rssTranscriptText.length > 100) {
                transcriptSource = "rss";
                transcript = {
                    episodeId,
                    text: rssTranscriptText,
                    source: "rss",
                    createdAt: new Date().toISOString(),
                };
                await saveTranscript(kv, transcript);
            }
        }
    } else {
        transcriptSource = transcript.source;
    }

    // Step 3: Transcribe via Whisper if no transcript found
    if (!transcript) {
        await updateJobStatusBoth(env, kv, jobId, "transcribing");

        // Update estimate based on duration (~1-2 min per 15 min audio + 30s for summary)
        const durationMinutes = metadata.episodeDuration / 60;
        const estimatedTranscriptionSeconds = Math.round((durationMinutes / 15) * 90);
        await updateJobEstimateBoth(env, kv, jobId, estimatedTranscriptionSeconds + 30);

        const transcriptionResult = await transcribeAudio(
            metadata.audioUrl,
            env.OPENAI_API_KEY
        );

        transcriptSource = "openai";
        transcript = {
            episodeId,
            text: transcriptionResult.text,
            source: "openai",
            createdAt: new Date().toISOString(),
        };
        await saveTranscript(kv, transcript);
    }

    // Step 4: Generate summary
    await updateJobStatusBoth(env, kv, jobId, "summarizing");
    await updateJobEstimateBoth(env, kv, jobId, 30); // ~30 seconds for summary

    const summaryResult = await generateSummary(
        transcript.text,
        templateId,
        env.OPENAI_API_KEY
    );

    const summary: Summary = {
        episodeId,
        templateId,
        text: summaryResult.text,
        model: summaryResult.model,
        createdAt: new Date().toISOString(),
    };
    await saveSummary(kv, summary);

    // Step 4.5: Generate tags (non-critical - don't fail job if this fails)
    let tags: string[] = [];
    try {
        const tagResult = await generateEpisodeTags(
            summary.text,
            transcript.text,
            env.OPENAI_API_KEY
        );
        tags = tagResult.tags;

        console.log(
            JSON.stringify({
                event: "tags_generated",
                episodeId,
                tags: tags,
                model: tagResult.model,
            })
        );
    } catch (error) {
        // Log but don't fail the job
        console.error(
            JSON.stringify({
                event: "tag_generation_failed",
                episodeId,
                error: error instanceof Error ? error.message : "Unknown error",
            })
        );
        // Continue with empty tags
    }

    // Step 5: Save episode metadata (only if it doesn't exist)
    if (!existingEpisode) {
        const now = new Date();
        const expiresAt = new Date(now);
        expiresAt.setDate(expiresAt.getDate() + 365);

        const episode: Episode = {
            id: episodeId,
            appleUrl,
            podcastName: metadata.podcastName,
            episodeTitle: metadata.episodeTitle,
            episodeDuration: metadata.episodeDuration,
            episodeDate: metadata.episodeDate,
            audioUrl: metadata.audioUrl,
            transcriptSource,
            createdAt: now.toISOString(),
            expiresAt: expiresAt.toISOString(),
            submittedBy,
            tags: tags.length > 0 ? tags : undefined,
        };
        await saveEpisode(kv, episode);

        // Add to episode index for efficient home page listing
        await addToEpisodeIndex(kv, {
            id: episode.id,
            podcastName: episode.podcastName,
            episodeTitle: episode.episodeTitle,
            episodeDate: episode.episodeDate,
            episodeDuration: episode.episodeDuration,
            createdAt: episode.createdAt,
            expiresAt: episode.expiresAt,
            tags: episode.tags,
        });
    }

    // Step 6: Mark job as completed
    await updateJobStatusBoth(env, kv, jobId, "completed");
}

// ============================================================================
// Regenerate Summary Pipeline
// ============================================================================

/**
 * Regenerate summary using existing transcript:
 * 1. Verify transcript exists
 * 2. Generate new summary with different template
 */
async function regenerateSummary(ctx: ProcessingContext): Promise<void> {
    const { env, jobId, episodeId, templateId } = ctx;
    const kv = env.TLDL_DATA;

    // Verify episode and transcript exist
    const [episode, transcript] = await Promise.all([
        getEpisode(kv, episodeId),
        getTranscript(kv, episodeId),
    ]);

    if (!episode) {
        throw new AppError(ERROR_CODES.EPISODE_NOT_FOUND, "Episode not found");
    }

    if (!transcript) {
        throw new AppError(
            ERROR_CODES.TRANSCRIPTION_FAILED,
            "Transcript not found. Cannot regenerate summary without transcript."
        );
    }

    // Generate summary
    await updateJobStatusBoth(env, kv, jobId, "summarizing");
    await updateJobEstimateBoth(env, kv, jobId, 30);

    const summaryResult = await generateSummary(
        transcript.text,
        templateId,
        env.OPENAI_API_KEY
    );

    const summary: Summary = {
        episodeId,
        templateId,
        text: summaryResult.text,
        model: summaryResult.model,
        createdAt: new Date().toISOString(),
    };
    await saveSummary(kv, summary);

    // Mark completed
    await updateJobStatusBoth(env, kv, jobId, "completed");
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Update the estimated seconds remaining for a job
 */
async function updateJobEstimate(
    kv: KVNamespace,
    jobId: string,
    estimatedSeconds: number
): Promise<void> {
    try {
        const job = await getJob(kv, jobId);
        if (job) {
            job.estimatedSeconds = estimatedSeconds;
            job.updatedAt = new Date().toISOString();
            await kv.put(`job:${jobId}`, JSON.stringify(job), {
                expirationTtl: 7 * 24 * 60 * 60, // 7 days
            });
        }
    } catch {
        // Non-critical - don't fail job if estimate update fails
    }
}

/**
 * Map error to user-friendly message
 */
function mapErrorToUserMessage(error: unknown): string {
    if (error instanceof AppError) {
        return error.userMessage;
    }

    if (error instanceof Error) {
        // Check for common error patterns
        const msg = error.message.toLowerCase();

        if (msg.includes("rate limit") || msg.includes("429")) {
            return "Service is busy. Your request will be retried automatically.";
        }

        if (msg.includes("timeout")) {
            return "Request timed out. Please try again.";
        }

        if (msg.includes("network") || msg.includes("fetch")) {
            return "Network error occurred. Please try again.";
        }
    }

    return "An unexpected error occurred. Please try again.";
}
