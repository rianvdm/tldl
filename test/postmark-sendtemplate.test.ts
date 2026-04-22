import { describe, it, expect, vi, beforeEach } from "vitest";
import { sendTemplate } from "../src/services/postmark";

describe("sendTemplate", () => {
    beforeEach(() => vi.restoreAllMocks());

    it("posts to /email/withTemplate with the right payload", async () => {
        const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
            new Response(JSON.stringify({ MessageID: "abc" }), { status: 200 })
        );
        const result = await sendTemplate("server-token", {
            from: "a@b.com",
            to: "c@d.com",
            templateAlias: "confirm-subscription",
            templateModel: { confirmUrl: "https://x", podcastList: "X", expiresIn: "48 hours" },
            messageStream: "tldl",
        });
        expect(result).toEqual({ success: true });
        expect(fetchSpy).toHaveBeenCalledWith(
            "https://api.postmarkapp.com/email/withTemplate",
            expect.objectContaining({
                method: "POST",
                headers: expect.objectContaining({ "X-Postmark-Server-Token": "server-token" }),
            })
        );
        const body = JSON.parse((fetchSpy.mock.calls[0]![1] as RequestInit).body as string);
        expect(body).toEqual({
            From: "a@b.com",
            To: "c@d.com",
            TemplateAlias: "confirm-subscription",
            TemplateModel: { confirmUrl: "https://x", podcastList: "X", expiresIn: "48 hours" },
            MessageStream: "tldl",
        });
    });

    it("returns success:false on non-2xx", async () => {
        vi.spyOn(globalThis, "fetch").mockResolvedValue(
            new Response(JSON.stringify({ ErrorCode: 10, Message: "bad" }), { status: 422 })
        );
        const result = await sendTemplate("t", {
            from: "a@b.com", to: "c@d.com",
            templateAlias: "x", templateModel: {}, messageStream: "tldl",
        });
        expect(result.success).toBe(false);
        expect(result.errorMessage).toBe("bad");
    });

    it("returns success:false on fetch throw", async () => {
        vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("net"));
        const result = await sendTemplate("t", {
            from: "a@b.com", to: "c@d.com",
            templateAlias: "x", templateModel: {}, messageStream: "tldl",
        });
        expect(result.success).toBe(false);
    });
});
