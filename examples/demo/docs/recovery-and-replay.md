# Recovery and replay

## Recoverable requests

Intake atomically writes the canonical run and a pending execution request. Approval atomically records one authoritative decision and advances the queued request revision. If the process exits before graph invocation, startup finds the same queued work. It does not re-submit the initial ticket or invent a second operation.

For a stored interrupt, the runner loads the existing approval and resumes through `Command` with its decision ID and original thread. Undecided approvals remain paused. For an unfinished non-interrupted checkpoint, it advances from stored state with `null` input. Completed graph threads are not executed again. A graph/schema mismatch stops with an explicit diagnostic; startup does not clear saved workflows to avoid compatibility checks.

## Crash windows

| Window | Behavior |
|---|---|
| Intake before initial invocation | Persisted job advances the stored run |
| Waiting for a manager | Same proposal and thread load; zero financial effects |
| Decision saved, resume not begun | Durable job carries the recorded decision into the original interrupt |
| Operation prepared, no dispatch | Exact proposal is revalidated; original operation ID reused |
| Dispatch recorded, no confirmed receipt | Reconcile the original operation; never blindly repeat a financial write |
| Mock upstream committed, caller timed out or crashed | Reliable operation lookup confirms the stored upstream receipt; otherwise UNKNOWN_OUTCOME |
| Receipt confirmed, graph checkpoint not written | Re-entry finds the original receipt before treating reduced balance as a new failure |
| Billing succeeded, support update failed | Preserve the receipt; PARTIAL_COMPLETION; retry the safe remaining bookkeeping only |
| Event persisted, webhook acknowledgment lost | Delivery retry keeps event ID and uses a new attempt ID; receiver deduplicates |

`tests/recovery-worker.ts` and `tests/external-worker.ts` run in fresh child processes. `FIELDKIT_FAILPOINT=after_upstream_commit` exits after the independent upstream commit; `after_confirmed_refund` exits after canonical confirmation and before the graph checkpoint. These are explicit test-only failpoints. Never enable them for ordinary use.

Resource-level SQLite reservations are unique by tenant/resource/action, so two separately keyed runs cannot correct one duplicate charge twice. The mock connector mutation and operation confirmation are separate commits. This models the difficult uncertainty interval instead of rolling back the upstream effect with the caller. It does not establish exactly-once semantics for a real provider without trustworthy reconciliation.

## Inspection is read-only

Opening a trace, exporting it, `workflow inspect`, and `replay TRACE_ID` read persisted records and checkpoints. They do not invoke the graph, model or business connector. Ordered event IDs support reconnect with `?after=ID`. Server execution does not depend on the browser remaining connected.

Original events are append-only until an explicit scoped synthetic reset. The canonical run accumulates legitimate lifecycle updates; inspection and rerun do not rewrite its history.

## Reruns are isolated execution

`replay TRACE_ID --rerun --sandbox` restores the recorded initial account, invoice, subscription, knowledge and configuration snapshot into a new directory. It copies the original fixture fault settings and seed, gives the new case a new run/thread and separate canonical/checkpoint files, and links it to the original. External support records are restored from their saved initial native snapshot. No provider credentials exist or are inherited.

The UI shows an original/new outcome and receipt diff. A large or destructive rerun pauses for a **new sandbox decision**. The trace exposes **Approve sandbox action** and **Reject sandbox action**, routed through the normal approval service in the sandbox. Original decisions never authorize a new execution.

The simulator, input, fixture snapshot, seed, versions and original clock are retained. IDs and measured elapsed times naturally differ. The current real clock is used for new expiration/authority checks; this is not a historical-clock emulation. Rerunning a saved expired-policy case on a different date may change time-dependent results and is labeled as a new execution.

LangGraph time travel would re-execute downstream nodes. FieldKit does not expose arbitrary checkpoint forks or a force-node command. A checkpoint alone is not a billing snapshot. Only full-case sandbox reruns are implemented.

## Scope and resets

A manager must confirm the selected tenant for reset. Active graph work prevents reset; the API also blocks reset while a local evaluation is running. A durable reset fence removes queued work before deleting that tenant's checkpoint threads and canonical rows. On startup, an incomplete reset is completed under the runner lock. Other tenants, baseline customer files, demo sessions and webhook signing material are preserved.

Archived sandbox database directories and generated report files are retained on disk even after their selected-tenant indexes are removed. This avoids deleting arbitrary paths. They are ignored by Git and never used as active deployment state. Stop the backend and deliberately remove the entire synthetic `FIELDKIT_DATA` directory for a complete disposable-environment cleanup.
