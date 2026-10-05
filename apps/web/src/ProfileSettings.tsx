import { useState, type ReactNode } from "react";
import { auth } from "./auth-client.js";
import { api, request, useLoad } from "./request.js";
import { useAction } from "./useAction.js";
import { LoadingState, SettingsField as Field } from "./ui.js";
function Notice({ action }: { action: ReturnType<typeof useAction> }) {
  return (
    <>
      {action.error && (
        <div className="alert" role="alert">
          {action.error}
        </div>
      )}
      {action.success && (
        <p className="success" role="status">
          {action.success}
        </p>
      )}
    </>
  );
}
export function ProfileSettings({ changed }: { changed?: () => void }) {
  const load = useLoad(async () => {
    const [session, sessions] = await Promise.all([
      auth.getSession(),
      auth.listSessions(),
    ]);
    if (session.error) throw new Error(session.error.message);
    if (!session.data) throw new Error("Sign in again to manage your profile.");
    return {
      ...session.data,
      sessions: sessions.data ?? [],
      sessionError: sessions.error?.message,
      staleSession: sessions.error?.code === "SESSION_NOT_FRESH",
    };
  }, []);
  const profile = useAction(),
    password = useAction(),
    security = useAction();
  if (load.error)
    return (
      <div className="alert" role="alert">
        {load.error}
        <button onClick={load.reload}>Try again</button>
      </div>
    );
  if (!load.data) return <LoadingState label="Loading your profile…" />;
  const current = load.data;
  return (
    <div className="profile-settings">
      <section className="panel">
        <h2>Your profile</h2>
        <p className="muted">
          Your display name is shared across your Navigated Support workspaces
          and support accounts.
        </p>
        <Notice action={profile} />
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const data = new FormData(event.currentTarget);
            void profile.run(async () => {
              await request("/v2/profile", { name: data.get("name") }, "PUT");
              load.reload();
              changed?.();
            }, "Profile saved.");
          }}
        >
          <Field label="Display name">
            <input
              key={current.user.name}
              name="name"
              autoComplete="name"
              required
              maxLength={80}
              defaultValue={current.user.name}
            />
          </Field>
          <Field label="Email address">
            <input type="email" value={current.user.email} readOnly />
          </Field>
          <p className="field-hint">
            {current.user.emailVerified
              ? "Verified email"
              : "Email not verified"}{" "}
            · This address is your sign-in identity.
          </p>
          <button className="primary" disabled={profile.busy}>
            {profile.busy ? "Saving…" : "Save profile"}
          </button>
        </form>
      </section>
      <section className="panel">
        <h2>Password & security</h2>
        <p className="muted">
          Use a unique password with at least 12 characters.
        </p>
        <Notice action={password} />
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const form = event.currentTarget,
              data = new FormData(form);
            void password.run(async () => {
              if (data.get("newPassword") !== data.get("confirmPassword"))
                throw new Error("The new passwords do not match.");
              const result = await auth.changePassword({
                currentPassword: String(data.get("currentPassword")),
                newPassword: String(data.get("newPassword")),
                revokeOtherSessions: data.get("revoke") === "on",
              });
              if (result.error)
                throw new Error(
                  result.error.message ?? "Could not change the password.",
                );
              form.reset();
              load.reload();
            }, "Password changed.");
          }}
        >
          <Field label="Current password">
            <input
              name="currentPassword"
              type="password"
              autoComplete="current-password"
              required
              maxLength={128}
            />
          </Field>
          <Field label="New password">
            <input
              name="newPassword"
              type="password"
              autoComplete="new-password"
              minLength={12}
              maxLength={128}
              required
            />
          </Field>
          <Field label="Confirm new password">
            <input
              name="confirmPassword"
              type="password"
              autoComplete="new-password"
              minLength={12}
              maxLength={128}
              required
            />
          </Field>
          <label className="checkbox">
            <input name="revoke" type="checkbox" defaultChecked />
            Sign out other sessions when changing password
          </label>
          <button disabled={password.busy}>
            {password.busy ? "Changing password…" : "Change password"}
          </button>
        </form>
      </section>
      <section className="panel">
        <div className="section-heading">
          <div>
            <h2>Active sessions</h2>
            <p className="muted">
              Review where you’re signed in. This session stays active when you
              sign out the others.
            </p>
          </div>
          <button onClick={load.reload}>Refresh sessions</button>
        </div>
        <Notice action={security} />
        {current.staleSession ? (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              const form = event.currentTarget,
                data = new FormData(form);
              void security.run(async () => {
                const result = await auth.signIn.email({
                  email: current.user.email,
                  password: String(data.get("password")),
                });
                if (result.error)
                  throw new Error(
                    result.error.message ?? "Could not confirm your password.",
                  );
                form.reset();
                load.reload();
              });
            }}
          >
            <p className="muted">
              Confirm your current password to manage active sessions.
            </p>
            <Field label="Confirm password for session management">
              <input
                name="password"
                type="password"
                autoComplete="current-password"
                required
                maxLength={128}
              />
            </Field>
            <button disabled={security.busy}>Unlock session management</button>
          </form>
        ) : (
          current.sessionError && (
            <p className="alert" role="alert">
              {current.sessionError}
            </p>
          )
        )}
        <ul className="profile-sessions">
          {current.sessions.map((session: any) => (
            <li key={session.id}>
              <div>
                <strong>
                  {session.token === current.session.token
                    ? "This session"
                    : "Other session"}
                </strong>
                <span>
                  {session.userAgent || "Device information unavailable"}
                </span>
              </div>
              <small>
                Signed in {new Date(session.createdAt).toLocaleString()}
                <br />
                Expires {new Date(session.expiresAt).toLocaleString()}
              </small>
            </li>
          ))}
        </ul>
        <button
          disabled={security.busy || current.sessions.length < 2}
          onClick={() =>
            void security.run(async () => {
              const result = await auth.revokeOtherSessions();
              if (result.error) throw new Error(result.error.message);
              load.reload();
            }, "Other sessions signed out.")
          }
        >
          Sign out other sessions
        </button>
      </section>
    </div>
  );
}

export function WorkspaceSettings({
  ws,
  changed,
}: {
  ws: string;
  changed: () => void;
}) {
  const load = useLoad(() => api(ws, ""), [ws]),
    action = useAction();
  if (load.error)
    return (
      <div className="alert" role="alert">
        {load.error}
      </div>
    );
  if (!load.data) return <LoadingState label="Loading workspace…" />;
  const workspace = load.data.workspace;
  return (
    <section className="panel workspace-settings">
      <h2>Workspace details</h2>
      <p className="muted">
        The workspace name identifies your team in Navigated Support. Set a
        different public name in Publish → Appearance.
      </p>
      <Notice action={action} />
      <form
        onSubmit={(event) => {
          event.preventDefault();
          const data = new FormData(event.currentTarget);
          void action.run(async () => {
            await api(ws, "/profile", { name: data.get("name") }, "PUT");
            load.reload();
            changed();
          }, "Workspace name saved.");
        }}
      >
        <Field label="Workspace name">
          <input
            name="name"
            required
            minLength={2}
            maxLength={80}
            defaultValue={workspace.name}
          />
        </Field>
        <Field label="Help center address">
          <input
            readOnly
            value={`${location.origin}/support/${workspace.slug}`}
          />
        </Field>
        <p className="field-hint">
          The address stays the same when you rename the workspace, so existing
          links and widgets keep working.
        </p>
        <button className="primary" disabled={action.busy}>
          {action.busy ? "Saving…" : "Save workspace"}
        </button>
      </form>
    </section>
  );
}
export function SettingsPage({
  ws,
  admin,
  changed,
  agentSettings,
  appearance,
}: {
  ws: string;
  admin: boolean;
  changed: () => void;
  agentSettings: ReactNode;
  appearance: () => void;
}) {
  const [tab, setTab] = useState(() =>
    new URLSearchParams(location.search).get("tab") === "profile" || !admin
      ? "profile"
      : "agent",
  );
  return (
    <>
      <div className="page-heading">
        <div>
          <span className="eyebrow">MAKE NAVIGATED SUPPORT YOURS</span>
          <h1>Settings</h1>
          <p>
            Manage your profile
            {admin
              ? ", workspace, and agent preferences"
              : " and account security"}
            .
          </p>
        </div>
        {admin && <button onClick={appearance}>Customize help center →</button>}
      </div>
      <nav className="settings-tabs" aria-label="Settings sections">
        {[
          ...(admin
            ? [
                ["agent", "Agent"],
                ["workspace", "Workspace"],
              ]
            : []),
          ["profile", "My profile"],
        ].map(([key, label]) => (
          <button
            key={key}
            aria-current={key === tab ? "page" : undefined}
            onClick={() => setTab(key)}
          >
            {label}
          </button>
        ))}
      </nav>
      {tab === "agent" && admin ? (
        agentSettings
      ) : tab === "workspace" && admin ? (
        <WorkspaceSettings ws={ws} changed={changed} />
      ) : (
        <ProfileSettings changed={changed} />
      )}
    </>
  );
}
