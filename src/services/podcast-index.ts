/**
 * Podcast Index API Service
 * Primary source for podcast and episode metadata
 * https://podcastindex-org.github.io/docs-api/
 */

import { createHash } from "node:crypto";

// ============================================================================
// Types
// ============================================================================

export interface PodcastIndexPodcast {
    id: number;
    url: string;           // RSS feed URL
    title: string;
    itunesId: number;
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
        "User-Agent": "TLDL/1.0 (Podcast Summary Service)"
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
        }));

        const response = await fetch(url, {
            headers: getAuthHeaders(apiKey, apiSecret)
        });
        
        if (!response.ok) {
            console.log(JSON.stringify({
                event: "podcast_index_lookup_failed",
                status: response.status,
                statusText: response.statusText,
            }));
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
            itunesId: data.feed.itunesId
        };
    } catch (error) {
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
    max: number = 1000
): Promise<PodcastIndexEpisode[]> {
    const url = `https://api.podcastindex.org/api/1.0/episodes/byitunesid?id=${itunesId}&max=${max}`;
    
    try {
        console.log(JSON.stringify({
            event: "podcast_index_episodes_start",
            itunesId,
            max,
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
 * Find episode matching Apple episode ID
 * 
 * Apple episode IDs don't have a direct mapping, so we match by:
 * 1. GUID (if it contains the episode ID)
 * 2. Title + approximate date
 * 3. Enclosure URL patterns
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
    
    // Strategy 2: Match by title (fuzzy)
    if (expectedTitle) {
        const normalizedExpected = expectedTitle.toLowerCase().trim();
        const byTitle = episodes.find(ep => {
            const normalizedTitle = ep.title.toLowerCase().trim();
            return normalizedTitle === normalizedExpected ||
                   normalizedTitle.includes(normalizedExpected) ||
                   normalizedExpected.includes(normalizedTitle);
        });
        if (byTitle) {
            console.log(JSON.stringify({
                event: "podcast_index_match_by_title",
                appleEpisodeId,
                expectedTitle,
                matchedTitle: byTitle.title,
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
    }));
    
    return null;
}
