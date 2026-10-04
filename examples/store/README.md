# Trail Supply: persistent local store sandbox

This runs the current FieldKit application with a fictional outdoor store. It is separate from the archived `demo-v1` and the disposable automated test database. Nothing is seeded in normal installations.

## Start

Install root dependencies (`npm ci`) and have a local PostgreSQL server with pgvector available. With your normal local `.env` configured:

```sh
npm run sandbox
```

The command reuses only the local PostgreSQL host/port/login from `DATABASE_URL`, creates a **different database named `fieldkit_store_sandbox`**, builds the frontend, and starts both servers. It does not copy workspaces, customer data, provider credentials, model keys, SMTP, or runner configuration. The PostgreSQL role needs permission to create this database and install pgvector, or an administrator can create it first.

Without a root `.env`, or to choose a different local PostgreSQL server:

```sh
SANDBOX_DATABASE_URL='postgresql://your-user:your-password@127.0.0.1:5432/fieldkit_store_sandbox' npm run sandbox
```

Only loopback PostgreSQL hosts and the exact sandbox database name are accepted. URL query parameters are rejected. Node 24+ and the root dependencies are required; no separate demo dependencies or SMTP server are needed.

- **Storefront, logins, guide, receipts, email outbox:** <http://127.0.0.1:4321/>
- **Staff app:** <http://127.0.0.1:4320/>
- **Customer portal:** <http://127.0.0.1:4320/support/trail-supply>

Both HTTP servers bind to `127.0.0.1`. Keep this environment local; its launch page intentionally shows synthetic account credentials and captured email. Use these exact addresses. The usual installation at `localhost:4318` stays separate. Browser cookies are scoped by host, not port: use a separate browser profile if your regular installation also runs on `127.0.0.1`.

## Accounts and sample data

The launch page shows a generated password shared initially by these **synthetic, preverified** users:

| Account                    | Role        | Sample data                                                     |
| -------------------------- | ----------- | --------------------------------------------------------------- |
| `owner@trail.example.test` | Owner       | Full workspace management and approvals                         |
| `agent@trail.example.test` | Staff agent | Inbox, replies, and human takeover                              |
| `alex@trail.example.test`  | Customer    | $89 Summit Daypack purchase and $12/month Trail Club membership |
| `sam@trail.example.test`   | Customer    | Separate history; no billing records                            |

Use a private browser window for the customer and a normal window for staff. The fixture accounts are not production accounts. Normal signup, email verification, recovery, and session checks still run; emails are written to the sandbox outbox instead of being delivered.

The first start creates five approved public documents (returns, shipping, products, membership, damaged items), one private staff document, two approval-required actions, a published LangGraph workflow, portal/widget branding, five Test Lab cases, and three starter conversations. The Markdown files in `knowledge/` can also be uploaded manually to a separate development workspace.

## Try these scenarios

1. Open the staff inbox as the owner. Review the pending **$20 partial refund**. Approve it and inspect the durable simulated receipt on the launch page. This runs the real approval/action engine with a local payment fixture.
2. Ask “What is your return policy?” in the anonymous widget. Inspect the citation. Customer replies cannot retrieve the staff-only document.
3. Sign in to the portal as Alex. Ask “Please refund $10 from my backpack purchase” or “Cancel my Trail Club membership.” Approve/reject the proposed action from the owner’s inbox. Refunds cannot exceed the remaining fictional payment balance.
4. Sign in as Sam and try requesting a refund: Alex’s purchase is unavailable to this customer.
5. Ask for a human or a warranty exception. Take over the ticket, add an internal note, reply, and resolve it.
6. Edit **Publish → Appearance**, upload a sample logo, and inspect the updated portal/widget. Edit and publish workflow routes or exact replies.
7. Run the preloaded **Test Lab** suite with **AI quality assessment turned off** and a token cap (the form still requires one). Five cases contain six turns covering cited policies, follow-ups, refund/cancellation proposals, anonymous identity, and handoff. No business effects execute during evaluation.
8. Submit feedback from a customer conversation; view Analytics and manually triage Knowledge → Gaps. Imported evidence and usage remain sandbox-only.

## What is real, and what is simulated?

**Real:** FieldKit authentication, PostgreSQL/pgvector storage, ingestion, visibility rules, citations, LangGraph execution, checkpoints, durable jobs, customer isolation, approvals, policies, inbox, feedback, branding, rule-based evaluation, and restart recovery.

**Simulated:** model responses, embedding vectors, purchases, subscriptions, and payment receipts. Responses use simple word matching against retrieved passages. FAQ/support-assistant outputs are labelled scripted drafts. Model instructions and model comparisons do not measure AI behavior here. No token usage is fabricated; the usage counter stays at zero.

**Unavailable in this sandbox:** paid/live AI, AI judging, AI gap analysis, external imports, real vendor connections, arbitrary custom endpoints, and Python/JavaScript execution. Unsupported provider requests fail without falling back to the network. These require separate test-account verification in a normal development installation. Do not enter real provider credentials in the sandbox. This setup does not establish Stripe or other vendor compatibility.

## Persistence and reset

Stop with **Ctrl+C**. Run `npm run sandbox` again to keep your accounts, password changes, branding, knowledge, conversations, workflow edits, approvals, and receipts. Seeding is skipped once initialization completes. Initial secrets/password are stored with restricted permissions in ignored `.fieldkit/store-sandbox/config.json`; uploads and the email outbox are under that directory. PostgreSQL holds application data and the sandbox’s payment receipts.

To **erase only the sandbox** and recreate its original synthetic data, first stop it, then run:

```sh
npm run sandbox -- --reset
```

This explicitly drops the sandbox database’s application, queue, and checkpoint schemas, and clears its uploads/outbox. It keeps local installation secrets and the initial generated password. A reset of the regular installation or automated test database is rejected by the sandbox database guard. Restarting without `--reset` never restores defaults over your changes. An interrupted first initialization reports an error and requires inspection or this explicit reset.

Regression coverage lives in `tests/store-sandbox.test.ts` and uses the existing disposable `TEST_DATABASE_URL`, **not** your persistent store sandbox. Run it with `npx tsx --test tests/store-sandbox.test.ts` (it clears that test database). It checks database guards, source visibility, account separation, exact-once simulated receipts, restart persistence, and all six evaluation turns.
