/**
 * Apple Podcasts / iTunes API Service
 * Fetches podcast and episode metadata from the iTunes Lookup API
 */

import { AppError } from "../lib/errors";
import { ERROR_CODES } from "../lib/constants";
import type { ParsedAppleUrl } from "../lib/url-parser";

/**
 * Result from iTunes Lookup API for a podcast
 */
export interface ItunesLookupResult {
    feedUrl: string;
    collectionName: string;
    artistName: string;
}

/**
 * Episode metadata extracted from RSS feed
 * (RSS parsing will be implemented in Prompt 4)
 */
export interface EpisodeMetadata {
    podcastName: string;
    episodeTitle: string;
    episodeDuration: number; // seconds
    episodeDate: string; // ISO date
    audioUrl: string;
    feedUrl: string;
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
    }>;
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
 * Get episode metadata for a parsed Apple Podcasts URL
 *
 * Note: This is a skeleton implementation. Full RSS parsing
 * will be added in Prompt 4. Currently returns feedUrl only.
 *
 * @param parsedUrl - The parsed Apple Podcasts URL
 * @returns Partial episode metadata with feedUrl
 * @throws AppError with EPISODE_NOT_FOUND if podcast doesn't exist
 */
export async function getEpisodeMetadata(
    parsedUrl: ParsedAppleUrl
): Promise<{ feedUrl: string; podcastName: string }> {
    const podcast = await lookupPodcast(parsedUrl.podcastId);

    if (!podcast) {
        throw new AppError(
            ERROR_CODES.EPISODE_NOT_FOUND,
            "Podcast not found. Please check the URL and try again."
        );
    }

    // RSS parsing will be added in Prompt 4
    // For now, return the basic info we have from iTunes
    return {
        feedUrl: podcast.feedUrl,
        podcastName: podcast.collectionName,
    };
}
