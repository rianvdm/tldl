export const BROADSHEET_SHARED_CSS = `
/* Container */
.bs-page { width: 100%; max-width: 1280px; margin: 0 auto; min-height: 100vh; }

/* Masthead */
.bs-mast {
  border-bottom: 2px solid var(--bs-ink);
  padding: 40px 56px 32px;
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
  padding: 16px 56px 18px;
  display: flex; justify-content: space-between; align-items: baseline;
  font-family: 'JetBrains Mono', ui-monospace, monospace;
  font-size: 10.5px; letter-spacing: 0.14em; text-transform: uppercase;
  color: var(--bs-ink-faint);
  border-bottom: 0.5px solid var(--bs-rule);
}
.bs-subhead .nav-items { display: flex; gap: 28px; }
.bs-subhead .nav-items a { color: var(--bs-ink-dim); transition: color 160ms ease; }
.bs-subhead .nav-items a:hover { color: var(--bs-ink); }
.bs-subhead .nav-items a.active { color: var(--bs-red); }
.bs-subhead .nav-items a.active:hover { color: var(--bs-red); }
.bs-search { margin: 0; }
.bs-search input {
  font-family: 'JetBrains Mono', ui-monospace, monospace;
  font-size: 10.5px; letter-spacing: 0.14em; text-transform: uppercase;
  color: var(--bs-ink-dim);
  background: transparent;
  border: none;
  border-bottom: 1px solid var(--bs-rule);
  padding: 4px 2px;
  width: 240px;
  outline: none;
}
.bs-search input:focus { border-bottom-color: var(--bs-red); color: var(--bs-ink); }
.bs-search input::placeholder { color: var(--bs-ink-faint); }

/* Section bar */
.bs-section-bar {
  display: flex; align-items: baseline; gap: 16px;
  padding: 56px 56px 20px;
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

/* Pagination */
.bs-pagination {
  display: flex; justify-content: space-between; align-items: baseline;
  padding: 32px 56px 48px;
  font-family: 'JetBrains Mono', ui-monospace, monospace;
  font-size: 11px; letter-spacing: 0.14em; text-transform: uppercase;
  color: var(--bs-ink-faint);
}
.bs-pagination a { color: var(--bs-red); }
.bs-pagination a:hover { color: var(--bs-ink); }
.bs-pagination .disabled { color: var(--bs-rule-strong); }
.bs-pagination .page-info { color: var(--bs-ink-dim); }

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
