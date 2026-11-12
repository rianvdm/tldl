/**
 * Tests for chunk planning (src/services/chunk-planning.ts), driven through
 * `planChunks` with an in-memory `fetchRange` over each fixture.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import {
    CHUNK_OVERLAP_BYTES,
    CHUNK_OVERLAP_SECONDS,
    CONTAINER_PROBE_BYTES,
    TARGET_CHUNK_SIZE_BYTES,
    calculateChunkRanges,
    id3Length,
} from "../src/lib/audio";
import { analyzeMp3, parseMp3FrameHeader, readVbrHeader } from "../src/lib/mp3";
import { planChunks, type ChunkPlan, type ChunkSizeLimits } from "../src/services/chunk-planning";
import {
    ADTS_AAC,
    MOOV_FIRST_M4A,
    MP3_BIG_ID3,
    MP3_CBR_INFO,
    MP3_STITCHED,
    fixtureBytes,
} from "./fixtures/audio";

/** 5 s fixtures split into several chunks at 2 s each. */
const LIMITS: ChunkSizeLimits = { maxBytes: TARGET_CHUNK_SIZE_BYTES, maxSeconds: 2 };

/** Plan `file` the way production does: a probe of its first bytes, then range reads. */
function plan(file: Uint8Array, limits: ChunkSizeLimits = LIMITS, contentType = "audio/mpeg"): Promise<ChunkPlan> {
    return planChunks({
        probe: file.slice(0, Math.min(CONTAINER_PROBE_BYTES, file.length)),
        fileSize: file.length,
        contentType,
        limits,
        fetchRange: async (start, end) => file.slice(start, end + 1).buffer,
    });
}

async function loadAll(p: ChunkPlan): Promise<Uint8Array[]> {
    const out: Uint8Array[] = [];
    for (const chunk of p.chunks) out.push(new Uint8Array(await chunk.load()));
    return out;
}

/** The chunk starts on an MPEG frame that is plain audio: no ID3 tag, no Xing/Info/VBRI frame. */
function expectBareAudioFrame(bytes: Uint8Array) {
    expect(new TextDecoder().decode(bytes.subarray(0, 3))).not.toBe("ID3");
    const header = parseMp3FrameHeader(bytes, 0);
    expect(header).not.toBeNull();
    expect(readVbrHeader(bytes, 0, header!)).toBeNull();
}

/** The byte ranges the MP3 planner should make for `file`, from the same inputs it uses. */
function expectedMp3Ranges(file: Uint8Array, limits: ChunkSizeLimits) {
    const id3 = id3Length(file);
    const analysis = analyzeMp3(file.subarray(id3), id3, file.length, id3)!;
    const audioBytes = file.length - analysis.audioStart;
    const bytesPerSecond = audioBytes / analysis.usedSeconds;
    const maxChunkBytes = Math.min(limits.maxBytes, Math.floor(bytesPerSecond * limits.maxSeconds));
    const overlap = Math.min(
        CHUNK_OVERLAP_BYTES,
        Math.round(bytesPerSecond * CHUNK_OVERLAP_SECONDS),
        Math.floor(maxChunkBytes / 4),
    );
    return {
        analysis,
        ranges: calculateChunkRanges(audioBytes, maxChunkBytes, overlap).map((r) => ({
            ...r,
            startByte: analysis.audioStart + r.startByte,
            endByte: analysis.audioStart + r.endByte,
        })),
    };
}

function loggedEvents(log: { mock: { calls: unknown[][] } }): Record<string, unknown>[] {
    return log.mock.calls
        .map(([line]) => {
            try {
                return JSON.parse(String(line)) as Record<string, unknown>;
            } catch {
                return null;
            }
        })
        .filter((e): e is Record<string, unknown> => e !== null);
}

describe("planChunks: MP3", () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("MP3 with Info frame: no chunk starts with a VBR header frame, every chunk starts on a confirmed frame", async () => {
        const file = fixtureBytes(MP3_CBR_INFO);
        // At 2 s chunks the overlap is a quarter chunk (0.5 s), so the 5.04 s file needs
        // 2 + 1.5 + 1.5 + 0.04 s: 4 chunks, not the 3 a 2 s overlap-free split would give.
        const { ranges } = expectedMp3Ranges(file, LIMITS);
        expect(ranges).toHaveLength(4);

        const p = await plan(file);

        expect(p.container).toBe("mp3");
        expect(p.chunks).toHaveLength(ranges.length);
        expect(p.chunks.map((c) => c.logFields)).toEqual(
            ranges.map((r) => expect.objectContaining({ startByte: r.startByte, endByte: r.endByte })),
        );
        for (const bytes of await loadAll(p)) expectBareAudioFrame(bytes);
    });

    it("MP3 plan carries the audio summary", async () => {
        const file = fixtureBytes(MP3_CBR_INFO);

        const p = await plan(file);

        expect(p.fileSize).toBe(file.length);
        expect(p.audio).toMatchObject({
            vbrHeader: "info",
            vbrHeaderDropped: true,
            bitrateKbps: 64,
            sampleRate: 44100,
            channels: 1,
        });
        expect(p.audio.usedSeconds).toBeCloseTo(5, 1);
        expect(p.audio.declaredSeconds).toBeCloseTo(5, 1);
        expect(p.audio.estimatedSeconds).toBeCloseTo(5, 1);
    });

    it("chunk 1 starts at audioStart, after the ID3 tag and the Info frame", async () => {
        const file = fixtureBytes(MP3_CBR_INFO);
        const id3 = id3Length(file);
        const infoFrame = parseMp3FrameHeader(file, id3)!;
        expect(readVbrHeader(file, id3, infoFrame)?.kind).toBe("info");
        const audioStart = id3 + infoFrame.frameLength;

        const p = await plan(file);
        const [first] = await loadAll(p);

        expect(p.totalBytes).toBe(file.length - audioStart);
        expect(p.chunks[0].logFields).toMatchObject({ startByte: audioStart });
        expect(p.chunks[0].overlapBytes).toBe(0);
        expect(first).toEqual(file.slice(audioStart, (p.chunks[0].logFields.endByte as number) + 1));
        // newBytes add up to the audio after audioStart.
        expect(p.chunks.reduce((n, c) => n + c.newBytes, 0)).toBe(p.totalBytes);
    });

    it("plannedSeconds never exceeds maxSeconds", async () => {
        for (const fixture of [MP3_CBR_INFO, MP3_STITCHED]) {
            const p = await plan(fixtureBytes(fixture));
            for (const chunk of p.chunks) {
                expect(chunk.plannedSeconds).toBeGreaterThan(0);
                expect(chunk.plannedSeconds!).toBeLessThanOrEqual(LIMITS.maxSeconds);
            }
        }
    });

    it("stitched MP3: chunks sized by the byte estimate; a chunk starting on the second piece's Info frame drops it", async () => {
        const file = fixtureBytes(MP3_STITCHED);

        const p = await plan(file);

        // The first Info frame declares only the 2 s pre-roll; the bytes say about 7 s.
        expect(p.audio.declaredSeconds).toBeCloseTo(2, 0);
        expect(p.audio.usedSeconds).toBeCloseTo(7.1, 1);
        expect(p.chunks.length).toBeGreaterThanOrEqual(4);
        for (const bytes of await loadAll(p)) expectBareAudioFrame(bytes);
    });

    it("stitched MP3: a chunk planned at the second piece's ID3 tag starts after its Info frame", async () => {
        const file = fixtureBytes(MP3_STITCHED);
        // The second piece is a whole tagged file: ID3 tag, Info frame, audio frames.
        const secondPiece = file.findIndex(
            (b, i) => i > 0 && b === 0x49 && file[i + 1] === 0x44 && file[i + 2] === 0x33,
        );
        const secondId3 = id3Length(file.subarray(secondPiece));
        const secondInfo = parseMp3FrameHeader(file, secondPiece + secondId3)!;
        expect(readVbrHeader(file, secondPiece + secondId3, secondInfo)?.kind).toBe("info");
        const secondAudio = secondPiece + secondId3 + secondInfo.frameLength;

        // A byte cap that lands chunk 2 exactly on the second ID3 tag: the 252-byte
        // first-piece header, then maxBytes − floor(maxBytes / 4) bytes on.
        const maxBytes = 21_733;
        const p = await plan(file, { maxBytes, maxSeconds: 900 });
        expect(p.chunks[1].logFields).toMatchObject({ startByte: secondPiece });
        const [, second] = await loadAll(p);

        expect(second).toEqual(file.slice(secondAudio, (p.chunks[1].logFields.endByte as number) + 1));
        expectBareAudioFrame(second);
    });

    it("resync skips an isolated sync word whose frame would end exactly at the chunk's end", async () => {
        const file = fixtureBytes(MP3_CBR_INFO);
        // 1440-byte chunks, so a 1440-byte frame header (MPEG-1, 320 kbps, 32 kHz) planted
        // at chunk 2's first byte looks like a frame filling the whole range.
        const limits = { maxBytes: 1440, maxSeconds: 900 };
        const p0 = await plan(file, limits);
        const { startByte, endByte } = p0.chunks[1].logFields as { startByte: number; endByte: number };
        expect(endByte - startByte + 1).toBe(1440);
        expect(p0.chunks[1].isLast).toBe(false);
        file.set([0xff, 0xfb, 0xe8, 0xc0], startByte);
        expect(parseMp3FrameHeader(file, startByte)!.frameLength).toBe(1440);

        const p = await plan(file, limits);
        const second = new Uint8Array(await p.chunks[1].load());

        const header = parseMp3FrameHeader(second, 0)!;
        expect(header).toMatchObject({ sampleRate: 44100, bitrateKbps: 64 });
        expect(second.length).toBeLessThan(1440);
        expect(second).toEqual(file.slice(endByte + 1 - second.length, endByte + 1));
    });

    it("large ID3 tag: plans from the after-tag probe", async () => {
        const file = fixtureBytes(MP3_BIG_ID3);
        expect(id3Length(file)).toBeGreaterThan(CONTAINER_PROBE_BYTES);

        const p = await plan(file);

        expect(p.container).toBe("mp3");
        expect(p.audio.vbrHeader).toBe("info");
        const [first] = await loadAll(p);
        expectBareAudioFrame(first);
    });

    it("unparseable MP3 falls back to the byte path and logs mp3_frame_parse_failed", async () => {
        const tag = new Uint8Array([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x14, ...new Array(20).fill(0)]);
        const file = new Uint8Array(tag.length + 2048);
        file.set(tag);
        const log = vi.spyOn(console, "log").mockImplementation(() => {});

        const p = await plan(file);

        expect(p.container).toBe("mp3");
        expect(p.chunks.map((c) => c.logFields)).toEqual(
            calculateChunkRanges(file.length, LIMITS.maxBytes).map((r) =>
                expect.objectContaining({ startByte: r.startByte, endByte: r.endByte }),
            ),
        );
        expect(p.totalBytes).toBe(file.length);
        const failed = loggedEvents(log).filter((e) => e.event === "mp3_frame_parse_failed");
        expect(failed).toEqual([
            {
                event: "mp3_frame_parse_failed",
                scanFrom: tag.length,
                firstBytesHex: new Array(32).fill("00").join(" "),
            },
        ]);
    });

    it("logs mp3_resync_failed and keeps the chunk's bytes when no frame is found near its start", async () => {
        const file = fixtureBytes(MP3_CBR_INFO);
        const { ranges } = expectedMp3Ranges(file, LIMITS);
        // Blank out everything from chunk 2's start, so no later chunk holds a frame.
        file.fill(0, ranges[1].startByte);
        const log = vi.spyOn(console, "log").mockImplementation(() => {});

        const p = await plan(file);
        const [, ...later] = await loadAll(p);

        expect(later).toEqual(ranges.slice(1).map((r) => file.slice(r.startByte, r.endByte + 1)));
        expect(loggedEvents(log).filter((e) => e.event === "mp3_resync_failed")).toEqual(
            ranges.slice(1).map((r, i) => ({ event: "mp3_resync_failed", chunkIndex: i + 2, startByte: r.startByte })),
        );
    });
});

describe("planChunks: every container", () => {
    it("every planner sets cacheId and fileSize", async () => {
        const cases: Array<[string, Uint8Array, RegExp, string]> = [
            ["mp3", fixtureBytes(MP3_CBR_INFO), /^b\d+-\d+$/, "audio/mpeg"],
            ["mp4", fixtureBytes(MOOV_FIRST_M4A), /^s\d+-\d+$/, "audio/mp4"],
            ["adts", fixtureBytes(ADTS_AAC), /^b\d+-\d+$/, "audio/aac"],
            ["other", new Uint8Array(4096), /^b\d+-\d+$/, "audio/ogg"],
        ];
        for (const [container, file, pattern, contentType] of cases) {
            const p = await plan(file, LIMITS, contentType);
            expect(p.container).toBe(container);
            expect(p.fileSize).toBe(file.length);
            expect(p.chunks.length).toBeGreaterThan(0);
            for (const chunk of p.chunks) expect(chunk.cacheId).toMatch(pattern);
        }
    });

    it("sets usedSeconds for MP4 and ADTS, and nothing for other", async () => {
        const mp4 = await plan(fixtureBytes(MOOV_FIRST_M4A), LIMITS, "audio/mp4");
        expect(mp4.audio.usedSeconds).toBeCloseTo(5, 0);

        const adts = await plan(fixtureBytes(ADTS_AAC), LIMITS, "audio/aac");
        expect(adts.audio.usedSeconds).toBeCloseTo(5, 0);
        for (const chunk of adts.chunks) {
            expect(chunk.plannedSeconds!).toBeLessThanOrEqual(LIMITS.maxSeconds);
        }

        const other = await plan(new Uint8Array(4096), LIMITS, "audio/ogg");
        expect(other.audio).toEqual({});
    });
});
