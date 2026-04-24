import { Hono } from "hono";
import type { Env } from "../types";
import { verifyTurnstile } from "../lib/turnstile";
import { sendTemplate } from "../services/postmark";
import { getMonitoredPodcastIds, getMonitoredPodcast } from "../lib/kv";
import {
    upsertPendingConfirmation,
    hasActivePendingForEmail,
    getSubscriberByEmail,
    getSubscriberById,
    confirmSubscriber,
    listSubscriptionsForSubscriber,
    replaceSubscriptions,
    unsubscribePodcast,
    unsubscribeAll,
} from "../lib/db";
import { signToken, verifyToken, manageMessage, unsubMessage, unsubAllMessage } from "../lib/emailTokens";
import { escapeHtml } from "../lib/auth";
import { Layout } from "./public";
import { renderFormPage } from "../lib/broadsheet/form-page";
import type { EpisodeIndexEntry } from "../types";

export const subscriptionsRoutes = new Hono<{ Bindings: Env }>();

const BASE_URL = "https://tldl-pod.com";
const PENDING_TTL_SECONDS = 48 * 3600;
const MAX_PODCAST_IDS = 50;
const TURNSTILE_SCRIPT = '<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>';
const CHECKBOX_LIST_STYLES = `
    <style>
        .checkbox-list { display: flex; flex-direction: column; gap: 0.75rem; }
        .checkbox-row { display: flex; align-items: flex-start; gap: 0.6rem; cursor: pointer; padding: 0.25rem 0; line-height: 1.3; }
        .checkbox-row input[type="checkbox"] { width: 1.1em; height: 1.1em; margin: 0.28em 0 0 0; flex-shrink: 0; }
        .checkbox-row .podcast-label { display: flex; flex-direction: column; gap: 0.15rem; }
        .checkbox-row .podcast-author { font-size: 0.85em; color: var(--text-muted, #888); line-height: 1.25; }
    </style>`;

function logSendFailure(event: string, email: string, result: { success: boolean; errorMessage?: string }): void {
    if (!result.success) {
        console.error(JSON.stringify({ event, email, errorMessage: result.errorMessage }));
    }
}

function isValidEmail(email: string): boolean {
    if (email.length < 3 || email.length > 254) return false;
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function randomTokenHex(bytes: number): string {
    const buf = new Uint8Array(bytes);
    crypto.getRandomValues(buf);
    let hex = "";
    for (let i = 0; i < buf.length; i++) hex += buf[i].toString(16).padStart(2, "0");
    return hex;
}

function checkInboxPage(message: string): string {
    return `
        <div class="page-header">
            <h1>Please check your inbox</h1>
        </div>
        <div class="card">
            <p>${escapeHtml(message)}</p>
        </div>
    `;
}

async function renderSubscribeBanner(
    env: Env,
    opts: { heading: string; sectionCount: string; pageTitle: string; bannerHtml: string; kind: "ok" | "err" },
): Promise<string> {
    const indexEntries = await env.TLDL_DATA.get<EpisodeIndexEntry[]>("episodes:index", "json") ?? [];
    const bodyHtml = `
<div class="bs-form-banner ${opts.kind}">
${opts.bannerHtml}
</div>
`;
    return renderFormPage({
        activeNav: "subscribe",
        sectionHeading: opts.heading,
        sectionCount: opts.sectionCount,
        bodyHtml,
        pageTitle: opts.pageTitle,
        totalInArchive: indexEntries.length,
    });
}

// ---- GET /subscribe ----
subscriptionsRoutes.get("/subscribe", async (c) => {
    const podcastIds = await getMonitoredPodcastIds(c.env.TLDL_DATA);
    const podcasts = (await Promise.all(podcastIds.map((id) => getMonitoredPodcast(c.env.TLDL_DATA, id))))
        .filter((p): p is NonNullable<typeof p> => Boolean(p))
        .sort((a, b) => a.name.localeCompare(b.name));

    // Optional pre-selected IDs from ?podcastIds=... (comma-separated or repeated).
    const preselectedRaw = c.req.queries("podcastIds") ?? [];
    const preselected = new Set<string>(
        preselectedRaw.flatMap((v) => v.split(",")).map((v) => v.trim()).filter(Boolean),
    );

    const indexEntries = await c.env.TLDL_DATA.get<EpisodeIndexEntry[]>("episodes:index", "json") ?? [];

    const podcastList = podcasts.length === 0
        ? `<p class="bs-form-hint">No podcasts are monitored yet. Check back soon.</p>`
        : `<div class="bs-form-options">${podcasts.map((p) => `
            <label class="opt">
                <input type="checkbox" name="podcastIds" value="${escapeHtml(p.id)}"${preselected.has(p.id) ? " checked" : ""}>
                <span class="opt-body">
                    <span class="opt-name">${escapeHtml(p.name)}</span>
                    ${p.author ? `<span class="opt-author">${escapeHtml(p.author)}</span>` : ""}
                </span>
            </label>`).join("")}</div>`;

    const bodyHtml = `
<div class="bs-form-intro">
    <p>Pick the podcasts you want. We'll email you a summary each time a new episode lands. Free, and you can unsubscribe any time.</p>
</div>
<form method="POST" action="/subscribe" class="bs-form">
    <div class="bs-form-field">
        <label for="email">Email Address</label>
        <input type="email" id="email" name="email"
            placeholder="you@example.com" autocomplete="email" required />
    </div>
    <div class="bs-form-field">
        <label>Podcasts</label>
        ${podcastList}
    </div>
    <div class="cf-turnstile" data-sitekey="${escapeHtml(c.env.TURNSTILE_SITE_KEY)}" data-theme="dark"></div>
    <div class="bs-form-actions">
        <button type="submit" class="bs-form-submit">Subscribe &rarr;</button>
    </div>
</form>
`;

    return c.html(renderFormPage({
        activeNav: "subscribe",
        sectionHeading: "Subscribe — Email Summaries",
        sectionCount: "Free · Unsubscribe any time",
        bodyHtml,
        pageTitle: "Subscribe — TL;DL",
        totalInArchive: indexEntries.length,
        headExtra: TURNSTILE_SCRIPT,
    }));
});

// ---- POST /subscribe ----
subscriptionsRoutes.post("/subscribe", async (c) => {
    const form = await c.req.parseBody({ all: true });
    const rawEmail = typeof form.email === "string" ? form.email.trim() : "";
    const turnstileToken = typeof form["cf-turnstile-response"] === "string" ? form["cf-turnstile-response"] : "";
    const rawPodcastIds = form.podcastIds;
    const podcastIds = Array.isArray(rawPodcastIds)
        ? rawPodcastIds.filter((v): v is string => typeof v === "string")
        : typeof rawPodcastIds === "string"
            ? [rawPodcastIds]
            : [];

    const errPage = async (message: string, status: 400 | 403) => c.html(
        await renderSubscribeBanner(c.env, {
            heading: "Subscribe — Email Summaries",
            sectionCount: "Something's off",
            pageTitle: "Subscribe — TL;DL",
            bannerHtml: `<p>${escapeHtml(message)} <a href="/subscribe">Try again</a>.</p>`,
            kind: "err",
        }),
        status,
    );

    if (!rawEmail || !isValidEmail(rawEmail)) return errPage("That email address doesn't look right.", 400);
    if (podcastIds.length === 0) return errPage("Pick at least one podcast to subscribe to.", 400);
    if (podcastIds.length > MAX_PODCAST_IDS) return errPage("That's more podcasts than we can handle in one go.", 400);

    if (!(await verifyTurnstile(turnstileToken, c.env.TURNSTILE_SECRET))) return errPage("The anti-spam check didn't pass. Please try again.", 403);

    const email = rawEmail.toLowerCase();
    const now = Math.floor(Date.now() / 1000);

    const inboxMessage = "Please check your inbox — if we can reach you, a confirmation email is on its way. Click the link inside to confirm your subscription.";

    const existing = await getSubscriberByEmail(c.env.DB, email);
    if (existing?.status === "complained") {
        return c.html(await renderSubscribeBanner(c.env, {
            heading: "Subscribe — Email Summaries",
            sectionCount: "Check your inbox",
            pageTitle: "Check your inbox — TL;DL",
            bannerHtml: `<p>${escapeHtml(inboxMessage)}</p>`,
            kind: "ok",
        }));
    }

    if (await hasActivePendingForEmail(c.env.DB, email, now)) {
        return c.html(await renderSubscribeBanner(c.env, {
            heading: "Subscribe — Email Summaries",
            sectionCount: "Check your inbox",
            pageTitle: "Check your inbox — TL;DL",
            bannerHtml: `<p>${escapeHtml(inboxMessage)}</p>`,
            kind: "ok",
        }));
    }

    const token = randomTokenHex(32);
    await upsertPendingConfirmation(c.env.DB, {
        token, email, podcastIds,
        createdAt: now, expiresAt: now + PENDING_TTL_SECONDS,
    });

    const podcastNames = (await Promise.all(podcastIds.map((id) => getMonitoredPodcast(c.env.TLDL_DATA, id))))
        .filter((p): p is NonNullable<typeof p> => Boolean(p))
        .map((p) => p.name)
        .join(", ");

    const sendRes = await sendTemplate(c.env.POSTMARK_API_KEY ?? "", {
        from: c.env.POSTMARK_FROM_EMAIL,
        to: email,
        templateAlias: "confirm-subscription",
        templateModel: {
            confirmUrl: `${BASE_URL}/confirm?token=${token}`,
            podcastList: podcastNames,
            expiresIn: "48 hours",
        },
        messageStream: c.env.POSTMARK_MESSAGE_STREAM,
    });
    logSendFailure("subscribe_confirm_send_failed", email, sendRes);

    return c.html(await renderSubscribeBanner(c.env, {
        heading: "Subscribe — Email Summaries",
        sectionCount: "Check your inbox",
        pageTitle: "Check your inbox — TL;DL",
        bannerHtml: `<p>${escapeHtml(inboxMessage)}</p><p style="font-size: 15px; margin-top: 12px; font-style: normal;">Already subscribed? <a href="/preferences">Manage preferences</a>.</p>`,
        kind: "ok",
    }));
});

// ---- GET /confirm ----
subscriptionsRoutes.get("/confirm", async (c) => {
    const invalidPage = Layout({
        title: "Invalid link",
        children: `
            <div class="page-header">
                <h1>Invalid or expired link</h1>
            </div>
            <div class="card">
                <p>This confirmation link didn't work. It may have expired, or the subscription was already completed.</p>
                <a href="/subscribe" class="button button-primary">Subscribe again</a>
            </div>
        `,
    });

    const token = c.req.query("token");
    if (!token) return c.html(invalidPage, 400);

    const now = Math.floor(Date.now() / 1000);
    const subscriber = await confirmSubscriber(c.env.DB, token, now);
    if (!subscriber) return c.html(invalidPage, 400);

    const subs = await listSubscriptionsForSubscriber(c.env.DB, subscriber.id);
    if (subs.length === 0) {
        const manageToken = await signToken(
            c.env.MANAGE_LINK_HMAC_SECRET,
            manageMessage(subscriber.id, subscriber.email),
        );
        const manageUrl = `/preferences/manage?s=${subscriber.id}&token=${manageToken}`;
        return c.html(Layout({
            title: "Almost done",
            children: `
                <div class="page-header">
                    <h1>Email confirmed</h1>
                    <p class="page-subtitle">Now pick the podcasts you want summaries for.</p>
                </div>
                <div class="card">
                    <a href="${manageUrl}" class="button button-primary">Choose podcasts</a>
                </div>
            `,
        }));
    }

    return c.html(Layout({
        title: "Subscribed",
        children: `
            <div class="page-header">
                <h1>You're subscribed</h1>
                <p class="page-subtitle">We'll email you when a new summary goes up for any of your podcasts.</p>
            </div>
            <div class="card">
                <a href="/preferences" class="button button-primary">Manage preferences</a>
            </div>
        `,
    }));
});

// ---- GET /preferences ----
subscriptionsRoutes.get("/preferences", (c) => c.html(Layout({
    title: "Manage preferences",
    children: `
        <div class="page-header">
            <h1>Manage preferences</h1>
            <p class="page-subtitle">Enter your email and we'll send you a link to change or remove your subscriptions.</p>
        </div>
        <div class="card">
            <form method="POST" action="/preferences" class="form">
                <div class="form-group">
                    <label for="email" class="form-label">Email</label>
                    <input type="email" id="email" name="email" class="form-input"
                        placeholder="you@example.com" autocomplete="email" required />
                </div>
                <div class="form-actions" style="margin-top: 1rem;">
                    <button type="submit" class="button button-primary">Send me the link</button>
                </div>
            </form>
        </div>
    `,
    canonicalUrl: `${BASE_URL}/preferences`,
})));

// ---- POST /preferences ----
subscriptionsRoutes.post("/preferences", async (c) => {
    const form = await c.req.parseBody();
    const rawEmail = typeof form.email === "string" ? form.email.trim() : "";
    if (!rawEmail || !isValidEmail(rawEmail)) return c.text("Invalid email", 400);
    const email = rawEmail.toLowerCase();
    const now = Math.floor(Date.now() / 1000);

    const subscriber = await getSubscriberByEmail(c.env.DB, email);
    if (subscriber && subscriber.status === "active" && subscriber.confirmedAt !== null) {
        const token = await signToken(c.env.MANAGE_LINK_HMAC_SECRET, manageMessage(subscriber.id, email));
        const manageUrl = `${BASE_URL}/preferences/manage?s=${subscriber.id}&token=${token}`;
        const sendRes = await sendTemplate(c.env.POSTMARK_API_KEY ?? "", {
            from: c.env.POSTMARK_FROM_EMAIL,
            to: email,
            templateAlias: "manage-link",
            templateModel: { manageUrl },
            messageStream: c.env.POSTMARK_MESSAGE_STREAM,
        });
        logSendFailure("preferences_manage_link_send_failed", email, sendRes);
    } else if (!subscriber) {
        // Throttle: don't email-bomb a victim by rotating IPs through /preferences.
        if (await hasActivePendingForEmail(c.env.DB, email, now)) {
            return c.html(Layout({
                title: "Check your inbox",
                children: checkInboxPage("If we can reach you, a link is on its way."),
            }));
        }
        const token = randomTokenHex(32);
        await upsertPendingConfirmation(c.env.DB, {
            token, email, podcastIds: [],
            createdAt: now, expiresAt: now + PENDING_TTL_SECONDS,
        });
        const sendRes = await sendTemplate(c.env.POSTMARK_API_KEY ?? "", {
            from: c.env.POSTMARK_FROM_EMAIL,
            to: email,
            templateAlias: "confirm-subscription",
            templateModel: {
                confirmUrl: `${BASE_URL}/confirm?token=${token}`,
                podcastList: "",
                expiresIn: "48 hours",
            },
            messageStream: c.env.POSTMARK_MESSAGE_STREAM,
        });
        logSendFailure("preferences_new_email_send_failed", email, sendRes);
    }
    // complained / bounced: silently drop.

    return c.html(Layout({
        title: "Check your inbox",
        children: checkInboxPage("If we can reach you, a link is on its way."),
    }));
});

// ---- GET /preferences/manage ----
subscriptionsRoutes.get("/preferences/manage", async (c) => {
    const sRaw = c.req.query("s");
    const token = c.req.query("token");
    if (!sRaw || !token) return c.text("Forbidden", 403);
    const s = Number.parseInt(sRaw, 10);
    if (!Number.isFinite(s)) return c.text("Forbidden", 403);

    const subscriber = await getSubscriberById(c.env.DB, s);
    if (!subscriber) return c.text("Forbidden", 403);

    const ok = await verifyToken(c.env.MANAGE_LINK_HMAC_SECRET, manageMessage(subscriber.id, subscriber.email), token);
    if (!ok) return c.text("Forbidden", 403);

    const allIds = await getMonitoredPodcastIds(c.env.TLDL_DATA);
    const allPodcasts = (await Promise.all(allIds.map((id) => getMonitoredPodcast(c.env.TLDL_DATA, id))))
        .filter((p): p is NonNullable<typeof p> => Boolean(p))
        .sort((a, b) => a.name.localeCompare(b.name));
    const current = new Set(await listSubscriptionsForSubscriber(c.env.DB, subscriber.id));

    const podcastList = allPodcasts.length === 0
        ? `<p class="text-muted">No podcasts are monitored.</p>`
        : `<div class="checkbox-list">${allPodcasts.map((p) => `
            <label class="checkbox-row">
                <input type="checkbox" name="podcastIds" value="${escapeHtml(p.id)}"${current.has(p.id) ? " checked" : ""}>
                <span class="podcast-label">
                    <span class="podcast-name">${escapeHtml(p.name)}</span>
                    ${p.author ? `<span class="podcast-author">by ${escapeHtml(p.author)}</span>` : ""}
                </span>
            </label>`).join("")}</div>`;

    const unsubAllToken = await signToken(c.env.MANAGE_LINK_HMAC_SECRET, unsubAllMessage(subscriber.id));

    const content = `
        <div class="page-header">
            <h1>Preferences</h1>
            <p class="page-subtitle">${escapeHtml(subscriber.email)}</p>
        </div>
        <div class="card">
            <form method="POST" action="/preferences/manage" class="form">
                <input type="hidden" name="s" value="${subscriber.id}">
                <input type="hidden" name="token" value="${escapeHtml(token)}">
                <div class="form-group">
                    <label class="form-label">Podcasts</label>
                    ${podcastList}
                </div>
                <div class="form-actions" style="margin-top: 1rem;">
                    <button type="submit" class="button button-primary">Save preferences</button>
                </div>
            </form>
        </div>
        <div class="card" style="margin-top: 1rem;">
            <h2 style="margin-top: 0;">Unsubscribe from everything</h2>
            <p>Remove your email from every podcast at once. You can re-subscribe any time.</p>
            <form method="POST" action="/unsubscribe">
                <input type="hidden" name="s" value="${subscriber.id}">
                <input type="hidden" name="token" value="${escapeHtml(unsubAllToken)}">
                <button type="submit" class="button">Unsubscribe from all</button>
            </form>
        </div>
        ${CHECKBOX_LIST_STYLES}
    `;

    return c.html(Layout({ title: "Preferences", children: content }));
});

// ---- POST /preferences/manage ----
subscriptionsRoutes.post("/preferences/manage", async (c) => {
    const form = await c.req.parseBody({ all: true });
    const sRaw = typeof form.s === "string" ? form.s : "";
    const token = typeof form.token === "string" ? form.token : "";
    const s = Number.parseInt(sRaw, 10);
    if (!Number.isFinite(s) || !token) return c.text("Forbidden", 403);

    const subscriber = await getSubscriberById(c.env.DB, s);
    if (!subscriber) return c.text("Forbidden", 403);

    const ok = await verifyToken(c.env.MANAGE_LINK_HMAC_SECRET, manageMessage(subscriber.id, subscriber.email), token);
    if (!ok) return c.text("Forbidden", 403);
    if (subscriber.status !== "active") return c.text("Account not active", 409);

    const rawPodcastIds = form.podcastIds;
    const podcastIds = Array.isArray(rawPodcastIds)
        ? rawPodcastIds.filter((v): v is string => typeof v === "string")
        : typeof rawPodcastIds === "string"
            ? [rawPodcastIds]
            : [];
    if (podcastIds.length > MAX_PODCAST_IDS) return c.text("Too many podcasts", 400);

    const now = Math.floor(Date.now() / 1000);
    await replaceSubscriptions(c.env.DB, subscriber.id, podcastIds, now);

    return c.html(Layout({
        title: "Saved",
        children: `
            <div class="page-header">
                <h1>Saved</h1>
                <p class="page-subtitle">Your preferences are updated.</p>
            </div>
        `,
    }));
});

// ---- Shared unsubscribe handler ----
async function runUnsubscribe(
    env: Env,
    subscriberId: number,
    podcastIdOrNull: string | null,
    token: string,
): Promise<{ ok: true } | { ok: false; status: 403 }> {
    const expectedMessage = podcastIdOrNull
        ? unsubMessage(subscriberId, podcastIdOrNull)
        : unsubAllMessage(subscriberId);
    const valid = await verifyToken(env.MANAGE_LINK_HMAC_SECRET, expectedMessage, token);
    if (!valid) return { ok: false, status: 403 };

    if (podcastIdOrNull) {
        await unsubscribePodcast(env.DB, subscriberId, podcastIdOrNull);
    } else {
        await unsubscribeAll(env.DB, subscriberId);
    }
    return { ok: true };
}

// ---- GET /unsubscribe ----
subscriptionsRoutes.get("/unsubscribe", async (c) => {
    const sRaw = c.req.query("s");
    const p = c.req.query("p") ?? null;
    const token = c.req.query("token");
    if (!sRaw || !token) return c.text("Forbidden", 403);
    const s = Number.parseInt(sRaw, 10);
    if (!Number.isFinite(s)) return c.text("Forbidden", 403);

    const result = await runUnsubscribe(c.env, s, p, token);
    if (!result.ok) return c.text("Forbidden", result.status);

    return c.html(Layout({
        title: "Unsubscribed",
        children: `
            <div class="page-header">
                <h1>You're unsubscribed</h1>
            </div>
            <div class="card">
                <p>Changed your mind? You can manage your preferences any time.</p>
                <a href="/preferences" class="button button-primary">Manage preferences</a>
            </div>
        `,
    }));
});

// ---- POST /unsubscribe (RFC 8058) ----
subscriptionsRoutes.post("/unsubscribe", async (c) => {
    // Read both query AND form body — RFC 8058 one-click may send via form-encoded POST body.
    const form = await c.req.parseBody();
    const sRaw = (typeof form.s === "string" ? form.s : null) ?? c.req.query("s");
    const p = (typeof form.p === "string" ? form.p : null) ?? c.req.query("p") ?? null;
    const token = (typeof form.token === "string" ? form.token : null) ?? c.req.query("token");

    if (!sRaw || !token) return c.text("Forbidden", 403);
    const s = Number.parseInt(sRaw, 10);
    if (!Number.isFinite(s)) return c.text("Forbidden", 403);

    const result = await runUnsubscribe(c.env, s, p, token);
    if (!result.ok) return c.text("Forbidden", result.status);

    return c.body("", 200);
});
