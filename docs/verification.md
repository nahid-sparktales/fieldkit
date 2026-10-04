# Verification and release gates

Status: development release candidate. A passing double-backed test is not a successful live connector verification. The original demo's 33 tests are reported separately and do not count as real-provider evidence.

## Inbox UX refresh — 2026-10-03

All 107 backend tests, strict TypeScript checks (including unused bindings), and the production build passed. The expanded browser journey passed in 43.7 seconds with no page errors. It covers draft preservation across tickets and app sections, draft recovery after a failed request, keyboard note submission, private-note exclusion from public previews, resolution and assignee filters, feedback resets, arrow-key tab navigation, mobile queue/detail navigation and focus restoration, and the existing assistant/knowledge/workflow/portal flows. Desktop and 390-pixel screenshots were inspected. The build retains the existing non-blocking large-chunk warning.

New deterministic tests cover takeover/status precedence, expired and invalidated approval queues, shared badge meanings, exact refund amount display, and customer/workspace isolation of conversation preview metadata. Manual local sandbox review checked approval cards, expiry disabling, desktop/narrow layouts, and the running app. Model/provider doubles and disposable test data were used; no paid calls or real business actions were performed. See [the inbox review](inbox-design.md) for behavior and boundaries.

## Help center branding and profile settings — 2026-10-02

All 97 backend tests pass, including new coverage for workspace/role isolation, logo validation and publication boundaries, optimistic concurrent saves, atomic rejection of invalid changes, stable workspace URLs, self-only profile updates, current-password validation, and session revocation. These tests use dedicated accounts in the disposable PostgreSQL database.

The browser journey covers profile editing and older-session handling, workspace renaming, logo upload, preview and persisted appearance, desktop/mobile layouts, actual public logo rendering, branded sign-in, privacy/terms links, and dark-palette widget contrast. Existing knowledge, workflow, customer conversation, feedback, and staff takeover journeys remain covered. Strict TypeScript checks and the production build pass. Local schema 10 migration, database backup, and app readiness were verified. No paid model or live business-provider calls are required by these additions. See [the branding guide](branding.md).

## Test Lab, gaps, and analytics — 2026-10-02

All 92 backend tests, 33 archived demo tests, strict TypeScript checks (including unused bindings), the production build, and the expanded browser journey passed locally. The feature suite uses the real PostgreSQL database, queue contracts, and LangGraph engine with injected model/provider doubles. New regressions cover multi-turn continuity and two-model snapshots, independent rules/judging/staff overrides, schema-checked fixture reads, zero customer or business-operation writes during evaluation, missing fixtures and unavailable runners, cancellation/uncertain restart recovery, revoked administrator access, changed knowledge, feedback updates and isolation, original-question gap evidence, grounded private drafts, merges, incremental analysis, opt-in scheduling, imported-case deletion, known analytics totals and delivery times, native/unrated denominators, modern/legacy Zendesk ratings and pagination, and atomic token reservations. Structured judging tests check invalid output and actual reported usage separately from the simulated judge's scores.

The expanded browser journey exercises native feedback, editable two-turn suites, invalid fixture errors and successful message resets, two-variant evaluation, staff review, Analytics channel filters, gap flagging, Analyze now, default-disabled scheduling, keyboard labels/focus, and mobile overflow checks. Desktop Test Lab/Analytics and portal feedback screenshots were inspected. Quality pages are loaded as separate bundles. The local database was backed up before the additive schema 9 migration and app/worker restart; readiness passed.

No paid model calls or live Zendesk ratings were used for these checks. The existing opt-in live-model suite remains separate. The Zendesk CSAT import is **not release-verified** until a dedicated account passes modern and legacy feedback flows, edits, pagination, permissions and rate limits. Docker/runner/Compose checks are defined in CI but cannot run on this Mac, which has no Docker, Podman, or Colima runtime. No local container success is claimed.

## Workflow customization verification — 2026-10-02

All 78 v2 tests, type checking, the production build, and the expanded browser journey passed locally. Thirteen customization tests cover exact/template replies without model usage, variable validation, typed conditions, customer visibility, schema failures, immutable components/subflows, cached-result recovery, tenant/role boundaries, fixed API destinations, verified customer reads, takeover, changed identity, nested action approvals, AI citations, and revoked read authority before Zendesk delivery. Existing process-restart approval regressions still pass.

The browser journey creates and tests a public API step, saves a Python component, verifies the unavailable-runner error, builds a subflow with mapped inputs/outputs, uses its result in a reply template, and publishes the graph. Desktop/mobile layout checks passed. Provider and model responses are injected test fixtures; this does not verify live vendor accounts. Local schema 8 migration and app/worker readiness passed after a database backup. Secret scans found no findings and the production dependency audit reported zero known vulnerabilities.

Docker is unavailable on the development Mac. The dedicated CI check builds the real runner image and tests actual Python/JavaScript execution, authentication, network/filesystem/credential isolation, output/log bounds, timeout, and cleanup. See the repository's current CI run for that check's result; local adapter doubles are not evidence of container execution. Operator setup is documented in [customization and runner setup](workflow-components.md).

## Model providers and README identity — 2026-10-01

All 65 v2 tests, type checking, the production build, and the complete browser journey passed. Six new provider suites exercise the actual adapters with injected HTTP responses for Claude, Kimi, OpenRouter, DeepSeek, vLLM, and generic compatible servers. They cover connection validation, structured answers, FAQ/staff assistance, provider overrides, reported usage on invalid/truncated results, conservative reservations when usage is missing, budgets, exact embedding dimensions, reindexing, publication preservation, and rejection of incompatible vectors. A real local HTTP server verifies operator-approved private transport, blocked redirects, and isolation from document/action networking.

The browser journey connects Claude, selects it for responses while keeping OpenAI embeddings, reloads saved settings, inspects vLLM setup, publishes a workflow with a provider/model override, and completes the FAQ and customer-support flows. Model/provider responses and email remain test doubles. The initial browser run exposed inaccessible exact labels on the new provider selects; explicit labels fixed it and the complete rerun passed. Desktop screenshots were inspected, and the journey retains its mobile overflow checks.

The local installation was backed up, migrated to schema 7, and restarted with readiness passing. Existing model settings and vectors were preserved. The new logo and FieldKit wordmark banner are included in the README. The source-tree secret scan found no non-allowlisted findings. No live requests were sent to the newly supported model providers; their full test-account evaluations remain blocked below.

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

| Gate                                                                         | Dedicated setup and required evidence                                                                                                                                                                                                                                  |
| ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SMTP and accounts                                                            | Real domain/sender; deliver verification, invitation, reset; expire a session; prove the customer cannot read another customer's ticket                                                                                                                                |
| Models: OpenAI, Claude, Kimi, OpenRouter, DeepSeek, vLLM, compatible servers | Run live evaluation for each enabled provider/model; record actual token totals; verify embeddings and citations; exceed a small test budget; unavailable/unsupported models must hand off                                                                             |
| Native portal/widget                                                         | Actual SMTP/model/knowledge; anonymous answer, signed identity, customer history, follow-up, takeover/resume, keyboard and mobile navigation                                                                                                                           |
| PDF/DOCX/text/web                                                            | Supported files plus image-only/unsupported files; mutate/delete source; prove fresh citations and failed extraction visibility                                                                                                                                        |
| Notion                                                                       | Operator integration/shared page; import/update; revoke page sharing; inaccessible content must disappear                                                                                                                                                              |
| Google                                                                       | Approved OAuth/Picker configuration; select one file; prove unselected files are not accessible; update/trash/revoke; refresh token                                                                                                                                    |
| Zendesk                                                                      | Approved global OAuth app and test account; signed create/update webhook; multi-page history; public reply/private note; tags/assignment/status; requester change; follow-up/handoff; safe-update conflict; duplicate delivery; refresh/429; feedback-loop suppression |
| Stripe                                                                       | Installed restricted-key App in test mode; reviewed mapping; full/partial refund and selected period-end cancellation; wrong-customer rejection; replay/concurrent approvals; timeout-after-commit lookup; prove exactly one effect                                    |
| Custom API                                                                   | Dedicated HTTPS test service with ownership checks, closed schemas, idempotency ledger and outcome lookup; read/write, duplicate request, bad output, timeout-after-commit, outage, blocked private URL                                                                |
| Operations                                                                   | Compose fresh install; migration repeat; stop/restart worker; database+uploads+secret restore drill; key rotation; retention/deletion; failed-job recovery                                                                                                             |

Vendor approval or unavailable credentials remain release blockers. Do not invite real customers until required live flows pass. This build does not alter existing integrations, customer accounts, or money to manufacture evidence.

Record each live run in a private report with commit, time, test account identifier, steps, expected/observed outcome, provider request/operation IDs, and redacted screenshots. Do not include keys, cookies, or customer documents. Mark every unrun step BLOCKED or NOT RUN. Promote a connector to release-verified only after its complete real test-account flow succeeds.

## Persistent store sandbox

`npm run sandbox` starts a separate local Trail Supply installation on ports 4320/4321. See [the walkthrough](../examples/store/README.md). Its six regression checks cover safe database selection, public/private knowledge, approval-required simulated billing, persistent idempotent receipts, restart-safe seeding, customer isolation, and six rule-based evaluation turns. All 103 backend tests, strict TypeScript checks, and the production build pass. Manual browser verification covered owner login, the exact pending refund approval, the embedded widget loading, customer-only ticket history, and a cited shipping response. Restarting the local sandbox preserved the workspace and conversations. Scripted outputs are not live-model quality evidence, and payment fixtures are not real Stripe verification.

## Ticket/chat and email regression checks

`tests/customer-support.test.ts` covers independent channel publications, default inheritance, closed-only feedback, latest-answer checks, human takeover on reopen, outbound deduplication, wrong-sender and auto-reply rejection, unsupported attachments, credential replacement, unknown SMTP outcomes, revoked contacts, and the absence of mail from chat/internal notes. Existing backend safety and approval regressions remain required.

The browser journey submits a subject/message ticket, verifies feedback is absent before closure, records feedback after closure, receives a staff reply, and exercises the existing inbox/branding/workflow journeys. The store launcher additionally captures actual queued mail and simulates an inbound reply to the same ticket. These are deterministic tests, not real Postmark release verification; complete the dedicated external mailbox round trip described in [customer support setup](customer-support.md) before release.
