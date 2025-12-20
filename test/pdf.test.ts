/**
 * PDF Generation Tests
 */

import { describe, it, expect } from "vitest";
import { generateEpisodePdf, type PdfContent } from "../src/services/pdf";

describe("PDF Generation", () => {
    const sampleContent: PdfContent = {
        podcastName: "The Test Podcast",
        episodeTitle: "Episode 1: Introduction to Testing",
        episodeDate: "2024-01-15T00:00:00Z",
        episodeDuration: 2700, // 45 minutes
        summary: `## Key Takeaways

This is a **test summary** with some markdown formatting.

- First bullet point
- Second bullet point

### Practical Steps

1. Do this first
2. Then do this

> A notable quote from the episode.`,
        summaryTemplate: "Key Takeaways & Practical Steps",
        transcript: "This is the full transcript of the episode. It contains all the spoken words from the podcast episode, which can be quite long for a 45 minute episode.",
        expiresAt: "2025-01-15T00:00:00Z",
    };

    it("generates a valid PDF buffer", () => {
        const result = generateEpisodePdf(sampleContent);

        expect(result).toBeInstanceOf(ArrayBuffer);
        expect(result.byteLength).toBeGreaterThan(0);
    });

    it("generates PDF with correct header bytes", () => {
        const result = generateEpisodePdf(sampleContent);
        const bytes = new Uint8Array(result);

        // PDF files start with %PDF-
        const header = String.fromCharCode(...bytes.slice(0, 5));
        expect(header).toBe("%PDF-");
    });

    it("handles empty summary gracefully", () => {
        const contentWithEmptySummary: PdfContent = {
            ...sampleContent,
            summary: "",
        };

        const result = generateEpisodePdf(contentWithEmptySummary);
        expect(result).toBeInstanceOf(ArrayBuffer);
        expect(result.byteLength).toBeGreaterThan(0);
    });

    it("handles empty transcript gracefully", () => {
        const contentWithEmptyTranscript: PdfContent = {
            ...sampleContent,
            transcript: "",
        };

        const result = generateEpisodePdf(contentWithEmptyTranscript);
        expect(result).toBeInstanceOf(ArrayBuffer);
        expect(result.byteLength).toBeGreaterThan(0);
    });

    it("handles long content that spans multiple pages", () => {
        const longTranscript = "This is a test sentence. ".repeat(500);
        const contentWithLongTranscript: PdfContent = {
            ...sampleContent,
            transcript: longTranscript,
        };

        const result = generateEpisodePdf(contentWithLongTranscript);
        expect(result).toBeInstanceOf(ArrayBuffer);
        // Long content should produce a larger PDF
        expect(result.byteLength).toBeGreaterThan(5000);
    });

    it("handles special characters in content", () => {
        const contentWithSpecialChars: PdfContent = {
            ...sampleContent,
            podcastName: "Podcast with émojis 🎙️ & spëcial chars",
            episodeTitle: "Episode: Testing <special> \"characters\" & more",
        };

        const result = generateEpisodePdf(contentWithSpecialChars);
        expect(result).toBeInstanceOf(ArrayBuffer);
        expect(result.byteLength).toBeGreaterThan(0);
    });
});
