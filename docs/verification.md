# Verification and release gates

Status: development release candidate. A passing double-backed test is not a successful live connector verification. The original demo's 33 tests are reported separately and do not count as real-provider evidence.

## Visual agent workflow and public-source preparation — 2026-10-01

All 59 v2 tests, type checking, the production build, the complete browser journey, and 33 separate archived-demo regressions passed. Workflow coverage includes validation, resource/tenant/role boundaries, optimistic editing, immutable run versions, knowledge selection, verified account context, multi-step draft review, conditional branches, held replies, assigned/prioritized handoff, takeover, mapping changes, exact approvals, fresh-process checkpoint recovery, and revocation of action authority when a workflow is replaced. Previews execute the same LangGraph route while stopping before approvals, writes, or messages. Setup preview follows the published graph.

The browser journey moves a node with the keyboard, adds and connects a condition using both outcome buttons and inspector controls, selects a knowledge source, publishes, previews the highlighted route, and completes a customer conversation through the edited workflow. Desktop and 390-pixel mobile views passed overflow checks. The local installation was backed up, migrated to schema 6, and restarted with app/worker readiness passing. These tests use injected model/provider responses; no live account action or paid model request was needed for this change.

Before publication, Gitleaks scanned all Git history and the tracked/new source tree. Five initial findings were confirmed as three literal fake provider keys and one synthetic request UUID (one key appears twice); only those exact values are allowlisted. The final scans found no non-allowlisted secrets. The production dependency audit reported zero known vulnerabilities. This review is not a complete security audit or a claim that the outstanding live-provider release gates have passed.

## Whole-library FAQ agent and inbox workflows — 2026-10-01

All 48 v2 regressions, type checking, the production build, and the browser journey passed. The regression suite now includes whole-library chunk coverage beyond the old 16-passage selection, saved batch progress, competing workers, cancellation, explicit retry, role revocation, source changes, tenant-scoped HTTP access, all five support workflows, private-note exclusion from customer replies, stale-result rejection, source revalidation before composing, private article creation, idempotent application, and queued Zendesk priority updates. Model/provider responses in these tests are injected. The browser journey exercises the full FAQ review, all five workflows, the `/customer-support` shortcut, reviewed triage, composer handoff, private article saving, and desktop/mobile layouts.

A live OpenAI escalation request on synthetic ticket text returned a cited summary with reported environment, reproduction, expected/actual outcome, attempted troubleshooting, and missing details. Actual usage was 318 input and 218 output tokens. No real conversation, FAQ, article, external note, or engineering issue was created by that check. This is a live adapter smoke check; it does not establish broad workflow quality or a successful live Zendesk write. Existing external-account release blockers remain unchanged.

## FAQ authoring and AI assistance — 2026-10-01

All 40 v2 regressions, type checking, the production build, and the browser journey passed. FAQ tests cover private drafts, tenant and role boundaries, exact-revision approvals, concurrent approval, withdrawal after editing, deletion, customer-approved AI context, revoked evidence, unsupported citations, duplicate suggestions, structured model output, token accounting, and budget enforcement. The browser journey creates and improves an FAQ, approves and publishes it, edits it back into a private draft, generates another private FAQ, and checks desktop and mobile layouts. These automated journeys use injected model responses.

One live request through the configured OpenAI model successfully rewrote a supplied answer into an FAQ, using 267 input and 45 output tokens. No FAQ was saved to the real workspace by this check. This verifies the live FAQ adapter and usage accounting; it is not a broader AI quality evaluation.

## Documentation import and response fix — 2026-10-01

The documentation crawler read all 45 pages discovered on `https://docs.locushost.co/` (214,633 extracted characters, no skipped pages), and four pages in GitBook's live `/docs/getting-started` section. These were public HTTP/extraction checks, not paid embedding runs. Isolated database tests cover per-page indexing, citations, staff-only defaults, unchanged-embedding reuse, version changes, removal, and revoked access. The browser journey includes creating a documentation-site source and previewing its pages.

A live OpenAI request using the installation's configured model returned a valid clarification after removing the transport-only `parametersJson` field. OpenAI reported 249 input and 62 output tokens. This verifies the response adapter fix; it is not the full live-model quality evaluation. The regression invokes the actual `LiveModel` adapter with a mocked SDK response and checks strict draft validation and usage accounting. Earlier requests that reached OpenAI before the app rejected their outputs remain real recorded usage.

## Observed results — 2026-09-30

All 30 v2 regressions, the complete browser journey, and the 33 separately archived demo tests passed. The [clean Node 24/Linux CI run](https://github.com/nahid-sparktales/fieldkit/actions/runs/36689961164) also built the Docker image and verified a fresh Compose installation, repeat migrations, and worker restart. Local backup restoration preserved record counts and immutable operation contracts/receipts; upload files matched their original SHA-256 hashes. Encryption-key rotation and keyboard focus checks passed. See [machine-readable results](verification-results.json) for scope and exact evidence. External test-account gates below remain blocked.

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
