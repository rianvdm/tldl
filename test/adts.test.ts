/**
 * Tests for the ADTS (raw AAC) header reader
 */

import { describe, it, expect } from "vitest";
import { readAdtsHeader } from "../src/lib/adts";
import { ADTS_AAC, fixtureBytes } from "./fixtures/audio";

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
