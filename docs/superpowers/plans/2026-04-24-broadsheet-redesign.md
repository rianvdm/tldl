# Broadsheet Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign tldl's public site to "The Broadsheet" editorial direction: index, episode detail, per-podcast, and per-tag pages. Direct cutover on `redesign-broadsheet` branch.

**Architecture:** Server-rendered HTML strings in Hono. New code lives in `src/lib/broadsheet/` (tokens, shared chrome, index + detail CSS/markup, masthead math, lead picker). `src/routes/public.ts` handlers call into those modules. Two new optional fields on the `Episode` type (`deck`, `pullQuote`) are generated per episode during ingest; pre-redesign episodes render with graceful fallbacks.

**Tech Stack:** TypeScript, Hono, Cloudflare Workers, KV (episodes + summaries), R2 (transcripts), vitest for unit tests, wrangler for local dev.

**Design spec:** `docs/superpowers/specs/2026-04-24-broadsheet-redesign-design.md`. The visual design is locked in the `product-ai` repo at `06-work/uploads/TLDL Direction A - Spec.md` and mockups `broadsheet.jsx` + `detail.jsx`.

---

## File Structure

**Create:**
```
src/lib/broadsheet/
  tokens.css.ts        // CSS variables + @import Google Fonts
  shared.css.ts        // masthead, subnav, section-bar, footer CSS
  index.css.ts         // .bs-* classes (Lead + index rows)
  detail.css.ts        // .bsd-* classes
  masthead.ts          // computeVolume(), computeIssueNumber(), renderMasthead()
  lead-picker.ts       // selectLeadEpisode()
  chrome.ts            // renderSubnav(), renderFooter(), renderSectionBar()
  index-page.ts        // renderIndexPage(leadEp?, rows, variant)
  index-row.ts         // renderIndexRow(ep, rowNumber)
  lead.ts              // renderLead(ep)
  detail-page.ts       // renderDetailPage(ep, summary, template, transcript)
src/services/editorial-meta.ts   // generateEditorialMeta(transcript) → { deck, pullQuote }

tests/lib/broadsheet/
  masthead.test.ts
  lead-picker.test.ts
  lead.test.ts          // covers pullQuote/deck fallback
  index-row.test.ts     // covers deck fallback
  detail-page.test.ts   // covers transcript fallback
tests/services/editorial-meta.test.ts
```

**Modify:**
* `src/types/index.ts` — add `deck?: string` and `pullQuote?: string` to `Episode`.
* `src/queue/consumer.ts` — call `generateEditorialMeta` after transcription, before summary. Store result on the `Episode` KV record.
* `src/routes/public.ts` — replace index/episode/podcast/tag handlers to render via `broadsheet/*`.
* `src/lib/styles.ts` — delete only the classes the Broadsheet replaces. No broad cleanup.

---

## Task 1: Branch verification + Episode type extension

**Files:**
- Modify: `src/types/index.ts`

- [ ] **Step 1: Verify branch**

Run: `git branch --show-current`
Expected: `redesign-broadsheet`

If not on branch, run: `git checkout redesign-broadsheet`

- [ ] **Step 2: Extend Episode interface**

Edit `src/types/index.ts`, in the `Episode` interface (around line 46), add two new optional fields after `podcastWebsiteUrl?: string`:

```ts
    /** 1–2 sentence deck for Index + Detail hero. Populated going forward; null for pre-redesign episodes. */
    deck?: string;
    /** One-sentence aphoristic pull quote from the transcript. Populated going forward; null for pre-redesign episodes. */
    pullQuote?: string;
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: exit 0, no errors.

- [ ] **Step 4: Commit**

```bash
git add src/types/index.ts
git commit -m "feat(types): add deck + pullQuote to Episode"
```

---

## Task 2: Editorial meta generation service (TDD)

Model after `src/services/tag-generation.ts`. Single OpenAI call per episode, returns `{ deck, pullQuote }`.

**Files:**
- Create: `src/services/editorial-meta.ts`
- Test: `tests/services/editorial-meta.test.ts`

- [ ] **Step 1: Write failing test for parsing**

Create `tests/services/editorial-meta.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { parseEditorialMeta } from "../../src/services/editorial-meta";

describe("parseEditorialMeta", () => {
    it("extracts deck and pullQuote from JSON response", () => {
        const raw = JSON.stringify({
            deck: "A four-hour conversation about compounding.",
            pullQuote: "Patience is the only moat that scales.",
        });
        expect(parseEditorialMeta(raw)).toEqual({
            deck: "A four-hour conversation about compounding.",
            pullQuote: "Patience is the only moat that scales.",
        });
    });

    it("strips surrounding whitespace and trailing ellipses", () => {
        const raw = JSON.stringify({
            deck: "  A deck...  ",
            pullQuote: "  A quote.  ",
        });
        expect(parseEditorialMeta(raw)).toEqual({
            deck: "A deck",
            pullQuote: "A quote.",
        });
    });

    it("returns null when JSON is malformed", () => {
        expect(parseEditorialMeta("not json")).toBeNull();
    });

    it("returns null when fields are missing", () => {
        expect(parseEditorialMeta(JSON.stringify({ deck: "x" }))).toBeNull();
        expect(parseEditorialMeta(JSON.stringify({ pullQuote: "x" }))).toBeNull();
    });

    it("returns null when fields are empty strings", () => {
        expect(parseEditorialMeta(JSON.stringify({ deck: "", pullQuote: "x" }))).toBeNull();
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/services/editorial-meta.test.ts`
Expected: FAIL — `parseEditorialMeta` not exported.

- [ ] **Step 3: Implement the service (scaffold + parser)**

Create `src/services/editorial-meta.ts`:

```ts
/**
 * Editorial Meta Service — produces the 1–2 sentence deck and one-sentence
 * pull quote used in the Broadsheet design. Called once per episode during
 * ingest, stored on the Episode KV record.
 */

import { AppError } from "../lib/errors";
import { ERROR_CODES } from "../lib/constants";
import { withRetry, isServerError } from "../lib/retry";

export interface EditorialMeta {
    deck: string;
    pullQuote: string;
}

const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
const MODEL = "gpt-5.4";

const PROMPT = `You are writing for a weekly newspaper that summarizes podcast episodes.

Given the transcript below, produce two pieces of copy:

1. "deck": a 1–2 sentence descriptive deck in the voice of a print weekly.
   Complete sentences. Sentence case. No ellipses. No phrases like "In this
   episode" or "This episode explores". Describe what the conversation is
   about, not what it promises.

2. "pullQuote": a single aphoristic sentence taken or lightly condensed from
   the transcript. The kind of line a reader would screenshot. One sentence.
   No ellipses. Prefer the speaker's voice over paraphrase.

Respond with strict JSON matching the shape:
{ "deck": string, "pullQuote": string }

No prose, no code fences, JSON only.`;

export function parseEditorialMeta(raw: string): EditorialMeta | null {
    let data: unknown;
    try {
        data = JSON.parse(raw.trim());
    } catch {
        return null;
    }
    if (!data || typeof data !== "object") return null;
    const obj = data as Record<string, unknown>;
    if (typeof obj.deck !== "string" || typeof obj.pullQuote !== "string") return null;
    const deck = obj.deck.trim().replace(/\.{3,}$/, "");
    const pullQuote = obj.pullQuote.trim().replace(/\.{3,}$/, "");
    if (!deck || !pullQuote) return null;
    return { deck, pullQuote };
}

export async function generateEditorialMeta(
    transcript: string,
    openaiApiKey: string
): Promise<EditorialMeta> {
    const result = await withRetry(
        () => callApi(transcript, openaiApiKey),
        { maxRetries: 3, baseDelayMs: 1000, shouldRetry: isServerError }
    );
    return result;
}

async function callApi(transcript: string, apiKey: string): Promise<EditorialMeta> {
    const response = await fetch(OPENAI_RESPONSES_URL, {
        method: "POST",
        headers: {
            "Authorization": `Bearer ${apiKey}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify({
            model: MODEL,
            instructions: PROMPT,
            input: transcript,
        }),
    });

    if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new AppError(
            ERROR_CODES.SUMMARIZATION_FAILED,
            `Editorial meta generation failed: ${response.status} ${body.slice(0, 500)}`
        );
    }

    const data: any = await response.json();
    const text: string | undefined = data?.output?.[0]?.content?.[0]?.text;
    if (!text) {
        throw new AppError(
            ERROR_CODES.SUMMARIZATION_FAILED,
            "Editorial meta response missing text output"
        );
    }

    const parsed = parseEditorialMeta(text);
    if (!parsed) {
        throw new AppError(
            ERROR_CODES.SUMMARIZATION_FAILED,
            `Editorial meta response could not be parsed as JSON: ${text.slice(0, 200)}`
        );
    }
    return parsed;
}
```

- [ ] **Step 4: Verify parser tests pass**

Run: `npx vitest run tests/services/editorial-meta.test.ts`
Expected: all 5 tests pass.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/services/editorial-meta.ts tests/services/editorial-meta.test.ts
git commit -m "feat(services): add editorial-meta generation (deck + pullQuote)"
```

---

## Task 3: Wire editorial-meta into the ingest queue

Find the code path that stores a new `Episode` record after transcription in `src/queue/consumer.ts`. That's where `tags` are populated today. Add `deck` and `pullQuote` alongside tags.

**Files:**
- Modify: `src/queue/consumer.ts`

- [ ] **Step 1: Locate the ingest flow**

Run: `grep -n "generateEpisodeTags\|tags:" src/queue/consumer.ts`

Identify the block that calls `generateEpisodeTags` and writes the `Episode` record to KV. That's the insertion point.

- [ ] **Step 2: Add editorial-meta call next to the tags call**

In the block identified in Step 1, after the `generateEpisodeTags` call, add:

```ts
import { generateEditorialMeta } from "../services/editorial-meta";

// ... inside the ingest function, after tags are generated:
let editorial: { deck?: string; pullQuote?: string } = {};
try {
    const meta = await generateEditorialMeta(transcript, env.OPENAI_API_KEY);
    editorial = { deck: meta.deck, pullQuote: meta.pullQuote };
} catch (err) {
    // Don't fail ingest if editorial-meta generation fails — log and continue.
    console.error("editorial-meta generation failed", err);
}
```

Then include `deck: editorial.deck` and `pullQuote: editorial.pullQuote` when constructing the `Episode` object written to KV. Confirm the KV write site includes both fields.

The import statement goes at the top of the file alongside the existing `generateSummary` / `generateEpisodeTags` imports.

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: exit 0.

- [ ] **Step 4: Run existing tests**

Run: `npm test`
Expected: pre-existing pass count holds (no regressions).

- [ ] **Step 5: Commit**

```bash
git add src/queue/consumer.ts
git commit -m "feat(ingest): populate deck + pullQuote on new Episodes"
```

---

## Task 4: Masthead math (TDD)

Pure functions: `computeVolume(year)`, `computeIssueNumber(date)`.

**Files:**
- Create: `src/lib/broadsheet/masthead.ts`
- Test: `tests/lib/broadsheet/masthead.test.ts`

- [ ] **Step 1: Write failing tests**

Create `tests/lib/broadsheet/masthead.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { computeVolume, computeIssueNumber } from "../../../src/lib/broadsheet/masthead";

describe("computeVolume", () => {
    it("returns Vol. I in the launch year", () => {
        expect(computeVolume(2024)).toBe("I");
    });
    it("returns Vol. II one year later", () => {
        expect(computeVolume(2025)).toBe("II");
    });
    it("returns Vol. III two years later", () => {
        expect(computeVolume(2026)).toBe("III");
    });
    it("returns Vol. X after nine years", () => {
        expect(computeVolume(2033)).toBe("X");
    });
});

describe("computeIssueNumber", () => {
    it("returns ISO week for early January", () => {
        expect(computeIssueNumber(new Date("2026-01-05T12:00:00Z"))).toBe(2);
    });
    it("returns week 1 when Jan 4 falls in week 1", () => {
        // ISO-8601: week 1 is the week containing Jan 4
        expect(computeIssueNumber(new Date("2026-01-04T12:00:00Z"))).toBe(1);
    });
    it("returns week 52 for a late-December date", () => {
        expect(computeIssueNumber(new Date("2024-12-23T12:00:00Z"))).toBe(52);
    });
    it("returns week 53 when the year has one", () => {
        // 2020 had 53 ISO weeks
        expect(computeIssueNumber(new Date("2020-12-28T12:00:00Z"))).toBe(53);
    });
});
```

- [ ] **Step 2: Verify tests fail**

Run: `npx vitest run tests/lib/broadsheet/masthead.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `src/lib/broadsheet/masthead.ts`:

```ts
export const LAUNCH_YEAR = 2024;

const ROMAN = [
    ["", "I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX"],
    ["", "X", "XX", "XXX", "XL", "L", "LX", "LXX", "LXXX", "XC"],
    ["", "C", "CC", "CCC", "CD", "D", "DC", "DCC", "DCCC", "CM"],
    ["M", "MM", "MMM"],
];

function toRoman(n: number): string {
    if (n < 1) return "";
    const digits = String(n).split("").reverse();
    let out = "";
    for (let i = digits.length - 1; i >= 0; i--) {
        const d = Number(digits[i]);
        const table = ROMAN[i];
        if (table && table[d] !== undefined) out += table[d];
    }
    return out;
}

export function computeVolume(year: number): string {
    return toRoman(year - LAUNCH_YEAR + 1);
}

/** Returns the ISO-8601 week number for the given date (1–53). */
export function computeIssueNumber(date: Date): number {
    // Copy date, set to Thursday of the same ISO week (ISO week is defined by its Thursday)
    const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
    const dayNum = d.getUTCDay() || 7; // Sun=0 → 7
    d.setUTCDate(d.getUTCDate() + 4 - dayNum);
    const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    return Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
}
```

- [ ] **Step 4: Verify tests pass**

Run: `npx vitest run tests/lib/broadsheet/masthead.test.ts`
Expected: all 8 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/lib/broadsheet/masthead.ts tests/lib/broadsheet/masthead.test.ts
git commit -m "feat(broadsheet): masthead math (volume + ISO week)"
```

---

## Task 5: Lead picker (TDD)

**Files:**
- Create: `src/lib/broadsheet/lead-picker.ts`
- Test: `tests/lib/broadsheet/lead-picker.test.ts`

- [ ] **Step 1: Write failing tests**

Create `tests/lib/broadsheet/lead-picker.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { selectLeadEpisode } from "../../../src/lib/broadsheet/lead-picker";
import type { EpisodeIndexEntry } from "../../../src/types";

function ep(overrides: Partial<EpisodeIndexEntry>): EpisodeIndexEntry {
    return {
        id: "x",
        podcastName: "Pod",
        episodeTitle: "Title",
        episodeDate: "2026-01-01",
        episodeDuration: 3600,
        createdAt: "2026-01-01T00:00:00Z",
        expiresAt: "2027-01-01T00:00:00Z",
        ...overrides,
    };
}

describe("selectLeadEpisode", () => {
    it("returns null on empty list", () => {
        expect(selectLeadEpisode([])).toBeNull();
    });
    it("returns the only episode when list has one", () => {
        const one = ep({ id: "a" });
        expect(selectLeadEpisode([one])).toBe(one);
    });
    it("returns the newest by episodeDate", () => {
        const older = ep({ id: "a", episodeDate: "2026-01-01" });
        const newer = ep({ id: "b", episodeDate: "2026-02-01" });
        expect(selectLeadEpisode([older, newer])).toBe(newer);
        expect(selectLeadEpisode([newer, older])).toBe(newer);
    });
    it("breaks ties by createdAt when episodeDate is identical", () => {
        const a = ep({ id: "a", episodeDate: "2026-02-01", createdAt: "2026-02-01T08:00:00Z" });
        const b = ep({ id: "b", episodeDate: "2026-02-01", createdAt: "2026-02-01T12:00:00Z" });
        expect(selectLeadEpisode([a, b])).toBe(b);
    });
});
```

- [ ] **Step 2: Verify tests fail**

Run: `npx vitest run tests/lib/broadsheet/lead-picker.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

Create `src/lib/broadsheet/lead-picker.ts`:

```ts
import type { EpisodeIndexEntry } from "../../types";

export function selectLeadEpisode<T extends EpisodeIndexEntry>(episodes: T[]): T | null {
    if (episodes.length === 0) return null;
    return episodes.reduce((best, cur) => {
        if (cur.episodeDate > best.episodeDate) return cur;
        if (cur.episodeDate < best.episodeDate) return best;
        return cur.createdAt > best.createdAt ? cur : best;
    });
}
```

- [ ] **Step 4: Verify tests pass**

Run: `npx vitest run tests/lib/broadsheet/lead-picker.test.ts`
Expected: all 4 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/lib/broadsheet/lead-picker.ts tests/lib/broadsheet/lead-picker.test.ts
git commit -m "feat(broadsheet): lead picker (newest episodeDate)"
```

---

## Task 6: CSS tokens + shared chrome

No tests — pure CSS strings. Visual QA covers correctness.

**Files:**
- Create: `src/lib/broadsheet/tokens.css.ts`
- Create: `src/lib/broadsheet/shared.css.ts`

- [ ] **Step 1: Write tokens module**

Create `src/lib/broadsheet/tokens.css.ts`:

```ts
export const BROADSHEET_FONTS_LINK = `<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Fraunces:ital,wght@0,400;0,500;0,600;0,900;1,400;1,500;1,600&family=Inter+Tight:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&family=Space+Grotesk:wght@400;500;600;700&display=swap" rel="stylesheet">`;

export const BROADSHEET_TOKENS_CSS = `
:root {
  --bs-ink: #f1ece3;
  --bs-ink-dim: #b8b0a3;
  --bs-ink-faint: #6f685d;
  --bs-paper: #10100e;
  --bs-paper-elev: #17170f;
  --bs-rule: #2a2a24;
  --bs-rule-strong: #4a4a40;
  --bs-red: #e63946;
  --bs-red-deep: #b92a35;
}
html, body {
  background: var(--bs-paper);
  color: var(--bs-ink);
  margin: 0;
  font-family: 'Inter Tight', system-ui, sans-serif;
  font-feature-settings: "ss01", "ss02", "cv11";
}
* { box-sizing: border-box; }
a { color: inherit; text-decoration: none; }
`;
```

- [ ] **Step 2: Write shared chrome module**

Create `src/lib/broadsheet/shared.css.ts`. Copy the masthead, subnav, section-bar, and footer CSS from `06-work/uploads/broadsheet.jsx` in the `product-ai` repo, adapting class names verbatim. Exact rules:

```ts
export const BROADSHEET_SHARED_CSS = `
/* Container */
.bs-page { width: 100%; max-width: 1280px; margin: 0 auto; min-height: 100vh; }

/* Masthead */
.bs-mast {
  border-bottom: 2px solid var(--bs-ink);
  padding: 28px 56px 20px;
  display: grid;
  grid-template-columns: 1fr auto 1fr;
  align-items: end;
  gap: 24px;
}
.bs-mast-left, .bs-mast-right {
  font-family: 'JetBrains Mono', ui-monospace, monospace;
  font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase;
  color: var(--bs-ink-faint); line-height: 1.7;
}
.bs-mast-right { text-align: right; }
.bs-mast-left b, .bs-mast-right b { color: var(--bs-ink-dim); font-weight: 500; }
.bs-wordmark {
  font-family: 'Fraunces', Georgia, serif;
  font-style: italic; font-weight: 900;
  font-size: 86px; letter-spacing: -0.04em; line-height: 0.9;
  text-align: center; color: var(--bs-ink);
}
.bs-wordmark .dot, .bs-wordmark .l { color: var(--bs-red); font-style: normal; }

/* Subnav */
.bs-subhead {
  padding: 10px 56px 14px;
  display: flex; justify-content: space-between; align-items: baseline;
  font-family: 'JetBrains Mono', ui-monospace, monospace;
  font-size: 10.5px; letter-spacing: 0.14em; text-transform: uppercase;
  color: var(--bs-ink-faint);
  border-bottom: 0.5px solid var(--bs-rule);
}
.bs-subhead .nav-items { display: flex; gap: 28px; }
.bs-subhead .nav-items a { color: var(--bs-ink-dim); }
.bs-subhead .nav-items a.active { color: var(--bs-red); }

/* Section bar */
.bs-section-bar {
  display: flex; align-items: baseline; gap: 16px;
  padding: 28px 56px 12px;
}
.bs-section-bar h2 {
  font-family: 'Fraunces', Georgia, serif;
  font-style: italic; font-weight: 500; font-size: 22px;
  letter-spacing: -0.01em; color: var(--bs-ink); margin: 0;
}
.bs-section-bar .rule { flex: 1; height: 1px; background: var(--bs-rule-strong); }
.bs-section-bar .count {
  font-family: 'JetBrains Mono', ui-monospace, monospace;
  font-size: 11px; letter-spacing: 0.14em; text-transform: uppercase;
  color: var(--bs-ink-faint);
}

/* Footer */
.bs-footer {
  border-top: 2px solid var(--bs-ink);
  margin-top: 24px; padding: 20px 56px;
  display: flex; justify-content: space-between;
  font-family: 'JetBrains Mono', ui-monospace, monospace;
  font-size: 10.5px; letter-spacing: 0.14em; text-transform: uppercase;
  color: var(--bs-ink-faint);
}

@media (max-width: 1023px) {
  .bs-mast, .bs-subhead, .bs-section-bar, .bs-footer { padding-left: 40px; padding-right: 40px; }
}
@media (max-width: 767px) {
  .bs-mast { padding: 20px; grid-template-columns: 1fr; text-align: center; }
  .bs-mast-left, .bs-mast-right { text-align: center; }
  .bs-wordmark { font-size: 56px; }
  .bs-subhead { padding: 10px 20px; flex-wrap: wrap; gap: 12px; }
  .bs-section-bar { padding: 20px; }
  .bs-footer { padding: 20px; }
}
`;
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
git add src/lib/broadsheet/tokens.css.ts src/lib/broadsheet/shared.css.ts
git commit -m "feat(broadsheet): css tokens + shared chrome"
```

---

## Task 7: Chrome helpers (masthead + subnav + footer + section bar)

HTML-returning helpers that assemble the shared chrome.

**Files:**
- Create: `src/lib/broadsheet/chrome.ts`

- [ ] **Step 1: Write the chrome helpers**

Create `src/lib/broadsheet/chrome.ts`:

```ts
import { computeVolume, computeIssueNumber, LAUNCH_YEAR } from "./masthead";

const ROMAN_LAUNCH = "MMXXIV"; // 2024

export function renderMasthead(opts: { now: Date; episodeCount: number }): string {
    const { now, episodeCount } = opts;
    const vol = computeVolume(now.getUTCFullYear());
    const no = computeIssueNumber(now);
    const longDate = now.toLocaleDateString("en-US", {
        weekday: "long", year: "numeric", month: "long", day: "numeric",
    });
    return `<div class="bs-mast">
  <div class="bs-mast-left">
    <div><b>Vol. ${vol} — No. ${no}</b></div>
    <div>${longDate}</div>
    <div>Est. ${ROMAN_LAUNCH}</div>
  </div>
  <div class="bs-wordmark" aria-label="TL;DL — Too Long, Didn't Listen">T<span class="dot">L</span>;D<span class="l">L</span></div>
  <div class="bs-mast-right">
    <div><b>Too Long, Didn't Listen</b></div>
    <div>A Weekly Ledger of Long-Form Audio</div>
    <div>${episodeCount} ${episodeCount === 1 ? "Episode" : "Episodes"} in the Archive</div>
  </div>
</div>`;
}

export type SubnavKey = "index" | "podcasts" | "archive" | "tags" | "subscribe";

export function renderSubnav(active: SubnavKey): string {
    const items: Array<{ key: SubnavKey; label: string; href: string }> = [
        { key: "index", label: "Today's Index", href: "/" },
        { key: "tags", label: "By Tag", href: "/tag" },
        { key: "subscribe", label: "Subscribe", href: "/subscribe" },
    ];
    return `<div class="bs-subhead">
  <div class="nav-items">
    ${items.map(i => `<a href="${i.href}" class="${i.key === active ? "active" : ""}">${i.label}</a>`).join("")}
  </div>
  <div>Issue ∞ — Continuously Revised</div>
</div>`;
}

export function renderSectionBar(heading: string, count: string): string {
    return `<div class="bs-section-bar">
  <h2>${heading}</h2>
  <span class="rule"></span>
  <span class="count">${count}</span>
</div>`;
}

export function renderFooter(): string {
    return `<div class="bs-footer">
  <span>TL;DL · A curated audio ledger</span>
  <span>&nbsp;</span>
</div>`;
}

// Exposed for tests + callers that want the same anchor date tldl uses
export { LAUNCH_YEAR };
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add src/lib/broadsheet/chrome.ts
git commit -m "feat(broadsheet): chrome helpers (masthead, subnav, section bar, footer)"
```

---

## Task 8: Index page CSS + Lead + Row (with fallback tests)

**Files:**
- Create: `src/lib/broadsheet/index.css.ts`
- Create: `src/lib/broadsheet/lead.ts`
- Create: `src/lib/broadsheet/index-row.ts`
- Test: `tests/lib/broadsheet/lead.test.ts`
- Test: `tests/lib/broadsheet/index-row.test.ts`

- [ ] **Step 1: Index CSS**

Create `src/lib/broadsheet/index.css.ts`:

```ts
export const BROADSHEET_INDEX_CSS = `
/* LEAD */
.bs-lead {
  padding: 40px 56px 32px;
  display: grid;
  grid-template-columns: 3fr 2fr;
  gap: 48px;
  border-bottom: 1px solid var(--bs-rule);
}
.bs-lead.single { grid-template-columns: 1fr; }
.bs-lead-dateline {
  font-family: 'JetBrains Mono', ui-monospace, monospace;
  font-size: 10.5px; letter-spacing: 0.14em; text-transform: uppercase;
  color: var(--bs-red); margin-bottom: 16px;
  display: flex; align-items: center; gap: 10px;
}
.bs-lead-dateline::after { content: ""; flex: 1; height: 1px; background: var(--bs-rule-strong); }
.bs-lead-kicker {
  font-family: 'JetBrains Mono', ui-monospace, monospace;
  font-size: 10.5px; letter-spacing: 0.14em; text-transform: uppercase;
  color: var(--bs-ink-faint); margin-bottom: 10px;
}
.bs-lead-title {
  font-family: 'Fraunces', Georgia, serif;
  font-weight: 500; font-size: 58px; letter-spacing: -0.025em;
  line-height: 1.02; margin: 0 0 18px; color: var(--bs-ink); text-wrap: balance;
}
.bs-lead-deck {
  font-family: 'Fraunces', Georgia, serif;
  font-weight: 400; font-size: 20px; line-height: 1.45;
  color: var(--bs-ink-dim); max-width: 52ch; text-wrap: pretty; margin: 0;
}
.bs-lead-meta {
  margin-top: 26px; display: flex; gap: 18px; flex-wrap: wrap; align-items: center;
  font-family: 'JetBrains Mono', ui-monospace, monospace;
  font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--bs-ink-faint);
}
.bs-lead-meta .sep { color: var(--bs-rule-strong); }
.bs-lead-meta .chip {
  color: var(--bs-red); border: 1px solid var(--bs-red-deep);
  padding: 3px 8px; letter-spacing: 0.14em;
}
.bs-pull { border-left: 2px solid var(--bs-red); padding: 4px 0 4px 24px; }
.bs-pull .q-mark {
  font-family: 'Fraunces', Georgia, serif;
  font-size: 90px; line-height: 0.6; color: var(--bs-red);
  display: block; margin-bottom: 8px;
}
.bs-pull-q {
  font-family: 'Fraunces', Georgia, serif;
  font-style: italic; font-size: 22px; line-height: 1.35;
  color: var(--bs-ink); text-wrap: pretty;
}
.bs-pull-src {
  display: block; margin-top: 18px;
  font-family: 'JetBrains Mono', ui-monospace, monospace;
  font-size: 10.5px; letter-spacing: 0.14em; text-transform: uppercase; color: var(--bs-ink-faint);
}

/* Index rows */
.bs-index { padding: 0 56px 48px; }
.bs-row {
  display: grid;
  grid-template-columns: 48px 1fr 160px 100px 120px 24px;
  gap: 24px; padding: 22px 0;
  border-top: 1px solid var(--bs-rule);
  align-items: baseline;
  transition: background 160ms ease;
}
.bs-row:last-child { border-bottom: 1px solid var(--bs-rule); }
.bs-row:hover { background: rgba(230,57,70,0.04); }
.bs-row:hover .bs-row-num { color: var(--bs-red); }
.bs-row:hover .bs-row-arrow { color: var(--bs-red); transform: translateX(4px); }
.bs-row-num {
  font-family: 'JetBrains Mono', ui-monospace, monospace;
  font-size: 11px; letter-spacing: 0.1em; color: var(--bs-ink-faint);
  transition: color 160ms ease;
}
.bs-row-pod {
  font-family: 'JetBrains Mono', ui-monospace, monospace;
  font-size: 10.5px; letter-spacing: 0.14em; text-transform: uppercase;
  color: var(--bs-ink-faint); margin-bottom: 6px;
}
.bs-row-pod b { color: var(--bs-ink-dim); font-weight: 500; }
.bs-row-title {
  font-family: 'Fraunces', Georgia, serif;
  font-weight: 500; font-size: 24px; line-height: 1.15;
  letter-spacing: -0.015em; color: var(--bs-ink);
  text-wrap: balance; margin-bottom: 6px;
}
.bs-row-blurb {
  font-family: 'Inter Tight', sans-serif;
  font-size: 14px; line-height: 1.5; color: var(--bs-ink-dim);
  max-width: 62ch; text-wrap: pretty;
}
.bs-row-date, .bs-row-dur, .bs-row-tag {
  font-family: 'JetBrains Mono', ui-monospace, monospace;
  font-size: 11px; letter-spacing: 0.1em; text-transform: uppercase;
  color: var(--bs-ink-dim); align-self: start; padding-top: 24px;
}
.bs-row-tag { color: var(--bs-red); }
.bs-row-arrow {
  color: var(--bs-ink-faint);
  font-family: 'JetBrains Mono', ui-monospace, monospace;
  transition: transform 160ms ease, color 160ms ease;
  align-self: start; padding-top: 24px;
}

@media (max-width: 1023px) {
  .bs-lead, .bs-index { padding-left: 40px; padding-right: 40px; }
}
@media (max-width: 767px) {
  .bs-lead { padding: 20px; grid-template-columns: 1fr; gap: 24px; }
  .bs-lead-title { font-size: 40px; }
  .bs-index { padding: 0 20px 32px; }
  .bs-row { grid-template-columns: 40px 1fr 80px 80px; gap: 16px; }
  .bs-row .bs-row-arrow, .bs-row .bs-row-tag { display: none; }
}
`;
```

- [ ] **Step 2: Write failing tests for Lead fallback**

Create `tests/lib/broadsheet/lead.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { renderLead } from "../../../src/lib/broadsheet/lead";
import type { Episode } from "../../../src/types";

function ep(overrides: Partial<Episode> = {}): Episode {
    return {
        id: "ep-1",
        appleUrl: "https://example.com",
        podcastName: "Acquired",
        episodeTitle: "Nvidia — The Dawn of the AI Era",
        episodeDuration: 15120,
        episodeDate: "2026-04-18",
        audioUrl: "https://example.com/a.mp3",
        transcriptSource: "rss",
        createdAt: "2026-04-18T00:00:00Z",
        expiresAt: "2027-04-18T00:00:00Z",
        podcastAuthor: "Ben Gilbert & David Rosenthal",
        tags: ["technology"],
        ...overrides,
    } as Episode;
}

describe("renderLead", () => {
    it("renders two-column grid when pullQuote is present", () => {
        const html = renderLead(ep({
            deck: "A four-hour conversation about compounding.",
            pullQuote: "Patience is the only moat that scales.",
        }));
        expect(html).toContain('class="bs-lead"');
        expect(html).not.toContain('class="bs-lead single"');
        expect(html).toContain("bs-pull");
        expect(html).toContain("Patience is the only moat that scales.");
    });

    it("collapses to single-column when pullQuote is missing", () => {
        const html = renderLead(ep({
            deck: "A deck line.",
            pullQuote: undefined,
        }));
        expect(html).toContain('class="bs-lead single"');
        expect(html).not.toContain("bs-pull");
    });

    it("falls back to empty deck when missing (no 'undefined' leak)", () => {
        const html = renderLead(ep({ deck: undefined, pullQuote: undefined }));
        expect(html).not.toContain("undefined");
    });

    it("renders the episode title as H1", () => {
        const html = renderLead(ep({ deck: "d", pullQuote: "q" }));
        expect(html).toMatch(/<h1[^>]*class="bs-lead-title"[^>]*>\s*Nvidia/);
    });

    it("links to the episode detail page", () => {
        const html = renderLead(ep({ id: "abc123" }));
        expect(html).toContain('href="/episode/abc123"');
    });
});
```

- [ ] **Step 3: Verify Lead tests fail**

Run: `npx vitest run tests/lib/broadsheet/lead.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement renderLead**

Create `src/lib/broadsheet/lead.ts`:

```ts
import type { Episode } from "../../types";

function escape(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function shortDate(iso: string): string {
    return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function formatDuration(seconds: number): string {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    return h > 0 ? `${h}h ${m.toString().padStart(2, "0")}m` : `${m}m`;
}

function firstTag(ep: Episode): string {
    return (ep.tags && ep.tags[0]) || "";
}

export function renderLead(ep: Episode): string {
    const hasPull = Boolean(ep.pullQuote);
    const deck = ep.deck ?? "";
    const tag = firstTag(ep);
    const podcastUc = escape(ep.podcastName).toUpperCase();
    const authorUc = ep.podcastAuthor ? ` · BY ${escape(ep.podcastAuthor).toUpperCase()}` : "";
    const href = `/episode/${encodeURIComponent(ep.id)}`;

    return `<div class="bs-lead${hasPull ? "" : " single"}">
  <div>
    <div class="bs-lead-dateline">The Lead — ${shortDate(ep.episodeDate)} Edition</div>
    <div class="bs-lead-kicker">${podcastUc}${authorUc}</div>
    <h1 class="bs-lead-title"><a href="${href}">${escape(ep.episodeTitle)}</a></h1>
    ${deck ? `<p class="bs-lead-deck">${escape(deck)}</p>` : ""}
    <div class="bs-lead-meta">
      <span>${formatDuration(ep.episodeDuration)}</span>
      <span class="sep">/</span>
      <span>${shortDate(ep.episodeDate)}</span>
      ${tag ? `<span class="sep">/</span><span class="chip">${escape(tag)}</span>` : ""}
    </div>
  </div>
  ${hasPull ? `<div class="bs-pull">
    <span class="q-mark">“</span>
    <span class="bs-pull-q">${escape(ep.pullQuote!)}</span>
    <span class="bs-pull-src">— From the episode</span>
  </div>` : ""}
</div>`;
}
```

- [ ] **Step 5: Verify Lead tests pass**

Run: `npx vitest run tests/lib/broadsheet/lead.test.ts`
Expected: all 5 tests pass.

- [ ] **Step 6: Write failing tests for index-row deck fallback**

Create `tests/lib/broadsheet/index-row.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { renderIndexRow } from "../../../src/lib/broadsheet/index-row";
import type { EpisodeIndexEntry } from "../../../src/types";

function ep(overrides: Partial<EpisodeIndexEntry & { deck?: string }> = {}): EpisodeIndexEntry & { deck?: string } {
    return {
        id: "ep-2",
        podcastName: "The Ezra Klein Show",
        episodeTitle: "The Case Against Productivity",
        episodeDate: "2026-04-16",
        episodeDuration: 3840,
        createdAt: "2026-04-16T00:00:00Z",
        expiresAt: "2027-04-16T00:00:00Z",
        podcastAuthor: "New York Times",
        tags: ["psychology"],
        ...overrides,
    };
}

describe("renderIndexRow", () => {
    it("renders a row with number, title, date, duration, tag, arrow", () => {
        const html = renderIndexRow(ep({ deck: "A deck." }), 2);
        expect(html).toContain("№ 02");
        expect(html).toContain("The Case Against Productivity");
        expect(html).toContain("Apr 16");
        expect(html).toContain("1h 04m");
        expect(html).toContain("psychology");
        expect(html).toContain("→");
    });

    it("renders deck in the blurb slot when present", () => {
        const html = renderIndexRow(ep({ deck: "Argument against productivity culture." }), 2);
        expect(html).toContain("Argument against productivity culture.");
    });

    it("omits the blurb element entirely when deck is missing", () => {
        const html = renderIndexRow(ep({ deck: undefined }), 2);
        expect(html).not.toContain("bs-row-blurb");
        expect(html).not.toContain("undefined");
    });

    it("pads row numbers to 2 digits", () => {
        expect(renderIndexRow(ep(), 1)).toContain("№ 01");
        expect(renderIndexRow(ep(), 10)).toContain("№ 10");
    });

    it("wraps the row in a link to /episode/:id", () => {
        const html = renderIndexRow(ep({ id: "xyz" }), 2);
        expect(html).toMatch(/<a[^>]+href="\/episode\/xyz"[^>]+class="bs-row"/);
    });
});
```

- [ ] **Step 7: Verify index-row tests fail**

Run: `npx vitest run tests/lib/broadsheet/index-row.test.ts`
Expected: FAIL.

- [ ] **Step 8: Implement renderIndexRow**

Create `src/lib/broadsheet/index-row.ts`:

```ts
import type { EpisodeIndexEntry } from "../../types";

function escape(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function shortDate(iso: string): string {
    return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function formatDuration(seconds: number): string {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    return h > 0 ? `${h}h ${m.toString().padStart(2, "0")}m` : `${m}m`;
}

/** Index entries may carry a deck (added going forward). */
export function renderIndexRow(ep: EpisodeIndexEntry & { deck?: string }, rowNumber: number): string {
    const num = String(rowNumber).padStart(2, "0");
    const tag = (ep.tags && ep.tags[0]) ?? "";
    const deck = ep.deck;
    const href = `/episode/${encodeURIComponent(ep.id)}`;
    const authorPart = ep.podcastAuthor ? ` · ${escape(ep.podcastAuthor)}` : "";

    return `<a class="bs-row" href="${href}">
  <div class="bs-row-num">№ ${num}</div>
  <div class="bs-row-body">
    <div class="bs-row-pod"><b>${escape(ep.podcastName)}</b>${authorPart}</div>
    <div class="bs-row-title">${escape(ep.episodeTitle)}</div>
    ${deck ? `<div class="bs-row-blurb">${escape(deck)}</div>` : ""}
  </div>
  <div class="bs-row-date">${shortDate(ep.episodeDate)}</div>
  <div class="bs-row-dur">${formatDuration(ep.episodeDuration)}</div>
  <div class="bs-row-tag">${escape(tag)}</div>
  <div class="bs-row-arrow">→</div>
</a>`;
}
```

Note: the `<a class="bs-row">` wrapper requires the row CSS to treat a flex/grid on `<a>` — already covered by `display: grid` in Task 8 Step 1.

- [ ] **Step 9: Verify index-row tests pass**

Run: `npx vitest run tests/lib/broadsheet/index-row.test.ts`
Expected: all 5 tests pass.

- [ ] **Step 10: Commit**

```bash
git add src/lib/broadsheet/index.css.ts src/lib/broadsheet/lead.ts src/lib/broadsheet/index-row.ts tests/lib/broadsheet/lead.test.ts tests/lib/broadsheet/index-row.test.ts
git commit -m "feat(broadsheet): index page markup (lead + row) with fallback tests"
```

---

## Task 9: Index page composer + route wiring

Compose tokens + shared + index CSS + chrome + Lead + rows into a full HTML page. Wire up `GET /`.

**Files:**
- Create: `src/lib/broadsheet/index-page.ts`
- Modify: `src/routes/public.ts`

- [ ] **Step 1: Compose the index page**

Create `src/lib/broadsheet/index-page.ts`:

```ts
import type { Episode, EpisodeIndexEntry } from "../../types";
import { BROADSHEET_FONTS_LINK, BROADSHEET_TOKENS_CSS } from "./tokens.css";
import { BROADSHEET_SHARED_CSS } from "./shared.css";
import { BROADSHEET_INDEX_CSS } from "./index.css";
import { renderMasthead, renderSubnav, renderSectionBar, renderFooter, type SubnavKey } from "./chrome";
import { renderLead } from "./lead";
import { renderIndexRow } from "./index-row";

export interface IndexPageOptions {
    lead: Episode | null;            // full Episode hydration required for deck + pullQuote
    rows: (EpisodeIndexEntry & { deck?: string })[];
    totalInArchive: number;
    sectionHeading: string;          // "The Index" (home) or "Podcast — Acquired" etc.
    sectionCount: string;            // e.g. "Nine Entries · Most Recent First"
    activeNav: SubnavKey;
    pageTitle: string;               // <title>
    now?: Date;                      // override for tests
}

export function renderIndexPage(opts: IndexPageOptions): string {
    const now = opts.now ?? new Date();
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeTitle(opts.pageTitle)}</title>
${BROADSHEET_FONTS_LINK}
<style>${BROADSHEET_TOKENS_CSS}${BROADSHEET_SHARED_CSS}${BROADSHEET_INDEX_CSS}</style>
</head>
<body>
<div class="bs-page">
${renderMasthead({ now, episodeCount: opts.totalInArchive })}
${renderSubnav(opts.activeNav)}
${opts.lead ? renderLead(opts.lead) : ""}
${renderSectionBar(opts.sectionHeading, opts.sectionCount)}
<div class="bs-index">
${opts.rows.map((ep, i) => renderIndexRow(ep, opts.lead ? i + 2 : i + 1)).join("\n")}
</div>
${renderFooter()}
</div>
</body>
</html>`;
}

function escapeTitle(s: string): string {
    return s.replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
```

- [ ] **Step 2: Locate the current `GET /` handler in `public.ts`**

Run: `grep -n "router.get(\"/\"\\|app.get(\"/\"\\|\\.get('/'," src/routes/public.ts`
Identify the handler that renders the current home page.

- [ ] **Step 3: Replace the home handler**

In `src/routes/public.ts`, replace the current `/` handler body with:

```ts
import { renderIndexPage } from "../lib/broadsheet/index-page";
import { selectLeadEpisode } from "../lib/broadsheet/lead-picker";

// inside the handler:
const index = await c.env.KV.get<EpisodeIndexEntry[]>("episodes:index", "json") ?? [];
const sorted = [...index].sort((a, b) => {
    if (a.episodeDate !== b.episodeDate) return b.episodeDate.localeCompare(a.episodeDate);
    return b.createdAt.localeCompare(a.createdAt);
});
const lead = selectLeadEpisode(sorted);
const leadFull = lead ? await c.env.KV.get<Episode>(`episode:${lead.id}`, "json") : null;
const rows = lead ? sorted.filter(e => e.id !== lead.id) : sorted;

// Hydrate deck onto each index row. Use Promise.all on a bounded slice — cap at 50 to avoid KV flood.
const MAX = 50;
const rowsSliced = rows.slice(0, MAX);
const hydrated = await Promise.all(rowsSliced.map(async r => {
    const ep = await c.env.KV.get<Episode>(`episode:${r.id}`, "json");
    return { ...r, deck: ep?.deck };
}));

const html = renderIndexPage({
    lead: leadFull,
    rows: hydrated,
    totalInArchive: index.length,
    sectionHeading: "The Index",
    sectionCount: `${hydrated.length} ${hydrated.length === 1 ? "Entry" : "Entries"} · Most Recent First`,
    activeNav: "index",
    pageTitle: "TL;DL — Too Long, Didn't Listen",
});
return c.html(html);
```

Ensure imports at the top of the file include `Episode` and `EpisodeIndexEntry` from `../types`.

- [ ] **Step 4: Typecheck and tests**

Run: `npm run typecheck && npm test`
Expected: typecheck clean; test count ≥ previous (no regressions).

- [ ] **Step 5: Smoke-test locally**

Run: `npm run dev`
Open: `http://localhost:8787/` in a browser.
Expected: masthead, subnav, Lead (if any episode exists), index rows, footer. If the store is empty in local dev, at minimum the chrome renders without throwing.
Stop wrangler dev before proceeding.

- [ ] **Step 6: Commit**

```bash
git add src/lib/broadsheet/index-page.ts src/routes/public.ts
git commit -m "feat(broadsheet): wire up / index route"
```

---

## Task 10: Detail page CSS

**Files:**
- Create: `src/lib/broadsheet/detail.css.ts`

- [ ] **Step 1: Write detail CSS**

Create `src/lib/broadsheet/detail.css.ts` — copy detail styles from `06-work/uploads/detail.jsx` (`.bsd-*` classes only; ignore the `.std-*` block):

```ts
export const BROADSHEET_DETAIL_CSS = `
.bsd-root { padding: 48px 72px; max-width: 1280px; margin: 0 auto; }
.bsd-topbar {
  display: flex; justify-content: space-between; align-items: baseline;
  border-bottom: 2px solid var(--bs-ink);
  padding-bottom: 12px; margin-bottom: 40px;
  font-family: 'JetBrains Mono', monospace;
  font-size: 11px; letter-spacing: 0.14em; text-transform: uppercase;
  color: var(--bs-ink-faint);
}
.bsd-topbar .back { color: var(--bs-red); }
.bsd-dateline {
  font-family: 'JetBrains Mono', monospace;
  font-size: 11px; letter-spacing: 0.14em; text-transform: uppercase;
  color: var(--bs-red); margin-bottom: 14px;
}
.bsd-pod {
  font-family: 'JetBrains Mono', monospace;
  font-size: 11.5px; letter-spacing: 0.14em; text-transform: uppercase;
  color: var(--bs-ink-dim); margin-bottom: 16px;
}
.bsd-title {
  font-family: 'Fraunces', Georgia, serif;
  font-weight: 500; font-size: 68px; letter-spacing: -0.03em; line-height: 1;
  color: var(--bs-ink); text-wrap: balance; margin: 0 0 22px;
}
.bsd-deck {
  font-family: 'Fraunces', Georgia, serif;
  font-size: 22px; line-height: 1.4; color: var(--bs-ink-dim);
  max-width: 60ch; margin-bottom: 28px; text-wrap: pretty;
}
.bsd-meta {
  display: flex; gap: 18px; flex-wrap: wrap; align-items: center;
  font-family: 'JetBrains Mono', monospace;
  font-size: 11px; letter-spacing: 0.1em; text-transform: uppercase;
  color: var(--bs-ink-faint);
  padding-bottom: 22px; border-bottom: 1px solid var(--bs-rule);
  margin-bottom: 44px;
}
.bsd-meta .sep { color: var(--bs-rule-strong); }
.bsd-meta .chip { color: var(--bs-red); border: 1px solid var(--bs-red); padding: 3px 9px; letter-spacing: 0.14em; }

.bsd-grid { display: grid; grid-template-columns: 200px 1fr; gap: 56px; }
.bsd-side {
  font-family: 'JetBrains Mono', monospace;
  font-size: 11px; letter-spacing: 0.1em; text-transform: uppercase;
  color: var(--bs-ink-faint);
  position: sticky; top: 20px; align-self: start;
}
.bsd-side h4 { color: var(--bs-ink-dim); margin: 0 0 12px; font-weight: 500; }
.bsd-side .tmpl {
  display: block; padding: 10px 0; border-top: 1px solid var(--bs-rule);
  color: var(--bs-ink-dim);
}
.bsd-side .tmpl.active { color: var(--bs-red); }
.bsd-side .tmpl:last-child { border-bottom: 1px solid var(--bs-rule); }

.bsd-body h3 {
  font-family: 'Fraunces', Georgia, serif;
  font-style: italic; font-weight: 500;
  font-size: 28px; letter-spacing: -0.015em;
  color: var(--bs-ink); margin: 0 0 18px;
}
.bsd-section-rule { height: 1px; background: var(--bs-rule-strong); margin: 0 0 28px; }
.bsd-body p {
  font-family: 'Fraunces', Georgia, serif;
  font-weight: 400; font-size: 19px; line-height: 1.55;
  color: var(--bs-ink); margin: 0 0 22px;
  max-width: 62ch; text-wrap: pretty;
}
.bsd-body p.lead::first-letter {
  font-family: 'Fraunces', serif;
  float: left;
  font-size: 88px; line-height: 0.82; font-weight: 600;
  padding: 4px 12px 0 0; color: var(--bs-red);
}
.bsd-body ol.takeaways {
  list-style: none; padding: 0; margin: 0 0 40px; max-width: 62ch;
  counter-reset: take;
}
.bsd-body ol.takeaways li {
  counter-increment: take;
  padding: 22px 0 22px 64px;
  border-top: 1px solid var(--bs-rule);
  position: relative;
  font-family: 'Fraunces', Georgia, serif;
  font-size: 19px; line-height: 1.5; color: var(--bs-ink);
}
.bsd-body ol.takeaways li:last-child { border-bottom: 1px solid var(--bs-rule); }
.bsd-body ol.takeaways li::before {
  content: counter(take, decimal-leading-zero);
  position: absolute; left: 0; top: 24px;
  font-family: 'JetBrains Mono', monospace;
  font-size: 12px; letter-spacing: 0.1em; color: var(--bs-red);
}
.bsd-body ol.takeaways li b {
  display: block;
  font-family: 'Space Grotesk', sans-serif;
  font-weight: 600; font-size: 16px; letter-spacing: -0.01em;
  color: var(--bs-ink); text-transform: none; margin-bottom: 4px;
}
.bsd-pullquote {
  border-top: 2px solid var(--bs-red);
  border-bottom: 2px solid var(--bs-red);
  margin: 40px 0; padding: 32px 0; max-width: 62ch;
}
.bsd-pullquote-q {
  font-family: 'Fraunces', Georgia, serif;
  font-style: italic; font-weight: 400;
  font-size: 32px; line-height: 1.25; color: var(--bs-ink); text-wrap: pretty;
}
.bsd-pullquote cite {
  display: block; margin-top: 16px;
  font-family: 'JetBrains Mono', monospace;
  font-style: normal; font-size: 11px;
  letter-spacing: 0.14em; text-transform: uppercase; color: var(--bs-red);
}
.bsd-transcript { margin-top: 48px; padding-top: 22px; border-top: 2px solid var(--bs-ink); }
.bsd-transcript-head {
  display: flex; justify-content: space-between;
  font-family: 'JetBrains Mono', monospace;
  font-size: 11px; letter-spacing: 0.14em; text-transform: uppercase;
  color: var(--bs-ink-faint); margin-bottom: 16px;
}
.bsd-transcript p {
  font-family: 'JetBrains Mono', monospace;
  font-size: 12.5px; line-height: 1.7; color: var(--bs-ink-dim);
  max-width: 74ch; margin: 0 0 14px;
}
.bsd-transcript .ts { color: var(--bs-red); margin-right: 10px; display: inline-block; }
.bsd-transcript-missing {
  font-family: 'Fraunces', Georgia, serif;
  font-style: italic; font-size: 16px; color: var(--bs-ink-faint); margin: 16px 0;
}

@media (max-width: 1023px) {
  .bsd-root { padding: 48px 40px; }
}
@media (max-width: 767px) {
  .bsd-root { padding: 32px 20px; }
  .bsd-title { font-size: 44px; }
  .bsd-grid { grid-template-columns: 1fr; gap: 32px; }
  .bsd-side { position: static; }
}
`;
```

- [ ] **Step 2: Commit**

```bash
git add src/lib/broadsheet/detail.css.ts
git commit -m "feat(broadsheet): detail page css"
```

---

## Task 11: Detail page renderer (TDD for transcript fallback + template switcher)

**Files:**
- Create: `src/lib/broadsheet/detail-page.ts`
- Test: `tests/lib/broadsheet/detail-page.test.ts`

Inputs: `Episode`, `summaryMarkdown: string`, `templateId: "key-takeaways" | "narrative-summary" | "eli5"`, `availableTemplates: string[]`, `transcriptText: string | null`.

- [ ] **Step 1: Write failing tests**

Create `tests/lib/broadsheet/detail-page.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { renderDetailPage } from "../../../src/lib/broadsheet/detail-page";
import type { Episode } from "../../../src/types";

function ep(overrides: Partial<Episode> = {}): Episode {
    return {
        id: "ep-1",
        appleUrl: "https://example.com",
        podcastName: "Acquired",
        episodeTitle: "Nvidia",
        episodeDuration: 15120,
        episodeDate: "2026-04-18",
        audioUrl: "https://example.com/a.mp3",
        transcriptSource: "rss",
        createdAt: "2026-04-18T00:00:00Z",
        expiresAt: "2027-04-18T00:00:00Z",
        podcastAuthor: "Ben Gilbert & David Rosenthal",
        tags: ["technology"],
        deck: "A deck.",
        pullQuote: "A quote.",
        ...overrides,
    } as Episode;
}

describe("renderDetailPage", () => {
    it("renders title, deck, and meta", () => {
        const html = renderDetailPage({
            episode: ep(),
            summaryHtml: "<p>Body</p>",
            activeTemplate: "key-takeaways",
            availableTemplates: ["key-takeaways", "narrative-summary"],
            transcriptText: null,
        });
        expect(html).toContain("Nvidia");
        expect(html).toContain("A deck.");
        expect(html).toContain("ACQUIRED");
    });

    it("shows only the templates that are available", () => {
        const html = renderDetailPage({
            episode: ep(),
            summaryHtml: "<p>Body</p>",
            activeTemplate: "key-takeaways",
            availableTemplates: ["key-takeaways", "eli5"],
            transcriptText: null,
        });
        expect(html).toContain("Key Takeaways");
        expect(html).toContain("ELI5");
        expect(html).not.toContain("Narrative");
    });

    it("marks the active template with the active class", () => {
        const html = renderDetailPage({
            episode: ep(),
            summaryHtml: "<p>Body</p>",
            activeTemplate: "eli5",
            availableTemplates: ["key-takeaways", "eli5"],
            transcriptText: null,
        });
        expect(html).toMatch(/class="tmpl active"[^>]*>[^<]*ELI5/);
    });

    it("template links carry ?template= query param", () => {
        const html = renderDetailPage({
            episode: ep({ id: "abc" }),
            summaryHtml: "<p>Body</p>",
            activeTemplate: "key-takeaways",
            availableTemplates: ["key-takeaways", "narrative-summary"],
            transcriptText: null,
        });
        expect(html).toContain('href="/episode/abc?template=narrative-summary"');
    });

    it("renders transcript when provided", () => {
        const html = renderDetailPage({
            episode: ep(),
            summaryHtml: "<p>Body</p>",
            activeTemplate: "key-takeaways",
            availableTemplates: ["key-takeaways"],
            transcriptText: "Host: Welcome to the show.",
        });
        expect(html).toContain("Full Transcript");
        expect(html).toContain("Host: Welcome to the show.");
        expect(html).not.toContain("transcript not available");
    });

    it("renders the fallback note when transcript is null", () => {
        const html = renderDetailPage({
            episode: ep(),
            summaryHtml: "<p>Body</p>",
            activeTemplate: "key-takeaways",
            availableTemplates: ["key-takeaways"],
            transcriptText: null,
        });
        expect(html).toContain("Full Transcript");
        expect(html).toContain("transcript not available for this episode");
        expect(html).toContain("bsd-transcript-missing");
    });

    it("renders the pull-quote block when episode has one", () => {
        const html = renderDetailPage({
            episode: ep({ pullQuote: "Memorable line." }),
            summaryHtml: "<p>Body</p>",
            activeTemplate: "key-takeaways",
            availableTemplates: ["key-takeaways"],
            transcriptText: null,
        });
        expect(html).toContain("bsd-pullquote");
        expect(html).toContain("Memorable line.");
    });

    it("omits the pull-quote block for ELI5 even when one exists", () => {
        const html = renderDetailPage({
            episode: ep({ pullQuote: "Memorable line." }),
            summaryHtml: "<p>Body</p>",
            activeTemplate: "eli5",
            availableTemplates: ["eli5"],
            transcriptText: null,
        });
        expect(html).not.toContain("bsd-pullquote");
    });
});
```

- [ ] **Step 2: Verify tests fail**

Run: `npx vitest run tests/lib/broadsheet/detail-page.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement renderDetailPage**

Create `src/lib/broadsheet/detail-page.ts`:

```ts
import type { Episode } from "../../types";
import { BROADSHEET_FONTS_LINK, BROADSHEET_TOKENS_CSS } from "./tokens.css";
import { BROADSHEET_SHARED_CSS } from "./shared.css";
import { BROADSHEET_DETAIL_CSS } from "./detail.css";

export type TemplateId = "key-takeaways" | "narrative-summary" | "eli5";

const TEMPLATE_LABELS: Record<TemplateId, string> = {
    "key-takeaways": "Key Takeaways",
    "narrative-summary": "Narrative",
    "eli5": "ELI5",
};

export interface DetailPageOptions {
    episode: Episode;
    summaryHtml: string;             // already-rendered markdown
    activeTemplate: TemplateId;
    availableTemplates: TemplateId[];
    transcriptText: string | null;   // null → render fallback note
    now?: Date;
}

function escape(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function shortDate(iso: string): string {
    return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function longDate(iso: string): string {
    return new Date(iso).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
}

function formatDuration(seconds: number): string {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    return h > 0 ? `${h}h ${m.toString().padStart(2, "0")}m` : `${m}m`;
}

function formatTranscriptParagraphs(text: string): string {
    // Split into lines on double newline or single newline, trim, escape, wrap in <p>
    const lines = text.split(/\n+/).map(l => l.trim()).filter(Boolean);
    return lines.map(l => `<p>${escape(l)}</p>`).join("\n");
}

export function renderDetailPage(opts: DetailPageOptions): string {
    const ep = opts.episode;
    const tag = (ep.tags && ep.tags[0]) || "";
    const showPullQuote = opts.activeTemplate !== "eli5" && Boolean(ep.pullQuote);
    const kicker = `${escape(ep.podcastName).toUpperCase()}${
        ep.podcastAuthor ? ` · ${escape(ep.podcastAuthor).toUpperCase()}` : ""
    }`;

    const templates = opts.availableTemplates.map(t => {
        const active = t === opts.activeTemplate ? " active" : "";
        const href = `/episode/${encodeURIComponent(ep.id)}?template=${t}`;
        return `<a class="tmpl${active}" href="${href}">${TEMPLATE_LABELS[t]}</a>`;
    }).join("\n");

    const transcriptBody = opts.transcriptText
        ? `<div class="bsd-transcript-head">
             <span>Source: ${escape(ep.transcriptSource)}</span>
             <span>${formatDuration(ep.episodeDuration)} runtime</span>
           </div>
           ${formatTranscriptParagraphs(opts.transcriptText)}`
        : `<p class="bsd-transcript-missing">— transcript not available for this episode —</p>`;

    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(ep.episodeTitle)} — TL;DL</title>
${BROADSHEET_FONTS_LINK}
<style>${BROADSHEET_TOKENS_CSS}${BROADSHEET_SHARED_CSS}${BROADSHEET_DETAIL_CSS}</style>
</head>
<body>
<div class="bsd-root">
  <div class="bsd-topbar">
    <a class="back" href="/">← Return to Index</a>
    <span>Archived ${longDate(ep.episodeDate)}</span>
  </div>
  <div class="bsd-dateline">The Lead — ${shortDate(ep.episodeDate)}</div>
  <div class="bsd-pod">${kicker}</div>
  <h1 class="bsd-title">${escape(ep.episodeTitle)}</h1>
  ${ep.deck ? `<p class="bsd-deck">${escape(ep.deck)}</p>` : ""}
  <div class="bsd-meta">
    <span>${formatDuration(ep.episodeDuration)}</span>
    <span class="sep">/</span>
    <span>${longDate(ep.episodeDate)}</span>
    ${tag ? `<span class="sep">/</span><span class="chip">${escape(tag)}</span>` : ""}
    <span class="sep">/</span>
    <span>Transcript sourced from ${escape(ep.transcriptSource)}</span>
  </div>

  <div class="bsd-grid">
    <aside class="bsd-side">
      <h4>Summary</h4>
      ${templates}
    </aside>
    <article class="bsd-body">
      ${opts.summaryHtml}
      ${showPullQuote ? `<div class="bsd-pullquote">
        <span class="bsd-pullquote-q">${escape(ep.pullQuote!)}</span>
        <cite>— From the episode</cite>
      </div>` : ""}
      <h3>Full Transcript</h3>
      <div class="bsd-section-rule"></div>
      <div class="bsd-transcript">${transcriptBody}</div>
    </article>
  </div>
</div>
</body>
</html>`;
}
```

- [ ] **Step 4: Verify tests pass**

Run: `npx vitest run tests/lib/broadsheet/detail-page.test.ts`
Expected: all 8 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/lib/broadsheet/detail-page.ts tests/lib/broadsheet/detail-page.test.ts
git commit -m "feat(broadsheet): detail page renderer with template + transcript fallback"
```

---

## Task 12: Wire `/episode/:id` route

**Files:**
- Modify: `src/routes/public.ts`

- [ ] **Step 1: Locate the current episode handler**

Run: `grep -n "/episode/:id\\|/episode/\\${" src/routes/public.ts`

- [ ] **Step 2: Replace the handler**

Replace the handler body with the following. Keep the existing route definition — just swap the rendering. Uses `marked` (already a dependency) to render the summary markdown.

```ts
import { renderDetailPage, type TemplateId } from "../lib/broadsheet/detail-page";
import { marked } from "marked";

// inside the handler (c: Context):
const id = c.req.param("id");
const requested = (c.req.query("template") ?? "") as TemplateId;
const validTemplates: TemplateId[] = ["key-takeaways", "narrative-summary", "eli5"];

const episode = await c.env.KV.get<Episode>(`episode:${id}`, "json");
if (!episode) return c.notFound();

// Determine which templates have been generated for this episode
const available: TemplateId[] = [];
for (const t of validTemplates) {
    const s = await c.env.KV.get(`summary:${id}:${t}`);
    if (s) available.push(t);
}
if (available.length === 0) return c.notFound();

const activeTemplate: TemplateId = validTemplates.includes(requested) && available.includes(requested)
    ? requested
    : available[0];

const summaryMarkdown = await c.env.KV.get(`summary:${id}:${activeTemplate}`) ?? "";
const summaryHtml = marked.parse(summaryMarkdown) as string;

// Transcript lives in R2 (or KV — use whichever tldl uses today; fall back to null)
let transcriptText: string | null = null;
try {
    const obj = await c.env.R2_TRANSCRIPTS?.get(`transcript:${id}`);
    transcriptText = obj ? await obj.text() : null;
} catch {
    transcriptText = null;
}
if (!transcriptText) {
    // fallback: check KV at transcript:{id}
    const kvTx = await c.env.KV.get(`transcript:${id}`, "json") as { text?: string } | null;
    transcriptText = kvTx?.text ?? null;
}

const html = renderDetailPage({
    episode,
    summaryHtml,
    activeTemplate,
    availableTemplates: available,
    transcriptText,
});
return c.html(html);
```

Confirm the `R2_TRANSCRIPTS` binding name matches `wrangler.toml` — if the binding differs, use the actual name. If transcripts are stored only in KV, drop the R2 block.

- [ ] **Step 3: Typecheck + tests**

Run: `npm run typecheck && npm test`
Expected: clean.

- [ ] **Step 4: Smoke-test**

Run: `npm run dev`
Open: `http://localhost:8787/episode/<some-id>` for an existing episode.
Also verify `?template=eli5` and `?template=narrative-summary` when available.
Expected: the page renders with sidebar showing only available templates; active template changes via query param.
Stop dev.

- [ ] **Step 5: Commit**

```bash
git add src/routes/public.ts
git commit -m "feat(broadsheet): wire up /episode/:id route"
```

---

## Task 13: `/podcast/:id` route (Index shell, no Lead)

**Files:**
- Modify: `src/routes/public.ts`

- [ ] **Step 1: Locate the current per-podcast handler**

Run: `grep -n "/podcast/:id\\|podcastId\\|'podcast'" src/routes/public.ts`

- [ ] **Step 2: Replace handler body**

```ts
// inside /podcast/:id handler:
const id = c.req.param("id");
const index = await c.env.KV.get<EpisodeIndexEntry[]>("episodes:index", "json") ?? [];
const rowsRaw = index
    .filter(e => e.id.startsWith(id) /* or however podcast membership is tracked — see below */)
    .sort((a, b) => b.episodeDate.localeCompare(a.episodeDate));
// If the index entry has a podcastName but not a podcastId, match on podcastName instead.
// Confirm the join key before committing.

const hydrated = await Promise.all(rowsRaw.slice(0, 100).map(async r => {
    const ep = await c.env.KV.get<Episode>(`episode:${r.id}`, "json");
    return { ...r, deck: ep?.deck };
}));

const podcastName = rowsRaw[0]?.podcastName ?? "Unknown Podcast";

const html = renderIndexPage({
    lead: null,
    rows: hydrated,
    totalInArchive: index.length,
    sectionHeading: `Podcast — ${podcastName}`,
    sectionCount: `${hydrated.length} ${hydrated.length === 1 ? "Entry" : "Entries"}`,
    activeNav: "index",
    pageTitle: `${podcastName} — TL;DL`,
});
return c.html(html);
```

**Before writing, confirm the podcast-membership key.** Run: `grep -n "podcastId\\|/podcast/" src/routes/public.ts src/lib/` and inspect how episodes are currently filtered for a podcast. Use the same mechanism — don't invent a new join.

- [ ] **Step 3: Typecheck + smoke**

Run: `npm run typecheck && npm run dev`, open a known `/podcast/:id`.
Expected: renders with Broadsheet shell, no Lead, filtered rows.
Stop dev.

- [ ] **Step 4: Commit**

```bash
git add src/routes/public.ts
git commit -m "feat(broadsheet): wire up /podcast/:id route"
```

---

## Task 14: `/tag/:tag` route (Index shell, no Lead)

**Files:**
- Modify: `src/routes/public.ts`

- [ ] **Step 1: Locate the current tag handler**

Run: `grep -n "/tag/:tag\\|tags?.includes\\|'tag'" src/routes/public.ts`

- [ ] **Step 2: Replace handler body**

```ts
// inside /tag/:tag handler:
const tag = c.req.param("tag").toLowerCase();
const index = await c.env.KV.get<EpisodeIndexEntry[]>("episodes:index", "json") ?? [];
const rowsRaw = index
    .filter(e => (e.tags ?? []).map(t => t.toLowerCase()).includes(tag))
    .sort((a, b) => b.episodeDate.localeCompare(a.episodeDate));

const hydrated = await Promise.all(rowsRaw.slice(0, 100).map(async r => {
    const ep = await c.env.KV.get<Episode>(`episode:${r.id}`, "json");
    return { ...r, deck: ep?.deck };
}));

const html = renderIndexPage({
    lead: null,
    rows: hydrated,
    totalInArchive: index.length,
    sectionHeading: `Tag — ${tag}`,
    sectionCount: `${hydrated.length} ${hydrated.length === 1 ? "Entry" : "Entries"}`,
    activeNav: "tags",
    pageTitle: `#${tag} — TL;DL`,
});
return c.html(html);
```

- [ ] **Step 3: Typecheck + smoke**

Run: `npm run dev` and load `/tag/technology` (or any known tag).
Expected: Broadsheet shell, filtered rows, `By Tag` active in subnav.
Stop dev.

- [ ] **Step 4: Commit**

```bash
git add src/routes/public.ts
git commit -m "feat(broadsheet): wire up /tag/:tag route"
```

---

## Task 15: Delete replaced styles from `styles.ts`

Grep each class reference before deletion. Do not touch classes used by `/subscribe`, `/preferences/manage`, admin, or error pages.

**Files:**
- Modify: `src/lib/styles.ts`

- [ ] **Step 1: Identify classes that are now unused**

Run each of these greps and collect class names that used to belong to the old home/episode/podcast/tag pages but are no longer referenced outside `styles.ts` itself and `public.ts` retained-handler code:

```bash
grep -n "^\." src/lib/styles.ts | head -60
# For each suspect class, check references:
grep -rn 'suspect-class' src/ | grep -v 'src/lib/styles.ts'
```

A class is safe to delete only if the only remaining reference is inside `styles.ts`.

- [ ] **Step 2: Delete**

Remove the identified unused blocks. Do NOT restructure or reformat the rest of the file.

- [ ] **Step 3: Typecheck + tests**

Run: `npm run typecheck && npm test`
Expected: clean.

- [ ] **Step 4: Full smoke**

Run: `npm run dev`
Load in order: `/`, `/episode/<id>`, `/podcast/<id>`, `/tag/<tag>`, `/subscribe`, `/preferences/manage`.
Expected: first four render Broadsheet; last two render the old design untouched.
Stop dev.

- [ ] **Step 5: Commit**

```bash
git add src/lib/styles.ts
git commit -m "chore(styles): drop classes replaced by broadsheet"
```

---

## Task 16: Final QA + push

- [ ] **Step 1: Run full test suite**

Run: `npm test`
Expected: all pass. Note any pre-existing failures as prior-known.

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: exit 0.

- [ ] **Step 3: Manual QA checklist**

Load `http://localhost:8787` against local dev and verify:
- [ ] Masthead `Vol. III — No. <week>`, today's date, episode count.
- [ ] Subnav: `Today's Index` active (red). Hover on others does nothing weird.
- [ ] Lead: renders with two columns if newest episode has a `pullQuote`, one column otherwise. Title links to `/episode/:id`.
- [ ] Index rows: numbered, hover turns number red + nudges arrow.
- [ ] Episode detail: sidebar shows only available templates. Clicking a template changes the URL query param and body.
- [ ] Transcript: renders when available; renders italic fallback note when missing.
- [ ] `/podcast/:id` and `/tag/:tag`: no Lead block, filtered rows, correct section heading.
- [ ] No horizontal scroll at 1280 / 1024 / 768 / 375.
- [ ] No console errors on any page.
- [ ] `/subscribe` and `/preferences/manage` unchanged.

- [ ] **Step 4: Push + open PR (or merge direct)**

STOP before pushing or merging. Report ready-for-review to the user; let the user decide whether to merge directly or open a PR. Per user's standing rule: never push + create MR without explicit approval.

---

## Out of scope for this plan

* Self-hosting the Google Fonts (follow-up after merge).
* Redesigning `/subscribe` and `/preferences/manage` (v2).
* Backfilling `deck` + `pullQuote` on pre-redesign episodes.
* Editorial-override layer for Lead picking.
* Italicized emphasis words in titles.
* Admin / error / 404 page redesign.
