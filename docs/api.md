# API and client interfaces

All resource endpoints live under `/v2`. Better Auth uses `/api/auth`. Staff and portal users use verified session cookies. Cookie-authenticated mutations require the installation's exact Origin. Service/widget credentials use `Authorization: Bearer …`. Resource IDs and widget slugs never grant administrative access.

The base for authenticated resources is `/v2/workspaces/:workspaceId`. These are the primary routes; inspect `apps/api/server.ts` for input validation and the complete contract.

| Route suffix                                           | Methods            | Access and purpose                                                                       |
| ------------------------------------------------------ | ------------------ | ---------------------------------------------------------------------------------------- |
| empty                                                  | GET                | Workspace settings, channels, usage                                                      |
| `/settings`                                            | PUT                | Admin settings                                                                           |
| `/appearance`                                          | GET, PUT           | Owner/admin public appearance, optimistic revision and optional logo                     |
| `/appearance/logo`                                     | GET                | Owner/admin private saved-logo preview                                                   |
| `/profile`                                             | PUT                | Owner/admin workspace rename; accepts only `name`                                        |
| `/members`, `/invitations`                             | GET / POST         | Staff list / admin invitations                                                           |
| `/contacts`, `/contacts/:id/mapping`                   | GET / PUT          | Staff identities / reviewed admin mapping                                                |
| `/agent/test`                                          | POST               | Admin answer preview with no account actions                                             |
| `/workflow`                                            | GET / PUT          | Staff graph/resources/version list / admin draft save with current revision              |
| `/workflow/publish`                                    | POST               | Admin publish of the exact saved draft revision                                          |
| `/workflow/test`                                       | POST               | Admin route preview; code and reads run, with no account writes or ticket changes        |
| `/workflow/components`                                 | POST               | Admin creates a reusable component version                                               |
| `/workflow/components/:id`                             | PUT / DELETE       | Admin saves a new immutable version / archives from new selection                        |
| `/workflow/components/:id/versions/:version`           | GET                | Staff reads an active component’s saved version in this workspace                        |
| `/workflow/components/test`                            | POST               | Admin tests code/API/subflow with explicit JSON inputs; no writes                        |
| `/workflow/step-results`                               | GET                | Staff reads the latest 30 custom executions, output, logs, and errors                    |
| `/workflow/versions/:version`                          | GET                | Staff read of an immutable published definition in this workspace                        |
| `/conversations`                                       | GET, POST          | Staff inbox or own customer tickets                                                      |
| `/conversations/:id`                                   | GET, DELETE        | Authorized history; admin deletion guards unresolved operations                          |
| `/conversations/:id/messages`                          | POST               | Customer message or staff reply; `body`, unique `requestKey`                             |
| `/conversations/:id/notes`                             | POST               | Staff-only internal note                                                                 |
| `/conversations/:id/control`                           | POST               | Staff takeover/resume, assignment, status, Zendesk tags/assignee                         |
| `/conversations/:id/events`                            | GET                | SSE with repeated authorization checks                                                   |
| `/sources`                                             | GET                | Staff knowledge library                                                                  |
| `/sources`, `/sources/upload`                          | POST               | Admin selected import / multipart file upload                                            |
| `/sources/:id/refresh`                                 | POST               | Admin asynchronous refresh                                                               |
| `/sources/:id/visibility`                              | PUT                | Admin customer-answer approval                                                           |
| `/documents/:id/publish`                               | PUT                | Separate public article publication                                                      |
| `/sources/:id`                                         | DELETE             | Admin source removal                                                                     |
| `/faqs`                                                | GET / POST         | Staff FAQ library / admin private draft creation                                         |
| `/faqs/:id`                                            | PUT / DELETE       | Admin edit with revision / remove FAQ                                                    |
| `/faqs/:id/approve`                                    | POST               | Admin approval of the exact revision; queues indexing                                    |
| `/faqs/generate`                                       | POST               | Admin AI generation of private drafts from approved knowledge                            |
| `/assistance`                                          | GET / POST         | Staff workflow history / queue a workflow; FAQ review and article creation require admin |
| `/assistance/:id/cancel`                               | POST               | Cancel queued or running work; already-created drafts stay private                       |
| `/assistance/:id/retry`                                | POST               | Retry a failed workflow from its saved progress                                          |
| `/assistance/:id/compose`                              | POST               | Revalidate a reply/report and return text for the staff composer; does not send          |
| `/assistance/:id/apply`                                | POST               | Apply reviewed triage or save a reviewed private article                                 |
| `/faqs/assist`                                         | POST               | Admin AI suggestion for the editor; does not save or publish                             |
| `/connections`                                         | GET                | Admin metadata, no stored secrets                                                        |
| `/connections/key`                                     | POST               | Validated key connection                                                                 |
| `/connections/:provider/oauth`                         | POST               | Session-bound OAuth start                                                                |
| `/connections/:provider`                               | DELETE             | Disconnect and invalidate affected knowledge                                             |
| `/actions`, `/actions/:id`                             | GET, POST / PUT    | Staff list / owner definitions and policies                                              |
| `/approvals/:id/decision`                              | POST               | Owner/admin exact-hash approve/reject                                                    |
| `/operations`, `/operations/jobs`                      | GET                | Audit/recovery views                                                                     |
| `/operations/:id/reconcile`, `/jobs/:id/retry`         | POST               | Admin bounded recovery, no bypass                                                        |
| `/identity-key`                                        | POST               | Owner widget identity-key rotation                                                       |
| `/credentials`, `/credentials/:id`                     | GET, POST / DELETE | Owner scoped service-token issue/list/revoke                                             |
| `/identities`                                          | POST               | Trusted service establishes existing website customer identity                           |
| `/requests`, `/requests/:id`, `/requests/:id/messages` | POST / GET / POST  | Scoped service support request/status                                                    |

Public routes under `/v2/public/:slug` expose only published configuration and articles. `/join` binds a verified portal account. `/widget/session` creates an anonymous or server-signed customer token for a published widget. Exact allowed origins are checked. `/v2/webhooks/zendesk/:workspaceId` accepts only provider-signed events. OAuth callbacks are `/v2/oauth/:provider/callback`.

## Appearance and profile

`GET /v2/workspaces/:workspaceId/appearance` returns `{ config, revision, logoUrl }`. `PUT` accepts `{ config, revision, logo? }`, with a complete `Appearance` config from `packages/platform/src/branding-contracts.ts`. Omit `logo` to keep it, send `null` to remove it, or send `{ "data": "base64 raster bytes" }` to replace it. Maximum decoded logo size is 1 MB. Stale revisions return 409; failed validation leaves the saved appearance untouched. Configuration only exposes public copy, colors and HTTPS links, not model settings or credentials.

Published portal and widget configuration include `appearance` as well as the existing `name`, `greeting`, and `brandColor` fields. Widget configuration also includes `brandTextColor` for launcher contrast. Public logo bytes are served at `/v2/public/:slug/appearance/logo` only while at least one native channel is published. The workspace `/appearance/logo` route requires an owner/admin session. Logo responses are not cached, including when the URL includes a version query.

`PUT /v2/profile` accepts only `{ "name": "Display name" }` for the verified signed-in user and synchronizes linked contact names. It cannot select another user, alter email, or change identity mappings. The workspace `/profile` endpoint accepts `{ "name": "Workspace name" }` and preserves the slug. Password and session controls use Better Auth's `/api/auth/change-password`, `/list-sessions`, and `/revoke-other-sessions`; password changes require the current password. See [the branding guide](branding.md).

## Model configuration

`POST /connections/key` accepts `provider`, `apiKey`, an optional exact `model` ID to validate, and (for `vllm` or `openai_compatible`) `baseUrl` and `jsonMode: "schema" | "json"`. Model provider IDs are `openai`, `anthropic`, `kimi`, `openrouter`, `deepseek`, `vllm`, and `openai_compatible`. Only the last two permit empty API keys. Private endpoints require the operator's exact `FIELDKIT_MODEL_ENDPOINTS` allowlist. Connections return metadata, never saved secrets.

`PUT /settings` accepts the workspace Settings object, including `responseProvider`, `model`, `embeddingProvider`, `embeddingModel`, `embeddingDimensions`, and `monthlyTokenBudget`. Embedding providers are `openai`, `openrouter`, `vllm`, or `openai_compatible`. Use the current settings from `GET` at the workspace base and replace the desired fields. Changing embedding configuration invalidates retrieval from the old vectors and queues reindexing transactionally. Workflow agent nodes may set `data.provider` and `data.model`; an empty provider uses the workspace default. See [model setup](models.md).

## Documentation site imports

Create a source with `{"kind":"website","scope":"site","title":"Product docs","locator":"https://docs.example.com/"}`. Omit `scope` or use `"page"` to import only one page. In the app, choose **Knowledge → Documentation site**. Use the documentation root to include the whole site, or a section URL to restrict the scan to that path.

The worker discovers pages from sitemaps (including sitemap indexes and robots.txt declarations) and internal links. It stays on the exact HTTPS origin and under the selected path, honors robots.txt and noindex, and never executes page scripts. Public, server-rendered pages are supported; login-protected or JavaScript-only content needs another import method. Query strings, fragments, and trailing slashes are treated as aliases. Crawls are bounded to 500 discovered pages, 25 sitemaps, 2 MB per response, 50 MB per scan, five million extracted characters, and five minutes of crawling. A limit or transient provider failure is an explicit failed import, not a successful partial index.

`sources.metadata.crawl` reports discovery, scanning, indexing, and skipped-page reasons. Each page has its own document, URL (`documents.locator` and citation `url`), version, preview, and publication control. Unchanged pages reuse embeddings. Hourly/manual refresh removes unavailable or no-longer-discovered pages from retrieval and unpublishes them; a failed import disables the source's evidence until a successful refresh. New content stays within the source's selected audience, and publishing articles remains an explicit per-page action.

## FAQs

FAQs are workspace-scoped knowledge sources (`kind: "faq"`). Create one with `{ "question": "How do I get help?", "answer": "Open a ticket in the help center." }`. It starts in `draft` with staff-only visibility and requires no model call. Edits also include the current `revision`; conflicting saves return 409. Editing immediately deactivates/unpublishes the old document and resets the FAQ to a private draft.

Approve with `{ "revision": 1 }` at `/faqs/:id/approve`. Approval requires a connected model for embedding and queues indexing in the same transaction. Once ready, the agent can cite the FAQ. Public help-center publication remains a separate `/documents/:id/publish` action. Draft FAQs are excluded from hourly ingestion and cannot be retrieved by customers.

AI generation accepts `{ "count": 5, "instructions": "Focus on onboarding", "sourceId": "optional-approved-source-id" }` (1–8 FAQs). It uses a bounded selection of current customer-approved chunks, validates returned citations, rechecks source access, and saves private drafts only. `/faqs/assist` accepts `question`, optional `answer`, optional `instructions`, and optional `sourceId`; it returns one suggestion without modifying saved FAQs. Existing answer text can be rewritten without indexed knowledge. Both use the configured response provider and model, workspace token budget, timeout, and actual usage accounting (`kind: "faq"`). No source access or publication permission is granted by model output.

## Document review and support workflows

Queue a full FAQ review with `{ "kind": "faq_review", "instructions": "Optional topic or style" }` at `/assistance`. It snapshots every chunk of every active, ready, customer-approved document except existing FAQs. Each durable job reads at most eight passages and may create up to three private FAQs. All snapshot passages are visited; this differs from the small selection used by `/faqs/generate`. Saved FAQ drafts and the next job commit in the same transaction as progress. Case-insensitive duplicate questions are skipped. Cancellation stops further saves; an in-flight model request may still incur usage. A worker retry resumes from saved progress and cannot duplicate committed drafts. If source revisions or permissions change, cancel the old run and start a fresh one. New documents require a new run.

For ticket workflows, POST `{ "kind": "triage|research|response|escalation|article", "conversationId": "...", "instructions": "Optional focus" }`. Use the literal kind, not the pipe-separated list. All workflows require staff sessions; article creation additionally requires an administrator and a resolved conversation. List history with `GET /assistance?conversationId=...`; without a conversation, the list contains FAQ reviews. Responses include status, progress, errors, and completed drafts with citations, missing information, and source coverage. The web app polls this endpoint while work is pending.

Research, triage, escalation, and article drafting search all ready indexed sources in the workspace, including staff-only material, using keyword/vector retrieval with up to 24 passages balanced across sources. This searches the indexed library; it does not fetch unimported vendor content or read every passage as the FAQ agent does. Customer response drafting excludes private notes and staff-only sources. Ticket history is preserved in full up to a 100 KB input limit; larger histories fail explicitly instead of silently omitting messages. Model outputs have closed schemas and must cite supplied knowledge or conversation evidence. No workflow invokes business actions.

`/compose` accepts `{ "body": "Reviewed text" }`, checks that the conversation and source access are still current, and returns `{ body, internal }`. It never sends a message. Staff explicitly send through the existing message/note endpoints. `/apply` accepts `{ "title": "Reviewed title", "body": "Reviewed content", "priority": "low|normal|high|urgent", "category": "Reviewed category" }`. For triage it updates local priority/category and queues the priority change for Zendesk-owned tickets. For an article it creates a staff-only `article` source and queues indexing; customer approval and publication remain separate source/document operations. Apply is idempotent per task and rejects changed conversation revisions or revoked evidence. User-supplied titles and text remain subject to ordinary size limits. Escalation outputs can be copied with citations or put into an internal-note draft; no engineering issue is filed automatically.

The `/customer-support` shortcut is local to Navigated Support's staff conversation composer. These internal workflows are not exposed through customer-scoped SDK, CLI, widget, or MCP credentials.

## Visual agent workflow API

See the [workflow guide](workflows.md) for step types and runtime behavior. `GET /workflow` returns `draft`, optimistic `revision`, `publishedVersion` (null for the built-in flow), `problems`, version metadata, and workspace-scoped resource metadata. `PUT /workflow` accepts `{ "revision": 0, "definition": { ... } }`; definitions have `format: 1`, `title`, `nodes`, and `edges`. Each node has `id`, `type`, `title`, canvas coordinates `x`/`y`, and closed typed `data`; each edge has `from`, `port`, and `to`. The exact shared schema is `packages/platform/src/workflow-definition.ts`.

Publish with `{ "revision": 1 }`. Both saving and publishing increment the draft revision; use the returned revision for the next mutation. `GET /workflow/versions/1` returns the immutable definition and timestamp. To restore it, save that definition as the current draft and publish a new version.

`POST /workflow/test` accepts `{ "definition": { ... }, "question": "...", "contactId": "optional-existing-verified-contact", "channel": "portal" }` (channel may also be `widget` or `zendesk`). It returns `answer`, `intent`, `citations`, an optional proposed `action`, step `trace`, and `actionsExecuted: false`. Model and embedding calls are charged through normal usage accounting; selected account lookups are read-only. `/agent/test` follows the published graph as an anonymous preview when one exists. Editing, publishing, and previews require an owner/admin session; customer and service credentials cannot configure workflows. `agent.step` events identify the node, operation, and pinned workflow version.

## SDK

`packages/sdk/src/index.ts` is a server-side TypeScript client. Keep its service token on your trusted server. `identify` asserts ownership, so call it only from your authenticated account system; never expose it as a model tool.

```ts
import { FieldKitClient } from "./packages/sdk/src/index.js";
const client = new FieldKitClient({
  url: process.env.FIELDKIT_URL!,
  workspaceId: process.env.FIELDKIT_WORKSPACE!,
  token: process.env.FIELDKIT_TOKEN!,
  customerId: authenticatedUser.id,
});
await client.identify({
  externalCustomerId: authenticatedUser.id,
  name: authenticatedUser.name,
});
const ticket = await client.request({
  externalCustomerId: authenticatedUser.id,
  body: "I need help with my order.",
  requestKey: crypto.randomUUID(),
});
const state = await client.status(ticket.id);
```

Use stable request keys when retrying the same submission. Reusing a key with different content returns a conflict. A request creates a persisted conversation and queues the agent; it does not return a completed action. Poll status or consume the authorized conversation event stream. A customer-bound SDK instance filters status to that fixed external identity.

## CLI and MCP

Set `FIELDKIT_URL`, `FIELDKIT_WORKSPACE`, and `FIELDKIT_TOKEN`, then:

```sh
npm run fieldkit -- identify YOUR_CUSTOMER_ID 'Customer name'
npm run fieldkit -- request YOUR_CUSTOMER_ID 'My support question'
npm run fieldkit -- status CONVERSATION_ID
```

Run `npm run mcp` as a stdio server with those variables plus `FIELDKIT_CUSTOMER` fixed by the trusted MCP host. It exposes exactly `request_support` and `support_status`. The model cannot choose a different customer, create mappings, approve actions, or directly execute tools. Approvals stay in the authenticated staff interface/API. Do not give a customer-facing model the installation `.env`, database credentials, a staff session, or an unrestricted CLI environment.

### Reusable components and reply templates

See [component contracts and examples](workflow-components.md). `POST /workflow/components` takes `{ "revision": 0, "definition": { ... } }`; updating `/:id` uses the last returned revision. Definitions are `kind: "code"` (Python/JavaScript), `"api"` (fixed `public_get` or existing `customer_action`), or `"subflow"` (an editable workflow). All have a name, description, closed input/output JSON schemas, and `customerSafe` (default false). Code additionally has `language` and `code`; API has `source`, `endpoint` or `actionId`; subflows have `workflow`. Tests take `{ "definition": { ... }, "input": { ... }, "contactId": "optional-verified-contact" }` and return output and trace. The optional runner is required only for code.

Custom/subflow nodes reference `componentId`, immutable `version`, and `inputs`, keyed by schema field: `{ "type": "path", "path": "customer.id" }` or `{ "type": "value", "value": 40 }`. A Return node has `outcome: "done" | "failed"` and `outputs` using the same mapping format. Compiled `task`/`scope` nodes and their execution metadata are server-only and rejected in editor definitions. Reply nodes select `content: "agent" | "exact" | "template"` and `text`; value conditions use `field: "value"`, a variable `path`, comparison `operator`, and a string `value` parsed as JSON when applicable. Existing format-1 graphs receive default AI reply behavior.

## Test Lab, gaps, feedback, and analytics

All paths below are relative to `/v2/workspaces/:workspaceId` and use the existing session authorization. They share the Zod contracts in `packages/platform/src/quality-contracts.ts`.

| Resource                                         | Methods                                        | Access                                                   |
| ------------------------------------------------ | ---------------------------------------------- | -------------------------------------------------------- |
| `/evaluation/suites`                             | GET, POST                                      | Staff read; owner/admin create                           |
| `/evaluation/suites/:id`                         | PUT (name, revision, cases)                    | Owner/admin; optimistic revision                         |
| `/evaluation/runs`                               | GET, POST (suiteId, tokenCap, variants, judge) | Staff read; owner/admin launch                           |
| `/quality/jobs/:id`                              | GET, PATCH (cancel/retry)                      | Staff read; owner/admin control                          |
| `/evaluation/runs/:id/results/:resultId/reviews` | POST (verdict, note)                           | Staff; append-only review history                        |
| `/conversations/:id/test-case`                   | GET                                            | Staff; returns an unsaved draft excluding internal notes |
| `/conversations/:id/gap`                         | POST                                           | Staff flag; deduplicated                                 |
| `/conversations/:id/feedback`                    | GET, PUT                                       | Own conversation; only customer/visitor can submit       |
| `/knowledge/gaps` and `/knowledge/gaps/:id`      | GET                                            | Staff                                                    |
| `/knowledge/gaps/:id`                            | PATCH (status, reason)                         | Staff; closing requires a reason                         |
| `/knowledge/gaps/:id/merge`                      | POST (targetId)                                | Staff                                                    |
| `/knowledge/gaps/:id/case`                       | GET                                            | Staff; draft regression case                             |
| `/knowledge/gaps/:id/draft`                      | POST                                           | Owner/admin; creates a private FAQ draft                 |
| `/knowledge/analysis`                            | GET, POST (tokenCap, optional gapIds)          | Staff read; owner/admin launch                           |
| `/knowledge/gap-scan`                            | POST (days 1–365, limit 1–500)                 | Owner/admin; no model calls                              |
| `/quality/settings`                              | GET, PUT (nightly, dailyTokenCap)              | Staff read; owner write                                  |
| `/analytics?from=ISO&to=ISO&channel=portal`      | GET                                            | Staff; default 30 days, max 366 days                     |
| `/quality/events?after=eventId`                  | GET SSE                                        | Staff; permissions rechecked while streaming             |

A case has an ID, name, up to ten ordered `{question, expected}` turns, channel, and fixtures. Expected checks can require an intent, visited node IDs, source IDs, exact action name/parameters, approval requirement, and a reference answer. Imported cases retain their source conversation ID and require `personalDataReviewed: true` before saving.

Runs accept one or two variants, each with a name and optional workflow `definition`, response `model`, and `provider`. An enabled judge defaults to the workspace response model; it may have its own connected provider/model. `tokenCap` is mandatory (1,000–10,000,000). Reservations for response, retrieval embedding, and judging calls share the same cap and workspace budget. A retry needs `{action:"retry", acknowledgeRetry:true}` and may increase the total cap. Completed turns are reused. Unresolved reservations remain visible; acknowledgement does not clear usage.

Feedback input is `{messageId, resolved, rating: "good" | "bad" | null, comment}`. The message must be a delivered AI reply belonging to the caller's conversation. Updates replace its current rating while preserving its history; a later customer message prevents an old answer from confirming resolution. Zendesk ratings are read-only imports and never become native resolution confirmations.

### Inbox presentation metadata

`GET /v2/workspaces/:ws/conversations` returns the latest 200 accessible conversations, with `channel_kind`, `last_message` (up to 240 characters from the latest customer/assistant/staff message), and `last_message_role`. Private notes and system messages are excluded from previews for every role. `approval_expires_at` contains the pending approval expiry for staff, otherwise `null`; an invalidated approval has no pending expiry. Existing workspace/customer access checks apply.

The staff-only approval objects in conversation detail include `action_name` and `action_kind` for readable review cards. These display fields do not change the signed proposal, approval hash, permission requirements, or execution checks.

### Channel workflows and customer correspondence

`GET/PUT /v2/workspaces/:ws/workflow` and `POST .../workflow/publish` accept `?channel=default|portal|widget|zendesk` (default: `default`). Each profile has its own optimistic draft revision; `inheritedVersion` identifies a fallback publication. Existing version endpoints use workspace-unique version numbers.

`POST .../conversations/:id/status` accepts `{ "status": "open" | "resolved" }` from the owning customer/visitor only, for native conversations. It preserves takeover and invalidates pending work. The first feedback write requires a resolved conversation and its latest delivered assistant/staff reply. Native feedback can be sent once per conversation: an identical retry returns the existing row; any changed or additional submission returns 409. Negative resolution feedback reopens native conversations while preserving agent/human mode; linked Zendesk ticket state remains authoritative. Conversation detail includes feedback summaries (resolution, rating, comment, source, timestamps) behind its existing access checks. Staff-only list metadata includes feedback counts and the latest resolution/rating. Public message reads exclude internal and undelivered replies.

First-party portal requests use `X-Fieldkit-Audience: customer` with the verified session to act as that user's workspace contact, including when the user is also staff. It can only reduce privileges and requires a prior `/v2/public/:slug/join`. Widget credentials are channel-bound; anonymous portal sessions are no longer issued. Public portal configuration includes `chatEnabled` and `emailReplies`; `/join` includes the verified account email and portal channel ID.

Administrators use `GET/PUT/DELETE .../ticket-email` for inbound configuration and recent delivery/rejection status. PUT accepts `{ "address": "support@inbound.example.com" }`, replaces credentials, revokes prior reply addresses, and returns the webhook password once. `POST .../ticket-email/:id/retry` explicitly retries an unknown/failed SMTP attempt. Staff conversation details include `emailDeliveries` and `inboundEmails`; customers cannot read these operational records.

`POST /v2/webhooks/email/:workspaceId` accepts Postmark inbound JSON with HTTP Basic Auth. Authenticate before parsing; body limit 256 KiB. See [email setup](customer-support.md) for required fields, ownership, deduplication, and limitations.

### Support availability

`PUT /v2/workspaces/:workspaceId/support-options` accepts `{ "mode": "both" | "tickets" | "chat" | "none" }` and requires the owner role. It atomically sets new-ticket availability on the portal and publication of the widget, preserving channel origins and handoff settings. Enabling chat runs the normal publication readiness checks. The help center publication toggle remains separate. `GET /v2/public/:slug` returns `ticketsEnabled` and `chatEnabled`; disabled tickets are rejected at conversation creation even with an existing customer session. Existing tickets can still receive replies. Disabling chat revokes widget credentials and pauses its automated conversations using the normal unpublish behavior. No database migration is needed; existing portal settings default to allowing tickets.

## Customer directory and grouped staff inbox

All of these resources require a current staff session in the workspace. Customers, widget visitors, and service credentials cannot read them.

| Resource under `/v2/workspaces/:workspaceId` | Method | Behavior                                                                                                  |
| -------------------------------------------- | ------ | --------------------------------------------------------------------------------------------------------- |
| `/inbox`                                     | GET    | Full retained inbox, filtered and paginated; defaults to customer grouping.                               |
| `/customers`                                 | GET    | Searchable customer directory with open/total conversation counts.                                        |
| `/customers/:id`                             | GET    | Identity, reviewed mappings, and customer support totals.                                                 |
| `/customers/:id/conversations`               | GET    | Paginated support history; same filters as the inbox, scoped to this customer.                            |
| `/customers/:id/notes`                       | GET    | Paginated private customer notes plus internal notes from their conversations.                            |
| `/customers/:id/notes`                       | POST   | Add `{body, requestKey}`; exact retries return the same note. No customer message or workflow is created. |

Inbox queries accept `section=all|open|unread|read|closed` (API default `all`; inbox UI default `open`), `type=all|ticket|chat`, `group=customer|conversation`, `state=all|human|approval|agent|resolved`, `assignee=all|unassigned|<staff ID>`, `q`, optional `contactId`, and one-based `page`. The page size is 40. Grouping happens before pagination; results include `total` (groups or rows), `conversation_total`, counts by status, and grouped customer counts. Ticket type includes Zendesk; chat type follows the widget channel even after handoff. Search matches name, email, or conversation subject, without treating percent signs as wildcards.

The customer directory accepts `q`, `kind=all|verified|visitor`, and `page`; notes accept `page`. Existing `/contacts/:id/mapping` remains the owner/admin-only identity mapping operation. New profile notes are staff-only audit events, are excluded from knowledge retrieval and customer message APIs, and follow the workspace retention period. Deleting a conversation removes its internal-note evidence; customer-wide notes remain until retention or deletion of the customer/workspace. Schema 12 adds only the notes table and query indexes.

### Personal inbox read state

Schema 13 adds a monotonic message sequence and per-staff `conversation_reads` markers. Staff conversation detail includes `read_state: {cursor, unread}`. `PUT /conversations/:id/read` accepts `{read: true, cursor}` from that loaded snapshot or `{read: false}`. Only customer messages advance the read cursor. An older acknowledgement cannot hide newer customer messages; marking unread does not change conversation status, revision, ordering, agent activity, or delivery. Read markers cascade on conversation or membership deletion.

Inbox results include `unread`, `group_unread`, and `section_counts` (conversation counts after type/search/assignee filters, before the section/status filter). Open contains every unresolved conversation; Unread and Read subdivide Open for the current staff member. Closed contains resolved conversations regardless of read state. All includes both. Customer history still defaults to all conversations. The staff-only API never exposes another person's read markers.

`GET /connections` includes `googleSetup` with boolean configuration checks, the local origin, and OAuth callback URL. No keys or client secrets are included. Google OAuth availability in this response requires both OAuth credentials and Picker configuration.

## Operational controls (additive v2 resources)

All paths below are relative to `/v2/workspaces/:workspace`. Staff sessions derive
workspace permissions server-side. Customer/visitor credentials cannot access
readiness, SLA, or shadow resources. JSON contracts live in the corresponding
`packages/platform/src/{readiness,attachment,sla,shadow}-contracts.ts` modules.
See the [operational controls guide](operational-controls.md) for effect boundaries,
retention, defaults and uncertainty handling.

| Resource                                | Methods and purpose                                                                   |
| --------------------------------------- | ------------------------------------------------------------------------------------- |
| `/readiness`                            | `GET` staff dashboard with cached evidence                                            |
| `/readiness/summary`                    | `GET` sanitized summary, also accessible with a `diagnostics:read` service credential |
| `/readiness/runs`                       | `POST` explicitly authorized diagnostic with an idempotent request key                |
| `/readiness/runs/:id`                   | `PATCH` cancel, retry eligible work, or reconcile the original uncertain operation    |
| `/readiness/checks/:check`              | `GET` evidence history; URL-encode the check identifier                               |
| `/readiness/checks/:check/attestations` | `POST` attributable manual evidence; never bypasses hard checks                       |
| `/readiness/settings`                   | `PUT` owner-only future strict-publication setting                                    |
| `/attachments/settings`                 | `GET` limits/admission settings; owner-only `PUT` enable/anonymous choices            |
| `/attachments`                          | `POST` reserve a file for the authorized channel, conversation and visibility         |
| `/attachments/:id`                      | `GET` authorized file status; `PATCH` retry, cancel or delete                         |
| `/attachments/:id/content`              | `PUT` bounded raw bytes; authenticated `GET` download, or staff-only `?preview=true`  |
| `/sla`                                  | `GET` deadlines and the current staff member's notifications                          |
| `/sla/policy`                           | `GET` current policy; owner/admin `PUT` optimistic versioned save                     |
| `/sla/preview`                          | `POST` deterministic business-time deadline calculation                               |
| `/sla/recalculate`                      | `POST` bounded preview, followed by explicit application of its exact preview hash    |
| `/sla/notifications/:id/read`           | `POST` mark the current staff member's notification read                              |
| `/conversations/:id/sla`                | `GET` staff-only timer history                                                        |
| `/conversations/:id/waiting`            | `PUT` staff-controlled waiting, with separate reminder consent                        |
| `/shadow`                               | `GET` immutable candidates, experiments and rollout summaries                         |
| `/shadow/candidates`                    | owner/admin `POST` snapshot a reviewed saved workflow; never publishes                |
| `/shadow/experiments`                   | owner/admin `POST` explicitly budgeted future sampling                                |
| `/shadow/experiments/:id`               | staff `GET` results; owner/admin `PATCH` stop or explicitly retry unfinished work     |
| `/shadow/results/:id/review`            | staff `POST` review retained alongside original rules and AI results                  |
| `/shadow/results/:id/case`              | `GET` a review-required Test Lab import                                               |
| `/rollouts`                             | owner/admin `POST` separately authorize eligible future customer traffic              |
| `/rollouts/:id`                         | owner/admin `PATCH` stop, increase future traffic or use normal workflow publication  |

`/readiness/events`, `/sla/events`, and `/shadow/events` provide session-authenticated
staff SSE progress. Ordinary conversation streams expose only customer-safe file
status/message updates; they exclude diagnostic, comparison, policy and notification
payloads. Files are passed to the existing message APIs by `attachments` (an array of reserved file IDs); the
server revalidates exact uploader, customer, workspace and private/public scope.
Downloads are private and non-cacheable. No public storage URLs are issued.

Diagnostic/canary effectful requests require explicit authorization in addition to
roles. Checks and model usage are queued transactionally. A repeated request key
with changed parameters is a conflict, not permission for another effect. The
existing SDK/CLI/MCP execution and approval boundaries are unchanged.
