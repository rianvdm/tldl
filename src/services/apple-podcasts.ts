/**
 * Apple Podcasts / iTunes API Service
 * Fetches podcast and episode metadata from the iTunes Lookup API
 */

import { AppError } from "../lib/errors";
import { ERROR_CODES } from "../lib/constants";
import type { ParsedAppleUrl } from "../lib/url-parser";
import type { Env } from "../types";
import { fetchAndParseFeed, findEpisodeInFeed } from "./rss";
import {
    lookupPodcastByItunesId,
    getEpisodesByItunesId,
    findEpisodeByAppleId,
} from "./podcast-index";

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
 * Extract episode title from Apple Podcasts redirect URL
 * Apple redirects to a canonical URL containing the episode title slug
 */
async function getEpisodeTitleFromAppleRedirect(
    appleUrl: string
): Promise<string | null> {
    try {
        // Fetch with redirect: "manual" to get the Location header
        const response = await fetch(appleUrl, {
            method: "HEAD",
            redirect: "manual",
            headers: {
                "User-Agent": "TLDL/1.0 (Podcast Summary Service)",
            },
        });
        
        const location = response.headers.get("location");
        if (!location) {
            return null;
        }
        
        // Parse the redirect URL to extract episode title
        // Format: https://podcasts.apple.com/us/podcast/episode-title-slug/id123?i=456
        const match = location.match(/\/podcast\/([^/]+)\/id\d+\?i=/);
        if (!match) {
            return null;
        }
        
        // Convert slug to title: "the-100-person-ai-lab" -> "the 100 person ai lab"
        const slug = match[1];
        const title = slug.replace(/-/g, " ");
        
        console.log(JSON.stringify({
            event: "apple_redirect_title_extracted",
            slug,
            title,
        }));
        
        return title;
    } catch (error) {
        console.log(JSON.stringify({
            event: "apple_redirect_fetch_error",
            error: error instanceof Error ? error.message : String(error),
        }));
        return null;
    }
}

/**
 * Pre-fetch episode info for queue message
 * Tries iTunes first, then Apple redirect + Podcast Index matching
 */
export async function prefetchEpisodeInfo(
    podcastId: string,
    episodeId: string,
    env: Env,
    appleUrl?: string
): Promise<ItunesEpisodeInfo | null> {
    // Try iTunes first - it sometimes works in HTTP context
    const itunesResult = await lookupEpisodeInfo(podcastId, episodeId);
    if (itunesResult) {
        console.log(JSON.stringify({
            event: "prefetch_itunes_success",
            podcastId,
            episodeId,
            title: itunesResult.trackName,
        }));
        return itunesResult;
    }
    
    console.log(JSON.stringify({
        event: "prefetch_itunes_failed",
        podcastId,
        episodeId,
    }));
    
    // iTunes failed - try to get title from Apple redirect URL
    if (appleUrl && env.PODCAST_INDEX_KEY && env.PODCAST_INDEX_SECRET) {
        const titleFromRedirect = await getEpisodeTitleFromAppleRedirect(appleUrl);
        
        if (titleFromRedirect) {
            // Now match this title in Podcast Index using the same matching logic
            try {
                const episodes = await getEpisodesByItunesId(
                    podcastId,
                    env.PODCAST_INDEX_KEY,
                    env.PODCAST_INDEX_SECRET,
                    500
                );
                
                if (episodes.length > 0) {
                    // Use findEpisodeByAppleId with the title from redirect
                    // This uses the improved normalization (hyphens -> spaces, etc.)
                    const matched = findEpisodeByAppleId(
                        episodes,
                        episodeId,
                        titleFromRedirect,
                        undefined // no date available from redirect
                    );
                    
                    if (matched) {
                        console.log(JSON.stringify({
                            event: "prefetch_redirect_podcast_index_match",
                            podcastId,
                            episodeId,
                            searchTitle: titleFromRedirect,
                            matchedTitle: matched.title,
                        }));
                        return {
                            trackId: parseInt(episodeId, 10),
                            trackName: matched.title,
                            releaseDate: new Date(matched.datePublished * 1000).toISOString(),
                            episodeGuid: matched.guid,
                        };
                    }
                    
                    console.log(JSON.stringify({
                        event: "prefetch_redirect_no_match",
                        podcastId,
                        episodeId,
                        searchTitle: titleFromRedirect,
                        episodeCount: episodes.length,
                        sampleTitles: episodes.slice(0, 5).map(e => e.title),
                    }));
                }
            } catch (error) {
                console.log(JSON.stringify({
                    event: "prefetch_podcast_index_error",
                    podcastId,
                    episodeId,
                    error: error instanceof Error ? error.message : String(error),
                }));
            }
        }
    }
    
    return null;
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
        console.log(JSON.stringify({ 
            event: "itunes_lookup_start", 
            podcastId, 
            episodeId,
            url 
        }));

        const response = await fetch(url, {
            headers: {
                Accept: "application/json",
                "User-Agent": "TLDL/1.0 (Podcast Summary Service)",
            },
        });

        if (!response.ok) {
            console.log(JSON.stringify({ 
                event: "itunes_lookup_failed", 
                status: response.status,
                statusText: response.statusText,
                headers: Object.fromEntries(response.headers.entries())
            }));
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
            totalResults: data.results.length,
            allTrackIds: data.results.map(r => r.trackId),
            sampleResults: data.results.slice(0, 5).map(r => ({ 
                trackId: r.trackId, 
                wrapperType: r.wrapperType,
                trackName: r.trackName,
                episodeGuid: r.episodeGuid 
            })),
        }));
        
        const episode = data.results.find(
            (r) => r.trackId === episodeIdNum && r.wrapperType !== "collection"
        );

        if (!episode || !episode.trackName) {
            console.log(JSON.stringify({ 
                event: "itunes_episode_not_found", 
                episodeFound: !!episode, 
                hasTrackName: !!episode?.trackName,
                episodeDetails: episode ? {
                    trackId: episode.trackId,
                    wrapperType: episode.wrapperType,
                    trackName: episode.trackName
                } : null
            }));
            return null;
        }

        console.log(JSON.stringify({
            event: "itunes_episode_found",
            trackId: episode.trackId,
            trackName: episode.trackName,
            episodeGuid: episode.episodeGuid,
            releaseDate: episode.releaseDate
        }));

        return {
            trackId: episode.trackId!,
            trackName: episode.trackName,
            releaseDate: episode.releaseDate || "",
            episodeGuid: episode.episodeGuid,
        };
    } catch (err) {
        console.log(JSON.stringify({ 
            event: "itunes_lookup_error", 
            error: err instanceof Error ? err.message : String(err),
            stack: err instanceof Error ? err.stack : undefined
        }));
        return null; // Non-critical fallback
    }
}

/**
 * Options for episode metadata fetching
 */
export interface GetEpisodeMetadataOptions {
    maxMinutes?: number;
    // Pre-fetched iTunes metadata (to avoid API calls that might fail)
    episodeGuid?: string;
    expectedTitle?: string;
    expectedDate?: string;
    // Environment for Podcast Index API access
    env?: Env;
}

/**
 * Get episode metadata for a parsed Apple Podcasts URL
 *
 * @param parsedUrl - The parsed Apple Podcasts URL
 * @param options - Optional max duration and pre-fetched metadata
 * @returns Full episode metadata
 * @throws AppError with EPISODE_NOT_FOUND if podcast or episode doesn't exist
 * @throws AppError with EPISODE_TOO_LONG if duration exceeds limit
 */
export async function getEpisodeMetadata(
    parsedUrl: ParsedAppleUrl,
    optionsOrMaxMinutes?: GetEpisodeMetadataOptions | number
): Promise<EpisodeMetadata> {
    // Handle backwards compatibility: support both number and options object
    const options: GetEpisodeMetadataOptions = typeof optionsOrMaxMinutes === 'number' 
        ? { maxMinutes: optionsOrMaxMinutes }
        : (optionsOrMaxMinutes || {});
    
    // Try Podcast Index first (primary source - no IP blocking issues)
    if (options.env?.PODCAST_INDEX_KEY && options.env?.PODCAST_INDEX_SECRET) {
        const podcastIndexResult = await getEpisodeFromPodcastIndex(
            parsedUrl,
            options.env.PODCAST_INDEX_KEY,
            options.env.PODCAST_INDEX_SECRET,
            options
        );
        if (podcastIndexResult) {
            return podcastIndexResult;
        }
        console.log(JSON.stringify({
            event: "podcast_index_fallback_to_itunes",
            podcastId: parsedUrl.podcastId,
            episodeId: parsedUrl.episodeId,
        }));
    }
    
    // Fall back to iTunes + RSS (existing implementation)
    // Step 1: Look up podcast via iTunes API
    const podcast = await lookupPodcast(parsedUrl.podcastId);

    if (!podcast) {
        throw new AppError(
            ERROR_CODES.EPISODE_NOT_FOUND,
            "Podcast not found. Please check the URL and try again."
        );
    }

    // Step 2: Get episode info - use pre-fetched if available, otherwise lookup
    let episodeInfo: ItunesEpisodeInfo | null = null;
    
    if (options.episodeGuid || options.expectedTitle || options.expectedDate) {
        // Use pre-fetched metadata (avoids iTunes API 403 errors in queue context)
        console.log(JSON.stringify({
            event: "using_prefetched_metadata",
            hasEpisodeGuid: !!options.episodeGuid,
            hasExpectedTitle: !!options.expectedTitle,
            hasExpectedDate: !!options.expectedDate
        }));
        
        if (options.expectedTitle) {
            episodeInfo = {
                trackId: parseInt(parsedUrl.episodeId, 10),
                trackName: options.expectedTitle,
                releaseDate: options.expectedDate || "",
                episodeGuid: options.episodeGuid,
            };
        }
    } else {
        // Fetch fresh from iTunes (HTTP context only)
        episodeInfo = await lookupEpisodeInfo(parsedUrl.podcastId, parsedUrl.episodeId);
    }

    // Fetch RSS feed
    const feed = await fetchAndParseFeed(podcast.feedUrl);

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
        usedPrefetchedMetadata: !!(options.episodeGuid || options.expectedTitle)
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
    if (options.maxMinutes !== undefined && episode.duration > 0) {
        validateDuration(episode.duration, options.maxMinutes);
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

// ============================================================================
// Podcast Index Integration
// ============================================================================

/**
 * Get episode metadata from Podcast Index API
 * Returns null if not found (caller should fall back to iTunes)
 */
async function getEpisodeFromPodcastIndex(
    parsedUrl: ParsedAppleUrl,
    apiKey: string,
    apiSecret: string,
    options: GetEpisodeMetadataOptions
): Promise<EpisodeMetadata | null> {
    try {
        // Step 1: Look up podcast by iTunes ID
        const podcast = await lookupPodcastByItunesId(
            parsedUrl.podcastId,
            apiKey,
            apiSecret
        );
        
        if (!podcast) {
            return null;
        }
        
        // Step 2: Get episodes from Podcast Index
        const episodes = await getEpisodesByItunesId(
            parsedUrl.podcastId,
            apiKey,
            apiSecret,
            1000
        );
        
        if (episodes.length === 0) {
            return null;
        }
        
        // Step 3: Find the specific episode
        const episode = findEpisodeByAppleId(
            episodes,
            parsedUrl.episodeId,
            options.expectedTitle,
            options.expectedDate
        );
        
        if (!episode) {
            return null;
        }
        
        // Step 4: Validate duration if limit specified
        if (options.maxMinutes !== undefined && episode.duration > 0) {
            validateDuration(episode.duration, options.maxMinutes);
        }
        
        // Convert Unix timestamp to ISO date
        const episodeDate = new Date(episode.datePublished * 1000).toISOString();
        
        console.log(JSON.stringify({
            event: "podcast_index_metadata_success",
            podcastId: parsedUrl.podcastId,
            episodeId: parsedUrl.episodeId,
            episodeTitle: episode.title,
            hasTranscript: !!episode.transcriptUrl,
        }));
        
        return {
            podcastName: podcast.title,
            episodeTitle: episode.title,
            episodeDuration: episode.duration,
            episodeDate,
            audioUrl: episode.enclosureUrl,
            feedUrl: podcast.url,
            ...(episode.transcriptUrl && { transcriptUrl: episode.transcriptUrl }),
        };
    } catch (error) {
        console.error(JSON.stringify({
            event: "podcast_index_metadata_error",
            podcastId: parsedUrl.podcastId,
            episodeId: parsedUrl.episodeId,
            error: error instanceof Error ? error.message : String(error),
        }));
        return null;
    }
}
