# Contributing to Navigated Support

Navigated Support uses React, TypeScript, Node 24+, PostgreSQL 17 with pgvector, pg-boss, and LangGraph. Contributions are provided under the repository's Apache-2.0 license. The current focus is the self-hosted release and the [open verification gates](docs/verification.md).

## Local setup

1. Fork and clone the repository. Run `npm ci` using the Node version in `.nvmrc`.
2. Run `npm run setup` to generate unique installation secrets. Configure `.env` for your local PostgreSQL database, URL/port, and SMTP. A local mail catcher can receive test signup messages; real account verification remains enabled.
3. Run `npm run migrate`, then `npm run dev` and `npm run worker` in separate terminals.
4. Register, verify your email, and create a workspace with your generated setup token. Add your own knowledge and test credentials as needed. The installation starts empty; `examples/demo` is separate and explicitly invoked.

## Verification

Create a separate, disposable PostgreSQL database with a name ending in `_test`, and set `TEST_DATABASE_URL` to its connection URL. Tests **delete that database's contents**. Never reuse an installation database. Run database and browser suites sequentially:

```sh
npm run typecheck
npm run build
npm test
npx playwright install chromium
npm run test:browser
npm ci --prefix examples/demo
npm run test:demo
```

Model and provider doubles exist only in tests. Keep new safety regressions focused on observable boundaries: tenant/customer isolation, source visibility, exact approvals, takeover, stale state, and uncertain writes. Do not label an injected-provider result as a live integration success. Live model evaluations are separately opt-in and consume tokens; see [verification](docs/verification.md).

Before opening a pull request, inspect the diff for secrets or personal data. If Gitleaks is installed, run `gitleaks git --redact --log-opts='--all' .`. Never commit `.env` variants, credentials, real customer exports, uploaded files, local logs, or database backups. Describe the user-visible change and the checks you ran. Report security vulnerabilities through the private process in [SECURITY.md](SECURITY.md).
