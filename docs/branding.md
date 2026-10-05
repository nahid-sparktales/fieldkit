# Help center appearance and account settings

Owners and admins can open **Publish → Appearance**, or choose **Customize help center** in Settings. The live preview uses the same header, welcome section, colors, and footer as the customer portal. Its sample articles are illustrative; your published articles appear on the real page.

## Customize the page

- Set a public help center name, or leave it blank to use the workspace name.
- Upload a PNG, JPEG, or static WebP logo up to 1 MB and 2048 × 2048 pixels. The logo also becomes the browser icon and appears in the widget. SVG and arbitrary HTML uploads are not supported. Remove the logo to return to the initial badge.
- Choose a color preset or adjust the accent, page background, and welcome background. Text on colored backgrounds and primary buttons automatically uses readable contrast.
- Write a welcome heading and description. Optionally hide the article list and search; this does not change which approved knowledge the agent can retrieve or withdraw already-public articles.
- Add HTTPS links to your website, privacy policy, and terms, plus optional footer text.

Use **Desktop** and **Mobile** to inspect the preview. **Save appearance** applies the design to already-published channels. It does not publish an unpublished channel. **Reload saved** discards local edits after confirmation. A stale save receives a conflict and must be reloaded; it cannot overwrite another administrator's newer design.

Until the first appearance save, existing installations retain their greeting and brand color from legacy settings. Afterward, the dedicated appearance resource controls public styling independently of agent/model settings. Changing visual settings does not invalidate workflow approvals, change action policies, or consume model tokens. Embedded launcher colors load from the published widget configuration and still require the configured allowed website origin.

## Profile and workspace

Select your name at the bottom of the staff sidebar or open **Settings → My profile**. All staff roles can edit their own display name, review active sessions, change a password using the current password, or sign out other sessions. Older sessions require password confirmation before managing sessions; profile editing remains available. Password changes default to signing out other sessions. The verified email remains the sign-in identity and is read-only. Customers get the same controls through **Your support account** in the portal.

Display names are shared across an account's workspaces and linked customer profiles. They do not change email verification or provider ownership mappings. Owners and admins can rename a workspace in **Settings → Workspace**. Its slug and public address remain stable. Team membership and invitation controls remain in **Team**.

## Storage and access

Run migrations on upgrade (schema 10). Appearance settings and logo bytes are stored in PostgreSQL in `workspace_branding`, so normal database backups include them. Saved logos are never exposed in configuration JSON as image bytes. Logo responses use their detected raster content type, `nosniff`, and no browser caching. Public logos require a published portal or widget; private previews require an owner/admin session. Replacing/removing the logo or unpublishing both channels immediately withdraws the old resource. Workspace deletion cascades to its appearance record.

The staff preview and published page have separate authenticated/public logo URLs. No remote logo fetch, arbitrary CSS, script injection, or model call is needed for customization.

## Navigated Support product identity

Navigated Support is the product name; FieldKit is the previous name. The supplied
Navigated Support Logo Kit is the source of the compass artwork and wordmark.
Editable SVG masters are in [`apps/web/public/brand`](../apps/web/public/brand/).
The [supplied brand guide](assets/navigated-support-brand-guide.pdf) specifies
charcoal `#0F1720`, forest `#4E7A5F`, mint `#A7C4B0`, off-white `#F7F9F8`, and slate
`#334155`, with the tagline **Guide · Resolve · Together**.

Use the light lockup on light backgrounds and the white/mint lockup on dark ones.
Keep at least one-quarter of the visible compass width clear around the mark.
Do not stretch, rotate, add shadows or recolor it. The minimum full-lockup width
is 180 pixels. The staff sidebar uses the supplied compass with a compact,
readable name; account screens and the README share the same identity. Arial is
the guide's supported local fallback for the wordmark.

Customer help centers continue using their own saved logos, colors and names.
Only their product attribution changes to Navigated Support. Existing installation
paths, `FIELDKIT_*` environment variables, the `fieldkit` CLI, `FieldKitClient`,
`window.FieldKit`, crawler identity and provider operation markers stay stable.
No credentials, customer data or workspace settings are changed by the rebrand.
The `demo-v1` archive retains its original FieldKit identity.
