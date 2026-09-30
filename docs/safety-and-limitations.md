# Safety boundaries and limitations

## Threat model

The protected resources are tenant-scoped customer data, refundable balances, immutable approval decisions, canonical receipts and execution history. Untrusted inputs include ticket text, imported knowledge, provider-native fields, HTTP bodies, conversation history, guessed IDs and tool requests from an external agent. The local operator and repository files are trusted for this fictional demonstration. A malicious local OS user who can edit SQLite files is outside the protection boundary.

| Risk | Implemented boundary | Remaining limitation |
|---|---|---|
| Prompt injection | No text-derived role/tenant authority; allowlisted action proposals; deterministic policy | Lexical simulator is intentionally narrow; no LLM robustness claim |
| Cross-tenant lookup | Session-bound tenant on all API/data/trace/approval/SDK/MCP paths | All local demo personas can be selected by the local operator |
| Cross-account request | Fixed authenticated account scope and verified record ownership; failed authorization skips evidence | One authorized fictional account per demo persona |
| Forged approval | Strict request schema, server-loaded role, exact proposal hash/revision, atomic authoritative decision | Demo persona selection is not enterprise IAM; manager identity is simulated |
| Stale authorization | Current config, policy, evidence, balance, expiration and external revision checks | No external identity-provider revocation feed |
| Duplicate refund | Stable operation IDs, canonical receipts, unique resource reservation and reconciliation | Local SQLite mock behavior is not a remote exactly-once guarantee |
| Timeout after commit | Independently committed upstream mutation; reliable lookup or UNKNOWN_OUTCOME | Unknown outcomes require human reconciliation; no automatic reversal |
| Partial completion | Confirmed receipt retained; safe ticket/provider update retry | Provider operations are mocked; real vendor retry semantics need independent verification |
| Webhook forgery/replay | HMAC validation, stable event IDs and consumer deduplication | Local sink only; real timestamp windows, endpoint security and secret rotation are unimplemented |
| MCP misuse | Only scoped request/status/policy tools; no approval, SQL or generic write tool | Host must supply and protect its own demo session token |
| Checkpoint leakage | Bounded reference state; no secrets, labels, databases or hidden reasoning | Local files are not encrypted at rest |

Money uses safe integer minor units and explicit currency. Approval never overrides hard policy prohibitions, absent ownership, conflicting authority, unpaid invoices or unsupported currency. Subscriptions are not changed by refunds. Deletion affects the fictional account profile; it is not a compliance-grade erasure implementation.

## Intentional constraints

- No live model adapter, real vendor adapter, real email delivery, payment provider, remote outbound webhook or public hosting was enabled.
- Supported free-text intents are duplicate refunds, policy answers, account deletion and ambiguous cancellation. Unsupported requests escalate. The held-out “reverse” and “credit” formulations remain measured failures.
- Cancellation deliberately requires human clarification; the demo does not guess which of multiple subscriptions to cancel.
- Demo actors expire after eight hours; requests expire after 24 hours. Approval records persist for audit. Current authorization still comes from server-owned records and the local role boundary.
- Read retry/backoff, graph steps, active time and ticket retry attempts are bounded. Runtime budgets are not a real-time scheduling guarantee. Abrupt crashes can lose part of elapsed-time accounting without losing receipts.
- Local runner ownership prevents competing live processes in the same environment; PID reuse and multi-host scheduling are not production-grade lease handling.
- Corpus metadata and customer source files are small fixtures. The scanner states exact coverage and never claims to have inspected a production estate.
- Output groundedness checks only the defined deterministic receipt claim. No model judge, hallucination rate or calibrated confidence is fabricated.
- Model usage/cost is N/A. Local simulator timing does not estimate future model or network latency.

## Retention and redaction

Canonical audit events are append-only during normal use. Trace views and reruns do not alter their source history. API JSON redacts obvious bearer/API-key tokens and email addresses; full initial customer snapshots are omitted from exports. Redaction is a bounded demonstration, not a general DLP engine. Do not put actual sensitive data in the app.

There is no automatic retention expiry. Runtime state stays in ignored `.fieldkit/`. Explicit selected-tenant reset clears canonical synthetic rows, execution requests, operation reservations, active checkpoint threads, external records and indexed reports for that tenant, while preserving other tenants. It preserves source files, reviewed discovery working copies, session credentials and signing keys. Old sandbox directories and generated exports remain as local files; complete disposal requires stopping the server and removing the disposable data directory yourself. No cleanup walks outside that directory.

## Production work that remains

Replace local demo identity with real authentication/authorization; independently implement and test vendor contracts; establish provider operation lookup/idempotency guarantees; protect secrets and backups; add retention, real delivery scheduling, concurrency leases, authorization revocation, network policy and operational monitoring; measure live-model behavior against independent data; and perform security and business review. Passing synthetic readiness gates does not complete any of those obligations.
