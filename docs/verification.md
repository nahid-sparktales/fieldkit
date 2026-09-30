# Verification and release gates

Status: development release candidate. A passing double-backed test is not a successful live connector verification. The original demo's 33 tests are reported separately and do not count as real-provider evidence.

## Automated local checks

`npm run typecheck`, `npm run build`, and the v2 database tests exercise actual PostgreSQL, pgvector, pg-boss transactional insertion, Better Auth sessions, LangGraph checkpoints, upload parsing, and HTTP authorization. Only model/provider responses and email delivery are injected. The binary PDF/DOCX fixtures contain synthetic text authored for these tests.

The v2 suite covers installation bootstrap, invitations, tenant/customer isolation, forged identities, unreviewed knowledge, all import adapters, revoked sources, empty extraction, stale turns, takeover, exact approvals, policy/role changes, cross-account actions, timeout-after-commit, a fresh child-process restart, competing approvals, reconciliation, service credential scope, retention, webhook duplicates, and Zendesk write suppression.

The browser journey registers and verifies staff/customer accounts through real application endpoints, ingests and approves a document, publishes a channel, asks a cited question, takes over in the staff inbox, replies, reloads persisted history, and checks a 390-pixel mobile viewport. It uses fake provider/model ports and captured test email, not real email or model service. Screenshots and Playwright traces are CI artifacts.

Use a disposable `TEST_DATABASE_URL` ending in `_test`. Each suite resets it. Run database and browser suites sequentially.

## Live model evaluation

Connect a real key to a dedicated workspace, then explicitly opt in:

```sh
FIELDKIT_RUN_LIVE_EVALS=1 FIELDKIT_LIVE_WORKSPACE_ID=YOUR_TEST_WORKSPACE npm run test:live
```

This consumes real model tokens within the workspace budget. It tests grounded answers, missing evidence, clarification, action selection, malicious document text, and conflicting policies. It never executes provider writes. Results are saved to `.fieldkit/reports/live-model.json`, with model/time and per-case decisions. Missing credentials produce exit code 2 and **BLOCKED**, with no simulator fallback. Review citation support and natural-language correctness manually; the small set is a regression gate, not a statistical reliability claim.

## Required real-account evidence (currently blocked)

| Gate | Dedicated setup and required evidence |
| --- | --- |
| SMTP and accounts | Real domain/sender; deliver verification, invitation, reset; expire a session; prove the customer cannot read another customer's ticket |
| OpenAI | Run live evaluation; record actual token totals; exceed a small test budget; unavailable model must hand off |
| Native portal/widget | Actual SMTP/model/knowledge; anonymous answer, signed identity, customer history, follow-up, takeover/resume, keyboard and mobile navigation |
| PDF/DOCX/text/web | Supported files plus image-only/unsupported files; mutate/delete source; prove fresh citations and failed extraction visibility |
| Notion | Operator integration/shared page; import/update; revoke page sharing; inaccessible content must disappear |
| Google | Approved OAuth/Picker configuration; select one file; prove unselected files are not accessible; update/trash/revoke; refresh token |
| Zendesk | Approved global OAuth app and test account; signed create/update webhook; multi-page history; public reply/private note; tags/assignment/status; requester change; follow-up/handoff; safe-update conflict; duplicate delivery; refresh/429; feedback-loop suppression |
| Stripe | Installed restricted-key App in test mode; reviewed mapping; full/partial refund and selected period-end cancellation; wrong-customer rejection; replay/concurrent approvals; timeout-after-commit lookup; prove exactly one effect |
| Custom API | Dedicated HTTPS test service with ownership checks, closed schemas, idempotency ledger and outcome lookup; read/write, duplicate request, bad output, timeout-after-commit, outage, blocked private URL |
| Operations | Compose fresh install; migration repeat; stop/restart worker; database+uploads+secret restore drill; key rotation; retention/deletion; failed-job recovery |

Vendor approval or unavailable credentials remain release blockers. Do not invite real customers until required live flows pass. This build does not alter existing integrations, customer accounts, or money to manufacture evidence.

Record each live run in a private report with commit, time, test account identifier, steps, expected/observed outcome, provider request/operation IDs, and redacted screenshots. Do not include keys, cookies, or customer documents. Mark every unrun step BLOCKED or NOT RUN. Promote a connector to release-verified only after its complete real test-account flow succeeds.
