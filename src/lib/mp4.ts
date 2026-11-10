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
