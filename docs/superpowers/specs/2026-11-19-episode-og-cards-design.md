# Per-episode share cards

## Why

When someone shares a tldl episode link in Discord, Slack, iMessage, X, or LinkedIn, the unfurl shows the right words but the wrong picture. `renderBroadsheetHead` (`src/lib/broadsheet/head.ts`) gives every page the same static image, `https://file.elezea.com/tldl-og-1200x630.png`, a homepage card that says "Podcast summaries that respect your time." The detail page (`src/lib/broadsheet/detail-page.ts`) already passes the episode title as `og:title`, and the deck as `og:description` (or a generated "Summary of … from …" sentence when there is no deck), so the text is right; only the image is generic. A shared episode should look like that episode.

elezea.com has per-post cards, but it makes them with a manual step: `npm run og -- <slug>` runs headless Chrome on the laptop, writes `public/og/<slug>.png`, and the PNG is committed. tldl publishes episodes from the cron and queue with nobody at a desk, so the card has to be drawn by the Worker itself. The look carries over from elezea; the mechanism does not.

## Goals

- Every episode page's `og:image` and `twitter:image` point at a card for that episode: podcast name, episode title, deck when there is one, date and runtime, in the Broadsheet look.
- Works for every episode, old and new, with no backfill and no change to the queue consumer.
- A card changes when the episode's title, deck, or podcast name changes, and link-preview caches see the change.

## Non-goals

- Cards for other pages (home, podcast browse, tag browse, about). They keep the static default.
- The pull quote on the card. Older episodes don't have one, and title plus deck is the recommendation Rian accepted.
- Podcast artwork on the card. It would mean fetching third-party images at render time; not now.
- A preview or admin UI for cards.

## Anti-goals

- A share that shows a broken or blank image. A failed render must fall back to the static default card, never a 500 or an empty response.
- Making the episode page slower. The page itself never renders a card; it only emits a URL.
- Any runtime dependency on Google Fonts or another third party to draw a card.

## Approaches

1. **Draw on first request, cache in KV (chosen).** A new route draws the PNG with satori (HTML-like tree to SVG) and resvg (SVG to PNG), both compiled to wasm, and caches the result. Old episodes get a card the first time anyone shares them, so there's nothing to backfill, and a render failure can't touch transcription or summarising.
2. **Draw once in the queue consumer at publish time, store the PNG.** Same libraries, but every existing episode needs a backfill, and a render bug would sit inside the job pipeline. Rejected.
3. **Browser Rendering binding (headless Chrome).** Closest to elezea's script and could reuse real HTML and CSS, but it starts a browser per card and adds a paid-binding dependency for one image. Rejected as overkill.

## Design

### URL and cache-busting

The detail page sets `ogImage` (already an option on `renderBroadsheetHead`, unused today) to:

```
https://tldl-pod.com/og/episode/<episodeId>.png?v=<cardVersion>
```

`cardVersion` is a short hash of everything drawn on the card (episode title, podcast name, deck, date, runtime) plus a `CARD_TEMPLATE_VERSION` constant. Link-preview services cache images by URL, so a new `v` is the only reliable way to get them to refetch after an edit or a redesign. Bumping `CARD_TEMPLATE_VERSION` redraws every card.

### Route: `GET /og/episode/<episodeId>.png`

That is the public URL shape. Hono reads `/og/episode/:episodeId.png` literally as a parameter named `episodeId.png` that also matches URLs without the suffix, so register a pattern that requires `.png` and strip it (for example `/og/episode/:file{.+\.png}`). A URL without `.png` is a 404.

1. Load the episode with `getEpisode`. If it's missing, check `getEpisodeRedirect` and 301 to the canonical card URL, as the page route does; otherwise 404. If the episode read itself throws, 302 to the static default image.
2. Compute `cardVersion` from the episode as it is now. If the request's `v` is missing or differs, 302 to the URL with the current `v`, with `Cache-Control: no-store`. Only a request whose `v` matches is ever answered with PNG bytes, so the year-long immutable cache in step 5 always covers the right image. (A briefly stale KV read of the episode can send a crawler to the previous version for up to about a minute after an edit; that's acceptable.)
3. Look up KV key `og:{episodeId}:{cardVersion}`. On a hit, return the PNG. A failed cache read is treated as a miss.
4. On a miss, draw the card, `put` it under that key with a 365-day TTL (`TTL.CONTENT`, matching the episode record), and return it. Old-version keys are never read again and expire on their own. A failed KV write after a successful draw is logged (`og_cache_write_failed`) and the PNG is still returned.
5. Response headers for PNG bytes: `Content-Type: image/png`, `Cache-Control: public, max-age=31536000, immutable`.
6. If drawing throws, log `og_render_failed` with `episodeId` and the error, and 302 to the static default image with `Cache-Control: no-store`, so the next request tries again.

Admin-deleted episodes need no cleanup: the route reads the episode first, so an orphaned PNG is never served and expires with its TTL. A copy already cached by a client or link-preview service can't be recalled; there's no prompt-takedown requirement.

Updated cards reach a platform the next time it rescrapes the episode page and sees the new image URL. Platforms that cache a page's preview (LinkedIn, Facebook, Slack) may keep showing the old card for a link already shared; that's accepted, not something this design tries to force.

### The card

1200×630, same frame as the current default card so the two read as one brand.

```
┌────────────────────────────────────────────────────────────┐
│                         TL;DL                              │  wordmark, Fraunces black italic, "L"s in red
├────────────────────────────────────────────────────────────┤
│ LENNY'S PODCAST — NOV 18, 2026 ───────────────────         │  kicker, JetBrains Mono, red
│                                                            │
│ How the best product teams                                 │  title, Fraunces, ink, size steps down
│ decide what not to build                                   │  with length, max 3 lines
│                                                            │
│ A former Stripe PM explains why saying no is a skill,      │  deck, Fraunces italic, ink-dim,
│ and the three questions she asks before any roadmap.       │  max 2 lines, ellipsis
│                                                            │
├────────────────────────────────────────────────────────────┤
│ TLDL · PODCAST SUMMARIES                1H 12M · TLDL-POD.COM │  footer, JetBrains Mono, faint
└────────────────────────────────────────────────────────────┘
```

- Colours come from the Broadsheet tokens in `src/lib/broadsheet/tokens.css.ts`: paper `#10100e`, ink `#f1ece3`, ink-dim `#b8b0a3`, ink-faint `#6f685d`, red `#e63946`, rules `#4a4a40`.
- Without a deck, the title gets the extra room and sits a little lower; nothing else changes. Pre-redesign episodes have no deck, and new episodes can also lack one because editorial metadata generation is best effort.
- `episodeDuration` can be `0` when the feed or a manual submission didn't supply it. Then the runtime is left out of the footer rather than shown as `0M`.
- Characters the bundled fonts don't cover (emoji, non-Latin scripts) are a known limit. Emoji are stripped from the card text; other uncovered characters render however satori handles a missing glyph. This assumes the catalogue stays English-language, so it's accepted rather than solved with more fonts. A test with an emoji in the title must still produce a PNG.
- The footer domain is `tldl-pod.com`. (The current default card's footer says `TLDL.FM`; fixing that static image is out of scope, noted for Rian.)

### Fonts

Vendored static TTF files under `src/assets/fonts/` (or wherever wasm/data imports sit best), imported as Data modules through a `[[rules]]` entry in `wrangler.toml`. satori cannot read woff2 or variable fonts, so these must be static instances. Keep it to four files: Fraunces 600 (title), Fraunces 900 italic (wordmark), Fraunces 400 italic (deck), JetBrains Mono 500 (labels). Both families are OFL; commit the licence files beside them.

### Libraries

`@cf-wasm/og` wraps satori and resvg for workerd and is maintained (0.5.0, August 2026); the older `workers-og` hasn't published since June 2025. `@cf-wasm/og` warns that it breaks between versions without semver, so pin an exact version. The builder may instead use its underlying `@cf-wasm/satori` and `@cf-wasm/resvg` directly with satori's plain-object element tree, which avoids pulling in React; pick whichever needs fewer moving parts. Either way, the card markup is a pure function `episode → element tree` so it can be unit-tested without drawing.

## Constraints

- Workers Paid plan, `cpu_ms = 300000`; today's bundle is 333 KiB gzipped. The wasm and fonts will add to that (estimate: low single-digit MB), well under the paid limit. Measure with `wrangler deploy --dry-run` before and after.
- `compatibility_date = "2024-01-01"`. If the library needs a newer date, raise it deliberately and run the full test suite; don't do it silently.
- Tests run in `@cloudflare/vitest-pool-workers`; wasm imports must work there.
- Deploys are manual (`npm run deploy`); merging does not deploy.

## Testing

- Unit: `cardVersion` changes when title, podcast name, deck, date, runtime, or `CARD_TEMPLATE_VERSION` change, and only then.
- Unit: the element tree for an episode with a deck, without a deck, and with a long title (100+ characters) and a long deck.
- Route: hit (serves cached bytes, no render), miss (renders, writes KV, returns `image/png`), missing or stale `v` → 302 to the current `v`, redirect for an aliased ID, 404 for unknown or a URL without `.png`, render failure → 302 to the default image, KV write failure still returns the PNG.
- Detail page: `og:image` and `twitter:image` carry the episode card URL with `v`.
- Visual: before deploy, render cards for at least three real prod episodes (short title with deck, long title with deck, pre-redesign episode without deck) and show them to Rian. Then check one live URL with a link-preview debugger or a Discord paste after deploy.

## Left to the builder

- `@cf-wasm/og` versus `@cf-wasm/satori` + `@cf-wasm/resvg` directly.
- Title size steps and exact spacing, as long as a 3-line title and 2-line deck fit without clipping. elezea's lesson applies: size against a fixed pixel width, not a character count alone.
- The hash function for `cardVersion` (anything short and stable; Web Crypto SHA-256 truncated is fine).
- Where the route lives (`src/routes/public.ts` or its own module).
