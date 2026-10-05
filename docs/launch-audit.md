# Launch security and performance review

Review date: **2026-10-04** (America/Toronto). Baseline: `32998021800c98be9b743a234d3fd0ba76883103`. This review covers the local changes made after that commit. It is a focused source review and regression exercise, not an independent penetration test or a production capacity certification.

## Findings addressed

| Priority         | Finding                                                                                                                                                               | Change and evidence                                                                                                                                                                                                                                                                                                                                                                      |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| High             | Request URL parsing happened outside the async request handler’s error boundary. A malformed target could cause an unhandled rejection and terminate the API process. | Parsing is inside the boundary and returns `400`. A raw-HTTP regression sends `//[` and verifies that the next health request still succeeds.                                                                                                                                                                                                                                            |
| Medium           | An unsupported Authorization header could fall back to a browser session; customer-session fallback did not require a verified contact.                               | Explicit credentials cannot borrow cookie authority. Session-only endpoints reject Authorization headers, and customer fallback requires verification. CSRF checks remain separate from independently authenticated email/Zendesk webhooks.                                                                                                                                              |
| Medium           | Unbounded concurrent event streams, ignored write backpressure, and replay from zero on reconnect multiplied database and client work.                                | Per-actor/process limits, non-overlapping polls, cleanup on close, five-minute lifetimes, permission rechecks, and socket backpressure. Resume with `Last-Event-ID`; new subscriptions start at the current authorized cursor with a refresh event. Workspace filtering scans bounded 100-event batches.                                                                                 |
| Defense in depth | Production pages only restricted framing; asset paths, caching, and compression lacked explicit controls.                                                             | A production CSP restricts scripts, frames, and connections; disables object embedding; and allows Google Picker only when configured. Added Permissions-Policy and HTTPS-only HSTS. Static delivery rejects hidden/invalid paths and missing assets, streams files, and supports HEAD, ETags, immutable hashed assets, Brotli, and gzip. Private responses do not enter static caching. |
| Performance      | Workflow/settings/portal/customer screens loaded eagerly.                                                                                                             | Route-level lazy loading; the customer profile has a local Suspense boundary so loading does not disrupt inbox keyboard focus.                                                                                                                                                                                                                                                           |
| Performance      | Shadow dashboards recomputed dependencies for every candidate; SLA events retried inserts for already-observed message history.                                       | Share dependency reads only inside each dashboard request. SLA selects unseen, delivered observations and emits one transactional queue wakeup per event. Fresh authority checks and delayed-delivery detection remain intact.                                                                                                                                                           |
| Performance      | Workspace-wide event cursor and conversation-time reads lacked matching indexes.                                                                                      | Additive schema **18** adds `(workspace_id,id)` on events and `(workspace_id,conversation_id,created_at,id)` on messages. Readiness checks the shared schema version.                                                                                                                                                                                                                    |

Existing controls reviewed include scope-bound credential encryption, outbound HTTPS/DNS restrictions, structured model validation, private attachment access, approval/recovery boundaries, authenticated webhooks, and isolated runner configuration. Existing safety regressions continue to exercise these controls; this review does not claim every possible exploit was ruled out.

## Measured changes

The before/after build used the same installed dependency versions and local Node runtime. The baseline was rebuilt from `git archive` in a temporary directory. Initial JavaScript totals include all script/module-preload entries in the generated `index.html`, not just the largest chunk. Sizes are decimal kB.

| Measurement                                                                                  |           Baseline |                                                                         Updated |
| -------------------------------------------------------------------------------------------- | -----------------: | ------------------------------------------------------------------------------: |
| Initial JS, minified bytes                                                                   |           601.2 kB |                                                    488.6 kB (**18.7% smaller**) |
| Initial JS, gzip level 9                                                                     |           177.4 kB |                                                                        147.4 kB |
| Initial JS, Brotli quality 9                                                                 |           162.1 kB |                                                                        136.7 kB |
| Compressed delivery by the application server                                                |    Not implemented |                                    Prebuilt gzip/Brotli, negotiated per request |
| Shadow dependency reads, 100 candidates on one channel                                       |        600 queries |                                           6 queries; 10 total dashboard queries |
| SLA duplicate message-observation INSERT attempts, 101 previously observed customer messages | 101 per sync event | 0; 3 domain queries for policy, conversation, and the new authority observation |
| SLA queue wakeups, 100 new customer observations plus authority observation                  |                101 |                                                      1, in the same transaction |

Optional routes still download their own chunks when visited. Compression is done at build time, not on every request. These are bundle and query-count measurements, not end-to-end latency or throughput promises. No representative multi-user load test was run.

## Verification for this change

- **175 backend tests passed**, including new raw HTTP, authentication, event privacy/revocation, replay/cursor, stream-limit/backpressure, filtered batch, static compression/cache, SLA, and shadow query-count regressions.
- Strict TypeScript checks (`--noUnusedLocals --noUnusedParameters`) and the production build passed; the previous large-chunk warning is gone.
- **33 archived demo tests passed**, reported separately from application/provider evidence.
- `npm audit` reported **0 known vulnerabilities** across the locked root dependency tree at review time. No dependency versions changed. CI now also checks dependency advisories and unused TypeScript bindings.
- Gitleaks found **0 leaks** in all 19 Git commits and in a temporary copy of tracked/current untracked source files. Ignored local credentials, uploads, and databases were excluded from that source copy.
- The **complete browser journey passed in 1.4 minutes**, covering staff/customer onboarding, knowledge, workflows/components, mobile and keyboard navigation, profile-loading focus, ticket/email replies, attachments, and operational controls. It also recorded **zero production CSP violations** on the staff page. Browser Zod validation is configured without dynamic-code probing; `unsafe-eval` is not enabled.
- An actual **schema-17 baseline → schema-18 upgrade** passed on the disposable test database. It retained the synthetic message and queued run, created both indexes, and passed a repeated migration. No real installation data was used.

Tests use disposable `_test` PostgreSQL data, captured mail, and model/provider doubles. No paid model calls or live business writes were used. Existing user installations were not migrated or restarted. The local runtime is Node **25.5.0**; Node **24** remains the deployment/CI target.

## Scanner CI follow-up — 2026-10-05

The [diagnostic run](https://github.com/nahid-sparktales/fieldkit/actions/runs/37271407818) reproduced the failure with the original startup order. The daemon reported database **28136**, dated **2026-09-27 06:26:12 UTC**, nearly **192 hours** old. Meanwhile `sigtool` verified database **28143** on disk, dated **2026-10-04 06:25 UTC**. Parsing was correct; the **48-hour** gate correctly rejected the old loaded engine.

The bundled entrypoint started freshclam and clamd concurrently. An update could finish before clamd's notification socket existed, while its startup file snapshot already reflected the new database. Reducing `SelfCheck` to 60 seconds alone did not repair that race. `scanner/start.sh` now finishes a foreground update before starting the daemon and background updater. Update failure blocks startup. No image/dependency versions, application clocks, or freshness limits changed.

The [full verification run for `6d84d50`](https://github.com/nahid-sparktales/fieldkit/actions/runs/37271848160) **passed**: **176 backend tests**, **33 archived demo tests**, strict TypeScript, dependency audit, production/browser builds and journey, real isolated Python/JavaScript execution, the Node 24 Docker image, Compose installation/migrations/worker restart, and **real clean-file/EICAR scans after initial startup and a retained-volume scanner restart**. Additional freshness regressions reject malformed, future, and expired timestamps before streaming any file. Failure diagnostics report the bounded daemon version, parsed date, clock, age, configured limit, and reason; they do not include files or credentials.

This closes the repository's real scanner and container CI blockers. Each deployment must still verify its own private scanner, current signatures, network, and clean/EICAR behavior before enabling attachments. Local Docker remains unavailable; the real-engine evidence above came from GitHub's Linux runner. Model/provider doubles remain separate from real connector verification.

## Outstanding launch gates

1. **Real connected services:** verify dedicated SMTP receipt/inbound mail, models, Google Picker/OAuth, Notion, Zendesk, Stripe test mode, and custom test APIs as applicable. Automated payload/provider doubles and a CSP allowlist are not live-account verification.
2. **Deployment operations:** complete a restore drill and expected-traffic load test on the deployment hardware. Configure TLS, proxy body/connection/rate limits, private runner/scanner networking, monitoring, and matching database/upload/secret backups. Proxy-aware per-client throttling belongs at the trusted edge; application auth limits currently use the socket peer.

## Upgrade and client notes

Back up first, stop app/worker, build, migrate to schema 18, and restart both on the same revision. Index creation needs a maintenance window for large databases. Existing workflows and stored application records are preserved. Backups and production migration execution were not part of this local audit.

SSE’s no-cursor behavior now subscribes to current changes; use `?after=0` explicitly for retained history. Custom consumers should handle `stream.connected`, keep the last event ID, and respect `429` backoff. See [API cursor semantics](api.md#event-stream-cursors-and-limits) and [operations](operations.md#launch-hardening-and-delivery-performance).

The README’s local links were checked, and both header SVGs match the supplied logo ZIP byte for byte. GitHub private vulnerability reporting is enabled.

The public README now leads with the supplied Navigated Support light/dark logo, a concise feature table, separate sandbox/self-host instructions, security boundaries, and release status. Existing `FIELDKIT_*`, SDK, CLI, widget, and repository names remain compatible.

## Reference

Scanner settings follow the official [ClamAV 1.5.4 configuration](https://github.com/Cisco-Talos/clamav/blob/clamav-1.5.4/etc/clamd.conf.sample).

The optional Google policy follows the origins documented in the official [Drive Picker component CSP guidance](https://github.com/googleworkspace/drive-picker-element/tree/main/packages/drive-picker-element#content-security-policy-csp); real Picker verification remains an open gate. HTTP resource limits and backpressure are implemented using the [Node HTTP API](https://nodejs.org/docs/latest-v24.x/api/http.html).
