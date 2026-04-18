/**
 * RSS Feed Parser Service
 * Fetches and parses podcast RSS feeds to extract episode metadata
 */

import { XMLParser } from "fast-xml-parser";
import { AppError } from "../lib/errors";
import { ERROR_CODES, USER_AGENT } from "../lib/constants";
import { stripTruncationSuffix, isTruncatedTitle } from "../lib/title-utils";

/**
 * Episode data extracted from RSS feed
 */
export interface RssEpisode {
    guid: string;
    title: string;
    pubDate: string; // ISO date string
    duration: number; // seconds
    audioUrl: string;
    transcriptUrl?: string;
    transcriptType?: string; // srt, vtt, json, etc.
}

/**
 * Parsed RSS feed data
 */
export interface ParsedFeed {
    title: string;
    episodes: RssEpisode[];
}

// Timeout for RSS feed fetches (10 seconds)
const FETCH_TIMEOUT_MS = 10_000;

// Maximum episodes to parse (for performance)
const MAX_EPISODES = 100;

/**
 * Parse duration string into seconds
 * Handles formats: "3600", "60:00", "1:00:00"
 */
export function parseDuration(durationStr: string | number | undefined): number {
    if (durationStr === undefined || durationStr === null) {
        return 0;
    }

    // Already a number
    if (typeof durationStr === "number") {
        return durationStr;
    }

    const trimmed = durationStr.trim();
    if (!trimmed) {
        return 0;
    }

    // Pure number (seconds)
    if (/^\d+$/.test(trimmed)) {
        return parseInt(trimmed, 10);
    }

    // Time format: MM:SS or HH:MM:SS
    const parts = trimmed.split(":").map((p) => parseInt(p, 10));

    if (parts.some(isNaN)) {
        return 0;
    }

    if (parts.length === 2) {
        // MM:SS
        return parts[0] * 60 + parts[1];
    }

    if (parts.length === 3) {
        // HH:MM:SS
        return parts[0] * 3600 + parts[1] * 60 + parts[2];
    }

    return 0;
}

/**
 * Parse RFC 2822 date to ISO string
 */
function parseRfc2822Date(dateStr: string): string {
    try {
        const date = new Date(dateStr);
        if (isNaN(date.getTime())) {
            return new Date().toISOString();
        }
        return date.toISOString();
    } catch {
        return new Date().toISOString();
    }
}

/**
 * Fetch and parse an RSS feed
 *
 * @param feedUrl - URL of the RSS feed
 * @returns Parsed feed with episodes
 * @throws AppError with RSS_TIMEOUT on timeout
 */
export async function fetchAndParseFeed(feedUrl: string): Promise<ParsedFeed> {
    // Create abort controller for timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    try {
        const response = await fetch(feedUrl, {
            headers: {
                Accept: "application/rss+xml, application/xml, text/xml",
                "User-Agent": USER_AGENT,
            },
            signal: controller.signal,
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
            throw new AppError(
                ERROR_CODES.EPISODE_NOT_FOUND,
                `Failed to fetch RSS feed: ${response.status}`
            );
        }

        const xml = await response.text();
        return parseFeedXml(xml);
    } catch (error) {
        clearTimeout(timeoutId);

        if (error instanceof AppError) {
            throw error;
        }

        // Handle abort (timeout)
        if (error instanceof Error && error.name === "AbortError") {
            throw new AppError(
                ERROR_CODES.RSS_TIMEOUT,
                "RSS feed request timed out. Please try again."
            );
        }

        throw new AppError(
            ERROR_CODES.EPISODE_NOT_FOUND,
            "Failed to fetch RSS feed",
            error instanceof Error ? error : undefined
        );
    }
}

/**
 * Parse RSS XML into structured data
 */
export function parseFeedXml(xml: string): ParsedFeed {
    const parser = new XMLParser({
        ignoreAttributes: false,
        attributeNamePrefix: "@_",
        textNodeName: "#text",
        isArray: (name) => name === "item" || name === "podcast:transcript",
    });

    let parsed: unknown;
    try {
        parsed = parser.parse(xml);
    } catch {
        throw new AppError(
            ERROR_CODES.EPISODE_NOT_FOUND,
            "Failed to parse RSS feed XML"
        );
    }

    const feed = (parsed as Record<string, unknown>)?.rss as Record<string, unknown>;
    const channel = feed?.channel as Record<string, unknown>;

    if (!channel) {
        throw new AppError(
            ERROR_CODES.EPISODE_NOT_FOUND,
            "Invalid RSS feed: missing channel"
        );
    }

    const title = String(channel.title || "Unknown Podcast");
    const items = (channel.item || []) as Array<Record<string, unknown>>;

    const episodes: RssEpisode[] = items.slice(0, MAX_EPISODES).map((item) => {
        // Extract guid
        let guid = "";
        if (typeof item.guid === "string") {
            guid = item.guid;
        } else if (item.guid && typeof item.guid === "object") {
            const guidObj = item.guid as Record<string, unknown>;
            guid = String(guidObj["#text"] || guidObj["@_isPermaLink"] || "");
        }

        // Extract enclosure URL
        let audioUrl = "";
        if (item.enclosure && typeof item.enclosure === "object") {
            const enclosure = item.enclosure as Record<string, unknown>;
            audioUrl = String(enclosure["@_url"] || "");
        }

        // Extract transcript info (Podcasting 2.0)
        let transcriptUrl: string | undefined;
        let transcriptType: string | undefined;

        const transcripts = item["podcast:transcript"];
        if (Array.isArray(transcripts) && transcripts.length > 0) {
            const transcript = transcripts[0] as Record<string, unknown>;
            transcriptUrl = String(transcript["@_url"] || "");
            transcriptType = String(transcript["@_type"] || "").split("/").pop();
        } else if (transcripts && typeof transcripts === "object") {
            const transcript = transcripts as Record<string, unknown>;
            transcriptUrl = String(transcript["@_url"] || "");
            transcriptType = String(transcript["@_type"] || "").split("/").pop();
        }

        // Extract iTunes duration
        const itunesDuration = item["itunes:duration"];
        const duration = parseDuration(itunesDuration as string | number | undefined);

        return {
            guid,
            title: String(item.title || "Untitled Episode"),
            pubDate: parseRfc2822Date(String(item.pubDate || "")),
            duration,
            audioUrl,
            ...(transcriptUrl && { transcriptUrl }),
            ...(transcriptType && { transcriptType }),
        };
    });

    return { title, episodes };
}

/**
 * Options for finding episodes with additional context for better matching
 */
export interface FindEpisodeOptions {
    /** Episode title from external source (e.g., Apple API scrape) for fallback matching */
    expectedTitle?: string;
    /** Episode publication date (ISO string) for fallback matching */
    expectedDate?: string;
    /** Episode index from Apple URL (some feeds use sequential ordering) */
    episodeIndex?: number;
    /** Episode GUID from iTunes API for direct matching */
    episodeGuid?: string;
}

/**
 * Normalize text for comparison (lowercase, remove punctuation, collapse whitespace)
 */
function normalizeText(text: string): string {
    return text
        .toLowerCase()
        .replace(/[^\w\s]/g, " ") // Replace punctuation with spaces
        .replace(/\s+/g, " ") // Collapse whitespace
        .trim();
}

/**
 * Calculate similarity between two strings (0-1 score)
 * Uses a simple word overlap algorithm
 */
function calculateSimilarity(a: string, b: string): number {
    const aNorm = normalizeText(a);
    const bNorm = normalizeText(b);

    if (aNorm === bNorm) return 1;
    if (!aNorm || !bNorm) return 0;

    const aWords = new Set(aNorm.split(" ").filter((w) => w.length > 2));
    const bWords = new Set(bNorm.split(" ").filter((w) => w.length > 2));

    if (aWords.size === 0 || bWords.size === 0) return 0;

    let matches = 0;
    for (const word of aWords) {
        if (bWords.has(word)) matches++;
    }

    // Jaccard-like similarity
    const union = new Set([...aWords, ...bWords]);
    return matches / union.size;
}

/**
 * Check if two dates are within a certain number of days of each other
 */
function datesAreClose(date1: string, date2: string, maxDaysDiff: number): boolean {
    try {
        const d1 = new Date(date1);
        const d2 = new Date(date2);
        const diffMs = Math.abs(d1.getTime() - d2.getTime());
        const diffDays = diffMs / (1000 * 60 * 60 * 24);
        return diffDays <= maxDaysDiff;
    } catch {
        return false;
    }
}

/**
 * Find an episode in a parsed feed by Apple episode ID with fallback strategies
 *
 * Matching strategies (in order of priority):
 * 1. guid contains appleEpisodeId (exact match)
 * 2. guid URL-decoded contains appleEpisodeId
 * 3. Title similarity match (if expectedTitle provided, >80% similarity)
 * 4. Date match + partial title overlap (if expectedDate provided)
 * 5. Recent episode by index (if episodeIndex provided)
 *
 * @param feed - Parsed feed data
 * @param appleEpisodeId - Episode ID from Apple Podcasts URL
 * @param options - Additional context for fallback matching
 * @returns Matching episode or null
 */
export function findEpisodeInFeed(
    feed: ParsedFeed,
    appleEpisodeId: string,
    options: FindEpisodeOptions = {}
): RssEpisode | null {
    console.log(JSON.stringify({
        event: "episode_matching_start",
        appleEpisodeId,
        hasEpisodeGuid: !!options.episodeGuid,
        hasExpectedTitle: !!options.expectedTitle,
        hasExpectedDate: !!options.expectedDate,
        episodeGuid: options.episodeGuid,
        expectedTitle: options.expectedTitle,
        expectedDate: options.expectedDate
    }));

    // Strategy 0: Match by iTunes episodeGuid (most reliable when available)
    if (options.episodeGuid) {
        for (const episode of feed.episodes) {
            if (episode.guid === options.episodeGuid) {
                console.log(JSON.stringify({
                    event: "episode_matched_guid_exact",
                    guid: episode.guid,
                    title: episode.title
                }));
                return episode;
            }
            // Also try URL-decoded match
            try {
                const decoded = decodeURIComponent(episode.guid);
                if (decoded === options.episodeGuid) {
                    console.log(JSON.stringify({
                        event: "episode_matched_guid_decoded",
                        guid: episode.guid,
                        title: episode.title
                    }));
                    return episode;
                }
            } catch {
                // Ignore decode errors
            }
        }
        console.log(JSON.stringify({
            event: "episode_guid_not_matched",
            episodeGuid: options.episodeGuid
        }));
    }

    // Strategy 1 & 2: GUID matching by Apple episode ID (numeric)
    for (const episode of feed.episodes) {
        // Direct match
        if (episode.guid.includes(appleEpisodeId)) {
            return episode;
        }

        // URL-decoded match
        try {
            const decoded = decodeURIComponent(episode.guid);
            if (decoded.includes(appleEpisodeId)) {
                return episode;
            }
        } catch {
            // Ignore decode errors
        }
    }

    // Strategy 3: Title similarity match (high confidence)
    if (options.expectedTitle) {
        // First check for truncated titles (ending with ellipsis)
        // Apple pages often truncate long titles with "…" or "..." mid-word
        if (isTruncatedTitle(options.expectedTitle)) {
            const cleanedPrefix = stripTruncationSuffix(options.expectedTitle);
            const normalizedPrefix = normalizeText(cleanedPrefix);
            console.log(JSON.stringify({
                event: "episode_truncated_prefix_matching",
                originalTitle: options.expectedTitle,
                cleanedPrefix: cleanedPrefix,
                normalizedPrefix: normalizedPrefix,
            }));

            for (const episode of feed.episodes) {
                const normalizedEpisodeTitle = normalizeText(episode.title);
                if (normalizedEpisodeTitle.startsWith(normalizedPrefix)) {
                    console.log(JSON.stringify({
                        event: "episode_matched_truncated_prefix",
                        title: episode.title,
                        prefix: normalizedPrefix,
                    }));
                    return episode;
                }
            }
        }

        // Fall back to word overlap similarity
        let bestMatch: RssEpisode | null = null;
        let bestScore = 0;
        const scores: Array<{ title: string; score: number }> = [];

        for (const episode of feed.episodes) {
            const score = calculateSimilarity(episode.title, options.expectedTitle);
            scores.push({ title: episode.title, score });
            if (score > bestScore && score >= 0.8) {
                bestScore = score;
                bestMatch = episode;
            }
        }

        console.log(JSON.stringify({
            event: "episode_title_matching",
            expectedTitle: options.expectedTitle,
            bestScore,
            threshold: 0.8,
            matched: !!bestMatch,
            topScores: scores.sort((a, b) => b.score - a.score).slice(0, 5)
        }));

        if (bestMatch) {
            console.log(JSON.stringify({
                event: "episode_matched_title",
                title: bestMatch.title,
                score: bestScore
            }));
            return bestMatch;
        }
    }

    // Strategy 4: Date match with title overlap (medium confidence)
    if (options.expectedDate) {
        const dateMatches = feed.episodes.filter((ep) =>
            datesAreClose(ep.pubDate, options.expectedDate!, 2)
        );

        console.log(JSON.stringify({
            event: "episode_date_matching",
            expectedDate: options.expectedDate,
            dateMatchCount: dateMatches.length,
            dateMatches: dateMatches.map(e => ({ title: e.title, pubDate: e.pubDate }))
        }));

        // If only one episode on that date, return it
        if (dateMatches.length === 1) {
            console.log(JSON.stringify({
                event: "episode_matched_date_single",
                title: dateMatches[0].title
            }));
            return dateMatches[0];
        }

        // If multiple episodes on that date and we have a title, pick best match
        if (dateMatches.length > 1 && options.expectedTitle) {
            let bestMatch: RssEpisode | null = null;
            let bestScore = 0;

            for (const episode of dateMatches) {
                const score = calculateSimilarity(episode.title, options.expectedTitle);
                if (score > bestScore) {
                    bestScore = score;
                    bestMatch = episode;
                }
            }

            // Accept lower threshold since we already matched on date
            if (bestMatch && bestScore >= 0.3) {
                console.log(JSON.stringify({
                    event: "episode_matched_date_title",
                    title: bestMatch.title,
                    score: bestScore
                }));
                return bestMatch;
            }
        }
    }

    // Strategy 5: Episode index (lowest confidence fallback)
    // Apple episode IDs often correlate with recency - try matching by position
    if (options.episodeIndex !== undefined && options.episodeIndex >= 0) {
        if (options.episodeIndex < feed.episodes.length) {
            console.log(JSON.stringify({
                event: "episode_matched_index",
                index: options.episodeIndex,
                title: feed.episodes[options.episodeIndex].title
            }));
            return feed.episodes[options.episodeIndex];
        }
    }

    console.log(JSON.stringify({
        event: "episode_not_matched",
        strategies_tried: {
            guid: !!options.episodeGuid,
            numericGuid: true,
            title: !!options.expectedTitle,
            date: !!options.expectedDate,
            index: options.episodeIndex !== undefined
        }
    }));

    return null;
}

export type FetchFeedResult =
    | { status: "ok"; feed: ParsedFeed; etag?: string; lastModified?: string }
    | { status: "not_modified" }
    | { status: "error"; reason: string };

export interface FetchFeedOptions {
    etag?: string;
    lastModified?: string;
}

/**
 * Fetch an RSS feed with conditional GET (If-None-Match / If-Modified-Since).
 * Returns "not_modified" on 304, "ok" with parsed feed + response headers on 200,
 * "error" on 429 or network failure (caller decides fallback).
 */
export async function fetchFeedIfChanged(
    feedUrl: string,
    options: FetchFeedOptions
): Promise<FetchFeedResult> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    const headers: Record<string, string> = {
        Accept: "application/rss+xml, application/xml, text/xml",
        "User-Agent": USER_AGENT,
    };
    if (options.etag) headers["If-None-Match"] = options.etag;
    if (options.lastModified) headers["If-Modified-Since"] = options.lastModified;

    try {
        const response = await fetch(feedUrl, { headers, signal: controller.signal });
        clearTimeout(timeoutId);

        if (response.status === 304) return { status: "not_modified" };
        if (response.status === 429) return { status: "error", reason: "http_429" };
        if (!response.ok) return { status: "error", reason: `http_${response.status}` };

        const xml = await response.text();
        const feed = parseFeedXml(xml);
        return {
            status: "ok",
            feed,
            etag: response.headers.get("ETag") || undefined,
            lastModified: response.headers.get("Last-Modified") || undefined,
        };
    } catch (error) {
        clearTimeout(timeoutId);
        return {
            status: "error",
            reason: error instanceof Error ? error.message : String(error),
        };
    }
}

/**
 * Fetch and parse a transcript file
 *
 * @param transcriptUrl - URL of the transcript
 * @param transcriptType - Type: srt, vtt, json, or plain
 * @returns Plain text transcript or null on error
 */
export async function fetchTranscript(
    transcriptUrl: string,
    transcriptType: string
): Promise<string | null> {
    try {
        const response = await fetch(transcriptUrl, {
            headers: {
                "User-Agent": USER_AGENT,
            },
        });

        if (!response.ok) {
            return null;
        }

        const content = await response.text();

        // Parse based on type
        const type = transcriptType.toLowerCase();

        if (type === "srt" || type === "vtt") {
            return parseSubtitleFile(content);
        }

        if (type === "json") {
            return parseJsonTranscript(content);
        }

        // Plain text or unknown - return as-is
        return content.trim();
    } catch {
        return null;
    }
}

/**
 * Parse SRT/VTT subtitle file to plain text
 */
function parseSubtitleFile(content: string): string {
    // Remove VTT header if present
    let text = content.replace(/^WEBVTT\s*\n/i, "");

    // Remove timing lines (00:00:00,000 --> 00:00:00,000)
    text = text.replace(/^\d{2}:\d{2}:\d{2}[,.]\d{3}\s*-->\s*\d{2}:\d{2}:\d{2}[,.]\d{3}.*$/gm, "");

    // Remove cue numbers
    text = text.replace(/^\d+\s*$/gm, "");

    // Remove style/position tags
    text = text.replace(/<[^>]+>/g, "");

    // Clean up whitespace
    text = text
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .join(" ");

    return text.trim();
}

/**
 * Parse JSON transcript to plain text
 */
function parseJsonTranscript(content: string): string | null {
    try {
        const data = JSON.parse(content);

        // Handle various JSON transcript formats
        if (Array.isArray(data)) {
            // Array of segments with text property
            return data
                .map((segment) => segment.text || segment.content || "")
                .join(" ")
                .trim();
        }

        if (data.segments && Array.isArray(data.segments)) {
            return data.segments
                .map((segment: { text?: string }) => segment.text || "")
                .join(" ")
                .trim();
        }

        if (data.transcript && typeof data.transcript === "string") {
            return data.transcript.trim();
        }

        if (data.text && typeof data.text === "string") {
            return data.text.trim();
        }

        return null;
    } catch {
        return null;
    }
}
