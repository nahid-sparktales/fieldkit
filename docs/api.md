# API and client interfaces

All resource endpoints live under `/v2`. Better Auth uses `/api/auth`. Staff and portal users use verified session cookies. Cookie-authenticated mutations require the installation's exact Origin. Service/widget credentials use `Authorization: Bearer …`. Resource IDs and widget slugs never grant administrative access.

The base for authenticated resources is `/v2/workspaces/:workspaceId`. These are the primary routes; inspect `apps/api/server.ts` for input validation and the complete contract.

| Route suffix | Methods | Access and purpose |
| --- | --- | --- |
| empty | GET | Workspace settings, channels, usage |
| `/settings` | PUT | Admin settings |
| `/members`, `/invitations` | GET / POST | Staff list / admin invitations |
| `/contacts`, `/contacts/:id/mapping` | GET / PUT | Staff identities / reviewed admin mapping |
| `/agent/test` | POST | Admin answer preview with no account actions |
| `/conversations` | GET, POST | Staff inbox or own customer tickets |
| `/conversations/:id` | GET, DELETE | Authorized history; admin deletion guards unresolved operations |
| `/conversations/:id/messages` | POST | Customer message or staff reply; `body`, unique `requestKey` |
| `/conversations/:id/notes` | POST | Staff-only internal note |
| `/conversations/:id/control` | POST | Staff takeover/resume, assignment, status, Zendesk tags/assignee |
| `/conversations/:id/events` | GET | SSE with repeated authorization checks |
| `/sources` | GET | Staff knowledge library |
| `/sources`, `/sources/upload` | POST | Admin selected import / multipart file upload |
| `/sources/:id/refresh` | POST | Admin asynchronous refresh |
| `/sources/:id/visibility` | PUT | Admin customer-answer approval |
| `/documents/:id/publish` | PUT | Separate public article publication |
| `/sources/:id` | DELETE | Admin source removal |
| `/faqs` | GET / POST | Staff FAQ library / admin private draft creation |
| `/faqs/:id` | PUT / DELETE | Admin edit with revision / remove FAQ |
| `/faqs/:id/approve` | POST | Admin approval of the exact revision; queues indexing |
| `/faqs/generate` | POST | Admin AI generation of private drafts from approved knowledge |
| `/assistance` | GET / POST | Staff workflow history / queue a workflow; FAQ review and article creation require admin |
| `/assistance/:id/cancel` | POST | Cancel queued or running work; already-created drafts stay private |
| `/assistance/:id/retry` | POST | Retry a failed workflow from its saved progress |
| `/assistance/:id/compose` | POST | Revalidate a reply/report and return text for the staff composer; does not send |
| `/assistance/:id/apply` | POST | Apply reviewed triage or save a reviewed private article |
| `/faqs/assist` | POST | Admin AI suggestion for the editor; does not save or publish |
| `/connections` | GET | Admin metadata, no stored secrets |
| `/connections/key` | POST | Validated key connection |
| `/connections/:provider/oauth` | POST | Session-bound OAuth start |
| `/connections/:provider` | DELETE | Disconnect and invalidate affected knowledge |
| `/actions`, `/actions/:id` | GET, POST / PUT | Staff list / owner definitions and policies |
| `/approvals/:id/decision` | POST | Owner/admin exact-hash approve/reject |
| `/operations`, `/operations/jobs` | GET | Audit/recovery views |
| `/operations/:id/reconcile`, `/jobs/:id/retry` | POST | Admin bounded recovery, no bypass |
| `/identity-key` | POST | Owner widget identity-key rotation |
| `/credentials`, `/credentials/:id` | GET, POST / DELETE | Owner scoped service-token issue/list/revoke |
| `/identities` | POST | Trusted service establishes existing website customer identity |
| `/requests`, `/requests/:id`, `/requests/:id/messages` | POST / GET / POST | Scoped service support request/status |

Public routes under `/v2/public/:slug` expose only published configuration and articles. `/join` binds a verified portal account. `/widget/session` creates an anonymous or server-signed customer token for a published widget. Exact allowed origins are checked. `/v2/webhooks/zendesk/:workspaceId` accepts only provider-signed events. OAuth callbacks are `/v2/oauth/:provider/callback`.

## Documentation site imports

Create a source with `{"kind":"website","scope":"site","title":"Product docs","locator":"https://docs.example.com/"}`. Omit `scope` or use `"page"` to import only one page. In the app, choose **Knowledge → Documentation site**. Use the documentation root to include the whole site, or a section URL to restrict the scan to that path.

The worker discovers pages from sitemaps (including sitemap indexes and robots.txt declarations) and internal links. It stays on the exact HTTPS origin and under the selected path, honors robots.txt and noindex, and never executes page scripts. Public, server-rendered pages are supported; login-protected or JavaScript-only content needs another import method. Query strings, fragments, and trailing slashes are treated as aliases. Crawls are bounded to 500 discovered pages, 25 sitemaps, 2 MB per response, 50 MB per scan, five million extracted characters, and five minutes of crawling. A limit or transient provider failure is an explicit failed import, not a successful partial index.

`sources.metadata.crawl` reports discovery, scanning, indexing, and skipped-page reasons. Each page has its own document, URL (`documents.locator` and citation `url`), version, preview, and publication control. Unchanged pages reuse embeddings. Hourly/manual refresh removes unavailable or no-longer-discovered pages from retrieval and unpublishes them; a failed import disables the source's evidence until a successful refresh. New content stays within the source's selected audience, and publishing articles remains an explicit per-page action.

## FAQs

FAQs are workspace-scoped knowledge sources (`kind: "faq"`). Create one with `{ "question": "How do I get help?", "answer": "Open a ticket in the help center." }`. It starts in `draft` with staff-only visibility and requires no model call. Edits also include the current `revision`; conflicting saves return 409. Editing immediately deactivates/unpublishes the old document and resets the FAQ to a private draft.

Approve with `{ "revision": 1 }` at `/faqs/:id/approve`. Approval requires a connected model for embedding and queues indexing in the same transaction. Once ready, the agent can cite the FAQ. Public help-center publication remains a separate `/documents/:id/publish` action. Draft FAQs are excluded from hourly ingestion and cannot be retrieved by customers.

AI generation accepts `{ "count": 5, "instructions": "Focus on onboarding", "sourceId": "optional-approved-source-id" }` (1–8 FAQs). It uses a bounded selection of current customer-approved chunks, validates returned citations, rechecks source access, and saves private drafts only. `/faqs/assist` accepts `question`, optional `answer`, optional `instructions`, and optional `sourceId`; it returns one suggestion without modifying saved FAQs. Existing answer text can be rewritten without indexed knowledge. Both use the configured OpenAI model, workspace token budget, timeout, and actual usage accounting (`kind: "faq"`). No source access or publication permission is granted by model output.

## Document review and support workflows

Queue a full FAQ review with `{ "kind": "faq_review", "instructions": "Optional topic or style" }` at `/assistance`. It snapshots every chunk of every active, ready, customer-approved document except existing FAQs. Each durable job reads at most eight passages and may create up to three private FAQs. All snapshot passages are visited; this differs from the small selection used by `/faqs/generate`. Saved FAQ drafts and the next job commit in the same transaction as progress. Case-insensitive duplicate questions are skipped. Cancellation stops further saves; an in-flight model request may still incur usage. A worker retry resumes from saved progress and cannot duplicate committed drafts. If source revisions or permissions change, cancel the old run and start a fresh one. New documents require a new run.

For ticket workflows, POST `{ "kind": "triage|research|response|escalation|article", "conversationId": "...", "instructions": "Optional focus" }`. Use the literal kind, not the pipe-separated list. All workflows require staff sessions; article creation additionally requires an administrator and a resolved conversation. List history with `GET /assistance?conversationId=...`; without a conversation, the list contains FAQ reviews. Responses include status, progress, errors, and completed drafts with citations, missing information, and source coverage. The web app polls this endpoint while work is pending.

Research, triage, escalation, and article drafting search all ready indexed sources in the workspace, including staff-only material, using keyword/vector retrieval with up to 24 passages balanced across sources. This searches the indexed library; it does not fetch unimported vendor content or read every passage as the FAQ agent does. Customer response drafting excludes private notes and staff-only sources. Ticket history is preserved in full up to a 100 KB input limit; larger histories fail explicitly instead of silently omitting messages. Model outputs have closed schemas and must cite supplied knowledge or conversation evidence. No workflow invokes business actions.

`/compose` accepts `{ "body": "Reviewed text" }`, checks that the conversation and source access are still current, and returns `{ body, internal }`. It never sends a message. Staff explicitly send through the existing message/note endpoints. `/apply` accepts `{ "title": "Reviewed title", "body": "Reviewed content", "priority": "low|normal|high|urgent", "category": "Reviewed category" }`. For triage it updates local priority/category and queues the priority change for Zendesk-owned tickets. For an article it creates a staff-only `article` source and queues indexing; customer approval and publication remain separate source/document operations. Apply is idempotent per task and rejects changed conversation revisions or revoked evidence. User-supplied titles and text remain subject to ordinary size limits. Escalation outputs can be copied with citations or put into an internal-note draft; no engineering issue is filed automatically.

The `/customer-support` shortcut is local to FieldKit's staff conversation composer. These internal workflows are not exposed through customer-scoped SDK, CLI, widget, or MCP credentials.

## SDK

`packages/sdk/src/index.ts` is a server-side TypeScript client. Keep its service token on your trusted server. `identify` asserts ownership, so call it only from your authenticated account system; never expose it as a model tool.

```ts
import { FieldKitClient } from './packages/sdk/src/index.js';
const client = new FieldKitClient({
  url: process.env.FIELDKIT_URL!,
  workspaceId: process.env.FIELDKIT_WORKSPACE!,
  token: process.env.FIELDKIT_TOKEN!,
  customerId: authenticatedUser.id,
});
await client.identify({ externalCustomerId: authenticatedUser.id, name: authenticatedUser.name });
const ticket = await client.request({
  externalCustomerId: authenticatedUser.id,
  body: 'I need help with my order.',
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
