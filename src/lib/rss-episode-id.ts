/**
 * Compute the first 10 hex chars of SHA-256(guid).
 * Stable identifier for RSS-sourced episodes that don't have an Apple episode ID.
 */
export async function guidHash(guid: string): Promise<string> {
    const data = new TextEncoder().encode(guid);
    const digest = await crypto.subtle.digest("SHA-256", data);
    const bytes = new Uint8Array(digest);
    let hex = "";
    for (let i = 0; i < 5; i++) {
        hex += bytes[i].toString(16).padStart(2, "0");
    }
    return hex;
}

/**
 * Build an episode ID for an RSS-sourced (monitor-queued) episode.
 * Shape: {podcastId}_rss_{guidHash}
 */
export async function deriveRssEpisodeId(podcastId: string, guid: string): Promise<string> {
    const hash = await guidHash(guid);
    return `${podcastId}_rss_${hash}`;
}
