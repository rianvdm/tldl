import { Hono } from "hono";
import type { HonoEnv } from "./types";
import { parseApplePodcastsUrl, deriveEpisodeId } from "./lib/url-parser";
import { transcribeAudio, validateAudioUrl } from "./services/transcription";
import { getEpisodeMetadata } from "./services/apple-podcasts";
import { generateSummary } from "./services/summarization";
import { CSS } from "./lib/styles";
import api from "./routes/api";
import authenticated from "./routes/authenticated";
import publicRoutes from "./routes/public";
import queueConsumer from "./queue/consumer";

// ============================================================================
// MAINTENANCE MODE TOGGLE
// Set to true to disable all HTTP endpoints (prevents API abuse)
// Set to false to enable normal operation
// Queue consumer continues to work regardless
// ============================================================================
const MAINTENANCE_MODE = false;

// Create the Hono app
const app = new Hono<HonoEnv>();

if (MAINTENANCE_MODE) {
    // Return 503 for all requests when in maintenance mode
    app.all("*", (c) => {
        return c.json({
            status: "maintenance",
            message: "Service temporarily unavailable. Public access has been disabled for security.",
        }, 503);
    });
} else {
    // ============================================================================
    // Static Assets
    // ============================================================================

    // Serve CSS styles
    app.get("/styles.css", () => {
        return new Response(CSS, {
            headers: {
                "Content-Type": "text/css",
                "Cache-Control": "public, max-age=3600",
            },
        });
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
    // API Routes
    // ============================================================================

    app.route("/api", api);

    // ============================================================================
    // Authenticated Routes
    // These routes will be protected by Cloudflare Access in production
    // ============================================================================

    app.route("/", authenticated);

    // ============================================================================
    // Public HTML Routes (must be after authenticated to allow overrides)
    // ============================================================================

    app.route("/", publicRoutes);
} // End of if (!MAINTENANCE_MODE)

// ============================================================================
// Export Durable Object class (required by Cloudflare)
// ============================================================================

export { JobStatusDO } from "./durable-objects/job-status";

// ============================================================================
// Export handlers
// ============================================================================

export default {
    fetch: app.fetch,
    queue: queueConsumer.queue,
};
