# Email templates

Source-of-truth copies of the Postmark templates rendered for transactional and broadcast email. Live versions are stored in Postmark on server `4477552` (production) — these files exist so the design lives in git history alongside the code.

| Alias | TemplateId | Stream | Sent from |
|---|---|---|---|
| `episode-summary` | `44604698` | `episode-summaries` (broadcast) | `src/notifications.ts` |
| `confirm-subscription` | `44604858` | `tldl` (transactional) | `src/routes/subscriptions.ts` |
| `manage-link` | `44604859` | `tldl` (transactional) | `src/routes/subscriptions.ts` |

## Editing

These files are not read at runtime — Postmark renders the live copy. To change a template:

1. Edit the `.html` and `.txt` here.
2. Push to Postmark with `X-Postmark-Server-Token` (the production server token, not the account token):
   ```
   curl -X PUT \
     -H "X-Postmark-Server-Token: $POSTMARK_SERVER_TOKEN" \
     -H "Content-Type: application/json" \
     -d "$(jq -n --arg subject '...' --rawfile html ./<alias>.html --rawfile text ./<alias>.txt \
            '{Subject:$subject, HtmlBody:$html, TextBody:$text, TemplateType:"Standard"}')" \
     "https://api.postmarkapp.com/templates/<alias>"
   ```
3. Test send via `POST /email/withTemplate` to your own inbox before merging.

## Postmark gotchas

- **No `<link rel="stylesheet">` to external CSS.** Postmark blocks it server-side (`ErrorCode 1122`). Use inline styles or a `<style>` block in `<head>`.
- **Broadcast streams require `{{{ pm:unsubscribe }}}`** somewhere in the body. If the token is absent, Postmark auto-injects its own unsubscribe footer below your content. The `episode-summary` template embeds it inline as the third footer link so the auto-footer is suppressed.
- **The Account token can't read or PUT templates** — those are server-scoped. Use the Server token for all template CRUD. The Account token is in `.dev.vars` as `POSTMARK_ACCOUNT_TOKEN`; the Server tokens come from `GET /servers` with the Account token.
- **Test sends to the broadcast stream still work** for non-subscribers — Postmark only suppresses delivery for addresses on the stream's suppression list.
