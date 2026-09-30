# Verification and completion record

Verified locally on **September 30, 2026**, with Node **25.5.0**, npm **11.8.0**, the pinned lockfile and actual file-backed LangGraph execution. Recommended installation is Node 24 LTS; CI is configured for Node 24 but no remote CI execution is claimed.

## Commands and observed results

| Command | Actual result |
|---|---|
| `npm ci` / initial `npm install` | Pinned dependencies installed; lockfile included |
| `npm run check:compat` | Passed: disk-backed interrupt, child-process exit, same-thread resume in a fresh child |
| `npm run typecheck` | Passed |
| `npm run build` | Passed; local production bundle generated |
| `npm test` | **33/33 passed**: core, API/SDK/MCP, evaluation, provider integration and recovery assertions |
| `npm run test:recovery` | Recovery cases also executed through `npm test` and the CLI recovery suites; **16/16 current recovery-file assertions passed** |
| `npm run test:browser` | **7/7 passed**, including refund, refresh, approval, Jira updates, remediation, isolated failure rerun and mobile layout |
| `npm run fieldkit -- eval acme --suite smoke` | Completed: **8/9**; the held-out reversal phrase failed visibly |
| `npm run fieldkit -- eval northstar --suite smoke` | Completed: **8/9**, with the tenant's own $25 authority |
| `npm run fieldkit -- eval globex --suite smoke` | Completed: **8/9**, with all monetary actions requiring approval |
| `npm run fieldkit -- eval acme --suite full --seed 42` | Completed: **620/640** case successes; **410/410** critical cases; **640/640** side-effect safety checks |
| `npm run fieldkit -- eval acme --suite recovery` | Completed: **29/29** recovery/integration/API/MCP assertions |
| `npm run fieldkit -- eval messycorp --suite full --seed 42` | After explicit reviewed remediation: **620/640**, **410/410** critical, **640/640** safety |
| `npm run fieldkit -- eval messycorp --suite recovery` | Completed: **29/29** |
| `npm audit --omit=dev` | Zero known reported production-dependency vulnerabilities at verification time |

The standalone browser suite uses its own production server and isolated data directory. Actual screenshots are in [screenshots](screenshots/overview.png). Manual in-app browser verification also confirmed a real $49 receipt and stored graph events. A development hot-reload warning was corrected by preserving the React root; production browser verification completed successfully.

During implementation, checks found a CSS import/build error, loss of selected detail on browser refresh, an invalid partial-balance generator variation, and full-suite polling overhead. Each was corrected before the successful checks above. These earlier failures are not represented as passes. Two unsupported wording families remain deliberately visible as actual task failures rather than having their labels changed to make the scores green.

## Reproducible evidence

The checked-in [verification-results.json](verification-results.json) records report IDs, counts and final readiness evidence. JSON/Markdown reports under `docs/reports/` are archived outputs from executed suites, not preloaded UI scores. Fresh checkouts begin without measured readiness and must execute their own suites.

| Report | ID |
|---|---|
| Acme full | `138d116c-31c2-4849-84c4-6493ff7248ed` |
| Acme recovery | `54bac843-68c7-4164-ad21-6cd6930415bd` |
| MessyCorp full after review | `7f3ebc3b-f33b-4b92-bf99-ff773c76e016` |
| MessyCorp recovery | `65ad1c5f-518f-45ad-8146-1f8da7f182c9` |

The full dataset has **64 independent base families and 640 generated variations**. It is not 640 independent customer examples. Full success is 96.875%; 20 failures come from the reversal/credit families and safely escalate. Approval correctness is separately reported as 627/640, including intent misses that never reached the expected approval. Evidence recall is 240/260. Neither imperfect metric is silently replaced with 100%.

MessyCorp's initial real scan had **8 findings, 7 critical blockers**. Verified ID mapping reduced this to **7 findings, 6 blockers**. The explicit business-owner fixture review then produced **0 findings, 0 blockers**. Current full and recovery evidence satisfied all seven configured gates, yielding **READY FOR SIMULATED PILOT**. That label is not production certification.

## Acceptance criterion → runnable evidence

| Acceptance criterion | Test/report |
|---|---|
| Actual graph, disk checkpoints, true interrupt/resume | `tests/compatibility.ts`, `tests/core.test.ts`, stored checkpoint events |
| $49 once; right account, invoice, ticket and receipt | `core.test.ts`; automatic-refund browser test |
| $8,000 no write before approval, exact action, rejection and expiry | `core.test.ts`, `recovery.test.ts`, independent approval eval families |
| Fresh-process waiting, decision-before-resume and crash-after-write | `recovery-worker.ts` / `recovery.test.ts` |
| Concurrent decisions and competing resource requests | Fresh-process decision race; two-run same-charge regression |
| Stale policy/evidence/balance and external ticket | Recovery restart case, full eval stale families, integration revision test |
| Tenant/role boundaries across REST, SDK, MCP and traces | `tests/api.test.ts`; wrong-tenant and forged-decision regressions |
| Unknown upstream commit versus retryable read | Recovery timeout cases and full read-failure families |
| Confirmed money plus failed ticket/provider update | Recovery and integration partial-completion tests |
| Provider normalization, round trips and async approval | Jira/Acme and Zendesk/Northstar integration tests; external restart child |
| Duplicate/reordered inbound events; signed outgoing retries | `tests/integrations.test.ts` |
| Missing fields/status mappings/capabilities | Normalization, unsupported-operation and discovery assertions |
| Discovery findings and actual remediation | Integration scanner test; measured MessyCorp before/after evidence |
| Version mismatch, persistent retry and graph-step budgets | `tests/recovery.test.ts` |
| Read-only inspection versus isolated execution | Inspection event-count assertion, separate-ledger rerun test |
| Fresh sandbox approval cannot reuse original authority | `tests/evaluation.test.ts` |
| Event reconnection and page refresh | API ordered-event cursor check; browser receipt persistence |
| Scoped reset preserves other tenants and checkpoints | Integration scoped-reset test |
| Independent labels, held-out failures, 640 seeded variants | `tests/evaluation.test.ts`, `cases.ts`, archived full reports |
| Actual UI, responsive navigation, no runtime page errors | `tests/browser/app.spec.ts`, genuine screenshots |

## Unverified or intentionally unavailable

No live-model calls, real-provider requests, internet webhook deliveries, real email, actual refunds, public deployment or historical production outcomes were attempted. Remote CI has not run. No production claim is made for single-host process ownership, real-world authorization, provider exactly-once execution, economic impact, calibrated confidence, general hallucination rate or LLM quality. The local receiver and demo identity are explicitly simulated.

The ZIP excludes dependencies, Git metadata, mutable SQLite databases, sessions and signing keys. Install dependencies from the included lockfile. Source, customer fixtures, tests, guides, archived reports and screenshots are included.

The packaged project was extracted into a fresh temporary directory and verified with `npm ci --prefer-offline`, `npm run typecheck`, `npm run build`, and `npm run check:compat`. All passed without relying on the original workspace's installed packages or runtime state. The ZIP integrity check also passed.
