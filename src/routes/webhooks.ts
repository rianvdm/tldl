import { Hono } from "hono";
import type { Env } from "../types";
import { markBounced, markComplained } from "../lib/db";
import { constantTimeEqual } from "../lib/emailTokens";

export const webhookRoutes = new Hono<{ Bindings: Env }>();

function checkBasicAuth(header: string | undefined, expected: string): boolean {
    if (!header?.startsWith("Basic ")) return false;
    const encoded = header.slice(6);
    let decoded: string;
    try { decoded = atob(encoded); } catch { return false; }
    return constantTimeEqual(decoded, expected);
}

interface PostmarkEvent {
    RecordType: string;
    Type?: string;
    Email?: string;
    Recipient?: string;
    SuppressSending?: boolean;
}

webhookRoutes.post("/webhooks/postmark", async (c) => {
    const auth = c.req.header("authorization");
    if (!checkBasicAuth(auth, c.env.POSTMARK_WEBHOOK_AUTH)) return c.text("Unauthorized", 401);

    let event: PostmarkEvent;
    try {
        event = await c.req.json<PostmarkEvent>();
    } catch {
        return c.text("Bad request", 400);
    }

    const now = Math.floor(Date.now() / 1000);
    const email = (event.Email || event.Recipient || "").toLowerCase();

    if (!email) return c.text("OK", 200);

    if (event.RecordType === "Bounce" && event.Type === "HardBounce") {
        await markBounced(c.env.DB, email, now);
    } else if (event.RecordType === "SpamComplaint") {
        await markComplained(c.env.DB, email, now);
    } else if (event.RecordType === "SubscriptionChange" && event.SuppressSending === true) {
        // markComplained already deletes all subscriptions via email lookup; no extra call needed.
        await markComplained(c.env.DB, email, now);
    }
    // All other events (soft bounces, opens, clicks, etc.) are ignored.

    return c.text("OK", 200);
});
