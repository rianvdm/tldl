export const BROADSHEET_INDEX_CSS = `
/* LEAD */
.bs-lead {
  padding: 64px 56px 56px;
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
  transition: background 160ms ease, color 160ms ease;
}
.bs-lead-meta a.chip:hover { background: var(--bs-red); color: var(--bs-paper); }
.bs-lead-tags { display: inline-flex; gap: 10px; align-items: center; flex-wrap: wrap; }
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

.bs-row-meta-mobile { display: none; }
@media (max-width: 1023px) {
  .bs-lead, .bs-index { padding-left: 40px; padding-right: 40px; }
  .bs-row { grid-template-columns: 36px 1fr; gap: 12px; padding: 18px 0; }
  .bs-row .bs-row-date,
  .bs-row .bs-row-dur,
  .bs-row .bs-row-tag,
  .bs-row .bs-row-arrow { display: none; }
  .bs-row-meta-mobile {
    display: block;
    margin-top: 10px;
    font-family: 'JetBrains Mono', ui-monospace, monospace;
    font-size: 10.5px; letter-spacing: 0.14em; text-transform: uppercase;
    color: var(--bs-ink-faint);
  }
}
@media (max-width: 767px) {
  .bs-lead { padding: 20px; grid-template-columns: 1fr; gap: 24px; }
  .bs-lead-title { font-size: 40px; }
  .bs-lead-meta { gap: 12px; }
  /* Force tags onto their own row */
  .bs-lead-tags {
    flex-basis: 100%;
    margin-top: 4px;
    gap: 8px;
  }
  .bs-lead-tags .sep { display: none; }
  /* Tighten the pull quote */
  .bs-pull { padding: 0 0 0 16px; }
  .bs-pull .q-mark {
    font-size: 56px; line-height: 0.7;
    margin-bottom: 0;
  }
  .bs-pull-q { font-size: 19px; line-height: 1.4; }
  .bs-pull-src { margin-top: 12px; }

  .bs-index { padding: 0 20px 32px; }
  .bs-row-title { font-size: 20px; }
}
`;
