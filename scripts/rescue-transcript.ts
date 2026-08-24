/**
 * Rescue an episode the queue consumer can't transcribe on its own.
 *
 * Two production failure modes leave an episode permanently stuck, and both have
 * the same fix — transcribe it somewhere without Cloudflare's constraints, then
 * hand the result to the consumer:
 *
 *   1. The audio host 429s Cloudflare's egress, so every queue retry fails on the
 *      HEAD and the episode never reaches the CDN (see #52).
 *   2. Every chunk falls back to whisper-1 (~50-150s each) and the invocation is
 *      killed by the 15-minute queue wall clock, restarting from chunk 1 forever
 *      (see #48).
 *
 * Step 3 of `processEpisode` is guarded by `if (!transcript)`, so a transcript
 * already in KV makes the requeued job skip the entire audio path and go straight
 * to summarizing. Your laptop has no wall clock and isn't the throttled IP.
 *
 * This script does the whole runbook: reverse-maps the episode ID to its feed
 * GUID, transcribes locally, writes `transcript:{id}` to prod KV, then clears the
 * two dedup signals so the next cron tick picks the episode up.
 *
 *   npm run rescue -- <episodeId> [<episodeId> ...]
 *   npm run rescue -- <episodeId> --dry-run          # transcribe only, no KV writes
 *   npm run rescue -- <episodeId> --audio-url <url>  # skip feed lookup (aged-out episodes)
 *   npm run rescue -- --help
 *
 * After it finishes, verify on the next cron tick that `episode:{id}` and
 * `summary:{id}:{templateId}` exist and the ID is in `episodes:index`.
 */

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { transcribeAudio } from "../src/services/transcription";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..");

const KV_NAMESPACE = "ee123158d5d54359b4257f8a1b678adf"; // TLDL_DATA (prod), see wrangler.toml
const CONTENT_TTL_SECONDS = 31536000; // 365 days, matches TTL.CONTENT
const FEED_UA = "Mozilla/5.0";

interface Args {
    episodeIds: string[];
    dryRun: boolean;
    audioUrl?: string;
}

function parseArgs(argv: string[]): Args {
    const out: Args = { episodeIds: [], dryRun: false };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === "--help" || a === "-h") {
            console.log(usage());
            process.exit(0);
        } else if (a === "--dry-run") {
            out.dryRun = true;
        } else if (a === "--audio-url") {
            out.audioUrl = argv[++i];
            if (!out.audioUrl) throw new Error("--audio-url needs a URL");
        } else if (a.startsWith("-")) {
            throw new Error(`Unknown flag: ${a} (try --help)`);
        } else {
            out.episodeIds.push(a);
        }
    }
    if (out.episodeIds.length === 0) throw new Error("No episode IDs given (try --help)");
    if (out.audioUrl && out.episodeIds.length > 1) {
        throw new Error("--audio-url applies to a single episode; pass one ID at a time");
    }
    return out;
}

function usage(): string {
    return (
        `Rescue stuck episodes by transcribing locally and pre-seeding prod KV.\n\n` +
        `  npm run rescue -- <episodeId> [<episodeId> ...]\n\n` +
        `  --dry-run           Transcribe and write local JSON only; touch no KV\n` +
        `  --audio-url <url>   Use this audio URL instead of looking it up in the RSS feed\n` +
        `                      (for episodes that have aged out of the feed)\n` +
        `  --help              This help\n`
    );
}

function readApiKey(): string {
    const vars = readFileSync(join(REPO_ROOT, ".dev.vars"), "utf8");
    const match = vars.match(/^OPENAI_API_KEY\s*=\s*"?([^"\n]+)"?/m);
    if (!match) throw new Error("OPENAI_API_KEY not found in .dev.vars");
    return match[1].trim();
}

/**
 * Read a KV key. Returns null when the key is absent.
 *
 * Note: `wrangler kv key get` on a missing key exits non-zero AND prints its 404
 * to stdout, so "did I get bytes back?" is not a valid existence check. We rely
 * on the exit code (execFileSync throws) and discard stderr entirely.
 */
function kvGet(key: string): string | null {
    try {
        return execFileSync(
            "npx",
            ["wrangler", "kv", "key", "get", key, "--namespace-id", KV_NAMESPACE, "--remote"],
            { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"], cwd: REPO_ROOT }
        );
    } catch {
        return null;
    }
}

function kvGetJson<T>(key: string): T | null {
    const raw = kvGet(key);
    if (raw === null) return null;
    try {
        return JSON.parse(raw) as T;
    } catch {
        throw new Error(`KV key ${key} did not contain valid JSON (got ${raw.length} bytes)`);
    }
}

/**
 * Write a KV value from a temp file.
 *
 * `ttlSeconds` omitted means no expiry — required for `monitored:*` records,
 * which must never be scheduled for deletion. Content keys pass CONTENT_TTL_SECONDS.
 * The flag is `--ttl`; `--expiration-ttl` hard-errors on wrangler 4.x.
 */
function kvPutJson(key: string, value: unknown, ttlSeconds?: number): void {
    const dir = mkdtempSync(join(tmpdir(), "tldl-rescue-"));
    const file = join(dir, "value.json");
    writeFileSync(file, JSON.stringify(value));
    const args = ["wrangler", "kv", "key", "put", key, "--namespace-id", KV_NAMESPACE, "--remote", "--path", file];
    if (ttlSeconds !== undefined) args.push("--ttl", String(ttlSeconds));
    execFileSync("npx", args, { stdio: ["ignore", "ignore", "inherit"], cwd: REPO_ROOT });
}

interface FeedMatch {
    guid: string;
    title: string;
    audioUrl: string;
}

/**
 * Reverse-map an episode ID to its feed entry.
 *
 * Cron-queued IDs are `{podcastId}_rss_{first 10 hex of SHA256(guid)}` (see
 * src/lib/rss-episode-id.ts). A hash can't be reversed, so hash every GUID in the
 * feed and look for the match.
 */
async function findInFeed(rssUrl: string, targetHash: string): Promise<FeedMatch | null> {
    const res = await fetch(rssUrl, { headers: { "User-Agent": FEED_UA } });
    if (!res.ok) throw new Error(`RSS fetch failed: HTTP ${res.status} for ${rssUrl}`);
    const xml = await res.text();

    for (const [, item] of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
        const guid = item.match(/<guid[^>]*>([\s\S]*?)<\/guid>/)?.[1]?.trim();
        if (!guid) continue;
        if (createHash("sha256").update(guid).digest("hex").slice(0, 10) !== targetHash) continue;

        const rawTitle = item.match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? "(unknown title)";
        return {
            guid,
            title: rawTitle.replace(/<!\[CDATA\[|\]\]>/g, "").trim(),
            audioUrl: item.match(/<enclosure[^>]*url="([^"]+)"/)?.[1] ?? "",
        };
    }
    return null;
}

interface MonitoredPodcast {
    id: string;
    name: string;
    rssUrl: string;
    etag?: string;
    lastModified?: string;
    [key: string]: unknown;
}

async function rescue(episodeId: string, apiKey: string, args: Args): Promise<boolean> {
    console.log(`\n=== ${episodeId} ===`);

    const [podcastId, targetHash] = episodeId.split("_rss_");
    if (!podcastId || !targetHash) {
        console.error(
            `  SKIP: not a cron-queued ID. Only {podcastId}_rss_{hash} IDs can be reverse-mapped;\n` +
            `        for a manually submitted episode pass --audio-url explicitly.`
        );
        return false;
    }

    const podcast = kvGetJson<MonitoredPodcast>(`monitored:${podcastId}`);
    if (!podcast) {
        console.error(`  SKIP: monitored:${podcastId} not found in KV — is this podcast still monitored?`);
        return false;
    }
    console.log(`  podcast: ${podcast.name}`);

    let audioUrl = args.audioUrl;
    let guid: string | undefined;

    const match = await findInFeed(podcast.rssUrl, targetHash);
    if (match) {
        guid = match.guid;
        console.log(`  title:   ${match.title}`);
        console.log(`  guid:    ${guid}`);
        audioUrl = audioUrl ?? match.audioUrl;
    } else if (audioUrl) {
        console.warn(`  WARN: episode not in the current feed; using --audio-url.`);
        console.warn(`        The GUID can't be cleared, so the cron will NOT requeue it —`);
        console.warn(`        resubmit from /admin/submit after this finishes.`);
    } else {
        console.error(`  SKIP: no feed item hashes to ${targetHash}, and no --audio-url given.`);
        return false;
    }

    if (!audioUrl) {
        console.error(`  SKIP: feed item has no <enclosure url>; pass --audio-url.`);
        return false;
    }

    // Transcribe locally: no 15-minute wall clock, and not the throttled IP.
    const started = Date.now();
    console.log(`  transcribing...`);
    const result = await transcribeAudio(audioUrl, {
        apiKey,
        onProgress: (cur, total) =>
            console.log(`    chunk ${cur}/${total}  (${((Date.now() - started) / 60000).toFixed(1)}m)`),
    });

    const mins = ((Date.now() - started) / 60000).toFixed(1);
    console.log(`  transcribed: ${result.text.length.toLocaleString()} chars, model=${result.model}, ${mins}m`);

    // A partial transcript still writes a plausible-looking record, and the summary
    // would then be generated from truncated content. Refuse rather than poison KV.
    if (result.partial) {
        console.error(`  ABORT: transcript is PARTIAL (${result.partialReason}). Not writing to KV.`);
        return false;
    }
    console.log(`  tail: ${JSON.stringify(result.text.slice(-90))}`);
    console.log(`        (a complete episode almost always ends on a sign-off — check this looks finished)`);

    const record = {
        episodeId,
        text: result.text,
        source: result.source,
        model: result.model,
        createdAt: new Date().toISOString(),
    };

    if (args.dryRun) {
        const out = join(REPO_ROOT, `transcript-${episodeId}.json`);
        writeFileSync(out, JSON.stringify(record));
        console.log(`  DRY RUN: wrote ${out}, no KV changes.`);
        return true;
    }

    kvPutJson(`transcript:${episodeId}`, record, CONTENT_TTL_SECONDS);
    console.log(`  wrote transcript:${episodeId} to KV`);

    // Clear dedup signal 1: the processed-GUID list. Without this the cron skips
    // the episode entirely.
    if (guid) {
        const processed = kvGetJson<string[]>(`monitored:processed:${podcastId}`) ?? [];
        const filtered = processed.filter((g) => g !== guid);
        if (filtered.length === processed.length) {
            console.log(`  processed list: GUID wasn't present, nothing to remove`);
        } else {
            kvPutJson(`monitored:processed:${podcastId}`, filtered); // no TTL
            console.log(`  processed list: removed GUID (${processed.length} -> ${filtered.length})`);
        }
    }

    // Clear dedup signal 2: the conditional-GET etag. A 304 makes the cron exit
    // early without iterating any episodes, so clearing the GUID alone is not enough.
    if (podcast.etag || podcast.lastModified) {
        const { etag, lastModified, ...rest } = podcast;
        if (!rest.rssUrl || !rest.name) {
            throw new Error(`monitored:${podcastId} looks malformed; refusing to write it back`);
        }
        kvPutJson(`monitored:${podcastId}`, rest); // no TTL — these records must not expire
        console.log(`  monitored record: stripped etag/lastModified`);
    } else {
        console.log(`  monitored record: no etag set, nothing to strip`);
    }

    return true;
}

async function main(): Promise<void> {
    const args = parseArgs(process.argv.slice(2));
    const apiKey = readApiKey();

    let ok = 0;
    for (const id of args.episodeIds) {
        try {
            if (await rescue(id, apiKey, args)) ok++;
        } catch (err) {
            console.error(`  FAILED ${id}:`, err instanceof Error ? err.message : err);
        }
    }

    console.log(`\n${ok}/${args.episodeIds.length} rescued.`);
    if (ok > 0 && !args.dryRun) {
        console.log(
            `The next cron tick (0 */2 * * * UTC) will requeue them; the consumer finds the\n` +
            `transcript and skips straight to summarizing, so each takes <60s. Then verify\n` +
            `episode:{id}, summary:{id}:{templateId}, and membership in episodes:index.`
        );
    }
    if (ok < args.episodeIds.length) process.exitCode = 1;
}

await main();
