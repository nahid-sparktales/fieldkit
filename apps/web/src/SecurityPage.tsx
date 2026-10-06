import { useState } from "react";
import { api, request, useLoad } from "./request.js";
import { useAction } from "./useAction.js";
import { Field, Notice, type Row } from "./quality-ui.js";
import { LoadingState } from "./ui.js";
import { useUnsavedChanges } from "./unsaved-changes.js";

export async function authRequest(path: string, body: unknown) {
  const res = await fetch(`/api/auth${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    data = await res.json();
  if (!res.ok)
    throw new Error(
      data.message ?? data.error ?? "Authentication could not be completed",
    );
  return data;
}
export function MfaChallenge({
  done,
  totpOnly = false,
}: {
  done: () => void;
  totpOnly?: boolean;
}) {
  const [recovery, setRecovery] = useState(false),
    a = useAction();
  return (
    <div className="panel">
      <h2>Confirm it’s you</h2>
      <p>
        {recovery
          ? "Enter one of your saved recovery codes. Each code works once."
          : "Enter the current code from your authenticator app."}
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const d = new FormData(e.currentTarget);
          void a.run(async () => {
            await authRequest(
              recovery
                ? "/two-factor/verify-backup-code"
                : "/two-factor/verify-totp",
              { code: String(d.get("code")) },
            );
            done();
          });
        }}
      >
        <Field label={recovery ? "Recovery code" : "Authenticator code"}>
          <input
            name="code"
            autoComplete="one-time-code"
            inputMode={recovery ? "text" : "numeric"}
            required
            autoFocus
          />
        </Field>
        <Notice action={a} />
        <button className="primary" disabled={a.busy}>
          Verify
        </button>
      </form>
      {!totpOnly && (
        <button onClick={() => setRecovery(!recovery)}>
          {recovery ? "Use authenticator instead" : "Use a recovery code"}
        </button>
      )}
    </div>
  );
}
export function SsoSignIn() {
  const a = useAction(),
    [providers, setProviders] = useState<Row[]>([]);
  return (
    <details>
      <summary>Sign in with workspace SSO</summary>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const d = new FormData(e.currentTarget);
          void a.run(async () => {
            const data = await request(
              `/v2/identity/providers?workspace=${encodeURIComponent(String(d.get("workspace")))}`,
            );
            setProviders(data.providers);
            if (!data.providers.length)
              throw new Error(
                "No enabled SSO provider was found for this workspace.",
              );
          });
        }}
      >
        <Field label="Workspace URL name">
          <input name="workspace" placeholder="your-team" required />
        </Field>
        <button disabled={a.busy}>Find sign-in provider</button>
      </form>
      <Notice action={a} />
      {providers.map((p) => (
        <button
          className="primary"
          key={p.id}
          onClick={() =>
            void a.run(async () => {
              const data = await authRequest("/sign-in/social", {
                provider: `oidc-${p.id}`,
              });
              location.assign(data.url);
            })
          }
        >
          Continue with {p.name}
        </button>
      ))}
    </details>
  );
}
export function SecurityAccount({ changed }: { changed?: () => void }) {
  const l = useLoad(() => request("/v2/identity/me"), []),
    a = useAction();
  const [setup, setSetup] = useState<{
      totpURI?: string;
      backupCodes: string[];
    } | null>(null),
    [challenge, setChallenge] = useState(false);
  const reload = () => {
    l.reload();
    changed?.();
  };
  useUnsavedChanges(!!setup);
  if (!l.data)
    return (
      <>
        {l.loading ? (
          <LoadingState label="Loading sign-in security…" />
        ) : (
          <p role="alert">{l.error}</p>
        )}
      </>
    );
  return (
    <section className="panel">
      <h2>Your sign-in security</h2>
      <p>
        Authenticator:{" "}
        <strong>{l.data.twoFactorEnabled ? "Enabled" : "Not enrolled"}</strong>.{" "}
        {l.data.mfaVerified ? "This session has passed MFA." : ""}
      </p>
      <Notice action={a} />
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const form = e.currentTarget,
            d = new FormData(form);
          void a.run(async () => {
            await request("/v2/identity/step-up", {
              password: String(d.get("password")),
            });
            form.reset();
            l.reload();
          }, "Password verified for five minutes.");
        }}
      >
        <Field label="Verify your password for sensitive changes">
          <input
            name="password"
            type="password"
            autoComplete="current-password"
            required
          />
        </Field>
        <button disabled={a.busy}>Verify password</button>
      </form>
      {l.data.stepUpUntil && (
        <p>
          Verification valid until{" "}
          {new Date(l.data.stepUpUntil).toLocaleTimeString()}.
        </p>
      )}
      {l.data.twoFactorEnabled && (
        <button onClick={() => setChallenge(true)}>
          Confirm authenticator or recovery code
        </button>
      )}
      {challenge && (
        <MfaChallenge
          done={() => {
            setChallenge(false);
            reload();
          }}
        />
      )}
      {!l.data.twoFactorEnabled && !setup && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const form = e.currentTarget,
              d = new FormData(form);
            void a.run(async () => {
              const data = await authRequest("/two-factor/enable", {
                password: String(d.get("password")),
                method: "totp",
              });
              setSetup(data);
              form.reset();
            });
          }}
        >
          <Field label="Password to set up an authenticator">
            <input
              name="password"
              type="password"
              autoComplete="current-password"
              required
            />
          </Field>
          <button disabled={a.busy}>Set up authenticator</button>
        </form>
      )}
      {setup && (
        <div className="callout">
          <h3>Save these recovery codes</h3>
          <p>
            Store them offline now. They are shown only once. Do not share your
            setup key or codes.
          </p>
          <textarea
            aria-label="One-time recovery codes"
            readOnly
            value={setup.backupCodes.join("\n")}
            rows={10}
          />
          {setup.totpURI && (
            <>
              <p>
                In your authenticator app, add a time-based account using this
                key:
              </p>
              <code>{new URL(setup.totpURI).searchParams.get("secret")}</code>
              <p>
                <a href={setup.totpURI}>Open in authenticator app</a>
              </p>
              <MfaChallenge
                totpOnly
                done={() => {
                  setSetup({ ...setup, totpURI: undefined });
                  reload();
                }}
              />
            </>
          )}
          <button
            onClick={() => {
              if (
                setup.totpURI &&
                !confirm("Enrollment is not confirmed yet. Close setup?")
              )
                return;
              setSetup(null);
            }}
          >
            I have stored my recovery codes
          </button>
        </div>
      )}
      {l.data.twoFactorEnabled && (
        <details>
          <summary>Recovery codes and factor removal</summary>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const form = e.currentTarget,
                d = new FormData(form);
              void a.run(async () => {
                const data = await authRequest(
                  "/two-factor/generate-backup-codes",
                  { password: String(d.get("password")) },
                );
                setSetup(data);
                form.reset();
                reload();
              }, "Old recovery codes were invalidated. Save the new codes.");
            }}
          >
            <Field label="Password to replace recovery codes">
              <input
                name="password"
                type="password"
                autoComplete="current-password"
                required
              />
            </Field>
            <button disabled={a.busy}>Replace recovery codes</button>
          </form>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (
                !confirm(
                  "Remove your authenticator? Other sessions will be signed out. Workspace policy may prevent removal.",
                )
              )
                return;
              const d = new FormData(e.currentTarget);
              void a.run(async () => {
                await authRequest("/two-factor/disable", {
                  password: String(d.get("password")),
                });
                reload();
              }, "Authenticator removed.");
            }}
          >
            <Field label="Password to remove authenticator">
              <input
                name="password"
                type="password"
                autoComplete="current-password"
                required
              />
            </Field>
            <button disabled={a.busy}>Remove authenticator</button>
          </form>
        </details>
      )}
      <h3>Workspace SSO accounts</h3>
      <p>
        Link an identity while signed in and recently verified. A matching email
        address alone cannot create a link or grant membership.
      </p>
      {l.data.providers
        .filter((p: Row) => p.id)
        .map((p: Row) => (
          <div key={p.id}>
            <strong>
              {p.workspace_name}: {p.name}
            </strong>
            <p>
              {p.sso_required ? "SSO required" : "SSO optional"} ·{" "}
              {p.linked ? "Linked" : "Not linked"}
            </p>
            <button
              disabled={!p.enabled || a.busy}
              onClick={() =>
                void a.run(async () => {
                  const data = await authRequest(
                    p.linked ? "/sign-in/social" : "/link-social",
                    { provider: `oidc-${p.id}` },
                  );
                  location.assign(data.url);
                })
              }
            >
              {p.linked ? "Sign in with SSO" : "Link SSO account"}
            </button>
          </div>
        ))}
    </section>
  );
}
export function SecurityPage({
  ws,
  canManage,
  children,
  changed,
}: {
  ws: string;
  canManage: boolean;
  children?: React.ReactNode;
  changed?: () => void;
}) {
  return (
    <div className="quality-page">
      <header>
        <span className="eyebrow">ACCOUNT & WORKSPACE</span>
        <h1>Security</h1>
        <p>Manage sign-in methods, staff policies, and access.</p>
      </header>
      <SecurityAccount changed={changed} />
      {canManage && <IdentityPolicy ws={ws} />} {children}
    </div>
  );
}
function IdentityPolicy({ ws }: { ws: string }) {
  const l = useLoad(() => api(ws, "/identity"), [ws]),
    a = useAction(),
    [dirty, setDirty] = useState(false);
  useUnsavedChanges(dirty);
  if (!l.data)
    return (
      <>
        <Notice action={a} error={l.error} />
        {l.loading && <LoadingState label="Loading workspace security…" />}
      </>
    );
  const { provider: p, policy, enrollments } = l.data;
  return (
    <>
      <section className="panel">
        <h2>OpenID Connect provider</h2>
        <p>
          Register the callback URL with your identity provider. Configuration
          uses discovery and S256 PKCE. Save, link your own account, and test
          local sign-in before enforcing the policy.
        </p>
        <Notice action={a} error={l.error} />
        <form
          key={p?.revision ?? 0}
          onChange={() => setDirty(true)}
          onSubmit={(e) => {
            e.preventDefault();
            const d = new FormData(e.currentTarget);
            void a.run(async () => {
              await api(
                ws,
                "/identity/provider",
                {
                  name: String(d.get("name")),
                  issuer: String(d.get("issuer")),
                  clientId: String(d.get("clientId")),
                  clientSecret: String(d.get("secret")) || undefined,
                  enabled: d.get("enabled") === "on",
                  revision: p?.revision ?? 0,
                },
                "PUT",
              );
              setDirty(false);
              l.reload();
            }, "SSO configuration saved.");
          }}
        >
          <Field label="Provider name">
            <input name="name" defaultValue={p?.name ?? ""} required />
          </Field>
          <Field label="Issuer URL">
            <input
              name="issuer"
              type="url"
              defaultValue={p?.issuer ?? ""}
              readOnly={!!p}
              required
            />
          </Field>
          <Field label="Client ID">
            <input
              name="clientId"
              defaultValue={p?.client_id ?? ""}
              readOnly={!!p}
              required
            />
          </Field>
          <Field
            label={
              p
                ? "New client secret (leave blank to keep current)"
                : "Client secret"
            }
          >
            <input
              name="secret"
              type="password"
              autoComplete="new-password"
              required={!p}
            />
          </Field>
          <label>
            <input
              name="enabled"
              type="checkbox"
              defaultChecked={p?.enabled ?? true}
            />{" "}
            Enable SSO sign-in
          </label>
          <p>
            Issuer and client ID identify existing account links and cannot be
            silently replaced.
          </p>
          <button className="primary" disabled={a.busy}>
            Save provider
          </button>
        </form>
        {p && (
          <>
            <Field label="Allowed callback URL">
              <input readOnly value={p.callbackURL} />
            </Field>
            <p>Secret is stored encrypted and is never returned.</p>
          </>
        )}
      </section>
      <section className="panel">
        <h2>Staff sign-in policy</h2>
        <p>
          Customers and widget visitors keep their existing sign-in flow. Policy
          changes take effect on existing staff sessions immediately.
        </p>
        <p>
          Operator recovery owner:{" "}
          {l.data.operatorRecoveryConfigured
            ? "Configured"
            : "Not configured. Add an approved owner ID to FIELDKIT_BREAK_GLASS_USERS on the server before enforcement."}
        </p>
        <form
          key={policy.revision}
          onSubmit={(e) => {
            e.preventDefault();
            if (
              !confirm(
                "Apply this staff sign-in policy now? Members who do not meet it must complete security setup before returning to work.",
              )
            )
              return;
            const d = new FormData(e.currentTarget);
            void a.run(async () => {
              await api(
                ws,
                "/identity/policy",
                {
                  ssoRequired: d.get("sso") === "on",
                  mfaRequired: d.get("mfa") === "on",
                  revision: policy.revision,
                  confirm: true,
                },
                "PUT",
              );
              l.reload();
            }, "Staff sign-in policy updated.");
          }}
        >
          <label>
            <input
              name="sso"
              type="checkbox"
              defaultChecked={policy.sso_required}
            />{" "}
            Require workspace SSO
          </label>
          <label>
            <input
              name="mfa"
              type="checkbox"
              defaultChecked={policy.mfa_required}
            />{" "}
            Require authenticator MFA
          </label>
          <button disabled={a.busy}>Apply policy</button>
        </form>
        <h3>Enrollment readiness</h3>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Member</th>
                <th>SSO linked</th>
                <th>MFA confirmed</th>
              </tr>
            </thead>
            <tbody>
              {enrollments.map((m: Row) => (
                <tr key={m.user_id}>
                  <td>
                    {m.name || m.email} {m.disabled ? "(disabled)" : ""}
                  </td>
                  <td>{m.sso_linked ? "Yes" : "No"}</td>
                  <td>{m.mfa_enabled ? "Yes" : "No"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
