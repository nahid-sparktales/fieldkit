# Local deployment guide

## Install and start

1. Install Node 24 LTS or a supported Node >=22.12 runtime and npm.
2. Run `npm ci` in the repository. Native SQLite may require normal platform C/C++ build tooling when a prebuilt package is unavailable.
3. Run `npm run dev` and open [http://localhost:4317](http://localhost:4317).

This one process serves the API and Vite development UI. `npm run build && npm start` serves the built frontend from the same loopback API server. The app never requires a second Python server, database service, embedding store, cloud account, or model key.

The checked-in `.env.example` documents optional variables. The process reads environment variables, not a dotenv file:

```sh
FIELDKIT_PORT=4318 FIELDKIT_DATA=.fieldkit-second-demo npm run dev
```

The data path selects a disposable local demo environment. Use distinct paths for concurrent independent servers. The server refuses external hostnames and cross-origin requests. Do not expose it publicly or tunnel its open demo-session selector.

## Persistence and initialization

Startup applies SQLite table migrations idempotently and seeds only deployments that are absent. It preserves existing invoices, runs, approval decisions and checkpoints. `init` never silently overwrites an existing deployment; because normal startup seeds the four fixture deployments, `npm run fieldkit -- init acme` correctly reports a conflict on an ordinary initialized demo.

`application.sqlite` contains the canonical application tables; `checkpoints.sqlite` contains LangGraph state. Source configuration and fixtures stay in `customers/`. Discovery creates `.fieldkit/customers/<tenant>/` working copies. Remediation writes and versions those copies and records who chose the change. Evaluation reads them; current deployment canonical state is separate. Reset reseeds the selected deployment from immutable baselines, preserving the reviewed discovery working copy.

## Configuration precedence

`ConfigSchema` requires `schema_version: 1` and rejects unknown settings. Source files use JSON, a valid unambiguous configuration format, rather than adding a YAML parser. The graph/engine/checkpointer/mode settings are literal supported values. Limits are explicitly translated to recursion, persisted attempt and active-time budgets; the configuration object is never passed wholesale to the SDK.

Canonical deployment configuration controls normal execution. The recorded initial snapshot controls full-case rerun initialization. Discovery/evaluation working copies control scans and isolated suites. Configuration hashes and policy versions bind proposals; a current material mismatch blocks a pending action.

Current authoritative policy sources outrank guides/imports. Expired/future authoritative sources cannot authorize writes. Equally authoritative conflicting refund permissions escalate; no arbitrary confidence score breaks the tie. Explicit manager-reviewed remediation selects the published policy and retains the former finance draft as non-authoritative history with a versioned audit record.

`fast` and `reasoning` are routing aliases for the deterministic triage/proposal stages. They are not model names. Live mode is unsupported and rejected; there is no deceptive working toggle.

## CLI and integration clients

The CLI needs the local API. It selects a labeled local manager persona unless `FIELDKIT_TOKEN` is provided. `FIELDKIT_URL` changes its server URL; `FIELDKIT_CUSTOMER` selects scope for trace commands. API IDs remain tenant-scoped. The SDK uses a session token. MCP requires one and cannot create/elevate it. See the [integration contracts](integrations.md).

## Testing and CI

`npm test` runs isolated temporary-database tests, including fresh child processes and a real MCP client/server exchange. `npm run test:recovery` narrows to crash/resume assertions. `npm run check:compat` separately proves the pinned SDK/checkpointer combination.

Browser verification requires `npx playwright install chromium` once. `npm run test:browser` builds on the existing production build and starts a separate loopback server on port 4320 with its own data scope. It captures real screenshots in `docs/screenshots`. CI installs dependencies and browser binaries, then runs typecheck, build, tests, browser tests and the offline smoke regression test. It never enables paid evaluations or real connectors.

## Operational ceiling

The runner serializes local work through SQLite ownership plus job revisions. HTTP requests remain short and evaluation yields to the event loop between cases. This is not a distributed queue or multi-host lease system. Larger deployments would need real identity, provider-specific secret/authentication handling, a job runner with robust ownership leases, production observability, retention and backups, and a independently approved rollout plan.
