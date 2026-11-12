/**
 * Tests for MPEG audio frame and VBR header parsing (src/lib/mp3.ts).
 */

import { describe, it, expect } from "vitest";
import {
    analyzeMp3,
    findMp3Frame,
    parseMp3FrameHeader,
    readVbrHeader,
} from "../src/lib/mp3";
import { id3Length } from "../src/lib/audio";
import {
    MP3_BIG_ID3,
    MP3_CBR_INFO,
    MP3_NO_HEADER,
    MP3_STITCHED,
    MP3_VBR_XING,
    fixtureBytes,
} from "./fixtures/audio";

/** The fixture's bytes and the offset of its first frame (right after the ID3 tag). */
function loadMp3(b64: string): { bytes: Uint8Array; first: number } {
    const bytes = fixtureBytes(b64);
    return { bytes, first: id3Length(bytes) };
}

describe("parseMp3FrameHeader", () => {
    it("parses MPEG-1 Layer III mono 96 kbps (Supra Insider #135's first frame)", () => {
        const h = parseMp3FrameHeader(new Uint8Array([0xff, 0xfb, 0x70, 0xc0]), 0);
        expect(h).toMatchObject({
            version: 1,
            bitrateKbps: 96,
            sampleRate: 44100,
            channels: 1,
            padding: false,
            crc: false,
            frameLength: 313,
            samplesPerFrame: 1152,
        });
    });

    it("parses MPEG-2 and MPEG-2.5 Layer III with the LSF tables", () => {
        // Bitrate index 4, sample-rate index 0, padding set, mono.
        expect(parseMp3FrameHeader(new Uint8Array([0xff, 0xf3, 0x42, 0xc4]), 0)).toMatchObject({
            version: 2,
            bitrateKbps: 32,
            sampleRate: 22050,
            channels: 1,
            padding: true,
            frameLength: 105, // floor(72 × 32000 / 22050) + 1
            samplesPerFrame: 576,
        });
        // Bitrate index 1, sample-rate index 2, no padding, stereo, CRC present.
        expect(parseMp3FrameHeader(new Uint8Array([0xff, 0xe2, 0x18, 0x00]), 0)).toMatchObject({
            version: 2.5,
            bitrateKbps: 8,
            sampleRate: 8000,
            channels: 2,
            crc: true,
            frameLength: 72, // floor(72 × 8000 / 8000)
            samplesPerFrame: 576,
        });
    });

    it("rejects free-format, bad-bitrate, reserved-rate and non-Layer-III headers", () => {
        const parse = (b1: number, b2: number) =>
            parseMp3FrameHeader(new Uint8Array([0xff, b1, b2, 0xc0]), 0);
        expect(parse(0xfb, 0x70)).not.toBeNull(); // the valid baseline
        expect(parse(0xfb, 0x00)).toBeNull(); // bitrate index 0: free format
        expect(parse(0xfb, 0xf0)).toBeNull(); // bitrate index 15: invalid
        expect(parse(0xfb, 0x7c)).toBeNull(); // sample-rate index 3: reserved
        expect(parse(0xfd, 0x70)).toBeNull(); // layer bits 10: Layer II
        expect(parse(0xeb, 0x70)).toBeNull(); // version bits 01: reserved
        expect(parse(0x7b, 0x70)).toBeNull(); // no sync word
    });

    it("returns null when fewer than 4 bytes remain", () => {
        expect(parseMp3FrameHeader(new Uint8Array([0xff, 0xfb, 0x70]), 0)).toBeNull();
        expect(parseMp3FrameHeader(new Uint8Array([0xff, 0xfb, 0x70, 0xc0]), 1)).toBeNull();
    });
});

describe("findMp3Frame", () => {
    it("returns a frame start when it is already on one", () => {
        const { bytes, first } = loadMp3(MP3_NO_HEADER);
        expect(findMp3Frame(bytes, first)).toBe(first);
        expect(findMp3Frame(bytes, 0)).toBe(first); // skips the ID3 tag's bytes
    });

    it("findMp3Frame ignores a lone sync word with no second header one frame on", () => {
        const { bytes, first } = loadMp3(MP3_NO_HEADER);
        const next = first + parseMp3FrameHeader(bytes, first)!.frameLength;
        expect(parseMp3FrameHeader(bytes, next)).not.toBeNull();

        const planted = first + 50; // inside the first frame's payload
        bytes.set([0xff, 0xfb, 0x70, 0xc0], planted);
        expect(parseMp3FrameHeader(bytes, planted)).not.toBeNull(); // parses on its own

        expect(findMp3Frame(bytes, first + 1)).toBe(next);
    });

    it("findMp3Frame returns -1 when no confirmed frame starts before `to`", () => {
        const { bytes, first } = loadMp3(MP3_NO_HEADER);
        const next = first + parseMp3FrameHeader(bytes, first)!.frameLength;
        expect(findMp3Frame(bytes, first + 1, next)).toBe(-1); // `to` is exclusive
        expect(findMp3Frame(bytes, first + 1, next + 1)).toBe(next);
        expect(findMp3Frame(new Uint8Array(4096), 0)).toBe(-1);
    });

    it("accepts a frame that ends exactly at the end of the buffer", () => {
        const { bytes, first } = loadMp3(MP3_NO_HEADER);
        const next = first + parseMp3FrameHeader(bytes, first)!.frameLength;
        const oneFrame = bytes.slice(first, next);
        expect(findMp3Frame(oneFrame, 0)).toBe(0);
        expect(findMp3Frame(oneFrame.slice(0, -1), 0)).toBe(-1); // truncated: not confirmed
    });
});

describe("readVbrHeader", () => {
    it("readVbrHeader finds Info in CBR, Xing in VBR, nothing without a header", () => {
        const read = (b64: string) => {
            const { bytes, first } = loadMp3(b64);
            return readVbrHeader(bytes, first, parseMp3FrameHeader(bytes, first)!);
        };

        const info = read(MP3_CBR_INFO);
        expect(info?.kind).toBe("info");
        expect(info?.frames).toBeGreaterThan(0);

        const xing = read(MP3_VBR_XING);
        expect(xing?.kind).toBe("xing");
        expect(xing?.frames).toBeGreaterThan(0);

        expect(read(MP3_NO_HEADER)).toBeNull();
    });

    it("finds a VBRI tag 36 bytes into the frame", () => {
        // A 1,045-byte MPEG-1 frame (320 kbps, 44.1 kHz, padded) carrying a VBRI tag.
        const frame = new Uint8Array(1045);
        frame.set([0xff, 0xfb, 0xe2, 0x00], 0);
        frame.set([0x56, 0x42, 0x52, 0x49], 36); // "VBRI"
        frame.set([0x00, 0x00, 0x01, 0x2c], 36 + 14); // 300 frames
        const header = parseMp3FrameHeader(frame, 0)!;
        expect(readVbrHeader(frame, 0, header)).toEqual({ kind: "vbri", frames: 300 });
    });
});

describe("analyzeMp3", () => {
    it("analyzeMp3 skips the Info frame and declares ~5 s", () => {
        const { bytes, first } = loadMp3(MP3_CBR_INFO);
        const a = analyzeMp3(bytes.slice(0, 64 * 1024), 0, bytes.length, first)!;
        const infoFrame = parseMp3FrameHeader(bytes, first)!;

        expect(a.firstFrameOffset).toBe(first);
        expect(a.audioStart).toBe(first + infoFrame.frameLength);
        expect(a.vbrHeader).toBe("info");
        expect(a.header.bitrateKbps).toBe(64);
        expect(Math.abs(a.declaredSeconds! - 5)).toBeLessThan(0.1);
        expect(Math.abs(a.estimatedSeconds - 5)).toBeLessThan(0.1);
        expect(a.usedSeconds).toBeGreaterThanOrEqual(a.estimatedSeconds);
        expect(a.usedSeconds).toBeGreaterThanOrEqual(a.declaredSeconds!);
    });

    it("starts audio at the first frame when there is no VBR header", () => {
        const { bytes, first } = loadMp3(MP3_NO_HEADER);
        const a = analyzeMp3(bytes, 0, bytes.length, first)!;
        expect(a.firstFrameOffset).toBe(first);
        expect(a.audioStart).toBe(first);
        expect(a.vbrHeader).toBe("none");
        expect(a.declaredSeconds).toBeNull();
        expect(a.usedSeconds).toBe(a.estimatedSeconds);
    });

    it("analyzeMp3 uses the longer estimate when the header under-declares", () => {
        const { bytes, first } = loadMp3(MP3_STITCHED);
        const a = analyzeMp3(bytes.slice(0, 64 * 1024), 0, bytes.length, first)!;
        expect(Math.abs(a.declaredSeconds! - 2)).toBeLessThan(0.1);
        expect(Math.abs(a.usedSeconds - 7)).toBeLessThan(0.2);
        expect(a.usedSeconds).toBe(a.estimatedSeconds);
    });

    it("analyzeMp3 reads a probe that starts after a large ID3 tag", () => {
        const { bytes, first: id3 } = loadMp3(MP3_BIG_ID3);
        expect(id3).toBeGreaterThan(64 * 1024);
        const probe = bytes.slice(id3, id3 + 65536);
        const a = analyzeMp3(probe, id3, bytes.length, id3)!;
        expect(a.firstFrameOffset).toBe(id3);
        expect(a.audioStart).toBe(id3 + parseMp3FrameHeader(bytes, id3)!.frameLength);
        expect(a.vbrHeader).toBe("info");
        expect(Math.abs(a.usedSeconds - 5)).toBeLessThan(0.1);
    });

    it("analyzeMp3 returns null when nothing after the tag is a confirmed frame", () => {
        const { bytes, first } = loadMp3(MP3_CBR_INFO);
        const junk = new Uint8Array(first + 4096);
        junk.set(bytes.slice(0, first)); // the real ID3 tag, then zeros
        junk.set([0xff, 0xfb, 0x50, 0xc0], first + 100); // one unconfirmed sync word
        expect(analyzeMp3(junk, 0, junk.length, first)).toBeNull();
    });

    it("returns null when the scan starts past the end of the probe", () => {
        const { bytes } = loadMp3(MP3_CBR_INFO);
        const probe = bytes.slice(0, 1024);
        expect(analyzeMp3(probe, 0, bytes.length, 4096)).toBeNull();
    });
});
