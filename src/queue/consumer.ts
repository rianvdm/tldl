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
import { parseApplePodcastsUrl } from "../lib/url-parser";
import {
    getJob,
    updateJobStatus,
    getEpisode,
    saveEpisode,
    getTranscript,
    saveTranscript,
    saveSummary,
} from "../lib/kv";
import { getEpisodeMetadata } from "../services/apple-podcasts";
import { fetchTranscript as fetchRssTranscript } from "../services/rss";
import { transcribeAudio } from "../services/transcription";
import { generateSummary } from "../services/summarization";

// ============================================================================
// Types
// ============================================================================

interface ProcessingContext {
    env: Env;
    jobId: string;
    episodeId: string;
    appleUrl: string;
    templateId: string;
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
                    })
                );

                // Mark job as failed in KV before retrying
                try {
                    const errorMessage = mapErrorToUserMessage(error);
                    await updateJobStatus(env.TLDL_DATA, message.body.jobId, "failed", errorMessage);
                } catch (updateError) {
                    console.error("Failed to update job status:", updateError);
                }

                // Retry the message (queue handles max_retries)
                message.retry();
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
    };

    console.log(
        JSON.stringify({
            event: "job_started",
            jobId: msg.jobId,
            type: msg.type,
            episodeId: msg.episodeId,
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
 * 1. Fetch metadata
 * 2. Check for/get transcript
 * 3. Generate summary
 * 4. Store all data
 */
async function processEpisode(ctx: ProcessingContext): Promise<void> {
    const { env, jobId, episodeId, appleUrl, templateId } = ctx;
    const kv = env.TLDL_DATA;
    const maxMinutes = parseInt(env.MAX_EPISODE_MINUTES, 10) || 80;

    // Step 1: Fetch episode metadata
    await updateJobStatus(kv, jobId, "fetching_metadata");
    await updateJobEstimate(kv, jobId, 180); // ~3 minutes initial estimate

    const parsedUrl = parseApplePodcastsUrl(appleUrl);
    if (!parsedUrl) {
        throw new AppError(ERROR_CODES.INVALID_URL, "Invalid Apple Podcasts URL");
    }

    const metadata = await getEpisodeMetadata(parsedUrl, maxMinutes);

    // Step 2: Check for existing transcript
    await updateJobStatus(kv, jobId, "checking_transcript");

    let transcript: Transcript | null = await getTranscript(kv, episodeId);
    let transcriptSource: TranscriptSource = "openai";

    if (!transcript) {
        // Check RSS feed for transcript
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
        // Use existing transcript source
        transcriptSource = transcript.source;
    }

    // Step 3: Transcribe via Whisper if no transcript found
    if (!transcript) {
        await updateJobStatus(kv, jobId, "transcribing");

        // Update estimate based on duration (~1-2 min per 15 min audio + 30s for summary)
        const durationMinutes = metadata.episodeDuration / 60;
        const estimatedTranscriptionSeconds = Math.round((durationMinutes / 15) * 90);
        await updateJobEstimate(kv, jobId, estimatedTranscriptionSeconds + 30);

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
    await updateJobStatus(kv, jobId, "summarizing");
    await updateJobEstimate(kv, jobId, 30); // ~30 seconds for summary

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

    // Step 5: Save episode metadata
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
    };
    await saveEpisode(kv, episode);

    // Step 6: Mark job as completed
    await updateJobStatus(kv, jobId, "completed");
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
    await updateJobStatus(kv, jobId, "summarizing");
    await updateJobEstimate(kv, jobId, 30);

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
    await updateJobStatus(kv, jobId, "completed");
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
