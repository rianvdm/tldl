/**
 * YouTube Service
 *
 * Fetches video metadata and captions from the YouTube watch page.
 * No API key required — extracts data from embedded JSON blobs.
 */

import { AppError } from "../lib/errors";
import { ERROR_CODES } from "../lib/constants";
import { withRetry, isServerError } from "../lib/retry";
import type { YouTubeEpisodeData } from "../types";

const BROWSER_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
};

/**
 * Fetch YouTube video metadata and captions from the watch page.
 *
 * @param videoId - YouTube video ID (e.g. "dQw4w9WgXcQ")
 * @throws AppError FETCH_FAILED if page cannot be parsed or video is unavailable
 * @throws AppError TRANSCRIPTION_FAILED if no captions available or caption fetch fails
 */
export async function fetchYouTubeEpisodeData(videoId: string): Promise<YouTubeEpisodeData> {
    const watchUrl = `https://www.youtube.com/watch?v=${videoId}`;

    const html = await withRetry(
        async () => {
            const response = await fetch(watchUrl, { headers: BROWSER_HEADERS });
            if (!response.ok) {
                throw new Error(`YouTube page fetch failed: HTTP ${response.status}`);
            }
            return response.text();
        },
        { maxRetries: 2, baseDelayMs: 2000, shouldRetry: isServerError }
    );

    const playerResponse = extractPlayerResponse(html);
    if (!playerResponse || !playerResponse.videoDetails) {
        throw new AppError(
            ERROR_CODES.FETCH_FAILED,
            "Could not load video data. The video may be private, unavailable, or region-restricted."
        );
    }

    const { videoDetails, microformat, captions } = playerResponse;

    const videoTitle = videoDetails.title ?? "Unknown Title";
    const channelName = videoDetails.author ?? "Unknown Channel";
    const durationSeconds = parseInt(videoDetails.lengthSeconds ?? "0", 10);
    const publishDate = microformat?.playerMicroformatRenderer?.publishDate
        ?? new Date().toISOString().split("T")[0];

    const captionTracks: CaptionTrack[] =
        captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];

    if (captionTracks.length === 0) {
        throw new AppError(
            ERROR_CODES.TRANSCRIPTION_FAILED,
            "This video doesn't have captions available. Only videos with captions can be processed."
        );
    }

    const captionTrack = selectBestCaptionTrack(captionTracks);
    const transcriptText = await fetchCaptionText(captionTrack.baseUrl);

    return { videoTitle, channelName, durationSeconds, publishDate, transcriptText };
}

// ============================================================================
// Internal types
// ============================================================================

interface CaptionTrack {
    baseUrl: string;
    languageCode: string;
    kind?: string;
    name?: { simpleText?: string };
}

interface PlayerResponse {
    videoDetails?: { title?: string; author?: string; lengthSeconds?: string };
    microformat?: { playerMicroformatRenderer?: { publishDate?: string } };
    captions?: { playerCaptionsTracklistRenderer?: { captionTracks?: CaptionTrack[] } };
}

// ============================================================================
// Internal helpers
// ============================================================================

function extractPlayerResponse(html: string): PlayerResponse | null {
    // Match the ytInitialPlayerResponse JSON blob. The pattern uses a greedy match
    // on the outer braces and stops at the semicolon that terminates the assignment.
    // On real YouTube pages this is followed by `var` or `</script>`, but in tests
    // it may be the only content, so we don't require a trailing sentinel.
    const match = html.match(/var ytInitialPlayerResponse\s*=\s*(\{[\s\S]+\});/);
    if (!match) return null;
    try {
        return JSON.parse(match[1]) as PlayerResponse;
    } catch {
        return null;
    }
}

function selectBestCaptionTrack(tracks: CaptionTrack[]): CaptionTrack {
    const englishTracks = tracks.filter((t) => t.languageCode.startsWith("en"));
    const searchSet = englishTracks.length > 0 ? englishTracks : tracks;
    const manual = searchSet.find((t) => !t.kind || t.kind !== "asr");
    return manual ?? searchSet[0];
}

async function fetchCaptionText(baseUrl: string): Promise<string> {
    let response: Response;
    try {
        response = await fetch(baseUrl, { headers: BROWSER_HEADERS });
    } catch {
        throw new AppError(
            ERROR_CODES.TRANSCRIPTION_FAILED,
            "Could not retrieve captions for this video."
        );
    }
    if (!response.ok) {
        throw new AppError(
            ERROR_CODES.TRANSCRIPTION_FAILED,
            "Could not retrieve captions for this video."
        );
    }
    const xml = await response.text();
    return parseCaptionXml(xml);
}

/**
 * Parse YouTube caption XML into plain text.
 * Strips all XML/HTML tags (including <c>, <font>), decodes HTML entities.
 */
export function parseCaptionXml(xml: string): string {
    const textMatches = [...xml.matchAll(/<text[^>]*>([\s\S]*?)<\/text>/g)];
    if (textMatches.length === 0) return "";

    const segments = textMatches.map((m) => {
        let text = m[1];
        text = text.replace(/<[^>]+>/g, "");
        text = text
            .replace(/&amp;/g, "&")
            .replace(/&lt;/g, "<")
            .replace(/&gt;/g, ">")
            .replace(/&quot;/g, '"')
            .replace(/&#39;/g, "'")
            .replace(/&apos;/g, "'");
        return text.trim();
    });

    return segments.filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
}
