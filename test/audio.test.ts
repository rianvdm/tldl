/**
 * Tests for audio utilities
 */

import { describe, it, expect } from "vitest";
import {
    calculateChunkRanges,
    requiresChunking,
    estimateTranscriptionTime,
    TARGET_CHUNK_SIZE_BYTES,
    CHUNK_OVERLAP_BYTES,
    MAX_TOTAL_SIZE_BYTES,
} from "../src/lib/audio";

describe("calculateChunkRanges", () => {
    const MB = 1024 * 1024;

    it("should return single chunk for small files", () => {
        const chunks = calculateChunkRanges(10 * MB);

        expect(chunks).toHaveLength(1);
        expect(chunks[0]).toEqual({
            startByte: 0,
            endByte: 10 * MB - 1,
            isFirst: true,
            isLast: true,
            overlapBytes: 0,
        });
    });

    it("should return single chunk for files exactly at limit", () => {
        const chunks = calculateChunkRanges(TARGET_CHUNK_SIZE_BYTES);

        expect(chunks).toHaveLength(1);
        expect(chunks[0].isFirst).toBe(true);
        expect(chunks[0].isLast).toBe(true);
    });

    it("should split files larger than chunk size", () => {
        const totalSize = 50 * MB;
        const chunks = calculateChunkRanges(totalSize);

        expect(chunks.length).toBeGreaterThan(1);

        // First chunk starts at 0 with no overlap
        expect(chunks[0].startByte).toBe(0);
        expect(chunks[0].isFirst).toBe(true);
        expect(chunks[0].overlapBytes).toBe(0);

        // Middle chunks have overlap
        if (chunks.length > 2) {
            expect(chunks[1].overlapBytes).toBe(CHUNK_OVERLAP_BYTES);
            expect(chunks[1].isFirst).toBe(false);
            expect(chunks[1].isLast).toBe(false);
        }

        // Last chunk ends at file end
        const lastChunk = chunks[chunks.length - 1];
        expect(lastChunk.endByte).toBe(totalSize - 1);
        expect(lastChunk.isLast).toBe(true);
    });

    it("should create overlapping ranges", () => {
        const totalSize = 45 * MB;
        const chunks = calculateChunkRanges(totalSize);

        // Check that consecutive chunks overlap
        for (let i = 1; i < chunks.length; i++) {
            const prevEnd = chunks[i - 1].endByte;
            const currStart = chunks[i].startByte;

            // Current chunk should start before previous ended
            expect(currStart).toBeLessThan(prevEnd);

            // Overlap should be approximately CHUNK_OVERLAP_BYTES
            const overlap = prevEnd - currStart + 1;
            expect(overlap).toBeCloseTo(CHUNK_OVERLAP_BYTES, -2); // Within 100 bytes
        }
    });

    it("should throw for files exceeding max size", () => {
        expect(() => {
            calculateChunkRanges(MAX_TOTAL_SIZE_BYTES + 1);
        }).toThrow(/too large/);
    });

    it("should handle custom chunk and overlap sizes", () => {
        const customChunk = 5 * MB;
        const customOverlap = 1 * MB;
        const totalSize = 12 * MB;

        const chunks = calculateChunkRanges(totalSize, customChunk, customOverlap);

        expect(chunks.length).toBeGreaterThan(1);
        expect(chunks[1].overlapBytes).toBe(customOverlap);
    });

    it("should cover entire file without gaps", () => {
        const totalSize = 75 * MB;
        const chunks = calculateChunkRanges(totalSize);

        // Create a coverage map
        const covered = new Set<number>();
        for (const chunk of chunks) {
            for (let b = chunk.startByte; b <= chunk.endByte; b += MB) {
                covered.add(Math.floor(b / MB));
            }
        }

        // Every MB should be covered
        for (let mb = 0; mb < Math.ceil(totalSize / MB); mb++) {
            expect(covered.has(mb)).toBe(true);
        }
    });
});

describe("requiresChunking", () => {
    const MB = 1024 * 1024;

    it("should return false for small files", () => {
        expect(requiresChunking(10 * MB)).toBe(false);
        expect(requiresChunking(24 * MB)).toBe(false);
    });

    it("should return true for files over 25MB", () => {
        expect(requiresChunking(26 * MB)).toBe(true);
        expect(requiresChunking(50 * MB)).toBe(true);
    });

    it("should use custom limit if provided", () => {
        expect(requiresChunking(15 * MB, 10 * MB)).toBe(true);
        expect(requiresChunking(8 * MB, 10 * MB)).toBe(false);
    });
});

describe("estimateTranscriptionTime", () => {
    it("should estimate time based on chunk count", () => {
        const estimate = estimateTranscriptionTime(50 * 1024 * 1024, 3);

        // 3 chunks * 45 seconds + 15 overhead = 150 seconds
        expect(estimate).toBe(150);
    });

    it("should handle single chunk", () => {
        const estimate = estimateTranscriptionTime(10 * 1024 * 1024, 1);

        // 1 chunk * 45 + 15 = 60 seconds
        expect(estimate).toBe(60);
    });
});
