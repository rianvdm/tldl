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
