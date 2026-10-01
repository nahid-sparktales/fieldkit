# FieldKit

Self-hosted AI support with a customer portal, embedded chat, a staff inbox, and Zendesk integration. Bring your own knowledge and OpenAI account. FieldKit retrieves evidence and proposes actions; application code controls identity, approval, and execution.

Apache-2.0 licensed. This repository is private during development. **Version 2 is a breaking replacement of the original demonstration.** Fresh installations contain no fictional businesses, customers, connections, or credentials. The original is preserved at the `demo-v1` tag and in `examples/demo` (`npm run demo`, explicitly invoked).

## What is implemented

- Verified email/password accounts, recovery, staff invitations, workspace roles, isolated customer history, and server-signed widget identities.
- Guided setup, model connection, document review, answer preview, publishing, customer accounts, articles, ticket conversations, private notes, assignment, approvals, and human takeover.
- **Knowledge → FAQs:** write and edit FAQ drafts, improve an answer with AI, or generate up to eight drafts from customer-approved knowledge. Approve each answer for retrieval and optionally publish it in the help center. Editing withdraws the previous answer until it is approved again; manual drafting requires no model key.
- PDF, DOCX, Markdown, text, individual website pages or entire public documentation sites (Docusaurus/GitBook), selected Notion pages, Google Picker files, and Zendesk help-center articles. Background ingestion, extraction errors, per-page versions and citations, manual refresh, and hourly synchronization. Imported knowledge starts staff-only; approval for customer answers and public article publication are separate controls.
- OpenAI Responses structured outputs inside LangGraph, PostgreSQL checkpoints, tenant-scoped pgvector/keyword retrieval, citations, actual usage accounting, and workspace token budgets.
- Zendesk OAuth, signed webhooks, paginated synchronization, public replies, notes, tags, assignment, status, safe updates, and uncertain-outcome reconciliation.
- Separate Stripe test/live connections, purchase/subscription retrieval, full or partial refunds, and selected-subscription cancellation at period end. Fixed-destination custom APIs with schemas, reviewed customer mappings, exact approvals, automatic limits, durable operation IDs, and outcome lookup.
- A `/v2` API, event streams, authenticated SDK/CLI/MCP, durable PostgreSQL jobs, a separate worker, health checks, and Docker Compose packaging.

## Installation

Use a server with Docker Compose, a TLS reverse proxy, a domain, SMTP, and an OpenAI API key. Node 24 is needed only for the local setup command; alternatively use the Node container below.

```sh
git clone git@github.com:nahid-sparktales/fieldkit.git
cd fieldkit
node scripts/setup.ts
# Alternatively: docker run --rm -v "$PWD:/app" -w /app node:24 node scripts/setup.ts
```

Edit the generated, ignored `.env`: set `FIELDKIT_URL` to your public HTTPS origin, `SMTP_URL`, and `SMTP_FROM`. Preserve the generated secrets and database password. Then:

```sh
docker compose up --build -d
docker compose logs --tail=50 migrate app worker
```

Proxy the public domain to `127.0.0.1:4317` with streaming enabled. PostgreSQL is private to the Compose network. App and worker share the persistent uploads volume. Migrations finish before either starts. See [operations](docs/operations.md) for TLS, backup, restoration, upgrades, and key rotation.

Open the app, register, verify your email, and create the first workspace with `FIELDKIT_SETUP_TOKEN` from `.env`. Invite staff from Team. Connect OpenAI, add knowledge, approve customer-safe sources, try a question, configure actions, and publish your channels. Replies initially require staff review; automatic replies are an explicit workspace setting. Account-changing actions initially require approval independently of reply mode.

## Verification status

This is an implemented release candidate, **not a claim that the external release gates have passed**. Local database, safety, recovery, and browser tests use dedicated test databases and injected provider/model doubles. They do not establish real model quality or vendor compatibility. Live SMTP, model, Zendesk, Notion, Google, Stripe, and custom API test-account runs remain release blockers until their evidence is recorded. See [release gates](docs/verification.md).

```sh
npm ci
npm run typecheck
npm run build
# TEST_DATABASE_URL must point to a disposable database ending in _test.
npm test
npx playwright install chromium
npm run test:browser
npm run test:demo
```

Tests delete the contents of the dedicated test database. Never point them at installation data. Model doubles live only under `tests/`; the running app has no simulation switch. A separate opt-in live evaluation set is available with `npm run test:live` and reports missing credentials as blocked.

For local development, configure PostgreSQL 17 with pgvector, run `npm run migrate`, then run `npm run dev` and `npm run worker` in separate terminals. Real signup still needs SMTP.

## Guides

- [Integrations, identities, and custom actions](docs/integrations.md)
- [Installation and operations](docs/operations.md)
- [Architecture and authorization](docs/architecture.md)
- [API, SDK, CLI, and MCP](docs/api.md)
- [Verification and external release blockers](docs/verification.md)

One installation on one server and one agent configuration per workspace are the initial deployment boundaries. Paid hosting, subscriptions, included model credits, OCR, arbitrary scripts, and unrestricted agent HTTP access are outside this release.
