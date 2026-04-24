# Broadsheet Redesign — Design Spec

**Date:** 2026-04-24
**Branch:** `redesign-broadsheet`
**Status:** Design approved; implementation plan to follow.

This spec covers the v1 redesign of tldl's public site to "The Broadsheet" editorial direction. The visual design (tokens, typography, layouts, components) is defined in full by `06-work/uploads/TLDL Direction A - Spec.md` and the reference mockups `broadsheet.jsx` / `detail.jsx` / `data.js` in the `product-ai` repo. This document does not re-litigate the visual design. It records the decisions made during brainstorming that adapt the spec to tldl's actual stack and content model, plus the rollout plan.

## Context

tldl is a Cloudflare Workers app (Hono). Pages are server-rendered HTML strings. Episodes and summaries live in KV. Subscriber data lives in D1. The Direction A spec was written against a React mockup with fabricated seed data, so several of its assumptions don't match production data.

**Scope for v1:**
* `/` (Index)
* `/episode/:id` (Detail)
* `/podcast/:id` (per-podcast listing, Index shell)
* `/tag/:tag` (per-tag listing, Index shell)

**Explicitly out of scope for v1:** `/subscribe`, `/preferences/manage`, admin routes, error/404 pages. These keep current styles.

## Decisions

### 1. Pull quote + deck — new fields going forward only

The design requires a one-sentence pull quote and a 1–2 sentence deck on every episode. Current summaries produce neither.

**Decision:** Add `deck` and `pullQuote` as new optional fields on the `Episode` type. Populate on ingest going forward; leave `null` on pre-redesign episodes. At render time:

* Missing `deck` → fall back to the first sentence of whichever summary template is being shown.
* Missing `pullQuote` → omit the pull-quote block entirely. On the Lead (home page), the two-column `3fr / 2fr` grid collapses to single-column when the lead episode has no quote.

No backfill. Pre-redesign episodes render the design with quote blocks absent. This is accepted visual inconsistency during the transition.

### 2. Template switching — route change, not client-side swap

The Direction A spec says sidebar template switching is "instant client-side swap, no route change." That's an aesthetic preference, not a functional requirement.

**Decision:** Full re-render via `?template=<kind>` query param. Clicking a template in the sidebar navigates to `/episode/:id?template=narrative` (or `eli5`, or `key-takeaways`). URLs are shareable. No JS required. Aligns with how the rest of tldl renders.

Sidebar only shows templates that exist for the episode (from the episode's generated-templates list). Default active template = whichever was the episode's primary template at generation time.

### 3. Lead picking — newest monitored episode

**Decision:** The Lead article on the Index is always the newest episode by `episodeDate`. Fully automatic. No editorial override in v1. An override layer is a 30-minute follow-up if it feels valuable later.

### 4. Masthead editorial metadata — live-computed

The masthead shows `Vol. III — No. 48`, `Friday, April 18, 2025`, `Est. MMXXIV`, `247 Episodes in the Archive`, `Issue ∞ — Continuously Revised`.

**Decision:** Live-compute on every request.

* **Vol** = Roman numeral of `(currentYear - LAUNCH_YEAR + 1)`. `LAUNCH_YEAR` is a hardcoded constant = `2024`, consistent with the "Est. MMXXIV" line in the masthead.
* **No** = ISO week of current date, as a decimal.
* **Date** = today, formatted `Friday, April 18, 2025`.
* **Archive count** = live count of episodes in the KV index.
* **"Est. MMXXIV"** and **"Issue ∞ — Continuously Revised"** = static string literals. The second is a joke; the first is fixed.

### 5. Transcript fallback — keep the rule, render a note

Transcripts are in R2 for monitored episodes but not universal. Older episodes may have none.

**Decision:** Always render the transcript section header and the `2px solid var(--bs-ink)` rule above it. When the transcript is missing, replace the body with a single italic line: `— transcript not available for this episode —`. Same visual rhythm as the spec's `— transcript continues, 48,213 words total —` footer.

### 6. Italic emphasis in titles — drop

The mockups italicize one word per title via hardcoded `<em>` (e.g. `the <em>unreasonable</em> compounding`). Real podcast episode titles don't carry emphasis hints.

**Decision:** Titles render plain in v1. No prompt-driven emphasis picking, no heuristics. The design still reads fine without it — pull quotes, drop caps, and mono metadata carry enough editorial texture.

### 7. Rollout — direct cutover in a branch

**Decision:** Work on `redesign-broadsheet`, merge to `main` when Index + Detail + `/podcast/:id` + `/tag/:tag` are complete end-to-end against real data. No feature flag, no preview route, no parallel deploy. Rollback = `git revert`. tldl is personal and low-traffic; the operational ceremony of a flag or parallel routes doesn't pay off here.

## Architecture

### Code layout

`src/routes/public.ts` (1700 lines) and `src/lib/styles.ts` (2000 lines) both need significant rework. Split the new code into focused modules:

```
src/lib/broadsheet/
  tokens.css.ts      // CSS custom properties + Google Fonts import
  shared.css.ts      // masthead, subnav, section-bar, footer
  index.css.ts       // .bs-* classes (Index + listing pages)
  detail.css.ts      // .bsd-* classes
  masthead.ts        // computeVolume(), computeIssueNumber(), renderMasthead()
  lead-picker.ts     // selectLeadEpisode(episodes): Episode
  index-row.ts       // renderIndexRow(ep, rowNumber)
  detail-page.ts     // renderDetailPage(ep, template, transcript)
```

`routes/public.ts` shrinks to route handlers that call into these modules. Nothing touches `styles.ts` except to delete the classes the Broadsheet replaces. Utility pages (subscribe, preferences, admin, errors) keep their current styles untouched in v1.

Constraint: `styles.ts` is used by more than the redesigned pages. Before deleting anything, grep each class to confirm it's only referenced by Broadsheet-targeted pages.

### Schema — TypeScript interface, not D1

Episodes live in KV at `episode:{id}`. Add two optional fields to the `Episode` interface in `src/types/index.ts`:

```ts
export interface Episode {
  // ...existing fields
  deck?: string;       // 1–2 sentence deck for Index + Detail
  pullQuote?: string;  // One-sentence aphoristic quote from the transcript
}
```

Summary generation prompt (wherever it currently lives — probably `src/services/` or similar) gains two required outputs: one deck, one pull quote. Deck = 1–2 complete sentences, sentence case, no ellipses, no "In this episode…". Pull quote = one aphoristic sentence from the transcript, no ellipses. Both written once per episode (not per template) and stored on the `Episode` record alongside existing metadata like `tags` and `podcastAuthor`.

The generation prompt receives the full transcript already — adding two output fields is cheap. Output schema changes from `{ summary, tags }` (or whatever the current shape is) to `{ summary, tags, deck, pullQuote }`.

### Data flow

**Index (`/`):**
1. Fetch `episodes:index` from KV → list of `EpisodeIndexEntry`.
2. `selectLeadEpisode(entries)` → newest. Hydrate full `Episode` for the lead to get `deck` + `pullQuote`.
3. Remaining entries render as index rows (use lightweight `EpisodeIndexEntry`; no hydration needed).
4. Masthead computed live.
5. Render to HTML string, return.

**Detail (`/episode/:id?template=<kind>`):**
1. Fetch `episode:{id}` from KV.
2. Fetch `summary:{id}:{template}` from KV.
3. Fetch transcript from R2 if available.
4. Render with topbar, article head, sidebar (only the templates that exist for this episode), body (template-specific content), and transcript section (or the italic fallback note).

**Per-podcast / per-tag:**
1. Filter `episodes:index` by podcast or tag.
2. Render Index shell with no Lead block. Section bar label reflects the filter.
3. All matching episodes render as numbered rows, most recent first.
4. Pagination remains as it is today (unchanged by redesign).

### Fonts

Four Google Fonts via the spec's `<link>` tag is a real perf hit but unblocks the cutover. Self-host variable WOFF2 in `public/fonts/` as a follow-up after merge, using the same metric-matched-fallback + preload pattern as elezea.com. Tracked as a post-merge task, not a v1 blocker.

## Testing

Three units justify tests; the rest is visual and checked by loading pages locally against real KV data.

* **`masthead.ts`** — `computeVolume(launchDate, now)` and `computeIssueNumber(now)` are pure functions. Table-driven unit tests with fixed dates covering year boundaries, ISO-week edge cases (week 53, early-January), and Roman-numeral correctness through at least Vol. X.
* **`lead-picker.ts`** — `selectLeadEpisode(episodes)` returns the newest. Cover empty list, single-episode, tie-breaking by `createdAt` when two share `episodeDate`.
* **Fallback rendering** — render Index + Detail with and without `deck` and `pullQuote` on the lead/episode. Assert the collapsed layouts don't leak class names or break structure. DOM string-contains assertions in vitest.

Visual QA: load `/`, `/episode/<newest>`, `/episode/<older-without-deck>`, `/podcast/<id>`, `/tag/ai` locally via `wrangler dev`. Check hover states, sticky sidebar, responsive breakpoints at 1280 / 1024 / 768 / 375.

## Risks

* **`styles.ts` coupling.** The 2000-line style file is shared across more than the redesigned pages. Grep each class before deletion. Do not attempt a broad styles cleanup in this branch — scope creep risk.
* **Pre-redesign episodes look subtly wrong.** Missing pull-quotes mean the home Lead sometimes renders single-column. Accepted tradeoff per Decision 1; will disappear as new episodes accumulate.
* **Font perf.** Google Fonts `<link>` is a temporary acceptance. Ship, self-host in a follow-up, don't let it block the cutover.

## Out of scope

* `/subscribe`, `/preferences/manage` redesign — v2 branch.
* Backfilling `deck` + `pullQuote` on existing episodes.
* Italicized emphasis words in titles.
* Self-hosted fonts (follow-up after merge).
* Light mode (Direction A is dark-only).
* Any engagement UI (share, like, comments) — excluded by the Direction A spec.
* Client-side template swap without route change.
* Broad cleanup of `styles.ts` beyond deleting classes the Broadsheet replaces.

## References

* `06-work/uploads/TLDL Direction A - Spec.md` — visual design source of truth (product-ai repo).
* `06-work/uploads/broadsheet.jsx`, `detail.jsx`, `data.js` — React reference mockups.
* `src/routes/public.ts`, `src/lib/styles.ts` — current rendering code to replace.
* `src/types/index.ts` — `Episode` interface to extend.
