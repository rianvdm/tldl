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
