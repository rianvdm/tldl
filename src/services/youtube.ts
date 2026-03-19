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

    // DIAGNOSTIC: log what we actually got from YouTube
    console.log(JSON.stringify({
        event: "youtube_page_fetch",
        videoId,
        htmlLength: html.length,
        hasPlayerResponse: html.includes("ytInitialPlayerResponse"),
        first200: html.slice(0, 200),
    }));

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
    console.log(JSON.stringify({
        event: "youtube_caption_fetch",
        videoId,
        trackCount: captionTracks.length,
        selectedTrack: { languageCode: captionTrack.languageCode, kind: captionTrack.kind },
        fullBaseUrl: captionTrack.baseUrl,
    }));
    const transcriptText = await fetchCaptionText(captionTrack.baseUrl, videoId);

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

/**
 * Extract ytInitialPlayerResponse from YouTube page HTML using brace counting
 * rather than regex, so it works across all page variants and script structures.
 */
function extractPlayerResponse(html: string): PlayerResponse | null {
    // Find the assignment — handles var/let/const/window. prefix and no-prefix variants
    const marker = "ytInitialPlayerResponse";
    const markerIdx = html.indexOf(marker);
    if (markerIdx === -1) return null;

    // Find the opening brace of the JSON object
    const braceIdx = html.indexOf("{", markerIdx);
    if (braceIdx === -1) return null;

    // Walk forward counting braces to find the matching close
    let depth = 0;
    let inString = false;
    let escape = false;
    for (let i = braceIdx; i < html.length; i++) {
        const ch = html[i];
        if (escape) { escape = false; continue; }
        if (ch === "\\" && inString) { escape = true; continue; }
        if (ch === '"' && !escape) { inString = !inString; continue; }
        if (inString) continue;
        if (ch === "{") depth++;
        else if (ch === "}") {
            depth--;
            if (depth === 0) {
                try {
                    return JSON.parse(html.slice(braceIdx, i + 1)) as PlayerResponse;
                } catch {
                    return null;
                }
            }
        }
    }
    return null;
}

function selectBestCaptionTrack(tracks: CaptionTrack[]): CaptionTrack {
    const englishTracks = tracks.filter((t) => t.languageCode.startsWith("en"));
    const searchSet = englishTracks.length > 0 ? englishTracks : tracks;
    const manual = searchSet.find((t) => !t.kind || t.kind !== "asr");
    return manual ?? searchSet[0];
}

async function fetchCaptionText(baseUrl: string, videoId: string): Promise<string> {
    const captionHeaders = {
        ...BROWSER_HEADERS,
        "Referer": `https://www.youtube.com/watch?v=${videoId}`,
    };

    // Try the signed URL from the page first, then fall back to the legacy
    // public timedtext endpoint which doesn't require session authentication.
    const urlsToTry = [
        baseUrl,
        `https://video.google.com/timedtext?v=${videoId}&lang=en`,
        `https://video.google.com/timedtext?v=${videoId}&lang=en&fmt=json3`,
    ];

    let body = "";
    for (const url of urlsToTry) {
        let response: Response;
        try {
            response = await fetch(url, { headers: captionHeaders });
        } catch {
            continue;
        }
        if (!response.ok) continue;
        const candidate = await response.text();
        console.log(JSON.stringify({
            event: "youtube_caption_response",
            url: url.slice(0, 80),
            status: response.status,
            bodyLength: candidate.length,
            first200: candidate.slice(0, 200),
        }));
        if (candidate.trim().length > 0) {
            body = candidate;
            break;
        }
    }

    if (!body) {
        throw new AppError(
            ERROR_CODES.TRANSCRIPTION_FAILED,
            "Could not retrieve captions for this video."
        );
    }

    // Detect format by content: XML starts with '<', JSON3 starts with '{'
    let text: string;
    if (body.trimStart().startsWith("<")) {
        text = parseCaptionXml(body);
    } else if (body.trimStart().startsWith("{")) {
        text = parseCaptionJson3(body);
    } else {
        text = "";
    }

    if (!text) {
        throw new AppError(
            ERROR_CODES.TRANSCRIPTION_FAILED,
            "Could not retrieve captions for this video."
        );
    }
    return text;
}

/**
 * Parse YouTube caption XML (timedtext format) into plain text.
 * Strips all XML/HTML tags, decodes HTML entities.
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

/**
 * Parse YouTube caption JSON3 format (wireMagic: "pb3") into plain text.
 * Extracts text from events[].segs[].utf8, skipping non-text events.
 */
export function parseCaptionJson3(json: string): string {
    let data: { events?: Array<{ segs?: Array<{ utf8?: string }> }> };
    try {
        data = JSON.parse(json) as typeof data;
    } catch {
        return "";
    }
    if (!data.events) return "";

    const segments = data.events
        .filter((e) => e.segs && e.segs.length > 0)
        .flatMap((e) => e.segs!.map((s) => s.utf8 ?? ""))
        .map((t) => t.trim());

    return segments.filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
}
