/**
 * ADTS (raw AAC stream) parsing.
 *
 * An ADTS stream is a run of AAC frames, each with a 7-byte header (9 with a
 * CRC) carrying a 12-bit 0xFFF sync word, the stream parameters and the frame
 * length. OpenAI rejects raw ADTS, so it has to be rewrapped as M4A (#53).
 */

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
