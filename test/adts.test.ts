/**
 * Tests for the ADTS (raw AAC) reader and its M4A rewrapping
 */

import { describe, it, expect } from "vitest";
import {
    adtsToM4a,
    buildAacStsd,
    findAdtsSync,
    parseAdtsFrames,
    readAdtsHeader,
    type AdtsConfig,
} from "../src/lib/adts";
import { id3Length } from "../src/lib/audio";
import { ERROR_CODES } from "../src/lib/constants";
import { AppError } from "../src/lib/errors";
import { parseAudioTrack } from "../src/lib/mp4";
import { locateMoov } from "../src/services/audio-containers";
import { ADTS_AAC, ADTS_AAC_ID3, fixtureBytes } from "./fixtures/audio";

/** The fixture's first 7-byte header, copied so each test can patch it. */
function firstHeader(): Uint8Array {
    return fixtureBytes(ADTS_AAC).slice(0, 7);
}

/** Overwrite the 13-bit frame_length field. */
function setFrameLength(header: Uint8Array, length: number): void {
    header[3] = (header[3] & 0xfc) | ((length >> 11) & 0x03);
    header[4] = (length >> 3) & 0xff;
    header[5] = (header[5] & 0x1f) | ((length & 0x07) << 5);
}

describe("readAdtsHeader", () => {
    it("reads the 7-byte header of ADTS_AAC", () => {
        const bytes = fixtureBytes(ADTS_AAC);
        const header = readAdtsHeader(bytes, 0);

        expect(header).not.toBeNull();
        expect(header!.config).toEqual({
            objectType: 2,
            sampleRateIndex: 4,
            sampleRate: 44100,
            channelConfig: 1,
        });
        expect(header!.headerSize).toBe(7);
        // The next frame starts exactly frame_length bytes on.
        expect(readAdtsHeader(bytes, header!.length)).not.toBeNull();
    });

    it("reads a header at a non-zero offset", () => {
        const bytes = new Uint8Array(10 + 7);
        bytes.set(firstHeader(), 10);
        expect(readAdtsHeader(bytes, 10)?.config.sampleRate).toBe(44100);
    });

    it("reports a 9-byte header when a CRC is present", () => {
        const header = firstHeader();
        header[1] &= 0xfe; // protection_absent = 0
        expect(readAdtsHeader(header, 0)?.headerSize).toBe(9);
    });

    it("returns null for bytes without a sync word", () => {
        expect(readAdtsHeader(new Uint8Array(7), 0)).toBeNull();
        expect(readAdtsHeader(new Uint8Array([0xff, 0xe1, 0x50, 0x40, 0x23, 0xbf, 0xfc]), 0)).toBeNull();
    });

    it("returns null when the layer bits are not 00", () => {
        const header = firstHeader();
        header[1] |= 0x02; // layer 01: an MPEG Layer III frame
        expect(readAdtsHeader(header, 0)).toBeNull();
    });

    it("returns null for a reserved sampling-frequency index", () => {
        for (const index of [13, 14, 15]) {
            const header = firstHeader();
            header[2] = (header[2] & 0xc3) | (index << 2);
            expect(readAdtsHeader(header, 0)).toBeNull();
        }
    });

    it("returns null when frame_length is shorter than the header", () => {
        const header = firstHeader();
        setFrameLength(header, 6);
        expect(readAdtsHeader(header, 0)).toBeNull();

        const crcHeader = firstHeader();
        crcHeader[1] &= 0xfe;
        setFrameLength(crcHeader, 8);
        expect(readAdtsHeader(crcHeader, 0)).toBeNull();
    });

    it("returns null when fewer than 7 bytes are left", () => {
        expect(readAdtsHeader(firstHeader().subarray(0, 6), 0)).toBeNull();
        expect(readAdtsHeader(firstHeader(), 1)).toBeNull();
    });
});

function concat(...parts: Uint8Array[]): Uint8Array {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of parts) {
        out.set(p, at);
        at += p.length;
    }
    return out;
}

/** Expect `fn` to throw AUDIO_UNSUPPORTED with exactly `message`. */
function expectUnsupported(fn: () => unknown, message: string): void {
    let error: unknown;
    try {
        fn();
    } catch (e) {
        error = e;
    }
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe(ERROR_CODES.AUDIO_UNSUPPORTED);
    expect((error as AppError).message).toBe(message);
}

const AAC_LC_44K_MONO: AdtsConfig = { objectType: 2, sampleRateIndex: 4, sampleRate: 44100, channelConfig: 1 };

describe("findAdtsSync", () => {
    it("returns 0 for a stream that starts on a frame", () => {
        expect(findAdtsSync(fixtureBytes(ADTS_AAC), 0)).toBe(0);
    });

    it("resyncs from a mid-frame offset onto the next real frame start", () => {
        const bytes = fixtureBytes(ADTS_AAC);
        const starts = parseAdtsFrames(bytes).frames.map((f) => f.offset);

        const offset = findAdtsSync(bytes, 1000);

        expect(offset).toBe(starts.find((s) => s >= 1000));
    });

    it("accepts a final frame that ends exactly at the end of the bytes", () => {
        const bytes = fixtureBytes(ADTS_AAC);
        const last = parseAdtsFrames(bytes).frames.at(-1)!;
        expect(findAdtsSync(bytes, last.offset)).toBe(last.offset);
    });

    it("returns -1 when no header is confirmed by a second one", () => {
        expect(findAdtsSync(new Uint8Array(4096), 0)).toBe(-1);
        expect(findAdtsSync(concat(firstHeader(), new Uint8Array(1024)), 0)).toBe(-1);
    });
});

describe("parseAdtsFrames", () => {
    it("reads every frame of ADTS_AAC with its config", () => {
        const bytes = fixtureBytes(ADTS_AAC);
        const { config, frames } = parseAdtsFrames(bytes);

        expect(config).toEqual(AAC_LC_44K_MONO);
        expect(frames).toHaveLength(217);
        expect(frames[0]).toEqual({ offset: 0, headerSize: 7, length: readAdtsHeader(bytes, 0)!.length });
        const last = frames.at(-1)!;
        expect(last.offset + last.length).toBe(bytes.length);
    });

    it("skips ID3 and finds the first frame", () => {
        const bytes = fixtureBytes(ADTS_AAC_ID3);
        const { frames } = parseAdtsFrames(bytes);

        expect(frames[0].offset).toBe(id3Length(bytes));
        expect(frames).toHaveLength(parseAdtsFrames(fixtureBytes(ADTS_AAC)).frames.length);
    });

    it("reads a 9-byte CRC header and keeps the payload intact", () => {
        const bytes = fixtureBytes(ADTS_AAC);
        const first = parseAdtsFrames(bytes).frames[0];
        // Clear protection_absent, insert two CRC bytes, and grow frame_length by 2.
        const header = bytes.slice(0, 7);
        header[1] &= 0xfe;
        setFrameLength(header, first.length + 2);
        const crcFrame = concat(header, new Uint8Array([0xab, 0xcd]), bytes.subarray(7, first.length));
        const stream = concat(crcFrame, bytes.subarray(first.length));

        const { frames } = parseAdtsFrames(stream);

        expect(frames[0]).toEqual({ offset: 0, headerSize: 9, length: first.length + 2 });
        expect(frames[1].offset).toBe(first.length + 2);
        const payload = stream.subarray(frames[0].offset + 9, frames[0].offset + frames[0].length);
        expect(payload).toEqual(bytes.subarray(7, first.length));
    });

    it("resyncs at the start of a chunk cut mid-frame", () => {
        const bytes = fixtureBytes(ADTS_AAC);
        const all = parseAdtsFrames(bytes).frames;

        const { frames } = parseAdtsFrames(bytes.subarray(1000));

        const firstAfter = all.findIndex((f) => f.offset >= 1000);
        expect(frames[0].offset).toBe(all[firstAfter].offset - 1000);
        expect(frames).toHaveLength(all.length - firstAfter);
    });

    it("drops a truncated final frame", () => {
        const bytes = fixtureBytes(ADTS_AAC);
        const all = parseAdtsFrames(bytes).frames;
        const last = all.at(-1)!;

        const { frames } = parseAdtsFrames(bytes.subarray(0, last.offset + 10));

        expect(frames).toHaveLength(all.length - 1);
    });

    it("rejects a config change mid-stream", () => {
        const bytes = fixtureBytes(ADTS_AAC).slice();
        const third = parseAdtsFrames(bytes).frames[2];
        bytes[third.offset + 2] = (bytes[third.offset + 2] & 0xc3) | (3 << 2); // 48 kHz

        expectUnsupported(() => parseAdtsFrames(bytes), "Unsupported ADTS: stream parameters change mid-file");
    });

    it("rejects frames holding more than one raw data block", () => {
        const bytes = fixtureBytes(ADTS_AAC).slice();
        bytes[6] |= 0x01; // number_of_raw_data_blocks_in_frame = 1, i.e. two blocks

        expectUnsupported(() => parseAdtsFrames(bytes), "Unsupported ADTS: multiple raw data blocks per frame");
    });

    it("throws rather than returning no frames", () => {
        expectUnsupported(() => parseAdtsFrames(new Uint8Array(4096)), "Unsupported ADTS: no complete frames");
        const bytes = fixtureBytes(ADTS_AAC);
        const first = parseAdtsFrames(bytes).frames[0];
        // A single frame cut short.
        expectUnsupported(
            () => parseAdtsFrames(bytes.subarray(0, first.length - 1)),
            "Unsupported ADTS: no complete frames",
        );
    });
});

describe("buildAacStsd", () => {
    it("builds the AudioSpecificConfig 0x12 0x08 for AAC-LC 44.1 kHz mono", () => {
        const stsd = buildAacStsd(AAC_LC_44K_MONO);
        const hex = Array.from(stsd, (b) => b.toString(16).padStart(2, "0")).join("");

        expect(new TextDecoder().decode(stsd.subarray(4, 8))).toBe("stsd");
        expect(new TextDecoder().decode(stsd.subarray(20, 24))).toBe("mp4a");
        // DecoderSpecificInfo: tag 0x05, length 2, then the AudioSpecificConfig.
        expect(hex).toContain("05021208");
        // mp4a: channelcount 1, samplesize 16, then samplerate 44100 << 16.
        const dv = new DataView(stsd.buffer, stsd.byteOffset);
        expect(dv.getUint16(16 + 8 + 16)).toBe(1);
        expect(dv.getUint16(16 + 8 + 18)).toBe(16);
        expect(dv.getUint32(16 + 8 + 24)).toBe(44100 * 65536);
    });

    it("encodes object type, rate index and channels in the AudioSpecificConfig", () => {
        // AAC-LC, 48 kHz (index 3), stereo: 0x11 0x90.
        const stsd = buildAacStsd({ objectType: 2, sampleRateIndex: 3, sampleRate: 48000, channelConfig: 2 });
        const hex = Array.from(stsd, (b) => b.toString(16).padStart(2, "0")).join("");
        expect(hex).toContain("05021190");
    });
});

describe("adtsToM4a", () => {
    async function readTrack(file: Uint8Array) {
        const { moov } = await locateMoov(file, file.length, async (s, e) => file.slice(s, e + 1).buffer);
        return parseAudioTrack(moov);
    }

    it("round-trips through parseAudioTrack", async () => {
        const bytes = fixtureBytes(ADTS_AAC_ID3);
        const { frames } = parseAdtsFrames(bytes);

        const m4a = adtsToM4a(bytes);
        const track = await readTrack(m4a);

        expect(new TextDecoder().decode(m4a.subarray(4, 8))).toBe("ftyp");
        expect(track.codec).toBe("mp4a");
        expect(track.timescale).toBe(44100);
        expect(track.language).toBe(0x55c4); // "und"
        expect(track.sampleCount).toBe(frames.length);
        expect(Array.from(track.sizes)).toEqual(frames.map((f) => f.length - f.headerSize));
        expect(new Set(track.durations)).toEqual(new Set([1024]));
        expect(track.durationSeconds).toBeCloseTo((frames.length * 1024) / 44100, 6);
        // mdat (written last) is every frame's payload, headers stripped, in order.
        const payloads = concat(...frames.map((f) => bytes.subarray(f.offset + f.headerSize, f.offset + f.length)));
        expect(m4a.subarray(track.offsets[0])).toEqual(payloads);
        expect(m4a.byteLength).toBe(m4a.buffer.byteLength);
    });
});
