/**
 * Chunk planning for audio files too large for one transcription upload (#53).
 *
 * Sniffs the container from a probe of the file's first bytes, then plans
 * chunks that the transcription loop loads and uploads one at a time:
 * - MP4/M4A: cut on sample boundaries; each chunk is rewritten as a
 *   standalone M4A, because MP4 audio can't be decoded without its `moov`.
 * - ADTS (raw AAC): byte ranges sized to the duration cap; each chunk's
 *   complete frames are rewrapped as a standalone M4A, because OpenAI
 *   rejects raw ADTS.
 * - Everything else (MP3, OGG, WAV): byte ranges, with the file's first
 *   512 bytes prepended to every chunk after the first.
 *
 * Must not import from `./transcription` (which imports this module).
 */

import { ADTS_SAMPLES_PER_FRAME, adtsToM4a, parseAdtsFrames, readAdtsHeader } from "../lib/adts";
import {
    CHUNK_OVERLAP_BYTES,
    CHUNK_OVERLAP_SECONDS,
    CONTAINER_PROBE_BYTES,
    MAX_CHUNK_FETCH_FACTOR,
    RUN_COALESCE_GAP_BYTES,
    calculateChunkRanges,
    id3Length,
} from "../lib/audio";
import { ERROR_CODES } from "../lib/constants";
import { AppError } from "../lib/errors";
import { coalesceRuns, parseAudioTrack, planSampleChunks, sampleDataEnd } from "../lib/mp4";
import { fetchExact, loadMp4Chunk, locateMoov, type FetchRange } from "./audio-containers";

/**
 * Size of the file header prepended to byte-range chunks after the first,
 * so the API can recognise the format. Enough for MP3 headers and metadata.
 */
const AUDIO_HEADER_SIZE_BYTES = 512;

/**
 * Bytes needed after an ID3 tag to confirm ADTS: one frame of the largest
 * possible frame_length (13 bits) plus the next frame's header.
 */
const ADTS_CONFIRM_BYTES = 0x1fff + 7;

export type AudioContainer = "mp3" | "mp4" | "adts" | "other";

/** Per-chunk caps. The MP3/other byte path uses only `maxBytes`; MP4 and ADTS use both. */
export interface ChunkSizeLimits {
    maxBytes: number;
    maxSeconds: number;
}

export interface PlannedChunk {
    /** 0-based position in the plan. */
    index: number;
    isFirst: boolean;
    isLast: boolean;
    /** Audio bytes shared with the previous chunk, which already transcribed them. */
    overlapBytes: number;
    /** Audio bytes only this chunk holds; its share of the audio is `newBytes / ChunkPlan.totalBytes`. */
    newBytes: number;
    /** Container-specific fields for the `chunk_processing` log event. */
    logFields: Record<string, unknown>;
    /** Fetch the chunk's audio and return the bytes to upload. */
    load(): Promise<ArrayBuffer>;
}

export interface ChunkPlan {
    container: AudioContainer;
    /**
     * All the audio bytes: the file size on the byte path, the bytes after
     * any ID3 tag for ADTS, the track's sample bytes for MP4.
     */
    totalBytes: number;
    chunks: PlannedChunk[];
}

export interface PlanChunksInput {
    /** The file's first bytes (up to `CONTAINER_PROBE_BYTES`). */
    probe: Uint8Array;
    fileSize: number;
    /** Only logged: the bytes decide the container. */
    contentType: string;
    limits: ChunkSizeLimits;
    fetchRange: FetchRange;
}

/**
 * Classify a file from its first bytes.
 *
 * - `mp4`: an `ftyp` box at offset 4.
 * - `adts`: after any ID3 tag, a valid ADTS header and a second one exactly
 *   `frame_length` bytes on. One sync word alone is common in MP3 data, so
 *   an unconfirmed header (including one the probe cuts short) is `other`.
 * - `mp3`: an MPEG Layer III sync after any ID3 tag, or an ID3-tagged file
 *   that is nothing else recognisable.
 * - `other`: anything else.
 */
export function detectContainer(probe: Uint8Array): AudioContainer {
    if (probe.length >= 8 && probe[4] === 0x66 && probe[5] === 0x74 && probe[6] === 0x79 && probe[7] === 0x70) {
        return "mp4";
    }

    const id3 = id3Length(probe);
    const tagged = id3 > 0;
    if (id3 + 2 > probe.length) return tagged ? "mp3" : "other";

    // 11-bit MPEG sync; the layer bits split ADTS (00) from MPEG Layer III (01).
    if (probe[id3] === 0xff && (probe[id3 + 1] & 0xe0) === 0xe0) {
        const layer = (probe[id3 + 1] >> 1) & 0x03;
        if (layer === 0) {
            const first = readAdtsHeader(probe, id3);
            return first && readAdtsHeader(probe, id3 + first.length) ? "adts" : "other";
        }
        if (layer === 1) return "mp3";
    }

    return tagged ? "mp3" : "other";
}

/** Detect the container and plan its chunks. */
export async function planChunks(input: PlanChunksInput): Promise<ChunkPlan> {
    const id3Bytes = id3Length(input.probe);
    const { container, audioProbe, probedAfterId3 } = await sniffContainer(input, id3Bytes);
    console.log(
        JSON.stringify({
            event: "container_detected",
            container,
            contentType: input.contentType,
            id3Bytes,
            ...(probedAfterId3 && { probedAfterId3 }),
        }),
    );

    if (container === "mp4") return planMp4Chunks(input);
    if (container === "adts") return planAdtsChunks(input, audioProbe, id3Bytes);
    return planByteChunks(container, input);
}

/**
 * Classify the file from its probe. An ID3 tag can outgrow the probe
 * (embedded cover art is common), leaving too little audio after it to
 * confirm ADTS, which `detectContainer` then calls `mp3`. In that case fetch
 * a second probe where the tag ends and check that for ADTS; anything else
 * keeps the first verdict. `audioProbe` holds the first audio frames.
 */
async function sniffContainer(
    { probe, fileSize, fetchRange }: PlanChunksInput,
    id3Bytes: number,
): Promise<{ container: AudioContainer; audioProbe: Uint8Array; probedAfterId3: boolean }> {
    const container = detectContainer(probe);
    const tagHidesAudio =
        (container === "mp3" || container === "other") &&
        id3Bytes > 0 &&
        id3Bytes + ADTS_CONFIRM_BYTES > probe.length &&
        probe.length < fileSize &&
        id3Bytes < fileSize;
    if (!tagHidesAudio) return { container, audioProbe: probe, probedAfterId3: false };

    // Probe size, not just ADTS_CONFIRM_BYTES: the ADTS route estimates the bitrate from these frames.
    const end = Math.min(id3Bytes + CONTAINER_PROBE_BYTES, fileSize) - 1;
    const afterTag = new Uint8Array(await fetchRange(id3Bytes, end));
    return detectContainer(afterTag) === "adts"
        ? { container: "adts", audioProbe: afterTag, probedAfterId3: true }
        : { container, audioProbe: probe, probedAfterId3: true };
}

/** Today's MP3 path: byte ranges, with the file header prepended to chunks after the first. */
function planByteChunks(
    container: AudioContainer,
    { probe, fileSize, limits, fetchRange }: PlanChunksInput,
): ChunkPlan {
    const header = probe.slice(0, AUDIO_HEADER_SIZE_BYTES);
    const chunks = calculateChunkRanges(fileSize, limits.maxBytes).map((range, index): PlannedChunk => {
        const sizeBytes = range.endByte - range.startByte + 1;
        return {
            index,
            isFirst: range.isFirst,
            isLast: range.isLast,
            overlapBytes: range.overlapBytes,
            newBytes: sizeBytes - range.overlapBytes,
            logFields: {
                startByte: range.startByte,
                endByte: range.endByte,
                sizeMB: Math.round(sizeBytes / 1024 / 1024),
            },
            load: async () => {
                const body = await fetchRange(range.startByte, range.endByte);
                return range.isFirst ? body : prependHeader(header, body, index);
            },
        };
    });
    return { container, totalBytes: fileSize, chunks };
}

function prependHeader(header: Uint8Array, body: ArrayBuffer, index: number): ArrayBuffer {
    const combined = new Uint8Array(header.length + body.byteLength);
    combined.set(header, 0);
    combined.set(new Uint8Array(body), header.length);
    console.log(
        JSON.stringify({
            event: "header_prepended",
            chunkIndex: index + 1,
            headerBytes: header.length,
            originalChunkBytes: body.byteLength,
            totalBytes: combined.byteLength,
        }),
    );
    return combined.buffer;
}

/**
 * ADTS: byte ranges over the audio after any ID3 tag, each holding at most
 * `limits.maxSeconds` at the bitrate of the probe's frames, rewrapped as M4A
 * on load. Frames resync on their own, so a range may start or end mid-frame:
 * the M4A keeps its complete frames, and the overlap (about
 * CHUNK_OVERLAP_SECONDS of audio) covers the frames cut at each boundary.
 */
function planAdtsChunks(
    { fileSize, limits, fetchRange }: PlanChunksInput,
    audioProbe: Uint8Array,
    audioStart: number,
): ChunkPlan {
    const { config, frames } = parseAdtsFrames(audioProbe);
    const frameBytes = frames.reduce((n, frame) => n + frame.length, 0);
    const bytesPerSecond = frameBytes / ((frames.length * ADTS_SAMPLES_PER_FRAME) / config.sampleRate);
    const maxChunkBytes = Math.min(limits.maxBytes, Math.floor(bytesPerSecond * limits.maxSeconds));
    // Never a whole chunk's worth, or the plan would stop advancing.
    const overlapBytes = Math.min(
        CHUNK_OVERLAP_BYTES,
        Math.round(bytesPerSecond * CHUNK_OVERLAP_SECONDS),
        Math.floor(maxChunkBytes / 4),
    );

    const audioBytes = fileSize - audioStart;
    const ranges = calculateChunkRanges(audioBytes, maxChunkBytes, overlapBytes);
    console.log(
        JSON.stringify({
            event: "adts_chunk_plan",
            totalChunks: ranges.length,
            audioStart,
            audioBytes,
            bytesPerSecond: Math.round(bytesPerSecond),
            maxChunkBytes,
            overlapBytes,
            objectType: config.objectType,
            sampleRate: config.sampleRate,
            channelConfig: config.channelConfig,
        }),
    );

    const chunks = ranges.map((range, index): PlannedChunk => {
        const startByte = audioStart + range.startByte;
        const endByte = audioStart + range.endByte;
        const sizeBytes = endByte - startByte + 1;
        return {
            index,
            isFirst: range.isFirst,
            isLast: range.isLast,
            overlapBytes: range.overlapBytes,
            newBytes: sizeBytes - range.overlapBytes,
            logFields: { startByte, endByte, sizeMB: Math.round(sizeBytes / 1024 / 1024) },
            load: async () => exactBuffer(adtsToM4a(await fetchExact(fetchRange, startByte, endByte))),
        };
    });
    return { container: "adts", totalBytes: audioBytes, chunks };
}

/**
 * MP4: cut on sample boundaries and rebuild each chunk as a standalone M4A.
 * Fails with AUDIO_UNSUPPORTED before any upload when the file can't be
 * chunked safely: a truncated file, or audio interleaved with so much other
 * data (video) that a chunk's fetches would not fit in the Worker's memory.
 */
async function planMp4Chunks({ probe, fileSize, limits, fetchRange }: PlanChunksInput): Promise<ChunkPlan> {
    const { moov, layout, moovAtEnd } = await locateMoov(probe, fileSize, fetchRange);
    const track = parseAudioTrack(moov);
    console.log(
        JSON.stringify({
            event: "mp4_layout",
            layout: layout.map(({ type, offset, size }) => ({ type, offset, size })),
            moovAtEnd,
            trackCount: track.trackCount,
            codec: track.codec,
            timescale: track.timescale,
            sampleCount: track.sampleCount,
            durationSeconds: roundSeconds(track.durationSeconds),
        }),
    );
    if (track.sampleCount === 0) {
        throw new AppError(ERROR_CODES.AUDIO_UNSUPPORTED, "Unsupported MP4: audio track has no samples");
    }
    // A moov-first file cut short still describes every sample; without this
    // the first chunk past the end would fail only after earlier chunks were paid for.
    const dataEnd = sampleDataEnd(track);
    if (dataEnd > fileSize) {
        throw new AppError(
            ERROR_CODES.AUDIO_UNSUPPORTED,
            `Unsupported MP4: file is truncated (sample table needs ${dataEnd} bytes, file has ${fileSize})`,
        );
    }

    const sampleChunks = planSampleChunks(track, {
        maxBytes: limits.maxBytes,
        maxSeconds: limits.maxSeconds,
        overlapSeconds: CHUNK_OVERLAP_SECONDS,
    });
    const chunkSummaries = sampleChunks.map((chunk) => ({
        firstSample: chunk.firstSample,
        endSample: chunk.endSample,
        sampleCount: chunk.endSample - chunk.firstSample,
        payloadBytes: chunk.payloadBytes,
        startSeconds: roundSeconds(chunk.startSeconds),
        endSeconds: roundSeconds(chunk.endSeconds),
    }));
    // The ranges each chunk's load will fetch: its samples plus any gaps under RUN_COALESCE_GAP_BYTES.
    const fetches = sampleChunks.map((chunk) => {
        const runs = coalesceRuns(track.offsets, track.sizes, chunk.firstSample, chunk.endSample, RUN_COALESCE_GAP_BYTES);
        return { rangeRequests: runs.length, fetchBytes: runs.reduce((n, run) => n + run.end - run.start + 1, 0) };
    });
    console.log(
        JSON.stringify({
            event: "mp4_chunk_plan",
            totalChunks: sampleChunks.length,
            totalPayloadBytes: track.totalPayloadBytes,
            chunks: chunkSummaries.map((summary, i) => ({ ...summary, ...fetches[i] })),
        }),
    );

    // Gap bytes are fetched alongside the audio, so audio interleaved with video
    // (an octet-stream file, or one sent through the admin override) can make a
    // chunk's fetches many times its payload.
    const worst = fetches.reduce((w, { fetchBytes }, i) => (fetchBytes > fetches[w].fetchBytes ? i : w), 0);
    if (fetches[worst].fetchBytes > MAX_CHUNK_FETCH_FACTOR * limits.maxBytes) {
        const otherMB = Math.round((fetches[worst].fetchBytes - sampleChunks[worst].payloadBytes) / 1024 / 1024);
        throw new AppError(
            ERROR_CODES.AUDIO_UNSUPPORTED,
            `Unsupported MP4: audio is interleaved with ${otherMB} MB of other data per chunk (video file?)`,
        );
    }

    const chunks = sampleChunks.map(
        (chunk, index): PlannedChunk => ({
            index,
            isFirst: chunk.isFirst,
            isLast: chunk.isLast,
            overlapBytes: chunk.payloadBytes - chunk.newPayloadBytes,
            newBytes: chunk.newPayloadBytes,
            logFields: chunkSummaries[index],
            load: async () => exactBuffer(await loadMp4Chunk(track, chunk, fetchRange)),
        }),
    );
    return { container: "mp4", totalBytes: track.totalPayloadBytes, chunks };
}

function roundSeconds(seconds: number): number {
    return Math.round(seconds * 100) / 100;
}

/** The view's bytes as an ArrayBuffer of exactly that length (copying only if it is a slice). */
export function exactBuffer(view: Uint8Array): ArrayBuffer {
    if (view.byteOffset === 0 && view.byteLength === view.buffer.byteLength && view.buffer instanceof ArrayBuffer) {
        return view.buffer;
    }
    return view.slice().buffer;
}
