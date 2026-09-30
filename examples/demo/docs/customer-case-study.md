# Acme: governed billing resolution behind an existing support desk

This case study is fictional. Business assumptions, synthetic measurements and unmeasured production outcomes are deliberately separated.

## Fictional business assumptions

Acme is a self-service SaaS company whose customers sometimes see both old and upgraded plan charges. Its support desk already uses a Jira-style request workflow. Support needs a way to verify a duplicate, apply the correct refund and explain the result without moving its conversation experience into a new chatbot.

The invented business owner permits eligible automatic refunds up to USD $100 and requires explicit review above that threshold. Captured-payment evidence, account ownership, a verified duplicate relationship, available balance and a current policy are prerequisites. A refund must not implicitly cancel a subscription. Account deletion requires approval regardless of amount.

No historical ticket volume, actual customer, headcount baseline, cost saving or production success percentage is asserted.

## Discovery and scope

The discovery exercise reads configuration, schema samples, knowledge, label coverage and support capabilities. Acme's fixture maps its CRM account and support requester to the same canonical customer. Its billing adapter supplies captured invoices and reliable operation lookup. Its support adapter can create an internal note, publish a reply and update status.

The first scoped deliverable is a duplicate $49 correction plus an $8,000 human-approval path. Cancellation remains a clarification/escalation path. The workflow is reusable across Northstar's differently shaped accounts, invoices and Confluence-style pages, and Globex's enterprise records and existing chatbot. Policy limits remain deployment-specific.

## Integration and execution design

The existing ticket enters a normalized event boundary. FieldKit owns trusted scope, evidence collection and deterministic authorization. LangGraph persists explicit stages and a genuine human interrupt. The proposal, permission decision and execution receipt are separate records. Before executing, the system reloads the current account, evidence, policy, invoice and external ticket revision.

The integration writes customer-safe outcomes back to the original ticket only after confirmed execution. A timeout after upstream commit is reconciled or remains unknown. A failed ticket update cannot cause the financial action to run again. The same policy services govern the native UI, external-ticket adapter, API, CLI, SDK and MCP request surface.

## Measured synthetic results

The seed-42 Acme full suite executes 64 base families with ten variants each. The recorded reference run observed 620/640 task successes, 410/410 critical-case passes and 640/640 side-effect safety checks. Smoke suites for Acme, Northstar and Globex each observed 8/9 successes. The dated verification report contains the actual run IDs and regression/browser counts.

The 20 full-suite failures are two held-out phrasing families. The narrow simulator does not interpret “reverse the second payment” or “credit the extra payment” as the labeled refund request. It escalates safely. Their failure traces are inspectable, and isolated reruns reproduce that limitation without modifying the original ledger.

Fresh-process tests verify waiting approval, saved-decision recovery, crashes before graph checkpoints, concurrent decisions, external correlation after restart, scoped reset, uncertainty handling and safe partial completion. Browser tests exercise actual requests, approvals, Jira updates, discovery changes, failure reruns and mobile controls. These are local synthetic observations, not measurements of an LLM or a vendor integration.

## MessyCorp's blocker-to-pilot journey

MessyCorp's actual fixtures include an unmapped legacy account, a stale guide, conflicting authoritative policies, missing evaluation labels, unsafe billing lookup, ambiguous support mapping and a missing status-write permission. The initial scanner blocks rollout even though support reads work.

A verified ID mapping removes only its own finding. A separate explicit business-owner decision selects the published refund policy, retains the contradictory draft as history, reviews the guide and labels, and enables the implemented mock reconciliation/status capabilities. A rescan reads these changed working files. Full and recovery suites must then pass the configured gates before the label becomes **READY FOR SIMULATED PILOT**. Dismissing a finding alone does nothing.

## Illustrative rollout and rollback plan

This is a documented plan, not an interactive production rollout switch:

1. **Shadow:** compare proposals with human decisions; permit no operational effects in a future real integration.
2. **Approval-only:** require human review for every financial operation; verify provider reconciliation and downstream updates.
3. **Limited autonomy:** permit only small, fully evidenced corrections under the approved threshold; keep high-risk and ambiguous cases gated.

Pause or roll back autonomy on any unauthorized/duplicate effect, unresolved unknown outcome, loss of policy authority, failed mandatory recovery assertion, mapping drift, or meaningful deterioration of independent evaluation results. A high average success score cannot offset a critical defect.

## Lessons and unmeasured outcomes

The difficult boundary is between proposing an action, authorizing it and proving it happened. Durable checkpoints support this boundary but do not replace it. Customer data mapping and support permissions matter as much as the resolver. Keeping traces separate from report summaries also makes progress updates practical without copying a large execution history on every poll.

Production savings, resolution-time improvement, support satisfaction, LLM quality and real integration reliability remain unmeasured. The next engagement would validate those independently; this portfolio does not invent them.
