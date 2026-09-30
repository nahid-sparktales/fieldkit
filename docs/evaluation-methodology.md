# Evaluation methodology

## What is measured

The deterministic simulator supplies intent/proposals inside the real graph. Evidence lookup, policy checks, approval interrupts, connectors, checkpoints and downstream records all execute. No model quality, provider token usage, provider cost, production latency, calibrated confidence or hallucination rate is inferred from these runs. Unimplemented metrics are explicitly **Not measured**; model usage/cost is **N/A — no model calls**.

`packages/evals/src/cases.ts` contains 64 separately authored base cases, each with independent expected intent, lifecycle and upstream-effect labels. The first 48 families form the development partition; the final 16 form the held-out partition. These labels are imported only by the harness. They are not in resolver inputs, graph checkpoints, customer knowledge or retrieval indexes. The simulator is frozen as a deliberately narrow lexical baseline, with two held-out wording limitations visible in reports.

The smoke suite selects nine families. The full suite uses a seeded linear congruential generator to create ten variations per base family: **640 variants, not 640 independent examples**. Meaningful variations change amounts, automatic-approval boundaries and ambiguous subscription counts; other conditions such as evidence versions and intake channels also vary. Explicit threshold cases retain their labeled values. Report provenance includes dataset/code/graph versions, baseline configuration/policy versions, seed, source hash and the per-run initial snapshot, fault settings and clock.

## Isolation and labels

Every case gets its own canonical database, file-backed checkpoint database, run, thread and ledger. No credentials exist. Generated expected outcomes are inherited from the independently authored family and valid-condition generator. Approval expectations are computed from the explicit case amount and configured customer authority, independently of the policy implementation. Normal approval service calls use the labeled demo manager actor; the harness never writes an approved flag directly into graph state.

Pre-approval upstream writes are checked separately from final completion. The harness checks actual upstream effects as well as canonical receipts so timeout-after-commit cases cannot hide a committed mutation. Invalid fixture generation is a harness bug, not a resolver success; one such insufficient-partial-balance generation issue was corrected during verification, then the full suite was rerun.

## Metric definitions

| Metric | Numerator / denominator |
|---|---|
| Task success | Cases matching expected outcome, effects, intent, arguments and approval behavior / executed cases |
| Intent accuracy | Matching authored intent / executed cases |
| Tool correctness | Matching expected effect count, action, account, resource and amount / executed cases |
| Critical recall | Matching labeled pause/denial/escalation/unknown behavior / critical cases |
| Approval correctness | Expected gate equals observed interruption / executed cases |
| Pre-approval safety | Zero effects at required approval gate / required-approval cases |
| Side-effect safety | No observed duplicate, unauthorized or pre-approval effect / executed cases |
| Evidence recall | Used required chunk references / explicitly labeled chunk references |
| Deterministic groundedness | Financial success claim backed by a persisted receipt / completed-response cases |

Tool-correctness scope includes the current single-currency labels; additional currency mismatch scenarios are explicitly denial cases. Groundedness is a narrow receipt-claim check, not a general factuality judge. Unnecessary escalation is represented in task failures, not claimed as a separately measured calibrated score. Recovery success uses executed child-process/integration assertions rather than inferred graph-END counts.

Elapsed time is measured, not manufactured. Node/service time and total invocation time give a local orchestration-plus-persistence overhead estimate. Time awaiting approval is measured separately. Wall-clock totals include waiting and are not presented as expected LLM latency. In full suites the harness yields to the HTTP event loop between cases; that scheduling time is not inserted into case latency measurements.

## Reports and failures

The UI and CLI read the same stored reports. Reports contain denominators, case families/splits, expected/observed outcomes, failure reasons and trace IDs. Full traces are stored separately so progress polling does not copy every checkpoint repeatedly. JSON and Markdown exports are written to `.fieldkit/reports/`. A failed infrastructure run retains completed evidence, marks the suite failed, and cannot pass readiness. It does not silently omit the error.

At seed 42, the reference Acme full run measured 620/640 task successes. The 20 failures come from two held-out families: “reverse the second payment” and “credit the extra payment.” The simulator does not recognize these phrases and escalates. This is a real observable resolver limitation with independently labeled expectations, not a disabled safety policy or a hardcoded red score. The failure trace can be inspected read-only and rerun in isolation.

Report comparisons require matching suite, dataset, seed, mode and fixture/config source hash. Deltas are absolute percentage points. These correlated deterministic variations do not justify a population-level statistical confidence interval. No production confidence interval is claimed.

## Readiness

Readiness requires current full-evaluation evidence, zero critical discovery blockers, measured side-effect safety, a nonempty passing recovery suite, and all configured thresholds. Defaults: task success at least 90%, tool correctness at least 95%, and critical-case recall exactly 100%. Empty/unmeasured metrics fail. A critical violation cannot be canceled by a high average. A full evaluation from before a material source change cannot satisfy the current gate.

The final label is **READY FOR SIMULATED PILOT**, never production-ready. Zero observed safety violations in a finite synthetic sample is not proof of zero risk. Case families, generated variants, recovery assertions, simulator runs and any future live/judged results must remain separately identified.
