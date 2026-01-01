/**
 * Known Feed URL Corrections
 * 
 * This is a last-resort fallback for podcasts where:
 * 1. Podcast Index has stale/dead feed URLs
 * 2. iTunes API returns 403 from Cloudflare Workers
 * 
 * Once Podcast Index is updated, these will naturally be bypassed
 * since the primary path (Podcast Index) will succeed.
 * 
 * To request Podcast Index to fix a stale feed:
 * - Use the API: POST /api/1.0/add/byfeedurl?url=<correct_url>
 * - Or visit: https://podcastindex.org/add
 */

// Map of iTunes Podcast ID -> corrected feed URL
export const FEED_URL_CORRECTIONS: Record<string, string> = {
    // Product Thinking by Melissa Perri
    // Old: feeds.bcast.fm (dead) -> New: anchor.fm
    "1550800132": "https://anchor.fm/s/ff7e9014/podcast/rss",
};

/**
 * Get a corrected feed URL if one is known
 * Returns undefined if no correction exists
 */
export function getCorrectedFeedUrl(podcastId: string): string | undefined {
    return FEED_URL_CORRECTIONS[podcastId];
}
