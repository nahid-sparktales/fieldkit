# Security

Navigated Support is a development release candidate. Automated safety tests are not a security certification. See [verification](docs/verification.md) for the tested boundaries and outstanding live-account gates. Fixes are currently developed on `main`; the archived `demo-v1` example is not a supported deployment for real customer data.

## Report a vulnerability privately

Use GitHub's **Security → Report a vulnerability** for this repository: [private vulnerability report](https://github.com/nahid-sparktales/fieldkit/security/advisories/new). Include the affected revision, reproduction steps using synthetic data, the expected authorization boundary, and observed impact.

Do not put credentials, customer messages, private documents, database dumps, or exploitable vulnerability details in a public issue. Ordinary non-sensitive bugs can use GitHub issues. Do not test against another operator's installation without permission.

## Operator responsibilities

- Keep `.env`, encryption/auth secrets, uploads, logs, and backups private. Back up the database, upload volume, and matching secrets together.
- Use HTTPS, configured SMTP, restricted provider credentials, and reviewed identity mappings. Connect dedicated test accounts before enabling live actions.
- Review customer-visible knowledge and action limits. Uploaded prose and model output never grant account ownership or execution authority.
- Follow [operations](docs/operations.md) for upgrades, restoration, credential rotation, retention, and failed-job recovery.

The repository's Gitleaks configuration allows only specific nonfunctional test strings and one archived synthetic request identifier. It does not exempt test files or entire directories from secret scanning.
