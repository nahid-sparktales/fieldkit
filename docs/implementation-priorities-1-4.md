# Implementation map: operational controls

Starting point: `0f23512d08c833a3e63d2de854c940e4fb99faf3` on `main`, clean
working tree. Schema version 13. Node 24+ target (local verification: Node 25.5.0),
PostgreSQL/pgvector, pg-boss 12,
LangGraph 1.4, React 19. No additional queue or orchestration service.

## Reused boundaries

| Concern                                                  | Implementation                                                         |
| -------------------------------------------------------- | ---------------------------------------------------------------------- |
| Session, staff role, customer and conversation access    | `packages/platform/src/auth.ts`, API principal and origin checks       |
| Transactional jobs, migrations, audit events             | `db.ts`, `platform.ts`, `apps/worker/main.ts`                          |
| Immutable versions and channel inheritance               | `workflows.ts`, `channel-workflows.ts`, workflow compiler              |
| Evaluation and bounded model calls                       | `quality.ts`, `evaluation-context.ts`, `model.ts`, `usage-context.ts`  |
| Exact approvals, takeover, operation recovery            | `agent.ts`, `actions.ts`, `support.ts`                                 |
| Delivered public messages and inbound reply capabilities | `support.ts`, `ticket-email.ts`, `customer-support-schema.ts`          |
| Retention and contact deletion                           | `platform.ts`, `customers.ts`                                          |
| UI request/action state                                  | `apps/web/src/request.ts`, `useAction.ts`, quality pages               |
| Isolated verification                                    | `tests/helpers.ts`, `tests/browser-server.ts`, `scripts/store-sandbox` |

## Delivery order

1. Readiness contracts, evidence history, check registry and durable worker; APIs
   and screen. Additive migration after version 13.
2. Attachment admission, private staging, real ClamAV adapter, message binding,
   inbound email and authenticated file UI. Additive schema and optional scanner.
3. Versioned SLA policies, timezone calendar, obligations and durable notifications;
   operator editor and inbox indicators.
4. Immutable shadow experiments, fixture evidence, explicit canary effect authority,
   kill switch, review UI and regression cases.
5. Cross-feature retention, diagnostics, documentation and isolated journeys.

## Decisions and invariants

- New capabilities default off; no paid checks, historical enrollment or automation
  during migrations. No live environment migration, email, provider write or model
  call is part of local verification.
- Diagnostic health, evidence level and capability scope stay separate. Secrets
  are hashed into fingerprints server-side; neither credentials nor raw provider
  responses enter evidence. History remains when configuration becomes stale.
- Files remain inaccessible until admission and a current scanner result succeed.
  Their contents never enter AI or knowledge automatically. File visibility and
  AI eligibility are separate concepts; eligibility starts false.
- SLA response measurements use recorded delivered public messages, never draft,
  queue or model completion timestamps. UTC deadlines bind to a frozen calendar.
- Shadow evaluation has no production effect adapters. Canary authority supplements
  existing conversation, workflow and policy checks rather than bypassing them.
- Unknown external effects stay uncertain and require reconciliation; a durable
  queue does not provide exactly-once external delivery.
- All feature evidence is staff-only. Customer events exclude diagnostics, shadow
  transcripts, private notes and file storage paths.
- Existing publication behavior is preserved unless an operator enables a new
  capability or explicitly chooses strict readiness for future publication.
- The inbox queue is a full-width list below the reader. On desktop its rows grow
  with the page instead of competing for a fixed fraction of the viewport.

Verification uses dedicated databases ending in `_test`, provider doubles and the
explicit sandbox only. Backend and browser suites run sequentially because they
share the disposable database. External verification is reported separately.
