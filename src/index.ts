import { Hono } from "hono";
import type { Env, HonoEnv, QueueMessage } from "./types";
import { parseApplePodcastsUrl, deriveEpisodeId } from "./lib/url-parser";
import { transcribeAudio, validateAudioUrl } from "./services/transcription";
import { getEpisodeMetadata } from "./services/apple-podcasts";
import { generateSummary } from "./services/summarization";

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

// Debug route for audio validation (will be removed in production)
app.get("/debug/validate-audio", async (c) => {
    const audioUrl = c.req.query("url");
    if (!audioUrl) {
        return c.json({ error: "Missing url query parameter" }, 400);
    }
    try {
        const validation = await validateAudioUrl(audioUrl);
        return c.json({
            valid: true,
            ...validation,
            sizeMB: (validation.contentLength / 1024 / 1024).toFixed(2),
        });
    } catch (error) {
        return c.json({
            valid: false,
            error: error instanceof Error ? error.message : "Unknown error",
        }, 400);
    }
});

// Debug route for transcription (will be removed in production)
app.get("/debug/transcribe", async (c) => {
    const audioUrl = c.req.query("url");
    const full = c.req.query("full") === "true";
    if (!audioUrl) {
        return c.json({ error: "Missing url query parameter" }, 400);
    }

    try {
        const result = await transcribeAudio(audioUrl, c.env.OPENAI_API_KEY);
        return c.json({
            success: true,
            source: result.source,
            textLength: result.text.length,
            text: full ? result.text : undefined,
            textPreview: full ? undefined : result.text.substring(0, 500) + (result.text.length > 500 ? "..." : ""),
        });
    } catch (error) {
        return c.json({
            success: false,
            error: error instanceof Error ? error.message : "Unknown error",
        }, 500);
    }
});

// Debug route for episode metadata (will be removed in production)
app.get("/debug/episode", async (c) => {
    const url = c.req.query("url");
    if (!url) {
        return c.json({ error: "Missing url query parameter" }, 400);
    }

    const parsed = parseApplePodcastsUrl(url);
    if (!parsed) {
        return c.json({ error: "Invalid Apple Podcasts URL" }, 400);
    }

    try {
        const metadata = await getEpisodeMetadata(parsed, 80);
        return c.json({
            success: true,
            storageId: deriveEpisodeId(parsed.podcastId, parsed.episodeId),
            ...metadata,
        });
    } catch (error) {
        return c.json({
            success: false,
            error: error instanceof Error ? error.message : "Unknown error",
        }, 500);
    }
});

// Debug route for summarization (will be removed in production)
app.get("/debug/summarize", async (c) => {
    const text = c.req.query("text");
    const template = c.req.query("template") || "key-takeaways";

    if (!text) {
        return c.json({ error: "Missing text query parameter" }, 400);
    }

    try {
        const result = await generateSummary(text, template, c.env.OPENAI_API_KEY);
        return c.json({
            success: true,
            model: result.model,
            template,
            summaryLength: result.text.length,
            summary: result.text,
        });
    } catch (error) {
        return c.json({
            success: false,
            error: error instanceof Error ? error.message : "Unknown error",
        }, 500);
    }
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
