/**
 * Pure planning step for scripts/backfill-episode-links.ts: given one stored
 * episode and what we know about its podcast (feed + Apple's episode list),
 * work out which outbound-link fields should change.
 *
 * Kept free of I/O so it can be tested; the script does the fetching and writing.
 */

import type { Episode } from "../../src/types";
import type { ParsedFeed } from "../../src/services/rss";
import { deriveRssEpisodeId } from "../../src/lib/rss-episode-id";
import { resolveWebsiteUrl, toEpisodePageUrl } from "../../src/lib/podcast-links";

export interface AppleEpisode {
    guid: string;
    trackId: number;
    title: string;
    url: string;
}

export interface PodcastLinkSources {
    feed: ParsedFeed | null;
    appleEpisodes: AppleEpisode[];
    monitoredWebsiteUrl?: string;
}

/** How the episode's RSS GUID was found; null when it couldn't be. */
export type GuidMatch = "stored" | "rss-id-hash" | "apple-id" | "audio-url" | "title" | null;

export interface EpisodeLinkPlan {
    guid?: string;
    matchedBy: GuidMatch;
    /** Only the fields that differ. A key present with value undefined means "remove". */
    changes: Partial<Pick<Episode, "episodeGuid" | "appleUrl" | "episodePageUrl" | "podcastWebsiteUrl">>;
}

function withoutQuery(url: string): string {
    try {
        const u = new URL(url);
        return `${u.origin}${u.pathname}`;
    } catch {
        return url;
    }
}

function normalizeTitle(title: string): string {
    return title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function appleEpisodeId(url: string | undefined): string | null {
    try {
        return url ? new URL(url).searchParams.get("i") : null;
    } catch {
        return null;
    }
}

async function resolveGuid(ep: Episode, src: PodcastLinkSources): Promise<{ guid?: string; matchedBy: GuidMatch }> {
    if (ep.episodeGuid) return { guid: ep.episodeGuid, matchedBy: "stored" };

    const feedEpisodes = src.feed?.episodes ?? [];
    const [podcastId, suffix = ""] = ep.id.split(/_(.*)/s);

    if (suffix.startsWith("rss_")) {
        for (const item of feedEpisodes) {
            if (item.guid && (await deriveRssEpisodeId(podcastId, item.guid)) === ep.id) {
                return { guid: item.guid, matchedBy: "rss-id-hash" };
            }
        }
    }

    if (/^\d+$/.test(suffix)) {
        const apple = src.appleEpisodes.find(a => String(a.trackId) === suffix);
        if (apple) return { guid: apple.guid, matchedBy: "apple-id" };
    }

    const audio = withoutQuery(ep.audioUrl);
    const byAudio = feedEpisodes.find(item => item.audioUrl && withoutQuery(item.audioUrl) === audio);
    if (byAudio?.guid) return { guid: byAudio.guid, matchedBy: "audio-url" };

    const title = normalizeTitle(ep.episodeTitle);
    const byTitle = feedEpisodes.find(item => normalizeTitle(item.title) === title);
    if (byTitle?.guid) return { guid: byTitle.guid, matchedBy: "title" };

    return { matchedBy: null };
}

export async function planEpisodeLinks(ep: Episode, src: PodcastLinkSources): Promise<EpisodeLinkPlan> {
    const changes: EpisodeLinkPlan["changes"] = {};
    const { guid, matchedBy } = await resolveGuid(ep, src);

    // Website is podcast-level, so it can be fixed even when the episode can't be matched.
    const website = resolveWebsiteUrl(ep.podcastWebsiteUrl, [src.feed?.link, src.monitoredWebsiteUrl]);
    if (website !== ep.podcastWebsiteUrl) changes.podcastWebsiteUrl = website;

    if (!guid) return { matchedBy, changes };
    if (guid !== ep.episodeGuid) changes.episodeGuid = guid;

    const item = src.feed?.episodes.find(e => e.guid === guid);
    const episodePageUrl = toEpisodePageUrl(item?.link, { websiteUrl: website, audioUrl: item?.audioUrl });
    if (episodePageUrl && episodePageUrl !== ep.episodePageUrl) changes.episodePageUrl = episodePageUrl;

    // Replace any Apple URL that isn't this episode's: show-level, empty, or a
    // ?i= built from a Podcast Index ID. A correct Apple-submitted URL is kept as-is.
    const apple = src.appleEpisodes.find(a => a.guid === guid);
    if (apple && appleEpisodeId(ep.appleUrl) !== String(apple.trackId)) changes.appleUrl = apple.url;

    return { guid, matchedBy, changes };
}
