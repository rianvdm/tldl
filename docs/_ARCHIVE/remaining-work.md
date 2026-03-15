# Remaining Work: Phases 4 and 5

*Status as of 2026-03-15*

Phases 1-3 are complete and deployed. The admin-first pivot is live. This doc covers what's left.

## Phase 4: Request a Podcast Form + Postmark

Goal: give visitors a way to request new podcasts. Simple form at `/request`, sends you an email via Postmark.

### Prerequisites (manual, do before coding)

1. **Create a Postmark account** at https://postmarkapp.com
   * Create a "Server" (e.g., "TLDL")
   * Note the Server API Token — this becomes `POSTMARK_API_KEY`

2. **Configure sending domain DNS** for `tldl-pod.com`
   * In Postmark: Sender Signatures → Add Domain → `tldl-pod.com`
   * Postmark gives you DNS records to add:
     * TXT record for SPF (or update existing SPF to include Postmark)
     * TXT record for DKIM (two CNAME records)
     * CNAME for Return-Path
   * Add these in Cloudflare DNS dashboard for `tldl-pod.com`
   * Verify in Postmark (click "Verify" — checks DNS propagation)
   * Until DNS is verified, Postmark won't send from `@tldl-pod.com`

3. **Set secrets and env vars**
   ```bash
   npx wrangler secret put POSTMARK_API_KEY
   # Paste the Server API Token from Postmark
   ```
   Add to `wrangler.toml` `[vars]`:
   ```toml
   POSTMARK_FROM_EMAIL = "noreply@tldl-pod.com"
   ADMIN_NOTIFICATION_EMAIL = "rianvdm@gmail.com"
   ```
   Add matching entries in `.dev.vars` for local testing:
   ```
   POSTMARK_API_KEY=your-test-server-token
   ```

### Code changes

#### 1. Add to Env type (`src/types/index.ts`)

```typescript
// In the Env interface, add:
POSTMARK_API_KEY?: string;           // Optional — form disabled if not set
POSTMARK_FROM_EMAIL: string;         // e.g., noreply@tldl-pod.com
ADMIN_NOTIFICATION_EMAIL: string;    // e.g., rianvdm@gmail.com
```

#### 2. Create `src/services/postmark.ts`

Minimal Postmark client. No SDK needed — it's a single POST.

```typescript
export async function sendEmail(
    apiKey: string,
    options: {
        from: string;
        to: string;
        subject: string;
        textBody: string;
        htmlBody?: string;
    }
): Promise<{ success: boolean; errorMessage?: string }> {
    const response = await fetch("https://api.postmarkapp.com/email", {
        method: "POST",
        headers: {
            "Accept": "application/json",
            "Content-Type": "application/json",
            "X-Postmark-Server-Token": apiKey,
        },
        body: JSON.stringify({
            From: options.from,
            To: options.to,
            Subject: options.subject,
            TextBody: options.textBody,
            HtmlBody: options.htmlBody,
        }),
    });

    if (!response.ok) {
        const error = await response.json();
        return { success: false, errorMessage: error.Message || "Failed to send" };
    }

    return { success: true };
}
```

#### 3. Add routes in `src/routes/public.ts`

**`GET /request`** — renders the form page with Turnstile:

```
Request a Podcast
Know a podcast that should be on TL;DL? Let us know.

┌─────────────────────────────────────────────────┐
│  Podcast name: [________________________]       │
│  Apple Podcasts URL (optional): [___________]   │
│  Your email (optional): [___________________]   │
│  Message (optional):                            │
│  [                                        ]     │
│  [Turnstile widget]                             │
│  [Send Request]                                 │
└─────────────────────────────────────────────────┘
```

* Turnstile script loaded via `headExtra`
* Only the podcast name field is required
* Apple Podcasts URL, email, and message are optional

**`POST /request`** — handles submission:

1. Validate Turnstile token via `verifyTurnstile()`
2. Validate podcast name is not empty
3. Send email via Postmark to `ADMIN_NOTIFICATION_EMAIL`
   * Subject: `TLDL Request: {podcast name}`
   * Body: podcast name, URL (if provided), requester email (if provided), message (if provided)
4. On success: render thank-you page
5. On failure: render form again with error message

If `POSTMARK_API_KEY` is not set, the form should still render but the POST should return a friendly "This feature is not available yet" message instead of crashing.

#### 4. Update public pages

* **Home page hero** (`src/routes/public.ts`): Change "Browse AI summaries below." to "Browse AI summaries below, or [request a podcast](/request) to be added."
* **Footer** (`src/lib/components.ts`): Add "Request a Podcast" link: `Request a Podcast | Feedback | Creator Opt-out`
* **About page** (`src/routes/public.ts`): Add a sentence in the intro section mentioning the request form

#### 5. Add CSS

Reuse existing `.form-group`, `.form-label`, `.form-input`, `.button` styles. The form is a standard card layout, no new CSS needed beyond what's already in `styles.ts`.

#### 6. Tests

* Test `GET /request` returns 200 with form HTML
* Test `POST /request` with missing Turnstile token returns error
* Test `POST /request` with empty podcast name returns validation error
* Test `POST /request` renders thank-you on success (will need to mock Postmark or accept the 401 from invalid API key)
* Test that Postmark is not called when `POSTMARK_API_KEY` is not set

#### 7. Imports to add back to `public.ts`

```typescript
import { verifyTurnstile } from "../lib/turnstile";
import { sendEmail } from "../services/postmark";
```

### Estimated scope

* 1 new file (`src/services/postmark.ts`, ~30 lines)
* ~150 lines added to `public.ts` (form page + POST handler)
* ~5 lines changed in `components.ts` (footer)
* ~5 lines changed in `public.ts` (hero text, about text)
* ~3 lines added to `types/index.ts`
* ~3 lines added to `wrangler.toml`
* ~50 lines of tests

## Phase 5: Cleanup

Final cleanup before merging the `admin-pivot` branch to main.

### Code cleanup

1. **Update `AGENTS.md`** — the architecture section is out of date. Key changes:
   * Routes: `/admin/*` replaces `/profile/*`. No public submit, waitlist, or job status pages.
   * New files: `src/routes/admin.ts`, `src/lib/discord.ts`, `src/services/postmark.ts`
   * Deleted files: `src/routes/authenticated.ts`
   * New KV keys: `activity:log`
   * New secrets: `DISCORD_WEBHOOK_URL`, `POSTMARK_API_KEY`
   * New env vars: `POSTMARK_FROM_EMAIL`, `ADMIN_NOTIFICATION_EMAIL`
   * Cloudflare Access: protects `/admin` and `/admin/*`
   * Debug routes: all disabled in production
   * Timeout detection: stale jobs (>20min) auto-marked as failed

2. **Archive old docs**
   * Move `docs/email-pivot-plan.md` to `docs/_ARCHIVE/`
   * Move `docs/email-subscriptions-plan.md` to `docs/_ARCHIVE/` (if still present)

3. **Clean up `docs/todo.md`** — review and update, or archive if stale

4. **Remove `.tmp-build/`** — add to `.gitignore` if not already there

### Manual steps (already done, verify)

* [x] Cloudflare Access: `/admin` and `/admin/*` protected, admin-only emails
* [x] `DISCORD_WEBHOOK_URL` secret set
* [ ] `POSTMARK_API_KEY` secret set (Phase 4 prerequisite)
* [ ] Postmark DNS verified for `tldl-pod.com`
* [ ] Remove old `/profile/*` Access application (if it still exists)

### Final testing checklist

Before merging to main:

* [ ] All public pages render correctly (/, /episode/:id, /podcasts, /about, /feed, /request)
* [ ] Removed routes 404 (/submit, /waitlist, /profile, /job/:id)
* [ ] Admin dashboard works behind Access (/admin)
* [ ] Admin submit creates jobs that process successfully
* [ ] Admin podcast monitoring shows correct status
* [ ] "Check All Now" works from both dashboard and podcasts page
* [ ] Discord notifications fire on failures (test by submitting an invalid episode)
* [ ] Request form sends email via Postmark (test with a real submission)
* [ ] Activity log shows recent events on dashboard
* [ ] RSS feed works (/feed)
* [ ] No JS console errors on any public page
* [ ] `npm test` passes (14/15 files, pre-existing consumer.test.ts DO issue excluded)

### Merge strategy

```bash
git checkout main
git merge admin-pivot
git push
npx wrangler deploy
```

No squash needed — the commit history is clean and tells the story of the migration.
