# Architecture and change points

FieldKit augments existing customer operations. The reference support workspace is one client of the same services used by integrations, the CLI, SDK, MCP and evaluation harness.

## Boundaries

`packages/core` imports no LangGraph code. `types.ts` validates versioned configuration and normalized intake; `store.ts` owns tenant-scoped canonical access; `services.ts` owns triage, evidence, policy, approvals, financial-operation identity, reconciliation and responses. Narrow support operations are injected through `SupportPort`. The externally useful, fuller `SupportAdapter` contract lives in `packages/integrations`.

`support-graph.ts` wraps those services in explicit nodes and trusted conditional edges. `runtime.ts` owns the compiled graph, checkpointer, durable execution-request queue and loopback-demo runner. The queue chooses which stored run to advance; it does not choose workflow steps. LangGraph chooses and checkpoints those steps.

`connectors/adapters.ts` maps raw Acme records, Northstar customer/bill keys, Globex organization/documents, Confluence-style pages and enterprise knowledge documents into canonical values. No provider-specific data rules appear in the graph. Support adapters independently normalize Jira issues, Zendesk tickets and chatbot conversations. Original provider fields are retained with each external ticket.

## Data ownership

| Store | Authoritative content |
|---|---|
| `application.sqlite / records` | Configurations, accounts, subscriptions, invoices, proposals via runs, approvals, operations, receipts, normalized tickets and knowledge |
| `application.sqlite / runs` | Business lifecycle, input, provenance snapshots, counters, server-generated thread mapping |
| `application.sqlite / events` | Append-only, ordered business/graph events with tenant/run IDs and invocation correlation |
| `application.sqlite / jobs` | Durable initial/resume requests with revision-based completion |
| `application.sqlite / reservations` | One correction operation per tenant/resource/action |
| `application.sqlite / upstream` | Simulated upstream effects, committed separately from the calling operation receipt |
| `application.sqlite / external_*` | Original support records and idempotent update receipts |
| `application.sqlite / deliveries` | Signed-event outbox and delivery attempts |
| `checkpoints.sqlite` | LangGraph resumable state, pending writes, interrupts and checkpoint history |

Records use integer minor units and explicit currency. No conversion occurs. Tenant IDs are bound to server-owned sessions at API boundaries; every canonical lookup includes tenant scope. Raw fixture snapshots remain internal and are removed from API exports. Evaluation answer labels never enter graph state, evidence or proposal services.

## Typical flow

An intake POST validates a bounded payload, binds the requester, persists a run, ticket and execution request, then returns an ID. The runner loads checkpoints independently of the browser. Evidence and policy can stop the action, answer safely, or request an immutable approval. A recorded manager decision transactionally schedules resumption. Revalidation checks the exact proposal, current records and external ticket revision. Execution reserves the resource, commits the mock upstream effect, then records or reconciles a receipt. Ticket bookkeeping, response persistence and original-provider updates are separate nodes.

Browser updates poll ordered stored records. Reconnecting retrieves events after an ID; it never re-submits the ticket. The page is not the worker.

## Where to change behavior

- Customer schemas: `connectors/src/adapters.ts` and the matching customer fixtures.
- Policy or money gates: `core/src/services.ts`, with a regression case.
- Graph branching/interrupt shape: `workflows/src/support-graph.ts`; increment the graph version for incompatible semantics.
- Provider normalization/status mappings: `integrations/src/support.ts` and `customers/*/support.json`.
- Customer readiness checks: `core/src/discovery.ts` and `evals/src/harness.ts`.
- A future tested live proposal adapter: replace only triage/proposal behavior. Policy, approval and connector paths remain shared.

The compact layout deliberately avoids separate services, a distributed scheduler, a supervisor agent, mandatory vector storage, or a custom workflow editor. The synchronous SQLite single-runner ceiling is documented; a multi-host product would require a different coordination and provider-authentication design.
