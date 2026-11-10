/**
 * Tests for the MP4 sample-table reader
 */

import { describe, it, expect } from "vitest";
import {
    box,
    coalesceRuns,
    findChild,
    fullBox,
    parseAudioTrack,
    planSampleChunks,
    readBoxHeader,
    writeM4a,
} from "../src/lib/mp4";
import { AppError } from "../src/lib/errors";
import {
    ALAC_M4A,
    CHAPTERS_M4A,
    FRAGMENTED_M4A,
    MOOV_FIRST_M4A,
    fixtureBytes,
} from "./fixtures/audio";

const u32 = (...values: number[]): Uint8Array => {
    const out = new Uint8Array(values.length * 4);
    const dv = new DataView(out.buffer);
    values.forEach((v, i) => dv.setUint32(i * 4, v));
    return out;
};

const u64 = (value: number): Uint8Array => {
    const out = new Uint8Array(8);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, Math.floor(value / 2 ** 32));
    dv.setUint32(4, value % 2 ** 32);
    return out;
};

/** Walk top-level boxes and return the named one, plus the mdat payload range. */
function topLevel(bytes: Uint8Array) {
    const boxes: Record<string, Uint8Array> = {};
    let mdat = { start: 0, end: 0 };
    let at = 0;
    while (at < bytes.length) {
        const h = readBoxHeader(bytes, at, bytes.length)!;
        boxes[h.type] = bytes.subarray(at, at + h.size);
        if (h.type === "mdat") mdat = { start: at + h.headerSize, end: at + h.size };
        at += h.size;
    }
    return { boxes, mdat };
}

/** Synthetic audio trak with explicit sample-table boxes. */
function syntheticTrak(opts: {
    handler?: string;
    codec?: string;
    stsc: number[][];
    chunkBox: Uint8Array;
    stsz: Uint8Array;
    stts: Uint8Array;
}): Uint8Array {
    const mdhd = fullBox("mdhd", 0, 0, u32(0, 0, 44100, 44100 * 4), new Uint8Array([0x55, 0xc4, 0, 0]));
    const hdlr = fullBox(
        "hdlr",
        0,
        0,
        u32(0),
        new Uint8Array([...(opts.handler ?? "soun").split("").map((c) => c.charCodeAt(0))]),
        new Uint8Array(13),
    );
    const entry = box(opts.codec ?? "mp4a", new Uint8Array(28));
    const stsd = fullBox("stsd", 0, 0, u32(1), entry);
    const stsc = fullBox("stsc", 0, 0, u32(opts.stsc.length), ...opts.stsc.map((r) => u32(...r)));
    return box(
        "trak",
        box(
            "mdia",
            mdhd,
            hdlr,
            box("minf", box("stbl", stsd, opts.stts, stsc, opts.stsz, opts.chunkBox)),
        ),
    );
}

const stts = (...pairs: number[][]) =>
    fullBox("stts", 0, 0, u32(pairs.length), ...pairs.map((p) => u32(...p)));
const stszTable = (...sizes: number[]) => fullBox("stsz", 0, 0, u32(0, sizes.length, ...sizes));
const stco = (...offsets: number[]) => fullBox("stco", 0, 0, u32(offsets.length, ...offsets));

describe("readBoxHeader", () => {
    it("reads a 32-bit, a largesize, and a size-0 box header", () => {
        const free = box("free", new Uint8Array(8));
        expect(readBoxHeader(free, 0, free.length)).toEqual({
            type: "free",
            offset: 0,
            size: 16,
            headerSize: 8,
        });

        const large = new Uint8Array(24);
        const dv = new DataView(large.buffer);
        dv.setUint32(0, 1);
        large.set([0x6d, 0x64, 0x61, 0x74], 4); // mdat
        dv.setUint32(12, 0x18);
        expect(readBoxHeader(large, 0, large.length)).toEqual({
            type: "mdat",
            offset: 0,
            size: 0x18,
            headerSize: 16,
        });

        const open = new Uint8Array(8);
        open.set([0x6d, 0x64, 0x61, 0x74], 4);
        expect(readBoxHeader(open, 0, 100, 40)).toEqual({
            type: "mdat",
            offset: 40,
            size: 60,
            headerSize: 8,
        });
    });

    it("returns null when too few bytes are available", () => {
        expect(readBoxHeader(new Uint8Array(7), 0, 7)).toBeNull();
        const largePrefix = new Uint8Array(12);
        new DataView(largePrefix.buffer).setUint32(0, 1);
        expect(readBoxHeader(largePrefix, 0, 100)).toBeNull();
    });
});

describe("parseAudioTrack", () => {
    it("parses the AAC track from a moov-first fixture", () => {
        const { boxes, mdat } = topLevel(fixtureBytes(MOOV_FIRST_M4A));
        const t = parseAudioTrack(boxes.moov);
        expect(t.codec).toBe("mp4a");
        expect(t.timescale).toBe(44100);
        expect(t.durationSeconds).toBeCloseTo(5, 0);
        expect(t.sampleCount).toBe(t.sizes.length);
        expect(t.sampleCount).toBeGreaterThan(100);
        for (let i = 0; i < t.sampleCount; i++) {
            expect(t.offsets[i]).toBeGreaterThanOrEqual(mdat.start);
            expect(t.offsets[i] + t.sizes[i]).toBeLessThanOrEqual(mdat.end);
        }
        expect(t.sizes.reduce((a, b) => a + b, 0)).toBe(t.totalPayloadBytes);
        expect(readBoxHeader(t.stsd, 0, t.stsd.length)!.type).toBe("stsd");
    });

    it("picks the soun track and ignores the chapter track", () => {
        const { boxes, mdat } = topLevel(fixtureBytes(CHAPTERS_M4A));
        let trakCount = 0;
        for (let at = 8; at < boxes.moov.length; ) {
            const h = readBoxHeader(boxes.moov, at, boxes.moov.length)!;
            if (h.type === "trak") trakCount++;
            at += h.size;
        }
        expect(trakCount).toBe(2);
        const t = parseAudioTrack(boxes.moov);
        expect(t.codec).toBe("mp4a");
        for (let i = 0; i < t.sampleCount; i++) {
            expect(t.offsets[i]).toBeGreaterThanOrEqual(mdat.start);
            expect(t.offsets[i] + t.sizes[i]).toBeLessThanOrEqual(mdat.end);
        }
    });

    it("expands multi-entry stsc correctly", () => {
        const trak = syntheticTrak({
            // Chunks 1-2 hold three samples each, chunk 3 holds one.
            stsc: [
                [1, 3, 1],
                [3, 1, 1],
            ],
            chunkBox: stco(100, 200, 300),
            stsz: stszTable(10, 20, 30, 40, 50, 60, 70),
            stts: stts([7, 1024]),
        });
        const t = parseAudioTrack(box("moov", trak));
        const s = [10, 20, 30, 40, 50, 60, 70];
        expect(Array.from(t.sizes)).toEqual(s);
        expect(Array.from(t.offsets)).toEqual([100, 110, 130, 200, 240, 290, 300]);
        expect(t.durationSeconds).toBeCloseTo((7 * 1024) / 44100, 6);
    });

    it("reads co64 chunk offsets above 2^32", () => {
        const trak = syntheticTrak({
            stsc: [[1, 2, 1]],
            chunkBox: fullBox("co64", 0, 0, u32(1), u64(5_000_000_000)),
            stsz: stszTable(100, 200),
            stts: stts([2, 1024]),
        });
        const t = parseAudioTrack(box("moov", trak));
        expect(t.offsets[0]).toBe(5_000_000_000);
        expect(t.offsets[1]).toBe(5_000_000_100);
    });

    it("handles uniform stsz (sample_size != 0)", () => {
        const trak = syntheticTrak({
            stsc: [[1, 4, 1]],
            chunkBox: stco(64),
            stsz: fullBox("stsz", 0, 0, u32(371, 4)),
            stts: stts([4, 1024]),
        });
        const t = parseAudioTrack(box("moov", trak));
        expect(Array.from(t.sizes)).toEqual([371, 371, 371, 371]);
        expect(t.totalPayloadBytes).toBe(1484);
        expect(Array.from(t.offsets)).toEqual([64, 435, 806, 1177]);
    });

    it("rejects tables whose sample counts disagree", () => {
        const trak = syntheticTrak({
            stsc: [[1, 2, 1]],
            chunkBox: stco(64),
            stsz: stszTable(10, 20, 30),
            stts: stts([3, 1024]),
        });
        expect(() => parseAudioTrack(box("moov", trak))).toThrow(/malformed stsc/);
    });

    it("rejects a fragmented file with AUDIO_UNSUPPORTED", () => {
        const { boxes } = topLevel(fixtureBytes(FRAGMENTED_M4A));
        try {
            parseAudioTrack(boxes.moov);
            expect.unreachable();
        } catch (err) {
            expect(err).toBeInstanceOf(AppError);
            expect((err as AppError).code).toBe("AUDIO_UNSUPPORTED");
            expect((err as AppError).message).toContain("fragmented");
        }
    });

    it("rejects ALAC naming the codec", () => {
        const { boxes } = topLevel(fixtureBytes(ALAC_M4A));
        expect(() => parseAudioTrack(boxes.moov)).toThrow(/'alac'/);
    });

    it("rejects a moov with no soun track", () => {
        const trak = syntheticTrak({
            handler: "vide",
            stsc: [[1, 1, 1]],
            chunkBox: stco(64),
            stsz: stszTable(10),
            stts: stts([1, 1024]),
        });
        expect(() => parseAudioTrack(box("moov", trak))).toThrow(/no audio track/);
    });
});

describe("findChild", () => {
    it("walks a nested path and returns the box with its header", () => {
        const { boxes } = topLevel(fixtureBytes(MOOV_FIRST_M4A));
        const hdlr = findChild(boxes.moov, ["trak", "mdia", "hdlr"])!;
        expect(readBoxHeader(hdlr, 0, hdlr.length)!.type).toBe("hdlr");
        expect(findChild(boxes.moov, ["trak", "nope"])).toBeNull();
    });
});

describe("planSampleChunks", () => {
    const uniform = (n: number, size = 1000, dur = 1024) => ({
        sizes: new Uint32Array(n).fill(size),
        durations: new Uint32Array(n).fill(dur),
        timescale: 44100,
    });
    const noLimit = { maxBytes: 1e9, maxSeconds: 1e9, overlapSeconds: 0 };

    it("cuts on the byte limit", () => {
        const chunks = planSampleChunks(uniform(100), { ...noLimit, maxBytes: 25_000 });
        expect(chunks).toHaveLength(4);
        for (const c of chunks) expect(c.endSample - c.firstSample).toBe(25);
        expect(chunks.map((c) => c.isLast)).toEqual([false, false, false, true]);
        expect(chunks[0].isFirst).toBe(true);
        expect(chunks[1].isFirst).toBe(false);
    });

    it("cuts on the duration limit first when bitrate is low", () => {
        const sample = 1024 / 44100;
        const chunks = planSampleChunks(uniform(100), { ...noLimit, maxSeconds: 0.5 });
        for (const c of chunks) {
            expect(c.endSeconds - c.startSeconds).toBeLessThanOrEqual(0.5);
            if (!c.isLast) expect(c.endSeconds - c.startSeconds).toBeGreaterThanOrEqual(0.5 - sample);
        }
    });

    it("overlaps by ~overlapSeconds of samples", () => {
        const chunks = planSampleChunks(uniform(100), {
            ...noLimit,
            maxBytes: 25_000,
            overlapSeconds: 0.1,
        });
        const overlap = Math.ceil((0.1 * 44100) / 1024);
        expect(overlap).toBe(5);
        expect(chunks[0].overlapSamples).toBe(0);
        for (let i = 1; i < chunks.length; i++) {
            expect(chunks[i].overlapSamples).toBe(overlap);
            expect(chunks[i].firstSample).toBe(chunks[i - 1].endSample - overlap);
            expect(chunks[i].newPayloadBytes).toBe(chunks[i].payloadBytes - overlap * 1000);
            expect(chunks[i].payloadBytes).toBeLessThanOrEqual(25_000);
        }
    });

    it("covers every sample exactly once outside overlaps", () => {
        const chunks = planSampleChunks(uniform(103), {
            ...noLimit,
            maxBytes: 25_000,
            overlapSeconds: 0.1,
        });
        let next = 0;
        for (const c of chunks) {
            expect(c.firstSample + c.overlapSamples).toBe(next);
            next = c.endSample;
        }
        expect(next).toBe(103);
    });

    it("never produces an empty or overlap-only chunk at the tail", () => {
        for (let n = 1; n < 60; n++) {
            const chunks = planSampleChunks(uniform(n), {
                ...noLimit,
                maxBytes: 7_000,
                overlapSeconds: 0.1,
            });
            for (const c of chunks) expect(c.endSample - c.firstSample).toBeGreaterThan(c.overlapSamples);
            expect(chunks[chunks.length - 1].endSample).toBe(n);
        }
    });

    it("still makes progress when overlap would swallow the whole chunk", () => {
        const chunks = planSampleChunks(uniform(20), { ...noLimit, maxBytes: 3_000, overlapSeconds: 1 });
        expect(chunks[chunks.length - 1].endSample).toBe(20);
        for (const c of chunks) expect(c.newPayloadBytes).toBeGreaterThan(0);
    });

    it("returns no chunks for an empty track", () => {
        expect(planSampleChunks(uniform(0), noLimit)).toEqual([]);
    });
});

describe("coalesceRuns", () => {
    it("coalesces contiguous samples into one run", () => {
        expect(coalesceRuns([100, 200, 300], [100, 100, 50], 0, 3, 0)).toEqual([
            { start: 100, end: 349 },
        ]);
    });

    it("splits runs across a gap larger than maxGap and merges smaller gaps", () => {
        const offsets = [0, 110, 110 + 100 + 2_000_000];
        const sizes = [100, 100, 100];
        expect(coalesceRuns(offsets, sizes, 0, 3, 1024 * 1024)).toEqual([
            { start: 0, end: 209 },
            { start: 2_000_210, end: 2_000_309 },
        ]);
    });

    it("only looks at the requested sample range", () => {
        expect(coalesceRuns([0, 100, 5_000_000], [100, 100, 100], 1, 3, 1000)).toEqual([
            { start: 100, end: 199 },
            { start: 5_000_000, end: 5_000_099 },
        ]);
    });
});

describe("writeM4a", () => {
    it("writes the same file from payload parts as from one payload buffer", () => {
        const source = fixtureBytes(MOOV_FIRST_M4A);
        const src = parseAudioTrack(topLevel(source).boxes.moov);
        const parts = Array.from({ length: 30 }, (_, k) =>
            source.subarray(src.offsets[k], src.offsets[k] + src.sizes[k]),
        );
        const joined = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
        let at = 0;
        for (const part of parts) {
            joined.set(part, at);
            at += part.length;
        }
        const input = {
            stsd: src.stsd,
            timescale: src.timescale,
            language: src.language,
            sizes: src.sizes.slice(0, 30),
            durations: src.durations.slice(0, 30),
        };

        const fromParts = writeM4a({ ...input, payload: parts });
        const fromBuffer = writeM4a({ ...input, payload: joined });

        expect(fromParts).toEqual(fromBuffer);
        // Uneven splits (an empty part, parts straddling samples) change nothing.
        const regrouped = [joined.subarray(0, 7), joined.subarray(7, 7), joined.subarray(7)];
        expect(writeM4a({ ...input, payload: regrouped })).toEqual(fromBuffer);
        // One allocation, sized exactly: the mdat ends the buffer.
        expect(fromParts.byteLength).toBe(fromParts.buffer.byteLength);
        const { mdat } = topLevel(fromParts);
        expect(mdat.end).toBe(fromParts.length);
        expect(mdat.end - mdat.start).toBe(joined.length);
    });

    it("round-trips through parseAudioTrack", () => {
        const source = fixtureBytes(MOOV_FIRST_M4A);
        const src = parseAudioTrack(topLevel(source).boxes.moov);
        const first = 10;
        const end = 40;
        const sizes = src.sizes.slice(first, end);
        const durations = src.durations.slice(first, end);
        const chunk = new Uint8Array(sizes.reduce((a, b) => a + b, 0));
        let at = 0;
        for (let i = first; i < end; i++) {
            chunk.set(source.subarray(src.offsets[i], src.offsets[i] + src.sizes[i]), at);
            at += src.sizes[i];
        }

        const out = writeM4a({
            stsd: src.stsd,
            timescale: src.timescale,
            language: src.language,
            sizes,
            durations,
            payload: chunk,
        });

        const order: string[] = [];
        for (let p = 0; p < out.length; ) {
            const h = readBoxHeader(out, p, out.length)!;
            order.push(h.type);
            p += h.size;
        }
        expect(order).toEqual(["ftyp", "moov", "mdat"]);

        const { boxes, mdat } = topLevel(out);
        const track = parseAudioTrack(boxes.moov);
        expect(track.codec).toBe("mp4a");
        expect(Array.from(track.sizes)).toEqual(Array.from(sizes));
        expect(Array.from(track.durations)).toEqual(Array.from(durations));
        expect(track.timescale).toBe(src.timescale);
        expect(track.language).toBe(src.language);
        expect(Array.from(track.stsd)).toEqual(Array.from(src.stsd));
        expect(track.offsets[0]).toBe(mdat.start);
        expect(mdat.end - mdat.start).toBe(chunk.length);
        for (let k = 0; k < sizes.length; k++) {
            const want = source.subarray(src.offsets[first + k], src.offsets[first + k] + sizes[k]);
            const got = out.subarray(track.offsets[k], track.offsets[k] + sizes[k]);
            expect(Array.from(got)).toEqual(Array.from(want));
        }
    });
});
