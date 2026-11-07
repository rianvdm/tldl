import { describe, it, expect, vi, afterEach } from "vitest";
import { parseAppleShowPage, fetchAppleEpisodeUrls } from "../src/services/apple-show-page";

/**
 * Mirrors the shape of podcasts.apple.com/us/podcast/id{X} as of 2026-11:
 * episode objects (with guid + storeUrl) nested deep inside the JSON in
 * <script id="serialized-server-data">, and the same episode listed twice.
 */
function showPage(episodes: Array<{ guid: string; storeUrl: string }>): string {
    const data = [{
        data: {
            shelves: [
                { items: episodes.map(e => ({ title: "t", episodeType: "full", ...e, mediaType: "audio" })) },
                { items: episodes.slice(0, 1) }, // "latest episode" shelf repeats the newest
            ],
        },
    }];
    return `<!DOCTYPE html><html><head><title>Show</title></head><body>
<script type="application/json" id="serialized-server-data">${JSON.stringify(data)}</script>
</body></html>`;
}

const DECODER = [
    { guid: "f1f35564-cfc6-11f0-83c5-a7f2be8f1462", storeUrl: "https://podcasts.apple.com/us/podcast/the-hidden-supply-chain-costs-of-the-ai-boom/id1011668648?i=1000800023647" },
    { guid: "substack:post:223203725", storeUrl: "https://podcasts.apple.com/us/podcast/scaling-slack/id1769051199?i=1000800061661" },
];

describe("parseAppleShowPage", () => {
    it("maps each episode GUID to its Apple episode URL", () => {
        const urls = parseAppleShowPage(showPage(DECODER));
        expect(urls.size).toBe(2);
        expect(urls.get("f1f35564-cfc6-11f0-83c5-a7f2be8f1462")).toBe(DECODER[0].storeUrl);
        expect(urls.get("substack:post:223203725")).toBe(DECODER[1].storeUrl);
    });

    it("ignores storeUrls that are not episode URLs", () => {
        const urls = parseAppleShowPage(showPage([
            { guid: "show-guid", storeUrl: "https://podcasts.apple.com/us/podcast/decoder/id1011668648" },
        ]));
        expect(urls.size).toBe(0);
    });

    it("returns an empty map when the data block is missing or malformed", () => {
        expect(parseAppleShowPage("<html><body>nothing here</body></html>").size).toBe(0);
        expect(parseAppleShowPage('<script type="application/json" id="serialized-server-data">{not json</script>').size).toBe(0);
    });
});

describe("fetchAppleEpisodeUrls", () => {
    afterEach(() => vi.restoreAllMocks());

    it("fetches the show page for the podcast and parses it", async () => {
        const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(showPage(DECODER)));

        const urls = await fetchAppleEpisodeUrls("1011668648");

        expect(fetchSpy.mock.calls[0][0]).toBe("https://podcasts.apple.com/us/podcast/id1011668648");
        expect(urls.get("substack:post:223203725")).toBe(DECODER[1].storeUrl);
    });

    it("returns an empty map on a non-200 response rather than throwing", async () => {
        vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("blocked", { status: 403 }));
        expect((await fetchAppleEpisodeUrls("1011668648")).size).toBe(0);
    });

    it("returns an empty map when the request fails", async () => {
        vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network down"));
        expect((await fetchAppleEpisodeUrls("1011668648")).size).toBe(0);
    });
});
