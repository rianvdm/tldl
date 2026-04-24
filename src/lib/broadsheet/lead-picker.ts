import type { EpisodeIndexEntry } from "../../types";

export function selectLeadEpisode<T extends EpisodeIndexEntry>(episodes: T[]): T | null {
    if (episodes.length === 0) return null;
    return episodes.reduce((best, cur) => {
        if (cur.episodeDate > best.episodeDate) return cur;
        if (cur.episodeDate < best.episodeDate) return best;
        return cur.createdAt > best.createdAt ? cur : best;
    });
}
