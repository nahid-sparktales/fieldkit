import { useState, type ReactNode } from "react";
import { auth } from "./auth-client.js";
import { api, request, useLoad } from "./request.js";
import { useAction } from "./useAction.js";
import { LoadingState, SettingsField as Field } from "./ui.js";
import { useSettingsForm } from "./settings-form.js";
import { useUnsavedChanges } from "./unsaved-changes.js";
import "./settings.css";
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
  const draft = useSettingsForm("profile");
  const [passwordDirty, setPasswordDirty] = useState(false);
  useUnsavedChanges(passwordDirty);
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
  if (load.error && !load.data)
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
      {load.error && (
        <div className="alert" role="alert">
          {load.error}
          <button onClick={load.reload}>Try again</button>
        </div>
      )}
      <section className="panel">
        <h2>Your profile</h2>
        <p className="muted">
          Your display name is shared across your Navigated Support workspaces
          and support accounts.
        </p>
        <Notice action={profile} />
        <form
          ref={draft.ref}
          onChange={draft.onChange}
          onSubmit={(event) => {
            event.preventDefault();
            const data = new FormData(event.currentTarget);
            void profile.run(async () => {
              await request("/v2/profile", { name: data.get("name") }, "PUT");
              draft.saved();
              load.reload();
              changed?.();
            }, "Profile saved.");
          }}
        >
          <Field label="Display name">
            <input
              key={current.user.name}
              name="name"
              disabled={profile.busy}
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
          <div className="settings-save-actions">
            <button className="primary" disabled={profile.busy || !draft.dirty}>
              {profile.busy ? "Saving…" : "Save profile"}
            </button>
            {draft.dirty && (
              <>
                <button
                  type="button"
                  disabled={profile.busy}
                  onClick={draft.discard}
                >
                  Discard changes
                </button>
                <span role="status">Unsaved changes</span>
              </>
            )}
          </div>
        </form>
      </section>
      <section className="panel">
        <h2>Password & security</h2>
        <p className="muted">
          Use a unique password with at least 12 characters.
        </p>
        <Notice action={password} />
        <form
          onChange={(event) =>
            setPasswordDirty(
              Array.from(
                event.currentTarget.querySelectorAll<HTMLInputElement>(
                  'input[type="password"]',
                ),
              ).some((input) => !!input.value),
            )
          }
          onReset={() => setPasswordDirty(false)}
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
              disabled={password.busy}
              type="password"
              autoComplete="current-password"
              required
              maxLength={128}
            />
          </Field>
          <Field label="New password">
            <input
              name="newPassword"
              disabled={password.busy}
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
              disabled={password.busy}
              type="password"
              autoComplete="new-password"
              minLength={12}
              maxLength={128}
              required
            />
          </Field>
          <label className="checkbox">
            <input
              name="revoke"
              type="checkbox"
              defaultChecked
              disabled={password.busy}
            />
            Sign out other sessions when changing password
          </label>
          <div className="settings-save-actions">
            <button disabled={password.busy}>
              {password.busy ? "Changing password…" : "Change password"}
            </button>
            {passwordDirty && (
              <button type="reset" disabled={password.busy}>
                Clear password fields
              </button>
            )}
          </div>
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
          <div className="settings-save-actions">
            <button onClick={load.reload}>Refresh sessions</button>
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
          </div>
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
          {[...current.sessions]
            .sort(
              (a: any, b: any) =>
                Number(b.token === current.session.token) -
                  Number(a.token === current.session.token) ||
                new Date(b.updatedAt ?? b.createdAt).getTime() -
                  new Date(a.updatedAt ?? a.createdAt).getTime(),
            )
            .map((session: any) => (
              <li key={session.id}>
                <div>
                  <strong>{sessionDevice(session.userAgent)}</strong>
                  {session.token === current.session.token && (
                    <span className="session-current">This session</span>
                  )}
                  <details className="session-details">
                    <summary>Device details</summary>
                    <p>
                      {session.userAgent || "Device information unavailable"}
                    </p>
                  </details>
                </div>
                <small>
                  Last active{" "}
                  {new Date(
                    session.updatedAt ?? session.createdAt,
                  ).toLocaleString()}
                  <br />
                  Signed in {new Date(session.createdAt).toLocaleString()}
                </small>
              </li>
            ))}
        </ul>
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
    action = useAction(),
    draft = useSettingsForm(ws);
  if (load.error && !load.data)
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
      {load.error && (
        <div className="alert" role="alert">
          {load.error}
          <button onClick={load.reload}>Try again</button>
        </div>
      )}
      <Notice action={action} />
      <form
        ref={draft.ref}
        onChange={draft.onChange}
        onSubmit={(event) => {
          event.preventDefault();
          const data = new FormData(event.currentTarget);
          void action.run(async () => {
            await api(ws, "/profile", { name: data.get("name") }, "PUT");
            draft.saved();
            load.reload();
            changed();
          }, "Workspace name saved.");
        }}
      >
        <Field label="Workspace name">
          <input
            name="name"
            disabled={action.busy}
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
        <div className="settings-save-actions">
          <button className="primary" disabled={action.busy || !draft.dirty}>
            {action.busy ? "Saving…" : "Save workspace"}
          </button>
          {draft.dirty && (
            <>
              <button
                type="button"
                disabled={action.busy}
                onClick={draft.discard}
              >
                Discard changes
              </button>
              <span role="status">Unsaved changes</span>
            </>
          )}
        </div>
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
  const [visited, setVisited] = useState(() => new Set([tab]));
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
            onClick={() => {
              setVisited((previous) => new Set([...previous, key]));
              setTab(key);
            }}
          >
            {label}
          </button>
        ))}
      </nav>
      {admin && visited.has("agent") && (
        <div
          key={`agent:${ws}`}
          className="settings-section"
          hidden={tab !== "agent"}
        >
          {agentSettings}
        </div>
      )}
      {admin && visited.has("workspace") && (
        <div
          key={`workspace:${ws}`}
          className="settings-section"
          hidden={tab !== "workspace"}
        >
          <WorkspaceSettings ws={ws} changed={changed} />
        </div>
      )}
      {visited.has("profile") && (
        <div className="settings-section" hidden={tab !== "profile"}>
          <ProfileSettings changed={changed} />
        </div>
      )}
    </>
  );
}

function sessionDevice(userAgent?: string) {
  if (!userAgent) return "Unrecognized device";
  const browser = /Edg\//.test(userAgent)
    ? "Edge"
    : /Firefox\//.test(userAgent)
      ? "Firefox"
      : /Chrome\/|CriOS\//.test(userAgent)
        ? "Chrome"
        : /Safari\//.test(userAgent)
          ? "Safari"
          : "Browser";
  const system = /iPhone/.test(userAgent)
    ? "iPhone"
    : /iPad/.test(userAgent)
      ? "iPad"
      : /Android/.test(userAgent)
        ? "Android"
        : /Windows/.test(userAgent)
          ? "Windows"
          : /Macintosh|Mac OS X/.test(userAgent)
            ? "macOS"
            : /Linux/.test(userAgent)
              ? "Linux"
              : "unknown device";
  return `${browser} on ${system}`;
}
