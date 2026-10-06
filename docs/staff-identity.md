# Staff SSO and MFA

Staff identity extends the installed Better Auth account/session tables and authentication hooks. OIDC uses its authorization-code, state, nonce, PKCE and ID-token validation helpers with `jose` signing-key verification. TOTP and recovery use Better Auth's [two-factor plugin](https://better-auth.com/docs/plugins/2fa). There is no second user database, external authentication service requirement, SAML, SCIM, group synchronization, or automatic domain enrollment.

## Configure OIDC

1. Upgrade the application and run the normal migration command while app/worker processes are stopped. Schema 23 adds workspace identity configuration and proof/transaction records; Better Auth adds its two-factor columns/table. Existing workspaces retain optional password authentication, with SSO/MFA enforcement off.
2. In **Security**, verify your current password. Configure the provider name, exact issuer URL, client ID and client secret. Discovery must advertise S256 PKCE, asymmetric ID-token signing, and `client_secret_basic`. Authorization, token and JWKS endpoints must be on the issuer's origin. Generic OIDC providers satisfying this contract are supported; provider-specific extensions have not been live-verified.
3. Register the displayed exact `/api/auth/callback/oidc-<provider-id>` URL at the IdP. Redirects back into the app must use its configured origin. Discovery/token/JWKS requests have size/time limits and refuse redirects. Public issuers require public HTTPS and connection-time DNS checks. A private/self-hosted issuer requires its exact URL in the operator-controlled comma-separated `FIELDKIT_OIDC_ISSUERS`; workspace administrators cannot grant private-network access themselves. HTTP is accepted only for such explicitly trusted operator issuers (use HTTPS outside local fixtures).
4. Invite each staff member through the existing verified account flow. While signed in locally, they verify their password and choose **Link SSO account**. MFA must also be confirmed if already enabled. Both workspace membership and the stable provider subject are checked; a matching asserted email alone never links an account or grants membership. The IdP must return a verified email matching the local account. Subject and provider association identify the account; email remains mutable profile information.
5. Test sign-in from the login screen using the workspace URL name. Linking rotates the current session. Each transaction binds the provider, workspace, configuration revision, state, PKCE and nonce. Configuration changes invalidate in-flight flows. Access/refresh tokens are not needed and are not retained. ID tokens are verified during the callback and discarded before account persistence; they are never sent to models or administration responses.

Issuer and client ID are immutable after configuration to prevent reassociating existing subjects to a different issuer/client. Client secrets can be replaced by entering a new value; leaving the secret blank preserves it. Disable policy first before disabling the provider. Replacing the issuer is an operator migration: back up, stop processes, remove the old workspace provider's account links and pending transactions, remove its configuration, then restart, configure and securely relink the new provider. Do not edit provider identity in place or transfer subjects by matching email.

## Enroll and enforce MFA

In **Security → Your sign-in security**, verify your password, then set up an authenticator using the locally displayed setup key or `otpauth` link. No external QR service receives the secret. The factor becomes active only after a valid authenticator code. Save the ten high-entropy recovery codes offline; they are shown once and stored as one-way SHA-256 verifiers. A recovery code is consumed atomically even under concurrent requests. Regenerating codes invalidates all previous codes and signs out other sessions.

TOTP secrets have an authenticated encryption layer using `FIELDKIT_ENCRYPTION_KEY` in addition to the library's existing secret handling. Both deployment keys are required by normal configuration validation; no fixed fallback is introduced. `npm run rotate-key -- <mode-0600-new-key-file>` covers provider secrets and the TOTP layer, in the same stopped-process transaction as existing encrypted records. Preserve both keys with encrypted backups. Rotating `BETTER_AUTH_SECRET` follows the authentication library's separate lifecycle and can invalidate sessions/factor material; do not replace it casually.

Password and SSO login both create a pending MFA challenge with no authenticated session until proof succeeds. Trusted-device bypass is disabled; an ordinary remembered seven-day session instead retains a server-side MFA proof. Replayed authenticator values are rejected for two minutes, including across workers, and the library enforces bounded attempts, per-path rate limits and account lockout. Current workspace policy and factor state are checked on every staff request. Existing sessions without proof must enroll/confirm before using staff APIs. They can still open their own Security screen to finish setup. Portal/customer and separately scoped service/widget credentials are not subject to workspace staff SSO policy.

Sensitive configuration, role changes, factor changes and recovery-code regeneration require password verification within five minutes and an MFA-proven session when a factor is enabled. Confirm the current authenticator again when recovering an old session. A workspace requiring MFA or SSO prevents factor removal until policy is safely disabled. Password reset revokes existing sessions; confirmed enrollment, factor removal and recovery regeneration revoke other sessions. Role/member changes revoke the affected user's sessions. Recovery codes cannot activate an unconfirmed factor; the first enrollment proof must come from the authenticator.

## Safe policy rollout and recovery

Before enabling **Require SSO** or **Require MFA**:

- Confirm your own MFA factor and, for SSO enforcement, securely link and verify your own SSO session.
- Configure at least one existing active owner ID in `FIELDKIT_BREAK_GLASS_USERS`. That owner must have an existing local password and confirmed MFA. The UI displays member enrollment readiness. Coordinate enrollment before applying policy; there is no hidden grace period.
- Save recovery codes offline and verify the operator can access the host/database and its backups.

An operator-approved owner can sign in with the existing local password, complete MFA (including a one-time recovery code), then verify the password in Security. That fresh proof permits recovery of SSO policy for five minutes. This only bypasses the SSO requirement; it never bypasses MFA and is not a public URL parameter or shared recovery password. The owner can disable enforcement through the normal audited Security screen.

If the owner has lost all MFA methods, stop app and worker processes, back up the database, verify the owner's identity outside the application, and run:

```sh
npx tsx scripts/recover-staff-identity.ts <workspace-id> <owner-user-id> disable-enforcement --confirm-offline
# Only when the owner has lost the factor and all recovery codes:
npx tsx scripts/recover-staff-identity.ts <workspace-id> <owner-user-id> reset-factor --confirm-offline
```

The command requires host/database privileges and an existing active owner with an existing local password. It does not generate a password or expose a reset endpoint. A global user's factor reset disables staff enforcement in every workspace they belong to, records that impact in each audit stream, deletes the factor, and invalidates all their sessions. Restart, sign in with the existing password, enroll and confirm a new factor, review audit records, securely relink SSO if needed, and restore policy. Removing another owner's last viable method is not an ordinary staff API operation.

## Disable/upgrade boundaries

Turn off enforcement before disabling a provider. Disabling SSO preserves historical account associations and tickets. The additive schema can remain in place when features are disabled. Take a backup before upgrades; restoring an old code/schema snapshot is a recovery operation, not a safe destructive down-migration. Expired OAuth transactions, pending proofs and TOTP replay claims are cleanup data; they do not grant access. No real enterprise tenant or production authentication configuration was changed or certified by the local tests.
