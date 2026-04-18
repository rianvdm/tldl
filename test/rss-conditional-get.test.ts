import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fetchFeedIfChanged } from "../src/services/rss";

const SAMPLE_FEED = `<?xml version="1.0"?>
<rss version="2.0"><channel><title>Test</title>
<item><title>E1</title><guid>g1</guid><pubDate>Mon, 01 Jan 2026 00:00:00 GMT</pubDate>
<enclosure url="https://example.com/a.mp3" type="audio/mpeg" length="1"/>
</item></channel></rss>`;

describe("fetchFeedIfChanged", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let fetchSpy: any;

    beforeEach(() => {
        fetchSpy = vi.spyOn(global, "fetch");
    });

    afterEach(() => {
        fetchSpy.mockRestore();
    });

    it("returns ok with feed + headers on 200", async () => {
        fetchSpy.mockResolvedValueOnce(new Response(SAMPLE_FEED, {
            status: 200,
            headers: { "ETag": "\"abc\"", "Last-Modified": "Mon, 01 Jan 2026 00:00:00 GMT" },
        }));

        const result = await fetchFeedIfChanged("https://feed/", {});
        expect(result.status).toBe("ok");
        if (result.status === "ok") {
            expect(result.etag).toBe("\"abc\"");
            expect(result.lastModified).toBe("Mon, 01 Jan 2026 00:00:00 GMT");
            expect(result.feed.episodes.length).toBe(1);
        }
    });

    it("sends If-None-Match and If-Modified-Since when headers are present", async () => {
        fetchSpy.mockResolvedValueOnce(new Response("", { status: 304 }));

        await fetchFeedIfChanged("https://feed/", {
            etag: "\"abc\"",
            lastModified: "Mon, 01 Jan 2026 00:00:00 GMT",
        });

        const call = fetchSpy.mock.calls[0];
        const init = call[1] as RequestInit;
        const headers = new Headers(init.headers);
        expect(headers.get("If-None-Match")).toBe("\"abc\"");
        expect(headers.get("If-Modified-Since")).toBe("Mon, 01 Jan 2026 00:00:00 GMT");
    });

    it("returns not_modified on 304", async () => {
        fetchSpy.mockResolvedValueOnce(new Response("", { status: 304 }));
        const result = await fetchFeedIfChanged("https://feed/", { etag: "\"abc\"" });
        expect(result.status).toBe("not_modified");
    });

    it("returns error on 429", async () => {
        fetchSpy.mockResolvedValueOnce(new Response("", { status: 429 }));
        const result = await fetchFeedIfChanged("https://feed/", {});
        expect(result.status).toBe("error");
        if (result.status === "error") expect(result.reason).toMatch(/429|rate/i);
    });

    it("returns error on network failure", async () => {
        fetchSpy.mockRejectedValueOnce(new Error("boom"));
        const result = await fetchFeedIfChanged("https://feed/", {});
        expect(result.status).toBe("error");
    });
});
