/**
 * Minimal MP4 (ISO BMFF) reader and box builders.
 *
 * Reads the sample table of the first audio track in a `moov` box so audio can
 * be split on sample boundaries instead of raw byte ranges. Only progressive
 * (non-fragmented) AAC files are supported; anything else throws
 * AppError(AUDIO_UNSUPPORTED).
 */

import { ERROR_CODES } from "./constants";
import { AppError } from "./errors";

export interface BoxHeader {
    type: string;
    /** Absolute offset of the box in the file. */
    offset: number;
    /** Full box size including the header; `size == 0` is resolved to `fileSize - offset`. */
    size: number;
    headerSize: number;
}

export interface Mp4AudioTrack {
    /** Sample entry fourcc (always "mp4a" for supported files). */
    codec: string;
    timescale: number;
    /** Packed ISO-639-2/T language code from `mdhd`. */
    language: number;
    /** The complete `stsd` box, header included, for reuse by a writer. */
    stsd: Uint8Array;
    sampleCount: number;
    /** Absolute file offset of each sample (a number: co64 offsets exceed 2^32). */
    offsets: Float64Array;
    sizes: Uint32Array;
    /** Duration of each sample in timescale units. */
    durations: Uint32Array;
    totalPayloadBytes: number;
    durationSeconds: number;
}

const TWO_POW_32 = 2 ** 32;
const textDecoder = new TextDecoder("latin1");

function unsupported(detail: string): AppError {
    return new AppError(ERROR_CODES.AUDIO_UNSUPPORTED, `Unsupported MP4: ${detail}`);
}

function malformed(box: string): AppError {
    return unsupported(`malformed ${box}`);
}

function view(bytes: Uint8Array): DataView {
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function fourcc(bytes: Uint8Array, at: number): string {
    return textDecoder.decode(bytes.subarray(at, at + 4));
}

/** Read a big-endian unsigned 64-bit value as a number (exact below 2^53). */
function readU64(dv: DataView, at: number): number {
    return dv.getUint32(at) * TWO_POW_32 + dv.getUint32(at + 4);
}

/**
 * Read a box header at `at`. `baseOffset` is the file offset of `bytes[0]`, so
 * the returned `offset` is absolute even when `bytes` is a range of the file.
 * Returns null when too few bytes are available or the size is impossible.
 */
export function readBoxHeader(
    bytes: Uint8Array,
    at: number,
    fileSize: number,
    baseOffset = 0,
): BoxHeader | null {
    if (at < 0 || bytes.length - at < 8) return null;
    const dv = view(bytes);
    const size32 = dv.getUint32(at);
    const type = fourcc(bytes, at + 4);
    const offset = baseOffset + at;

    let headerSize = 8;
    let size = size32;
    if (size32 === 1) {
        if (bytes.length - at < 16) return null;
        headerSize = 16;
        size = readU64(dv, at + 8);
    } else if (size32 === 0) {
        size = fileSize - offset;
    }
    if (size < headerSize) return null;
    return { type, offset, size, headerSize };
}

/** Iterate the direct children of a box (header included in `container`). */
function* children(container: Uint8Array): Generator<{ header: BoxHeader; box: Uint8Array }> {
    const parent = readBoxHeader(container, 0, container.length);
    if (!parent) throw malformed("box");
    const end = Math.min(parent.size, container.length);
    let at = parent.headerSize;
    while (at < end) {
        const header = readBoxHeader(container.subarray(0, end), at, end);
        if (!header || at + header.size > end) throw malformed(header?.type ?? "box");
        yield { header, box: container.subarray(at, at + header.size) };
        at += header.size;
    }
}

/**
 * Find a nested box by path (e.g. `["trak", "mdia", "hdlr"]`). `container` is
 * a box including its header; the path names successive children. Returns the
 * first match including its header, or null.
 */
export function findChild(container: Uint8Array, path: string[]): Uint8Array | null {
    let current = container;
    for (const name of path) {
        let next: Uint8Array | null = null;
        for (const { header, box } of children(current)) {
            if (header.type === name) {
                next = box;
                break;
            }
        }
        if (!next) return null;
        current = next;
    }
    return current;
}

/** Payload of a box (everything after its header). */
function payload(box: Uint8Array): Uint8Array {
    const header = readBoxHeader(box, 0, box.length);
    if (!header) throw malformed("box");
    return box.subarray(header.headerSize, Math.min(header.size, box.length));
}

/**
 * Parse the first `soun` track's sample table from a `moov` box (header
 * included) into flat per-sample offset, size and duration arrays.
 */
export function parseAudioTrack(moov: Uint8Array): Mp4AudioTrack {
    if (findChild(moov, ["mvex"])) throw unsupported("fragmented file");

    let trak: Uint8Array | null = null;
    for (const { header, box } of children(moov)) {
        if (header.type !== "trak") continue;
        const hdlr = findChild(box, ["mdia", "hdlr"]);
        if (!hdlr) continue;
        const p = payload(hdlr);
        if (p.length >= 12 && fourcc(p, 8) === "soun") {
            trak = box;
            break;
        }
    }
    if (!trak) throw unsupported("no audio track");

    const mdhd = findChild(trak, ["mdia", "mdhd"]);
    const stsdBox = findChild(trak, ["mdia", "minf", "stbl", "stsd"]);
    if (!mdhd) throw malformed("mdhd");
    if (!stsdBox) throw malformed("stsd");

    // mdhd: timescale and language
    const md = payload(mdhd);
    const mdv = view(md);
    let timescale: number;
    let language: number;
    if (md[0] === 1) {
        if (md.length < 36) throw malformed("mdhd");
        timescale = mdv.getUint32(20);
        language = mdv.getUint16(32);
    } else {
        if (md.length < 24) throw malformed("mdhd");
        timescale = mdv.getUint32(12);
        language = mdv.getUint16(20);
    }
    if (timescale === 0) throw malformed("mdhd");

    // stsd: the first sample entry names the codec
    const sd = payload(stsdBox);
    if (sd.length < 16) throw malformed("stsd");
    const codec = fourcc(sd, 12);
    if (codec !== "mp4a") {
        throw unsupported(`audio codec '${codec}' (only AAC is supported)`);
    }

    const stbl = findChild(trak, ["mdia", "minf", "stbl"]);
    if (!stbl) throw malformed("stbl");
    const stsz = findChild(stbl, ["stsz"]);
    const stsc = findChild(stbl, ["stsc"]);
    const stts = findChild(stbl, ["stts"]);
    const stco = findChild(stbl, ["stco"]);
    const co64 = findChild(stbl, ["co64"]);
    if (!stsz) throw malformed("stsz");
    if (!stsc) throw malformed("stsc");
    if (!stts) throw malformed("stts");
    if (!stco && !co64) throw malformed("stco");

    // stsz: sample sizes
    const sz = payload(stsz);
    if (sz.length < 12) throw malformed("stsz");
    const szv = view(sz);
    const uniformSize = szv.getUint32(4);
    const sampleCount = szv.getUint32(8);
    if (uniformSize === 0 && sz.length < 12 + sampleCount * 4) throw malformed("stsz");
    // A uniform size carries no table, so cap the count to avoid a huge allocation.
    if (uniformSize !== 0 && sampleCount > 0xffffff) throw malformed("stsz");
    const sizes = new Uint32Array(sampleCount);
    for (let i = 0; i < sampleCount; i++) {
        sizes[i] = uniformSize !== 0 ? uniformSize : szv.getUint32(12 + i * 4);
    }

    // stts: per-sample durations
    const tt = payload(stts);
    if (tt.length < 8) throw malformed("stts");
    const ttv = view(tt);
    const sttsEntries = ttv.getUint32(4);
    if (tt.length < 8 + sttsEntries * 8) throw malformed("stts");
    const durations = new Uint32Array(sampleCount);
    let d = 0;
    for (let i = 0; i < sttsEntries; i++) {
        const count = ttv.getUint32(8 + i * 8);
        const delta = ttv.getUint32(12 + i * 8);
        if (d + count > sampleCount) throw malformed("stts");
        durations.fill(delta, d, d + count);
        d += count;
    }
    if (d !== sampleCount) throw malformed("stts");

    // Chunk offsets (stco 32-bit or co64 64-bit)
    const chunkBox = co64 ?? stco!;
    const wide = co64 !== null;
    const cp = payload(chunkBox);
    if (cp.length < 8) throw malformed(wide ? "co64" : "stco");
    const cpv = view(cp);
    const chunkCount = cpv.getUint32(4);
    const entrySize = wide ? 8 : 4;
    if (cp.length < 8 + chunkCount * entrySize) throw malformed(wide ? "co64" : "stco");
    const chunkOffset = (i: number): number =>
        wide ? readU64(cpv, 8 + i * 8) : cpv.getUint32(8 + i * 4);

    // stsc: runs of (first_chunk, samples_per_chunk)
    const sc = payload(stsc);
    if (sc.length < 8) throw malformed("stsc");
    const scv = view(sc);
    const runCount = scv.getUint32(4);
    if (runCount === 0 || sc.length < 8 + runCount * 12) throw malformed("stsc");

    const offsets = new Float64Array(sampleCount);
    let sample = 0;
    for (let r = 0; r < runCount; r++) {
        const firstChunk = scv.getUint32(8 + r * 12);
        const perChunk = scv.getUint32(12 + r * 12);
        const nextFirst = r + 1 < runCount ? scv.getUint32(8 + (r + 1) * 12) : chunkCount + 1;
        if (firstChunk < 1 || nextFirst <= firstChunk || nextFirst > chunkCount + 1) {
            throw malformed("stsc");
        }
        if (r === 0 && firstChunk !== 1) throw malformed("stsc");
        for (let chunk = firstChunk; chunk < nextFirst; chunk++) {
            let offset = chunkOffset(chunk - 1);
            for (let k = 0; k < perChunk; k++) {
                if (sample >= sampleCount) throw malformed("stsc");
                offsets[sample] = offset;
                offset += sizes[sample];
                sample++;
            }
        }
    }
    if (sample !== sampleCount) throw malformed("stsc");

    let totalPayloadBytes = 0;
    let totalDuration = 0;
    for (let i = 0; i < sampleCount; i++) {
        totalPayloadBytes += sizes[i];
        totalDuration += durations[i];
    }

    return {
        codec,
        timescale,
        language,
        stsd: stsdBox,
        sampleCount,
        offsets,
        sizes,
        durations,
        totalPayloadBytes,
        durationSeconds: totalDuration / timescale,
    };
}

// ============================================================================
// Box builders (used by the M4A writer and by tests)
// ============================================================================

/** Build a box: 32-bit size, fourcc type, then the concatenated parts. */
export function box(type: string, ...parts: Uint8Array[]): Uint8Array {
    const body = parts.reduce((n, p) => n + p.length, 0);
    const out = new Uint8Array(8 + body);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, 8 + body);
    for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
    let at = 8;
    for (const p of parts) {
        out.set(p, at);
        at += p.length;
    }
    return out;
}

/** Build a full box: a box whose payload starts with a version byte and 24-bit flags. */
export function fullBox(
    type: string,
    version: number,
    flags: number,
    ...parts: Uint8Array[]
): Uint8Array {
    const head = new Uint8Array([version, (flags >> 16) & 0xff, (flags >> 8) & 0xff, flags & 0xff]);
    return box(type, head, ...parts);
}

// ============================================================================
// Chunk planning
// ============================================================================

export interface SampleChunk {
    firstSample: number;
    /** Exclusive. */
    endSample: number;
    /** Leading samples shared with the previous chunk. */
    overlapSamples: number;
    /** Bytes of every sample in the chunk, overlap included. */
    payloadBytes: number;
    /** Bytes of the samples that are not overlap. */
    newPayloadBytes: number;
    startSeconds: number;
    endSeconds: number;
    isFirst: boolean;
    isLast: boolean;
}

export interface ChunkLimits {
    maxBytes: number;
    maxSeconds: number;
    overlapSeconds: number;
}

/**
 * Split a sample table into chunks that each stay within `maxBytes` and
 * `maxSeconds` (overlap included). Every chunk after the first starts about
 * `overlapSeconds` before the previous one ended. Every chunk holds at least
 * one sample that is not overlap, even if a single sample exceeds the limits.
 */
export function planSampleChunks(
    track: Pick<Mp4AudioTrack, "sizes" | "durations" | "timescale">,
    limits: ChunkLimits,
): SampleChunk[] {
    const { sizes, durations, timescale } = track;
    const n = sizes.length;
    if (n === 0) return [];

    // Prefix sums so chunk times and overlap are cheap to compute.
    const startTicks = new Float64Array(n + 1);
    for (let i = 0; i < n; i++) startTicks[i + 1] = startTicks[i] + durations[i];

    const maxTicks = limits.maxSeconds * timescale;
    const overlapTicks = limits.overlapSeconds * timescale;
    const chunks: SampleChunk[] = [];

    let first = 0;
    let overlap = 0;
    while (true) {
        let end = first;
        let bytes = 0;
        while (end < n) {
            const mustTake = end < first + overlap + 1;
            const fits =
                bytes + sizes[end] <= limits.maxBytes &&
                startTicks[end + 1] - startTicks[first] <= maxTicks;
            if (!mustTake && !fits) break;
            bytes += sizes[end];
            end++;
        }

        let overlapBytes = 0;
        for (let i = first; i < first + overlap; i++) overlapBytes += sizes[i];
        const isLast = end >= n;
        chunks.push({
            firstSample: first,
            endSample: end,
            overlapSamples: overlap,
            payloadBytes: bytes,
            newPayloadBytes: bytes - overlapBytes,
            startSeconds: startTicks[first] / timescale,
            endSeconds: startTicks[end] / timescale,
            isFirst: chunks.length === 0,
            isLast,
        });
        if (isLast) return chunks;

        // Smallest run of trailing samples covering the overlap time, leaving
        // at least one sample so the next chunk starts after this one's start.
        let next = end;
        while (next > first + 1 && startTicks[end] - startTicks[next] < overlapTicks) next--;
        overlap = end - next;
        first = next;
    }
}

export interface ByteRun {
    start: number;
    /** Inclusive. */
    end: number;
}

/**
 * Merge samples `[first, end)` into byte ranges for fetching. Consecutive
 * samples whose gap is at most `maxGap` bytes share a run; a sample that
 * starts before the previous one ended begins a new run.
 */
export function coalesceRuns(
    offsets: ArrayLike<number>,
    sizes: ArrayLike<number>,
    first: number,
    end: number,
    maxGap: number,
): ByteRun[] {
    const runs: ByteRun[] = [];
    let current: ByteRun | null = null;
    for (let i = first; i < end; i++) {
        if (sizes[i] === 0) continue;
        const start = offsets[i];
        const last = start + sizes[i] - 1;
        const gap = current ? start - (current.end + 1) : 0;
        if (current && gap >= 0 && gap <= maxGap) {
            current.end = Math.max(current.end, last);
        } else {
            current = { start, end: last };
            runs.push(current);
        }
    }
    return runs;
}

// ============================================================================
// M4A writer
// ============================================================================

/** Big-endian 32-bit values from an array (no spread, so long sample tables are safe). */
function u32Array(values: ArrayLike<number>): Uint8Array {
    const out = new Uint8Array(values.length * 4);
    const dv = new DataView(out.buffer);
    for (let i = 0; i < values.length; i++) dv.setUint32(i * 4, values[i]);
    return out;
}
/** Big-endian 32-bit values, for box payloads. */
export const u32 = (...values: number[]): Uint8Array => u32Array(values);
/** Big-endian 16-bit values, for box payloads. */
export const u16 = (...values: number[]): Uint8Array => {
    const out = new Uint8Array(values.length * 2);
    const dv = new DataView(out.buffer);
    values.forEach((v, i) => dv.setUint16(i * 2, v));
    return out;
};
const zeros = (n: number): Uint8Array => new Uint8Array(n);
const ascii = (s: string): Uint8Array => Uint8Array.from(s, (c) => c.charCodeAt(0));

/** 3x3 unity transformation matrix used by `mvhd` and `tkhd`. */
const UNITY_MATRIX = u32(0x10000, 0, 0, 0, 0x10000, 0, 0, 0, 0x40000000);

export interface M4aInput {
    /** The source track's complete `stsd` box, copied verbatim. */
    stsd: Uint8Array;
    timescale: number;
    /** Packed ISO-639-2/T language code. */
    language: number;
    sizes: ArrayLike<number>;
    durations: ArrayLike<number>;
    /** The samples' bytes, concatenated in order. */
    payload: Uint8Array;
}

/**
 * Write a self-contained, progressive M4A (ftyp, moov, mdat) holding one audio
 * track made of the given samples. `moov` precedes `mdat` so the single `stco`
 * entry can be computed once `moov` is sized.
 */
export function writeM4a(input: M4aInput): Uint8Array {
    const { stsd, timescale, language, sizes, durations, payload } = input;
    const count = sizes.length;

    let duration = 0;
    for (let i = 0; i < count; i++) duration += durations[i];

    // stts: run-length encode the durations
    const runs: number[] = [];
    for (let i = 0; i < count; i++) {
        if (runs.length && runs[runs.length - 1] === durations[i]) {
            runs[runs.length - 2]++;
        } else {
            runs.push(1, durations[i]);
        }
    }

    const ftyp = box("ftyp", ascii("M4A "), u32(0), ascii("M4A "), ascii("mp42"), ascii("isom"));

    const buildMoov = (mdatPayloadOffset: number): Uint8Array => {
        const mvhd = fullBox(
            "mvhd",
            0,
            0,
            u32(0, 0, timescale, duration, 0x10000),
            u16(0x0100),
            zeros(10),
            UNITY_MATRIX,
            zeros(24),
            u32(2),
        );
        const tkhd = fullBox(
            "tkhd",
            0,
            0x7,
            u32(0, 0, 1, 0, duration),
            zeros(8),
            u16(0, 0, 0x0100, 0),
            UNITY_MATRIX,
            u32(0, 0),
        );
        const mdhd = fullBox("mdhd", 0, 0, u32(0, 0, timescale, duration), u16(language, 0));
        const hdlr = fullBox("hdlr", 0, 0, u32(0), ascii("soun"), zeros(12), ascii("SoundHandler\0"));
        const smhd = fullBox("smhd", 0, 0, u16(0, 0));
        const dinf = box("dinf", fullBox("dref", 0, 0, u32(1), fullBox("url ", 0, 1)));
        const stts = fullBox("stts", 0, 0, u32(runs.length / 2), u32Array(runs));
        const stsc = fullBox("stsc", 0, 0, u32(1, 1, count, 1));
        const stsz = fullBox("stsz", 0, 0, u32(0, count), u32Array(sizes));
        const stco = fullBox("stco", 0, 0, u32(1, mdatPayloadOffset));
        const stbl = box("stbl", stsd, stts, stsc, stsz, stco);
        const minf = box("minf", smhd, dinf, stbl);
        const mdia = box("mdia", mdhd, hdlr, minf);
        return box("moov", mvhd, box("trak", tkhd, mdia));
    };

    // moov's size does not depend on the stco value, so size it with a placeholder.
    const moovSize = buildMoov(0).length;
    const moov = buildMoov(ftyp.length + moovSize + 8);
    return concat([ftyp, moov, box("mdat", payload)]);
}

function concat(parts: Uint8Array[]): Uint8Array {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of parts) {
        out.set(p, at);
        at += p.length;
    }
    return out;
}
