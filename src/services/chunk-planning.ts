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
 * - MP3: byte ranges sized to the duration cap, starting at the first audio
 *   frame. Each chunk is bare MPEG frames: no ID3 tag and never a
 *   Xing/Info/VBRI frame, which declares the whole file's duration and makes
 *   gpt-transcribe reject the chunk. A chunk after the first starts at its
 *   first confirmed frame.
 * - Everything else (OGG, WAV, and MP3 whose frames can't be parsed): byte
 *   ranges, with the file's first 512 bytes prepended to every chunk after
 *   the first.
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
    hexBytes,
    id3Length,
} from "../lib/audio";
import { ERROR_CODES } from "../lib/constants";
import { AppError } from "../lib/errors";
import {
    MP3_RESYNC_WINDOW_BYTES,
    analyzeMp3,
    findMp3Frame,
    parseMp3FrameHeader,
    readVbrHeader,
    type VbrHeaderKind,
} from "../lib/mp3";
import { coalesceRuns, parseAudioTrack, planSampleChunks, sampleDataEnd } from "../lib/mp4";
import { fetchExact, loadMp4Chunk, locateMoov, type FetchRange } from "./audio-containers";

/**
 * Version of the planner's output and the chunk cache key's format. A cached
 * chunk transcript is reused only under the same version, so bump this
 * whenever the chunks planned for the same file and limits change
 * (boundaries or the bytes a chunk uploads) or `chunkCacheKey` changes.
 */
export const CHUNK_PLAN_VERSION = 3;

/**
 * Size of the file header prepended to byte-range chunks after the first on
 * the `other` path, so the API can recognise the format.
 */
const AUDIO_HEADER_SIZE_BYTES = 512;

/**
 * Bytes needed after an ID3 tag to confirm ADTS: one frame of the largest
 * possible frame_length (13 bits) plus the next frame's header.
 */
const ADTS_CONFIRM_BYTES = 0x1fff + 7;

export type AudioContainer = "mp3" | "mp4" | "adts" | "other";

/** Per-chunk caps. MP3, MP4 and ADTS use both; the `other` byte path uses only `maxBytes`. */
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
    /**
     * Identifies the chunk's audio within the file, for the chunk cache:
     * `b{startByte}-{endByte}` (absolute, inclusive) on the byte, MP3 and ADTS
     * paths, `s{firstSample}-{endSample}` (end exclusive) on MP4.
     */
    cacheId: string;
    /** Audio duration the planner expects the chunk to hold (unset on the `other` byte path). */
    plannedSeconds?: number;
    /** Fetch the chunk's audio and return the bytes to upload. */
    load(): Promise<ArrayBuffer>;
}

export interface ChunkPlan {
    container: AudioContainer;
    /**
     * All the audio bytes: the file size on the byte path, the bytes from
     * the first audio frame for MP3, the bytes after any ID3 tag for ADTS,
     * the track's sample bytes for MP4.
     */
    totalBytes: number;
    /** The whole file's byte length, whatever the container. */
    fileSize: number;
    /** What the planner learnt about the audio; `{}` on the byte path. */
    audio: ChunkPlanAudio;
    chunks: PlannedChunk[];
}

/** The audio facts a plan was sized from, for logs. Fields a container can't supply are absent. */
export interface ChunkPlanAudio {
    bitrateKbps?: number;
    sampleRate?: number;
    channels?: number;
    /** MP3 only: the VBR header frame before the audio, if any. */
    vbrHeader?: VbrHeaderKind | "none";
    /** MP3 only: the VBR header frame was left out of every chunk. */
    vbrHeaderDropped?: boolean;
    /** MP3 only: the duration the VBR header declares, or null without a frame count. */
    declaredSeconds?: number | null;
    /** MP3 only: the duration from the audio bytes at the first frame's bitrate. */
    estimatedSeconds?: number;
    /** The duration the per-chunk seconds cap was applied to. */
    usedSeconds?: number;
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
    const { container, audioProbe, audioProbeOffset, probedAfterId3 } = await sniffContainer(input, id3Bytes);
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
    if (container === "mp3") return planMp3Chunks(input, audioProbe, audioProbeOffset, id3Bytes);
    return planByteChunks(container, input);
}

/**
 * Classify the file from its probe. An ID3 tag can outgrow the probe
 * (embedded cover art is common), leaving too little audio after it to
 * confirm ADTS, which `detectContainer` then calls `mp3`. In that case fetch
 * a second probe where the tag ends and check that for ADTS; anything else
 * keeps the first verdict. `audioProbe` holds the first audio frames, from
 * absolute offset `audioProbeOffset`: the after-tag probe for ADTS and MP3,
 * so the MP3 planner can find its first frame behind an oversized tag.
 */
async function sniffContainer(
    { probe, fileSize, fetchRange }: PlanChunksInput,
    id3Bytes: number,
): Promise<{
    container: AudioContainer;
    audioProbe: Uint8Array;
    audioProbeOffset: number;
    probedAfterId3: boolean;
}> {
    const container = detectContainer(probe);
    const tagHidesAudio =
        (container === "mp3" || container === "other") &&
        id3Bytes > 0 &&
        id3Bytes + ADTS_CONFIRM_BYTES > probe.length &&
        probe.length < fileSize &&
        id3Bytes < fileSize;
    if (!tagHidesAudio) return { container, audioProbe: probe, audioProbeOffset: 0, probedAfterId3: false };

    // Probe size, not just ADTS_CONFIRM_BYTES: the ADTS route estimates the bitrate from these frames.
    const end = Math.min(id3Bytes + CONTAINER_PROBE_BYTES, fileSize) - 1;
    const afterTag = new Uint8Array(await fetchRange(id3Bytes, end));
    if (detectContainer(afterTag) === "adts") {
        return { container: "adts", audioProbe: afterTag, audioProbeOffset: id3Bytes, probedAfterId3: true };
    }
    return container === "mp3"
        ? { container, audioProbe: afterTag, audioProbeOffset: id3Bytes, probedAfterId3: true }
        : { container, audioProbe: probe, audioProbeOffset: 0, probedAfterId3: true };
}

/**
 * The `other` path (and MP3 whose frames can't be parsed): byte ranges over
 * the whole file, with the file header prepended to chunks after the first.
 */
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
            cacheId: byteCacheId(range.startByte, range.endByte),
            load: async () => {
                const body = await fetchRange(range.startByte, range.endByte);
                return range.isFirst ? body : prependHeader(header, body, index);
            },
        };
    });
    return { container, totalBytes: fileSize, fileSize, audio: {}, chunks };
}

function byteCacheId(startByte: number, endByte: number): string {
    return `b${startByte}-${endByte}`;
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
 * MP3: byte ranges over the audio from its first frame, each holding at most
 * `limits.maxSeconds` at the file's average byte rate. The duration is the
 * longer of the VBR header's and the byte estimate, so a stitched file whose
 * Info frame describes only a pre-roll is still sized by its bytes.
 *
 * Chunk 1 starts at the first audio frame, past the ID3 tag and any
 * Xing/Info/VBRI frame. A later chunk's range starts mid-stream, so its load
 * trims the bytes before the first confirmed frame, and that frame too when
 * it is a VBR header (a stitched file's second piece starts with one). The
 * overlap (about CHUNK_OVERLAP_SECONDS of audio) covers what is trimmed.
 * When the planner can't find the first frame it keeps the byte path.
 */
function planMp3Chunks(
    input: PlanChunksInput,
    audioProbe: Uint8Array,
    audioProbeOffset: number,
    scanFrom: number,
): ChunkPlan {
    const { fileSize, limits, fetchRange } = input;
    const analysis = analyzeMp3(audioProbe, audioProbeOffset, fileSize, scanFrom);
    if (!analysis) {
        const at = Math.max(scanFrom - audioProbeOffset, 0);
        console.log(
            JSON.stringify({
                event: "mp3_frame_parse_failed",
                scanFrom,
                firstBytesHex: hexBytes(audioProbe.subarray(at, at + 32)),
            }),
        );
        return planByteChunks("mp3", input);
    }

    const { audioStart, header, usedSeconds } = analysis;
    const audioBytes = fileSize - audioStart;
    const bytesPerSecond = audioBytes / usedSeconds;
    const maxChunkBytes = Math.min(limits.maxBytes, Math.floor(bytesPerSecond * limits.maxSeconds));
    const overlapBytes = chunkOverlapBytes(bytesPerSecond, maxChunkBytes);
    const ranges = calculateChunkRanges(audioBytes, maxChunkBytes, overlapBytes);
    const audio: ChunkPlanAudio = {
        bitrateKbps: header.bitrateKbps,
        sampleRate: header.sampleRate,
        channels: header.channels,
        vbrHeader: analysis.vbrHeader,
        vbrHeaderDropped: analysis.vbrHeader !== "none",
        declaredSeconds: analysis.declaredSeconds,
        estimatedSeconds: analysis.estimatedSeconds,
        usedSeconds,
    };
    console.log(
        JSON.stringify({
            event: "mp3_chunk_plan",
            totalChunks: ranges.length,
            firstFrameOffset: analysis.firstFrameOffset,
            audioStart,
            audioBytes,
            bytesPerSecond: Math.round(bytesPerSecond),
            maxChunkBytes,
            overlapBytes,
            ...audio,
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
            cacheId: byteCacheId(startByte, endByte),
            plannedSeconds: sizeBytes / bytesPerSecond,
            load: async () => {
                const body = await fetchExact(fetchRange, startByte, endByte);
                return exactBuffer(range.isFirst ? body : startAtAudioFrame(body, index, startByte, range.isLast));
            },
        };
    });
    return { container: "mp3", totalBytes: audioBytes, fileSize, audio, chunks };
}

/**
 * The plan cut an MP3 on frame boundaries, so its chunks are bare MPEG
 * frames. False for MP3 whose frames couldn't be parsed, which keeps the
 * byte path (and is the only MP3 plan without `audio.vbrHeader`).
 */
export function isMp3FramePlan(plan: ChunkPlan | null): plan is ChunkPlan {
    return plan?.container === "mp3" && plan.audio.vbrHeader !== undefined;
}

/**
 * Trim a mid-stream MP3 chunk to start at its first confirmed frame, skipping
 * that frame too when it is a VBR header. Only the last chunk ends at the
 * file's end, so only there may a frame ending at the chunk's end go
 * unconfirmed. Without a frame in the resync window, logs
 * `mp3_resync_failed` and returns the bytes unchanged.
 */
function startAtAudioFrame(body: Uint8Array, index: number, startByte: number, isLast: boolean): Uint8Array {
    const frame = findMp3Frame(body, 0, MP3_RESYNC_WINDOW_BYTES, { bufferEndsFile: isLast });
    if (frame === -1) {
        console.log(JSON.stringify({ event: "mp3_resync_failed", chunkIndex: index + 1, startByte }));
        return body;
    }
    const header = parseMp3FrameHeader(body, frame)!;
    return body.subarray(readVbrHeader(body, frame, header) ? frame + header.frameLength : frame);
}

/**
 * Overlap between byte-range chunks: CHUNK_OVERLAP_SECONDS of audio, at most
 * CHUNK_OVERLAP_BYTES, and never a whole chunk's worth, or the plan would
 * stop advancing.
 */
function chunkOverlapBytes(bytesPerSecond: number, maxChunkBytes: number): number {
    return Math.min(
        CHUNK_OVERLAP_BYTES,
        Math.round(bytesPerSecond * CHUNK_OVERLAP_SECONDS),
        Math.floor(maxChunkBytes / 4),
    );
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
    const overlapBytes = chunkOverlapBytes(bytesPerSecond, maxChunkBytes);

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
            cacheId: byteCacheId(startByte, endByte),
            plannedSeconds: sizeBytes / bytesPerSecond,
            load: async () => exactBuffer(adtsToM4a(await fetchExact(fetchRange, startByte, endByte))),
        };
    });
    return {
        container: "adts",
        totalBytes: audioBytes,
        fileSize,
        audio: { usedSeconds: audioBytes / bytesPerSecond },
        chunks,
    };
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
            cacheId: `s${chunk.firstSample}-${chunk.endSample}`,
            plannedSeconds: chunk.endSeconds - chunk.startSeconds,
            load: async () => exactBuffer(await loadMp4Chunk(track, chunk, fetchRange)),
        }),
    );
    return {
        container: "mp4",
        totalBytes: track.totalPayloadBytes,
        fileSize,
        audio: { usedSeconds: track.durationSeconds },
        chunks,
    };
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
