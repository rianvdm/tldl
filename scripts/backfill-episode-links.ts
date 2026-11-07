/**
 * Backfill outbound links on every stored episode: the episode's own Apple
 * Podcasts URL, the publisher's episode page, and the podcast website.
 *
 * Runs locally because the iTunes Lookup API (the only source for Apple
 * episode IDs older than the ~10 on each show page) 403s from Cloudflare
 * Workers but works from a laptop. New episodes don't need this: the 2h cron
 * fills their links (see src/lib/apple-link-enrichment.ts).
 *
 *   npm run backfill:links                      # dry run: plan + report, no writes
 *   npm run backfill:links -- --podcast <id>    # limit to one podcast (repeatable)
 *   npm run backfill:links -- --apply           # write the planned changes to prod KV
 *
 * Every run writes the full plan to scripts/backfill-results/. Idempotent: a
 * second run plans nothing for episodes the first one fixed.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { Episode, EpisodeIndexEntry, MonitoredPodcast } from "../src/types";
import { parseFeedXml, type ParsedFeed } from "../src/services/rss";
import { resolveWebsiteUrl, toWebsiteUrl } from "../src/lib/podcast-links";
import { extractPodcastId } from "../src/lib/url-parser";
import { CONTENT_TTL_SECONDS, kvBulkGetJson, kvBulkPutJson, kvGetJson, kvPutJson } from "./lib/prod-kv";
import { planEpisodeLinks, type AppleEpisode, type EpisodeLinkPlan } from "./lib/episode-links-plan";

const RESULTS_DIR = join(dirname(fileURLToPath(import.meta.url)), "backfill-results");
const FEED_UA = "Mozilla/5.0";
/** iTunes Lookup is limited to roughly 20 requests a minute per IP. */
const ITUNES_SPACING_MS = 3500;
const ITUNES_EPISODE_LIMIT = 200; // API maximum

interface Args {
    apply: boolean;
    podcastIds: string[];
}

function parseArgs(argv: string[]): Args {
    const out: Args = { apply: false, podcastIds: [] };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === "--help" || a === "-h") {
            console.log(
                "Backfill Apple episode URLs, episode pages and websites on stored episodes.\n\n" +
                "  npm run backfill:links                     Dry run: plan and report only\n" +
                "  npm run backfill:links -- --podcast <id>   Limit to a podcast (repeatable)\n" +
                "  npm run backfill:links -- --apply          Write planned changes to prod KV\n"
            );
            process.exit(0);
        } else if (a === "--apply") {
            out.apply = true;
        } else if (a === "--podcast") {
            const id = argv[++i];
            if (!id) throw new Error("--podcast needs a podcast ID");
            out.podcastIds.push(id);
        } else {
            throw new Error(`Unknown argument: ${a} (try --help)`);
        }
    }
    return out;
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

interface ItunesResult {
    wrapperType?: string;
    kind?: string;
    feedUrl?: string;
    trackId?: number;
    trackName?: string;
    episodeGuid?: string;
    trackViewUrl?: string;
}

/** Apple's tracking parameter (uo=4) adds nothing to a link we display. */
function cleanAppleUrl(url: string): string {
    const u = new URL(url);
    u.searchParams.delete("uo");
    return u.toString();
}

async function lookupItunes(podcastId: string): Promise<{ feedUrl?: string; episodes: AppleEpisode[] }> {
    const url = `https://itunes.apple.com/lookup?id=${podcastId}&entity=podcastEpisode&limit=${ITUNES_EPISODE_LIMIT}`;
    for (let attempt = 1; attempt <= 3; attempt++) {
        const res = await fetch(url);
        if (res.status === 403 || res.status === 429) {
            await sleep(attempt * 15_000);
            continue;
        }
        if (!res.ok) throw new Error(`iTunes lookup ${podcastId}: HTTP ${res.status}`);
        const { results = [] } = (await res.json()) as { results?: ItunesResult[] };
        return {
            feedUrl: results.find(r => r.kind === "podcast")?.feedUrl,
            episodes: results
                .filter(r => r.wrapperType === "podcastEpisode" && r.episodeGuid && r.trackId && r.trackViewUrl)
                .map(r => ({ guid: r.episodeGuid!, trackId: r.trackId!, title: r.trackName ?? "", url: cleanAppleUrl(r.trackViewUrl!) })),
        };
    }
    throw new Error(`iTunes lookup ${podcastId}: still rate-limited after 3 attempts`);
}

async function fetchFeed(url: string): Promise<ParsedFeed> {
    const res = await fetch(url, { headers: { "User-Agent": FEED_UA }, signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return parseFeedXml(await res.text(), { maxEpisodes: Infinity });
}

interface PodcastReport {
    podcastId: string;
    name: string;
    episodes: number;
    matched: number;
    appleEpisodesKnown: number;
    feedWebsite?: string;
    errors: string[];
}

interface EpisodeResult extends EpisodeLinkPlan {
    id: string;
    title: string;
    before: Pick<Episode, "appleUrl" | "episodePageUrl" | "podcastWebsiteUrl">;
}

async function main(): Promise<void> {
    const args = parseArgs(process.argv.slice(2));

    console.log("Reading episode index…");
    const index = kvGetJson<EpisodeIndexEntry[]>("episodes:index") ?? [];
    const byPodcast = new Map<string, string[]>();
    let skippedNoPodcastId = 0;
    for (const entry of index) {
        const podcastId = extractPodcastId(entry.id);
        if (!podcastId) { skippedNoPodcastId++; continue; }
        if (args.podcastIds.length > 0 && !args.podcastIds.includes(podcastId)) continue;
        byPodcast.set(podcastId, [...(byPodcast.get(podcastId) ?? []), entry.id]);
    }
    const episodeIds = [...byPodcast.values()].flat();
    console.log(`${episodeIds.length} episodes across ${byPodcast.size} podcasts (${skippedNoPodcastId} without a podcast ID skipped)`);

    console.log("Reading episode and monitored-podcast records…");
    const episodes = kvBulkGetJson<Episode>(episodeIds.map(id => `episode:${id}`));
    const monitored = kvBulkGetJson<MonitoredPodcast>([...byPodcast.keys()].map(id => `monitored:${id}`));

    const results: EpisodeResult[] = [];
    const podcastReports: PodcastReport[] = [];
    const monitoredWebsiteFixes: Array<{ podcastId: string; from?: string; to: string }> = [];

    for (const [podcastId, ids] of byPodcast) {
        const mon = monitored.get(`monitored:${podcastId}`) ?? null;
        const report: PodcastReport = { podcastId, name: mon?.name ?? "", episodes: ids.length, matched: 0, appleEpisodesKnown: 0, errors: [] };
        podcastReports.push(report);

        let itunes: Awaited<ReturnType<typeof lookupItunes>> = { episodes: [] };
        try {
            itunes = await lookupItunes(podcastId);
        } catch (error) {
            report.errors.push(String(error instanceof Error ? error.message : error));
        }
        await sleep(ITUNES_SPACING_MS);
        report.appleEpisodesKnown = itunes.episodes.length;

        let feed: ParsedFeed | null = null;
        const feedUrl = mon?.rssUrl || itunes.feedUrl;
        if (feedUrl) {
            try {
                feed = await fetchFeed(feedUrl);
            } catch (error) {
                report.errors.push(`feed ${feedUrl}: ${error instanceof Error ? error.message : error}`);
            }
        } else {
            report.errors.push("no feed URL");
        }
        report.feedWebsite = toWebsiteUrl(feed?.link);
        const monitoredWebsite = mon ? resolveWebsiteUrl(mon.websiteUrl, [feed?.link]) : undefined;
        if (mon && monitoredWebsite && monitoredWebsite !== mon.websiteUrl) {
            monitoredWebsiteFixes.push({ podcastId, from: mon.websiteUrl, to: monitoredWebsite });
        }

        for (const id of ids) {
            const ep = episodes.get(`episode:${id}`);
            if (!ep) continue; // in the index but expired from KV
            report.name ||= ep.podcastName;
            const plan = await planEpisodeLinks(ep, { feed, appleEpisodes: itunes.episodes, monitoredWebsiteUrl: mon?.websiteUrl });
            if (plan.matchedBy) report.matched++;
            results.push({
                id,
                title: ep.episodeTitle,
                before: { appleUrl: ep.appleUrl, episodePageUrl: ep.episodePageUrl, podcastWebsiteUrl: ep.podcastWebsiteUrl },
                ...plan,
            });
        }
        const r = report;
        console.log(`  ${r.name.slice(0, 40).padEnd(40)} ${String(r.matched).padStart(3)}/${String(r.episodes).padEnd(3)} matched, ${r.appleEpisodesKnown} Apple eps${r.errors.length ? `  ⚠ ${r.errors.join("; ")}` : ""}`);
    }

    const changed = results.filter(r => Object.keys(r.changes).length > 0);
    const count = (field: keyof EpisodeLinkPlan["changes"]) => changed.filter(r => field in r.changes).length;
    const matchCounts = results.reduce<Record<string, number>>((acc, r) => {
        const k = r.matchedBy ?? "unmatched";
        acc[k] = (acc[k] ?? 0) + 1;
        return acc;
    }, {});

    const summary = {
        mode: args.apply ? "apply" : "dry-run",
        episodesScanned: results.length,
        episodesChanged: changed.length,
        guidMatchedBy: matchCounts,
        fieldChanges: {
            episodeGuid: count("episodeGuid"),
            appleUrl: count("appleUrl"),
            episodePageUrl: count("episodePageUrl"),
            podcastWebsiteUrlSetOrChanged: changed.filter(r => "podcastWebsiteUrl" in r.changes && r.changes.podcastWebsiteUrl).length,
            podcastWebsiteUrlRemoved: changed.filter(r => "podcastWebsiteUrl" in r.changes && !r.changes.podcastWebsiteUrl).length,
        },
        stillShowLevelApple: results.filter(r => !r.changes.appleUrl && /\/id\d+\/?$/.test(r.before.appleUrl ?? "")).length,
        monitoredWebsiteFixes,
    };

    mkdirSync(RESULTS_DIR, { recursive: true });
    const reportPath = join(RESULTS_DIR, `episode-links-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
    // undefined -> null so a planned removal ("podcastWebsiteUrl": null) is visible in the report.
    const keepUndefined = (_key: string, value: unknown) => (value === undefined ? null : value);
    writeFileSync(reportPath, JSON.stringify({ summary, podcasts: podcastReports, episodes: results }, keepUndefined, 2));

    console.log("\n" + JSON.stringify(summary, null, 2));
    console.log(`\nFull plan: ${reportPath}`);

    if (!args.apply) {
        console.log("\nDry run: nothing written. Re-run with --apply to write.");
        return;
    }

    // Re-read right before writing: the cron may have touched a record while the
    // iTunes lookups ran. Changes are field-level, so they merge onto fresh data.
    console.log(`\nWriting ${changed.length} episodes…`);
    const fresh = kvBulkGetJson<Episode>(changed.map(r => `episode:${r.id}`));
    const writes = changed.flatMap(r => {
        const current = fresh.get(`episode:${r.id}`);
        return current ? [{ key: `episode:${r.id}`, value: { ...current, ...r.changes } }] : [];
    });
    // Pre-images, for rollback: kvBulkPutJson(backup.episodes, CONTENT_TTL_SECONDS).
    const backupPath = reportPath.replace(/\.json$/, ".backup.json");
    writeFileSync(backupPath, JSON.stringify({
        episodes: writes.map(w => ({ key: w.key, value: fresh.get(w.key) })),
        monitored: monitoredWebsiteFixes.map(f => ({ key: `monitored:${f.podcastId}`, value: monitored.get(`monitored:${f.podcastId}`) })),
    }));
    console.log(`Backup of overwritten records: ${backupPath}`);
    kvBulkPutJson(writes, CONTENT_TTL_SECONDS);
    console.log(`Wrote ${writes.length} episodes.`);

    for (const fix of monitoredWebsiteFixes) {
        const current = kvGetJson<MonitoredPodcast>(`monitored:${fix.podcastId}`);
        if (!current) continue;
        kvPutJson(`monitored:${fix.podcastId}`, { ...current, websiteUrl: fix.to }); // no TTL: must never expire
    }
    console.log(`Updated website on ${monitoredWebsiteFixes.length} monitored podcasts.`);
}

main().catch(error => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
});
