/**
 * Podcast Index API Service
 * Primary source for podcast and episode metadata
 * https://podcastindex-org.github.io/docs-api/
 */

import { createHash } from "node:crypto";
import { AppError } from "../lib/errors";
import { ERROR_CODES, USER_AGENT } from "../lib/constants";
import { stripTruncationSuffix } from "../lib/title-utils";

// ============================================================================
// Types
// ============================================================================

export interface PodcastIndexPodcast {
    id: number;
    url: string;           // RSS feed URL
    title: string;
    itunesId: number;
    author?: string;       // Podcast author/host name
    link?: string;         // Podcast website URL
}

export interface PodcastIndexEpisode {
    id: number;
    title: string;
    datePublished: number;  // Unix timestamp
    duration: number;       // Seconds
    enclosureUrl: string;   // Audio URL
    guid: string;
    transcriptUrl?: string;
}

interface PodcastIndexPodcastResponse {
    status: string;
    feed?: {
        id: number;
        url: string;
        title: string;
        itunesId: number;
        author?: string;
        link?: string;
    };
}

interface PodcastIndexEpisodesResponse {
    status: string;
    items?: Array<{
        id: number;
        title: string;
        datePublished: number;
        duration: number;
        enclosureUrl: string;
        guid: string;
        transcriptUrl?: string;
    }>;
}

// ============================================================================
// Authentication
// ============================================================================

/**
 * Generate auth headers for Podcast Index API
 */
function getAuthHeaders(apiKey: string, apiSecret: string): HeadersInit {
    const apiHeaderTime = Math.floor(Date.now() / 1000);
    const data = apiKey + apiSecret + apiHeaderTime;
    // Podcast Index requires plain SHA-1 hash, not HMAC
    const hash = createHash('sha1').update(data).digest('hex');

    return {
        "X-Auth-Date": apiHeaderTime.toString(),
        "X-Auth-Key": apiKey,
        "Authorization": hash,
        "User-Agent": USER_AGENT
    };
}

// ============================================================================
// API Functions
// ============================================================================

/**
 * Look up podcast by iTunes ID
 */
export async function lookupPodcastByItunesId(
    itunesId: string,
    apiKey: string,
    apiSecret: string
): Promise<PodcastIndexPodcast | null> {
    const url = `https://api.podcastindex.org/api/1.0/podcasts/byitunesid?id=${itunesId}`;

    try {
        console.log(JSON.stringify({
            event: "podcast_index_lookup_start",
            itunesId,
            apiKeyPrefix: apiKey.substring(0, 6),
        }));

        const response = await fetch(url, {
            headers: getAuthHeaders(apiKey, apiSecret)
        });

        if (!response.ok) {
            const retryAfter = response.headers.get("Retry-After");
            console.log(JSON.stringify({
                event: "podcast_index_lookup_failed",
                status: response.status,
                statusText: response.statusText,
                retryAfter,
                headers: Object.fromEntries(response.headers.entries()),
            }));
            // Throw on rate limit so job retries instead of falling back to iTunes
            if (response.status === 429) {
                throw new AppError(
                    ERROR_CODES.RATE_LIMITED,
                    `Podcast Index API rate limit exceeded. Retry after: ${retryAfter || 'unknown'}`
                );
            }
            return null;
        }

        const data = await response.json() as PodcastIndexPodcastResponse;

        if (!data.feed) {
            console.log(JSON.stringify({
                event: "podcast_index_no_feed",
                itunesId,
            }));
            return null;
        }

        console.log(JSON.stringify({
            event: "podcast_index_lookup_success",
            itunesId,
            feedId: data.feed.id,
            title: data.feed.title,
        }));

        return {
            id: data.feed.id,
            url: data.feed.url,
            title: data.feed.title,
            itunesId: data.feed.itunesId,
            author: data.feed.author,
            link: data.feed.link,
        };
    } catch (error) {
        // Re-throw AppErrors (especially rate limit) so they cause job retries
        if (error instanceof AppError) {
            console.error(JSON.stringify({
                event: "podcast_index_lookup_error",
                itunesId,
                error: error.message,
            }));
            throw error;
        }
        console.error(JSON.stringify({
            event: "podcast_index_lookup_error",
            itunesId,
            error: error instanceof Error ? error.message : String(error),
        }));
        return null;
    }
}

/**
 * Get all episodes for a podcast by iTunes ID
 */
export async function getEpisodesByItunesId(
    itunesId: string,
    apiKey: string,
    apiSecret: string,
    max: number = 1000,
    since?: number
): Promise<PodcastIndexEpisode[]> {
    let url = `https://api.podcastindex.org/api/1.0/episodes/byitunesid?id=${itunesId}&max=${max}`;
    if (since) {
        url += `&since=${since}`;
    }

    try {
        console.log(JSON.stringify({
            event: "podcast_index_episodes_start",
            itunesId,
            max,
            apiKeyPrefix: apiKey.substring(0, 6),
        }));

        const response = await fetch(url, {
            headers: getAuthHeaders(apiKey, apiSecret)
        });

        if (!response.ok) {
            console.log(JSON.stringify({
                event: "podcast_index_episodes_failed",
                status: response.status,
                statusText: response.statusText,
            }));
            // Throw on rate limit so job retries instead of falling back to iTunes
            if (response.status === 429) {
                throw new AppError(
                    ERROR_CODES.RATE_LIMITED,
                    "Podcast Index API rate limit exceeded. Please try again in a few minutes."
                );
            }
            return [];
        }

        const data = await response.json() as PodcastIndexEpisodesResponse;
        const episodes = data.items || [];

        console.log(JSON.stringify({
            event: "podcast_index_episodes_success",
            itunesId,
            episodeCount: episodes.length,
        }));

        return episodes.map(ep => ({
            id: ep.id,
            title: ep.title,
            datePublished: ep.datePublished,
            duration: ep.duration,
            enclosureUrl: ep.enclosureUrl,
            guid: ep.guid,
            transcriptUrl: ep.transcriptUrl,
        }));
    } catch (error) {
        // Re-throw AppErrors (especially rate limit) so they cause job retries
        if (error instanceof AppError) {
            console.error(JSON.stringify({
                event: "podcast_index_episodes_error",
                itunesId,
                error: error.message,
            }));
            throw error;
        }
        console.error(JSON.stringify({
            event: "podcast_index_episodes_error",
            itunesId,
            error: error instanceof Error ? error.message : String(error),
        }));
        return [];
    }
}

// ============================================================================
// Episode Matching
// ============================================================================

/**
 * Normalize a title for fuzzy matching
 * - Lowercase
 * - Replace hyphens with spaces
 * - Remove special characters except spaces
 * - Collapse multiple spaces
 */
function normalizeForMatching(text: string): string {
    return text
        .toLowerCase()
        .replace(/-/g, ' ')           // Replace hyphens with spaces
        .replace(/[^a-z0-9\s]/g, '')  // Remove special chars
        .replace(/\s+/g, ' ')         // Collapse spaces
        .trim();
}

/**
 * Check if two titles match (fuzzy)
 * Returns true if one title starts with or contains the other
 * Handles truncated titles from Apple pages (ending with "…")
 */
function titlesMatch(title1: string, title2: string): boolean {
    // First, handle potential truncation in either title
    const clean1 = stripTruncationSuffix(title1);
    const clean2 = stripTruncationSuffix(title2);

    const norm1 = normalizeForMatching(clean1);
    const norm2 = normalizeForMatching(clean2);

    // Exact match
    if (norm1 === norm2) return true;

    // One contains the other
    if (norm1.includes(norm2) || norm2.includes(norm1)) return true;

    // One starts with the other (for truncated URL slugs)
    if (norm1.startsWith(norm2) || norm2.startsWith(norm1)) return true;

    return false;
}

/**
 * Find episode matching Apple episode ID
 * 
 * Apple episode IDs don't have a direct mapping, so we match by:
 * 1. GUID (if it contains the episode ID)
 * 2. Title (fuzzy matching with normalization)
 * 3. Approximate date
 */
export function findEpisodeByAppleId(
    episodes: PodcastIndexEpisode[],
    appleEpisodeId: string,
    expectedTitle?: string,
    expectedDate?: string
): PodcastIndexEpisode | null {
    console.log(JSON.stringify({
        event: "podcast_index_find_episode_start",
        appleEpisodeId,
        expectedTitle,
        expectedDate,
        episodeCount: episodes.length,
    }));

    // Strategy 1: Check if GUID contains the Apple episode ID
    const byGuid = episodes.find(ep =>
        ep.guid?.includes(appleEpisodeId)
    );
    if (byGuid) {
        console.log(JSON.stringify({
            event: "podcast_index_match_by_guid",
            appleEpisodeId,
            matchedTitle: byGuid.title,
        }));
        return byGuid;
    }

    // Strategy 2: Match by title (fuzzy with normalization)
    if (expectedTitle) {
        const byTitle = episodes.find(ep => titlesMatch(ep.title, expectedTitle));
        if (byTitle) {
            console.log(JSON.stringify({
                event: "podcast_index_match_by_title",
                appleEpisodeId,
                expectedTitle,
                matchedTitle: byTitle.title,
                normalizedExpected: normalizeForMatching(expectedTitle),
                normalizedMatched: normalizeForMatching(byTitle.title),
            }));
            return byTitle;
        }
    }

    // Strategy 3: Match by date
    if (expectedDate) {
        const expectedTimestamp = new Date(expectedDate).getTime() / 1000;
        const byDate = episodes.find(ep => {
            const diff = Math.abs(ep.datePublished - expectedTimestamp);
            return diff < 86400; // Within 24 hours
        });
        if (byDate) {
            console.log(JSON.stringify({
                event: "podcast_index_match_by_date",
                appleEpisodeId,
                expectedDate,
                matchedTitle: byDate.title,
            }));
            return byDate;
        }
    }

    console.log(JSON.stringify({
        event: "podcast_index_no_match",
        appleEpisodeId,
        expectedTitle,
        expectedDate,
        cleanedExpected: expectedTitle ? stripTruncationSuffix(expectedTitle) : undefined,
        normalizedExpected: expectedTitle ? normalizeForMatching(stripTruncationSuffix(expectedTitle)) : undefined,
        sampleEpisodeTitles: episodes.slice(0, 5).map(ep => ep.title),
    }));

    return null;
}
