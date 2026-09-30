# LangGraph design

## Verified dependencies

The pinned and installed stack is `@langchain/langgraph@1.4.18`, `@langchain/core@1.2.13`, `@langchain/langgraph-checkpoint@1.1.5`, `@langchain/langgraph-checkpoint-sqlite@1.0.4`, `better-sqlite3@12.10.0`, and `zod@4.6.5`. The lockfile records transitive resolutions. Installed TypeScript declarations were checked for `SqliteSaver.fromConnString`, `db`, `deleteThread`, `durability`, `stream`, `getState`, and `getStateHistory`.

The earliest compatibility test constructs a genuine `StateGraph`, checkpoints to a temporary file, calls `interrupt`, exits its child process, then launches another child process and resumes with `Command({resume: ...})` and the same thread. This requires neither a model nor network access.

References checked against installed types:

- [JavaScript overview](https://docs.langchain.com/oss/javascript/langgraph/overview)
- [SQLite checkpoint adapters, inspection and durability](https://docs.langchain.com/oss/javascript/langgraph/checkpointers)
- [Interrupts and node re-entry](https://docs.langchain.com/oss/javascript/langgraph/interrupts)
- [Supported update and checkpoint streaming](https://docs.langchain.com/oss/javascript/langgraph/streaming)

## Concrete graph

`normalize_intake → triage_ticket → lookup_authorized_account → retrieve_evidence → propose_action → evaluate_policy` is the shared entry path. Failed account authorization branches directly to escalation, without evidence retrieval.

Policy branches to answer-only bookkeeping, `record_escalation`, `record_denial`, `create_approval`, or `revalidate_action`. The approval path persists its request, updates the external ticket to waiting, and reaches the dedicated `await_approval` interrupt. Resumption carries only a reference to a durable decision. `validate_recorded_decision` reloads and verifies it; rejected, expired and escalated decisions cannot reach execution.

All newly permitted actions pass `revalidate_action → execute_action → reconcile_or_escalate`. Confirmed, unknown, denied and non-action paths converge on `update_ticket → compose_response → publish_support_result → finalize_run`. A graph ending is not itself a resolution: canonical `run.stage` distinguishes completion, rejection, escalation, failure, partial completion and unknown outcomes.

The trace viewer derives graph nodes and edges from `getGraphAsync()`, visited nodes from actual stream/business events, and checkpoint history from `getStateHistory()`. It does not display an unrelated decorative flowchart.

## State and identity

Each support run has independently generated run, ticket and thread IDs, plus graph/schema/config/policy versions. Invocation IDs change on each initial/resume/recovery attempt. Graph state contains bounded references and summaries: run/tenant IDs, versions, evidence IDs, proposal/approval/operation/receipt IDs, decision reference, stage, route, steps and a structured error summary. Checkpoints do not contain service instances, customer databases, evaluation labels, secrets or hidden reasoning.

Canonical SQLite remains authoritative for permissions, balances, decisions and execution receipts. Node wrappers reload the run from trusted storage, call ordinary services, save canonical results and return small state updates. A model cannot choose a graph destination or access a generic write executor.

## Durability and interrupts

The graph compiles with the official file-backed SQLite saver and each invocation passes `durability: 'sync'`. The business and checkpoint databases are separate files, both using WAL and full synchronous persistence. This adds storage work; it is intentionally not presented as a speed improvement.

The interrupt node contains no financial side effect and does not catch the LangGraph interrupt signal. Its request is persisted in the preceding idempotent service under a stable ID derived from the run. Re-entry repeats neither approval creation nor a refund. A decision transaction records the actor, exact proposal hash and revision and queues the original run. It never calls billing directly.

## Recovery, bounded work, observability

The runner uses a SQLite compare-and-set queue and a database-recorded process owner. Another live local process cannot advance threads concurrently. On a detected dead owner, a new process reclaims unfinished execution requests. This is a one-host demonstration; PID ownership is not a distributed lease protocol.

Synchronous node services, persisted step/read/ticket counters, a configured active execution budget and SDK recursion limit bound work. Read-only transient retries use short bounded backoff; financial uncertainty is never retried as a read. There are no model calls, so the model-call count stays zero and the configured model budget is not consumed. Approval waiting does not consume active execution time. Invocation time includes SDK/checkpoint overhead; `nodeMs` and `overheadMs` separate service work from the remaining local orchestration/persistence cost. Crash-before-accounting intervals cannot be reconstructed exactly and are not claimed as benchmark-quality timing.

The supported `updates` and `checkpoints` stream modes generate versioned, redacted events in canonical storage. Business events persist independently of a live stream. Optional tracing is not enabled and no LangSmith endpoint is required.

LangGraph is not FieldKit's authorization system, billing database, distributed-scheduling proof, or production-readiness certification. Durable approvals and explicit recovery are the reasons to use it here; no multi-agent supervisor is needed.
