# Readiness, customer files, deadlines, and rollout

These features use the existing PostgreSQL database, transactional pg-boss jobs,
LangGraph execution, and staff permissions. Migrations 14–17 add their records;
all paid checks, attachment admission, SLA policies, reminders, shadow experiments,
and canaries start disabled. No historical automation is enrolled by migration.

## Readiness

Open **Readiness**, also linked from Setup, Connections, Publish and Activity.
**Run safe checks** performs local checks and bounded provider reads. Viewing the
page or infrastructure health endpoints never calls a model or sends email.
Owners/admins launch checks and record manual notes; agents can inspect evidence.
Only owners can require strict readiness for future publication.

Evidence level (configuration, authenticated access, exact read, dedicated write,
manual attestation) is separate from current health (current, stale, degraded,
blocked, failed, running, canceled or uncertain). Each run records its initiator,
operation, environment, definition version, configuration fingerprint, dates and
sanitized evidence. A result covers the displayed operation only. A successful
model access check is not evidence of valid generated answers. SMTP acceptance is
not inbox receipt. Manual notes never upgrade automated evidence or bypass a
security rule. Injected test adapters are explicitly labeled local evidence.

Checks expire after 5 minutes for installation/scanner/SLA/shadow processing,
60 minutes for knowledge dependencies, and 24 hours for provider capabilities.
Relevant settings and credential revisions invalidate evidence immediately;
ordinary OAuth token refresh does not. Source checks inspect at most 20 selected
Drive files or shared Notion pages per check; remaining selections are shown as
untested. Knowledge retains the full extraction/indexing state. Zendesk reports
observed authenticated webhooks separately from ticket-read permissions. Declared
OAuth scopes are shown when the provider returned them; existing connections may
have unknown declared scopes, so successful reads establish only actual access.

Paid response/embedding probes require an explicit token cap within the workspace
budget. Reported tokens and unresolved reservations remain separate. SMTP and
Postmark tests require a dedicated mailbox. Reply to the Postmark challenge from
that same mailbox within 30 minutes through the configured authenticated inbound
handler. This creates diagnostic evidence, not a customer ticket.

Explicit dedicated write checks are available for:

- A private note on an **unlinked** Zendesk ticket tagged `fieldkit_diagnostic_test`.
  It uses the original update timestamp and safe-update check. Outcome lookup
  searches bounded audit pages for the exact diagnostic operation marker.
- A 1–100 minor-unit refund on an exact **Stripe test-mode** charge, or period-end
  cancellation of an explicitly selected test subscription. Both the customer and
  resource must have metadata `fieldkit_diagnostic=true`, and ownership must match.
  The diagnostic operation ID is the Stripe idempotency key. Live Stripe writes
  are intentionally unavailable in diagnostics.
- An enabled fixed custom action with `config.diagnosticTest=true`, input/output
  schemas, and a verified staff-mapped contact whose external ID starts
  `fieldkit-test-`. Writes additionally require idempotency and outcome lookup.
  Mark only a dedicated test endpoint this way; it grants no production authority.

Cancellation does not undo dispatched effects. An uncertain write cannot be
retried: **Look up original outcome** performs provider reads, never another
write. If credentials or resource access changed, inspect the original provider
and record an attributable manual note. No repository-wide vendor certification
is implied by workspace evidence.

Strict readiness is opt-in and does not unpublish existing channels. Existing
publication checks always remain active. Enabled attachments additionally require
a working scanner even when strict readiness is off.

For automation, create a **diagnostic summaries only** service key in Settings.
`FieldKitClient.readiness()` and `npm run fieldkit -- readiness` read the cached,
sanitized `/v2/workspaces/:ws/readiness/summary`. `diagnostics:read` grants no check
execution, history/transcript access, publication, approvals or owner privileges.

## Customer attachments

Owners enable **Publish → Attachments** only after the private scanner is healthy.
Anonymous uploads are a separate default-off setting; existing anonymous text
chat does not depend on scanning. Native tickets, chat, staff replies, private
notes and authenticated inbound email use the same admission and visibility rules.

Supported files are PNG/JPEG screenshots, PDF downloads, UTF-8 `.txt` and `.log`.
The server checks extension, detected bytes, actual length, declared type, quotas
and malware verdict. PDFs stay download-only; staff image previews are decoded,
bounded, stripped of metadata and served as PNG. Text previews are escaped.
Files never enter knowledge retrieval or model input automatically. A file-only
message goes to staff and still creates an eligible SLA response obligation.

| Limit                      | Default                                      | Operator maximum                |
| -------------------------- | -------------------------------------------- | ------------------------------- |
| Per file                   | 8 MiB                                        | 20 MiB                          |
| Files per message          | 5                                            | 10                              |
| Decoded bytes per message  | 20 MiB                                       | 40 MiB                          |
| Workspace reserved storage | 1 GiB                                        | 100 GiB                         |
| Anonymous upload           | 2 files, 2 MiB each, 4 MiB total             | Also bounded by operator limits |
| Concurrent scans           | 2                                            | 4                               |
| Scanner deadline           | 30 seconds                                   | 120 seconds                     |
| Signature age              | 48 hours                                     | 168 hours                       |
| Text preview               | 64 KiB                                       | Fixed                           |
| Image preview              | 640 pixels, 2 MiB output, 20M decoded pixels | Fixed                           |

`uploading → quarantined → scanning → available`; failures become `blocked`,
`scan_failed`, `canceled`, or `deleted`. Upload completion never grants download
access. Quotas are reserved under a workspace lock. Private randomly named files
are fsynced before the scan job is acknowledged. Scan generations and authorization
are rechecked after I/O. A late worker cannot resurrect deleted files. Customers
can download only their own delivered public files; private-note files stay staff-only.
Anonymous uploads require a valid existing conversation capability.

Use `FIELDKIT_CLAM_HOST=scanner` and the Compose `attachments` profile. ClamAV has
no public port and sends no files to a cloud scanner. Signatures need update access;
reserve 4 GiB for the scanner. A missing/stale/unavailable engine fails closed while
unrelated text support continues. See `.env.example` for limits. Verify private
network reachability from both app and worker, then enable a workspace's files.

On every container start, `scanner/start.sh` completes a foreground signature
update before launching clamd and its background updater. An update failure stops
startup; Compose retries it under the existing restart policy. This prevents the
daemon from keeping an old database loaded when an update finishes before its
notification socket exists. The application still checks the **loaded** signature
date before each scan, with the unchanged default maximum age of **48 hours**.

```sh
docker compose --profile attachments up --build -d
# Explicit actual-engine clean/EICAR smoke test, only after configuring the scanner:
docker compose exec -T app npm run test:scanner -- --live-scanner
```

The smoke test uses the standard harmless antivirus test marker, not real malware.
Failures print JSON diagnostics: the bounded daemon version reply, check time,
parsed signature time, age in hours, configured limit, and a reason. `stale` means
the loaded signatures exceed the limit; `invalid_timestamp` means parsing failed;
`future_timestamp` means the date is more than five minutes ahead of the app clock.
Check UTC clocks and `docker compose logs scanner`; for stale signatures, verify
the download completed and restart the scanner so it refreshes before loading.
An unavailable socket during startup is distinct from stale signatures. Never
change clocks or relax the age limit to make verification pass. CI exercises real
clean-file/EICAR detection after both initial startup and a retained-volume restart.

Mock scanner tests do not verify a real engine. Configure the reverse proxy to
accept `ceil(decoded message limit × 4/3) + 256 KiB` for inbound email; with defaults
use at least **29 MiB**. Direct upload requests remain limited to per-file bytes.
Server streaming limits still apply when Content-Length is absent or forged.

Inbound email is authenticated before parsing. Files are staged durably before a
successful webhook acknowledgement. Invalid individual files create blocked cards
while valid text survives. Oversized whole envelopes get an explicit failure;
reused message IDs cannot change content. Outbound email links to the authenticated
portal instead of sending binary copies. Zendesk binary forwarding is unsupported
and explicitly blocked; use native channels for files in this release.

Unsent uploads expire after 24 hours. Reconciliation recovers interrupted scans,
rotates through bounded orphan batches, and removes terminal bytes after a grace
period. Workspace retention removes originals and previews even when an unresolved
business operation prevents deleting the conversation. Minimal operation/hash
records may remain; they grant no download access. Apply retention to backups too.

## Needs attention and SLA policy

**Needs attention** shows deadline order, at-risk/overdue labels, staff notifications,
and policy settings. Inbox rows and conversation activity show deadlines. Owners
and admins edit policies; agents can inspect, mark notifications read and explicitly
mark a conversation waiting after a delivered staff response.

Policies are immutable versions with an IANA timezone, split business shifts,
holidays, ordered channel/priority rules and first/next/handoff response targets.
The first matching rule wins. UTC instants retain the frozen calendar. Arithmetic
uses elapsed minutes inside business hours via Temporal, including DST gaps/repeats.
An interval ending at closing time is inclusive for a deadline. Repeated local
opening uses the earlier instant and repeated closing the later; nonexistent local
boundaries advance to the compatible instant. No model calculates deadlines.

| Event                                                                 | Timer / automation behavior                                                    |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| First eligible customer message                                       | Starts earliest unanswered obligation                                          |
| More unanswered messages                                              | Retain original anchor; cannot extend the deadline                             |
| Delivered eligible response                                           | Satisfies once; late replies retain breach history                             |
| Draft, private note, handoff acknowledgement, shadow output, reminder | Never satisfies a response target                                              |
| New customer message after response/reopen                            | Starts a new cycle; prior history stays                                        |
| Human takeover                                                        | Keeps staff obligations; may add handoff target; cancels old waiting reminders |
| Assignment change                                                     | Does not reset elapsed time; pending mail rechecks recipient                   |
| Priority change                                                       | Recomputes from original start using frozen policy; keeps breaches             |
| Policy edit                                                           | Applies to new obligations; active changes require previewed recalculation     |
| Explicit waiting after delivered staff reply                          | Pauses active obligation; optional reviewed reminder needs separate permission |
| Customer reply/end waiting                                            | Cancels reminder; resumes remaining business time and recomputes thresholds    |
| Close, delete, disabled channel/policy                                | Cancels future effects                                                         |

Warnings and escalations are deduplicated by obligation/generation/threshold.
After downtime only the current relevant threshold is created, not a catch-up
burst. Routing uses current assignment or the frozen escalation recipient, falling
back to bounded owner/admin recipients. Reassignment does not generate another
notification for the same threshold. Staff email is opt-in; a durable sending
intent and stable Message-ID distinguish accepted, suppressed and uncertain.
Unknown SMTP outcomes are not automatically resent.

Waiting reminders require both an enabled exact administrator-reviewed template
and staff opt-in for that cycle. Default maximum is one, hard maximum three.
Immediately before publication and queued email send, Navigated Support rechecks status,
revision, source staff delivery, channel, actor, template/policy and newer customer
activity. No auto-close, account action or forced agent resume occurs. Zendesk
status remains authoritative; unknown historical response semantics are not inferred.

## Shadow comparisons and gradual rollout

Save a workflow draft, then open **Shadow & rollout**. Snapshot a candidate without
changing publication. It freezes the expanded graph/components, action policies,
response settings, approved knowledge versions, effective baseline and channel.
Editing a draft never edits an existing candidate. Optional model/provider overrides
are available in the candidate form and API; embeddings and the optional judge
keep their baseline settings.

An owner/admin authorizes a bounded experiment: sample percentage, duration,
maximum sampled turns, aggregate and per-run token caps, concurrency (1–2), and a
production token reserve (minimum 10,000). Default eligibility is verified customers.
Sampling uses a private stable HMAC and unique conversation revision. It includes
only future turns, with exclusions and missing/failed baselines visible separately.

A comparison starts from customer-visible history **before** the baseline answer.
Production may capture already-authorized account/API read results for the sampled
turn. Shadow receives only exact contract/input/customer/revision-matched fixtures;
missing or revoked fixtures block it. It never makes replacement business reads.
Customer attachment bytes are unavailable. Actual LangGraph execution runs with
business adapters denied and stops at the governed action proposal boundary.
Isolated code steps retain existing runner restrictions. Shadow creates no customer
message, approval, operation, delivery, checkpoint thread, SLA clock or notification.

Inspect baseline/candidate answers, citations, steps, proposed parameters, approval
requirements, usage and latency. Required rules, optional advisory AI assessment,
and staff review remain separate. AI scoring cannot override a failed hard rule or
publish. A one-turn comparison uses actual baseline history, not the candidate's
hypothetical prior replies; use Test Lab for autonomous multi-turn scenarios.
Shadow queue wait is not production p95, and shadow has no customer CSAT/resolution.

Shadow jobs have their own lower-concurrency queue and yield while production runs
are queued/running. Model and judge reservations atomically count against both the
experiment and workspace caps while preserving the configured production reserve.
An interrupted attempt stays uncertain until explicit retry; retained reservations
are not erased. Retention/source deletion hides or removes derived content without
resetting aggregate usage. Source, policy, connector replacement, actor or baseline
changes invalidate affected evidence; OAuth refresh preserves identity.

Canary launch is a separate explicit decision with passing staff-reviewed evidence,
percentage (1/5/10/25/50), duration, token cap and failure stop threshold. Only new
eligible conversations are assigned. Existing conversations are not enrolled;
assignment persists across turns and traffic increases apply only to new ones.

Candidate effects require the exact immutable version, rollout generation,
conversation assignment, current actor/dependencies, published channel and budgets,
as well as ordinary identity, action approvals, takeover and conversation revision
checks. No-rollout workflows retain their original version rules. Candidate effect
commits and the kill switch share an advisory fence; work not authorized before
that boundary is revoked. Provider requests whose intent was already committed
retain normal reconciliation; stopping cannot undo them.

| Change                                                                             | Result                                                                       |
| ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Draft edit                                                                         | Existing candidate snapshot unchanged                                        |
| Baseline/default/channel publication, credential replacement, source/policy change | Candidate authority invalid; pending work moves to staff                     |
| Customer mapping/revision change or takeover                                       | Existing conversation/action guards block stale effects                      |
| Stop, duration/cap limit, configured failure threshold                             | Revoke assignments and pending approvals/runs; unfinished work goes to staff |
| Increased percentage                                                               | Existing assignments unchanged                                               |
| Promotion                                                                          | Exact matching reviewed draft goes through normal workflow publication       |

Stop conditions count handed-off/stale candidate runs conservatively, including
intentional handoff. No interrupted request is silently replayed on the baseline.
Neither shadow reviews nor canary launch grant new action permissions.

## Upgrade and rollback

Stop app/worker and back up database, private upload volume and matching secrets as
one set. Build from the reviewed source, run `npm run migrate` (or the Compose
migration service), then start app and worker together. Schema 13 upgrades to 17
through additive migrations. Repeat migration is safe. Existing workspaces remain
unpublished/disabled exactly as before; new features are opt-in. No live migration
is part of this change's local verification.

Rollback by stopping both new processes and restoring the schema-13 backup with the
matching application revision, volume and secrets. Do not run the old application
against a partially downgraded database or remove new tables while jobs are active.
Before restoring, reconcile externally dispatched effects against the original
provider; restoring a backup does not undo email or account writes. Review retention
and customer access in an isolated restore before reopening traffic.

## Local versus live evidence

Backend/browser tests use a disposable `_test` database and explicit provider/model/
scanner doubles. The optional `npm run sandbox -- --operations` adds labeled local
readiness failure/recovery, clean/rejected files, overdue/canceled-follow-up examples,
a no-effect shadow proposal and a stopped unsent canary. It advances only its
injected SLA clock, captures email locally, and never runs in production startup.
Use a fresh sandbox for predictable scenarios; existing sandbox edits are preserved.

Live model/embedding, SMTP inbox receipt, Postmark routing, dedicated Zendesk/Stripe/
custom operations and a real private ClamAV engine remain independent release gates.
They require configured dedicated resources and operator authorization. See the
[verification guide](verification.md) for commands actually run and blockers.

Primary contracts: [ClamAV Docker packaging](https://docs.clamav.net/manual/Installing/Docker.html),
[ClamAV protocol](https://docs.clamav.net/manual/Usage/ClamdProtocol.html),
[OWASP upload controls](https://cheatsheetseries.owasp.org/cheatsheets/File_Upload_Cheat_Sheet.html),
[Postmark inbound](https://postmarkapp.com/developer/webhooks/inbound-webhook),
[Zendesk audit reads](https://developer.zendesk.com/api-reference/ticketing/tickets/ticket_audits/),
[Stripe refund creation](https://docs.stripe.com/api/refunds/create),
[Stripe subscription update](https://docs.stripe.com/api/subscriptions/update).
