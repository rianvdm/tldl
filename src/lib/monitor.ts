/**
 * Podcast Monitoring Service
 * Core logic for checking monitored podcasts for new episodes
 */

import type { Env, MonitoredPodcast, Job } from "../types";
import {
    getMonitorSettings,
    getMonitoredPodcastIds,
    getMonitoredPodcast,
    getProcessedEpisodes,
    markEpisodeProcessed,
    markEpisodesProcessed,
    updateMonitoredPodcastStatus,
    saveMonitoredPodcast,
    addToMonitoredList,
    getEpisode,
    getEpisodeIndex,
} from "./kv";
import { fetchAndParseFeed, type RssEpisode } from "../services/rss";
import { lookupPodcastByItunesId, getEpisodesByItunesId } from "../services/podcast-index";
import { createJob } from "./kv";
import { enqueueJob, createProcessEpisodeMessage } from "./queue";
import { createJobDO } from "./job-status-do";
import { AppError } from "./errors";
import { ERROR_CODES } from "./constants";

// Generate a UUID v4
function generateUUID(): string {
    return crypto.randomUUID();
}

// ============================================================================
// Types
// ============================================================================

export interface CheckResult {
    podcastId: string;
    podcastName: string;
    newEpisodes: number;
    queued: string[];  // Episode titles that were queued
    errors: string[];
}

export interface CheckAllResult {
    checked: number;
    totalNewEpisodes: number;
    results: CheckResult[];
    errors: string[];
}

// ============================================================================
// Add Podcast Flow
// ============================================================================

export interface AddPodcastResult {
    success: boolean;
    podcast?: MonitoredPodcast;
    queuedLatest?: boolean;
    error?: string;
}

/**
 * Add a new podcast to monitoring
 * 
 * 1. Parse Apple Podcasts URL → extract podcast ID
 * 2. Check if already monitored
 * 3. Look up RSS URL from Podcast Index
 * 4. Verify RSS feed is accessible
 * 5. Mark all current episodes as "processed" (prevent backlog)
 * 6. Optionally queue the latest episode if not already in KV
 */
export async function addPodcastToMonitoring(
    env: Env,
    podcastId: string,
    templateId: string,
    queueLatest: boolean = true
): Promise<AddPodcastResult> {
    // Check if already monitored
    const existing = await getMonitoredPodcast(env.TLDL_DATA, podcastId);
    if (existing) {
        return { success: false, error: "Podcast is already being monitored" };
    }

    // Look up podcast info from Podcast Index
    const podcastInfo = await lookupPodcastByItunesId(
        podcastId,
        env.PODCAST_INDEX_KEY,
        env.PODCAST_INDEX_SECRET
    );

    if (!podcastInfo) {
        return { success: false, error: "Could not find podcast in Podcast Index" };
    }

    // Verify RSS feed is accessible
    let feed;
    try {
        feed = await fetchAndParseFeed(podcastInfo.url);
    } catch (error) {
        return {
            success: false,
            error: `Could not fetch RSS feed: ${error instanceof Error ? error.message : String(error)}`
        };
    }

    // Mark all existing episode GUIDs as processed (prevent backlog cascade)
    const episodeGuids = feed.episodes.map(ep => ep.guid);
    await markEpisodesProcessed(env.TLDL_DATA, podcastId, episodeGuids);

    // Create the monitored podcast record
    const podcast: MonitoredPodcast = {
        id: podcastId,
        name: podcastInfo.title,
        rssUrl: podcastInfo.url,
        templateId,
        addedAt: new Date().toISOString(),
        episodesProcessed: 0,
        status: "active",
    };

    await saveMonitoredPodcast(env.TLDL_DATA, podcast);
    await addToMonitoredList(env.TLDL_DATA, podcastId);

    // Optionally queue the latest episode if it's not already in KV
    let queuedLatest = false;
    if (queueLatest && feed.episodes.length > 0) {
        const latestEpisode = feed.episodes[0];  // RSS feeds are typically newest-first

        // Get Podcast Index episodes to find the episode ID
        const piEpisodes = await getEpisodesByItunesId(
            podcastId,
            env.PODCAST_INDEX_KEY,
            env.PODCAST_INDEX_SECRET,
            10
        );

        // Try to match by GUID or title
        const matchedPiEpisode = piEpisodes.find(
            ep => ep.guid === latestEpisode.guid ||
                ep.title.toLowerCase() === latestEpisode.title.toLowerCase()
        );

        if (matchedPiEpisode) {
            const episodeId = `${podcastId}_${matchedPiEpisode.id}`;

            // Check if already exists in KV (by ID or by title)
            const existingEpisode = await getEpisode(env.TLDL_DATA, episodeId);
            const existsByTitle = await episodeExistsByTitle(env, podcastId, latestEpisode.title);

            if (!existingEpisode && !existsByTitle) {
                // Queue the latest episode
                await queueEpisodeForProcessing(env, {
                    podcastId,
                    episodeId,
                    episodeGuid: latestEpisode.guid,
                    expectedTitle: latestEpisode.title,
                    expectedDate: latestEpisode.pubDate,
                    templateId,
                    appleUrl: `https://podcasts.apple.com/us/podcast/podcast/id${podcastId}?i=${matchedPiEpisode.id}`,
                });
                queuedLatest = true;
            }
        }
    }

    console.log(JSON.stringify({
        event: "podcast_added_to_monitoring",
        podcastId,
        podcastName: podcastInfo.title,
        rssUrl: podcastInfo.url,
        episodeCount: feed.episodes.length,
        queuedLatest,
    }));

    return { success: true, podcast, queuedLatest };
}

// ============================================================================
// Check Single Podcast
// ============================================================================

/**
 * Check a single podcast for new episodes
 * Primary strategy: Podcast Index API (avoids RSS feed 429s from CDNs)
 * Fallback: RSS feed (if PI is rate-limited)
 */
export async function checkPodcastForNewEpisodes(
    env: Env,
    podcast: MonitoredPodcast,
    maxEpisodes: number = 5
): Promise<CheckResult> {
    const result: CheckResult = {
        podcastId: podcast.id,
        podcastName: podcast.name,
        newEpisodes: 0,
        queued: [],
        errors: [],
    };

    try {
        // Calculate "since" timestamp: lastChecked or 7 days ago
        const sinceDate = podcast.lastChecked
            ? new Date(podcast.lastChecked)
            : new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
        const sinceEpoch = Math.floor(sinceDate.getTime() / 1000);

        try {
            // Primary: Podcast Index API with since filter
            console.log(JSON.stringify({
                event: "monitor_check_strategy",
                podcastId: podcast.id,
                podcastName: podcast.name,
                strategy: "podcast_index",
                since: sinceDate.toISOString(),
                sinceEpoch,
            }));

            const piEpisodes = await getEpisodesByItunesId(
                podcast.id,
                env.PODCAST_INDEX_KEY,
                env.PODCAST_INDEX_SECRET,
                100,
                sinceEpoch
            );

            console.log(JSON.stringify({
                event: "monitor_pi_new_episodes",
                podcastId: podcast.id,
                podcastName: podcast.name,
                episodeCount: piEpisodes.length,
            }));

            // Filter against already-processed GUIDs
            const processedGuids = await getProcessedEpisodes(env.TLDL_DATA, podcast.id);
            const processedSet = new Set(processedGuids);
            const newEpisodes = piEpisodes.filter(ep => !processedSet.has(ep.guid));

            if (newEpisodes.length === 0) {
                await updateMonitoredPodcastStatus(env.TLDL_DATA, podcast.id, {
                    lastChecked: new Date().toISOString(),
                    status: "active",
                });
                return result;
            }

            // Process new episodes (up to max)
            const episodesToProcess = newEpisodes.slice(0, maxEpisodes);

            for (const piEpisode of episodesToProcess) {
                try {
                    const episodeId = `${podcast.id}_${piEpisode.id}`;

                    // Check if already in KV by ID or title
                    const existingEpisode = await getEpisode(env.TLDL_DATA, episodeId);
                    const existsByTitle = await episodeExistsByTitle(env, podcast.id, piEpisode.title);

                    if (existingEpisode || existsByTitle) {
                        await markEpisodeProcessed(env.TLDL_DATA, podcast.id, piEpisode.guid);
                        continue;
                    }

                    // Queue the episode — PI provides everything we need
                    await queueEpisodeForProcessing(env, {
                        podcastId: podcast.id,
                        episodeId,
                        episodeGuid: piEpisode.guid,
                        expectedTitle: piEpisode.title,
                        expectedDate: new Date(piEpisode.datePublished * 1000).toISOString(),
                        templateId: podcast.templateId,
                        appleUrl: `https://podcasts.apple.com/us/podcast/podcast/id${podcast.id}?i=${piEpisode.id}`,
                    });

                    await markEpisodeProcessed(env.TLDL_DATA, podcast.id, piEpisode.guid);
                    result.queued.push(piEpisode.title);
                    result.newEpisodes++;

                } catch (error) {
                    result.errors.push(`Error processing ${piEpisode.title}: ${error instanceof Error ? error.message : String(error)}`);
                }
            }

        } catch (piError) {
            // Fallback to RSS if PI fails (e.g. rate limited)
            const reason = piError instanceof AppError && piError.code === ERROR_CODES.RATE_LIMITED
                ? "podcast_index_rate_limited"
                : "podcast_index_error";

            console.log(JSON.stringify({
                event: "monitor_check_fallback_to_rss",
                podcastId: podcast.id,
                podcastName: podcast.name,
                reason,
                error: piError instanceof Error ? piError.message : String(piError),
            }));

            // RSS fallback: original flow
            const feed = await fetchAndParseFeed(podcast.rssUrl);
            const processedGuids = await getProcessedEpisodes(env.TLDL_DATA, podcast.id);
            const processedSet = new Set(processedGuids);
            const newEpisodes = feed.episodes.filter(ep => !processedSet.has(ep.guid));

            if (newEpisodes.length === 0) {
                await updateMonitoredPodcastStatus(env.TLDL_DATA, podcast.id, {
                    lastChecked: new Date().toISOString(),
                    status: "active",
                });
                return result;
            }

            // Need PI episodes for ID mapping in RSS fallback
            // Use a fresh call without since (PI rate limit may have been transient)
            const piEpisodes = await getEpisodesByItunesId(
                podcast.id,
                env.PODCAST_INDEX_KEY,
                env.PODCAST_INDEX_SECRET,
                100
            );

            const episodesToProcess = newEpisodes.slice(0, maxEpisodes);

            for (const rssEpisode of episodesToProcess) {
                try {
                    const matchedPiEpisode = findMatchingPiEpisode(rssEpisode, piEpisodes);

                    if (!matchedPiEpisode) {
                        result.errors.push(`Could not find episode ID for: ${rssEpisode.title}`);
                        console.log(JSON.stringify({
                            event: "monitor_pi_match_not_found",
                            podcastId: podcast.id,
                            episodeTitle: rssEpisode.title,
                            episodeGuid: rssEpisode.guid,
                        }));
                        continue;
                    }

                    const episodeId = `${podcast.id}_${matchedPiEpisode.id}`;
                    const existingEpisode = await getEpisode(env.TLDL_DATA, episodeId);
                    const existsByTitle = await episodeExistsByTitle(env, podcast.id, rssEpisode.title);

                    if (existingEpisode || existsByTitle) {
                        await markEpisodeProcessed(env.TLDL_DATA, podcast.id, rssEpisode.guid);
                        continue;
                    }

                    await queueEpisodeForProcessing(env, {
                        podcastId: podcast.id,
                        episodeId,
                        episodeGuid: rssEpisode.guid,
                        expectedTitle: rssEpisode.title,
                        expectedDate: rssEpisode.pubDate,
                        templateId: podcast.templateId,
                        appleUrl: `https://podcasts.apple.com/us/podcast/podcast/id${podcast.id}?i=${matchedPiEpisode.id}`,
                    });

                    await markEpisodeProcessed(env.TLDL_DATA, podcast.id, rssEpisode.guid);
                    result.queued.push(rssEpisode.title);
                    result.newEpisodes++;

                } catch (error) {
                    result.errors.push(`Error processing ${rssEpisode.title}: ${error instanceof Error ? error.message : String(error)}`);
                }
            }
        }

        // Update podcast status
        const currentPodcast = await getMonitoredPodcast(env.TLDL_DATA, podcast.id);
        await updateMonitoredPodcastStatus(env.TLDL_DATA, podcast.id, {
            lastChecked: new Date().toISOString(),
            episodesProcessed: (currentPodcast?.episodesProcessed || 0) + result.newEpisodes,
            status: "active",
        });

    } catch (error) {
        result.errors.push(error instanceof Error ? error.message : String(error));

        // Mark as error status
        await updateMonitoredPodcastStatus(env.TLDL_DATA, podcast.id, {
            lastChecked: new Date().toISOString(),
            status: "error",
            lastError: error instanceof Error ? error.message : String(error),
        });
    }

    return result;
}

// ============================================================================
// Check All Podcasts
// ============================================================================

/**
 * Check all monitored podcasts for new episodes (for cron)
 */
export async function checkAllPodcasts(env: Env): Promise<CheckAllResult> {
    const settings = await getMonitorSettings(env.TLDL_DATA);

    if (!settings.enabled) {
        return {
            checked: 0,
            totalNewEpisodes: 0,
            results: [],
            errors: ["Monitoring is disabled"],
        };
    }

    const podcastIds = await getMonitoredPodcastIds(env.TLDL_DATA);
    const result: CheckAllResult = {
        checked: 0,
        totalNewEpisodes: 0,
        results: [],
        errors: [],
    };

    for (const podcastId of podcastIds) {
        const podcast = await getMonitoredPodcast(env.TLDL_DATA, podcastId);
        if (!podcast || podcast.status === "paused") {
            continue;
        }

        try {
            const checkResult = await checkPodcastForNewEpisodes(
                env,
                podcast,
                settings.maxEpisodesPerCheck
            );
            result.results.push(checkResult);
            result.totalNewEpisodes += checkResult.newEpisodes;
            result.checked++;

            // Surface per-podcast episode errors (e.g. "Could not find episode ID")
            // so the scheduled handler can notify via Discord
            for (const err of checkResult.errors) {
                result.errors.push(`${podcast.name}: ${err}`);
            }

        } catch (error) {
            result.errors.push(`${podcastId}: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    console.log(JSON.stringify({
        event: "monitor_check_all_complete",
        checked: result.checked,
        totalNewEpisodes: result.totalNewEpisodes,
        errors: result.errors.length,
    }));

    return result;
}

/**
 * Force immediate check of all podcasts (for "Check Now" button)
 */
export async function forceCheckAllPodcasts(env: Env): Promise<CheckAllResult> {
    // Same as checkAllPodcasts but ignores the enabled setting
    const podcastIds = await getMonitoredPodcastIds(env.TLDL_DATA);
    const settings = await getMonitorSettings(env.TLDL_DATA);

    const result: CheckAllResult = {
        checked: 0,
        totalNewEpisodes: 0,
        results: [],
        errors: [],
    };

    for (const podcastId of podcastIds) {
        const podcast = await getMonitoredPodcast(env.TLDL_DATA, podcastId);
        if (!podcast || podcast.status === "paused") {
            continue;
        }

        try {
            const checkResult = await checkPodcastForNewEpisodes(
                env,
                podcast,
                settings.maxEpisodesPerCheck
            );
            result.results.push(checkResult);
            result.totalNewEpisodes += checkResult.newEpisodes;
            result.checked++;

            // Surface per-podcast episode errors
            for (const err of checkResult.errors) {
                result.errors.push(`${podcast.name}: ${err}`);
            }

        } catch (error) {
            result.errors.push(`${podcastId}: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    console.log(JSON.stringify({
        event: "monitor_force_check_complete",
        checked: result.checked,
        totalNewEpisodes: result.totalNewEpisodes,
        errors: result.errors.length,
    }));

    return result;
}

// ============================================================================
// Helper Functions
// ============================================================================

interface QueueEpisodeParams {
    podcastId: string;
    episodeId: string;
    episodeGuid: string;
    expectedTitle: string;
    expectedDate: string;
    templateId: string;
    appleUrl: string;
}

/**
 * Queue an episode for processing (creates job and sends to queue)
 */
async function queueEpisodeForProcessing(
    env: Env,
    params: QueueEpisodeParams
): Promise<void> {
    const jobId = generateUUID();
    const now = new Date().toISOString();

    const job: Job = {
        id: jobId,
        episodeId: params.episodeId,
        appleUrl: params.appleUrl,
        status: "queued",
        templateId: params.templateId,
        createdAt: now,
        updatedAt: now,
    };

    // Create job in both DO and KV
    await createJobDO(env, job);
    await createJob(env.TLDL_DATA, job);

    // Queue the job
    const message = createProcessEpisodeMessage({
        jobId,
        episodeId: params.episodeId,
        appleUrl: params.appleUrl,
        templateId: params.templateId,
        episodeGuid: params.episodeGuid,
        expectedTitle: params.expectedTitle,
        expectedDate: params.expectedDate,
        submittedBy: "monitor@tldl.app",  // System submission
    });

    await enqueueJob(env.TLDL_QUEUE, message);

    console.log(JSON.stringify({
        event: "monitor_episode_queued",
        jobId,
        episodeId: params.episodeId,
        title: params.expectedTitle,
    }));
}

/**
 * Find matching Podcast Index episode for an RSS episode
 */
function findMatchingPiEpisode(
    rssEpisode: RssEpisode,
    piEpisodes: Array<{ id: number; guid: string; title: string; datePublished: number }>
): { id: number; guid: string; title: string } | null {
    // Try exact GUID match first
    const guidMatch = piEpisodes.find(ep => ep.guid === rssEpisode.guid);
    if (guidMatch) return guidMatch;

    // Try title match (case insensitive)
    const normalizedRssTitle = rssEpisode.title.toLowerCase().trim();
    const titleMatch = piEpisodes.find(
        ep => ep.title.toLowerCase().trim() === normalizedRssTitle
    );
    if (titleMatch) return titleMatch;

    // Try fuzzy title match (first 50 chars)
    const shortRssTitle = normalizedRssTitle.slice(0, 50);
    const fuzzyMatch = piEpisodes.find(
        ep => ep.title.toLowerCase().trim().slice(0, 50) === shortRssTitle
    );
    if (fuzzyMatch) return fuzzyMatch;

    return null;
}

/**
 * Check if an episode already exists by title for a given podcast
 * This is needed because Apple episode IDs differ from Podcast Index IDs
 */
async function episodeExistsByTitle(
    env: Env,
    podcastId: string,
    episodeTitle: string
): Promise<boolean> {
    const index = await getEpisodeIndex(env.TLDL_DATA);
    const normalizedTitle = episodeTitle.toLowerCase().trim();

    // Check if any episode for this podcast has a matching title
    return index.some(ep =>
        ep.id.startsWith(`${podcastId}_`) &&
        ep.episodeTitle.toLowerCase().trim() === normalizedTitle
    );
}

