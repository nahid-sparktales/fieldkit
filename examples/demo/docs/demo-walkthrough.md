# Three-minute demonstration

Start with `npm run dev`, open [localhost:4317](http://localhost:4317), select **Acme**, and use the labeled **Support manager** demo persona. If you have already refunded the demonstration charge, use **Reset synthetic demo data** and confirm Acme before the tour. This deliberately resets that tenant's synthetic history.

1. **Automatic refund.** Click **Start demo**, then **Run workflow** for Duplicate charge. Read the $49 receipt, resolved ticket, actual invoice evidence and execution events. A repeated request cannot refund the same charge twice.
2. **Durable human approval.** Choose **Large refund**, then **Run workflow**. It shows waiting and no execution receipt. Open **Approvals**, inspect the exact $8,000 action, and approve or reject it. Approval revalidates and executes once; rejection makes no financial write.
3. **A real failure.** Open **Evaluations → Run smoke**. The held-out reversal case fails and escalates. Choose its **Inspect** action. The graph path and response explain the failure; **Rerun in isolated sandbox** repeats it against fresh state without touching the original ledger.
4. **Messy customer discovery.** Select **MessyCorp → Customer discovery → Scan customer files**. Inspect legacy-ID, policy-conflict, retry-safety, missing-label and support-permission findings. **Apply verified account mapping** removes one actual finding, while the other blockers remain.
5. **Reviewed remediation and evaluation.** Expand **Review the remaining proposed fixture changes**, read the explicitly selected policy and capability changes, then **Apply reviewed fixture remediation** as the fictional business owner. Run **full** and **recovery** suites. Readiness is computed from those real results. The full run takes longer than the initial three-minute scan of the interface; it remains visible and inspectable while it runs.

The guided bar uses the same screens and operations. It does not replace backend execution with scenario success messages. The uncertainty scenario is easiest to inspect against a fresh ledger or an isolated rerun; after the $49 charge is already refunded, the ordinary duplicate safety gate correctly blocks a new refund rather than manufacturing another timeout.

## Existing support stack

On a fresh Acme scope, open **Existing support stack** and process **ACME-1042**. The mock Jira ticket enters the same graph and gets one $49 receipt. Return to the integration screen and expand **Native fields, comments & status**: the original issue has an internal note, customer-safe public reply and Resolved status. Process **ACME-1043** to see internal-approval waiting for $8,000.

Select **Northstar** and process **2401** through mock Zendesk. Its different schema maps into the same domain. Northstar's $25 limit means the $49 case requires approval. Its receipt and final solved ticket prove provider independence while preserving customer-specific policy.

Globex uses **Existing chatbot** by default. **Send governed chatbot request** creates a real normalized request and returns an approval-bound operation. The before/after panel explains the host chatbot's role: its conversation remains outside FieldKit; only governed operational work is delegated.

## Real backend restart

1. Start the server in a terminal: `npm run dev`.
2. In Acme, process **ACME-1043**, or launch **Large refund** in Support workspace.
3. In Traces, note the run ID, original thread ID and proposal hash. Verify no receipt exists. For Jira, verify the external ticket is waiting for internal approval.
4. Stop the backend with **Ctrl+C** in its terminal. This is an actual process stop, not a UI animation.
5. Restart with `npm run dev` using the same directory and `FIELDKIT_DATA`.
6. Refresh **Approvals**. The same proposal, run and external ticket remain pending.
7. Approve the exact action. Inspect the original trace: the thread is unchanged, invocation count increases and there is one $8,000 receipt. The original Jira ticket resolves.
8. Refresh and inspect again. No additional financial action appears.

For automated crash-window proof, run `npm run test:recovery`. It covers abrupt child-process exit after an upstream commit and after canonical confirmation, plus a decision saved before resumption starts.

## Safe support retry

On a fresh Acme scope choose **Partial completion** and run it. The refund receipt is durable but the ticket write fails. Click **Retry ticket update only**. Only the failed bookkeeping path is retried. The receipt count remains one. This is distinct from **Rerun in isolated sandbox**, which executes a new case in new files.

## Inspection commands

```sh
npm run fieldkit -- workflow inspect RUN_ID
npm run fieldkit -- replay TRACE_ID
npm run fieldkit -- replay TRACE_ID --rerun --sandbox
```

The first two are read-only. The last creates new sandbox state; fresh sandbox approval controls appear in the resulting trace when needed.
