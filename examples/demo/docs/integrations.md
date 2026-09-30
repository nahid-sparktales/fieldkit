# Existing support-stack integration

FieldKit's own UI is a control plane and reference client. Operational requests can enter through REST, the typed SDK, simulated provider webhooks or MCP. There is one policy/approval/billing workflow.

## Offline adapters

| Deployment | Support surface | Account/invoice source | Knowledge source |
|---|---|---|---|
| Acme | Mock Jira Service Management | Salesforce/Stripe-style records | Local article array |
| Northstar | Mock Zendesk | `customer_key`, `bill_key`, `gross_cents`, `settled` | Confluence-style pages, nested versions and body storage |
| Globex | Existing chatbot + generic support API | `OrganizationId`, `DocumentId`, `TotalMinor`, `CaptureState` | Internal document/revision/governance records |
| MessyCorp | Mock Jira + legacy mapping failures | Inconsistent identifiers and unsafe billing capability | Contradictory policies and an expired guide |

These names describe simulated compatibility fixtures, not an authenticated vendor connection. `support.json` records actual capability, permission, identity/status mapping, rate-limit metadata and webhook examples. `SupportAdapter` covers capabilities, getTicket, internal notes, customer replies and status changes. Assignment and tags are optional and deliberately unavailable; their absence is surfaced, not silently emulated. Configured mock rate limits are metadata; live network rate limiting is not claimed.

Jira fixtures use `key`, nested `fields.status.name`, reporter IDs, a custom account field and `jsdPublic` comments. Zendesk uses integer ticket/requester/organization IDs, status strings, tag/custom-field arrays and `public` comments. Chatbot/native fixtures use conversation IDs, authenticated customer references and message arrays. Native fields are retained for audit and round trips.

## Authentication

The server binds to loopback and accepts only loopback hosts. Browser requests use an HttpOnly, SameSite=Strict demo session cookie. API/SDK/MCP clients use a bearer session token. Cross-origin requests are rejected; JSON schemas are strict and body/history lengths are bounded.

For this local demonstration only, create a session with:

```sh
curl http://localhost:4317/api/session \
  -H 'Content-Type: application/json' \
  -d '{"tenant":"acme","persona":"requester"}'
```

Use the returned token as `Authorization: Bearer TOKEN`. A `support_manager` persona can review approvals. Open persona selection is a documented simulation, not authentication assurance. Real hosting would require replacing it before exposure.

## REST and SDK

`POST /v1/requests` accepts the version-1 `FieldKitRequestSchema`. Trusted-context assertions must match the authenticated session; putting tenant/account/role claims in text grants no authority. Recent history is limited to six messages of at most 2,000 characters, with a 4,000-character current message. Extra fields are rejected. The request returns `202`, a run ID and status URL, without keeping the connection open for approval.

```ts
import { FieldKitClient } from './packages/sdk/src/index.js';
const client = new FieldKitClient('http://localhost:4317', process.env.FIELDKIT_TOKEN!);
const result = await client.resolve({
  schemaVersion: 1,
  deploymentId: 'acme',
  idempotencyKey: crypto.randomUUID(),
  external: { conversationId: 'existing-conversation-42', channel: 'existing_chatbot' },
  message: 'Please refund the duplicate charge for both plans.',
  trustedContext: { tenantId: 'acme', authenticatedCustomerId: 'acct-1' }
});
const status = await client.inspect(result.runId);
// Present status.run.response only as its persisted, customer-safe result.
```

`GET /v1/runs/:id` returns an authorized run, safe checkpoint summary and pending approval state. `GET /api/approvals` returns the tenant inbox. `POST /api/approvals/:id/decision` accepts only `{revision, decision}`; it loads the exact proposal server-side and schedules resumption. A caller-supplied role, thread, checkpoint, action argument or decision boolean cannot bypass it.

`POST /api/runs` supports canonical native/API/mock-email/web-chat intake. `GET /api/runs/:id/events?after=ID` returns stable ordered stored events. `GET /api/traces/:id` is inspection; `POST /api/traces/:id/rerun` is isolated execution.

The SDK is a typed HTTP client, not another orchestrator. Only network-failed GETs have a bounded retry; POSTs are not blindly retried. Repeated intake must reuse its idempotency key. A chatbot conversation ID identifies the stored request context; send a new conversation/request identifier for a new operational request.

## Provider-shaped inbound events

The stored `customers/*/support.json` supplies webhook-shaped fixtures. Call:

```text
POST /api/integrations/mock_jira_service_management/webhook
Authorization: Bearer <local-demo-token>
Content-Type: application/json

{"schemaVersion":1,"eventId":"acme-jsm-1","ticketId":"ACME-1042","sequence":1}
```

This offline endpoint reads the provider-native fixture through its adapter. Duplicate IDs return the original run. Reordered sequences do not roll the ticket backward. Conflicting reuse returns a conflict. Unknown external IDs, missing custom account fields, unsupported statuses and missing required capabilities stop safely. A changed external ticket revision makes an approved action stale.

Inbound fixtures use the authenticated local bearer boundary, not real Jira webhook-signature verification. No claim is made about live Atlassian webhook compatibility beyond these explicit simulated shapes.

## Outbound events

Every durable waiting/terminal outcome produces a versioned event with event ID, type, tenant/run correlation, receipt reference and original support reference. Supported types include `run.waiting_for_approval`, `run.completed`, `run.failed`, `run.unknown_outcome`, `run.partial_completion`, `run.rejected` and `run.escalated`.

The default destination is a **local simulated receiver**, not a remote URL. Payload bytes are HMAC-SHA256 signed using a generated server-only key under the ignored data directory. Each attempt has a unique ID, timestamp, signature and HTTP-shaped status. The receiver verifies signatures and deduplicates the event ID. Retry budget is three. Failed acknowledgments can be modeled deterministically in tests; startup also processes pending deliveries.

`GET /api/webhooks` exposes tenant-scoped delivery state, without the signing key. Adding a real HTTP sink is an explicit future integration task: it would need endpoint configuration, timestamp/replay-window handling, delivery scheduling, secret rotation, and an SSRF policy. This demonstration does not send internet webhooks.

## MCP

The installed official MCP SDK is pinned at `@modelcontextprotocol/sdk@1.31.0`. Its stdio transport was tested with an actual SDK client. Run:

```sh
FIELDKIT_URL=http://localhost:4317 FIELDKIT_TOKEN=<session-token> \
  npx tsx packages/mcp/src/server.ts
```

Tools: `resolve_support_request`, `get_run_status`, `get_policy_status`. The resolver requests an allowlisted governed action through normal intake. There is no approve, arbitrary connector call, SQL, thread-edit, cross-tenant search, or force-node tool. MCP cannot create its own session or elevate its role. A manager must decide through the normal application approval path.

## Asynchronous sequence

1. The adapter normalizes the external ticket and verifies account mapping against the host identity.
2. The server stores the provider, ticket/conversation ID, initial native snapshot and revision with the run.
3. A large action updates that same external ticket to internal-approval waiting, then interrupts.
4. Restart preserves both the proposal and external reference.
5. An authorized decision resumes the original thread; current evidence and external revision are checked.
6. A confirmed receipt enables a customer-safe reply, internal note and resolved status on the original ticket.
7. Idempotent support-write keys make partial update recovery safe. Financial execution is not repeated.
