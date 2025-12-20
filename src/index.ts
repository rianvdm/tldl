import { Hono } from "hono";
import type { Env, HonoEnv, QueueMessage } from "./types";
import { parseApplePodcastsUrl, deriveEpisodeId } from "./lib/url-parser";

// Create the Hono app
const app = new Hono<HonoEnv>();

// ============================================================================
// Public Routes
// ============================================================================

// Home page - placeholder until UI is implemented
app.get("/", (c) => {
    return c.text("TLDL - Coming Soon");
});

// Health check endpoint
app.get("/health", (c) => {
    return c.json({ status: "ok", timestamp: new Date().toISOString() });
});

// Debug route for URL parsing (will be removed in production)
app.get("/debug/parse", (c) => {
    const url = c.req.query("url");
    if (!url) {
        return c.json({ error: "Missing url query parameter" }, 400);
    }
    const parsed = parseApplePodcastsUrl(url);
    const storageId = parsed
        ? deriveEpisodeId(parsed.podcastId, parsed.episodeId)
        : null;
    return c.json({ parsed, storageId });
});


// ============================================================================
// Queue Consumer (placeholder)
// ============================================================================

const queueHandler = {
    async queue(
        batch: MessageBatch<QueueMessage>,
        _env: Env
    ): Promise<void> {
        for (const message of batch.messages) {
            console.log(`Processing job: ${message.body.jobId}`);
            // Queue processing will be implemented in Prompt 9
            message.ack();
        }
    },
};

// ============================================================================
// Export handlers
// ============================================================================

export default {
    fetch: app.fetch,
    queue: queueHandler.queue,
};
