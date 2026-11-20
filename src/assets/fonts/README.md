# Share-card fonts

The four static TrueType fonts the episode share card (`src/lib/og/`) is drawn with. satori can't read woff2 or variable fonts, so these are the static instances Google Fonts serves. They're bundled as Data modules through the `[[rules]]` entry in `wrangler.toml`; nothing is fetched at runtime.

| File | Family | Weight / style | Used for |
|------|--------|----------------|----------|
| `Fraunces-SemiBold.ttf` | Fraunces | 600 normal | Title |
| `Fraunces-BlackItalic.ttf` | Fraunces | 900 italic | `TL;DL` wordmark |
| `Fraunces-Italic.ttf` | Fraunces | 400 italic | Deck |
| `JetBrainsMono-Medium.ttf` | JetBrains Mono | 500 normal | Kicker and footer |

Both families are licensed under the SIL Open Font License 1.1: `Fraunces-OFL.txt`, `JetBrainsMono-OFL.txt`.

## Source

Fetched 2026-11-19. The Google Fonts CSS2 API returns `truetype` URLs when the `User-Agent` isn't a browser:

```sh
curl -sS -A "curl/8" \
  "https://fonts.googleapis.com/css2?family=Fraunces:ital,wght@0,600;1,400;1,900&family=JetBrains+Mono:wght@500"

curl -sSf -o Fraunces-Italic.ttf      "https://fonts.gstatic.com/s/fraunces/v38/6NVf8FyLNQOQZAnv9ZwNjucMHVn85Ni7emAe9lKqZTnbB-gzTK0K1ChJdt9vIVYX9G37lvd9sPEKsxx664UJf1hLTf7W.ttf"
curl -sSf -o Fraunces-BlackItalic.ttf "https://fonts.gstatic.com/s/fraunces/v38/6NVf8FyLNQOQZAnv9ZwNjucMHVn85Ni7emAe9lKqZTnbB-gzTK0K1ChJdt9vIVYX9G37lvd9sPEKsxx664UJf1jiSv7W.ttf"
curl -sSf -o Fraunces-SemiBold.ttf    "https://fonts.gstatic.com/s/fraunces/v38/6NUh8FyLNQOQZAnv9bYEvDiIdE9Ea92uemAk_WBq8U_9v0c2Wa0K7iN7hzFUPJH58nib1603gg7S2nfgRYIcaRyjDg.ttf"
curl -sSf -o JetBrainsMono-Medium.ttf "https://fonts.gstatic.com/s/jetbrainsmono/v24/tDbY2o-flEEny0FZhsfKu5WU4zr3E_BX0PnT8RD8-qxjPQ.ttf"

curl -sSf -o Fraunces-OFL.txt      https://raw.githubusercontent.com/google/fonts/main/ofl/fraunces/OFL.txt
curl -sSf -o JetBrainsMono-OFL.txt https://raw.githubusercontent.com/google/fonts/main/ofl/jetbrainsmono/OFL.txt
```

## Checks

`file *.ttf` reports `TrueType Font data` for all four. fontTools wasn't installed, so the table directory was read directly from each file's header: none has an `fvar` or `gvar` table, so all four are static instances.

To refresh, rerun the commands above (the CSS response names the current `v<N>` URLs), repeat the checks, and bump `CARD_TEMPLATE_VERSION` in `src/lib/og/card-model.ts` so every card is redrawn.
