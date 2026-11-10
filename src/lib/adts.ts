/**
 * ADTS (raw AAC stream) parsing.
 *
 * An ADTS stream is a run of AAC frames, each with a 7-byte header (9 with a
 * CRC) carrying a 12-bit 0xFFF sync word, the stream parameters and the frame
 * length. OpenAI rejects raw ADTS, so it has to be rewrapped as M4A (#53).
 */

import { id3Length } from "./audio";
import { ERROR_CODES } from "./constants";
import { AppError } from "./errors";
import { box, fullBox, u16, u32, writeM4a } from "./mp4";

/** Stream parameters from an ADTS header, in AudioSpecificConfig terms. */
export interface AdtsConfig {
    /** MPEG-4 audio object type: the ADTS profile + 1 (2 = AAC-LC). */
    objectType: number;
    sampleRateIndex: number;
    sampleRate: number;
    channelConfig: number;
}

/** Sampling frequencies by index; 13-15 are reserved or not allowed in ADTS. */
const SAMPLE_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];

/**
 * Read the ADTS frame header at `at`. Returns null unless the bytes hold a
 * plausible header: the 0xFFF sync, layer bits 00, a defined sampling index,
 * and a frame length that covers at least the header itself.
 */
export function readAdtsHeader(
    bytes: Uint8Array,
    at: number,
): { config: AdtsConfig; headerSize: 7 | 9; length: number } | null {
    if (at < 0 || at + 7 > bytes.length) return null;
    const b1 = bytes[at + 1];
    if (bytes[at] !== 0xff || (b1 & 0xf0) !== 0xf0) return null;
    if ((b1 & 0x06) !== 0) return null; // layer must be 00

    const b2 = bytes[at + 2];
    const b3 = bytes[at + 3];
    const sampleRateIndex = (b2 >> 2) & 0x0f;
    if (sampleRateIndex >= SAMPLE_RATES.length) return null;

    const headerSize = (b1 & 0x01) === 1 ? 7 : 9; // protection_absent
    const length = ((b3 & 0x03) << 11) | (bytes[at + 4] << 3) | (bytes[at + 5] >> 5);
    if (length < headerSize) return null;

    return {
        config: {
            objectType: ((b2 >> 6) & 0x03) + 1,
            sampleRateIndex,
            sampleRate: SAMPLE_RATES[sampleRateIndex],
            channelConfig: ((b2 & 0x01) << 2) | (b3 >> 6),
        },
        headerSize,
        length,
    };
}

/** One ADTS frame within a byte buffer. */
export interface AdtsFrame {
    /** Offset of the frame's header in the buffer. */
    offset: number;
    headerSize: 7 | 9;
    /** frame_length: header plus payload. */
    length: number;
}

/** PCM samples per AAC frame (one raw data block). */
export const ADTS_SAMPLES_PER_FRAME = 1024;

/** ISO-639-2/T "und" (undetermined), packed as in `mdhd`. */
const LANGUAGE_UND = 0x55c4;

function unsupported(detail: string): AppError {
    return new AppError(ERROR_CODES.AUDIO_UNSUPPORTED, `Unsupported ADTS: ${detail}`);
}

function sameConfig(a: AdtsConfig, b: AdtsConfig): boolean {
    return (
        a.objectType === b.objectType &&
        a.sampleRateIndex === b.sampleRateIndex &&
        a.channelConfig === b.channelConfig
    );
}

/**
 * The first offset at or after `from` where a frame header parses and is
 * confirmed by a second header with the same parameters at `offset + length`
 * (or where that frame ends exactly at the end of `bytes`). A lone 0xFFF in
 * AAC or MP3 data is common, so one header alone proves nothing. Returns -1
 * if there is no such offset.
 */
export function findAdtsSync(bytes: Uint8Array, from: number): number {
    for (let at = Math.max(0, from); at + 7 <= bytes.length; at++) {
        if (bytes[at] !== 0xff) continue;
        const header = readAdtsHeader(bytes, at);
        if (!header) continue;
        const next = at + header.length;
        if (next === bytes.length) return at;
        const confirm = readAdtsHeader(bytes, next);
        if (confirm && sameConfig(confirm.config, header.config)) return at;
    }
    return -1;
}

/**
 * List the complete ADTS frames in `bytes`, which may be any byte range of a
 * stream: parsing skips a leading ID3 tag, resyncs if the range starts
 * mid-frame (or hits junk between frames), and stops before a final frame
 * the range cuts short.
 *
 * @throws AppError(AUDIO_UNSUPPORTED) if the stream parameters change, a
 *   frame packs several raw data blocks, or there are no complete frames.
 */
export function parseAdtsFrames(bytes: Uint8Array): { config: AdtsConfig; frames: AdtsFrame[] } {
    const frames: AdtsFrame[] = [];
    let config: AdtsConfig | null = null;

    let at = findAdtsSync(bytes, id3Length(bytes));
    while (at >= 0) {
        const header = readAdtsHeader(bytes, at);
        if (!header) {
            at = findAdtsSync(bytes, at + 1);
            continue;
        }
        if (at + header.length > bytes.length) break;

        if (config === null) {
            config = header.config;
        } else if (!sameConfig(header.config, config)) {
            throw unsupported("stream parameters change mid-file");
        }
        // number_of_raw_data_blocks_in_frame: each frame must hold exactly 1024 samples.
        if ((bytes[at + 6] & 0x03) !== 0) throw unsupported("multiple raw data blocks per frame");

        frames.push({ offset: at, headerSize: header.headerSize, length: header.length });
        at += header.length;
    }

    if (config === null) throw unsupported("no complete frames");
    return { config, frames };
}

/** An MPEG-4 descriptor: tag, expandable size, body. */
function descriptor(tag: number, ...parts: Uint8Array[]): Uint8Array {
    const size = parts.reduce((n, p) => n + p.length, 0);
    const sizeBytes: number[] = [size & 0x7f];
    for (let rest = size >> 7; rest > 0; rest >>= 7) sizeBytes.unshift((rest & 0x7f) | 0x80);
    const out = new Uint8Array(1 + sizeBytes.length + size);
    out[0] = tag;
    out.set(sizeBytes, 1);
    let at = 1 + sizeBytes.length;
    for (const p of parts) {
        out.set(p, at);
        at += p.length;
    }
    return out;
}

/**
 * An `stsd` box with one `mp4a` sample entry for the stream described by an
 * ADTS header. Its `esds` carries the 2-byte AudioSpecificConfig decoders
 * need in place of the per-frame ADTS headers.
 */
export function buildAacStsd(config: AdtsConfig): Uint8Array {
    const { objectType, sampleRateIndex, sampleRate, channelConfig } = config;
    const audioSpecificConfig = u16((objectType << 11) | (sampleRateIndex << 7) | (channelConfig << 3));

    const esds = fullBox(
        "esds",
        0,
        0,
        descriptor(
            0x03, // ES_Descriptor
            u16(1), // ES_ID: the track's ID
            new Uint8Array([0]), // no stream dependence, URL or OCR stream
            descriptor(
                0x04, // DecoderConfigDescriptor
                new Uint8Array([0x40, (0x05 << 2) | 0x01]), // MPEG-4 audio; audio stream, reserved bit set
                new Uint8Array(3), // bufferSizeDB: unknown
                u32(0, 0), // maxBitrate, avgBitrate: unknown
                descriptor(0x05, audioSpecificConfig), // DecoderSpecificInfo
            ),
            descriptor(0x06, new Uint8Array([0x02])), // SLConfigDescriptor: MP4 predefined
        ),
    );

    // channelConfig 0 defers to an in-stream element; 7 means 7.1.
    const channelCount = channelConfig === 0 ? 2 : channelConfig === 7 ? 8 : channelConfig;
    const mp4a = box(
        "mp4a",
        new Uint8Array(6), // reserved
        u16(1), // data_reference_index
        new Uint8Array(8), // reserved
        u16(channelCount, 16, 0, 0), // channelcount, samplesize, pre_defined, reserved
        // 16.16 fixed point; rates above 65535 Hz don't fit and are left to the esds.
        u32(sampleRate <= 0xffff ? sampleRate * 0x10000 : 0),
        esds,
    );
    return fullBox("stsd", 0, 0, u32(1), mp4a);
}

/**
 * Rewrap an ADTS byte range as a self-contained M4A: the frames' payloads,
 * headers stripped, become the samples of one AAC track. Peak memory is the
 * input plus the output.
 *
 * @throws AppError(AUDIO_UNSUPPORTED) as `parseAdtsFrames` does.
 */
export function adtsToM4a(bytes: Uint8Array): Uint8Array {
    const { config, frames } = parseAdtsFrames(bytes);

    const sizes = new Uint32Array(frames.length);
    // Views of the input: writeM4a copies them once, into the output.
    const payload = frames.map((frame, i) => {
        sizes[i] = frame.length - frame.headerSize;
        return bytes.subarray(frame.offset + frame.headerSize, frame.offset + frame.length);
    });

    return writeM4a({
        stsd: buildAacStsd(config),
        timescale: config.sampleRate,
        language: LANGUAGE_UND,
        sizes,
        durations: new Uint32Array(frames.length).fill(ADTS_SAMPLES_PER_FRAME),
        payload,
    });
}
