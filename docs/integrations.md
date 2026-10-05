# Integrations and identity

Use dedicated test accounts first. No credentials or approved vendor registrations are distributed in the repository or image. Connecting a key validates access; it does not prove every connector operation passed. Record the real flows in [verification](verification.md).

## Model providers

Connect OpenAI, Claude, Kimi, OpenRouter, DeepSeek, vLLM, or another OpenAI-compatible endpoint in Connections. Choose the response provider/model and a separate embedding provider/model in Settings. Every response is schema-validated, and usage is recorded against the workspace's shared token budget. Changing embedding configuration queues a full reindex. See [model providers](models.md) for setup, supported request formats, local server access, and verification limits.

References: [response model](https://developers.openai.com/api/docs/models/gpt-5.4-mini), [embedding model](https://developers.openai.com/api/docs/models/text-embedding-3-small).

## Zendesk

The installation operator registers their own OAuth application. Distributed integrations require a Zendesk-approved global OAuth client; vendor approval is a release blocker. Set `ZENDESK_CLIENT_ID`, `ZENDESK_CLIENT_SECRET`, and the exact callback `https://YOUR-ORIGIN/v2/oauth/zendesk/callback`. Connect the account's subdomain in Connections. The flow uses state, PKCE, and server-side encrypted token storage/refresh.

Create a signed Zendesk webhook pointing to the workspace URL shown in Connections. Configure ticket-create/update triggers to POST JSON with `{"ticket_id":"{{ticket.id}}"}`. Preserve Zendesk's signature, signature timestamp, and invocation ID headers. Copy the webhook signing secret into Navigated Support's Zendesk settings. Signatures cover the timestamp plus exact request body; the server rejects timestamps outside five minutes. Keep the server clock synchronized. Publish the Zendesk channel only after this setup succeeds.

Requested scopes cover ticket read/write, users, organizations, and help-center read. The connector paginates comments/audits, suppresses its own comment IDs using audit metadata, and uses `safe_update` with `updated_stamp`. It handles conflicts without replaying uncertain writes. Configure native portal/widget handoff independently to native or Zendesk. A native customer needs a verified email to create a Zendesk handoff ticket. Existing Zendesk requesters are not automatically linked to portal accounts by email; review mappings in Team.

Test public replies, internal notes, tags, external agent assignment, status, customer follow-ups, requester changes, duplicate webhooks, expired tokens, and provider rate limits. The `/control` endpoint accepts `tags` and `externalAssigneeId`. Staff should inspect unknown deliveries in Activity before retrying; an uncertain write only performs outcome lookup.

References: [authentication/global OAuth](https://developer.zendesk.com/api-reference/introduction/security-and-auth/), [metadata and safe updates](https://developer.zendesk.com/documentation/ticketing/managing-tickets/creating-and-updating-tickets/).

## Notion

Either share selected pages with an internal integration and connect its token, or configure an operator-owned public OAuth integration with `NOTION_CLIENT_ID`, `NOTION_CLIENT_SECRET`, and callback `/v2/oauth/notion/callback`. Select/shared pages define provider access. Add individual page IDs in Knowledge. Navigated Support reads page/block content recursively within documented size/depth limits; it does not import the entire workspace. Hourly refresh removes inaccessible pages from retrieval when Notion revokes access.

[Notion authorization](https://developers.notion.com/guides/get-started/authorization).

## Google Drive

Enable Google Drive API and Picker API in one Google Cloud project. Configure a web OAuth client with callback `/v2/oauth/google/callback`; set `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_PICKER_KEY`, and `GOOGLE_APP_ID` (project number). Restrict the Picker browser key to your app origin (HTTPS in production; for local development, for example `http://localhost:4318/*`) and `https://docs.google.com/*`, because Picker renders in a Google iframe. Restrict its APIs to Google Picker API and Google Drive API. Complete Google's consent/verification requirements for the intended users.

Connect Google, then use **Choose Drive files** in Knowledge. Navigated Support requests only `drive.file`, which grants access to files selected/shared with the application. It does not enumerate a user's entire Drive. Native Google documents export to text, spreadsheets to CSV; supported binary documents use the file extractor. Removed, inaccessible, unsupported, and empty files fail visibly and are excluded from retrieval.

[Picker setup and restrictions](https://developers.google.com/workspace/drive/picker/guides/web-picker), [Drive scopes](https://developers.google.com/workspace/drive/api/guides/api-specific-auth), [web-server OAuth](https://developers.google.com/identity/protocols/oauth2/web-server).

## Stripe App restricted keys

Register your own Stripe App using the restricted-API-key template. Configure read permissions for customers, charges, and subscriptions and write permissions for refunds and subscription updates. Follow Stripe's current permission names and app review requirements; this repository does not claim a published/approved marketplace app.

Install it in a dedicated Stripe test account and generate its restricted key. Connect `rk_test_…` under **Stripe test**. Live installations use **Stripe live** and `rk_live_…`; mismatched prefixes are rejected. Both connections can coexist. Each action explicitly selects test or live mode, with test as the default. No ordinary secret `sk_…` key is accepted.

In Team, review the customer's `stripe_test` or `stripe_live` mapping to the correct `cus_…` ID. Select an existing charge/subscription, never infer ownership from supplied text. Refunds use integer minor units and cannot exceed the captured, unrefunded balance. Full refunds are the remaining balance. Cancellation sets `cancel_at_period_end=true` on the selected subscription. All writes require approval initially; automatic refund policies require explicit currency, per-action amount, and daily count limits.

[Restricted-key app installation](https://docs.stripe.com/stripe-apps/api-authentication/rak), [Stripe App permissions](https://docs.stripe.com/stripe-apps/reference/permissions).

## Signed widget identities

Anonymous widget users can ask customer-safe questions. To authenticate an existing website user, generate an identity signing key in Publish and store it only on the website's server. After checking your own session, sign a short-lived payload (at most one hour). The subject must come from your authenticated database record, not request text.

```ts
import { createHmac } from "node:crypto";
const payload = Buffer.from(
  JSON.stringify({
    sub: authenticatedUser.id,
    name: authenticatedUser.name,
    email: authenticatedUser.verifiedEmail,
    exp: Math.floor(Date.now() / 1000) + 300,
  }),
).toString("base64url");
const assertion =
  payload +
  "." +
  createHmac("sha256", process.env.FIELDKIT_IDENTITY_SECRET!)
    .update(payload)
    .digest("base64url");
// Return only the short-lived assertion to this signed-in user's browser.
```

Load the embed snippet shown in Publish, then call `window.FieldKit.identify(assertion)`. Configure exact allowed website origins. The signing key is never put in browser code. This establishes a customer identity; provider mappings still require staff review. Rotate it in Publish to invalidate old assertions.

## Custom APIs

Owners configure a fixed public HTTPS endpoint, optional encrypted bearer credential, a closed JSON input/output schema, a customer mapping key, and approval rules. Save a credential using the authenticated `/connections/key` endpoint with provider `custom:YOUR-ID`; set `credentialId` to `YOUR-ID`. There are no scripts, templated hosts, redirects, private-network endpoints, or model-chosen URLs.

Example configuration:

```json
{
  "endpoint": "https://support-api.example.com/change-delivery",
  "lookupEndpoint": "https://support-api.example.com/operation-status",
  "credentialId": "orders",
  "mappingKey": "commerce_customer",
  "idempotent": true,
  "inputSchema": {
    "type": "object",
    "properties": { "orderId": { "type": "string" } },
    "required": ["orderId"],
    "additionalProperties": false
  },
  "outputSchema": {
    "type": "object",
    "properties": {
      "status": { "type": "string" },
      "orderId": { "type": "string" }
    },
    "required": ["status", "orderId"],
    "additionalProperties": false
  }
}
```

The write endpoint receives `{"operationId":"…","customerId":"staff-reviewed-provider-id","parameters":{"orderId":"…"}}`, a bearer header if configured, and `Idempotency-Key`. It must atomically store and replay the result for that operation ID. Enforce customer ownership independently on your API. Read actions use the same fixed POST envelope and must have no business side effects.

The lookup endpoint receives `{"operationId":"…","customerId":"…"}` and returns `{"status":"confirmed","operationId":"…","result":{…}}` only when the original result is known. `result` must match the configured output schema. Anything else remains unknown. Automatic writes cannot be enabled without both an idempotency contract and lookup endpoint. Returning HTTP 200 alone does not establish an uncertain write's outcome.

## Scope-specific diagnostics

Readiness reports configuration, exact reads, dedicated writes and manual notes separately. Safe checks never issue business writes. Dedicated Zendesk notes require a tagged unlinked test ticket; Stripe probes are test-mode only with explicitly marked owned resources. Custom endpoint tests require `config.diagnosticTest=true`, a staff-mapped test contact, schemas, and idempotency plus lookup for writes. Unknown outcomes use read-only lookup. These checks do not replace [real release gates](verification.md) or grant execution permissions. [Detailed controls](operational-controls.md#readiness).
