# Navigated Support

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="apps/web/public/brand/horizontal-dark.svg" />
  <img src="apps/web/public/brand/horizontal-light.svg" alt="Navigated Support — Guide · Resolve · Together" width="960" />
</picture>

An open-source, self-hosted AI support platform, previously called FieldKit. Add an agent to your Zendesk operation, or publish your own help center, embedded chat, and customer portal with a staff inbox. Both use the same knowledge, visual LangGraph workflow, verified customer identities, and governed business actions.

Bring your own model provider and documents: OpenAI, Claude, Kimi, OpenRouter, DeepSeek, vLLM, or another OpenAI-compatible service. Navigated Support retrieves evidence and proposes actions; application code controls identity, approval, and execution. Your application data, uploads, and encrypted credentials live on your server; model inputs and enabled provider requests are sent to the services you connect.

**Status: development release candidate.** The application and automated tests are implemented; several real vendor test-account verification gates remain open. See [verification and release boundaries](docs/verification.md) before using it for customer-facing operations.

Licensed under [Apache-2.0](LICENSE). **Version 2 is a breaking replacement of the original demonstration.** Fresh installations contain no fictional businesses, customers, connections, or credentials. The original is preserved at the `demo-v1` tag and in `examples/demo`. To run it explicitly, install its separate dependencies with `npm ci --prefix examples/demo`, then run `npm run demo`. Its SQLite dependencies are excluded from the production installation.

## What is implemented

- **Readiness:** cached operational evidence, safe checks, explicit budgeted model/mail tests, dedicated resource probes and uncertain-outcome lookup.
- **Private customer attachments:** screenshots, PDF downloads and logs with quarantine, private ClamAV scanning, authenticated access and safe staff previews. Admission starts off.
- **Needs attention:** versioned business-hour SLA policies, response deadlines, staff notifications and reviewed waiting reminders. Automation starts off.
- **Shadow & rollout:** immutable no-effect workflow comparisons, captured read fixtures, bounded budgets, staff review and separately authorized gradual rollout with a kill switch. [Operational controls guide](docs/operational-controls.md).

- Verified email/password accounts, recovery, staff invitations, workspace roles, isolated customer history, and server-signed widget identities.
- Guided setup, model connection, document review, answer preview, publishing, customer accounts, articles, ticket conversations, private notes, assignment, approvals, and human takeover.
- **Knowledge → FAQs:** write and edit FAQ drafts, improve an answer with AI, or generate up to eight drafts from customer-approved knowledge. Approve each answer for retrieval and optionally publish it in the help center. Editing withdraws the previous answer until it is approved again; manual drafting requires no model key.
- **FAQ agent:** review every passage of every ready, customer-approved document, including all indexed documentation pages. Durable background batches show progress, support cancellation/retry, and save private FAQ drafts. Source changes invalidate unfinished work; existing FAQs are excluded and repeated questions are skipped.
- **Focused staff inbox:** color-coded work queues, conversation previews, assignment filters, readable approval cards, per-ticket reply drafts, private notes, keyboard shortcuts, and a mobile conversation view. [Inbox UX guide](docs/inbox-design.md).
- **Inbox support assistant:** triage and prioritize a ticket, research across indexed sources, draft a customer response, package an engineering escalation, and turn a resolved ticket into a private knowledge-base article. Review and edit outputs with evidence before applying them. Internal research can use staff-only knowledge; customer replies cannot. Type `/customer-support` in a staff reply box to open the assistant.
- PDF, DOCX, Markdown, text, individual website pages or entire public documentation sites (Docusaurus/GitBook), selected Notion pages, Google Picker files, and Zendesk help-center articles. Background ingestion, extraction errors, per-page versions and citations, manual refresh, and hourly synchronization. Imported knowledge starts staff-only; approval for customer answers and public article publication are separate controls.
- Multiple model providers inside LangGraph, separate response and embedding settings, PostgreSQL checkpoints, tenant-scoped pgvector/keyword retrieval, citations, provider-reported token usage, and workspace budgets. Claude uses its native Messages API; OpenAI uses Responses; other providers use compatible Chat Completions. Every result is schema-validated. See [model setup](docs/models.md).
- **Test Lab:** repeatable multi-turn suites, fixture-based account/API reads, workflow/model comparisons, immutable run snapshots, separate rules/AI/staff assessments, token caps, and durable cancellation/retry.
- **Knowledge → Gaps:** grouped unanswered questions, feedback and staff flags; bounded AI analysis, owner opt-in nightly analysis, private FAQ suggestions, and regression-test imports.
- **Analytics:** native resolution and satisfaction feedback, delivered response times, handoffs/reopens, channel/date filters, conversation drill-down, and purpose-attributed tokens/reservations. Zendesk CSAT imports are read-only and still require real-account release verification. [Quality guide](docs/quality.md).
- **Workflow:** choose a guided step builder with starter templates and plain-language outcome menus, or visually edit the agent's actual LangGraph with draggable steps, outcome connections, customer-account lookup, selected knowledge/FAQs, model instructions, conditions, existing actions, approvals, exact replies, variable templates, and staff handoff. Reuse versioned subflows and Python/JavaScript/API steps with mapped inputs, outputs, and run logs. Save drafts, test routes without executing actions, publish immutable versions, and restore an earlier version as a new draft. See the [workflow guide](docs/workflows.md).
- Zendesk OAuth, signed webhooks, paginated synchronization, public replies, notes, tags, assignment, status, safe updates, and uncertain-outcome reconciliation.
- Separate Stripe test/live connections, purchase/subscription retrieval, full or partial refunds, and selected-subscription cancellation at period end. Fixed-destination custom APIs with schemas, reviewed customer mappings, exact approvals, automatic limits, durable operation IDs, and outcome lookup.
- A `/v2` API, event streams, authenticated SDK/CLI/MCP, durable PostgreSQL jobs, a separate worker, health checks, and Docker Compose packaging.

Use **Publish → Appearance** to customize the help center's logo, colors, welcome content, public name, article visibility, and website/privacy/terms links with desktop and mobile previews. The logo and accent also apply to the embedded chatbot. **Settings → My profile** manages your display name, password, and active sessions; **Settings → Workspace** renames the workspace without changing its public URL. [Branding and account guide](docs/branding.md).

## Try a local store sandbox

Run `npm run sandbox` with local PostgreSQL/pgvector available, then open [the store launch page](http://127.0.0.1:4321/). It creates a separate, persistent **Trail Supply** sandbox with staff/customer logins, policies, a portal and widget, starter tickets, refund/cancellation approvals, and Test Lab cases. Responses and payments are explicitly simulated; no model tokens or real orders are used. Restarting preserves edits; resetting requires `--reset`. Add `-- --operations` for clearly labeled operational-control scenarios in a fresh offline sandbox. [Setup and walkthrough](examples/store/README.md).

The project is now **Navigated Support**. The repository URL, `FIELDKIT_*` configuration, `fieldkit` CLI, `FieldKitClient` SDK, and `window.FieldKit` widget API retain their existing names for compatibility. See the [identity and brand assets](docs/branding.md#navigated-support-product-identity).

## Installation

Use a server with Docker Compose, a TLS reverse proxy, a domain, SMTP, and access to response and embedding models. A single OpenAI key covers the defaults; other providers and self-hosted models are supported. Node 24 is needed only for the local setup command; alternatively use the Node container below.

```sh
git clone https://github.com/nahid-sparktales/fieldkit.git
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

Open the app, register, verify your email, and create the first workspace with `FIELDKIT_SETUP_TOKEN` from `.env`. Invite staff from Team. Connect your model providers in **Connections**, select response and embedding models in **Settings**, add knowledge, approve customer-safe sources, configure actions, and test the agent. Use **Workflow** to customize and publish its graph, then publish a portal/widget or connect Zendesk. Replies initially require staff review; automatic replies are an explicit workspace setting. Account-changing actions initially require approval independently of reply mode.

In **Workflow**, choose **Guided steps** for a readable step list and starter templates. Select a step, choose **What happens next?**, or insert a step on an outcome. **Visual graph** provides the canvas; both views edit the same draft, including custom components, account settings, and action approvals. Save a draft, test its route, and publish a version when ready. Only routes reaching model/embedding steps use model quota. Previews can read a selected verified customer's account and run isolated code, but never perform account writes or send replies. [Full workflow guide →](docs/workflows.md)

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
npm ci --prefix examples/demo
npm run test:demo
```

Tests delete the contents of the dedicated test database. Never point them at installation data. Model doubles live under `tests/` and the explicitly invoked store sandbox in `scripts/store-sandbox/`; the normal running app has no simulation switch. A separate opt-in live evaluation set is available with `npm run test:live` and reports missing credentials as blocked.

For local development, configure PostgreSQL 17 with pgvector, run `npm run migrate`, then run `npm run dev` and `npm run worker` in separate terminals. Real signup still needs SMTP.

## Guides

- [Test Lab, knowledge gaps, feedback, and analytics](docs/quality.md)
- [Guided and visual LangGraph workflow editors](docs/workflows.md)
- [Custom replies, Python/JavaScript/API steps, subflows, and runner setup](docs/workflow-components.md)
- [Model providers and self-hosted vLLM](docs/models.md)
- [Integrations, identities, and custom actions](docs/integrations.md)
- [Installation and operations](docs/operations.md)
- [Architecture and authorization](docs/architecture.md)
- [API, SDK, CLI, and MCP](docs/api.md)
- [Verification and external release blockers](docs/verification.md)
- [Contributing and local development](CONTRIBUTING.md)
- [Reporting a security vulnerability](SECURITY.md)

One installation on one server and one agent configuration per workspace are the initial deployment boundaries. Paid hosting, subscriptions, included model credits, OCR, unrestricted host scripts, and unrestricted agent HTTP access are outside this release.

### Ticket support and live chat

Owners choose **tickets, chatbot, both, or neither** in **Publish → Channels**. The help center separates **Submit a ticket** from the bottom-right **Chat with us** pop-up; articles and existing ticket history remain available when new tickets are turned off. Tickets use a subject, message history, waiting states, and queued email notifications; the live assistant uses the widget channel. Feedback appears only after closure. Choose independent ticket/email, chat, and Zendesk graphs in **Workflow → Channel workflow**. Configure direct email replies and delivery recovery in **Publish → Email support**. See [customer support and email setup](docs/customer-support.md) for SMTP, Postmark inbound, security boundaries, and the local captured-email walkthrough.

The staff inbox includes searchable **Notes** and **Feedback** tabs alongside the message timeline, plus an expanded conversation view. Customers send feedback once after closing a conversation; “still need help” reopens native conversations for follow-up. Internal notes and rejected action proposals do not send customer notifications.

Organize the inbox by **customer** or **conversation**, with **Tickets** and **Chatbot** filters. The separate **Customers** section brings together account identity, support history, private customer notes, and reviewed provider links. Open the same profile from a ticket’s **Customer** tab; **Team** is reserved for staff access.

### Inbox layout and read sections

The desktop inbox places the conversation above a full-width queue. A compact composer keeps replies and internal notes close at hand while reserving more space for the transcript. Use **Open**, **Unread**, **Read**, **Closed**, or **All conversations**, then filter tickets/chatbot, customer, assignment, or status. Opening the conversation marks its loaded customer messages read for you; **Mark as unread** keeps it in your follow-up queue. Read does not mean resolved. The **Conversation size** slider adjusts the space between the viewer and queue. **Expand conversation** gives the viewer the full workspace, preserving unsent drafts. On mobile, switch between the queue and conversation with the back button.

Connections use locally bundled provider logos. Google Drive setup shows which OAuth/Picker settings are missing; see [Google integration setup](docs/integrations.md) for the required Cloud configuration. The offline store sandbox continues using local provider doubles and does not use live Google credentials.
