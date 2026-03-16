# Design: marked XSS Sanitization Fix

**Date:** 2026-03-15
**Status:** Approved
**Scope:** `src/routes/public.ts` — `renderMarkdown()` function

---

## Problem

`renderMarkdown()` calls `marked.parse()` with no HTML sanitization. The `marked` library passes raw HTML through by default. Two confirmed XSS vectors:

1. **Raw HTML passthrough** — `<script>alert(1)</script>` renders as-is into the page
2. **`javascript:` links** — `[x](javascript:alert(1))` renders as a clickable `javascript:` href

The CSP at `src/index.ts` uses `'unsafe-inline'` for `script-src`, so inline scripts injected this way are not blocked by the browser.

`renderMarkdown()` is called in two places:
- `src/routes/public.ts:660` — episode detail page
- `src/routes/public.ts:1245` — RSS feed

---

## Chosen Approach

**Custom `marked` renderer** — override two renderer methods to strip the XSS vectors at render time. No new dependencies. Scoped to the one function.

---

## Design

### Changes to `renderMarkdown()` (`src/routes/public.ts:80-90`)

Replace the current implementation with one that:

1. Creates a `Renderer` instance
2. Overrides `renderer.html` to return `""` — stripping all raw HTML blocks
3. Overrides `renderer.link` to check `href` against `/^javascript:/i` — if matched, returns just the link text (no anchor element); otherwise renders a normal `<a>` tag
4. Applies the renderer via `marked.use({ renderer })` **once at module load time** (outside the function body), not inside the function on every call — this also fixes the existing global mutation issue with `marked.setOptions`
5. Removes `marked.setOptions({ gfm, breaks })` from the function body and passes options per-call via `marked.parse(md, { gfm: true, breaks: false })`

### What the renderer overrides do

| Vector | Input | Before | After |
|--------|-------|--------|-------|
| Raw HTML | `<script>alert(1)</script>` | `<script>alert(1)</script>` | *(empty string)* |
| javascript: link | `[x](javascript:alert(1))` | `<a href="javascript:alert(1)">x</a>` | `x` |
| Normal link | `[Google](https://google.com)` | `<a href="https://google.com">Google</a>` | `<a href="https://google.com">Google</a>` |
| Normal markdown | `**bold**` | `<strong>bold</strong>` | `<strong>bold</strong>` |

---

## Testing

Add a new test file `test/render-markdown.test.ts` (or add to `test/api.test.ts`) covering:

- Raw HTML `<script>` tag is stripped
- Raw HTML `<img onerror=...>` is stripped
- `javascript:` link href is stripped, text preserved
- `JAVASCRIPT:` (uppercase) link is also stripped
- Normal `https://` link renders correctly
- Standard markdown (bold, italic, headings, lists) renders correctly

---

## Files Changed

| File | Change |
|------|--------|
| `src/routes/public.ts` | Rewrite `renderMarkdown()`, move `marked.use()` to module scope |
| `test/render-markdown.test.ts` | New test file for `renderMarkdown` XSS cases |

---

## Out of Scope

- Fixing other issues from the code review (KV pagination, job status TTL, etc.)
- Changing the CSP `unsafe-inline` setting
- Replacing `marked` with a different library
