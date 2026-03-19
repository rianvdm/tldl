/**
 * Tests for YouTube service
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fetchYouTubeEpisodeData, parseCaptionXml } from "../src/services/youtube";
import { ERROR_CODES } from "../src/lib/constants";

function makePlayerResponse(overrides: Record<string, unknown> = {}): string {
    const base = {
        videoDetails: {
            title: "Test Video Title",
            author: "Test Channel",
            lengthSeconds: "3600",
        },
        microformat: {
            playerMicroformatRenderer: {
                publishDate: "2024-01-15",
            },
        },
        captions: {
            playerCaptionsTracklistRenderer: {
                captionTracks: [
                    {
                        baseUrl: "https://www.youtube.com/api/timedtext?v=test&lang=en",
                        languageCode: "en",
                        kind: "asr",
                        name: { simpleText: "English (auto-generated)" },
                    },
                ],
            },
        },
        ...overrides,
    };
    return `var ytInitialPlayerResponse = ${JSON.stringify(base)};`;
}

const sampleCaptionXml = `<?xml version="1.0" encoding="utf-8" ?><transcript><text start="0.5" dur="2.3">Hello &amp; welcome</text><text start="3.0" dur="1.5"><b>to</b> this <c>video</c></text></transcript>`;

describe("fetchYouTubeEpisodeData", () => {
    beforeEach(() => {
        vi.stubGlobal("fetch", vi.fn());
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("should return metadata and transcript for a video with captions", async () => {
        const mockFetch = vi.fn()
            .mockResolvedValueOnce({ ok: true, text: async () => makePlayerResponse() })
            .mockResolvedValueOnce({ ok: true, text: async () => sampleCaptionXml });
        vi.stubGlobal("fetch", mockFetch);

        const result = await fetchYouTubeEpisodeData("testVideoId");

        expect(result.videoTitle).toBe("Test Video Title");
        expect(result.channelName).toBe("Test Channel");
        expect(result.durationSeconds).toBe(3600);
        expect(result.publishDate).toBe("2024-01-15");
        expect(result.transcriptText).toContain("Hello & welcome");
        expect(result.transcriptText).toContain("to this");
        expect(result.transcriptText).not.toContain("<b>");
        expect(result.transcriptText).not.toContain("<c>");
        expect(result.transcriptText).not.toContain("&amp;");
    });

    it("should prefer manually-uploaded track over auto-generated", async () => {
        const playerResponse = makePlayerResponse({
            captions: {
                playerCaptionsTracklistRenderer: {
                    captionTracks: [
                        {
                            baseUrl: "https://youtube.com/timedtext?lang=en&kind=asr",
                            languageCode: "en",
                            kind: "asr",
                            name: { simpleText: "English (auto-generated)" },
                        },
                        {
                            baseUrl: "https://youtube.com/timedtext?lang=en-US",
                            languageCode: "en-US",
                            name: { simpleText: "English (United States)" },
                        },
                    ],
                },
            },
        });

        const mockFetch = vi.fn()
            .mockResolvedValueOnce({ ok: true, text: async () => playerResponse })
            .mockResolvedValueOnce({ ok: true, text: async () => sampleCaptionXml });
        vi.stubGlobal("fetch", mockFetch);

        await fetchYouTubeEpisodeData("testVideoId");

        const captionFetchUrl = mockFetch.mock.calls[1][0] as string;
        expect(captionFetchUrl).toContain("en-US");
        expect(captionFetchUrl).not.toContain("kind=asr");
    });

    it("should throw FETCH_FAILED if page cannot be parsed", async () => {
        vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
            ok: true,
            text: async () => "<html>Some page without player response</html>",
        }));

        await expect(fetchYouTubeEpisodeData("badVideoId"))
            .rejects.toMatchObject({ code: ERROR_CODES.FETCH_FAILED });
    });

    it("should throw TRANSCRIPTION_FAILED if no captionTracks present", async () => {
        const playerResponse = makePlayerResponse({
            captions: {
                playerCaptionsTracklistRenderer: { captionTracks: [] },
            },
        });
        vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
            ok: true,
            text: async () => playerResponse,
        }));

        await expect(fetchYouTubeEpisodeData("noCaptionsId"))
            .rejects.toMatchObject({ code: ERROR_CODES.TRANSCRIPTION_FAILED });
    });

    it("should throw TRANSCRIPTION_FAILED if caption fetch fails", async () => {
        const mockFetch = vi.fn()
            .mockResolvedValueOnce({ ok: true, text: async () => makePlayerResponse() })
            .mockResolvedValueOnce({ ok: false, status: 403, text: async () => "Forbidden" });
        vi.stubGlobal("fetch", mockFetch);

        await expect(fetchYouTubeEpisodeData("expiredCaptionId"))
            .rejects.toMatchObject({ code: ERROR_CODES.TRANSCRIPTION_FAILED });
    });
});

describe("parseCaptionXml", () => {
    it("should strip XML tags and decode HTML entities", () => {
        const xml = `<transcript><text start="0">Hello &amp; world</text><text start="1"><b>bold</b> and <c>timed</c></text></transcript>`;
        const result = parseCaptionXml(xml);
        expect(result).toBe("Hello & world bold and timed");
    });

    it("should handle empty transcript", () => {
        expect(parseCaptionXml("<transcript></transcript>")).toBe("");
    });

    it("should strip <font> tags", () => {
        const xml = `<transcript><text start="0"><font color="#ccc">colored text</font></text></transcript>`;
        expect(parseCaptionXml(xml)).toBe("colored text");
    });
});
