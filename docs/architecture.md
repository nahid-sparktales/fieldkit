# Architecture

The Node HTTP application serves React and the versioned API. The worker runs pg-boss jobs against the same PostgreSQL database. PostgreSQL stores business records, pgvector chunks, Better Auth sessions, queue records, and LangGraph checkpoints in separate schemas. Uploads live in a persistent filesystem volume.

## Authority and identity

Workspace IDs in routes are selectors, never authorization. Every staff request derives membership from a verified Better Auth session. Owners configure actions and service credentials; owners/admins review knowledge, connections, mappings, and approvals. Agents handle conversations and notes. Customer requests are scoped to their contact identity. Service tokens are hashed, expiring, workspace-scoped, and limited to request creation/status and server-established identities. Widget tokens cannot access staff records.

Customer ownership comes from a verified portal account, a signed assertion from the business's server, or a staff-reviewed provider mapping. An email in a message, model-provided ID, or email match alone cannot grant account access. A Zendesk requester is an external contact; staff must review any link to a portal identity. Stripe test and live customer mappings are independent.

Application queries explicitly scope every resource to the authenticated workspace. This release uses application authorization and composite database constraints, not PostgreSQL row-level security. Direct database access is an operator privilege.

## A conversation turn

1. A message and its new conversation revision commit with the pg-boss job in one PostgreSQL transaction.
2. The worker enters the persisted LangGraph. The built-in route is retrieve → structured decision → policy → approval interrupt if required → revalidation → execution → publication. A published visual workflow replaces this route for new turns with its validated steps and outcome connections.
3. Retrieval includes only active customer-approved versions in the workspace. The model can answer, clarify, propose a named action, or hand off. It sees customer-visible messages, approved evidence, allowed action schemas, and reviewed account data. Internal notes and credentials are excluded.
4. Staff intervention and newer messages advance the revision. Each stage checks it. The final effect boundary locks the conversation, so a completed takeover prevents later automatic effects. An already-sent provider request cannot be recalled; it must be reconciled.
5. Approval binds the exact proposal, parameters, customer mapping revision, action/policy revision, connection revision, workspace revision, conversation revision, and evidence hash. Staff authority, expiry, evidence, provider ownership, and policy are checked again before execution.
6. Automatic replies and automatic account actions are independent settings. Uploaded text never grants execution authority.

Runs use per-conversation PostgreSQL advisory locks and revision checks. Turns within one conversation are serialized; new messages still invalidate an older in-flight response immediately. Only the current conversation revision can publish or execute. Unpublishing a channel pauses its conversations and revokes widget credentials; republishing does not silently resume paused conversations. All messages are independent records. SSE rechecks access and emits only customer-safe events to customers.

## Configurable LangGraph

`workflows` stores the editable draft and optimistic revision; `workflow_versions` stores immutable published definitions. Message enqueue snapshots the active version and definition onto the run in the same transaction as the job. The runtime compiles that definition into LangGraph nodes and conditional edges, expanding governed actions into approval interrupt, revalidation, and execution. PostgreSQL checkpoints resume the exact saved graph after restart. Older `support-v2` runs retain their original graph; configured runs use `support-v3`.

Publishing changes new turns and invalidates pending approvals. At the effect boundary the worker also checks that the run's workflow version is still active, including legacy runs created before the first publication. Custom code executes only in the optional isolated Docker runner. API reads use fixed public endpoints or existing customer-bound read actions; graphs cannot select arbitrary destinations or establish customer identities. Preview uses the same configured graph, including isolated computation and API reads, but stops before account-changing action execution and does not persist conversations or approvals. See [workflows](workflows.md) for steps, roles, and bounds.

## Durable effects

An operation ID, proposal hash, resource lock, and sent intent are committed before a provider write. Stripe receives that ID as its idempotency key and metadata. Custom APIs receive `Idempotency-Key` and `operationId`. A successful receipt is stored independently of the conversation transaction so process failure cannot erase knowledge of an external effect.

Timeouts and malformed responses after a write leave an unknown outcome. Reads can retry with bounded backoff; uncertain writes are never blindly replayed. Reconciliation locates Stripe metadata or asks the original configured custom lookup endpoint. Each operation stores its immutable action contract and identity for read-only reconciliation after later policy/mapping edits; this never revives an approval or authorizes a second write. Pending Stripe refunds remain unknown until confirmed. Unresolved operations prevent conversation retention from deleting their evidence.

Zendesk deliveries have a separate durable ledger. Ticket creation uses a stable external ID; updates carry audit metadata. Reconciliation searches external IDs/audits. Safe updates use Zendesk's timestamp; changed tickets invalidate queued automatic replies. Synchronization checks ticket audit comment IDs to suppress Navigated Support feedback loops. Zendesk is authoritative for externally handled ticket history/status.

## Knowledge and outbound access

Sources own immutable document versions. New content invalidates the old searchable version before indexing. Refresh errors, revoked access, disconnection, and deletion remove material from customer retrieval. Publishing an article requires customer approval and is independently revocable. Historical conversation citations remain historical records until conversation retention removes them.

Uploads are size bounded and stored under random server-generated names. PDF extraction is capped at 500 pages; image-only files report that OCR is required. Website ingestion accepts a selected public HTTPS page or a bounded documentation-site crawl using sitemaps and internal links. The crawler validates each redirect and stays within its permitted scope; other remote adapters reject redirects. Remote fetches reject non-public destinations, validate DNS results at connection time, and bound response size/time. Provider destinations are fixed. Custom action destinations and schemas are owner configured; the model cannot change them.

Credentials use AES-256-GCM with workspace/provider scope as authenticated data. Service/widget tokens are hashed at rest. Budget reservations prevent concurrent model calls overspending configured token limits. On an uncertain model failure, the reservation remains conservative; actual token counts are stored when the provider reports them.

## Deliberate deployment limits

One server, persistent local uploads, one agent per workspace, and invited business customers. Large document import/history limits produce visible errors rather than partial silent ingestion. There is no SaaS billing, bundled model allowance, OCR, unrestricted host code execution, or multi-region deployment. Provider registrations, DNS, TLS, SMTP, backups, and access governance remain operator responsibilities.

## Reusable workflow components

`workflow_components` stores the active library head and `workflow_component_versions` stores immutable schemas, code/API configuration, or subflow definitions. Publishing resolves workspace-scoped component references into `workflow_versions.compiled_definition`. Subflows expand into namespaced LangGraph nodes with input/output boundaries, preserving per-node checkpoints and action approval interrupts. Older published definitions without compiled snapshots continue unchanged.

`workflow_step_results` records bounded outputs, logs, failures, and input hashes independently of checkpoints. A recovered node reuses its completed result only for identical inputs and still-valid customer/action/connection proofs. Code is pure computation; API steps are reads. Those operations can repeat if a crash occurs before their result is recorded. Write effects remain in the existing governed operation ledger.

Step output is private by default. Explicit customer-safe output can supply template variables and cited AI evidence. Subflow inputs retain source visibility. Templates cannot execute code or interpolate secrets, and verified identity is rechecked before account data is published. Queued Zendesk replies additionally revalidate the pinned workflow, identity, and read proofs before delivery.

The optional runner accepts operator-authenticated requests and launches a disposable non-root Docker container per execution. It alone holds the host Docker socket; child containers have no socket, app files, credentials, network, or capabilities. Runtime images are fixed by the operator. See [runner setup and limits](workflow-components.md#enable-the-optional-runner).

## Quality measurement and evaluation

Schema 9 adds tenant-scoped suites, immutable quality jobs, per-turn evaluation results and staff review history, gap groups/aliases/occurrences, and answer-bound feedback. The existing pg-boss queues process evaluation/analysis batches and read-only feedback reconciliation. Job creation and queue insertion share a transaction. Evaluation context runs the existing compiled graph without checkpoint/customer write paths; saved fixtures replace every account/API read and business actions stop after parameter, identity and policy checks. Only the existing isolated runner executes code.

An async usage context attributes retrieval/response/judge calls and enforces run caps and optional daily analysis caps inside the workspace budget lock. Provider-reported usage replaces reservations; ambiguous attempts retain reservations. Persisted completed turns are reused; interrupted model attempts require an acknowledged retry. Workers recheck the initiating administrator, source versions, imports, cancellation and scheduled-owner authority.

Gap evidence points to the original customer message and survives later follow-ups. Feedback updates keep history, and current resolution confirmation is calculated against later customer messages. Delivered timestamps and explicit transition events drive metrics; historical unknowns are not reconstructed. Retention/deletion removes derived transcripts and invalidates imported cases while preserving aggregate model accounting.

## Operational controls

Migrations 14–17 add diagnostic evidence, attachment lifecycle records, SLA obligations and shadow/rollout authority. Focused `readiness`, `attachments`, `sla`, and `shadow` services use existing transactional queues. Database event/turn hooks capture bounded observations; only canary runs carry explicit rollout generation/assignment authority. Ordinary version checks remain unchanged. Attachment bytes are excluded from model inputs. See [states, isolation and transitions](operational-controls.md).
