import { BROADSHEET_FONTS_LINK, BROADSHEET_TOKENS_CSS } from "./tokens.css";
import { renderBroadsheetHead } from "./head";
import { BROADSHEET_SHARED_CSS } from "./shared.css";
import {
    renderMasthead,
    renderSubnav,
    renderSectionBar,
    renderFooter,
    type SubnavKey,
} from "./chrome";

const BROADSHEET_FORM_CSS = `
.bs-form-page {
    padding: 40px 56px 72px;
    max-width: 62ch;
}
.bs-form-intro {
    font-family: 'Fraunces', Georgia, serif;
    font-size: 19px; line-height: 1.55;
    color: var(--bs-ink);
    margin: 0 0 32px;
}
.bs-form-intro p { margin: 0 0 16px; }
.bs-form-intro a { color: var(--bs-red); border-bottom: 1px solid currentColor; text-decoration: none; }
.bs-form label {
    display: block;
    font-family: 'JetBrains Mono', ui-monospace, monospace;
    font-size: 10.5px; letter-spacing: 0.14em; text-transform: uppercase;
    color: var(--bs-ink-faint);
    margin: 0 0 8px;
}
.bs-form input[type="email"],
.bs-form input[type="text"] {
    width: 100%;
    background: transparent; border: none;
    border-bottom: 1px solid var(--bs-rule);
    padding: 8px 0;
    font-family: 'Fraunces', Georgia, serif;
    font-size: 18px;
    color: var(--bs-ink);
    outline: none;
    transition: border-color 160ms ease;
}
.bs-form input:focus { border-bottom-color: var(--bs-red); }
.bs-form-field { margin-bottom: 28px; }
.bs-form-hint {
    font-family: 'Inter Tight', sans-serif;
    font-size: 13px; line-height: 1.5; color: var(--bs-ink-dim);
    margin-top: 8px;
}
.bs-form-options {
    margin: 0 0 32px;
    border-top: 1px solid var(--bs-rule);
    border-bottom: 1px solid var(--bs-rule);
}
.bs-form-options .opt {
    display: flex; gap: 16px; align-items: flex-start;
    padding: 18px 0;
    border-top: 1px solid var(--bs-rule);
    cursor: pointer;
}
.bs-form-options .opt:first-child { border-top: none; }
.bs-form-options .opt input[type="checkbox"] {
    margin-top: 4px;
    accent-color: var(--bs-red);
    width: 16px; height: 16px;
    cursor: pointer;
}
.bs-form-options .opt-body { flex: 1; min-width: 0; }
.bs-form-options .opt-name {
    font-family: 'Fraunces', Georgia, serif;
    font-size: 18px; line-height: 1.3;
    color: var(--bs-ink);
}
.bs-form-options .opt-author {
    font-family: 'JetBrains Mono', ui-monospace, monospace;
    font-size: 10.5px; letter-spacing: 0.14em; text-transform: uppercase;
    color: var(--bs-ink-faint);
    margin-top: 4px;
}
.bs-form-submit {
    background: transparent; border: none; padding: 12px 0;
    font-family: 'JetBrains Mono', ui-monospace, monospace;
    font-size: 11px; letter-spacing: 0.14em; text-transform: uppercase;
    color: var(--bs-red);
    cursor: pointer;
    transition: transform 160ms ease;
}
.bs-form-submit:hover { transform: translateX(4px); }
.bs-form-submit:disabled { color: var(--bs-ink-faint); cursor: not-allowed; transform: none; }
.bs-form-banner {
    border-top: 2px solid var(--bs-red);
    border-bottom: 2px solid var(--bs-red);
    padding: 24px 0; margin: 0 0 32px;
    font-family: 'Fraunces', Georgia, serif;
    font-style: italic; font-size: 20px; line-height: 1.3;
    color: var(--bs-ink);
}
.bs-form-banner a { color: var(--bs-red); border-bottom: 1px solid currentColor; text-decoration: none; font-style: normal; }
.bs-form-actions { margin-top: 8px; }
.cf-turnstile { margin: 16px 0 24px; }
@media (max-width: 1023px) { .bs-form-page { padding-left: 40px; padding-right: 40px; } }
@media (max-width: 767px) { .bs-form-page { padding: 24px 20px 48px; } }
`;

export interface FormPageOptions {
    activeNav: SubnavKey;
    sectionHeading: string;
    sectionCount: string;
    bodyHtml: string;
    pageTitle: string;
    description?: string;
    canonicalUrl?: string;
    now?: Date;
    totalInArchive: number;
    headExtra?: string;
}

export function renderFormPage(opts: FormPageOptions): string {
    const now = opts.now ?? new Date();
    return `<!doctype html>
<html lang="en">
<head>
${renderBroadsheetHead({ title: opts.pageTitle, description: opts.description, canonicalUrl: opts.canonicalUrl, extra: opts.headExtra })}
${BROADSHEET_FONTS_LINK}
<style>${BROADSHEET_TOKENS_CSS}${BROADSHEET_SHARED_CSS}${BROADSHEET_FORM_CSS}</style>
</head>
<body>
<div class="bs-page">
${renderMasthead({ now, episodeCount: opts.totalInArchive })}
${renderSubnav(opts.activeNav)}
${renderSectionBar(opts.sectionHeading, opts.sectionCount)}
<div class="bs-form-page">
${opts.bodyHtml}
</div>
${renderFooter()}
</div>
</body>
</html>`;
}
