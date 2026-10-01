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
