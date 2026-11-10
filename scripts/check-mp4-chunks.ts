/**
 * Local check for MP4/M4A chunking (#53): plan chunks from the sample table,
 * write them as standalone M4A files, decode each one in full with ffmpeg,
 * and optionally send them to OpenAI.
 *
 *   npm run check:chunks -- <url-or-path> [--max-mb 15] [--max-seconds 900] [--limit N] [--transcribe]
 *
 * MP4/M4A only: any other container (ADTS, MP3) exits with an error naming it.
 *
 * Each chunk must decode with no ffmpeg errors, and ffprobe must count as
 * many audio packets as the plan put samples in it. Chunks land in
 * scripts/chunk-check-results/ (gitignored). `--transcribe` uses the
 * production model with no fallback and reads OPENAI_API_KEY from .dev.vars.
 * Exits non-zero on a decode error, a packet-count mismatch or any non-200.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync, readSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
    CHUNK_OVERLAP_SECONDS,
    CONTAINER_PROBE_BYTES,
    MAX_CHUNK_SECONDS,
    TARGET_CHUNK_SIZE_BYTES,
} from "../src/lib/audio";
import { AUDIO_USER_AGENT } from "../src/lib/constants";
import { parseAudioTrack, planSampleChunks } from "../src/lib/mp4";
import { loadMp4Chunk, locateMoov, type FetchRange } from "../src/services/audio-containers";
import { detectContainer } from "../src/services/chunk-planning";
import { getProviderConfig } from "../src/services/transcription";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..");
const OUT_DIR = join(HERE, "chunk-check-results");

interface Args {
    source: string;
    maxMb: number;
    maxSeconds: number;
    limit: number;
    transcribe: boolean;
}

function parseArgs(argv: string[]): Args {
    const out: Args = {
        source: "",
        maxMb: TARGET_CHUNK_SIZE_BYTES / 1024 / 1024,
        maxSeconds: MAX_CHUNK_SECONDS,
        limit: Infinity,
        transcribe: false,
    };
    const num = (flag: string, v: string | undefined): number => {
        const n = Number(v);
        if (!v || !Number.isFinite(n) || n <= 0) throw new Error(`${flag} needs a positive number`);
        return n;
    };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === "--max-mb") out.maxMb = num(a, argv[++i]);
        else if (a === "--max-seconds") out.maxSeconds = num(a, argv[++i]);
        else if (a === "--limit") out.limit = num(a, argv[++i]);
        else if (a === "--transcribe") out.transcribe = true;
        else if (a.startsWith("--")) throw new Error(`Unknown flag: ${a}`);
        else out.source = a;
    }
    if (!out.source) throw new Error("Usage: check:chunks -- <url-or-path> [flags]");
    return out;
}

function readApiKey(): string {
    const vars = readFileSync(join(REPO_ROOT, ".dev.vars"), "utf8");
    const match = vars.match(/^OPENAI_API_KEY\s*=\s*"?([^"\n]+)"?/m);
    if (!match) throw new Error("OPENAI_API_KEY not found in .dev.vars");
    return match[1].trim();
}

/** Range reader over a URL (HTTP Range) or a local file. */
async function openSource(source: string): Promise<{ size: number; fetchRange: FetchRange }> {
    if (!/^https?:\/\//.test(source)) {
        const size = statSync(source).size;
        const fetchRange: FetchRange = async (start, end) => {
            const fd = openSync(source, "r");
            try {
                const buf = Buffer.alloc(end - start + 1);
                const n = readSync(fd, buf, 0, buf.length, start);
                return new Uint8Array(buf.subarray(0, n)).buffer;
            } finally {
                closeSync(fd);
            }
        };
        return { size, fetchRange };
    }

    // Resolve redirects once so range requests hit the final host.
    const head = await fetch(source, { method: "HEAD", redirect: "follow", headers: { "User-Agent": AUDIO_USER_AGENT } });
    if (!head.ok) throw new Error(`HEAD failed: HTTP ${head.status}`);
    const url = head.url;
    const size = Number(head.headers.get("content-length"));
    if (!size) throw new Error("No content-length from HEAD");
    const fetchRange: FetchRange = async (start, end) => {
        const res = await fetch(url, {
            headers: { "User-Agent": AUDIO_USER_AGENT, Range: `bytes=${start}-${end}` },
        });
        if (res.status !== 206) throw new Error(`Range ${start}-${end}: HTTP ${res.status}`);
        return res.arrayBuffer();
    };
    return { size, fetchRange };
}

/** Decode the whole file, discarding the audio; returns ffmpeg's errors (empty when clean). */
function ffmpegDecodeErrors(path: string): string {
    const result = spawnSync("ffmpeg", ["-nostdin", "-v", "error", "-i", path, "-f", "null", "-"], {
        encoding: "utf8",
    });
    if (result.error) throw result.error;
    const errors = result.stderr.trim();
    return result.status === 0 ? errors : errors || `ffmpeg exited with status ${result.status}`;
}

/** Audio packets ffprobe reads from the first audio stream. */
function ffprobePacketCount(path: string): number {
    const out = execFileSync(
        "ffprobe",
        ["-v", "error", "-select_streams", "a:0", "-count_packets", "-show_entries", "stream=nb_read_packets", "-of", "csv=p=0", path],
        { encoding: "utf8" },
    );
    return Number(out.trim());
}

async function transcribe(path: string, apiKey: string): Promise<{ status: number; body: string }> {
    const config = getProviderConfig();
    const form = new FormData();
    form.append("file", new Blob([readFileSync(path)], { type: "audio/mp4" }), "audio.m4a");
    form.append("model", config.model);
    form.append("response_format", "json");
    const res = await fetch(config.baseUrl, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}` },
        body: form,
    });
    return { status: res.status, body: await res.text() };
}

async function main(): Promise<void> {
    const args = parseArgs(process.argv.slice(2));
    const apiKey = args.transcribe ? readApiKey() : "";
    mkdirSync(OUT_DIR, { recursive: true });

    const { size, fetchRange } = await openSource(args.source);
    const probe = new Uint8Array(await fetchRange(0, Math.min(CONTAINER_PROBE_BYTES, size) - 1));
    const container = detectContainer(probe);
    if (container !== "mp4") throw new Error(`Not an MP4/M4A file (detected ${container}); this check is MP4-only`);
    const { moov, layout, moovAtEnd } = await locateMoov(probe, size, fetchRange);
    console.log(`file: ${size} bytes, moovAtEnd=${moovAtEnd}`);
    console.log(`layout: ${layout.map((b) => `${b.type} ${b.size}B@${b.offset}`).join(" | ")}`);

    const track = parseAudioTrack(moov);
    console.log(
        `track: ${track.codec}, ${track.sampleCount} samples, timescale ${track.timescale}, ` +
        `${track.durationSeconds.toFixed(1)}s, ${track.totalPayloadBytes} payload bytes`,
    );

    const chunks = planSampleChunks(track, {
        maxBytes: args.maxMb * 1024 * 1024,
        maxSeconds: args.maxSeconds,
        overlapSeconds: CHUNK_OVERLAP_SECONDS,
    });
    console.log(`plan: ${chunks.length} chunks`);
    chunks.forEach((c, i) =>
        console.log(
            `  ${i + 1}: samples ${c.firstSample}-${c.endSample} (overlap ${c.overlapSamples}) ` +
            `${c.payloadBytes}B ${c.startSeconds.toFixed(2)}-${c.endSeconds.toFixed(2)}s`,
        ),
    );

    const name = basename(args.source.split("?")[0], extname(args.source.split("?")[0])) || "audio";
    let failed = false;
    for (let i = 0; i < Math.min(chunks.length, args.limit); i++) {
        const chunk = chunks[i];
        const bytes = await loadMp4Chunk(track, chunk, fetchRange);
        const path = join(OUT_DIR, `${name}-${String(i + 1).padStart(2, "0")}.m4a`);
        writeFileSync(path, bytes);

        // Empty samples carry no packet.
        let planned = 0;
        for (let s = chunk.firstSample; s < chunk.endSample; s++) if (track.sizes[s] > 0) planned++;
        const packets = ffprobePacketCount(path);
        const decodeErrors = ffmpegDecodeErrors(path);
        const ok = packets === planned && decodeErrors === "";
        if (!ok) failed = true;
        console.log(
            `chunk ${i + 1}: ${bytes.length}B ${(chunk.endSeconds - chunk.startSeconds).toFixed(2)}s ` +
            `planned ${planned} packets, read ${packets}, decode ${decodeErrors === "" ? "clean" : "ERRORS"} ` +
            `${ok ? "OK" : "MISMATCH"}`,
        );
        if (decodeErrors) console.log(`  ffmpeg: ${decodeErrors.split("\n").slice(0, 5).join(" | ")}`);

        if (args.transcribe) {
            const { status, body } = await transcribe(path, apiKey);
            let text = body;
            try {
                text = (JSON.parse(body) as { text?: string }).text ?? body;
            } catch {
                // keep the raw body for error output
            }
            console.log(`  openai ${status}: ${JSON.stringify(status === 200 ? text.slice(0, 120) : body)}`);
            if (status !== 200) failed = true;
        }
    }
    if (failed) process.exitCode = 1;
}

await main();
