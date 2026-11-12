/**
 * MPEG audio (MP3) frame and VBR header parsing.
 *
 * Pure functions over byte buffers, used to cut MP3 chunks on frame
 * boundaries and to drop the LAME/Xing "Info"/"Xing" or Fraunhofer "VBRI"
 * frame, which declares the whole file's duration and makes gpt-transcribe
 * reject a chunk. Layer III only: podcast MP3s are Layer III, and accepting
 * Layers I/II would only widen the space for false sync words.
 */

// ============================================================================
// Constants
// ============================================================================

/** How far into a chunk's bytes to look for its first confirmed frame. */
export const MP3_RESYNC_WINDOW_BYTES = 16 * 1024;

/** Layer III bitrates in kbps by header index; 0 is free format, 15 is invalid. */
const MPEG1_BITRATES_KBPS = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
/** MPEG-2 and MPEG-2.5 (the "low sampling frequency" extensions) share one table. */
const LSF_BITRATES_KBPS = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];

/** Sample rates by header index; index 3 is reserved. */
const SAMPLE_RATES: Record<Mp3FrameHeader["version"], readonly number[]> = {
    1: [44100, 48000, 32000],
    2: [22050, 24000, 16000],
    2.5: [11025, 12000, 8000],
};

/** Offset of the VBRI tag from the frame start, fixed whatever the channel mode. */
const VBRI_TAG_OFFSET = 36;

// ============================================================================
// Types
// ============================================================================

export interface Mp3FrameHeader {
    version: 1 | 2 | 2.5;
    bitrateKbps: number;
    sampleRate: number;
    channels: 1 | 2;
    padding: boolean;
    /** A 16-bit CRC follows the 4-byte header. */
    crc: boolean;
    /** Whole frame in bytes, header included. */
    frameLength: number;
    samplesPerFrame: 1152 | 576;
}

export type VbrHeaderKind = "xing" | "info" | "vbri";

export interface VbrHeader {
    kind: VbrHeaderKind;
    /** Audio frames the header declares, or null when it carries no count. */
    frames: number | null;
}

export interface Mp3Analysis {
    /** Absolute file offset of the first frame. */
    firstFrameOffset: number;
    /** Absolute offset of the first audio frame (after any VBR header frame). */
    audioStart: number;
    /** The frame at `audioStart`. */
    header: Mp3FrameHeader;
    vbrHeader: VbrHeaderKind | "none";
    /** Duration the VBR header declares, or null without a frame count. */
    declaredSeconds: number | null;
    /** Duration from the bytes after `audioStart` at the bitrate of the frame there. */
    estimatedSeconds: number;
    /** max(declaredSeconds ?? 0, estimatedSeconds) */
    usedSeconds: number;
}

// ============================================================================
// Frame headers
// ============================================================================

/**
 * Parse the 4-byte MPEG audio frame header at `offset`, or return null when
 * it isn't a Layer III header with a usable bitrate and sample rate
 * (free-format bitrates are rejected: their frame length can't be computed).
 */
export function parseMp3FrameHeader(bytes: Uint8Array, offset: number): Mp3FrameHeader | null {
    if (offset < 0 || offset + 4 > bytes.length) return null;
    const b1 = bytes[offset + 1];
    const b2 = bytes[offset + 2];
    const b3 = bytes[offset + 3];

    // Sync: 11 set bits.
    if (bytes[offset] !== 0xff || (b1 & 0xe0) !== 0xe0) return null;

    const versionBits = (b1 >> 3) & 0x03;
    if (versionBits === 0b01) return null; // reserved
    const version = versionBits === 0b11 ? 1 : versionBits === 0b10 ? 2 : 2.5;

    if (((b1 >> 1) & 0x03) !== 0b01) return null; // not Layer III

    const bitrateIndex = b2 >> 4;
    if (bitrateIndex === 0 || bitrateIndex === 15) return null;
    const bitrateKbps = (version === 1 ? MPEG1_BITRATES_KBPS : LSF_BITRATES_KBPS)[bitrateIndex];

    const sampleRateIndex = (b2 >> 2) & 0x03;
    if (sampleRateIndex === 3) return null;
    const sampleRate = SAMPLE_RATES[version][sampleRateIndex];

    const padding = ((b2 >> 1) & 0x01) === 1;
    const channels = b3 >> 6 === 0b11 ? 1 : 2;

    // Bytes per frame = samples per frame / 8 × bitrate / sample rate:
    // 1152 / 8 = 144 for MPEG-1, 576 / 8 = 72 for MPEG-2 and 2.5.
    const coefficient = version === 1 ? 144 : 72;
    const frameLength =
        Math.floor((coefficient * bitrateKbps * 1000) / sampleRate) + (padding ? 1 : 0);

    return {
        version,
        bitrateKbps,
        sampleRate,
        channels,
        padding,
        crc: (b1 & 0x01) === 0, // protection bit 0 means a CRC follows
        frameLength,
        samplesPerFrame: version === 1 ? 1152 : 576,
    };
}

export interface FindMp3FrameOptions {
    /**
     * `bytes` ends where the file ends, so a frame ending exactly at
     * `bytes.length` is the file's last frame and needs no second header.
     * Leave false for a probe or range that stops mid-file: a stray sync word
     * whose computed frame happens to end at the cut would otherwise count.
     */
    bufferEndsFile?: boolean;
}

/**
 * Offset of the first confirmed frame at or after `from` and before `to`
 * (exclusive, default `bytes.length`), or -1 when there is none.
 *
 * `0xFF 0xE?` occurs naturally inside compressed audio, so one header that
 * parses proves nothing. A frame counts only when another header of the same
 * MPEG version and sample rate starts one frame length on, or, with
 * `bufferEndsFile`, when the frame ends exactly at the end of `bytes`.
 */
export function findMp3Frame(
    bytes: Uint8Array,
    from: number,
    to: number = bytes.length,
    { bufferEndsFile = false }: FindMp3FrameOptions = {}
): number {
    const end = Math.min(to, bytes.length - 3);
    for (let i = Math.max(from, 0); i < end; i++) {
        const header = parseMp3FrameHeader(bytes, i);
        if (!header) continue;
        const next = i + header.frameLength;
        if (next === bytes.length && bufferEndsFile) return i;
        const nextHeader = parseMp3FrameHeader(bytes, next);
        if (
            nextHeader &&
            nextHeader.version === header.version &&
            nextHeader.sampleRate === header.sampleRate
        ) {
            return i;
        }
    }
    return -1;
}

// ============================================================================
// VBR headers
// ============================================================================

/**
 * Read a Xing/Info or VBRI header from the frame at `frameOffset`, or return
 * null when the frame is plain audio. Decoders only look for these in a
 * file's first frame, and trust the duration it declares.
 */
export function readVbrHeader(
    bytes: Uint8Array,
    frameOffset: number,
    header: Mp3FrameHeader
): VbrHeader | null {
    const frameEnd = Math.min(frameOffset + header.frameLength, bytes.length);

    // Xing/Info: after the header, the optional CRC and the side information.
    const sideInfoBytes =
        header.version === 1 ? (header.channels === 1 ? 17 : 32) : header.channels === 1 ? 9 : 17;
    const xingTag = frameOffset + 4 + (header.crc ? 2 : 0) + sideInfoBytes;
    const xingKind = asciiAt(bytes, xingTag, frameEnd);
    if (xingKind === "Xing" || xingKind === "Info") {
        // Flags (4 bytes); bit 0 says a 4-byte frame count follows.
        const flags = uint32At(bytes, xingTag + 4, frameEnd);
        const frames =
            flags !== null && (flags & 0x01) !== 0 ? uint32At(bytes, xingTag + 8, frameEnd) : null;
        return { kind: xingKind === "Xing" ? "xing" : "info", frames };
    }

    const vbriTag = frameOffset + VBRI_TAG_OFFSET;
    if (asciiAt(bytes, vbriTag, frameEnd) === "VBRI") {
        // Version (2), delay (2), quality (2), byte count (4), then frame count (4).
        return { kind: "vbri", frames: uint32At(bytes, vbriTag + 14, frameEnd) };
    }

    return null;
}

// ============================================================================
// Analysis
// ============================================================================

/**
 * Find a file's first audio frame and estimate its duration.
 *
 * `probe` holds the file's bytes from absolute offset `probeOffset`, and the
 * scan starts at absolute offset `scanFrom` (usually just past the ID3 tag).
 * When the first frame is a Xing/Info/VBRI frame, audio starts at the frame
 * after it. Returns null when the probe holds no confirmed frame from
 * `scanFrom` on, or nothing but the VBR header frame.
 */
export function analyzeMp3(
    probe: Uint8Array,
    probeOffset: number,
    fileSize: number,
    scanFrom: number
): Mp3Analysis | null {
    const first = findMp3Frame(probe, Math.max(scanFrom - probeOffset, 0), probe.length, {
        bufferEndsFile: probeOffset + probe.length >= fileSize,
    });
    if (first === -1) return null;
    const firstHeader = parseMp3FrameHeader(probe, first)!;

    const vbr = readVbrHeader(probe, first, firstHeader);
    const audio = vbr ? first + firstHeader.frameLength : first;
    const header = vbr ? parseMp3FrameHeader(probe, audio) : firstHeader;
    if (!header) return null;

    const audioStart = probeOffset + audio;
    const declaredSeconds =
        vbr?.frames != null
            ? (vbr.frames * firstHeader.samplesPerFrame) / firstHeader.sampleRate
            : null;
    const estimatedSeconds = ((fileSize - audioStart) * 8) / (header.bitrateKbps * 1000);

    return {
        firstFrameOffset: probeOffset + first,
        audioStart,
        header,
        vbrHeader: vbr ? vbr.kind : "none",
        declaredSeconds,
        estimatedSeconds,
        usedSeconds: Math.max(declaredSeconds ?? 0, estimatedSeconds),
    };
}

// ============================================================================
// Byte helpers
// ============================================================================

/** The 4 ASCII characters at `offset`, or null when they run past `end`. */
function asciiAt(bytes: Uint8Array, offset: number, end: number): string | null {
    if (offset + 4 > end) return null;
    return String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
}

/** Big-endian unsigned 32-bit integer at `offset`, or null when it runs past `end`. */
function uint32At(bytes: Uint8Array, offset: number, end: number): number | null {
    if (offset + 4 > end) return null;
    return (
        ((bytes[offset] << 24) |
            (bytes[offset + 1] << 16) |
            (bytes[offset + 2] << 8) |
            bytes[offset + 3]) >>>
        0
    );
}
