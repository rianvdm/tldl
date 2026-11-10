/**
 * Range-fetch glue for MP4/M4A audio: finds `moov` in a remote file and
 * rebuilds a standalone M4A for one chunk of samples.
 *
 * Must not import from `./transcription` (which imports this module).
 */

import { MAX_MOOV_BYTES, RUN_COALESCE_GAP_BYTES } from "../lib/audio";
import { ERROR_CODES } from "../lib/constants";
import { AppError } from "../lib/errors";
import {
    coalesceRuns,
    readBoxHeader,
    writeM4a,
    type BoxHeader,
    type Mp4AudioTrack,
    type SampleChunk,
} from "../lib/mp4";

/** Fetch bytes `[start, end]` (end inclusive, like an HTTP Range header). */
export type FetchRange = (start: number, end: number) => Promise<ArrayBuffer>;

/** Large enough for a 64-bit-size box header. */
const HEADER_READ_BYTES = 16;

function unsupported(detail: string): AppError {
    return new AppError(ERROR_CODES.AUDIO_UNSUPPORTED, `Unsupported MP4: ${detail}`);
}

/**
 * Fetch bytes `[start, end]` and verify the server honored the range exactly,
 * so a server that ignores Range (returning the whole file) fails loudly.
 */
export async function fetchExact(fetchRange: FetchRange, start: number, end: number): Promise<Uint8Array> {
    const body = new Uint8Array(await fetchRange(start, end));
    const expected = end - start + 1;
    if (body.length !== expected) {
        throw new AppError(
            ERROR_CODES.AUDIO_UNAVAILABLE,
            `Range request returned ${body.length} bytes, expected ${expected}`,
        );
    }
    return body;
}

/**
 * Walk top-level boxes from the start of the file until `moov`, reading
 * headers beyond `probe` with small range fetches. After `moov`, keeps
 * listing boxes only while their headers are inside the probe (no fetches).
 */
export async function locateMoov(
    probe: Uint8Array,
    fileSize: number,
    fetchRange: FetchRange,
): Promise<{ moov: Uint8Array; layout: BoxHeader[]; moovAtEnd: boolean }> {
    const layout: BoxHeader[] = [];
    let moov: Uint8Array | null = null;
    let moovAtEnd = false;
    let sawMdat = false;
    let at = 0;

    while (at < fileSize) {
        const need = Math.min(HEADER_READ_BYTES, fileSize - at);
        const inProbe = at + need <= probe.length;
        if (moov && !inProbe) break;
        const bytes = inProbe
            ? probe.subarray(at, at + need)
            : await fetchExact(fetchRange, at, at + need - 1);
        const header = readBoxHeader(bytes, 0, fileSize, at);
        if (moov) {
            // Past moov the listing is best effort: stop at anything unreadable.
            if (!header || header.offset + header.size > fileSize) break;
            layout.push(header);
            at += header.size;
            continue;
        }
        if (!header) throw unsupported("malformed box header");
        if (header.offset + header.size > fileSize) {
            throw unsupported(`${header.type} box runs past end of file`);
        }

        layout.push(header);
        if (header.type === "moof") throw unsupported("fragmented file");
        if (header.type === "mdat") sawMdat = true;
        if (header.type === "moov") {
            if (header.size > MAX_MOOV_BYTES) {
                throw unsupported(`moov box is ${header.size} bytes (limit ${MAX_MOOV_BYTES})`);
            }
            const end = header.offset + header.size;
            moov =
                end <= probe.length
                    ? probe.subarray(header.offset, end)
                    : await fetchExact(fetchRange, header.offset, end - 1);
            moovAtEnd = sawMdat;
        }
        at += header.size;
    }

    if (!moov) throw unsupported("no moov box");
    return { moov, layout, moovAtEnd };
}

/**
 * Fetch one chunk's samples and write them as a standalone M4A. Every range
 * response must be exactly the requested length, so a server that ignores
 * Range (returning the whole file) fails loudly instead of yielding bad audio.
 */
export async function loadMp4Chunk(
    track: Mp4AudioTrack,
    chunk: SampleChunk,
    fetchRange: FetchRange,
): Promise<Uint8Array> {
    const { firstSample, endSample } = chunk;
    const runs = coalesceRuns(
        track.offsets,
        track.sizes,
        firstSample,
        endSample,
        RUN_COALESCE_GAP_BYTES,
    );
    const fetched = await Promise.all(
        runs.map(async (run) => ({ run, bytes: await fetchExact(fetchRange, run.start, run.end) })),
    );

    // Views of the fetched runs, one per stretch of back-to-back samples:
    // writeM4a copies them once, into the output.
    const payload: Uint8Array[] = [];
    let run = 0;
    let part: { run: number; start: number; end: number } | null = null;
    for (let i = firstSample; i < endSample; i++) {
        const size = track.sizes[i];
        if (size === 0) continue;
        const start = track.offsets[i];
        // Runs are in sample order; advance to the run holding this sample.
        while (!(start >= fetched[run].run.start && start + size - 1 <= fetched[run].run.end)) run++;
        const rel = start - fetched[run].run.start;
        if (part && part.run === run && part.end === rel) {
            part.end += size;
        } else {
            if (part) payload.push(fetched[part.run].bytes.subarray(part.start, part.end));
            part = { run, start: rel, end: rel + size };
        }
    }
    if (part) payload.push(fetched[part.run].bytes.subarray(part.start, part.end));

    return writeM4a({
        stsd: track.stsd,
        timescale: track.timescale,
        language: track.language,
        sizes: track.sizes.subarray(firstSample, endSample),
        durations: track.durations.subarray(firstSample, endSample),
        payload,
    });
}
