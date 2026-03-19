/**
 * Apple Podcasts URL Parser
 * Extracts podcast and episode IDs from Apple Podcasts URLs
 */

/**
 * Result of parsing an Apple Podcasts URL
 */
export interface ParsedAppleUrl {
    podcastId: string;
    episodeId: string;
    country: string;
}

/**
 * Parse an Apple Podcasts episode URL and extract IDs
 *
 * Valid URL format:
 * https://podcasts.apple.com/{country}/podcast/{podcast-slug}/id{podcast_id}?i={episode_id}
 *
 * @param url - The Apple Podcasts URL to parse
 * @returns ParsedAppleUrl if valid episode URL, null otherwise
 */
export function parseApplePodcastsUrl(url: string): ParsedAppleUrl | null {
    if (!url || typeof url !== "string") {
        return null;
    }

    try {
        const parsed = new URL(url);

        // Must be podcasts.apple.com
        if (parsed.hostname !== "podcasts.apple.com") {
            return null;
        }

        // Extract country from path (e.g., /us/podcast/...)
        // Pattern: /{country}/podcast/{slug}/id{podcastId}
        const pathMatch = parsed.pathname.match(
            /^\/([a-z]{2})\/podcast\/[^/]+\/id(\d+)\/?$/i
        );

        if (!pathMatch) {
            return null;
        }

        const country = pathMatch[1].toLowerCase();
        const podcastId = pathMatch[2];

        // Episode ID must be in query param ?i=
        const episodeId = parsed.searchParams.get("i");

        if (!episodeId || !/^\d+$/.test(episodeId)) {
            return null;
        }

        return {
            podcastId,
            episodeId,
            country,
        };
    } catch {
        // URL constructor throws on invalid URLs
        return null;
    }
}

/**
 * Result of parsing a podcast-level URL (no episode)
 */
export interface ParsedPodcastUrl {
    podcastId: string;
    country: string;
}

/**
 * Parse an Apple Podcasts podcast URL and extract podcast ID
 * 
 * Valid URL format:
 * https://podcasts.apple.com/{country}/podcast/{podcast-slug}/id{podcast_id}
 * 
 * Note: This accepts both podcast-level URLs and episode URLs (ignoring the episode ID)
 *
 * @param url - The Apple Podcasts URL to parse
 * @returns ParsedPodcastUrl if valid, null otherwise
 */
export function parsePodcastUrl(url: string): ParsedPodcastUrl | null {
    if (!url || typeof url !== "string") {
        return null;
    }

    try {
        const parsed = new URL(url);

        // Must be podcasts.apple.com
        if (parsed.hostname !== "podcasts.apple.com") {
            return null;
        }

        // Extract country and podcast ID from path
        // Pattern: /{country}/podcast/{slug}/id{podcastId}
        const pathMatch = parsed.pathname.match(
            /^\/([a-z]{2})\/podcast\/[^/]+\/id(\d+)\/?$/i
        );

        if (!pathMatch) {
            return null;
        }

        return {
            podcastId: pathMatch[2],
            country: pathMatch[1].toLowerCase(),
        };
    } catch {
        // URL constructor throws on invalid URLs
        return null;
    }
}

/**
 * Derive a stable episode ID for storage from podcast and episode IDs
 *
 * @param podcastId - The podcast ID from Apple
 * @param episodeId - The episode ID from Apple
 * @returns A stable key in format: {podcastId}_{episodeId}
 */
export function deriveEpisodeId(podcastId: string, episodeId: string): string {
    return `${podcastId}_${episodeId}`;
}

/**
 * Extract the podcast ID from a derived episode ID
 *
 * @param episodeId - The derived episode ID in format: {podcastId}_{episodeId}
 * @returns The podcast ID if valid format, null otherwise
 */
export function extractPodcastId(episodeId: string): string | null {
    if (!episodeId || typeof episodeId !== "string") {
        return null;
    }
    const match = episodeId.match(/^(\d+)_/);
    return match ? match[1] : null;
}

/**
 * Result of parsing a YouTube URL
 */
export interface ParsedYouTubeUrl {
    videoId: string;
}

/**
 * Parse a YouTube URL and extract the video ID.
 *
 * Accepts:
 * - https://www.youtube.com/watch?v=VIDEO_ID
 * - https://youtu.be/VIDEO_ID
 * - https://www.youtube.com/shorts/VIDEO_ID
 */
export function parseYouTubeUrl(url: string): ParsedYouTubeUrl | null {
    if (!url || typeof url !== "string") {
        return null;
    }

    try {
        const parsed = new URL(url);
        const hostname = parsed.hostname.replace(/^www\./, "");

        if (hostname === "youtube.com") {
            if (parsed.pathname === "/watch") {
                const videoId = parsed.searchParams.get("v");
                if (videoId && /^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
                    return { videoId };
                }
            }
            const shortsMatch = parsed.pathname.match(/^\/shorts\/([a-zA-Z0-9_-]{11})\/?$/);
            if (shortsMatch) {
                return { videoId: shortsMatch[1] };
            }
        }

        if (hostname === "youtu.be") {
            const videoId = parsed.pathname.slice(1).split("/")[0];
            if (videoId && /^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
                return { videoId };
            }
        }

        return null;
    } catch {
        return null;
    }
}

/**
 * Detect the type of a submitted URL.
 *
 * @returns "apple" | "youtube" | "unknown"
 */
export function detectUrlType(url: string): "apple" | "youtube" | "unknown" {
    if (parseApplePodcastsUrl(url)) return "apple";
    if (parseYouTubeUrl(url)) return "youtube";
    return "unknown";
}
