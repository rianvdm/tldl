/**
 * Tests for the MP4 range-fetch glue
 */

import { describe, it, expect } from "vitest";
import { MAX_MOOV_BYTES } from "../src/lib/audio";
import { ERROR_CODES } from "../src/lib/constants";
import { AppError } from "../src/lib/errors";
import {
    box,
    parseAudioTrack,
    planSampleChunks,
    readBoxHeader,
    type Mp4AudioTrack,
} from "../src/lib/mp4";
import { loadMp4Chunk, locateMoov, type FetchRange } from "../src/services/audio-containers";
import {
    FRAGMENTED_M4A,
    MOOV_FIRST_M4A,
    MOOV_LAST_M4A,
    fixtureBytes,
} from "./fixtures/audio";

/** In-memory fetchRange over `file` that records its calls. */
function memoryFetch(file: Uint8Array) {
    const calls: Array<[number, number]> = [];
    const fetchRange: FetchRange = async (start, end) => {
        calls.push([start, end]);
        const slice = file.slice(start, end + 1);
        return slice.buffer.slice(slice.byteOffset, slice.byteOffset + slice.byteLength);
    };
    return { calls, fetchRange };
}

function concat(...parts: Uint8Array[]): Uint8Array {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of parts) {
        out.set(p, at);
        at += p.length;
    }
    return out;
}

function topLevel(file: Uint8Array) {
    const boxes: Array<{ type: string; offset: number; size: number }> = [];
    let at = 0;
    while (at < file.length) {
        const h = readBoxHeader(file, at, file.length)!;
        boxes.push({ type: h.type, offset: at, size: h.size });
        at += h.size;
    }
    return boxes;
}

const freeBox = () => box("free", new Uint8Array(92)); // 100 bytes
const uuidBox = () => box("uuid", new Uint8Array(16 + 20));

async function trackOf(file: Uint8Array): Promise<Mp4AudioTrack> {
    const { moov } = await locateMoov(file, file.length, memoryFetch(file).fetchRange);
    return parseAudioTrack(moov);
}

function wholeFileChunk(track: Mp4AudioTrack) {
    const [chunk] = planSampleChunks(track, {
        maxBytes: Number.MAX_SAFE_INTEGER,
        maxSeconds: Number.MAX_SAFE_INTEGER / track.timescale,
        overlapSeconds: 0,
    });
    return chunk;
}

/** Concatenated sample bytes of the whole track, read straight from `file`. */
function sourceSamples(file: Uint8Array, track: Mp4AudioTrack): Uint8Array {
    const parts: Uint8Array[] = [];
    for (let i = 0; i < track.sampleCount; i++) {
        parts.push(file.subarray(track.offsets[i], track.offsets[i] + track.sizes[i]));
    }
    return concat(...parts);
}

async function expectCode(promise: Promise<unknown>, code: string) {
    const error = await promise.then(
        () => null,
        (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe(code);
    return error as AppError;
}

describe("locateMoov", () => {
    it("finds moov inside the probe with no extra fetches", async () => {
        const file = fixtureBytes(MOOV_FIRST_M4A);
        const { calls, fetchRange } = memoryFetch(file);
        const result = await locateMoov(file, file.length, fetchRange);
        expect(calls).toHaveLength(0);
        expect(result.moovAtEnd).toBe(false);
        expect(readBoxHeader(result.moov, 0, result.moov.length)!.type).toBe("moov");
        expect(result.layout.map((b) => b.type)).toEqual(topLevel(file).map((b) => b.type));
    });

    it("finds moov after mdat with one header read and one moov read", async () => {
        const file = fixtureBytes(MOOV_LAST_M4A);
        const { calls, fetchRange } = memoryFetch(file);
        const result = await locateMoov(file.subarray(0, 64), file.length, fetchRange);
        expect(result.moovAtEnd).toBe(true);
        expect(calls.length).toBeLessThanOrEqual(3);
        expect(parseAudioTrack(result.moov).sampleCount).toBeGreaterThan(0);
    });

    it("skips free/uuid boxes before moov", async () => {
        const original = fixtureBytes(MOOV_LAST_M4A);
        const boxes = topLevel(original);
        const moovAt = boxes.find((b) => b.type === "moov")!.offset;
        const padded = concat(
            original.subarray(0, moovAt),
            freeBox(),
            uuidBox(),
            original.subarray(moovAt),
        );
        const { fetchRange } = memoryFetch(padded);
        const result = await locateMoov(padded.subarray(0, 64), padded.length, fetchRange);
        expect(result.layout.map((b) => b.type)).toContain("free");
        expect(result.layout.map((b) => b.type)).toContain("uuid");

        const track = parseAudioTrack(result.moov);
        const expected = await trackOf(original);
        const chunk = wholeFileChunk(track);
        const out = await loadMp4Chunk(track, chunk, fetchRange);
        const outTrack = await trackOf(out);
        expect(Array.from(outTrack.sizes)).toEqual(Array.from(expected.sizes));
        expect(sourceSamples(out, outTrack)).toEqual(sourceSamples(original, expected));
    });

    it("skips free/uuid boxes after moov", async () => {
        const original = fixtureBytes(MOOV_FIRST_M4A);
        const padded = concat(original, freeBox(), uuidBox());
        const { calls, fetchRange } = memoryFetch(padded);
        const result = await locateMoov(padded, padded.length, fetchRange);
        expect(calls).toHaveLength(0);
        expect(result.moovAtEnd).toBe(false);
        const track = parseAudioTrack(result.moov);
        const expected = await trackOf(original);
        expect(Array.from(track.sizes)).toEqual(Array.from(expected.sizes));
    });

    it("ignores a probe that ends just past moov or inside the next header", async () => {
        const file = fixtureBytes(MOOV_FIRST_M4A);
        const boxes = topLevel(file);
        const moov = boxes.find((b) => b.type === "moov")!;
        const moovEnd = moov.offset + moov.size;
        const next = boxes.find((b) => b.offset === moovEnd);
        const cuts = [1, 4, 7].map((n) => moovEnd + n);
        if (next) cuts.push(next.offset + 12);
        for (const cut of cuts) {
            const { calls, fetchRange } = memoryFetch(file);
            const result = await locateMoov(file.subarray(0, cut), file.length, fetchRange);
            expect(calls).toHaveLength(0);
            expect(readBoxHeader(result.moov, 0, result.moov.length)!.type).toBe("moov");
        }
    });

    it("ignores trailing junk or a truncated box after moov", async () => {
        const original = fixtureBytes(MOOV_FIRST_M4A);
        for (const tail of [new Uint8Array(4), box("free", new Uint8Array(92)).subarray(0, 50)]) {
            const file = concat(original, tail);
            const { calls, fetchRange } = memoryFetch(file);
            const result = await locateMoov(file, file.length, fetchRange);
            expect(calls).toHaveLength(0);
            expect(readBoxHeader(result.moov, 0, result.moov.length)!.type).toBe("moov");
        }
    });

    it("treats size-0 mdat as running to EOF", async () => {
        const file = fixtureBytes(MOOV_FIRST_M4A).slice();
        const mdat = topLevel(file).find((b) => b.type === "mdat")!;
        new DataView(file.buffer).setUint32(mdat.offset, 0);
        const { fetchRange } = memoryFetch(file);
        const { layout } = await locateMoov(file, file.length, fetchRange);
        const last = layout[layout.length - 1];
        expect(last.type).toBe("mdat");
        expect(last.size).toBe(file.length - last.offset);
    });

    it("reads a box header that straddles the probe end with a small fetch", async () => {
        const file = fixtureBytes(MOOV_LAST_M4A);
        const second = topLevel(file)[1];
        const { calls, fetchRange } = memoryFetch(file);
        // Probe ends 4 bytes into the second box's header.
        const result = await locateMoov(file.subarray(0, second.offset + 4), file.length, fetchRange);
        expect(result.moovAtEnd).toBe(true);
        expect(calls[0]).toEqual([second.offset, second.offset + 15]);
    });

    it("rejects a moof that precedes moov", async () => {
        const original = fixtureBytes(FRAGMENTED_M4A);
        const moovAt = topLevel(original).find((b) => b.type === "moov")!.offset;
        const file = concat(
            original.subarray(0, moovAt),
            box("moof", new Uint8Array(8)),
            original.subarray(moovAt),
        );
        const { fetchRange } = memoryFetch(file);
        const error = await expectCode(
            locateMoov(file, file.length, fetchRange),
            ERROR_CODES.AUDIO_UNSUPPORTED,
        );
        expect(error.message).toContain("fragmented");
    });

    it("rejects an oversized moov", async () => {
        const header = new Uint8Array(16);
        new DataView(header.buffer).setUint32(0, MAX_MOOV_BYTES + 1);
        header.set([0x6d, 0x6f, 0x6f, 0x76], 4); // "moov"
        const { calls, fetchRange } = memoryFetch(new Uint8Array(0));
        await expectCode(
            locateMoov(header, MAX_MOOV_BYTES + 1, fetchRange),
            ERROR_CODES.AUDIO_UNSUPPORTED,
        );
        expect(calls).toHaveLength(0);
    });

    it("rejects a box that runs past the end of the file", async () => {
        const file = fixtureBytes(MOOV_LAST_M4A);
        const truncated = file.subarray(0, file.length - 10);
        const { fetchRange } = memoryFetch(truncated);
        await expectCode(
            locateMoov(truncated, truncated.length, fetchRange),
            ERROR_CODES.AUDIO_UNSUPPORTED,
        );
    });

    it("rejects a file with no moov", async () => {
        const file = concat(box("ftyp", new Uint8Array(12)), box("mdat", new Uint8Array(40)));
        const { fetchRange } = memoryFetch(file);
        const error = await expectCode(
            locateMoov(file, file.length, fetchRange),
            ERROR_CODES.AUDIO_UNSUPPORTED,
        );
        expect(error.message).toBe("Unsupported MP4: no moov box");
    });
});

describe("loadMp4Chunk", () => {
    it("output decodes to the same samples", async () => {
        const file = fixtureBytes(MOOV_FIRST_M4A);
        const track = await trackOf(file);
        const { fetchRange } = memoryFetch(file);
        const out = await loadMp4Chunk(track, wholeFileChunk(track), fetchRange);
        const outTrack = await trackOf(out);
        expect(outTrack.sampleCount).toBe(track.sampleCount);
        expect(Array.from(outTrack.sizes)).toEqual(Array.from(track.sizes));
        expect(Array.from(outTrack.durations)).toEqual(Array.from(track.durations));
        expect(sourceSamples(out, outTrack)).toEqual(sourceSamples(file, track));
    });

    it("uses one range request for an audio-only chunk", async () => {
        const file = fixtureBytes(MOOV_FIRST_M4A);
        const track = await trackOf(file);
        const { calls, fetchRange } = memoryFetch(file);
        await loadMp4Chunk(track, wholeFileChunk(track), fetchRange);
        expect(calls).toHaveLength(1);
    });

    it("fetches one range per run and keeps samples in order", async () => {
        const real = await trackOf(fixtureBytes(MOOV_FIRST_M4A));
        const MB = 1024 * 1024;
        const sizes = Uint32Array.from([100, 50, 80, 120, 60, 90]);
        // Runs: [0..149], [3MB..3MB+199], [6MB..6MB+149]; gaps exceed 1 MB.
        const offsets = Float64Array.from([0, 100, 3 * MB, 3 * MB + 80, 6 * MB, 6 * MB + 60]);
        const backing = new Uint8Array(6 * MB + 150);
        for (const [i, off] of offsets.entries()) {
            for (let b = 0; b < sizes[i]; b++) backing[off + b] = (i + 1) * 40 + (b % 7);
        }
        const track: Mp4AudioTrack = {
            ...real,
            sampleCount: sizes.length,
            offsets,
            sizes,
            durations: new Uint32Array(sizes.length).fill(1024),
            totalPayloadBytes: sizes.reduce((a, b) => a + b, 0),
        };
        const { calls, fetchRange } = memoryFetch(backing);
        const out = await loadMp4Chunk(track, wholeFileChunk(track), fetchRange);
        expect(calls).toEqual([
            [0, 149],
            [3 * MB, 3 * MB + 199],
            [6 * MB, 6 * MB + 149],
        ]);
        const outTrack = await trackOf(out);
        expect(Array.from(outTrack.sizes)).toEqual(Array.from(sizes));
        expect(sourceSamples(out, outTrack)).toEqual(sourceSamples(backing, track));
    });

    it("throws AUDIO_UNAVAILABLE when a range comes back the wrong length", async () => {
        const file = fixtureBytes(MOOV_FIRST_M4A);
        const track = await trackOf(file);
        const wholeFile: FetchRange = async () =>
            file.slice().buffer as ArrayBuffer;
        const chunk = wholeFileChunk(track);
        const error = await expectCode(
            loadMp4Chunk(track, chunk, wholeFile),
            ERROR_CODES.AUDIO_UNAVAILABLE,
        );
        expect(error.message).toMatch(/^Range request returned \d+ bytes, expected \d+$/);
    });
});
