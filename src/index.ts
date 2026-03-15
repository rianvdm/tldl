import { Hono } from "hono";
import { html } from "hono/html";
import type { HonoEnv } from "./types";
import { parseApplePodcastsUrl, deriveEpisodeId } from "./lib/url-parser";
import { transcribeAudio, validateAudioUrl } from "./services/transcription";
import { getEpisodeMetadata } from "./services/apple-podcasts";
import { generateSummary } from "./services/summarization";
import { rebuildEpisodeIndex } from "./lib/kv";
import { CSS } from "./lib/styles";
import { APPLE_PODCASTS_BADGE, FAVICON_SVG, APPLE_TOUCH_ICON_PNG_BASE64, WEB_MANIFEST } from "./lib/assets";
import { AppError, logError } from "./lib/errors";
import api from "./routes/api";
import admin from "./routes/admin";
import publicRoutes from "./routes/public";
import queueConsumer from "./queue/consumer";
import { Footer } from "./lib/components";
import { checkAllPodcasts } from "./lib/monitor";
import { appendActivityEvent } from "./lib/kv";
import { notifyDiscord, DISCORD_COLORS } from "./lib/discord";
import type { Env } from "./types";

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
            "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline' https://challenges.cloudflare.com; frame-src https://challenges.cloudflare.com; img-src 'self' data:; font-src 'self'"
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

    // Serve Apple touch icon (for iOS "Add to Home Screen")
    app.get("/apple-touch-icon.png", () => {
        const pngBuffer = Uint8Array.from(atob(APPLE_TOUCH_ICON_PNG_BASE64), c => c.charCodeAt(0));
        return new Response(pngBuffer, {
            headers: {
                "Content-Type": "image/png",
                "Cache-Control": "public, max-age=86400",
            },
        });
    });

    // Health check endpoint
    app.get("/health", (c) => {
        return c.json({ status: "ok", timestamp: new Date().toISOString() });
    });

    // Serve robots.txt
    app.get("/robots.txt", () => {
        const robotsTxt = `User-agent: *
Allow: /
Disallow: /admin/
Disallow: /debug/
`;
        return new Response(robotsTxt, {
            headers: {
                "Content-Type": "text/plain",
                "Cache-Control": "public, max-age=86400",
            },
        });
    });

    // Serve web manifest (for PWA "Add to Home Screen")
    app.get("/manifest.webmanifest", () => {
        return new Response(WEB_MANIFEST, {
            headers: {
                "Content-Type": "application/manifest+json",
                "Cache-Control": "public, max-age=86400",
            },
        });
    });

    // Debug route for URL parsing (disabled in production)
    app.get("/debug/parse", (c) => {
        if (c.env.ENVIRONMENT !== "development") {
            return c.json({ error: "Debug routes are disabled in production" }, 403);
        }

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

    // Debug route for audio validation (disabled in production)
    app.get("/debug/validate-audio", async (c) => {
        if (c.env.ENVIRONMENT !== "development") {
            return c.json({ error: "Debug routes are disabled in production" }, 403);
        }

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

    // Debug route for episode metadata (disabled in production - calls external APIs)
    app.get("/debug/episode", async (c) => {
        if (c.env.ENVIRONMENT !== "development") {
            return c.json({ error: "Debug routes are disabled in production" }, 403);
        }

        const url = c.req.query("url");
        if (!url) {
            return c.json({ error: "Missing url query parameter" }, 400);
        }

        const parsed = parseApplePodcastsUrl(url);
        if (!parsed) {
            return c.json({ error: "Invalid Apple Podcasts URL" }, 400);
        }

        try {
            const metadata = await getEpisodeMetadata(parsed, { maxMinutes: 121, env: c.env });
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

    // Debug route for rebuilding episode index (one-time migration)
    app.post("/debug/rebuild-index", async (c) => {
        // Disabled in production — use POST /admin/rebuild-index instead
        if (c.env.ENVIRONMENT !== "development") {
            return c.json({ error: "Debug routes are disabled in production. Use POST /admin/rebuild-index instead." }, 403);
        }

        try {
            const count = await rebuildEpisodeIndex(c.env.TLDL_DATA);
            return c.json({
                success: true,
                message: `Episode index rebuilt successfully`,
                episodeCount: count,
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
    // Admin Routes (protected by Cloudflare Access in production)
    // ============================================================================

    // Admin routes (protected by Cloudflare Access: /admin and /admin/* paths)
    app.route("/admin", admin);

    // ============================================================================
    // Public HTML Routes
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
                        <a href="/" class="nav-brand">TL;D<span class="text-accent">L</span></a>
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
                    ${Footer}
                </div>
            </body>
        </html>`;
}

// ============================================================================
// Export Durable Object class (required by Cloudflare)
// ============================================================================

export { JobStatusDO } from "./durable-objects/job-status";

// ============================================================================
// Scheduled Handler (for cron-triggered podcast monitoring)
// ============================================================================

async function scheduledHandler(
    controller: ScheduledController,
    env: Env,
    _ctx: ExecutionContext
): Promise<void> {
    console.log(JSON.stringify({
        event: "scheduled_handler_started",
        trigger: controller.cron,
        scheduledTime: new Date(controller.scheduledTime).toISOString(),
    }));

    try {
        const result = await checkAllPodcasts(env);
        console.log(JSON.stringify({
            event: "scheduled_handler_complete",
            checked: result.checked,
            totalNewEpisodes: result.totalNewEpisodes,
            errors: result.errors.length,
        }));

        // Log monitoring check to activity log and notify Discord on errors
        if (result.errors.length > 0) {
            const errorSummary = result.errors.join("; ");
            await appendActivityEvent(env.TLDL_DATA, {
                type: "monitor_error",
                timestamp: new Date().toISOString(),
                title: `Monitoring check: ${result.errors.length} error(s) in ${result.checked} podcasts`,
                details: errorSummary,
            });
            await notifyDiscord(env.DISCORD_WEBHOOK_URL, {
                title: `⚠ Monitoring: ${result.errors.length} error(s)`,
                description: `Checked ${result.checked} podcasts.\n\n${errorSummary}`,
                color: DISCORD_COLORS.WARNING,
            });
        } else {
            await appendActivityEvent(env.TLDL_DATA, {
                type: "monitor_check",
                timestamp: new Date().toISOString(),
                title: `Monitoring check: ${result.checked} podcasts, ${result.totalNewEpisodes} new episode(s)`,
            });
        }
    } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        console.error(JSON.stringify({
            event: "scheduled_handler_error",
            error: errorMsg,
        }));

        // Log the error to activity log and notify Discord (best effort)
        try {
            await appendActivityEvent(env.TLDL_DATA, {
                type: "monitor_error",
                timestamp: new Date().toISOString(),
                title: "Monitoring check failed",
                details: errorMsg,
            });
            await notifyDiscord(env.DISCORD_WEBHOOK_URL, {
                title: "🔴 Monitoring check failed",
                description: errorMsg,
                color: DISCORD_COLORS.ERROR,
            });
        } catch {
            // Activity log and Discord are non-critical
        }
    }
}

// ============================================================================
// Export handlers
// ============================================================================

export default {
    fetch: app.fetch,
    queue: queueConsumer.queue,
    scheduled: scheduledHandler,
};
