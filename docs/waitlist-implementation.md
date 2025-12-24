# Waitlist Implementation Plan

Add a simple email waitlist with Cloudflare Turnstile spam protection.

## Overview

- **URL**: `GET /waitlist` (form), `POST /waitlist` (submit)
- **Storage**: KV with key pattern `waitlist:{email}`
- **Spam Protection**: Cloudflare Turnstile (free, privacy-focused)
- **Admin**: `GET /profile/waitlist` to view/export entries

## Cloudflare Turnstile Setup

1. Go to [Cloudflare Dashboard](https://dash.cloudflare.com) → Turnstile → Add site
2. Choose widget type:
   - **Managed** (recommended): Shows checkbox only when needed
   - **Invisible**: Fully invisible, best UX
   - **Non-interactive**: Always shows a loading spinner briefly
3. Copy **Site Key** (public) and **Secret Key** (private)
4. Add secret to Workers:
   ```bash
   npx wrangler secret put TURNSTILE_SECRET
   ```
5. Add site key as env var in `wrangler.toml`:
   ```toml
   [vars]
   TURNSTILE_SITE_KEY = "0x4AAAAAAA..."
   ```

## KV Schema

```
waitlist:{email} → { email, createdAt, source? }
```

- TTL: None (persist until manually cleared)
- Optional `source` field for tracking (e.g., "homepage", "footer")

## Routes

### GET /waitlist - Form Page

Public page with:
- Email input field
- Turnstile widget
- Submit button
- Success/error messages via query params

### POST /waitlist - Submit Handler

1. Validate Turnstile token with Cloudflare API
2. Validate email format
3. Check if email already exists (optional: show "already registered" message)
4. Store in KV
5. Redirect to `/waitlist?success=1`

### GET /profile/waitlist - Admin View

Protected endpoint (under `/profile/*` for Cloudflare Access):
- List all waitlist entries
- Show count
- Export as CSV button

## Implementation

### 1. Add to `src/routes/public.ts`

```typescript
// GET /waitlist - Waitlist signup form
publicRoutes.get("/waitlist", async (c) => {
    const success = c.req.query("success") === "1";
    const error = c.req.query("error");
    const siteKey = c.env.TURNSTILE_SITE_KEY;

    return c.html(Layout({
        title: "Join the Waitlist",
        children: WaitlistPage({ success, error, siteKey })
    }));
});

// POST /waitlist - Handle signup
publicRoutes.post("/waitlist", async (c) => {
    const body = await c.req.parseBody();
    const email = body.email as string;
    const token = body["cf-turnstile-response"] as string;

    // 1. Validate Turnstile
    const turnstileValid = await verifyTurnstile(token, c.env.TURNSTILE_SECRET);
    if (!turnstileValid) {
        return c.redirect("/waitlist?error=captcha");
    }

    // 2. Validate email
    if (!email || !isValidEmail(email)) {
        return c.redirect("/waitlist?error=invalid-email");
    }

    // 3. Store in KV (lowercase for deduplication)
    const normalizedEmail = email.toLowerCase().trim();
    const key = `waitlist:${normalizedEmail}`;

    await c.env.TLDL_DATA.put(key, JSON.stringify({
        email: normalizedEmail,
        createdAt: new Date().toISOString()
    }));

    return c.redirect("/waitlist?success=1");
});
```

### 2. Turnstile Verification Helper

Add to `src/lib/turnstile.ts`:

```typescript
export async function verifyTurnstile(token: string, secret: string): Promise<boolean> {
    if (!token) return false;

    const response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            secret,
            response: token
        })
    });

    const result = await response.json() as { success: boolean };
    return result.success;
}
```

### 3. Waitlist Page Component

```typescript
function WaitlistPage(props: { success: boolean; error?: string; siteKey: string }) {
    return html`
        <div class="page-header">
            <h1>Join the Waitlist</h1>
            <p class="page-subtitle text-muted">
                TL;DL is currently invite-only. Sign up to get notified when we open up.
            </p>
        </div>

        ${props.success ? html`
            <div class="alert alert-success">
                <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/>
                    <polyline points="22 4 12 14.01 9 11.01"/>
                </svg>
                <span>You're on the list! We'll email you when spots open up.</span>
            </div>
        ` : html`
            ${props.error ? html`
                <div class="alert alert-error" style="margin-bottom: 1.5rem;">
                    <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <circle cx="12" cy="12" r="10"/>
                        <line x1="12" y1="8" x2="12" y2="12"/>
                        <line x1="12" y1="16" x2="12.01" y2="16"/>
                    </svg>
                    <span>${props.error === "captcha" ? "Verification failed. Please try again." : "Please enter a valid email address."}</span>
                </div>
            ` : ""}

            <div class="card">
                <form method="POST" action="/waitlist" class="form">
                    <div class="form-group">
                        <label for="email" class="form-label">Email address</label>
                        <input
                            type="email"
                            id="email"
                            name="email"
                            class="form-input"
                            placeholder="you@example.com"
                            required
                            autocomplete="email"
                        />
                    </div>

                    <!-- Turnstile widget -->
                    <div class="cf-turnstile" data-sitekey="${props.siteKey}" data-theme="dark"></div>
                    <script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>

                    <div class="form-actions">
                        <button type="submit" class="button button-primary">Join Waitlist</button>
                    </div>
                </form>
            </div>
        `}
    `;
}
```

### 4. Admin View (in `src/routes/authenticated.ts`)

```typescript
// GET /profile/waitlist - Admin view of waitlist entries
authenticatedRoutes.get("/profile/waitlist", async (c) => {
    // Check admin (reuse existing admin check pattern)
    const userEmail = getUserEmail(c);
    if (userEmail !== "your-admin-email@example.com") {
        return c.text("Unauthorized", 403);
    }

    // List all waitlist entries
    const list = await c.env.TLDL_DATA.list({ prefix: "waitlist:" });
    const entries = await Promise.all(
        list.keys.map(async (key) => {
            const data = await c.env.TLDL_DATA.get(key.name);
            return data ? JSON.parse(data) : null;
        })
    );

    const validEntries = entries.filter(Boolean);

    // Render admin page with entries and CSV export
    return c.html(Layout({
        title: "Waitlist Admin",
        children: WaitlistAdminPage({ entries: validEntries })
    }));
});
```

## Turnstile Widget Styling

The widget auto-adapts to dark mode with `data-theme="dark"`. No additional CSS needed.

For invisible mode, the widget won't render anything visible - just include the div and script.

## Email Validation Helper

Simple regex for basic validation:

```typescript
function isValidEmail(email: string): boolean {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}
```

## Environment Variables

Add to `wrangler.toml`:

```toml
[vars]
TURNSTILE_SITE_KEY = "your-site-key-here"
```

Add secret via CLI:

```bash
npx wrangler secret put TURNSTILE_SECRET
# Paste your secret key when prompted
```

## Testing

1. Test form renders correctly at `/waitlist`
2. Test Turnstile widget loads and completes
3. Test successful submission stores email in KV
4. Test duplicate emails are handled gracefully
5. Test invalid emails show error message
6. Test admin view at `/profile/waitlist`

Verify KV storage:
```bash
npx wrangler kv key list --namespace-id=ee123158d5d54359b4257f8a1b678adf --prefix="waitlist:"
npx wrangler kv key get --namespace-id=ee123158d5d54359b4257f8a1b678adf "waitlist:test@example.com"
```

## Optional Enhancements

- **Double opt-in**: Send confirmation email (requires email service integration)
- **Source tracking**: Add `?source=homepage` param to track signup sources
- **Referral system**: Generate unique codes for viral growth
- **Rate limiting**: Add per-IP rate limiting (similar to existing submission rate limiting)
