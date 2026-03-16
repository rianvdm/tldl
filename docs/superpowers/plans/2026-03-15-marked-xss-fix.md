# marked XSS Sanitization Fix Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix two XSS vectors in `renderMarkdown()` — raw HTML passthrough and `javascript:` links — by using a custom `marked` renderer with no new dependencies.

**Architecture:** Override `renderer.html` and `renderer.link` on a `marked` `Renderer` instance, apply it once at module scope via `marked.use()`, and pass parse options per-call instead of via `setOptions`. Add a dedicated test file covering all XSS vectors and normal markdown behavior.

**Tech Stack:** `marked` v17 (already installed), Vitest + `@cloudflare/vitest-pool-workers`

---

## Chunk 1: Tests + Implementation

### Task 1: Write failing tests for `renderMarkdown` XSS behavior

**Context:** `renderMarkdown` is a module-private function in `src/routes/public.ts`. It is not exported, so we cannot import it directly in tests. The tests should exercise it via the HTTP route — `GET /episode/:id` renders the summary through `renderMarkdown`. Use the existing test harness pattern from `test/api.test.ts` (SELF_WORKER binding + `env` fixture) to make requests and assert on response HTML.

Look at `test/api.test.ts` to understand how the test harness is set up — it uses `SELF` binding and a `env` fixture from `cloudflare:test`. The episode detail route is `GET /episode/:id` in `src/routes/public.ts`.

To inject a summary containing XSS payloads, write it directly to KV in test setup using the `putSummary` helper from `src/lib/kv.ts` (or write to `TLDL_DATA` KV directly — check how `test/api.test.ts` seeds episode/summary data).

**Files:**
- Create: `test/render-markdown.test.ts`

- [ ] **Step 1: Write the test file with failing tests**

```typescript
// test/render-markdown.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import worker from "../src/index";
import { saveEpisode, saveSummary } from "../src/lib/kv";

// Helper to make a request through the worker
async function getEpisodePage(episodeId: string): Promise<string> {
    const req = new Request(`http://localhost/episode/${episodeId}`);
    const res = await worker.fetch(req, env);
    return res.text();
}

// Seed a minimal episode + summary with the given summary text
async function seedEpisodeWithSummary(episodeId: string, summaryText: string) {
    await saveEpisode(env.TLDL_DATA, {
        id: episodeId,
        podcastName: "Test Podcast",
        episodeTitle: "Test Episode",
        episodeDate: "2024-01-01",
        duration: 600,
        audioUrl: "https://example.com/audio.mp3",
        applePodcastsUrl: "https://podcasts.apple.com/test",
        status: "complete",
        templateId: "key-takeaways",
        createdAt: new Date().toISOString(),
        tags: [],
    });
    await saveSummary(env.TLDL_DATA, episodeId, "key-takeaways", {
        templateId: "key-takeaways",
        text: summaryText,
        generatedAt: new Date().toISOString(),
    });
}

describe("renderMarkdown XSS protection", () => {
    const episodeId = "test_xss_episode";

    it("strips raw <script> tags", async () => {
        await seedEpisodeWithSummary(episodeId + "_1", "<script>alert(1)</script>");
        const html = await getEpisodePage(episodeId + "_1");
        expect(html).not.toContain("<script>alert(1)</script>");
    });

    it("strips raw HTML with event handlers", async () => {
        await seedEpisodeWithSummary(episodeId + "_2", '<img src="x" onerror="alert(1)">');
        const html = await getEpisodePage(episodeId + "_2");
        expect(html).not.toContain("onerror");
    });

    it("strips javascript: link href and keeps link text", async () => {
        await seedEpisodeWithSummary(episodeId + "_3", "[click me](javascript:alert(1))");
        const html = await getEpisodePage(episodeId + "_3");
        expect(html).not.toContain("javascript:alert(1)");
        expect(html).toContain("click me");
    });

    it("strips JAVASCRIPT: (uppercase) link href", async () => {
        await seedEpisodeWithSummary(episodeId + "_4", "[click me](JAVASCRIPT:alert(1))");
        const html = await getEpisodePage(episodeId + "_4");
        expect(html).not.toContain("JAVASCRIPT:");
        expect(html).toContain("click me");
    });

    it("does NOT strip normal https:// links", async () => {
        await seedEpisodeWithSummary(episodeId + "_5", "[Google](https://google.com)");
        const html = await getEpisodePage(episodeId + "_5");
        expect(html).toContain('href="https://google.com"');
        expect(html).toContain("Google");
    });

    it("renders bold markdown correctly", async () => {
        await seedEpisodeWithSummary(episodeId + "_6", "**important point**");
        const html = await getEpisodePage(episodeId + "_6");
        expect(html).toContain("<strong>important point</strong>");
    });

    it("renders bullet lists correctly", async () => {
        await seedEpisodeWithSummary(episodeId + "_7", "- item one\n- item two");
        const html = await getEpisodePage(episodeId + "_7");
        expect(html).toContain("<li>item one</li>");
        expect(html).toContain("<li>item two</li>");
    });
});
```

> **Note:** You may need to adjust `saveEpisode` / `saveSummary` import paths and call signatures. Check `src/lib/kv.ts` to confirm the exact function names and argument shapes used in existing tests like `test/api.test.ts`.

- [ ] **Step 2: Run the tests to confirm they fail**

```bash
npm test -- test/render-markdown.test.ts
```

Expected: tests for XSS vectors currently **pass** (the XSS is present, meaning the `not.toContain` assertions fail), tests for normal markdown may pass. This confirms the tests are correctly detecting the current broken behavior.

---

### Task 2: Implement the `renderMarkdown` fix

**Context:** `renderMarkdown` is at `src/routes/public.ts:80-90`. The fix requires:
1. Moving `marked.use()` with a custom renderer to **module scope** (after the `import { marked }` line, outside any function)
2. Removing `marked.setOptions()` from inside `renderMarkdown`
3. Passing `{ gfm: true, breaks: false }` as the second argument to `marked.parse()` instead

The `marked` v17 `Renderer` and `marked.use` API:
- `import { marked, Renderer } from "marked"` — `Renderer` is a named export
- `renderer.html = ({ text }) => ""` — the `html` method receives an object with a `text` property
- `renderer.link = ({ href, title, tokens }) => string` — `href` is the URL string, `tokens` is the array of inline tokens for the link text; to get the link text as HTML, use `this.parser.renderInline(tokens)` or reconstruct from `tokens[0].raw`

Check the `marked` v17 type definitions or source to confirm the exact `link` token shape before writing. In v17 the link token type is:
```typescript
{ href: string; title: string | null | undefined; tokens: Token[] }
```
You can get rendered link text with `tokens.map(t => ('raw' in t ? t.raw : '')).join('')` as a safe fallback if `this.parser` is unavailable in the renderer context.

**Files:**
- Modify: `src/routes/public.ts:24-90`

- [ ] **Step 1: Update the import line to include `Renderer`**

At `src/routes/public.ts:24`, change:
```typescript
import { marked } from "marked";
```
to:
```typescript
import { marked, Renderer } from "marked";
```

- [ ] **Step 2: Add the module-scope sanitizing renderer after the import block**

After the import block (after line 28, before line 30 where `publicRoutes` is defined), add:

```typescript
// ============================================================================
// Markdown Renderer (XSS-safe)
// Applied once at module scope — strips raw HTML and javascript: links
// ============================================================================
const sanitizingRenderer = new Renderer();

// Strip raw HTML blocks entirely (e.g. <script>, <img onerror=...>)
sanitizingRenderer.html = () => "";

// Strip javascript: link hrefs, keep link text; pass normal links through
sanitizingRenderer.link = ({ href, title, tokens }) => {
    // Reconstruct link text from tokens
    const text = tokens.map((t) => ("raw" in t ? t.raw : "")).join("");
    if (href && /^javascript:/i.test(href.trim())) {
        return text; // drop the href entirely, keep visible text
    }
    const titleAttr = title ? ` title="${title}"` : "";
    return `<a href="${href}"${titleAttr}>${text}</a>`;
};

marked.use({ renderer: sanitizingRenderer });
```

- [ ] **Step 3: Rewrite `renderMarkdown` to remove `setOptions` and pass options per-call**

Replace the current `renderMarkdown` function (`src/routes/public.ts:80-90`):

```typescript
/**
 * Render markdown to HTML using the marked library.
 * XSS-safe: raw HTML is stripped, javascript: links are sanitized.
 * Uses module-scope sanitizingRenderer (applied via marked.use above).
 */
function renderMarkdown(md: string): string {
    if (!md) return "";
    return marked.parse(md, { gfm: true, breaks: false }) as string;
}
```

- [ ] **Step 4: Run the tests to confirm they pass**

```bash
npm test -- test/render-markdown.test.ts
```

Expected: all 7 tests **pass**.

- [ ] **Step 5: Run the full test suite to confirm no regressions**

```bash
npm test
```

Expected: all 305+ tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/routes/public.ts test/render-markdown.test.ts
git commit -m "fix: sanitize marked output to prevent XSS via raw HTML and javascript: links"
```

---

## Done

The fix is complete when:
- All XSS test cases pass (raw HTML stripped, `javascript:` links stripped)
- Normal markdown (links, bold, lists) still renders correctly
- Full test suite passes with no regressions
