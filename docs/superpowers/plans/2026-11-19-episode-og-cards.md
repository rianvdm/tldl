# Per-episode Share Cards Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every episode page's `og:image` points at a 1200×630 card for that episode, drawn by the Worker on first request and cached in KV.

**Architecture:** A pure model layer turns an `Episode` into the text the card shows and a content hash (`cardVersion`). A render layer turns that model into a satori element tree, then SVG, then PNG with resvg, using vendored static fonts. A new Hono sub-app serves `/og/episode/<id>.png?v=<cardVersion>` with KV caching and a static-image fallback; the detail page emits that URL.

**Tech Stack:** TypeScript, Hono 4, Cloudflare Workers (Paid), KV, `@cf-wasm/satori` + `@cf-wasm/resvg` (wasm), Vitest with `@cloudflare/vitest-pool-workers`.

**Spec:** `docs/superpowers/specs/2026-11-19-episode-og-cards-design.md`

## Global Constraints

- Card size 1200×630 PNG.
- Public URL: `https://tldl-pod.com/og/episode/<episodeId>.png?v=<cardVersion>`; a URL without `.png` is a 404.
- KV key `og:{episodeId}:{cardVersion}`, TTL `TTL.CONTENT` (365 days).
- PNG responses: `Content-Type: image/png`, `Cache-Control: public, max-age=31536000, immutable`. Every redirect from the card route carries `Cache-Control: no-store`.
- Fallback image: `https://file.elezea.com/tldl-og-1200x630.png` (today's `OG_IMAGE` in `src/lib/broadsheet/head.ts`).
- Colours: paper `#10100e`, ink `#f1ece3`, ink-dim `#b8b0a3`, ink-faint `#6f685d`, red `#e63946`, rule `#4a4a40`.
- Fonts: four static TTFs only: Fraunces 600, Fraunces 900 italic, Fraunces 400 italic, JetBrains Mono 500, with their OFL licence files. No runtime font fetching.
- Pin `@cf-wasm/satori` and `@cf-wasm/resvg` to exact versions (no `^`); the upstream breaks without semver.
- Do not change `compatibility_date` unless the libraries fail without it; if so, raise it in its own commit and run the full suite.
- Log events: `og_render_failed`, `og_cache_write_failed`, via the repo's existing structured `console.log(JSON.stringify(...))` / `logError` style.
- Footer domain is `tldl-pod.com`.
- Deploy is manual (`npm run deploy`) and is not part of this plan's tasks; it happens after the final review and Rian's look at real cards.

## Review Focus

1. **A deck that is an empty or whitespace-only string.** Expect the no-deck layout, not an empty gap. Test in Task 1.
2. **A title made only of emoji** (stripped to nothing). Expect the podcast name as the title, never a blank card. Test in Task 1.
3. **An `episodeDate` that doesn't parse.** Expect the kicker to show the podcast name alone, never "INVALID DATE". Test in Task 1.
4. **Crawlers that send `HEAD`.** Expect the same status and headers as `GET` (Hono routes HEAD to GET handlers). Test in Task 3.
5. **An episode ID containing a dot.** Expect the `.png` suffix strip to take only the final `.png`. Test in Task 3.

---

### Task 1: Card model and version hash

**Files:**
- Create: `src/lib/og/card-model.ts`
- Test: `test/og-card-model.test.ts`

**Interfaces:**
- Produces:
  - `export const CARD_TEMPLATE_VERSION = "1";`
  - `export interface CardModel { kicker: string; title: string; deck: string | null; runtime: string | null; }`
  - `export function toCardModel(ep: Episode): CardModel`
  - `export async function cardVersion(ep: Episode): Promise<string>`: 12 lowercase hex chars.
  - `export function episodeCardUrl(episodeId: string, version: string): string`: absolute URL per Global Constraints, with `encodeURIComponent(episodeId)`.

- [ ] **Step 1: Write the failing tests** in `test/og-card-model.test.ts` (reuse the `episode()` fixture shape from `test/detail-page.test.ts`):

```ts
it("builds kicker, title, deck and runtime", () => {
    const m = toCardModel(episode({ podcastName: "Lenny's Podcast", episodeDate: "2026-11-18T10:00:00Z",
        episodeTitle: "Deciding what not to build", deck: "A deck.", episodeDuration: 4320 }));
    expect(m).toEqual({ kicker: "LENNY'S PODCAST — NOV 18, 2026", title: "Deciding what not to build",
        deck: "A deck.", runtime: "1H 12M" });
});
it("drops runtime when duration is 0", () => expect(toCardModel(episode({ episodeDuration: 0 })).runtime).toBeNull());
it("formats runtime like the detail page", () => {
    expect(toCardModel(episode({ episodeDuration: 2700 })).runtime).toBe("45M");
    expect(toCardModel(episode({ episodeDuration: 7500 })).runtime).toBe("2H 05M");
});
it("treats a missing or blank deck as no deck", () => {
    expect(toCardModel(episode({ deck: undefined })).deck).toBeNull();
    expect(toCardModel(episode({ deck: "   " })).deck).toBeNull();
});
it("strips emoji and collapses whitespace", () =>
    expect(toCardModel(episode({ episodeTitle: "AI 🤖  agents 👨‍👩‍👧 now" })).title).toBe("AI agents now"));
it("falls back to the podcast name when the title is only emoji", () =>
    expect(toCardModel(episode({ podcastName: "Pod", episodeTitle: "🎙️🔥" })).title).toBe("Pod"));
it("omits the date from the kicker when episodeDate does not parse", () =>
    expect(toCardModel(episode({ podcastName: "Pod", episodeDate: "not a date" })).kicker).toBe("POD"));
it("cardVersion is 12 hex chars and stable", async () => {
    const a = await cardVersion(episode()); expect(a).toMatch(/^[0-9a-f]{12}$/);
    expect(await cardVersion(episode())).toBe(a);
});
it.each(["episodeTitle", "podcastName", "deck", "episodeDate", "episodeDuration"] as const)(
    "cardVersion changes when %s changes", async (field) => {
        const base = episode({ deck: "d" });
        const changed = { ...base, [field]: field === "episodeDuration" ? 1 : "changed" };
        expect(await cardVersion(changed)).not.toBe(await cardVersion(base));
    });
it("cardVersion ignores fields not drawn on the card", async () =>
    expect(await cardVersion(episode({ tags: ["ai"], pullQuote: "q" }))).toBe(await cardVersion(episode())));
it("builds the card URL", () =>
    expect(episodeCardUrl("a b", "abc123abc123")).toBe("https://tldl-pod.com/og/episode/a%20b.png?v=abc123abc123"));
```

- [ ] **Step 2: Run** `npm test -- test/og-card-model.test.ts`. Expected: FAIL, module not found.

- [ ] **Step 3: Implement `src/lib/og/card-model.ts`.**
  - Emoji strip: remove `/\p{Extended_Pictographic}(?:️|‍\p{Extended_Pictographic})*/gu` and stray `️`/`‍`, then collapse runs of whitespace and trim. Apply to title, deck, and podcast name.
  - Kicker date: `toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }).toUpperCase()`, joined with ` — `; skip it when `Number.isNaN(Date.parse(ep.episodeDate))`.
  - Runtime: same arithmetic and padding as `formatDuration` in `detail-page.ts`, uppercased (`1H 12M`, `2H 05M`, `45M`), so the card matches the page. Return `null` for `<= 0` or non-finite.
  - `cardVersion`: SHA-256 via `crypto.subtle.digest` over `JSON.stringify([CARD_TEMPLATE_VERSION, toCardModel(ep)])`, first 12 hex chars. Hashing the model rather than raw fields means `cardVersion` changes exactly when the drawn text changes.

  (The `it.each` test above must still pass when hashing the model: every listed field changes the model.)

- [ ] **Step 4: Run** `npm test -- test/og-card-model.test.ts`. Expected: PASS. Then `npm run typecheck`. Expected: no errors.

- [ ] **Step 5: Commit** `git add src/lib/og/card-model.ts test/og-card-model.test.ts && git commit -m "Add the share-card model and its content hash"`

---

### Task 2: Draw the card (fonts, element tree, PNG)

This task also proves the wasm libraries load in both `wrangler` and the Vitest pool. If they don't, stop and report rather than working around it in a way the spec doesn't describe.

**Files:**
- Modify: `package.json`, `package-lock.json` (add exact-pinned `@cf-wasm/satori`, `@cf-wasm/resvg`)
- Create: `src/assets/fonts/` with `Fraunces-SemiBold.ttf`, `Fraunces-BlackItalic.ttf`, `Fraunces-Italic.ttf`, `JetBrainsMono-Medium.ttf`, `Fraunces-OFL.txt`, `JetBrainsMono-OFL.txt`, `README.md` (source URLs and the exact command used to fetch them)
- Create: `src/lib/og/fonts.ts`, `src/lib/og/card-tree.ts`, `src/lib/og/render.ts`
- Modify: `wrangler.toml` (a `[[rules]]` entry, only if the Data-module route is used; see Step 3)
- Test: `test/og-render.test.ts`

**Interfaces:**
- Consumes: `CardModel` from Task 1.
- Produces:
  - `export type SatoriNode = { type: string; props: { style?: Record<string, unknown>; children?: SatoriNode | SatoriNode[] | string } }` (in `card-tree.ts`)
  - `export function buildCardTree(model: CardModel): SatoriNode`
  - `export function cardFonts(): { name: string; data: ArrayBuffer; weight: 400 | 600 | 900 | 500; style: "normal" | "italic" }[]`
  - `export async function renderCardPng(model: CardModel): Promise<Uint8Array>`

- [ ] **Step 1: Fetch the fonts.** Static instances, not variable fonts: request each family/weight from the Google Fonts CSS2 API with a non-browser `User-Agent` (it then returns `truetype` URLs), download the TTFs, and take `OFL.txt` from `github.com/google/fonts` (`ofl/fraunces/`, `ofl/jetbrainsmono/`). Record the exact commands in `src/assets/fonts/README.md`. Check each file: `file src/assets/fonts/*.ttf` reports TrueType, and none has an `fvar` table (`python3 -c "from fontTools.ttLib import TTFont"`… if fontTools is absent, the Google CSS2 static request is sufficient evidence; note which).

- [ ] **Step 2: Write the failing tests** in `test/og-render.test.ts`:

```ts
const model = { kicker: "POD — NOV 18, 2026", title: "A title", deck: "A deck.", runtime: "1H 12M" };

it("tree contains the kicker, title, deck, runtime and domain", () => {
    const text = JSON.stringify(buildCardTree(model));
    for (const s of ["POD — NOV 18, 2026", "A title", "A deck.", "1H 12M", "TLDL-POD.COM"]) expect(text).toContain(s);
});
it("tree has no deck node when deck is null", () =>
    expect(JSON.stringify(buildCardTree({ ...model, deck: null }))).not.toContain("A deck."));
it("tree omits runtime when null", () =>
    expect(JSON.stringify(buildCardTree({ ...model, runtime: null }))).not.toMatch(/\d+M/));
it("title font steps down for long titles", () => {
    const size = (t: string) => titleFontSize(t);
    expect(size("x".repeat(120))).toBeLessThan(size("Short title"));
});
it("renders a 1200x630 PNG", async () => {
    const png = await renderCardPng(model);
    expect([...png.slice(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const view = new DataView(png.buffer, png.byteOffset);
    expect(view.getUint32(16)).toBe(1200); // IHDR width
    expect(view.getUint32(20)).toBe(630);  // IHDR height
});
it("renders a long title, long deck and no runtime without throwing", async () => {
    const png = await renderCardPng({ kicker: "A VERY LONG PODCAST NAME THAT GOES ON — JAN 1, 2026",
        title: "word ".repeat(40).trim(), deck: "deck ".repeat(60).trim(), runtime: null });
    expect(png.byteLength).toBeGreaterThan(1000);
});
```

  `titleFontSize(title: string): number` is exported from `card-tree.ts` for this test.

- [ ] **Step 3: Implement.**
  - `fonts.ts`: load the four TTFs as `ArrayBuffer`s. First choice: Data-module imports through `[[rules]] type = "Data" globs = ["**/*.ttf"] fallthrough = true` in `wrangler.toml`. If the Vitest pool can't import them that way, generate base64 TS modules instead (`src/assets/fonts/*.ts`, following the `APPLE_TOUCH_ICON_PNG_BASE64` pattern in `src/lib/assets.ts`) from a script in `scripts/` and decode once at module scope. Either way, decode or load once per isolate, not per request.
  - `card-tree.ts`: the layout from the spec's sketch, in satori's flexbox subset. Padding 56px left/right. Masthead: centred `TL;DL` wordmark (Fraunces 900 italic, ~88px, both `L`s in red), 2px ink rule beneath. Kicker: JetBrains Mono 500, ~20px, red, letter-spacing ~0.12em, followed by a thin `#4a4a40` rule filling the row. Title: Fraunces 600, ink, `lineClamp: 3`. Deck: Fraunces 400 italic, ~30px, ink-dim, `lineClamp: 2`, ellipsis. Footer: 2px ink rule, then JetBrains Mono 500 ~18px ink-faint: `TLDL · PODCAST SUMMARIES` left, `<runtime> · TLDL-POD.COM` right (`TLDL-POD.COM` alone when runtime is null). Without a deck, the title block is vertically centred in the space the deck would have shared.
  - `titleFontSize`: start from these steps and adjust during Task 4's visual check if clipping appears: ≤ 40 chars → 76, ≤ 70 → 64, ≤ 100 → 54, else 46. Text column width is fixed at 1088px; keep it in pixels.
  - `render.ts`: `satori(tree, { width: 1200, height: 630, fonts: cardFonts() })` → `Resvg.async(svg)` → `.render().asPng()`. Import from `@cf-wasm/satori` and `@cf-wasm/resvg` (the `workerd` condition resolves automatically). Free any resvg handles the API exposes.

- [ ] **Step 4: Run** `npm test -- test/og-render.test.ts`. Expected: PASS. Then `npm run typecheck`. Expected: no errors.

- [ ] **Step 5: Measure the bundle.** Run `npx wrangler deploy --dry-run --outdir /tmp/tldl-dry` (any scratch dir) and record `Total Upload … / gzip …` in the commit message. Baseline before this task: `1675.08 KiB / gzip: 333.18 KiB`. Expected: gzip under 10 MiB. Report the number.

- [ ] **Step 6: Commit** fonts, licences, README, `src/lib/og/{fonts,card-tree,render}.ts`, test, `package.json`, `package-lock.json`, and `wrangler.toml` if changed. Check `git diff package-lock.json` for stripped `libc` fields first (a known npm churn on this Mac): revert any unrelated hunks so the lockfile change is only the two new packages and their dependencies.

---

### Task 3: The card route

**Files:**
- Create: `src/routes/og.ts`
- Modify: `src/lib/kv.ts` (add `ogCard: (episodeId: string, version: string) => \`og:${episodeId}:${version}\`` to `KV_KEYS`)
- Modify: `src/lib/broadsheet/head.ts` (export the existing `OG_IMAGE` constant as `DEFAULT_OG_IMAGE`; keep using it as the default)
- Modify: `src/index.ts` (mount before `app.route("/", publicRoutes)`)
- Test: `test/og-route.test.ts`

**Interfaces:**
- Consumes: `toCardModel`, `cardVersion` (Task 1); `renderCardPng` (Task 2); `getEpisode`, `getEpisodeRedirect`, `saveEpisode`, `KV_KEYS`, `TTL` from `src/lib/kv.ts`; `DEFAULT_OG_IMAGE` from `head.ts`.
- Produces: `export function createOgRoutes(deps?: { render?: (m: CardModel) => Promise<Uint8Array> }): Hono<HonoEnv>`; `export default createOgRoutes();`. `index.ts` mounts with `app.route("/", ogRoutes)`.

- [ ] **Step 1: Write the failing tests** in `test/og-route.test.ts`. Use `createOgRoutes({ render: fake }).request(path, init, env)` with `env` from `cloudflare:test`, a `fake` that counts calls and returns `new Uint8Array([0x89, 0x50, 0x4e, 0x47])`, and a `beforeEach` that clears `episode:`, `episode-redirect:` and `og:` keys. Seed with `saveEpisode`. Let `v = await cardVersion(ep)`.

```ts
it("miss: renders, caches in KV, returns the PNG with immutable caching", async () => {
    const res = await app.request(`/og/episode/${ep.id}.png?v=${v}`, {}, env);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(calls).toBe(1);
    expect(await env.TLDL_DATA.get(`og:${ep.id}:${v}`, "arrayBuffer")).not.toBeNull();
});
it("hit: serves cached bytes without rendering", async () => {
    await env.TLDL_DATA.put(`og:${ep.id}:${v}`, new Uint8Array([1, 2, 3]));
    const res = await app.request(`/og/episode/${ep.id}.png?v=${v}`, {}, env);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
    expect(calls).toBe(0);
});
it.each(["", "?v=stale0000000"])("missing or stale v (%s) redirects to the current v", async (q) => {
    const res = await app.request(`/og/episode/${ep.id}.png${q}`, {}, env);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`/og/episode/${encodeURIComponent(ep.id)}.png?v=${v}`);
    expect(res.headers.get("cache-control")).toBe("no-store");
});
it("aliased id 301s to the canonical card URL", async () => {
    await saveEpisodeRedirect(env.TLDL_DATA, "old_id", ep.id);
    const res = await app.request(`/og/episode/old_id.png?v=x`, {}, env);
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe(`/og/episode/${encodeURIComponent(ep.id)}.png`);
});
it("unknown id is a 404", async () => expect((await app.request(`/og/episode/nope.png?v=x`, {}, env)).status).toBe(404));
it("URL without .png is a 404", async () => expect((await app.request(`/og/episode/${ep.id}?v=${v}`, {}, env)).status).toBe(404));
it("render failure 302s to the default image, uncached", async () => {
    const res = await createOgRoutes({ render: async () => { throw new Error("boom"); } })
        .request(`/og/episode/${ep.id}.png?v=${v}`, {}, env);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(DEFAULT_OG_IMAGE);
    expect(res.headers.get("cache-control")).toBe("no-store");
});
it("KV write failure still returns the PNG", async () => {
    const brokenEnv = { ...env, TLDL_DATA: new Proxy(env.TLDL_DATA, { get: (t, p) =>
        p === "put" ? async () => { throw new Error("kv down"); } : Reflect.get(t, p).bind(t) }) };
    const res = await app.request(`/og/episode/${ep.id}.png?v=${v}`, {}, brokenEnv);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
});
it("HEAD behaves like GET", async () => {
    const res = await app.request(`/og/episode/${ep.id}.png?v=${v}`, { method: "HEAD" }, env);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
});
it("an id containing a dot strips only the final .png", async () => {
    const dotted = { ...ep, id: "123_rss_a.b" }; await saveEpisode(env.TLDL_DATA, dotted);
    const dv = await cardVersion(dotted);
    expect((await app.request(`/og/episode/123_rss_a.b.png?v=${dv}`, {}, env)).status).toBe(200);
});
```

  Plus one test through `SELF.fetch("https://tldl-pod.com/og/episode/<id>.png?v=<v>")` that proves the route is mounted in `index.ts` and the real renderer returns `image/png`.

- [ ] **Step 2: Run** `npm test -- test/og-route.test.ts`. Expected: FAIL, module not found.

- [ ] **Step 3: Implement `src/routes/og.ts`.** Route pattern `/og/episode/:file{.+\\.png}`; `episodeId = decodeURIComponent(file.slice(0, -4))`. Order exactly as the spec's route section: episode read (throw → 302 default), redirect/404, version check (302 no-store), KV read (throw → treat as miss), render (throw → log `og_render_failed`, 302 default no-store), KV put with `expirationTtl: TTL.CONTENT` (throw → log `og_cache_write_failed`, still return PNG). Do the KV put inline (awaited) rather than `waitUntil`, so the tests can observe it and a crawler burst after the first render hits the cache.

- [ ] **Step 4: Run** `npm test -- test/og-route.test.ts`. Expected: PASS. Then the full suite, `npm test`. Expected: PASS with no new failures. Then `npm run typecheck`.

- [ ] **Step 5: Commit** `git commit -m "Serve per-episode share cards from /og/episode/<id>.png"`

---

### Task 4: Point episode pages at their card, document, and check real cards

**Files:**
- Modify: `src/lib/broadsheet/detail-page.ts` (new optional `ogImageUrl?: string` in the options interface, passed to `renderBroadsheetHead` as `ogImage`)
- Modify: `src/routes/public.ts` (in `GET /episode/:episodeId`, compute `episodeCardUrl(episode.id, await cardVersion(episode))` and pass it)
- Modify: `AGENTS.md` (new subsection under Architecture Overview: "Episode share cards", covering the route, KV key, cache-busting `v`, `CARD_TEMPLATE_VERSION` bump to redraw everything, fonts location, fallback, and the two log events)
- Test: `test/detail-page.test.ts`

**Interfaces:**
- Consumes: `episodeCardUrl`, `cardVersion` (Task 1).

- [ ] **Step 1: Write the failing tests** in `test/detail-page.test.ts`:

```ts
it("uses the episode card for og:image and twitter:image when given", () => {
    const url = "https://tldl-pod.com/og/episode/x.png?v=abc123abc123";
    const html = renderDetailPage({ episode: episode(), summaryHtml: "", activeTemplate: "key-takeaways",
        availableTemplates: ["key-takeaways"], transcriptText: null, ogImageUrl: url });
    expect(html).toContain(`<meta property="og:image" content="${url}">`);
    expect(html).toContain(`<meta name="twitter:image" content="${url}">`);
});
it("falls back to the default image without ogImageUrl", () =>
    expect(render(episode())).toContain("tldl-og-1200x630.png"));
```

  And in `test/og-route.test.ts`, one `SELF.fetch` of `/episode/<id>` (seed a summary with `saveSummary`) asserting the page's `og:image` contains `/og/episode/<id>.png?v=<cardVersion>`.

- [ ] **Step 2: Run** `npm test -- test/detail-page.test.ts test/og-route.test.ts`. Expected: FAIL on the new tests.

- [ ] **Step 3: Implement** the two modifications and the `AGENTS.md` subsection.

- [ ] **Step 4: Run** `npm test` and `npm run typecheck`. Expected: all PASS.

- [ ] **Step 5: Commit** `git commit -m "Point episode pages at their share card and document it"`

- [ ] **Step 6: Visual check on real episodes.** Pick three prod episodes: a short title with a deck, the longest title with a deck you can find in `episodes:index`, and a pre-redesign episode with no deck (ideally one with `episodeDuration: 0` too). Copy each `episode:<id>` record from prod KV (`npx wrangler kv key get --remote …`) into local KV (`npx wrangler kv key put --local …`), run `npm run dev`, and save `curl -L "http://localhost:8787/og/episode/<id>.png?v=…"` to the session scratchpad. Look at each PNG. Fix any clipping, overlap, or awkward title size in `card-tree.ts` (adjust `titleFontSize` steps first), re-run `npm test`, and commit. Hand the three final PNG paths to the controller for Rian to see; do not deploy.
