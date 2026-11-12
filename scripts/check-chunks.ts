/**
 * Local check for uploads (#53, #48): route the file with the Worker's own
 * routing (`planUploads` and `uploadParts`, which `transcribeAudio` also
 * calls), write each upload exactly as the Worker would send it, decode each
 * one in full with ffmpeg, and optionally send them to OpenAI. An MP3 chunk
 * (or whole-file upload) whose frames run past `--max-seconds` goes up in
 * parts, as in production, and each part is checked as an upload.
 *
 * A file over the 25 MB upload limit is chunked with `--max-mb` per chunk
 * (default 15). A file under it is routed as production routes it: chunked
 * only when its audio runs past `--max-seconds`, otherwise one whole-file
 * upload (bare frames for MP3, the file unchanged for MP4 and anything the
 * planner can't plan, M4A for ADTS). `--max-mb` never splits a small file.
 *
 *   npm run check:chunks -- <url-or-path> [--max-mb 15] [--max-seconds 900] [--limit N] [--transcribe]
 *
 * Covers every container the planner handles: MP3 (bare MPEG frames), MP4/M4A
 * and ADTS (rewritten as M4A), and anything else, such as OGG or WAV (byte
 * ranges, with the file's first 512 bytes prepended after chunk 1).
 *
 * Each upload must decode with no ffmpeg errors. Where the planner caps
 * duration (MP3, MP4, ADTS), the duration ffmpeg decodes must be at most
 * `--max-seconds` + 5: decoded in full, not ffprobe's estimate, which MP3
 * takes from the first frame's bitrate and can be far too low. The byte path
 * is capped by bytes only, so its duration is printed but not checked. MP4 chunks must hold as many audio packets as
 * the plan put non-empty samples in them. MP3 chunks must start on a frame
 * that parses and is not a Xing/Info/VBRI frame, which would declare the whole
 * file's duration.
 *
 * Uploads land in scripts/chunk-check-results/<name>/ (gitignored).
 * `--transcribe` sends each upload with the filename and MIME type the Worker
 * would send (from the upload's magic bytes, then the source's content type),
 * using the production model with no fallback, and reads OPENAI_API_KEY from
 * .dev.vars.
 * Exits non-zero on any failed check or any non-200.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync, readSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { CONTAINER_PROBE_BYTES, MAX_CHUNK_SECONDS, TARGET_CHUNK_SIZE_BYTES, hexBytes } from "../src/lib/audio";
import { AUDIO_USER_AGENT } from "../src/lib/constants";
import { findMp3Frame, parseMp3FrameHeader, readVbrHeader } from "../src/lib/mp3";
import { parseAudioTrack, type Mp4AudioTrack } from "../src/lib/mp4";
import { locateMoov, type FetchRange } from "../src/services/audio-containers";
import { isMp3FramePlan, type ChunkPlan, type PlannedChunk } from "../src/services/chunk-planning";
import {
    detectAudioFormat,
    getProviderConfig,
    mimeFromExtension,
    planUploads,
    uploadLimits,
    uploadParts,
} from "../src/services/transcription";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..");
const OUT_DIR = join(HERE, "chunk-check-results");

/** Slack on the duration cap: frame and sample boundaries round a chunk up a little. */
const DURATION_SLACK_SECONDS = 5;

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

/** Production's content type for audio served without one; a local file has none either. */
const UNKNOWN_CONTENT_TYPE = "unknown";

/** Range reader over a URL (HTTP Range) or a local file. */
async function openSource(source: string): Promise<{ size: number; contentType: string; fetchRange: FetchRange }> {
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
        return { size, contentType: UNKNOWN_CONTENT_TYPE, fetchRange };
    }

    // Resolve redirects once so range requests hit the final host.
    const head = await fetch(source, { method: "HEAD", redirect: "follow", headers: { "User-Agent": AUDIO_USER_AGENT } });
    if (!head.ok) throw new Error(`HEAD failed: HTTP ${head.status}`);
    const url = head.url;
    const size = Number(head.headers.get("content-length"));
    if (!size) throw new Error("No content-length from HEAD");
    const contentType = head.headers.get("content-type") || UNKNOWN_CONTENT_TYPE;
    const fetchRange: FetchRange = async (start, end) => {
        const res = await fetch(url, {
            headers: { "User-Agent": AUDIO_USER_AGENT, Range: `bytes=${start}-${end}` },
        });
        if (res.status !== 206) throw new Error(`Range ${start}-${end}: HTTP ${res.status}`);
        return res.arrayBuffer();
    };
    return { size, contentType, fetchRange };
}

/** Filename extension and MIME type a chunk is uploaded with. */
interface UploadFormat {
    ext: string;
    mime: string;
}

/**
 * The upload's filename extension and MIME type, built as production's
 * `callTranscriptionApi` builds them: from the chunk's magic bytes, then the
 * source's content type, then MP3.
 */
function uploadFormat(bytes: Uint8Array, contentType: string): UploadFormat {
    const ext = detectAudioFormat(bytes.slice().buffer, contentType);
    return { ext, mime: mimeFromExtension(ext) };
}

/**
 * Where a source's chunks go: its file name as a slug, always a strict child
 * of OUT_DIR, because the folder is deleted before each run. Leading dots are
 * stripped, so names like `..mp3` can't resolve to OUT_DIR or its parent.
 */
function resultsDir(source: string): string {
    // A URL's query (Substack signs its CDN URLs) and fragment are not part of the name.
    const sourcePath = /^https?:\/\//.test(source) ? new URL(source).pathname : source;
    const slug = basename(sourcePath, extname(sourcePath))
        .replace(/[^A-Za-z0-9._-]+/g, "_")
        .replace(/^\.+/, "");
    const dir = resolve(OUT_DIR, slug || "audio");
    if (!dir.startsWith(resolve(OUT_DIR) + sep)) throw new Error(`Refusing to use results folder outside ${OUT_DIR}: ${dir}`);
    return dir;
}

interface Decode {
    /** ffmpeg's errors; empty when the decode was clean. */
    errors: string;
    /** Seconds of audio ffmpeg decoded, or null when it reported none. */
    seconds: number | null;
}

/** Decode the whole file, discarding the audio; report ffmpeg's errors and how much audio it decoded. */
function ffmpegDecode(path: string): Decode {
    const result = spawnSync(
        "ffmpeg",
        ["-nostdin", "-v", "error", "-i", path, "-f", "null", "-", "-progress", "pipe:1", "-nostats"],
        { encoding: "utf8" },
    );
    if (result.error) throw result.error;
    const stderr = result.stderr.trim();
    const errors = result.status === 0 ? stderr : stderr || `ffmpeg exited with status ${result.status}`;
    // -progress writes key=value blocks to stdout; the last out_time_us is where decoding ended.
    const times = [...result.stdout.matchAll(/^out_time_us=(\d+)$/gm)];
    const seconds = times.length > 0 ? Number(times[times.length - 1][1]) / 1e6 : null;
    return { errors, seconds };
}

/** One ffprobe value as a number, or null when ffprobe fails or reports none. */
function ffprobeNumber(path: string, args: string[]): number | null {
    try {
        const out = execFileSync("ffprobe", ["-v", "error", ...args, "-of", "csv=p=0", path], {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
        }).trim();
        const n = Number(out);
        return out !== "" && Number.isFinite(n) ? n : null;
    } catch {
        return null;
    }
}

/** Audio packets ffprobe reads from the first audio stream. */
function ffprobePacketCount(path: string): number | null {
    return ffprobeNumber(path, ["-select_streams", "a:0", "-count_packets", "-show_entries", "stream=nb_read_packets"]);
}

/**
 * A reason the MP3 chunk would not start where production means it to, or
 * null when its first frame parses and is plain audio.
 */
function mp3FirstFrameProblem(bytes: Uint8Array): string | null {
    const header = parseMp3FrameHeader(bytes, 0);
    if (!header) return `does not start on an MP3 frame (first bytes ${hexBytes(bytes.subarray(0, 8))})`;
    const vbr = readVbrHeader(bytes, 0, header);
    return vbr ? `first frame is a ${vbr.kind} header` : null;
}

/**
 * Bytes at the end of an MP3 chunk that belong to a frame cut short, or 0
 * when the chunk ends on a frame boundary or its frames can't be walked to
 * the end. Chunk ranges end on a byte count, not a frame boundary, so a
 * chunk before the last usually ends mid-frame; the next chunk's overlap
 * holds that frame whole.
 */
function mp3TruncatedTailBytes(bytes: Uint8Array): number {
    let offset = 0;
    while (offset < bytes.length) {
        const header = parseMp3FrameHeader(bytes, offset);
        if (!header) {
            // Not a frame (junk between stitched pieces): resync at the next confirmed one.
            offset = findMp3Frame(bytes, offset + 1);
            if (offset === -1) return 0;
            continue;
        }
        if (offset + header.frameLength > bytes.length) return bytes.length - offset;
        offset += header.frameLength;
    }
    return 0;
}

/**
 * ffmpeg's decode errors for an MP3 chunk, forgiving a final frame cut short:
 * ffmpeg reports one (often "invalid new backstep -1"), and gpt-transcribe
 * accepts it (spike variant B, 2026-11-12). The errors are forgiven only when
 * the chunk decodes clean without that frame, so an error anywhere else
 * still fails.
 */
function mp3Decode(path: string, bytes: Uint8Array): Decode & { truncatedTailBytes: number } {
    const decode = ffmpegDecode(path);
    const tail = decode.errors === "" ? 0 : mp3TruncatedTailBytes(bytes);
    if (tail === 0) return { ...decode, truncatedTailBytes: 0 };
    const trimmedPath = `${path}.trimmed.mp3`;
    writeFileSync(trimmedPath, bytes.subarray(0, bytes.length - tail));
    try {
        return ffmpegDecode(trimmedPath).errors === ""
            ? { ...decode, errors: "", truncatedTailBytes: tail }
            : { ...decode, truncatedTailBytes: 0 };
    } finally {
        unlinkSync(trimmedPath);
    }
}

/** Samples in an MP4 chunk that carry a packet (empty samples carry none). */
function plannedPackets(track: Mp4AudioTrack, chunk: PlannedChunk): number {
    const { firstSample, endSample } = chunk.logFields as { firstSample: number; endSample: number };
    let packets = 0;
    for (let s = firstSample; s < endSample; s++) if (track.sizes[s] > 0) packets++;
    return packets;
}

function describeAudio(plan: ChunkPlan | null): string {
    if (!plan) return "the planner couldn't plan the file (uploaded whole, as production does)";
    const fields = Object.entries(plan.audio).map(([key, value]) =>
        typeof value === "number" && !Number.isInteger(value) ? `${key} ${value.toFixed(1)}` : `${key} ${value}`,
    );
    return fields.length > 0 ? fields.join(", ") : "nothing parsed (byte path)";
}

async function transcribe(path: string, format: UploadFormat, apiKey: string): Promise<{ status: number; body: string }> {
    const config = getProviderConfig();
    const form = new FormData();
    form.append("file", new Blob([readFileSync(path)], { type: format.mime }), `audio.${format.ext}`);
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

    const outDir = resultsDir(args.source);
    console.log(`output: ${outDir}`);
    const { size, contentType, fetchRange } = await openSource(args.source);
    const route = await planUploads(
        {
            size,
            contentType,
            audioHost: /^https?:\/\//.test(args.source) ? new URL(args.source).hostname : "local file",
            fetchRange,
            fetchWhole: () => fetchRange(0, size - 1),
        },
        // --max-mb is the per-chunk cap for files over the upload limit only, as
        // production's 15 MB is. Whole bytes: a fractional value would plan fractional offsets.
        uploadLimits({ maxBytes: Math.floor(args.maxMb * 1024 * 1024), maxSeconds: args.maxSeconds }),
    );
    const plan = route.plan;
    const container = route.kind === "whole" ? route.container : route.plan.container;
    // What the Worker sends: each planned chunk's uploads, or the whole file's.
    const sources: { label: string; name: string; chunk?: PlannedChunk; load(): Promise<ArrayBuffer[]> }[] =
        route.kind === "chunked"
            ? route.plan.chunks.map((chunk) => ({
                  label: `chunk ${chunk.index + 1}/${route.plan.chunks.length}`,
                  name: `chunk-${String(chunk.index + 1).padStart(2, "0")}`,
                  chunk,
                  load: async () => uploadParts(await chunk.load(), route.plan, chunk, args.maxSeconds),
              }))
            : [{ label: "whole-file upload", name: "whole", chunk: route.plan?.chunks[0], load: async () => route.uploads }];
    const count = Math.min(sources.length, args.limit);
    /** The uploads of the first `count` sources, in order; a split source's parts are labelled. */
    async function* uploads() {
        for (const source of sources.slice(0, count)) {
            const parts = await source.load();
            for (const [i, part] of parts.entries()) {
                const split = parts.length > 1;
                yield {
                    label: split ? `${source.label} part ${i + 1}/${parts.length}` : source.label,
                    name: split ? `${source.name}-part-${i + 1}` : source.name,
                    chunk: source.chunk,
                    bytes: new Uint8Array(part),
                };
            }
        }
    }
    console.log(
        `\nfile: ${size} bytes, content type ${contentType}, container ${container}, ` +
        (route.kind === "chunked"
            ? `${route.plan.totalBytes} audio bytes, ${route.plan.chunks.length} chunks`
            : "uploaded whole (under the upload limit, and the planner's duration estimate is under the cap)"),
    );
    console.log(`audio: ${describeAudio(plan)}`);

    // MP3 whose frames can't be parsed falls back to the byte path.
    const mp3Frames = isMp3FramePlan(plan);
    if (container === "mp3" && !mp3Frames) console.log("mp3: frames not found, byte path; frame checks skipped");
    // The plan keeps only sample ranges; the sizes say which samples carry a packet.
    const probe = new Uint8Array(await fetchRange(0, Math.min(CONTAINER_PROBE_BYTES, size) - 1));
    const track = plan?.container === "mp4" ? parseAudioTrack((await locateMoov(probe, size, fetchRange)).moov) : null;

    rmSync(outDir, { recursive: true, force: true });
    mkdirSync(outDir, { recursive: true });
    console.log("");

    let failed = false;
    let uploadCount = 0;
    for await (const { label, name, chunk, bytes } of uploads()) {
        uploadCount++;
        const format = uploadFormat(bytes, contentType);
        const path = join(outDir, `${name}.${format.ext}`);
        writeFileSync(path, bytes);

        const problems: string[] = [];
        const notes: string[] = [`${(bytes.length / 1024 / 1024).toFixed(2)} MB`, `audio.${format.ext} ${format.mime}`];

        const decode = mp3Frames ? mp3Decode(path, bytes) : { ...ffmpegDecode(path), truncatedTailBytes: 0 };
        if (chunk?.plannedSeconds !== undefined) notes.push(`planned ${chunk.plannedSeconds.toFixed(1)}s`);
        notes.push(`decoded ${decode.seconds === null ? "no duration" : `${decode.seconds.toFixed(1)}s`}`);
        if (chunk?.plannedSeconds !== undefined) {
            const cap = args.maxSeconds + DURATION_SLACK_SECONDS;
            if (decode.seconds === null) problems.push("ffmpeg decoded no audio");
            else if (decode.seconds > cap) problems.push(`decoded duration ${decode.seconds.toFixed(1)}s is over ${cap}s`);
        }

        if (track && chunk) {
            const planned = plannedPackets(track, chunk);
            const packets = ffprobePacketCount(path);
            notes.push(`packets ${packets ?? "?"}/${planned}`);
            if (packets !== planned) problems.push(`ffprobe read ${packets ?? "no"} packets, plan has ${planned}`);
        }

        if (mp3Frames) {
            const problem = mp3FirstFrameProblem(bytes);
            notes.push(problem === null ? "first frame audio" : "first frame BAD");
            if (problem) problems.push(problem);
        }

        const decodeErrors = decode.errors;
        notes.push(
            decodeErrors !== ""
                ? "decode ERRORS"
                : decode.truncatedTailBytes > 0
                  ? `decode clean but the final frame (cut short, ${decode.truncatedTailBytes} bytes)`
                  : "decode clean",
        );
        if (decodeErrors) problems.push(`ffmpeg: ${decodeErrors.split("\n").slice(0, 5).join(" | ")}`);

        console.log(`${label}: ${notes.join(", ")} ${problems.length === 0 ? "OK" : "FAIL"}`);
        for (const problem of problems) console.log(`  ${problem}`);
        if (problems.length > 0) failed = true;

        if (args.transcribe) {
            const { status, body } = await transcribe(path, format, apiKey);
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

    const checked = `${uploadCount} uploads from ${count} of ${sources.length} ${route.kind === "chunked" ? "chunks" : "files"}`;
    console.log(`\n${failed ? "FAILED" : "all checks passed"} (${checked} checked)`);
    if (failed) process.exitCode = 1;
}

await main();
