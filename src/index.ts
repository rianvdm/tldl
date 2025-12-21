import { Hono } from "hono";
import { html } from "hono/html";
import type { HonoEnv } from "./types";
import { parseApplePodcastsUrl, deriveEpisodeId } from "./lib/url-parser";
import { transcribeAudio, validateAudioUrl } from "./services/transcription";
import { getEpisodeMetadata } from "./services/apple-podcasts";
import { generateSummary } from "./services/summarization";
import { CSS } from "./lib/styles";
import { APPLE_PODCASTS_BADGE, FAVICON_SVG } from "./lib/assets";
import { AppError, logError } from "./lib/errors";
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

// ============================================================================
// Security Headers Middleware (applies to all routes)
// ============================================================================

app.use("*", async (c, next) => {
    await next();

    // Security headers for all responses
    c.res.headers.set("X-Content-Type-Options", "nosniff");
    c.res.headers.set("X-Frame-Options", "DENY");
    c.res.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");

    // Content Security Policy for HTML responses
    const contentType = c.res.headers.get("Content-Type") || "";
    if (contentType.includes("text/html")) {
        c.res.headers.set(
            "Content-Security-Policy",
            "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'"
        );
    }
});

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

    // Serve Apple Podcasts badge
    app.get("/apple-podcasts-badge.svg", () => {
        return new Response(APPLE_PODCASTS_BADGE, {
            headers: {
                "Content-Type": "image/svg+xml",
                "Cache-Control": "public, max-age=86400",
            },
        });
    });

    // Serve favicon
    app.get("/favicon.svg", () => {
        return new Response(FAVICON_SVG, {
            headers: {
                "Content-Type": "image/svg+xml",
                "Cache-Control": "public, max-age=86400",
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

    // Debug route for transcription (disabled in production - calls OpenAI API)
    app.get("/debug/transcribe", async (c) => {
        // Block in production to prevent unauthorized OpenAI API usage
        if (c.env.ENVIRONMENT !== "development") {
            return c.json({ error: "Debug routes are disabled in production" }, 403);
        }

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
            const metadata = await getEpisodeMetadata(parsed, { maxMinutes: 80, env: c.env });
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

    // Debug route for summarization (disabled in production - calls OpenAI API)
    app.get("/debug/summarize", async (c) => {
        // Block in production to prevent unauthorized OpenAI API usage
        if (c.env.ENVIRONMENT !== "development") {
            return c.json({ error: "Debug routes are disabled in production" }, 403);
        }

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

    // ============================================================================
    // Global Error Handler
    // ============================================================================

    app.onError((err, c) => {
        // Log the error with context
        logError(err, {
            url: c.req.url,
            requestId: c.req.header("cf-ray"),
        });

        // Determine if this is an API request (expects JSON)
        const isApiRequest = c.req.path.startsWith("/api/") ||
            c.req.header("Accept")?.includes("application/json");

        if (err instanceof AppError) {
            if (isApiRequest) {
                return c.json(err.toJSON(), err.httpStatus as 400);
            }
            // Return HTML error page for browser requests
            return c.html(ErrorPage({
                title: `Error`,
                message: err.userMessage,
                showRetry: true,
            }), err.httpStatus as 400);
        }

        // Unknown error - return generic message
        if (isApiRequest) {
            return c.json({
                code: "UNKNOWN_ERROR",
                message: "Something went wrong. Please try again later.",
            }, 500);
        }

        return c.html(ErrorPage({
            title: "Something went wrong",
            message: "An unexpected error occurred. Please try again later.",
            showRetry: true,
        }), 500);
    });

    // ============================================================================
    // 404 Handler
    // ============================================================================

    app.notFound((c) => {
        const isApiRequest = c.req.path.startsWith("/api/") ||
            c.req.header("Accept")?.includes("application/json");

        if (isApiRequest) {
            return c.json({
                code: "NOT_FOUND",
                message: "The requested resource was not found.",
            }, 404);
        }

        return c.html(ErrorPage({
            title: "Page not found",
            message: "The page you're looking for doesn't exist.",
            showRetry: false,
        }), 404);
    });
} // End of if (!MAINTENANCE_MODE)

// ============================================================================
// Error Page Component
// ============================================================================

function ErrorPage(props: { title: string; message: string; showRetry: boolean }) {
    return html`<!DOCTYPE html>
        <html lang="en" class="dark">
            <head>
                <meta charset="UTF-8" />
                <meta name="viewport" content="width=device-width, initial-scale=1.0" />
                <title>${props.title} - TLDL</title>
                <link rel="stylesheet" href="/styles.css" />
            </head>
            <body>
                <div class="container">
                    <nav class="nav">
                        <a href="/" class="nav-brand">TL;DL</a>
                        <span class="nav-tagline">Too Long Didn't Listen</span>
                    </nav>
                    <main class="main">
                        <div class="error-page">
                            <div class="error-icon">
                                <svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                                    <circle cx="12" cy="12" r="10"/>
                                    <line x1="12" y1="8" x2="12" y2="12"/>
                                    <line x1="12" y1="16" x2="12.01" y2="16"/>
                                </svg>
                            </div>
                            <h1>${props.title}</h1>
                            <p class="error-message">${props.message}</p>
                            <div class="error-actions">
                                <a href="/" class="button button-primary">Go Home</a>
                                ${props.showRetry ? html`<button onclick="location.reload()" class="button">Try Again</button>` : ""}
                            </div>
                        </div>
                    </main>
                    <footer class="footer">
                        <p>TL;DL uses AI to generate summaries from podcast transcripts.</p>
                    </footer>
                </div>
            </body>
        </html>`;
}

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
