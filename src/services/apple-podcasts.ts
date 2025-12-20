/**
 * Apple Podcasts / iTunes API Service
 * Fetches podcast and episode metadata from the iTunes Lookup API
 */

import { AppError } from "../lib/errors";
import { ERROR_CODES } from "../lib/constants";
import type { ParsedAppleUrl } from "../lib/url-parser";
import { fetchAndParseFeed, findEpisodeInFeed } from "./rss";

/**
 * Result from iTunes Lookup API for a podcast
 */
export interface ItunesLookupResult {
    feedUrl: string;
    collectionName: string;
    artistName: string;
}

/**
 * Episode info from iTunes Lookup API
 */
export interface ItunesEpisodeInfo {
    trackId: number;
    trackName: string;
    releaseDate: string;
    episodeGuid?: string; // The podcast's internal GUID for this episode
}

/**
 * Episode metadata extracted from RSS feed
 */
export interface EpisodeMetadata {
    podcastName: string;
    episodeTitle: string;
    episodeDuration: number; // seconds
    episodeDate: string; // ISO date
    audioUrl: string;
    feedUrl: string;
    transcriptUrl?: string;
    transcriptType?: string;
}

/**
 * iTunes API response structure
 */
interface ItunesApiResponse {
    resultCount: number;
    results: Array<{
        wrapperType: string;
        kind?: string;
        feedUrl?: string;
        collectionName?: string;
        artistName?: string;
        trackId?: number;
        trackName?: string;
        releaseDate?: string;
        episodeGuid?: string; // The podcast's internal GUID
    }>;
}

/**
 * Validate episode duration is within limits
 *
 * @param durationSeconds - Duration in seconds
 * @param maxMinutes - Maximum allowed duration in minutes
 * @throws AppError with EPISODE_TOO_LONG if exceeded
 */
export function validateDuration(
    durationSeconds: number,
    maxMinutes: number
): void {
    const maxSeconds = maxMinutes * 60;
    if (durationSeconds > maxSeconds) {
        const durationMinutes = Math.round(durationSeconds / 60);
        throw new AppError(
            ERROR_CODES.EPISODE_TOO_LONG,
            `Episode is ${durationMinutes} minutes long, which exceeds the ${maxMinutes} minute limit.`
        );
    }
}

/**
 * Look up a podcast by its Apple ID using the iTunes API
 *
 * @param podcastId - The Apple podcast ID (e.g., "1200361736")
 * @returns ItunesLookupResult if found, null if not found
 * @throws AppError with ITUNES_API_ERROR on API failures
 */
export async function lookupPodcast(
    podcastId: string
): Promise<ItunesLookupResult | null> {
    const url = `https://itunes.apple.com/lookup?id=${encodeURIComponent(podcastId)}&entity=podcast`;

    try {
        const response = await fetch(url, {
            headers: {
                Accept: "application/json",
                "User-Agent": "TLDL/1.0 (Podcast Summary Service)",
            },
        });

        if (!response.ok) {
            // Handle rate limiting
            if (response.status === 429) {
                throw new AppError(
                    ERROR_CODES.RATE_LIMITED,
                    "iTunes API rate limit exceeded. Please try again in a few minutes."
                );
            }

            throw new AppError(
                ERROR_CODES.ITUNES_API_ERROR,
                `iTunes API returned status ${response.status}`
            );
        }

        const data = (await response.json()) as ItunesApiResponse;

        if (data.resultCount === 0 || !data.results || data.results.length === 0) {
            return null;
        }

        // Find the podcast result (not an episode)
        const podcast = data.results.find(
            (r) => r.wrapperType === "collection" || r.kind === "podcast"
        );

        if (!podcast || !podcast.feedUrl) {
            return null;
        }

        return {
            feedUrl: podcast.feedUrl,
            collectionName: podcast.collectionName || "Unknown Podcast",
            artistName: podcast.artistName || "Unknown Artist",
        };
    } catch (error) {
        // Re-throw AppErrors
        if (error instanceof AppError) {
            throw error;
        }

        // Wrap other errors
        throw new AppError(
            ERROR_CODES.ITUNES_API_ERROR,
            "Failed to fetch podcast information from iTunes",
            error instanceof Error ? error : undefined
        );
    }
}

/**
 * Look up episode info from iTunes API to get title and date for RSS matching
 *
 * @param podcastId - The Apple podcast ID
 * @param episodeId - The Apple episode ID (trackId)
 * @returns Episode info if found, null otherwise
 */
export async function lookupEpisodeInfo(
    podcastId: string,
    episodeId: string
): Promise<ItunesEpisodeInfo | null> {
    // Fetch recent episodes from iTunes (limit to 200 to cover most cases)
    const url = `https://itunes.apple.com/lookup?id=${encodeURIComponent(podcastId)}&entity=podcastEpisode&limit=200`;

    try {
        const response = await fetch(url, {
            headers: {
                Accept: "application/json",
                "User-Agent": "TLDL/1.0 (Podcast Summary Service)",
            },
        });

        if (!response.ok) {
            console.log(JSON.stringify({ event: "itunes_lookup_failed", status: response.status }));
            return null; // Non-critical - we'll fall back to other matching
        }

        const data = (await response.json()) as ItunesApiResponse;

        // Find the episode by trackId (the episode ID from the URL)
        const episodeIdNum = parseInt(episodeId, 10);
        
        console.log(JSON.stringify({
            event: "itunes_episode_search",
            episodeId,
            episodeIdNum,
            resultCount: data.resultCount,
            sampleTrackIds: data.results.slice(0, 5).map(r => ({ trackId: r.trackId, wrapperType: r.wrapperType })),
        }));
        
        const episode = data.results.find(
            (r) => r.trackId === episodeIdNum && r.wrapperType !== "collection"
        );

        if (!episode || !episode.trackName) {
            console.log(JSON.stringify({ event: "itunes_episode_not_found", episodeFound: !!episode, hasTrackName: !!episode?.trackName }));
            return null;
        }

        return {
            trackId: episode.trackId!,
            trackName: episode.trackName,
            releaseDate: episode.releaseDate || "",
            episodeGuid: episode.episodeGuid,
        };
    } catch (err) {
        console.log(JSON.stringify({ event: "itunes_lookup_error", error: err instanceof Error ? err.message : String(err) }));
        return null; // Non-critical fallback
    }
}

/**
 * Get episode metadata for a parsed Apple Podcasts URL
 *
 * @param parsedUrl - The parsed Apple Podcasts URL
 * @param maxMinutes - Optional max episode duration (for validation)
 * @returns Full episode metadata
 * @throws AppError with EPISODE_NOT_FOUND if podcast or episode doesn't exist
 * @throws AppError with EPISODE_TOO_LONG if duration exceeds limit
 */
export async function getEpisodeMetadata(
    parsedUrl: ParsedAppleUrl,
    maxMinutes?: number
): Promise<EpisodeMetadata> {
    // Step 1: Look up podcast via iTunes API
    const podcast = await lookupPodcast(parsedUrl.podcastId);

    if (!podcast) {
        throw new AppError(
            ERROR_CODES.EPISODE_NOT_FOUND,
            "Podcast not found. Please check the URL and try again."
        );
    }

    // Step 2: Look up episode info for fallback matching (parallel with RSS fetch)
    const [feed, episodeInfo] = await Promise.all([
        fetchAndParseFeed(podcast.feedUrl),
        lookupEpisodeInfo(parsedUrl.podcastId, parsedUrl.episodeId),
    ]);

    // Debug logging
    console.log(JSON.stringify({
        event: "episode_lookup_debug",
        podcastId: parsedUrl.podcastId,
        episodeId: parsedUrl.episodeId,
        feedUrl: podcast.feedUrl,
        feedEpisodeCount: feed.episodes.length,
        firstFiveGuids: feed.episodes.slice(0, 5).map(e => e.guid),
        episodeInfoFound: !!episodeInfo,
        episodeGuid: episodeInfo?.episodeGuid,
        expectedTitle: episodeInfo?.trackName,
    }));

    // Step 3: Find episode in feed with fallback options
    const episode = findEpisodeInFeed(feed, parsedUrl.episodeId, {
        expectedTitle: episodeInfo?.trackName,
        expectedDate: episodeInfo?.releaseDate,
        episodeGuid: episodeInfo?.episodeGuid,
    });

    if (!episode) {
        throw new AppError(
            ERROR_CODES.EPISODE_NOT_FOUND,
            "Episode not found in podcast feed. It may have been removed or the URL is incorrect."
        );
    }

    // Step 4: Validate duration if limit specified
    if (maxMinutes !== undefined && episode.duration > 0) {
        validateDuration(episode.duration, maxMinutes);
    }

    // Return full metadata
    return {
        podcastName: feed.title,
        episodeTitle: episode.title,
        episodeDuration: episode.duration,
        episodeDate: episode.pubDate,
        audioUrl: episode.audioUrl,
        feedUrl: podcast.feedUrl,
        ...(episode.transcriptUrl && { transcriptUrl: episode.transcriptUrl }),
        ...(episode.transcriptType && { transcriptType: episode.transcriptType }),
    };
}

