# Admin-First Pivot Plan

*Supersedes: `email-pivot-plan.md`*

## The Pivot

TLDL shifts from a user-submitted podcast summary tool to an **admin-curated podcast archive**. The site is a public read-only archive with an RSS feed. Only admins can submit episodes and manage podcasts. Visitors can request new podcasts via a simple contact form.

**What changes:**

* The submit flow is removed from public pages and moved behind admin auth
* The waitlist is replaced by a "Request a Podcast" contact form (Postmark + Turnstile)
* "Regular signed-in users" no longer exist — only admins
* All admin functionality moves to `/admin/*` (from `/profile/*`)
* Podcast monitoring gets a proper admin UI with error visibility and Discord notifications
* The admin dashboard is redesigned as a single-page starting point with stats, activity, and tools
* Auth-conditional UI on public pages is removed entirely (no login button, no auth detection JS)

**What stays:**

* The full processing pipeline (RSS parsing, transcription, summarization, tagging)
* Public pages: home (`/`), episode detail (`/episode/:id`), podcasts (`/podcasts`, `/podcasts/:id`), about (`/about`), RSS feed (`/feed`)
* KV storage for episodes, summaries, transcripts
* Queue consumer and Durable Objects for job processing
* Cron-triggered podcast monitoring

## Why This Is Better

1. **Honest about scale.** There's one user who submits episodes. Build for that instead of pretending there's a multi-user model.
2. **Simpler auth model.** One Cloudflare Access policy (`/admin/*` → admin emails only). No auth detection scripts, no per-user episode tracking, no rate limiting.
3. **Better admin experience.** Instead of admin features scattered across a profile page, get a proper dashboard with at-a-glance status.
4. **Failure visibility.** Silent monitoring failures have been a real problem. Discord webhooks and a better admin UI surface errors proactively.
5. **Public visitor experience improves.** No confusing "invite-only" messaging. Visitors browse, read, subscribe to RSS, or request a podcast. Simple.

**Trade-offs:** Postmark adds an external dependency (API key, DNS setup, account) for the contact form. Cloudflare Access policy changes are manual and if misconfigured could lock out admin or leave old paths exposed. The migration itself is a large refactor that touches most route files and tests.

## URL Structure

### Public (no auth)

| Route | Purpose |
|-------|---------|
| `GET /` | Episode list with pagination, search, tag filtering |
| `GET /episode/:id` | Episode detail with summary and transcript |
| `GET /podcasts` | Browse all podcasts |
| `GET /podcasts/:id` | Individual podcast page |
| `GET /about` | About page |
| `GET /feed` | RSS feed (with optional `?tag=` filter) |
| `GET /request` | "Request a Podcast" form (Turnstile protected) |
| `POST /request` | Handle request form submission (sends email via Postmark) |

### API (no auth)

| Route | Purpose |
|-------|---------|
| `GET /api/episodes` | JSON episode list |
| `GET /api/episode/:id` | JSON episode detail |
| `GET /api/episode/:id/transcript.txt` | Download transcript |
| `GET /api/templates` | Available summary templates |

### Admin (Cloudflare Access, admin-only emails)

| Route | Purpose |
|-------|---------|
| `GET /admin` | Admin dashboard (stats, activity, episode list, tools) |
| `GET /admin/podcasts` | Podcast monitoring management |
| `GET /admin/submit` | Submit a single episode (URL + template picker) |
| `POST /admin/submit` | Process episode submission |
| `POST /admin/episodes/:id/delete` | Delete episode |
| `POST /admin/episodes/:id/tags` | Update episode tags |
| `GET /admin/episodes/:id/summaries` | Get all summaries for episode |
| `POST /admin/episodes/:id/summaries/:templateId` | Update summary text |
| `POST /admin/episodes/:id/regenerate` | Regenerate with different template |
| `POST /admin/rebuild-index` | Rebuild episode index |
| `POST /admin/backfill-tags` | Generate tags for untagged episodes |
| `POST /admin/cleanup-tags` | Remove invalid tags |
| `POST /admin/cleanup-jobs` | Clean up failed jobs |
| `POST /admin/backfill-podcast-info` | Backfill podcast metadata |
| `PUT /admin/podcasts/settings` | Update monitoring settings |
| `POST /admin/podcasts/add` | Add podcast to monitoring |
| `POST /admin/podcasts/check-now` | Force check all podcasts |
| `POST /admin/podcasts/:id/check` | Check single podcast |
| `DELETE /admin/podcasts/:id` | Remove podcast from monitoring |

## UI Design

### Public Nav

```
TL;DL  Too Long Didn't Listen     Podcasts    About
```

No Submit button. No Login link. No auth-conditional UI.

### Public Home Page Hero

```
Your favorite podcasts, summarized.
Browse AI summaries below, or request a podcast to be added.
```

"request a podcast" links to `/request`.

### Footer (`src/lib/components.ts`)

```
Request a Podcast | Creator Opt-out | Feedback
```

The `Footer` component lives in `src/lib/components.ts` and is imported into both `public.ts` and `index.ts` (error pages). Updating it in one place covers all pages.

### Admin Dashboard (`/admin`)

Designed as a card-based layout that can grow over time. No link to this page in the public UI — admin navigates directly via URL or bookmark.

```
Admin Dashboard                                    [Log Out]

┌─────────────────────────────────────────────────────────────┐
│  Stats                                                      │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐   │
│  │    47     │  │    12    │  │    0     │  │   3h     │   │
│  │ Episodes  │  │ Podcasts │  │  Errors  │  │ Last chk │   │
│  └──────────┘  └──────────┘  └──────────┘  └──────────┘   │
└─────────────────────────────────────────────────────────────┘

┌─ Quick Actions ─────────────────────────────────────────────┐
│  [Submit Episode]  [Manage Podcasts]  [Check All Now]       │
└─────────────────────────────────────────────────────────────┘

┌─ Recent Activity ───────────────────────────────────────────┐
│  • "The Ezra Klein Show - AI and..." completed 2h ago       │
│  • Monitoring check: 12 podcasts, 1 new episode — 3h ago    │
│  • "Hard Fork - Apple's..." failed: timeout — 5h ago   [!]  │
│  Active Jobs: none                                          │
└─────────────────────────────────────────────────────────────┘

┌─ Episodes (page 1 of 5) ───────────────────────────────────┐
│  [Episode cards with delete, edit tags, edit summaries]     │
│  [Pagination]                                               │
└─────────────────────────────────────────────────────────────┘

┌─ Admin Tools ───────────────────────────────────────────────┐
│  Rebuild Index | Cleanup Failed Jobs | Backfill Tags        │
│  Cleanup Invalid Tags | Backfill Podcast Info               │
└─────────────────────────────────────────────────────────────┘
```

**Design principles for extensibility:**
* Stats row is a CSS grid — add new stat cards by adding items
* Quick Actions is a flex row — add new action buttons freely
* Recent Activity is a log-style list — later could become its own page `/admin/activity`
* Admin Tools is a grid of button cards — later could become `/admin/tools`
* Each section is a card with a heading — new capabilities = new cards

### Admin Podcast Monitoring (`/admin/podcasts`)

```
Podcast Monitoring                                  [← Dashboard]

┌─ Status ────────────────────────────────────────────────────┐
│  Monitoring: ● Active  |  12 podcasts  |  Last check: 3h   │
│  [Check All Now]  [Pause All]                               │
└─────────────────────────────────────────────────────────────┘

┌─ Add Podcast ───────────────────────────────────────────────┐
│  Apple Podcasts URL: [________________________]             │
│  Template: [Key Takeaways ▼]                                │
│  ☑ Queue latest episode immediately                         │
│  [Add Podcast]                                              │
└─────────────────────────────────────────────────────────────┘

┌─ The Ezra Klein Show ──────────── ● active ─────────────────┐
│  Template: key-takeaways  |  23 episodes  |  Checked 3h ago │
│  [Check Now]  [Pause]  [Remove]                             │
├─────────────────────────────────────────────────────────────┤
│  Show Name Two ────────────────── ⚠ error ──────────────────│
│  Template: narrative  |  8 episodes  |  Checked 3h ago      │
│  Error: RSS feed returned 404                               │
│  [Check Now]  [Pause]  [Remove]                             │
└─────────────────────────────────────────────────────────────┘
```

Improvements over current page:
* Status summary at top
* Relative timestamps ("3h ago" not ISO dates)
* Pause/resume toggle per podcast
* Error display inline with red styling
* Apple Podcasts link per podcast (for reference)

### Admin Submit (`/admin/submit`)

The current submit form, moved to `/admin/submit`:
* No Turnstile (behind Access)
* URL input + template radio buttons + submit button
* On success, redirects to admin dashboard (active jobs show there)

### Request a Podcast (`/request`)

```
Request a Podcast
Know a podcast that should be on TL;DL? Let us know.

┌─────────────────────────────────────────────────────────────┐
│  Podcast name: [________________________]                   │
│  Apple Podcasts URL (optional): [________________________]  │
│  Your email (optional): [________________________]          │
│  Message (optional):                                        │
│  [                                                    ]     │
│  [                                                    ]     │
│  [Turnstile widget]                                         │
│  [Send Request]                                             │
└─────────────────────────────────────────────────────────────┘
```

On submit: Postmark sends email to admin. User sees thank-you message.

## Routes to Remove

| Current route | Reason |
|---------------|--------|
| `GET /submit` (public) | Moved to `/admin/submit` |
| `POST /submit` (public form) | Moved to `/admin/submit` |
| `POST /submit` (authenticated JSON) | Moved to `/admin/submit` |
| `GET /waitlist` | Replaced by `/request` |
| `POST /waitlist` | Replaced by `POST /request` |
| `GET /profile` | Replaced by `/admin` |
| `GET /profile/auth-check` | No longer needed (no client-side auth detection) |
| `GET /profile/waitlist` | Removed (waitlist is gone) |
| `POST /profile/delete/:id` | Moved to `/admin/episodes/:id/delete` |
| `POST /profile/update-tags/:id` | Moved to `/admin/episodes/:id/tags` |
| `GET /profile/summaries/:id` | Moved to `/admin/episodes/:id/summaries` |
| `POST /profile/update-summary/:id/:t` | Moved to `/admin/episodes/:id/summaries/:t` |
| `POST /profile/rebuild-index` | Moved to `/admin/rebuild-index` |
| `POST /profile/backfill-tags` | Moved to `/admin/backfill-tags` |
| `POST /profile/cleanup-invalid-tags` | Moved to `/admin/cleanup-tags` |
| `POST /profile/cleanup-failed-jobs` | Moved to `/admin/cleanup-jobs` |
| `POST /profile/backfill-podcast-info` | Moved to `/admin/backfill-podcast-info` |
| `GET /profile/podcasts` | Moved to `/admin/podcasts` |
| `PUT /profile/podcasts/settings` | Moved to `/admin/podcasts/settings` |
| `POST /profile/podcasts/add` | Moved to `/admin/podcasts/add` |
| `POST /profile/podcasts/check-now` | Moved to `/admin/podcasts/check-now` |
| `POST /profile/podcasts/:id/check` | Moved to `/admin/podcasts/:id/check` |
| `DELETE /profile/podcasts/:id` | Moved to `/admin/podcasts/:id` |
| `POST /episode/:id/regenerate` | Moved to `/admin/episodes/:id/regenerate` |
| `DELETE /episode/:id` | Moved to `/admin/episodes/:id/delete` |
| `GET /job/:id` (public HTML) | Removed — active jobs visible on admin dashboard and home page |
| `POST /job/:id/retry` (public) | Moved to admin (retry from dashboard) |
| `POST /job/:id/delete` (public) | Moved to admin (cleanup from dashboard) |
| `GET /job/:id` (authenticated JSON) | Removed |
| `POST /job/:id/retry` (authenticated JSON) | Removed |
| `DELETE /api/job/:id` | Move behind admin auth (currently unauthenticated — security issue) |

## New Files

### `src/lib/discord.ts`

Discord webhook helper for failure notifications.

```typescript
export async function sendDiscordNotification(
    webhookUrl: string,
    message: { title: string; description: string; color?: number }
): Promise<void>
```

Color conventions: red (0xFF0000) for errors, green (0x22C55E) for success, yellow (0xEAB308) for warnings.

Called from:
* `scheduledHandler` in `src/index.ts` — when cron check has errors
* `queue/consumer.ts` — when a job fails
* `monitor.ts` — when a podcast enters error state

### `src/services/postmark.ts`

Minimal Postmark client for the contact form.

```typescript
export async function sendEmail(
    apiKey: string,
    options: { from: string; to: string; subject: string; textBody: string; htmlBody?: string }
): Promise<void>
```

Postmark's API is a single POST to `https://api.postmarkapp.com/email` with the server token as a header. No SDK needed.

### `src/routes/admin.ts`

New file containing all admin routes (replaces the admin portions of `authenticated.ts`).

### `src/routes/public.ts` (heavily modified)

Remove: submit form, waitlist, job status pages, auth-conditional UI scripts, SubmitFormPage component, WaitlistPage component, JobStatusPage component.

Add: request form page, updated nav, updated hero text, updated footer.

## Cloudflare Access Configuration

### Current setup
* Application protects `/profile/*` paths
* Policy allows "any email" (or a specific list)

### New setup
* Application protects `/admin/*` paths
* Policy allows only emails in `ADMIN_EMAILS` (currently just `rianvdm@gmail.com`)
* Remove the `/profile/*` application entirely

**Manual step:** Update in Cloudflare Zero Trust dashboard → Access → Applications.

## Environment Changes

### New secrets (via `wrangler secret put`)

| Secret | Purpose |
|--------|---------|
| `DISCORD_WEBHOOK_URL` | Discord channel webhook for failure notifications |
| `POSTMARK_API_KEY` | Postmark server API token for contact form emails |

### New env vars (in `wrangler.toml`)

| Variable | Value | Purpose |
|----------|-------|---------|
| `POSTMARK_FROM_EMAIL` | `noreply@tldl-pod.com` | Sender address for contact form |
| `ADMIN_NOTIFICATION_EMAIL` | `rianvdm@gmail.com` | Where contact form emails are sent |

### Dev environment (`[env.dev.vars]` in `wrangler.toml`)

`wrangler.toml` has a parallel `[env.dev.vars]` section for local development. Add `POSTMARK_FROM_EMAIL` and `ADMIN_NOTIFICATION_EMAIL` there too. For secrets (`DISCORD_WEBHOOK_URL`, `POSTMARK_API_KEY`), create a `.dev.vars` file (gitignored) with test/dummy values for local dev, or add dev-mode fallbacks that skip the external calls when `ENVIRONMENT === "development"`.

### Type changes (`src/types/index.ts`)

Add to `Env` interface:
```typescript
DISCORD_WEBHOOK_URL: string;
POSTMARK_API_KEY: string;
POSTMARK_FROM_EMAIL: string;
ADMIN_NOTIFICATION_EMAIL: string;
```

### DNS setup for Postmark

Configure SPF, DKIM, and Return-Path records for `tldl-pod.com`:
1. Log in to Postmark → Sender Signatures → Add domain `tldl-pod.com`
2. Postmark provides DNS records (TXT for SPF/DKIM, CNAME for Return-Path)
3. Add these records in Cloudflare DNS dashboard for `tldl-pod.com`
4. Verify in Postmark

### Discord webhook setup

1. In Discord, go to the server/channel where you want notifications
2. Server Settings → Integrations → Webhooks → New Webhook
3. Name it "TLDL Monitoring" (or similar)
4. Copy the webhook URL
5. `npx wrangler secret put DISCORD_WEBHOOK_URL` → paste the URL

## Code to Remove (Dead Code Cleanup)

| Code | Location | Reason |
|------|----------|--------|
| `listEpisodesByUser()` | `src/lib/kv.ts` | No per-user episode tracking |
| `checkRateLimit()` / `setRateLimitHeaders()` | `src/routes/authenticated.ts` | Admin doesn't need rate limits |
| Rate limit KV key pattern `ratelimit:{email}:{hour}` | `src/routes/authenticated.ts` (`checkRateLimit()`) | No longer used |
| Auth-conditional UI: `<head>` script (auth probe to `/profile/auth-check`, localStorage `tldl-auth` cache, `window.__authCheck`) | `src/routes/public.ts` Layout function | No client-side auth detection |
| Auth-conditional UI: `</body>` script (`showLoggedIn()`, class toggling, stale-cache reload) | `src/routes/public.ts` Layout function | No client-side auth detection |
| Auth nav elements: Login link (`#nav-auth-link`), disabled Submit wrapper (`.auth-logged-out`), hidden Submit button (`.auth-logged-in`) | `src/routes/public.ts` Layout function | No submit or login in public nav |
| `.auth-logged-out` / `.auth-logged-in` / `.hidden` styles | `src/lib/styles.ts` | No auth-conditional styling |
| `.nav-submit-btn` / `.nav-submit-wrapper` / tooltip styles | `src/lib/styles.ts` | No submit button in nav |
| `SubmitFormPage` component | `src/routes/public.ts` | Submit moved to admin |
| `WaitlistPage` component | `src/routes/public.ts` | Waitlist removed |
| `JobStatusPage` component | `src/routes/public.ts` | Public job status page removed |
| `InProgressCard` component | `src/routes/public.ts` | Keep on home page but simplify (no link to job page) |
| `STATUS_LABELS` / `STATUS_PROGRESS` / `STATUS_ORDER` | `src/routes/public.ts` | Job status page removed |
| `isBlockedPodcast` import in public routes | `src/routes/public.ts` | Submit removed from public |
| `verifyTurnstile`, `isValidEmail` imports | `src/routes/public.ts` | Waitlist removed (re-import Turnstile for `/request`) |
| `createJob`, `updateJobStatus` imports | `src/routes/public.ts` | Only used by submit and job status routes |
| `createJobDO`, `getJobWithFallback`, `updateJobStatusDO`, `deleteJobDO` imports | `src/routes/public.ts` | Only used by submit and job routes (keep `listActiveJobsWithDO` if "In Progress" stays on home page) |
| `enqueueJob`, `createProcessEpisodeMessage` imports | `src/routes/public.ts` | Only used by submit and job retry |
| `getUserEmailFromJwt` import + `getUserEmail()` helper function | `src/routes/public.ts` | Only used by submit and job retry flows |
| `TIMEOUTS` import | `src/routes/public.ts` | Only used by job status page timeout detection |
| `?loggedOut=1` query param handler + logout banner | `src/routes/public.ts` home page route | No public login/logout flow |
| `submittedBy` field on `Episode` type | `src/types/index.ts` | Keep for backwards compat but stop writing it |
| `DELETE /api/job/:jobId` (unauthenticated) | `src/routes/api.ts` | Security issue — move behind admin |

## CSS Changes

### Remove
* `.auth-logged-out`, `.auth-logged-in`, `.auth-disabled`, `.hidden` (auth classes)
* `.nav-submit-btn`, `.nav-submit-disabled`, `.nav-submit-wrapper` and tooltip styles
* Job status page styles (`.step`, `.step-complete`, `.step-current`, `.step-pending`, `.step-icon`, `.progress-container`, `.progress-bar`, `.progress-fill`, `.progress-info`, `.progress-percent`, `.estimated-time`)

### Add
* `.admin-stats-grid` — 4-column grid for stat cards
* `.admin-stat-card` — individual stat with number + label
* `.admin-quick-actions` — flex row for action buttons
* `.admin-activity` — recent activity list
* `.admin-activity-item` — individual activity entry
* `.request-form` — contact form styling (reuse existing `.form` patterns)

### Keep (already exist in `styles.ts`, reuse)
* `.card`, `.form-group`, `.form-label`, `.form-input`, `.button`, `.badge`
* `.episode-card`, `.episode-list`
* `.modal`, `.modal-backdrop`, `.modal-content`

### Migrate from inline `<style>` blocks (currently in `authenticated.ts`, move to `styles.ts`)
* `.podcast-monitor-card`, `.status-badge`, `.status-active`, `.status-paused`, `.status-error`
* `.podcast-header`, `.podcast-meta`, `.podcast-actions`, `.button-danger`
* `.admin-tools`, `.admin-tool-item` (used as HTML class hooks but have no CSS definitions yet; need new styles)

## Test Impact

### Tests to remove or rewrite

| Test file | Impact |
|-----------|--------|
| `test/submit-job-html.test.ts` | **Remove entirely** — tests public submit form which no longer exists |
| `test/authenticated.test.ts` | **Rewrite** — all `POST /submit` tests become `POST /admin/submit`, all `/profile/*` become `/admin/*` |
| `test/integration/full-flow.test.ts` | **Update** — references to `/submit` change to `/admin/submit` |

### Tests to add

* Admin dashboard renders stats and episodes
* Admin submit flow (URL validation, job creation)
* Request form: Turnstile validation, Postmark email sent
* Discord webhook: notification sent on monitoring failure
* Discord webhook: notification sent on queue consumer failure

### Tests unaffected

* `test/kv.test.ts` — KV helpers don't change (except removing `listEpisodesByUser`)
* `test/api.test.ts` — public API routes unchanged (note: `DELETE /api/job/:id` has no existing test)
* `test/consumer.test.ts` — queue consumer logic unchanged (just adding Discord notification)
* `test/rss.test.ts`, `test/podcast-index.test.ts`, `test/url-parser.test.ts`, `test/audio.test.ts`, `test/transcription.test.ts`, `test/summarization.test.ts`, `test/apple-podcasts.test.ts` — service tests unaffected
* `test/auth.test.ts`, `test/types.test.ts` — unaffected

## Activity Log Data Layer

The admin dashboard's "Recent Activity" section needs a data source. Jobs have a 1-day TTL in KV and disappear after completion, so there's no existing structure for historical activity.

**New KV key:** `activity:log`

**Structure:** A JSON array of the last 50 activity events, stored as a single KV value. Each event:

```typescript
interface ActivityEvent {
    type: "episode_completed" | "episode_failed" | "monitor_check" | "monitor_error";
    timestamp: string;        // ISO timestamp
    title: string;            // Human-readable summary
    details?: string;         // Error message or extra context
    episodeId?: string;       // For episode events
    podcastId?: string;       // For monitoring events
}
```

**TTL:** 30 days (longer than job TTL; old entries are pruned when the array exceeds 50 items)

**Write points:**
* `queue/consumer.ts` on job completion or failure (append `episode_completed` or `episode_failed`)
* `scheduledHandler` in `src/index.ts` after cron check (append `monitor_check` with summary, or `monitor_error` for failures)

**Read point:** `GET /admin` reads the log and renders the most recent entries

**New helpers in `src/lib/kv.ts`:**
* `appendActivityEvent(kv, event)` — reads the current log, appends the new event, prunes to 50 entries, writes back
* `getActivityLog(kv, limit?)` — reads and returns the last N events

This is a simple append-and-read pattern. No indexing needed since the list is capped at 50 events.

## Implementation Phases

### Phase 1: Route restructure and dead code removal

The biggest phase. Restructure routes and remove dead code.

1. Create `src/routes/admin.ts` with all admin routes (migrated from `authenticated.ts` with `/admin` prefix)
2. Remove non-admin code from `authenticated.ts` (or delete the file entirely, replacing with `admin.ts`)
3. Update `src/index.ts` to mount `admin.ts` at `/admin` instead of `authenticated.ts`
4. Remove from `src/routes/public.ts`:
   * `GET /submit`, `POST /submit` routes
   * `GET /waitlist`, `POST /waitlist` routes
   * `GET /job/:id`, `POST /job/:id/retry`, `POST /job/:id/delete` routes
   * `SubmitFormPage`, `WaitlistPage`, `JobStatusPage` components and supporting constants (`STATUS_LABELS`, `STATUS_PROGRESS`, `STATUS_ORDER`)
   * Layout `<head>` script block (auth probe, localStorage cache, `window.__authCheck`)
   * Layout `</body>` script block (`showLoggedIn()`, class toggling, stale-cache reload)
   * Three auth nav elements: Login link (`#nav-auth-link`), disabled Submit wrapper, hidden Submit button
   * `?loggedOut=1` query param handler and logout success banner on home page
   * Dead imports: `createJob`, `updateJobStatus`, `createJobDO`, `getJobWithFallback`, `updateJobStatusDO`, `deleteJobDO`, `enqueueJob`, `createProcessEpisodeMessage`, `getUserEmailFromJwt`, `isValidEmail`, `isBlockedPodcast`, `TIMEOUTS`
   * `getUserEmail()` helper function (only used by removed routes)
   * Update empty-state text on home page (remove "Click Submit in the nav bar" reference)
   * Update empty-state text on `/podcasts` page (remove link to `/submit`)
   * Update About page text (remove "invite-only" and user-facing submission descriptions)
5. Remove from `src/lib/kv.ts`: `listEpisodesByUser()`
6. Move `DELETE /api/job/:id` from `api.ts` to `admin.ts` (behind auth)
7. Clean up `src/lib/styles.ts`: remove auth-conditional and submit-button CSS
8. Update `robots.txt` in `src/index.ts`: remove `/job/` disallow, add `/admin/` disallow, remove dead `Sitemap: https://tldl-pod.com/sitemap.xml` reference (no `/sitemap.xml` route exists; consider implementing one later for SEO)
9. Update tests: remove `submit-job-html.test.ts`, rewrite `authenticated.test.ts`

### Phase 2: Admin dashboard

Build the new admin dashboard UI.

1. Add a new KV key pattern for the activity log (see "Activity Log Data Layer" below)
2. Implement `GET /admin` with:
   * Stats row (total episodes, total podcasts, error count, last check time)
   * Quick actions (Submit Episode, Manage Podcasts, Check All Now)
   * Recent Activity section (reads from the activity log)
   * Paginated episode list with tag editing, summary editing, delete
   * Admin tools section
3. Add new CSS for admin dashboard components
3. Move admin submit form to `GET /admin/submit`, `POST /admin/submit`
4. Wire active jobs display into admin dashboard

### Phase 3: Podcast monitoring improvements

Improve the podcast monitoring admin page.

1. Redesign `GET /admin/podcasts` with:
   * Status summary at top
   * Relative timestamps
   * Pause/resume toggle per podcast
   * Better error display
2. Add Discord webhook integration:
   * Create `src/lib/discord.ts`
   * Add `DISCORD_WEBHOOK_URL` to `Env` type
   * Wire into `scheduledHandler` (notify after cron check if errors)
   * Wire into `queue/consumer.ts` (notify on job failure)
3. Test Discord notifications end-to-end

### Phase 4: Request form + Postmark

Build the public "Request a Podcast" form.

**Note:** Phase 1 removes the waitlist link from the hero text, and Phase 4 adds the `/request` link. In the intermediate state (after Phase 1, before Phase 4), the hero text should say "Browse AI summaries below" without linking to either waitlist or request form. Phase 4 step 5 then adds the request link.

1. Create `src/services/postmark.ts` (minimal email client)
2. Add `POSTMARK_API_KEY`, `POSTMARK_FROM_EMAIL`, `ADMIN_NOTIFICATION_EMAIL` to `Env` type and `wrangler.toml`
3. Implement `GET /request` (form page with Turnstile)
4. Implement `POST /request` (validate Turnstile, send email via Postmark, show thank-you)
5. Update home page hero text to link to `/request`
6. Update About page to reference the request form
7. Update footer in `src/lib/components.ts` to include "Request a Podcast" link
8. DNS setup for Postmark (manual step)

### Phase 5: Cleanup and deploy

1. Update `AGENTS.md` to reflect new architecture
2. Archive `docs/email-pivot-plan.md` to `docs/_ARCHIVE/`
3. Run full test suite, fix any failures
4. Update `docs/todo.md` if keeping it
5. Manual: Update Cloudflare Access (protect `/admin/*`, remove `/profile/*`)
6. Manual: `wrangler secret put DISCORD_WEBHOOK_URL`
7. Manual: `wrangler secret put POSTMARK_API_KEY`
8. Deploy via `npm run deploy`
9. Smoke test: public pages, admin dashboard, submit flow, podcast monitoring, request form

## Security Notes

* **Unauthenticated job delete:** `DELETE /api/job/:jobId` is currently unauthenticated in `api.ts`. Moving it behind `/admin` fixes this.
* **`submittedBy` field:** Keep on the Episode type for backwards compatibility (existing data has it), but stop populating it on new submissions. It served no purpose without per-user tracking.
* **Fail-closed auth:** The `requireAuth` function in admin routes remains fail-closed — production requests without a valid CF Access JWT are rejected.
* **Turnstile stays:** Needed for the `/request` form to prevent spam. Can remove the `TURNSTILE_SITE_KEY` env var from wrangler.toml if not rendered in admin pages, but keep it for the public request form.

## Open Questions

* **Home page "In Progress" section:** Currently shows active jobs to everyone. Keep this? It's useful for you to see processing status without going to admin, and harmless for visitors. Recommendation: keep it but remove the link to `/job/:id` — just show status inline.
* **`/admin` bookmark:** Consider adding a browser bookmark bar shortcut or setting `/admin` as a pinned tab workflow. No code needed — just a usage pattern.
