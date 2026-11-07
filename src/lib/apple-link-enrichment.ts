/**
 * Upgrade monitor-ingested episodes from the show-level Apple Podcasts URL
 * they're saved with to the episode's own Apple URL.
 *
 * The cron usually processes an episode within 2h of publication, but Apple's
 * show page can take most of a day to list it (measured 2026-11-07: a 4h-old
 * episode was missing, day-old ones were present). So this runs on every cron
 * tick and retries each episode until Apple lists it or the window closes.
 */

import type { Env } from "../types";
import { getEpisode, getEpisodeIndex, saveEpisode } from "./kv";
import { isShowLevelAppleUrl } from "./podcast-links";
import { extractPodcastId } from "./url-parser";
import { fetchAppleEpisodeUrls } from "../services/apple-show-page";

/** Stop retrying after this long; older episodes are the backfill script's job. */
const ENRICH_WINDOW_DAYS = 14;

export interface AppleLinkEnrichmentResult {
    /** Episodes in the window still waiting for an episode-level Apple URL. */
    pending: number;
    updated: number;
}

export async function enrichAppleEpisodeLinks(env: Env, now: Date = new Date()): Promise<AppleLinkEnrichmentResult> {
    const kv = env.TLDL_DATA;
    const cutoff = now.getTime() - ENRICH_WINDOW_DAYS * 86_400_000;

    const recent = (await getEpisodeIndex(kv)).filter(entry => Date.parse(entry.createdAt) >= cutoff);
    const episodes = await Promise.all(recent.map(entry => getEpisode(kv, entry.id)));
    const pending = episodes.filter(
        (ep): ep is NonNullable<typeof ep> => !!ep?.episodeGuid && isShowLevelAppleUrl(ep.appleUrl)
    );

    const byPodcast = new Map<string, typeof pending>();
    for (const ep of pending) {
        const podcastId = extractPodcastId(ep.id);
        if (!podcastId) continue;
        byPodcast.set(podcastId, [...(byPodcast.get(podcastId) ?? []), ep]);
    }

    let updated = 0;
    for (const [podcastId, podcastEpisodes] of byPodcast) {
        const appleUrls = await fetchAppleEpisodeUrls(podcastId);
        for (const ep of podcastEpisodes) {
            const appleUrl = appleUrls.get(ep.episodeGuid!);
            if (!appleUrl) continue;
            await saveEpisode(kv, { ...ep, appleUrl });
            updated++;
        }
    }

    console.log(JSON.stringify({
        event: "apple_link_enrichment",
        pending: pending.length,
        podcasts: byPodcast.size,
        updated,
    }));
    return { pending: pending.length, updated };
}
