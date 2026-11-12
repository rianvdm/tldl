/**
 * Queue Consumer for TLDL Background Job Processing
 *
 * Handles the full pipeline for podcast episode processing:
 * 1. Fetch episode metadata from Apple/RSS
 * 2. Check for existing transcript (RSS or previous processing)
 * 3. Transcribe via OpenAI gpt-transcribe if needed
 * 4. Generate summary via GPT-5.2
 * 5. Store results in KV
 */

import type { Env, QueueMessage, Episode, Transcript, Summary, TranscriptSource } from "../types";
import { AppError } from "../lib/errors";
import { ERROR_CODES } from "../lib/constants";
import { generateEpisodeTags } from "../services/tag-generation";
import { generateEditorialMeta } from "../services/editorial-meta";
import { parseApplePodcastsUrl, extractPodcastId } from "../lib/url-parser";
import { resolveWebsiteUrl, showLevelAppleUrl, toEpisodePageUrl, toWebsiteUrl } from "../lib/podcast-links";
import { notifyDiscord, DISCORD_COLORS } from "../lib/discord";
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
    appendActivityEvent,
    getMonitoredPodcast,
} from "../lib/kv";
import {
    updateJobStatusDO,
    updateJobEstimateDO,
    updateJobMetadataDO,
} from "../lib/job-status-do";
import { getEpisodeMetadata } from "../services/apple-podcasts";
import type { EpisodeMetadata } from "../services/apple-podcasts";
import {
    fetchTranscript as fetchRssTranscript,
    fetchAndParseFeed,
    findEpisodeInFeedExact,
    type RssEpisode,
} from "../services/rss";
import { transcribeAudio } from "../services/transcription";
import type { TranscriptionResult } from "../services/transcription";
import { generateSummary } from "../services/summarization";
import { notifySubscribers } from "../notifications";

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
    appleUrl?: string;
    appleUrlIsSynthetic?: boolean;
    templateId: string;
    // Pre-fetched iTunes metadata (avoids 403 errors from iTunes API)
    episodeGuid?: string;
    expectedTitle?: string;
    expectedDate?: string;
    // Override audio URL (bypasses origin rate limiting on redirecting hosts)
    audioUrlOverride?: string;
    // Pre-resolved audio URL (redirect followed in request handler context)
    preResolvedAudioUrl?: string;
    // User who submitted the episode
    submittedBy?: string;
    // RSS-sourced monitoring: skip Podcast Index / iTunes lookup entirely
    rssSourced?: boolean;
    prefetchedAudioUrl?: string;
    prefetchedDurationSeconds?: number;
    prefetchedTranscriptUrl?: string;
    prefetchedTranscriptType?: string;
    prefetchedPodcastTitle?: string;
    prefetchedWebsiteUrl?: string;
    prefetchedEpisodePageUrl?: string;
}

/**
 * Surface a transcript that was accepted with its final chunk missing (#54).
 * The episode still completes, so without this the gap would only be visible
 * in Workers logs. Activity log and Discord are non-critical: never throws.
 */
async function reportPartialTranscript(
    env: Env,
    episodeId: string,
    metadata: EpisodeMetadata,
    result: { partialReason?: string; text: string },
): Promise<void> {
    const reason = result.partialReason ?? "Transcript is missing the end of the episode.";
    console.warn(JSON.stringify({
        event: "transcription_partial",
        episodeId,
        reason,
        textLength: result.text.length,
    }));

    const episodeLabel = `${metadata.podcastName}: ${metadata.episodeTitle}`;
    try {
        await appendActivityEvent(env.TLDL_DATA, {
            type: "episode_partial",
            timestamp: new Date().toISOString(),
            title: episodeLabel,
            details: reason,
            episodeId,
        });
        await notifyDiscord(env.DISCORD_WEBHOOK_URL, {
            title: "🟡 Episode transcript is incomplete",
            description: `**${episodeLabel}**\n\n${reason}\n\n🔗 https://tldl-pod.com/episode/${episodeId}`,
            color: DISCORD_COLORS.WARNING,
        });
    } catch {
        // Activity log and Discord are non-critical — don't fail the job
    }
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

                // Log successful completion to activity log and notify Discord
                try {
                    const episode = await getEpisode(env.TLDL_DATA, message.body.episodeId);
                    const episodeLabel = episode
                        ? `${episode.podcastName}: ${episode.episodeTitle}`
                        : `Episode ${message.body.episodeId}`;

                    await appendActivityEvent(env.TLDL_DATA, {
                        type: "episode_completed",
                        timestamp: new Date().toISOString(),
                        title: episodeLabel,
                        episodeId: message.body.episodeId,
                    });

                    const episodeUrl = `https://tldl-pod.com/episode/${message.body.episodeId}`;
                    await notifyDiscord(env.DISCORD_WEBHOOK_URL, {
                        title: "🟢 Episode processed successfully",
                        description: `**${episodeLabel}**\n\n🔗 ${episodeUrl}`,
                        color: DISCORD_COLORS.SUCCESS,
                    });
                } catch {
                    // Activity log and Discord are non-critical — don't fail the job
                }
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

                // Zombie messages: the job's DO/KV record has been deleted (likely
                // by the stale-job sweep or admin cleanup) but the queue still has
                // the message and keeps redelivering it. Every retry slams the
                // audio CDN before failing on the missing job. Ack and drop.
                const isZombie = error instanceof Error && error.message.startsWith("Job not found:");
                if (isZombie) {
                    console.log(
                        JSON.stringify({
                            event: "zombie_message_dropped",
                            jobId: message.body.jobId,
                            episodeId: message.body.episodeId,
                            attempts: message.attempts,
                        })
                    );
                    message.ack();
                    continue;
                }

                // Rate-limited jobs get more attempts with longer backoff to let CDN cool down
                const isRateLimited = error instanceof AppError && error.code === ERROR_CODES.RATE_LIMITED;
                // Unsupported audio (e.g. fragmented MP4, non-AAC codec) and audio the
                // model rejected are deterministic: retrying can't help
                const isDeterministicAudioFailure =
                    error instanceof AppError &&
                    (error.code === ERROR_CODES.AUDIO_UNSUPPORTED || error.code === ERROR_CODES.AUDIO_REJECTED);
                const maxAttempts = isDeterministicAudioFailure ? 1 : isRateLimited ? 5 : 3;
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
                                // An AppError's userMessage can carry a full audio URL; its message never does
                                errorMessage: error instanceof AppError ? error.message : errorMessage,
                            })
                        );

                        // Log failure to activity log and notify Discord
                        try {
                            const episode = await getEpisode(env.TLDL_DATA, message.body.episodeId);
                            const episodeLabel = episode
                                ? `${episode.podcastName}: ${episode.episodeTitle}`
                                : `Episode ${message.body.episodeId}`;

                            await appendActivityEvent(env.TLDL_DATA, {
                                type: "episode_failed",
                                timestamp: new Date().toISOString(),
                                title: episodeLabel,
                                details: errorMessage,
                                episodeId: message.body.episodeId,
                            });

                            await notifyDiscord(env.DISCORD_WEBHOOK_URL, {
                                title: "🔴 Episode processing failed",
                                description: `**${episodeLabel}**\n\n${errorMessage}`,
                                color: DISCORD_COLORS.ERROR,
                            });
                        } catch {
                            // Activity log and Discord are non-critical
                        }
                    } catch (updateError) {
                        console.error("Failed to update job status:", updateError);
                    }
                    message.ack(); // Don't retry anymore
                } else {
                    // Use much longer delays for CDN rate limits — short retries just extend the ban
                    const delaySeconds = isRateLimited
                        ? 120 * message.attempts  // 2min, 4min, 6min, 8min, 10min
                        : 5;

                    // Surface retry state to the user. Keep `status` at its current
                    // step (so the UI's progress phrasing still works) but populate
                    // the error field with a human-readable retry note. This bumps
                    // `updatedAt`, but it doesn't hold off the stale-job sweep: that
                    // sweep (listActiveJobsWithDO) measures age from `createdAt` and
                    // fails the job once it passes TIMEOUTS.JOB_MS.
                    const retryNote = isRateLimited
                        ? `Audio CDN rate-limited. Retrying in ${Math.round(delaySeconds / 60)} min (attempt ${message.attempts} of ${maxAttempts}).`
                        : `Transient error; retrying in ${delaySeconds}s (attempt ${message.attempts} of ${maxAttempts}).`;
                    try {
                        const job = await getJob(env.TLDL_DATA, message.body.jobId);
                        const retryStatus = job?.status ?? "transcribing";
                        await updateJobStatusBoth(
                            env,
                            env.TLDL_DATA,
                            message.body.jobId,
                            retryStatus,
                            retryNote
                        );
                    } catch (statusErr) {
                        console.error(
                            JSON.stringify({
                                event: "retry_status_update_failed",
                                jobId: message.body.jobId,
                                error: statusErr instanceof Error ? statusErr.message : String(statusErr),
                            })
                        );
                    }

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

                    // Diagnostic: queue retries 2-5 have been observed to silently not
                    // fire after this call. Wrap to log any thrown error and confirm
                    // the call returned without throwing.
                    try {
                        message.retry({ delaySeconds });
                        console.log(
                            JSON.stringify({
                                event: "queue_retry_called",
                                jobId: message.body.jobId,
                                attempt: message.attempts,
                                delaySeconds,
                            })
                        );
                    } catch (retryErr) {
                        console.error(
                            JSON.stringify({
                                event: "queue_retry_threw",
                                jobId: message.body.jobId,
                                attempt: message.attempts,
                                delaySeconds,
                                error: retryErr instanceof Error ? retryErr.message : String(retryErr),
                            })
                        );
                    }
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
        appleUrlIsSynthetic: msg.appleUrlIsSynthetic,
        templateId: msg.templateId,
        episodeGuid: msg.episodeGuid,
        expectedTitle: msg.expectedTitle,
        expectedDate: msg.expectedDate,
        audioUrlOverride: msg.audioUrlOverride,
        preResolvedAudioUrl: msg.preResolvedAudioUrl,
        submittedBy: msg.submittedBy,
        rssSourced: msg.rssSourced,
        prefetchedAudioUrl: msg.audioUrl,
        prefetchedDurationSeconds: msg.durationSeconds,
        prefetchedTranscriptUrl: msg.transcriptUrl,
        prefetchedTranscriptType: msg.transcriptType,
        prefetchedPodcastTitle: msg.podcastTitle,
        prefetchedWebsiteUrl: msg.podcastWebsiteUrl,
        prefetchedEpisodePageUrl: msg.episodePageUrl,
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
    } else if (msg.type === "process_manual") {
        await processManualJob(context);
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
 * Read the podcast's feed and find this episode in it by exact identifiers.
 * Non-critical: links are a nicety, so any failure returns null and the job
 * carries on without them.
 */
async function readFeedEpisode(
    metadata: EpisodeMetadata,
    episodeGuid: string | undefined,
    episodeId: string
): Promise<{ feedLink?: string; episode: RssEpisode | null } | null> {
    if (!metadata.feedUrl) return null;
    try {
        const feed = await fetchAndParseFeed(metadata.feedUrl);
        const found = findEpisodeInFeedExact(feed, {
            guid: episodeGuid,
            audioUrl: metadata.audioUrl,
            title: metadata.episodeTitle,
        });
        return { feedLink: feed.link, episode: found?.episode ?? null };
    } catch (error) {
        console.log(JSON.stringify({
            event: "feed_links_lookup_failed",
            episodeId,
            error: error instanceof Error ? error.message : String(error),
        }));
        return null;
    }
}

/**
 * Full episode processing pipeline:
 * 1. Check for existing episode/transcript (fast path for regeneration)
 * 2. Fetch metadata if needed
 * 3. Check RSS for transcript if needed
 * 4. Transcribe via gpt-transcribe if needed
 * 5. Generate summary
 * 6. Store all data
 */
async function processEpisode(ctx: ProcessingContext): Promise<void> {
    const { env, jobId, episodeId, appleUrl, templateId, episodeGuid, expectedTitle, expectedDate, submittedBy } = ctx;
    const kv = env.TLDL_DATA;
    const maxMinutes = parseInt(env.MAX_EPISODE_MINUTES, 10) || 121;

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
            env.ANTHROPIC_API_KEY
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

    let metadata: EpisodeMetadata;
    // Outbound links. The monitor's RSS path sends these on the message; the
    // Apple-submitted path reads them from the feed below.
    let storedGuid = episodeGuid;
    let episodePageUrl = ctx.prefetchedEpisodePageUrl;

    if (ctx.rssSourced && ctx.prefetchedAudioUrl) {
        // RSS-sourced path: metadata was pre-fetched from the feed — skip PI / iTunes entirely
        const podcastId = episodeId.split("_")[0];
        const monitored = await getMonitoredPodcast(kv, podcastId);
        const durationSec = ctx.prefetchedDurationSeconds ?? 0;

        if (durationSec > maxMinutes * 60) {
            throw new AppError(
                ERROR_CODES.EPISODE_TOO_LONG,
                `Episode duration (${Math.round(durationSec / 60)} min) exceeds limit (${maxMinutes} min)`
            );
        }

        metadata = {
            podcastName: ctx.prefetchedPodcastTitle || monitored?.name || "Unknown Podcast",
            episodeTitle: expectedTitle || "Untitled Episode",
            episodeDuration: durationSec,
            episodeDate: expectedDate || new Date().toISOString(),
            audioUrl: ctx.prefetchedAudioUrl,
            feedUrl: monitored?.rssUrl || "",
            podcastAuthor: monitored?.author,
            podcastWebsiteUrl: ctx.prefetchedWebsiteUrl ?? toWebsiteUrl(monitored?.websiteUrl),
            ...(ctx.prefetchedTranscriptUrl && { transcriptUrl: ctx.prefetchedTranscriptUrl }),
            ...(ctx.prefetchedTranscriptType && { transcriptType: ctx.prefetchedTranscriptType }),
        };

        console.log(JSON.stringify({
            event: "consumer_rss_sourced_skip_pi",
            episodeId,
            audioUrl: ctx.prefetchedAudioUrl,
        }));
    } else {
        if (!appleUrl) {
            throw new AppError(ERROR_CODES.INVALID_URL, "Missing Apple Podcasts URL for process_episode job");
        }
        const parsedUrl = parseApplePodcastsUrl(appleUrl);
        if (!parsedUrl) {
            throw new AppError(ERROR_CODES.INVALID_URL, "Invalid Apple Podcasts URL");
        }

        // Use pre-fetched iTunes metadata from queue message (avoids 403 errors)
        // Pass env for Podcast Index API access (primary source)
        // Pass appleUrl for redirect-based title extraction when no pre-fetched metadata
        metadata = await getEpisodeMetadata(parsedUrl, {
            maxMinutes,
            episodeGuid,
            expectedTitle,
            expectedDate,
            env,
            appleUrl,
        });

        // getEpisodeMetadata's main (Podcast Index) path never reads the feed,
        // so read it here for the episode's page and the podcast's website.
        const feedEpisode = await readFeedEpisode(metadata, episodeGuid, episodeId);
        const monitored = await getMonitoredPodcast(kv, parsedUrl.podcastId);
        metadata.podcastWebsiteUrl = resolveWebsiteUrl(monitored?.websiteUrl, [feedEpisode?.feedLink, metadata.podcastWebsiteUrl]);
        episodePageUrl = toEpisodePageUrl(feedEpisode?.episode?.link, {
            websiteUrl: metadata.podcastWebsiteUrl,
            audioUrl: feedEpisode?.episode?.audioUrl,
        });
        storedGuid = episodeGuid ?? feedEpisode?.episode?.guid;
    }

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

    // Step 3: Transcribe via gpt-transcribe if no transcript found
    if (!transcript) {
        await updateJobStatusBoth(env, kv, jobId, "transcribing");

        // Update estimate based on duration (~1-2 min per 15 min audio + 30s for summary)
        const durationMinutes = metadata.episodeDuration / 60;
        const estimatedTranscriptionSeconds = Math.round((durationMinutes / 15) * 90);
        await updateJobEstimateBoth(env, kv, jobId, estimatedTranscriptionSeconds + 30);

        // Prefer pre-resolved URL (resolved in request handler context to bypass CDN WAF),
        // then audio URL override, then metadata audio URL.
        const audioUrl = ctx.preResolvedAudioUrl || ctx.audioUrlOverride || metadata.audioUrl;
        const skipValidation = !!(ctx.preResolvedAudioUrl || ctx.audioUrlOverride);
        if (ctx.preResolvedAudioUrl) {
            console.log(JSON.stringify({
                event: "using_preresolve_audio_url",
                resolved: ctx.preResolvedAudioUrl,
                original: ctx.audioUrlOverride || metadata.audioUrl,
            }));
        } else if (ctx.audioUrlOverride) {
            console.log(JSON.stringify({
                event: "using_audio_url_override",
                override: ctx.audioUrlOverride,
            }));
        }

        let transcriptionResult: TranscriptionResult;
        try {
            transcriptionResult = await transcribeAudio(
                audioUrl,
                { apiKey: env.OPENAI_API_KEY, skipValidation },
            );
        } catch (error) {
            throw withCheckChunksCommand(error, audioUrl);
        }

        if (transcriptionResult.partial) {
            await reportPartialTranscript(env, episodeId, metadata, transcriptionResult);
        }

        transcriptSource = transcriptionResult.source;
        transcript = {
            episodeId,
            text: transcriptionResult.text,
            source: transcriptionResult.source,
            model: transcriptionResult.model,
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
        env.ANTHROPIC_API_KEY
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

    // Step 4.6: Generate editorial meta (deck + pull quote) — non-critical
    // New episode — no existing value to preserve; store raw.
    let editorial: { deck?: string; pullQuote?: string } = {};
    try {
        const meta = await generateEditorialMeta(transcript.text, env.OPENAI_API_KEY);
        editorial = { deck: meta.deck, pullQuote: meta.pullQuote };
    } catch (err) {
        // Don't fail ingest if editorial-meta generation fails — log and continue.
        console.error(
            JSON.stringify({
                event: "editorial_meta_generation_failed",
                episodeId,
                source: "processEpisode",
                error: err instanceof Error ? err.message : "Unknown error",
            })
        );
    }

    // Step 5: Save episode metadata (only if it doesn't exist)
    if (!existingEpisode) {
        const now = new Date();
        const expiresAt = new Date(now);
        expiresAt.setDate(expiresAt.getDate() + 365);

        // Monitor-queued episodes have no real Apple episode ID yet (RSS path:
        // none at all; Podcast Index path: PI's own ID), so start with the
        // show-level URL. The cron upgrades it once Apple lists the episode
        // (see lib/apple-link-enrichment.ts), matching on episodeGuid.
        const storedAppleUrl = ctx.rssSourced || ctx.appleUrlIsSynthetic
            ? showLevelAppleUrl(episodeId.split("_")[0]) ?? ""
            : appleUrl ?? "";
        const episode: Episode = {
            id: episodeId,
            appleUrl: storedAppleUrl,
            episodeGuid: storedGuid,
            episodePageUrl,
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
            deck: editorial.deck,
            pullQuote: editorial.pullQuote,
            podcastAuthor: metadata.podcastAuthor,
            podcastWebsiteUrl: metadata.podcastWebsiteUrl,
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
            podcastAuthor: episode.podcastAuthor,
            audioUrl: episode.audioUrl,
        });
        const notifyPodcastId = extractPodcastId(episodeId);
        if (notifyPodcastId) {
            await notifySubscribers(env, {
                podcastId: notifyPodcastId,
                episode: { ...episode, summaryText: summary.text },
            });
        }
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
        env.ANTHROPIC_API_KEY
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
// Process Manual Transcript Pipeline
// ============================================================================

/**
 * Manual transcript processing pipeline:
 * 1. Load pre-stored transcript and partial episode from KV (seeded by the
 *    submit handler before enqueuing the job)
 * 2. Generate summary from the manual transcript
 * 3. Generate tags (non-critical — failures logged, job still completes)
 * 4. Update episode with tags and add to the episode index
 */
async function processManualJob(ctx: ProcessingContext): Promise<void> {
    const { env, jobId, episodeId, templateId, submittedBy } = ctx;
    const kv = env.TLDL_DATA;

    const [transcript, episode] = await Promise.all([
        getTranscript(kv, episodeId),
        getEpisode(kv, episodeId),
    ]);

    if (!transcript) {
        throw new AppError(
            ERROR_CODES.TRANSCRIPTION_FAILED,
            "Manual job is missing its transcript. Submission may have failed to write KV."
        );
    }
    if (!episode) {
        throw new AppError(
            ERROR_CODES.EPISODE_NOT_FOUND,
            "Manual job is missing its episode record."
        );
    }

    // Reflect podcast/episode title on the job so the status page renders nicely
    await updateJobMetadataDO(env, jobId, episode.podcastName, episode.episodeTitle);
    await updateJobMetadata(kv, jobId, episode.podcastName, episode.episodeTitle);

    // Generate summary
    await updateJobStatusBoth(env, kv, jobId, "summarizing");
    await updateJobEstimateBoth(env, kv, jobId, 30);

    const summaryResult = await generateSummary(
        transcript.text,
        templateId,
        env.ANTHROPIC_API_KEY
    );

    const summary: Summary = {
        episodeId,
        templateId,
        text: summaryResult.text,
        model: summaryResult.model,
        createdAt: new Date().toISOString(),
    };
    await saveSummary(kv, summary);

    // Generate tags (non-critical)
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
                tags,
                model: tagResult.model,
            })
        );
    } catch (error) {
        console.error(
            JSON.stringify({
                event: "tag_generation_failed",
                episodeId,
                error: error instanceof Error ? error.message : "Unknown error",
            })
        );
    }

    // Generate editorial meta (deck + pull quote) — non-critical
    let editorial: { deck?: string; pullQuote?: string } = {};
    try {
        const meta = await generateEditorialMeta(transcript.text, env.OPENAI_API_KEY);
        editorial = { deck: meta.deck, pullQuote: meta.pullQuote };
    } catch (err) {
        console.error(
            JSON.stringify({
                event: "editorial_meta_generation_failed",
                episodeId,
                source: "processManualJob",
                error: err instanceof Error ? err.message : "Unknown error",
            })
        );
    }

    // Update episode with new tags (preserve existing tags if generation failed)
    const updatedEpisode: Episode = {
        ...episode,
        tags: tags.length > 0 ? tags : episode.tags,
        deck: editorial.deck ?? episode.deck,
        pullQuote: editorial.pullQuote ?? episode.pullQuote,
        submittedBy: episode.submittedBy ?? submittedBy,
    };
    await saveEpisode(kv, updatedEpisode);

    // Add to episode index for home-page listing
    await addToEpisodeIndex(kv, {
        id: updatedEpisode.id,
        podcastName: updatedEpisode.podcastName,
        episodeTitle: updatedEpisode.episodeTitle,
        episodeDate: updatedEpisode.episodeDate,
        episodeDuration: updatedEpisode.episodeDuration,
        createdAt: updatedEpisode.createdAt,
        expiresAt: updatedEpisode.expiresAt,
        tags: updatedEpisode.tags,
        podcastAuthor: updatedEpisode.podcastAuthor,
        audioUrl: updatedEpisode.audioUrl,
    });
    const notifyPodcastId = extractPodcastId(episodeId);
    if (notifyPodcastId) {
        await notifySubscribers(env, {
            podcastId: notifyPodcastId,
            episode: { ...updatedEpisode, summaryText: summary.text },
        });
    }

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
 * Append a copy-paste `check:chunks` command to a model rejection's user-facing
 * message, so the failure alert says how to reproduce it. The URL goes only into
 * `userMessage`: `message` (and so the stack and logs) stays URL-free, because
 * signed CDN URLs carry credentials. Other errors pass through unchanged.
 */
function withCheckChunksCommand(error: unknown, audioUrl: string): unknown {
    if (!(error instanceof AppError) || error.code !== ERROR_CODES.AUDIO_REJECTED) {
        return error;
    }
    return new AppError(
        ERROR_CODES.AUDIO_REJECTED,
        error.message,
        error,
        `${error.userMessage}. Debug with: npm run check:chunks -- ${shellQuote(audioUrl)} --transcribe`
    );
}

/**
 * Quote a string as one POSIX shell argument, so `?`, `&` and `'` in a signed
 * URL survive being pasted into zsh or bash.
 */
function shellQuote(value: string): string {
    return `'${value.replace(/'/g, "'\\''")}'`;
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
