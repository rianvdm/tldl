/**
 * Tests for the MP4 sample-table reader
 */

import { describe, it, expect } from "vitest";
import { box, findChild, fullBox, parseAudioTrack, readBoxHeader } from "../src/lib/mp4";
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
