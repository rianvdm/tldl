/**
 * Apple Podcasts / iTunes API Service
 * Fetches podcast and episode metadata from the iTunes Lookup API
 */

import { AppError } from "../lib/errors";
import { ERROR_CODES } from "../lib/constants";
import { getCorrectedFeedUrl } from "../lib/feed-corrections";
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
 * Extract episode title by fetching the Apple Podcasts page HTML
 * The page <title> tag contains the actual episode title in format:
 * "Episode Title - Podcast Name - Apple Podcasts"
 * 
 * This is more reliable than URL slugs, which sometimes contain 
 * the podcast name instead of the episode title.
 */
async function getEpisodeTitleFromApplePage(
    appleUrl: string
): Promise<string | null> {
    try {
        console.log(JSON.stringify({
            event: "apple_page_fetch_start",
            appleUrl,
        }));

        const response = await fetch(appleUrl, {
            headers: {
                "User-Agent": "TLDL/1.0 (Podcast Summary Service)",
                "Accept": "text/html",
            },
        });

        if (!response.ok) {
            console.log(JSON.stringify({
                event: "apple_page_fetch_failed",
                status: response.status,
            }));
            return null;
        }

        const html = await response.text();

        // Extract from <title> tag
        // Format: "Episode Title - Podcast Name - Apple Podcasts"
        const titleMatch = html.match(/<title>([^<]+)<\/title>/i);
        if (titleMatch) {
            const fullTitle = titleMatch[1];
            // Split by " - " and take first part (episode title)
            // Handle truncated titles with "…" 
            const parts = fullTitle.split(' - ');
            if (parts.length >= 2) {
                const episodeTitle = parts[0].trim();
                console.log(JSON.stringify({
                    event: "apple_page_title_extracted",
                    fullTitle,
                    episodeTitle,
                }));
                return episodeTitle;
            }
        }

        // Fallback: og:title meta tag (different regex patterns for attribute order)
        const ogMatch = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i) ||
            html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/i);
        if (ogMatch) {
            console.log(JSON.stringify({
                event: "apple_page_og_title_extracted",
                title: ogMatch[1],
            }));
            return ogMatch[1].trim();
        }

        console.log(JSON.stringify({
            event: "apple_page_no_title_found",
        }));
        return null;
    } catch (error) {
        console.log(JSON.stringify({
            event: "apple_page_fetch_error",
            error: error instanceof Error ? error.message : String(error),
        }));
        return null;
    }
}

/**
 * Clean a podcast link URL that might be an RSS feed URL
 * Strips RSS-specific paths/filenames while preserving the directory structure
 * e.g., https://www.thisamericanlife.org/podcast/rss.xml -> https://www.thisamericanlife.org/podcast
 */
function cleanPodcastWebsiteUrl(url: string): string {
    try {
        const parsed = new URL(url);
        let pathname = parsed.pathname;
        const lowerPath = pathname.toLowerCase();

        // Check if it looks like an RSS feed path
        const isRssFeed =
            lowerPath.endsWith('.xml') ||
            lowerPath.endsWith('.rss') ||
            lowerPath.endsWith('/feed') ||
            lowerPath.endsWith('/feed/') ||
            lowerPath.endsWith('/rss') ||
            lowerPath.endsWith('/rss/') ||
            lowerPath.includes('/feed/') ||
            lowerPath.includes('/rss/');

        if (!isRssFeed) {
            // Not an RSS URL, return as-is
            return url;
        }

        // Remove RSS/XML filenames (keep the directory)
        if (lowerPath.endsWith('.xml') || lowerPath.endsWith('.rss')) {
            pathname = pathname.substring(0, pathname.lastIndexOf('/'));
        }

        // Remove /feed, /feed/, /rss, or /rss/ from the end
        pathname = pathname.replace(/\/(feed|rss)\/?$/i, '');

        // If /feed/ or /rss/ appears in the middle, remove it and everything after
        const feedMiddleIndex = pathname.toLowerCase().indexOf('/feed/');
        const rssMiddleIndex = pathname.toLowerCase().indexOf('/rss/');

        if (feedMiddleIndex !== -1) {
            pathname = pathname.substring(0, feedMiddleIndex);
        } else if (rssMiddleIndex !== -1) {
            pathname = pathname.substring(0, rssMiddleIndex);
        }

        // If pathname is empty or just a slash, return the origin
        if (!pathname || pathname === '/') {
            return parsed.origin;
        }

        return `${parsed.origin}${pathname}`;
    } catch {
        // If URL parsing fails, return as-is
        return url;
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
        const titleFromRedirect = await getEpisodeTitleFromApplePage(appleUrl);

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
    podcastAuthor?: string;      // Podcast author/host name
    podcastWebsiteUrl?: string;  // Podcast website URL
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
    // Original Apple URL for redirect-based title extraction
    appleUrl?: string;
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

        // If iTunes failed (403 from Cloudflare Workers), try to get title from Apple page
        if (!episodeInfo && options.appleUrl) {
            console.log(JSON.stringify({
                event: "itunes_failed_trying_apple_page",
                appleUrl: options.appleUrl,
            }));
            const titleFromPage = await getEpisodeTitleFromApplePage(options.appleUrl);
            if (titleFromPage) {
                episodeInfo = {
                    trackId: parseInt(parsedUrl.episodeId, 10),
                    trackName: titleFromPage,
                    releaseDate: "",
                };
            }
        }
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

        // Step 3: Get title for matching - use pre-fetched or extract from Apple redirect
        let titleForMatching = options.expectedTitle;
        console.log(JSON.stringify({
            event: "podcast_index_title_check",
            hasExpectedTitle: !!options.expectedTitle,
            hasAppleUrl: !!options.appleUrl,
            appleUrl: options.appleUrl,
        }));
        if (!titleForMatching && options.appleUrl) {
            titleForMatching = await getEpisodeTitleFromApplePage(options.appleUrl) || undefined;
            if (titleForMatching) {
                console.log(JSON.stringify({
                    event: "podcast_index_title_from_redirect",
                    appleUrl: options.appleUrl,
                    extractedTitle: titleForMatching,
                }));
            }
        }

        // Step 4: Find the specific episode in Podcast Index data
        const episode = findEpisodeByAppleId(
            episodes,
            parsedUrl.episodeId,
            titleForMatching,
            options.expectedDate
        );

        if (episode) {
            // Step 5: Validate duration if limit specified
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
                ...(podcast.author && { podcastAuthor: podcast.author }),
                ...(podcast.link && { podcastWebsiteUrl: cleanPodcastWebsiteUrl(podcast.link) }),
            };
        }

        // Step 5: Podcast Index doesn't have the episode - try fetching RSS feed directly
        // This handles cases where Podcast Index is behind (stale data)
        console.log(JSON.stringify({
            event: "podcast_index_fallback_to_rss",
            podcastId: parsedUrl.podcastId,
            episodeId: parsedUrl.episodeId,
            feedUrl: podcast.url,
            reason: "episode_not_in_podcast_index",
        }));

        try {
            const feed = await fetchAndParseFeed(podcast.url);
            const rssEpisode = findEpisodeInFeed(feed, parsedUrl.episodeId, {
                expectedTitle: titleForMatching,
                expectedDate: options.expectedDate,
            });

            if (rssEpisode) {
                // Validate duration if limit specified
                if (options.maxMinutes !== undefined && rssEpisode.duration > 0) {
                    validateDuration(rssEpisode.duration, options.maxMinutes);
                }

                console.log(JSON.stringify({
                    event: "rss_fallback_metadata_success",
                    podcastId: parsedUrl.podcastId,
                    episodeId: parsedUrl.episodeId,
                    episodeTitle: rssEpisode.title,
                    hasTranscript: !!rssEpisode.transcriptUrl,
                }));

                return {
                    podcastName: feed.title,
                    episodeTitle: rssEpisode.title,
                    episodeDuration: rssEpisode.duration,
                    episodeDate: rssEpisode.pubDate,
                    audioUrl: rssEpisode.audioUrl,
                    feedUrl: podcast.url,
                    ...(rssEpisode.transcriptUrl && { transcriptUrl: rssEpisode.transcriptUrl }),
                    ...(rssEpisode.transcriptType && { transcriptType: rssEpisode.transcriptType }),
                    ...(podcast.author && { podcastAuthor: podcast.author }),
                    ...(podcast.link && { podcastWebsiteUrl: cleanPodcastWebsiteUrl(podcast.link) }),
                };
            }

            console.log(JSON.stringify({
                event: "rss_fallback_no_match",
                podcastId: parsedUrl.podcastId,
                episodeId: parsedUrl.episodeId,
            }));
        } catch (rssError) {
            console.log(JSON.stringify({
                event: "rss_fallback_error",
                podcastId: parsedUrl.podcastId,
                episodeId: parsedUrl.episodeId,
                feedUrl: podcast.url,
                error: rssError instanceof Error ? rssError.message : String(rssError),
            }));

            // Last resort: check if we have a known feed correction for this podcast
            // This handles cases where Podcast Index has stale/dead feed URLs
            const correctedFeedUrl = getCorrectedFeedUrl(parsedUrl.podcastId);
            if (correctedFeedUrl && correctedFeedUrl !== podcast.url) {
                console.log(JSON.stringify({
                    event: "known_feed_correction_start",
                    podcastId: parsedUrl.podcastId,
                    episodeId: parsedUrl.episodeId,
                    correctedFeedUrl,
                    staleFeedUrl: podcast.url,
                }));

                try {
                    const correctedFeed = await fetchAndParseFeed(correctedFeedUrl);
                    const correctedEpisode = findEpisodeInFeed(correctedFeed, parsedUrl.episodeId, {
                        expectedTitle: titleForMatching,
                        expectedDate: options.expectedDate,
                    });

                    if (correctedEpisode) {
                        // Validate duration if limit specified
                        if (options.maxMinutes !== undefined && correctedEpisode.duration > 0) {
                            validateDuration(correctedEpisode.duration, options.maxMinutes);
                        }

                        console.log(JSON.stringify({
                            event: "known_feed_correction_success",
                            podcastId: parsedUrl.podcastId,
                            episodeId: parsedUrl.episodeId,
                            episodeTitle: correctedEpisode.title,
                            hasTranscript: !!correctedEpisode.transcriptUrl,
                        }));

                        return {
                            podcastName: correctedFeed.title,
                            episodeTitle: correctedEpisode.title,
                            episodeDuration: correctedEpisode.duration,
                            episodeDate: correctedEpisode.pubDate,
                            audioUrl: correctedEpisode.audioUrl,
                            feedUrl: correctedFeedUrl,
                            ...(correctedEpisode.transcriptUrl && { transcriptUrl: correctedEpisode.transcriptUrl }),
                            ...(correctedEpisode.transcriptType && { transcriptType: correctedEpisode.transcriptType }),
                            ...(podcast.author && { podcastAuthor: podcast.author }),
                            ...(podcast.link && { podcastWebsiteUrl: cleanPodcastWebsiteUrl(podcast.link) }),
                        };
                    }

                    console.log(JSON.stringify({
                        event: "known_feed_correction_no_match",
                        podcastId: parsedUrl.podcastId,
                        episodeId: parsedUrl.episodeId,
                    }));
                } catch (correctionError) {
                    console.log(JSON.stringify({
                        event: "known_feed_correction_error",
                        podcastId: parsedUrl.podcastId,
                        episodeId: parsedUrl.episodeId,
                        error: correctionError instanceof Error ? correctionError.message : String(correctionError),
                    }));
                }
            }
        }

        return null;
    } catch (error) {
        // Log the error and fall back to iTunes for ALL errors including rate limits
        // This ensures the job continues even when Podcast Index is unavailable
        console.error(JSON.stringify({
            event: "podcast_index_metadata_error",
            podcastId: parsedUrl.podcastId,
            episodeId: parsedUrl.episodeId,
            error: error instanceof Error ? error.message : String(error),
            fallingBackToItunes: true,
        }));
        return null;
    }
}
