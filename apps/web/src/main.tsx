import "@fontsource/dm-sans/latin-400.css";
import "@fontsource/dm-sans/latin-500.css";
import "@fontsource/dm-sans/latin-600.css";
import "@fontsource/dm-sans/latin-700.css";
import "@fontsource/manrope/latin-500.css";
import "@fontsource/manrope/latin-600.css";
import "@fontsource/manrope/latin-700.css";
import "@fontsource/manrope/latin-800.css";
import React, {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { createRoot } from "react-dom/client";
import { createAuthClient } from "better-auth/react";
import "./style.css";

const auth = createAuthClient();
type Row = Record<string, any>;
async function request(
  path: string,
  data?: unknown,
  method?: string,
  bearer?: string,
) {
  const res = await fetch(path, {
    method: method ?? (data === undefined ? "GET" : "POST"),
    headers: {
      ...(data instanceof FormData
        ? {}
        : { "Content-Type": "application/json" }),
      ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
    },
    body:
      data === undefined
        ? undefined
        : data instanceof FormData
          ? data
          : JSON.stringify(data),
  });
  const result = await res.json();
  if (!res.ok)
    throw new Error(result.error ?? "The request could not be completed");
  return result;
}
const api = (
  ws: string,
  path: string,
  data?: unknown,
  method?: string,
  bearer?: string,
) => request(`/v2/workspaces/${ws}${path}`, data, method, bearer);
function useLoad(fn: () => Promise<any>, keys: unknown[]) {
  const [data, setData] = useState<any>(null),
    [error, setError] = useState(""),
    [version, setVersion] = useState(0);
  useEffect(() => {
    let live = true;
    setError("");
    fn()
      .then((v) => {
        if (live) setData(v);
      })
      .catch((e) => {
        if (live) setError(e.message);
      });
    return () => {
      live = false;
    };
  }, [...keys, version]);
  return { data, error, reload: () => setVersion((v) => v + 1) };
}
function Logo() {
  return (
    <span className="brand">
      <svg viewBox="0 0 32 32" aria-hidden="true">
        <rect width="32" height="32" rx="10" fill="currentColor" />
        <path d="M10 9h13v4h-9v4h7v4h-7v5h-4z" fill="white" />
      </svg>
      FieldKit<span className="edition">OPEN SOURCE</span>
    </span>
  );
}
function Icon({ name }: { name: string }) {
  const paths: Record<string, string> = {
    Setup: "M4 12l5 5L20 6",
    Inbox: "M3 4h18v16H3z M3 13h5l2 3h4l2-3h5",
    Knowledge:
      "M4 3h6c2 0 2 2 2 2s0-2 2-2h6v17h-6c-2 0-2 1-2 1s0-1-2-1H4z M12 5v16",
    Connections:
      "M10 13a5 5 0 007 0l3-3a5 5 0 00-7-7l-2 2 M14 11a5 5 0 00-7 0l-3 3a5 5 0 007 7l2-2",
    Actions: "M13 2L4 14h7l-1 8 10-13h-8z",
    Publish: "M12 3v12 M7 8l5-5 5 5 M4 14v7h16v-7",
    Team: "M16 21v-2a4 4 0 00-4-4H6a4 4 0 00-4 4v2 M9 11a4 4 0 100-8 4 4 0 000 8 M18 3a4 4 0 010 8 M22 21v-2a4 4 0 00-3-4",
    Settings:
      "M12 8a4 4 0 100 8 4 4 0 000-8 M12 2v3 M12 19v3 M2 12h3 M19 12h3 M5 5l2 2 M17 17l2 2 M5 19l2-2 M17 7l2-2",
    Activity: "M2 12h5l3-8 4 16 3-8h5",
  };
  return (
    <svg className="icon" viewBox="0 0 24 24" aria-hidden="true">
      <path d={paths[name] ?? paths.Activity} />
    </svg>
  );
}
function Badge({ value }: { value: string }) {
  return (
    <span
      className={`badge ${["ready", "connected", "completed", "approved", "resolved", "delivered"].includes(value) ? "good" : ["failed", "unknown", "disconnected"].includes(value) ? "bad" : "neutral"}`}
    >
      {value.replaceAll("_", " ")}
    </span>
  );
}
function Alert({ children }: { children?: ReactNode }) {
  return children ? (
    <div className="alert" role="alert">
      {children}
    </div>
  ) : null;
}
function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <span className="empty-symbol">↗</span>
      <h3>{title}</h3>
      <p>{children}</p>
    </div>
  );
}
function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: ReactNode;
  hint?: string;
}) {
  return (
    <div className="field">
      <label>
        <span>{label}</span>
        {children}
      </label>
      {hint && <small>{hint}</small>}
    </div>
  );
}
function useAction() {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [success, setSuccess] = useState("");
  return {
    busy,
    error,
    success,
    run: async (fn: () => Promise<void>, message = "") => {
      setBusy(true);
      setError("");
      setSuccess("");
      try {
        await fn();
        setSuccess(message);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Something went wrong");
      } finally {
        setBusy(false);
      }
    },
  };
}
function AuthScreen({
  done,
  compact = false,
}: {
  done: () => void;
  compact?: boolean;
}) {
  const [mode, setMode] = useState(
      new URLSearchParams(location.search).has("token") ? "reset" : "login",
    ),
    a = useAction();
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const d = new FormData(e.currentTarget);
    await a.run(
      async () => {
        let result: any;
        if (mode === "signup")
          result = await auth.signUp.email({
            email: String(d.get("email")),
            password: String(d.get("password")),
            name: String(d.get("name")),
            callbackURL: location.origin + location.pathname,
          });
        else if (mode === "forgot")
          result = await auth.requestPasswordReset({
            email: String(d.get("email")),
            redirectTo: location.origin + "/reset-password",
          });
        else if (mode === "reset")
          result = await auth.resetPassword({
            newPassword: String(d.get("password")),
            token: new URLSearchParams(location.search).get("token") ?? "",
          });
        else
          result = await auth.signIn.email({
            email: String(d.get("email")),
            password: String(d.get("password")),
          });
        if (result.error) throw new Error(result.error.message);
        if (mode === "login") done();
      },
      mode === "signup"
        ? "Check your email to verify your account."
        : mode === "forgot"
          ? "If an account exists, a reset link has been sent."
          : mode === "reset"
            ? "Password updated. You can sign in."
            : "",
    );
  }
  return (
    <div className={compact ? "auth-inline" : "auth-page"}>
      {!compact && (
        <div className="auth-story">
          <Logo />
          <div>
            <span className="eyebrow">SUPPORT THAT KNOWS YOUR BUSINESS</span>
            <h1>
              Good answers.
              <br />
              Thoughtful actions.
              <br />
              <em>Your control.</em>
            </h1>
            <p>
              Bring your knowledge and your support tools together. Give your
              team an agent they can trust, on infrastructure you own.
            </p>
          </div>
          <span className="subtle">
            Self-hosted · Apache 2.0 · Built for real conversations
          </span>
        </div>
      )}
      <div className="auth-panel">
        <span className="eyebrow">WELCOME TO FIELDKIT</span>
        <h2>
          {mode === "signup"
            ? "Create your account"
            : mode === "forgot"
              ? "Reset your password"
              : mode === "reset"
                ? "Choose a new password"
                : "Welcome back"}
        </h2>
        <p className="muted">
          {mode === "signup"
            ? "Verify your email to get started."
            : "Sign in to continue the conversation."}
        </p>
        <form onSubmit={submit}>
          {mode === "signup" && (
            <Field label="Name">
              <input name="name" autoComplete="name" required />
            </Field>
          )}
          {mode !== "reset" && (
            <Field label="Email">
              <input name="email" type="email" autoComplete="email" required />
            </Field>
          )}
          {mode !== "forgot" && (
            <Field
              label="Password"
              hint={mode === "signup" ? "At least 12 characters." : undefined}
            >
              <input
                name="password"
                type="password"
                minLength={mode === "login" ? 1 : 12}
                autoComplete={
                  mode === "login" ? "current-password" : "new-password"
                }
                required
              />
            </Field>
          )}
          <Alert>{a.error}</Alert>
          {a.success && (
            <p className="success" role="status">
              {a.success}
            </p>
          )}
          <button className="primary full" disabled={a.busy}>
            {a.busy
              ? "Working…"
              : mode === "signup"
                ? "Create account"
                : mode === "forgot"
                  ? "Send reset link"
                  : mode === "reset"
                    ? "Update password"
                    : "Sign in"}
          </button>
        </form>
        <div className="auth-links">
          <button
            onClick={() => setMode(mode === "signup" ? "login" : "signup")}
          >
            {mode === "signup"
              ? "Already have an account? Sign in"
              : "Create an account"}
          </button>
          <button
            onClick={() => setMode(mode === "forgot" ? "login" : "forgot")}
          >
            {mode === "forgot" ? "Back to sign in" : "Forgot password?"}
          </button>
        </div>
      </div>
    </div>
  );
}
function WorkspaceSetup({ done }: { done: () => void }) {
  const a = useAction(),
    info = useLoad(() => request("/v2/installation"), []);
  return (
    <div className="setup-page">
      <Logo />
      <div className="panel setup-card">
        <span className="eyebrow">YOUR FIRST WORKSPACE</span>
        <h1>A home for your support.</h1>
        <p className="muted">
          Name your business and choose the address for its support portal.
        </p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const d = new FormData(e.currentTarget);
            void a.run(async () => {
              await request("/v2/workspaces", {
                name: d.get("name"),
                slug: d.get("slug"),
                setupToken: d.get("setupToken") || undefined,
              });
              done();
            });
          }}
        >
          <Field label="Business name">
            <input name="name" required placeholder="Your business" />
          </Field>
          <Field
            label="Portal address"
            hint="Lowercase letters, numbers, and hyphens."
          >
            <div className="input-prefix">
              <span>/support/</span>
              <input
                name="slug"
                pattern="[a-z0-9][a-z0-9-]{2,47}"
                required
                placeholder="your-business"
              />
            </div>
          </Field>
          {!info.data?.initialized && (
            <Field
              label="Installation setup token"
              hint="Find FIELDKIT_SETUP_TOKEN in your server’s .env file."
            >
              <input name="setupToken" type="password" required />
            </Field>
          )}
          <Alert>{a.error}</Alert>
          <button className="primary" disabled={a.busy}>
            Create workspace →
          </button>
        </form>
      </div>
    </div>
  );
}
const sections = [
  "Setup",
  "Inbox",
  "Knowledge",
  "Connections",
  "Actions",
  "Publish",
  "Team",
  "Settings",
  "Activity",
];
function App() {
  const [session, setSession] = useState<any>(undefined),
    [ws, setWs] = useState(
      new URLSearchParams(location.search).get("workspace") ?? "",
    ),
    [view, setView] = useState(() => {
      const v = new URLSearchParams(location.search).get("view");
      return sections.find((s) => s.toLowerCase() === v) ?? "Setup";
    }),
    [menu, setMenu] = useState(false);
  const refresh = () =>
    request("/v2/me")
      .then((v) => {
        setSession(v);
        setWs((old) =>
          v.workspaces.some((w: Row) => w.id === old)
            ? old
            : (v.workspaces[0]?.id ?? ""),
        );
      })
      .catch(() => setSession(null));
  useEffect(() => {
    void refresh();
  }, []);
  const invite = new URLSearchParams(location.search).get("invite");
  const invitation = useAction();
  useEffect(() => {
    if (session && invite)
      void invitation.run(async () => {
        await request("/v2/invitations/accept", { token: invite });
        history.replaceState({}, "", "/");
        await refresh();
      });
  }, [session?.user?.id, invite]);
  if (session === undefined)
    return (
      <div className="loading">
        <Logo />
        <p>Opening your workspace…</p>
      </div>
    );
  if (!session) return <AuthScreen done={() => void refresh()} />;
  if (invite)
    return (
      <div className="loading">
        <Logo />
        <Alert>{invitation.error}</Alert>
        <p>Accepting your invitation…</p>
      </div>
    );
  if (!ws) return <WorkspaceSetup done={() => void refresh()} />;
  const workspace = session.workspaces.find((w: Row) => w.id === ws),
    role = workspace?.role;
  const go = (v: string) => {
    setView(v);
    setMenu(false);
    history.replaceState({}, "", `/?workspace=${ws}&view=${v.toLowerCase()}`);
  };
  return (
    <div className="shell">
      <aside className={menu ? "sidebar mobile-open" : "sidebar"}>
        <Logo />
        <label className="workspace-switch">
          <span>WORKSPACE</span>
          <select
            aria-label="Workspace"
            value={ws}
            onChange={(e) => setWs(e.target.value)}
          >
            {session.workspaces.map((w: Row) => (
              <option value={w.id} key={w.id}>
                {w.name}
              </option>
            ))}
          </select>
        </label>
        <nav aria-label="Main navigation">
          {sections
            .filter(
              (s) =>
                role !== "agent" ||
                ["Inbox", "Knowledge", "Actions", "Activity"].includes(s),
            )
            .map((s) => (
              <button
                className={view === s ? "nav-item selected" : "nav-item"}
                onClick={() => go(s)}
                key={s}
              >
                <Icon name={s} />
                {s}
                {s === "Setup" && <span className="nav-dot" />}
              </button>
            ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="own-it">
            <span className="status-dot" /> Your infrastructure. Your data.
          </div>
          <div className="profile">
            <span className="avatar">
              {session.user.name.slice(0, 1).toUpperCase()}
            </span>
            <div>
              <strong>{session.user.name}</strong>
              <small>{role}</small>
            </div>
            <button
              title="Sign out"
              aria-label="Sign out"
              onClick={() => void auth.signOut().then(() => refresh())}
            >
              ↗
            </button>
          </div>
        </div>
      </aside>
      <main className="workspace">
        <header className="topbar">
          <button
            className="mobile-toggle"
            onClick={() => setMenu(!menu)}
            aria-label="Toggle navigation"
          >
            ☰
          </button>
          <div>
            <span className="breadcrumb">{workspace?.name}</span>
            <span className="separator">/</span>
            <strong>{view}</strong>
          </div>
          <a
            className="quiet-link"
            href={`/support/${workspace?.slug}`}
            target="_blank"
            rel="noreferrer"
          >
            View support portal ↗
          </a>
        </header>
        <div className="workspace-body" key={ws + view}>
          {view === "Setup" ? (
            <Setup ws={ws} go={go} />
          ) : view === "Inbox" ? (
            <Inbox ws={ws} role={role} />
          ) : view === "Knowledge" ? (
            <KnowledgePage ws={ws} admin={role !== "agent"} />
          ) : view === "Connections" ? (
            <ConnectionsPage ws={ws} owner={role === "owner"} />
          ) : view === "Actions" ? (
            <ActionsPage ws={ws} owner={role === "owner"} />
          ) : view === "Publish" ? (
            <PublishPage
              ws={ws}
              slug={workspace.slug}
              owner={role === "owner"}
            />
          ) : view === "Team" ? (
            <TeamPage ws={ws} />
          ) : view === "Settings" ? (
            <SettingsPage ws={ws} />
          ) : (
            <ActivityPage ws={ws} admin={role !== "agent"} />
          )}
        </div>
      </main>
    </div>
  );
}
function Heading({
  eyebrow,
  title,
  children,
  action,
}: {
  eyebrow: string;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="page-heading">
      <div>
        <span className="eyebrow">{eyebrow}</span>
        <h1>{title}</h1>
        {children && <p>{children}</p>}
      </div>
      {action}
    </div>
  );
}
function Setup({ ws, go }: { ws: string; go: (s: string) => void }) {
  const l = useLoad(async () => {
    const [base, connections, knowledge, inbox, actions] = await Promise.all([
      api(ws, ""),
      api(ws, "/connections"),
      api(ws, "/sources"),
      api(ws, "/conversations"),
      api(ws, "/actions"),
    ]);
    return { base, connections, knowledge, inbox, actions };
  }, [ws]);
  const d = l.data;
  const preview = useAction(),
    [previewResult, setPreviewResult] = useState<Row | null>(null);
  const tasks = [
    {
      title: "Connect your AI model",
      text: "Use your own OpenAI account and set a usage budget.",
      view: "Connections",
      done: d?.connections.connections.some(
        (c: Row) => c.provider === "openai" && c.status === "connected",
      ),
    },
    {
      title: "Give your agent the right knowledge",
      text: "Upload documents or connect the sources your team uses.",
      view: "Knowledge",
      done: d?.knowledge.sources.some((s: Row) => s.status === "ready"),
    },
    {
      title: "Decide what your agent can do",
      text: "Configure account actions and the rules for human approval.",
      view: "Actions",
      done: (d?.actions.actions.length ?? 0) > 0,
    },
    {
      title: "Open your support channels",
      text: "Publish your portal and widget, or connect Zendesk.",
      view: "Publish",
      done: d?.base.channels.some((c: Row) => c.published),
    },
  ];
  return (
    <>
      <Heading
        eyebrow="MAKE IT YOURS"
        title="A thoughtful start to better support."
      >
        Connect what your business knows. Choose what your agent can do. Stay in
        control.
      </Heading>
      <Alert>{l.error}</Alert>
      <div className="setup-hero">
        <div>
          <span className="eyebrow">ONE AGENT. YOUR SUPPORT, CONNECTED.</span>
          <h2>
            Meet customers
            <br />
            where they need you.
          </h2>
          <p>
            Keep your existing helpdesk or create a support experience of your
            own. FieldKit brings the knowledge and actions together.
          </p>
          <button
            className="primary"
            onClick={() => go(tasks.find((t) => !t.done)?.view ?? "Inbox")}
          >
            Continue setup →
          </button>
        </div>
        <div className="orbit">
          <div className="orbit-source top">Your documents</div>
          <div className="orbit-source left">Zendesk</div>
          <div className="orbit-core">
            <Logo />
          </div>
          <div className="orbit-source right">Your tools</div>
          <div className="orbit-source bottom">Your customers</div>
        </div>
      </div>
      <div className="metric-row">
        <div>
          <small>CONVERSATIONS</small>
          <strong>{d?.inbox.conversations.length ?? "—"}</strong>
          <span>In your workspace</span>
        </div>
        <div>
          <small>KNOWLEDGE SOURCES</small>
          <strong>
            {d?.knowledge.sources.filter((s: Row) => s.status === "ready")
              .length ?? "—"}
          </strong>
          <span>Ready for your team</span>
        </div>
        <div>
          <small>MODEL TOKENS THIS MONTH</small>
          <strong>
            {d
              ? Number(d.base.usage.input_tokens) +
                Number(d.base.usage.output_tokens)
              : "—"}
          </strong>
          <span>Actual recorded usage</span>
        </div>
      </div>
      <section className="panel agent-preview">
        <h2>Try a customer question</h2>
        <p className="muted">
          Preview answers from customer-approved knowledge before publishing.
          This uses your model account and cannot perform account actions.
        </p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const question = new FormData(e.currentTarget).get("question");
            void preview.run(async () =>
              setPreviewResult(await api(ws, "/agent/test", { question })),
            );
          }}
        >
          <Field label="Test question">
            <input
              name="question"
              required
              placeholder="How do returns work?"
            />
          </Field>
          <button className="primary" disabled={preview.busy}>
            {preview.busy ? "Thinking…" : "Test answer"}
          </button>
        </form>
        <Alert>{preview.error}</Alert>
        {previewResult && (
          <div className="preview-result">
            <Badge value={previewResult.intent} />
            <p>{previewResult.answer}</p>
            {previewResult.citations.map((c: Row) => (
              <blockquote key={c.id}>
                {c.title} · v{c.version}
                <p>{c.excerpt}</p>
              </blockquote>
            ))}
          </div>
        )}
      </section>
      <h2 className="section-title">Your launch checklist</h2>
      <div className="checklist">
        {tasks.map((t, i) => (
          <button key={t.title} onClick={() => go(t.view)}>
            <span className={t.done ? "step done" : "step"}>
              {t.done ? "✓" : `0${i + 1}`}
            </span>
            <div>
              <strong>{t.title}</strong>
              <p>{t.text}</p>
            </div>
            <span>↗</span>
          </button>
        ))}
      </div>
    </>
  );
}
function useConversationEvents(
  ws: string,
  id: string | undefined,
  reload: () => void,
  bearer?: string,
) {
  const callback = useRef(reload);
  callback.current = reload;
  useEffect(() => {
    if (!id) return;
    const controller = new AbortController();
    let retry: ReturnType<typeof setTimeout>;
    const connect = async () => {
      try {
        const res = await fetch(
          `/v2/workspaces/${ws}/conversations/${id}/events`,
          {
            signal: controller.signal,
            headers: bearer ? { Authorization: `Bearer ${bearer}` } : {},
          },
        );
        if (!res.ok) return;
        const reader = res.body!.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let index;
          while ((index = buffer.indexOf("\n\n")) >= 0) {
            const event = buffer.slice(0, index);
            buffer = buffer.slice(index + 2);
            if (event.includes("data:")) callback.current();
          }
        }
      } catch {}
      if (!controller.signal.aborted) retry = setTimeout(connect, 2000);
    };
    void connect();
    return () => {
      controller.abort();
      clearTimeout(retry);
    };
  }, [ws, id, bearer]);
}
function Inbox({ ws, role }: { ws: string; role: string }) {
  const l = useLoad(() => api(ws, "/conversations"), [ws]),
    [selected, setSelected] = useState("");
  const detail = useLoad(
    () =>
      selected ? api(ws, `/conversations/${selected}`) : Promise.resolve(null),
    [ws, selected],
  );
  const a = useAction(),
    members = useLoad(() => api(ws, "/members"), [ws]);
  const [note, setNote] = useState(false);
  useConversationEvents(ws, selected, () => {
    detail.reload();
    l.reload();
  });
  useEffect(() => {
    if (!selected && l.data?.conversations.length)
      setSelected(l.data.conversations[0].id);
  }, [l.data]);
  const control = (d: Row) =>
    a.run(async () => {
      await api(ws, `/conversations/${selected}/control`, d);
      detail.reload();
      l.reload();
    });
  return (
    <>
      <Heading
        eyebrow="YOUR SUPPORT DESK"
        title="Every conversation, in good hands."
      >
        Your agent and your team, working from the same context.
      </Heading>
      <Alert>{l.error || detail.error || a.error}</Alert>
      <div className="inbox">
        <section className="conversation-list">
          <div className="list-title">
            <strong>All conversations</strong>
            <span>{l.data?.conversations.length ?? 0}</span>
          </div>
          {l.data?.conversations.length ? (
            l.data.conversations.map((c: Row) => (
              <button
                key={c.id}
                onClick={() => setSelected(c.id)}
                className={
                  selected === c.id
                    ? "conversation-card active"
                    : "conversation-card"
                }
              >
                <div>
                  <span className="avatar small">
                    {(c.customer_name || "V")[0]}
                  </span>
                  <strong>{c.customer_name || "Visitor"}</strong>
                  <small>{new Date(c.updated_at).toLocaleDateString()}</small>
                </div>
                <h3>{c.subject}</h3>
                <Badge value={c.status} />
              </button>
            ))
          ) : (
            <Empty title="Ready for your first conversation">
              Messages from your portal, widget, and Zendesk appear here.
            </Empty>
          )}
        </section>
        {detail.data ? (
          <section className="conversation-detail">
            <header>
              <div>
                <span className="eyebrow">
                  {detail.data.conversation.external_id
                    ? "ZENDESK #" + detail.data.conversation.external_id
                    : "CUSTOMER CONVERSATION"}
                </span>
                <h2>{detail.data.conversation.subject}</h2>
              </div>
              <Badge
                value={
                  detail.data.conversation.mode === "human"
                    ? "human takeover"
                    : "agent active"
                }
              />
            </header>
            <div className="conversation-controls">
              <select
                aria-label="Assign conversation"
                value={detail.data.conversation.assigned_to ?? ""}
                onChange={(e) =>
                  void control({ assignedTo: e.target.value || null })
                }
              >
                <option value="">Unassigned</option>
                {members.data?.members.map((m: Row) => (
                  <option key={m.user_id} value={m.user_id}>
                    {m.name}
                  </option>
                ))}
              </select>
              <button
                onClick={() =>
                  void control({
                    mode:
                      detail.data.conversation.mode === "agent"
                        ? "human"
                        : "agent",
                  })
                }
              >
                {detail.data.conversation.mode === "agent"
                  ? "Take over"
                  : "Resume agent"}
              </button>
              <button
                onClick={() =>
                  void control({
                    status:
                      detail.data.conversation.status === "resolved"
                        ? "open"
                        : "resolved",
                  })
                }
              >
                {detail.data.conversation.status === "resolved"
                  ? "Reopen"
                  : "Resolve"}
              </button>
            </div>
            <div className="messages">
              <MessageList messages={detail.data.messages} />
              {detail.data.approvals
                .filter((p: Row) => p.status === "pending")
                .map((p: Row) => (
                  <div className="approval-box" key={p.id}>
                    <span className="eyebrow">APPROVAL REQUIRED</span>
                    <h3>{p.proposal.reason}</h3>
                    <pre>{JSON.stringify(p.proposal.parameters, null, 2)}</pre>
                    <p>
                      Bound to this customer, action revision, and policy.
                      Expires {new Date(p.expires_at).toLocaleString()}.
                    </p>
                    {role !== "agent" && (
                      <div className="button-row">
                        <button
                          disabled={a.busy}
                          onClick={() =>
                            void a.run(async () => {
                              await api(ws, `/approvals/${p.id}/decision`, {
                                hash: p.hash,
                                decision: "reject",
                              });
                              detail.reload();
                            })
                          }
                        >
                          Reject
                        </button>
                        <button
                          className="primary"
                          disabled={a.busy}
                          onClick={() => {
                            if (
                              confirm(
                                "Approve this exact account action? It will execute against the connected provider.",
                              )
                            )
                              void a.run(async () => {
                                await api(ws, `/approvals/${p.id}/decision`, {
                                  hash: p.hash,
                                  decision: "approve",
                                });
                                detail.reload();
                              });
                          }}
                        >
                          Approve action
                        </button>
                      </div>
                    )}
                  </div>
                ))}
            </div>
            <form
              className="reply-form"
              onSubmit={(e) => {
                e.preventDefault();
                const form = e.currentTarget;
                const body = new FormData(form).get("body");
                void a.run(async () => {
                  await api(
                    ws,
                    `/conversations/${selected}/${note ? "notes" : "messages"}`,
                    { body, requestKey: crypto.randomUUID() },
                  );
                  form.reset();
                  detail.reload();
                  l.reload();
                });
              }}
            >
              <textarea
                aria-label="Reply"
                name="body"
                required
                placeholder={
                  note
                    ? "Write a private note for your team…"
                    : "Write a reply to the customer…"
                }
              />
              <div>
                <label className="checkbox">
                  <input
                    type="checkbox"
                    checked={note}
                    onChange={(e) => setNote(e.target.checked)}
                  />
                  Internal note
                </label>
                <button className="primary" disabled={a.busy}>
                  {note ? "Add note" : "Send reply"} →
                </button>
              </div>
            </form>
            <details className="run-details">
              <summary>Agent activity & evidence</summary>
              {detail.data.runs.map((r: Row) => (
                <article key={r.id}>
                  <Badge value={r.status} />
                  <p>
                    {r.state.error ??
                      r.state.draft?.reason ??
                      "Processing request"}
                  </p>
                  <pre>
                    {JSON.stringify(
                      {
                        proposal: r.state.proposal,
                        receipt: r.state.receipt,
                        evidence: r.state.evidence,
                      },
                      null,
                      2,
                    )}
                  </pre>
                </article>
              ))}
            </details>
          </section>
        ) : (
          <section className="conversation-detail">
            <Empty title="A little context goes a long way">
              Choose a conversation to read its history, review evidence, and
              help your customer.
            </Empty>
          </section>
        )}
      </div>
    </>
  );
}
function MessageList({ messages }: { messages: Row[] }) {
  return (
    <>
      {messages.map((m) => (
        <article className={`message ${m.role}`} key={m.id}>
          <div>
            <strong>
              {m.role === "assistant"
                ? "FieldKit"
                : m.role === "note"
                  ? "Internal note"
                  : m.role === "staff"
                    ? "Support team"
                    : "Customer"}
            </strong>
            <time>
              {new Date(m.created_at).toLocaleTimeString([], {
                hour: "2-digit",
                minute: "2-digit",
              })}
            </time>
          </div>
          <p>{m.body}</p>
          {m.citations?.length > 0 && (
            <details className="citations">
              <summary>
                {m.citations.length} source{m.citations.length === 1 ? "" : "s"}
              </summary>
              {m.citations.map((c: Row) => (
                <blockquote key={c.id}>
                  <strong>
                    {c.title} · v{c.version}
                  </strong>
                  <p>{c.excerpt}</p>
                </blockquote>
              ))}
            </details>
          )}
        </article>
      ))}
    </>
  );
}
async function googlePicker(
  ws: string,
  onPick: (files: any[]) => Promise<void>,
) {
  const config = await api(ws, "/connections/google/picker"),
    w = window as any;
  if (!w.gapi)
    await new Promise<void>((resolve, reject) => {
      const s = document.createElement("script");
      s.src = "https://apis.google.com/js/api.js";
      s.onload = () => resolve();
      s.onerror = () => reject(new Error("Google Picker could not load"));
      document.head.append(s);
    });
  await new Promise<void>((resolve) => w.gapi.load("picker", resolve));
  return new Promise<void>((resolve, reject) => {
    const picker = new w.google.picker.PickerBuilder()
      .setDeveloperKey(config.developerKey)
      .setAppId(config.appId)
      .setOAuthToken(config.accessToken)
      .setOrigin(location.origin)
      .addView(new w.google.picker.DocsView().setIncludeFolders(false))
      .enableFeature(w.google.picker.Feature.MULTISELECT_ENABLED)
      .setCallback((data: any) => {
        if (data.action === w.google.picker.Action.PICKED)
          onPick(data.docs).then(resolve, reject);
        else if (data.action === w.google.picker.Action.CANCEL) resolve();
      })
      .build();
    picker.setVisible(true);
  });
}
function KnowledgePage({ ws, admin }: { ws: string; admin: boolean }) {
  const l = useLoad(() => api(ws, "/sources"), [ws]),
    a = useAction(),
    [preview, setPreview] = useState<Row | null>(null),
    [kind, setKind] = useState("website");
  const upload = useRef<HTMLInputElement>(null);
  return (
    <>
      <Heading
        eyebrow="A SHARED SOURCE OF TRUTH"
        title="What your business knows."
        action={
          admin && (
            <button className="primary" onClick={() => upload.current?.click()}>
              ＋ Upload documents
            </button>
          )
        }
      >
        Bring in your documents and connected knowledge. Review what customers
        can see before you publish.
      </Heading>
      <input
        ref={upload}
        hidden
        type="file"
        accept=".pdf,.docx,.md,.txt"
        multiple
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          void a.run(async () => {
            for (const file of files) {
              const data = new FormData();
              data.append("file", file);
              await api(ws, "/sources/upload", data);
            }
            l.reload();
          }, "Files queued for ingestion.");
        }}
      />
      <Alert>{l.error || a.error}</Alert>
      {a.success && <p className="success">{a.success}</p>}
      <div className="knowledge-banner">
        <Icon name="Knowledge" />
        <p>
          <strong>Private until you say otherwise.</strong> Imported documents
          start as staff-only knowledge. Approving customer answers and
          publishing an article are separate choices.
        </p>
      </div>
      {admin && (
        <section className="panel">
          <h2>Connect a knowledge source</h2>
          <form
            className="source-form"
            onSubmit={(e) => {
              e.preventDefault();
              const d = new FormData(e.currentTarget);
              void a.run(async () => {
                await api(ws, "/sources", {
                  kind,
                  title: d.get("title"),
                  locator: d.get("locator"),
                });
                l.reload();
              });
            }}
          >
            <Field label="Source">
              <select value={kind} onChange={(e) => setKind(e.target.value)}>
                <option value="website">Website page</option>
                <option value="notion">Notion page</option>
                <option value="zendesk">Zendesk article</option>
              </select>
            </Field>
            <Field label="Title">
              <input name="title" required placeholder="Getting started" />
            </Field>
            <Field
              label={
                kind === "website"
                  ? "Page URL"
                  : kind === "notion"
                    ? "Shared page ID"
                    : "Article ID"
              }
            >
              <input
                name="locator"
                required
                placeholder={
                  kind === "website"
                    ? "https://example.com/help"
                    : kind === "notion"
                      ? "Page ID shared with your connection"
                      : "123456789"
                }
              />
            </Field>
            <button disabled={a.busy}>Add source →</button>
          </form>
          <div className="inline-note">
            Notion and Zendesk need a connection first.{" "}
            <button
              className="link"
              disabled={a.busy}
              onClick={() =>
                void a.run(async () => {
                  await googlePicker(ws, async (files) => {
                    for (const f of files)
                      await api(ws, "/sources", {
                        kind: "google",
                        title: f.name,
                        locator: f.id,
                      });
                  });
                  l.reload();
                })
              }
            >
              Choose files from Google Drive ↗
            </button>
          </div>
        </section>
      )}
      <section className="panel">
        <div className="section-heading">
          <h2>Your knowledge library</h2>
          <button onClick={l.reload}>Refresh status</button>
        </div>
        {l.data?.sources.length ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Source</th>
                  <th>Index status</th>
                  <th>Audience</th>
                  <th>Article</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {l.data.sources.map((s: Row) => {
                  const doc = l.data.documents.find(
                    (d: Row) => d.source_id === s.id && d.active,
                  );
                  return (
                    <tr key={s.id}>
                      <td>
                        <strong>{s.title}</strong>
                        <small>
                          {s.kind} ·{" "}
                          {s.last_synced
                            ? new Date(s.last_synced).toLocaleString()
                            : "Not indexed yet"}
                        </small>
                        {s.error && (
                          <small className="error-text">{s.error}</small>
                        )}
                      </td>
                      <td>
                        <Badge value={s.status} />
                      </td>
                      <td>
                        {admin ? (
                          <select
                            aria-label={`Audience for ${s.title}`}
                            value={s.visibility}
                            onChange={(e) =>
                              void a.run(async () => {
                                await api(
                                  ws,
                                  `/sources/${s.id}/visibility`,
                                  { visibility: e.target.value },
                                  "PUT",
                                );
                                l.reload();
                              })
                            }
                          >
                            <option value="staff">Staff only</option>
                            <option value="customer">Customer answers</option>
                          </select>
                        ) : (
                          s.visibility
                        )}
                      </td>
                      <td>
                        {doc ? (
                          <>
                            <button
                              className="link"
                              onClick={() =>
                                void a.run(async () =>
                                  setPreview(
                                    await api(ws, `/documents/${doc.id}`),
                                  ),
                                )
                              }
                            >
                              Preview v{doc.version}
                            </button>
                            {admin && (
                              <button
                                className="link"
                                disabled={s.visibility !== "customer" || a.busy}
                                onClick={() =>
                                  void a.run(async () => {
                                    await api(
                                      ws,
                                      `/documents/${doc.id}/publish`,
                                      { published: !doc.published },
                                    );
                                    l.reload();
                                  })
                                }
                              >
                                {doc.published
                                  ? "Unpublish article"
                                  : "Publish article"}
                              </button>
                            )}
                          </>
                        ) : (
                          <span className="muted">—</span>
                        )}
                      </td>
                      <td>
                        {admin && (
                          <div className="row-actions">
                            <button
                              title="Reindex"
                              onClick={() =>
                                void a.run(async () => {
                                  await api(ws, `/sources/${s.id}/refresh`, {});
                                  l.reload();
                                })
                              }
                            >
                              ↻
                            </button>
                            <button
                              title="Delete source"
                              onClick={() => {
                                if (
                                  confirm(
                                    "Remove this source and all its indexed content?",
                                  )
                                )
                                  void a.run(async () => {
                                    await api(
                                      ws,
                                      `/sources/${s.id}`,
                                      {},
                                      "DELETE",
                                    );
                                    l.reload();
                                  });
                              }}
                            >
                              ×
                            </button>
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty title="Give your agent something to work with">
            Start with your help articles, policies, or product documentation.
          </Empty>
        )}
      </section>
      {preview && (
        <dialog open className="preview-dialog">
          <header>
            <h2>{preview.title}</h2>
            <button onClick={() => setPreview(null)} aria-label="Close preview">
              ×
            </button>
          </header>
          <div className="article-body">{preview.body}</div>
        </dialog>
      )}
    </>
  );
}
function ConnectionsPage({ ws, owner }: { ws: string; owner: boolean }) {
  const l = useLoad(() => api(ws, "/connections"), [ws]),
    a = useAction(),
    [selected, setSelected] = useState("openai");
  return (
    <>
      <Heading
        eyebrow="WORKS WITH YOUR BUSINESS"
        title="Connect the tools you rely on."
      >
        Credentials stay encrypted on your server. Each connection belongs to
        this workspace.
      </Heading>
      <Alert>{l.error || a.error}</Alert>
      {a.success && <p className="success">{a.success}</p>}
      <div className="connection-grid">
        {[
          {
            id: "openai",
            letter: "O",
            name: "OpenAI",
            description:
              "Use your own model account for answers and knowledge retrieval.",
          },
          {
            id: "zendesk",
            letter: "Z",
            name: "Zendesk",
            description:
              "Bring AI capabilities to your existing helpdesk and conversations.",
          },
          {
            id: "stripe_test",
            letter: "S",
            name: "Stripe test",
            description:
              "Read verified billing records and perform approved account actions.",
          },
          {
            id: "stripe_live",
            letter: "S",
            name: "Stripe live",
            description:
              "A separate live connection. Actions must explicitly select live mode.",
          },
          {
            id: "notion",
            letter: "N",
            name: "Notion",
            description:
              "Keep the pages you choose connected to your knowledge library.",
          },
          {
            id: "google",
            letter: "G",
            name: "Google Drive",
            description:
              "Import selected files without opening your entire Drive.",
          },
        ].map((provider) => {
          const row = l.data?.connections.find(
            (r: Row) => r.provider === provider.id,
          );
          return (
            <button
              className={`connection-card ${selected === provider.id ? "chosen" : ""}`}
              key={provider.id}
              onClick={() => setSelected(provider.id)}
            >
              <span className={`provider-logo ${provider.id}`}>
                {provider.letter}
              </span>
              <h3>{provider.name}</h3>
              <p>{provider.description}</p>
              <Badge value={row?.status ?? "not connected"} />
              {row?.metadata.mode && <small>{row.metadata.mode} mode</small>}
            </button>
          );
        })}
      </div>
      {owner && (
        <section className="panel">
          <h2>Connect a custom API</h2>
          <p className="muted">
            Save a bearer token for your business API, then use this connection
            name in an action.
          </p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const form = e.currentTarget,
                d = new FormData(form);
              void a.run(async () => {
                await api(ws, "/connections/key", {
                  provider: `custom:${d.get("name")}`,
                  apiKey: d.get("key"),
                });
                form.reset();
                l.reload();
              }, "Custom API credentials saved.");
            }}
          >
            <div className="form-grid">
              <Field label="Custom connection name">
                <input
                  name="name"
                  pattern="[a-z][a-z0-9-]{1,49}"
                  required
                  placeholder="orders"
                />
              </Field>
              <Field label="Custom API bearer token">
                <input name="key" type="password" autoComplete="off" required />
              </Field>
            </div>
            <button disabled={a.busy}>Save custom connection</button>
          </form>
        </section>
      )}
      <section className="panel connection-settings">
        <h2>Configure {selected === "google" ? "Google Drive" : selected}</h2>
        {["openai", "stripe_test", "stripe_live", "notion"].includes(
          selected,
        ) && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const d = new FormData(e.currentTarget);
              void a.run(async () => {
                await api(ws, "/connections/key", {
                  provider: selected,
                  apiKey: d.get("key"),
                });
                l.reload();
                e.currentTarget?.reset();
              }, "Connection verified and saved.");
            }}
          >
            <Field
              label={
                selected.startsWith("stripe_")
                  ? "Restricted Stripe App key"
                  : selected === "notion"
                    ? "Internal connection token"
                    : "API key"
              }
              hint={
                selected.startsWith("stripe_")
                  ? "Install your Stripe App and provide its rk_test_ or rk_live_ key. This does not execute a payment."
                  : selected === "notion"
                    ? "Share the selected pages with this connection in Notion."
                    : undefined
              }
            >
              <input name="key" type="password" autoComplete="off" required />
            </Field>
            <button className="primary" disabled={a.busy}>
              Verify & connect
            </button>
          </form>
        )}
        {["zendesk", "google", "notion"].includes(selected) && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const d = new FormData(e.currentTarget);
              void a.run(async () => {
                const result = await api(
                  ws,
                  `/connections/${selected}/oauth`,
                  selected === "zendesk"
                    ? { subdomain: d.get("subdomain") }
                    : {},
                );
                location.assign(result.url);
              });
            }}
          >
            {selected === "zendesk" && (
              <Field label="Zendesk subdomain">
                <div className="input-prefix">
                  <input
                    name="subdomain"
                    required
                    pattern="[a-z0-9-]+"
                    placeholder="your-company"
                  />
                  <span>.zendesk.com</span>
                </div>
              </Field>
            )}
            <p className="muted">
              {l.data?.oauth[selected]
                ? "Authorize only the account and content you want to connect."
                : "Your server administrator must configure this provider’s OAuth app before connecting."}
            </p>
            <button disabled={!l.data?.oauth[selected] || a.busy}>
              Connect with {selected === "google" ? "Google" : selected} ↗
            </button>
          </form>
        )}
        {selected === "zendesk" && (
          <form
            className="webhook-form"
            onSubmit={(e) => {
              e.preventDefault();
              const d = new FormData(e.currentTarget);
              void a.run(async () => {
                await api(
                  ws,
                  "/connections/zendesk/webhook-secret",
                  { secret: d.get("secret") },
                  "PUT",
                );
              }, "Webhook signing secret saved.");
            }}
          >
            <h3>Receive ticket updates</h3>
            <p className="muted">
              Configure a signed Zendesk webhook with your ticket trigger. Send
              a JSON body containing <code>ticket_id</code> to:
            </p>
            <code className="copyable">{l.data?.webhookUrl}</code>
            <Field label="Webhook signing secret">
              <input name="secret" type="password" required />
            </Field>
            <button disabled={a.busy}>Save signing secret</button>
          </form>
        )}
        <button
          className="danger-link"
          onClick={() => {
            if (
              confirm(
                "Disconnect this provider? Its imported knowledge will stop being used.",
              )
            )
              void a.run(async () => {
                await api(ws, `/connections/${selected}`, {}, "DELETE");
                l.reload();
              });
          }}
        >
          Disconnect {selected}
        </button>
      </section>
    </>
  );
}
const actionDefaults = {
  name: "refund_payment",
  description:
    "Refund a verified captured payment when the customer requests a refund.",
  kind: "stripe_refund",
  enabled: false,
  config: { idempotent: false, mappingKey: "customer_id" },
  policy: {
    mode: "approval",
    maxAmountMinor: 0,
    currency: "usd",
    dailyLimit: 10,
  },
};
function ActionsPage({ ws, owner }: { ws: string; owner: boolean }) {
  const l = useLoad(() => api(ws, "/actions"), [ws]),
    a = useAction(),
    [edit, setEdit] = useState<Row | null>(null),
    [configText, setConfigText] = useState("{}");
  function select(row: Row) {
    setEdit({ ...row });
    setConfigText(JSON.stringify(row.config, null, 2));
  }
  return (
    <>
      <Heading
        eyebrow="USEFUL ACTIONS. EXPLICIT PERMISSION."
        title="Give your agent the right tools."
        action={
          owner && (
            <button
              className="primary"
              onClick={() => select({ ...actionDefaults })}
            >
              ＋ Create action
            </button>
          )
        }
      >
        Every account change starts with human approval. Enable automatic
        actions only within rules you choose.
      </Heading>
      <Alert>{l.error || a.error}</Alert>
      <div className="action-list">
        {l.data?.actions.length ? (
          l.data.actions.map((action: Row) => (
            <section className="panel action-card" key={action.id}>
              <div className="section-heading">
                <div>
                  <span className="eyebrow">
                    {action.kind.replaceAll("_", " ")}
                  </span>
                  <h2>{action.name}</h2>
                </div>
                <Badge value={action.enabled ? "enabled" : "disabled"} />
              </div>
              <p>{action.description}</p>
              <div className="policy-strip">
                <span>
                  {action.policy.mode === "approval"
                    ? "Human approval required"
                    : "Automatic within policy"}
                </span>
                <span>{action.policy.dailyLimit} automatic actions / day</span>
              </div>
              {owner && (
                <button onClick={() => select(action)}>
                  Configure action →
                </button>
              )}
            </section>
          ))
        ) : (
          <section className="panel">
            <Empty title="Useful tools, added deliberately">
              Add Stripe refunds, period-end cancellation, or a schema-validated
              connection to your own API.
            </Empty>
          </section>
        )}
      </div>
      {edit && (
        <section className="panel">
          <div className="section-heading">
            <h2>{edit.id ? "Edit action" : "Create an action"}</h2>
            <button onClick={() => setEdit(null)}>Close</button>
          </div>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const d = new FormData(e.currentTarget);
              void a.run(async () => {
                const config = edit.kind.startsWith("custom")
                  ? JSON.parse(configText)
                  : {
                      idempotent: false,
                      mappingKey: "customer_id",
                      stripeMode: d.get("stripeMode"),
                    };
                await api(
                  ws,
                  `/actions${edit.id ? "/" + edit.id : ""}`,
                  {
                    name: d.get("name"),
                    description: d.get("description"),
                    kind: edit.kind,
                    enabled: d.get("enabled") === "on",
                    config,
                    policy: {
                      mode: d.get("mode"),
                      maxAmountMinor: Number(d.get("maxAmountMinor")),
                      currency: d.get("currency"),
                      dailyLimit: Number(d.get("dailyLimit")),
                    },
                  },
                  edit.id ? "PUT" : "POST",
                );
                setEdit(null);
                l.reload();
              });
            }}
          >
            <div className="form-grid">
              <Field label="Action name">
                <input
                  name="name"
                  defaultValue={edit.name}
                  pattern="[a-z][a-z0-9_]{2,49}"
                  required
                />
              </Field>
              <Field label="Tool">
                <select
                  value={edit.kind}
                  onChange={(e) => setEdit({ ...edit, kind: e.target.value })}
                >
                  <option value="stripe_refund">
                    Stripe: refund a payment
                  </option>
                  <option value="stripe_cancel">
                    Stripe: cancel at period end
                  </option>
                  <option value="custom_read">Custom API: read data</option>
                  <option value="custom_write">Custom API: change data</option>
                </select>
              </Field>
            </div>
            <Field label="What should the agent use this for?">
              <textarea
                name="description"
                defaultValue={edit.description}
                minLength={8}
                required
              />
            </Field>
            {edit.kind.startsWith("stripe") && (
              <Field label="Stripe environment">
                <select
                  name="stripeMode"
                  defaultValue={edit.config.stripeMode ?? "test"}
                >
                  <option value="test">Test mode</option>
                  <option value="live">Live mode — real account changes</option>
                </select>
              </Field>
            )}
            {edit.kind.startsWith("custom") && (
              <Field
                label="Custom API configuration"
                hint="Provide endpoint, inputSchema, outputSchema, mappingKey, optional credentialId, and (for automatic writes) idempotent and lookupEndpoint. See the integration guide."
              >
                <textarea
                  className="code-editor"
                  value={configText}
                  onChange={(e) => setConfigText(e.target.value)}
                  rows={12}
                />
              </Field>
            )}
            <div className="form-grid">
              <Field label="Approval policy">
                <select name="mode" defaultValue={edit.policy.mode}>
                  <option value="approval">Always require approval</option>
                  <option value="automatic">Automatic within limits</option>
                </select>
              </Field>
              <Field label="Automatic refund limit (minor units)">
                <input
                  name="maxAmountMinor"
                  type="number"
                  min="0"
                  defaultValue={edit.policy.maxAmountMinor}
                />
              </Field>
              <Field label="Currency">
                <input
                  name="currency"
                  pattern="[a-z]{3}"
                  defaultValue={edit.policy.currency}
                />
              </Field>
              <Field label="Daily automatic action limit">
                <input
                  name="dailyLimit"
                  type="number"
                  min="1"
                  defaultValue={edit.policy.dailyLimit}
                />
              </Field>
            </div>
            <label className="checkbox">
              <input
                name="enabled"
                type="checkbox"
                defaultChecked={edit.enabled}
              />
              Enable this action
            </label>
            <button className="primary" disabled={a.busy}>
              Save action
            </button>
          </form>
        </section>
      )}
    </>
  );
}
function PublishPage({
  ws,
  slug,
  owner,
}: {
  ws: string;
  slug: string;
  owner: boolean;
}) {
  const l = useLoad(() => api(ws, ""), [ws]),
    a = useAction(),
    [secret, setSecret] = useState("");
  return (
    <>
      <Heading
        eyebrow="MEET YOUR CUSTOMERS"
        title="Your support, on your terms."
      >
        Publish the full portal, embed a bot on your website, or work inside
        Zendesk.
      </Heading>
      <Alert>{l.error || a.error}</Alert>
      {l.data?.channels.map((channel: Row) => (
        <section className="panel" key={channel.id}>
          <div className="section-heading">
            <div>
              <span className="eyebrow">
                {channel.kind === "portal"
                  ? "HELP CENTER + CUSTOMER ACCOUNTS"
                  : channel.kind === "widget"
                    ? "A CONVERSATION ON YOUR WEBSITE"
                    : "YOUR EXISTING HELPDESK"}
              </span>
              <h2>
                {channel.kind === "portal"
                  ? "Support portal"
                  : channel.kind === "widget"
                    ? "Embedded chatbot"
                    : "Zendesk agent"}
              </h2>
            </div>
            <Badge value={channel.published ? "published" : "unpublished"} />
          </div>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const d = new FormData(e.currentTarget);
              void a.run(async () => {
                await api(
                  ws,
                  `/channels/${channel.id}`,
                  {
                    published: d.get("published") === "on",
                    settings: {
                      origins: String(d.get("origins") ?? "")
                        .split("\n")
                        .map((s) => s.trim())
                        .filter(Boolean),
                      handoff: d.get("handoff") ?? "native",
                    },
                  },
                  "PUT",
                );
                l.reload();
              });
            }}
          >
            {channel.kind === "widget" && (
              <Field
                label="Allowed website origins"
                hint="One exact origin per line, for example https://www.yourcompany.com"
              >
                <textarea
                  name="origins"
                  defaultValue={(channel.settings.origins ?? []).join("\n")}
                />
              </Field>
            )}
            {channel.kind !== "zendesk" && (
              <Field label="When a person needs to help">
                <select
                  name="handoff"
                  defaultValue={channel.settings.handoff ?? "native"}
                >
                  <option value="native">Hand off to FieldKit inbox</option>
                  <option value="zendesk">Create a Zendesk ticket</option>
                </select>
              </Field>
            )}
            <label className="checkbox">
              <input
                name="published"
                type="checkbox"
                defaultChecked={channel.published}
              />
              Publish this channel
            </label>
            <button className="primary" disabled={a.busy}>
              Save channel
            </button>
          </form>
          {channel.kind === "portal" && (
            <a
              className="portal-link"
              href={`/support/${slug}`}
              target="_blank"
              rel="noreferrer"
            >
              {location.origin}/support/{slug} ↗
            </a>
          )}
          {channel.kind === "widget" && (
            <>
              <p className="muted">
                Add this snippet to your website after publishing:
              </p>
              <code className="copyable">{`<script src="${location.origin}/widget.js" data-workspace="${slug}" defer></script>`}</code>
            </>
          )}
        </section>
      ))}
      {owner && <ServiceCredentials ws={ws} />}
      <section className="panel">
        <h2>Identify customers from your website</h2>
        <p className="muted">
          Sign short-lived customer identities on your own server. The signing
          secret must never be included in browser code.
        </p>
        <button
          onClick={() =>
            void a.run(async () =>
              setSecret((await api(ws, "/identity-key", {})).secret),
            )
          }
        >
          Generate / rotate identity signing key
        </button>
        {secret && (
          <Field label="Copy this key now; it is shown only once">
            <input
              type="password"
              value={secret}
              readOnly
              onFocus={(e) => e.target.select()}
            />
          </Field>
        )}
      </section>
    </>
  );
}
function ServiceCredentials({ ws }: { ws: string }) {
  const l = useLoad(() => api(ws, "/credentials"), [ws]),
    a = useAction(),
    [secret, setSecret] = useState("");
  return (
    <section className="panel">
      <h2>Connect your server or assistant</h2>
      <p className="muted">
        Create a limited key for your server, the command-line client, or MCP.
        Keep it out of browser code.
      </p>
      <Alert>{l.error || a.error}</Alert>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const d = new FormData(e.currentTarget);
          void a.run(async () => {
            setSecret(
              (
                await api(ws, "/credentials", {
                  label: d.get("label"),
                  days: Number(d.get("days")),
                })
              ).token,
            );
            l.reload();
          });
        }}
      >
        <div className="form-grid">
          <Field label="Key name">
            <input name="label" required placeholder="Website backend" />
          </Field>
          <Field label="Expires in days">
            <input
              name="days"
              type="number"
              min="1"
              max="90"
              defaultValue="30"
              required
            />
          </Field>
        </div>
        <button disabled={a.busy}>Create service key</button>
      </form>
      {secret && (
        <Field label="Copy this service key now">
          <input
            type="password"
            value={secret}
            readOnly
            onFocus={(e) => e.target.select()}
          />
        </Field>
      )}
      {l.data?.credentials.map((key: Row) => (
        <div className="section-heading" key={key.id}>
          <div>
            <strong>{key.label}</strong>
            <p className="muted">
              Expires {new Date(key.expires_at).toLocaleDateString()}
            </p>
          </div>
          <button
            onClick={() =>
              void a.run(async () => {
                await api(ws, `/credentials/${key.id}`, undefined, "DELETE");
                l.reload();
              })
            }
          >
            Revoke
          </button>
        </div>
      ))}
    </section>
  );
}
function TeamPage({ ws }: { ws: string }) {
  const l = useLoad(
      async () => ({
        ...(await api(ws, "/members")),
        ...(await api(ws, "/contacts")),
      }),
      [ws],
    ),
    a = useAction();
  return (
    <>
      <Heading eyebrow="PEOPLE & PERMISSIONS" title="Keep your team connected.">
        Invite teammates and review which customer identities can access
        connected accounts.
      </Heading>
      <Alert>{l.error || a.error}</Alert>
      {a.success && <p className="success">{a.success}</p>}
      <section className="panel">
        <h2>Invite a teammate</h2>
        <form
          className="source-form"
          onSubmit={(e) => {
            e.preventDefault();
            const d = new FormData(e.currentTarget);
            void a.run(async () => {
              await api(ws, "/invitations", {
                email: d.get("email"),
                role: d.get("role"),
              });
              l.reload();
            }, "Invitation sent.");
          }}
        >
          <Field label="Email">
            <input name="email" type="email" required />
          </Field>
          <Field label="Role">
            <select name="role">
              <option value="agent">Agent — conversations and notes</option>
              <option value="admin">Admin — settings and approvals</option>
            </select>
          </Field>
          <button className="primary" disabled={a.busy}>
            Send invitation
          </button>
        </form>
        <div className="member-list">
          {l.data?.members.map((m: Row) => (
            <div key={m.user_id}>
              <span className="avatar">{m.name[0]}</span>
              <div>
                <strong>{m.name}</strong>
                <small>{m.email}</small>
              </div>
              <Badge value={m.role} />
            </div>
          ))}
        </div>
      </section>
      <section className="panel">
        <h2>Reviewed customer mappings</h2>
        <p className="muted">
          An email match alone does not authorize billing changes. Map a
          verified customer to their provider record after reviewing ownership.
        </p>
        {l.data?.contacts.length ? (
          l.data.contacts.map((contact: Row) => (
            <details className="contact-mapping" key={contact.id}>
              <summary>
                {contact.name || "Visitor"} ·{" "}
                {contact.email ?? contact.external_id ?? contact.id}{" "}
                <Badge value={contact.verified ? "verified" : "unverified"} />
              </summary>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  const d = new FormData(e.currentTarget);
                  void a.run(async () => {
                    await api(
                      ws,
                      `/contacts/${contact.id}/mapping`,
                      {
                        mappings: JSON.parse(String(d.get("mappings"))),
                        ...(d.get("userId") ? { userId: d.get("userId") } : {}),
                      },
                      "PUT",
                    );
                    l.reload();
                  }, "Reviewed mapping saved.");
                }}
              >
                <Field
                  label="Provider identities"
                  hint={
                    'For Stripe use "stripe_test" or "stripe_live" with its cus_ ID. Custom actions use their configured mapping key.'
                  }
                >
                  <textarea
                    name="mappings"
                    className="code-editor"
                    defaultValue={JSON.stringify(contact.mappings, null, 2)}
                  />
                </Field>
                <Field label="Verified portal user ID (optional)">
                  <input name="userId" defaultValue={contact.user_id ?? ""} />
                </Field>
                <button disabled={a.busy}>Save reviewed mapping</button>
              </form>
            </details>
          ))
        ) : (
          <Empty title="Customer identities will appear here">
            Verified portal users, signed website identities, and Zendesk
            requesters are kept separate until explicitly linked.
          </Empty>
        )}
      </section>
    </>
  );
}
function SettingsPage({ ws }: { ws: string }) {
  const l = useLoad(() => api(ws, ""), [ws]),
    a = useAction();
  const settings = l.data?.workspace.settings;
  return (
    <>
      <Heading
        eyebrow="YOUR AGENT’S WORKING AGREEMENT"
        title="Make FieldKit your own."
      >
        Set the tone, control model usage, and choose how your agent starts
        working.
      </Heading>
      <Alert>{l.error || a.error}</Alert>
      {a.success && <p className="success">{a.success}</p>}
      {settings && (
        <section className="panel">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const d = new FormData(e.currentTarget);
              void a.run(async () => {
                await api(
                  ws,
                  "/settings",
                  {
                    ...settings,
                    model: d.get("model"),
                    instructions: d.get("instructions"),
                    monthlyTokenBudget: Number(d.get("budget")),
                    retentionDays: Number(d.get("retention")),
                    greeting: d.get("greeting"),
                    brandColor: d.get("color"),
                    replies: d.get("replies"),
                  },
                  "PUT",
                );
                l.reload();
              }, "Workspace settings saved.");
            }}
          >
            <Field
              label="Agent instructions"
              hint="Describe your business and preferred tone. Permissions and action policies are controlled separately."
            >
              <textarea
                name="instructions"
                defaultValue={settings.instructions}
                rows={5}
              />
            </Field>
            <div className="form-grid">
              <Field label="Response model">
                <input name="model" defaultValue={settings.model} required />
              </Field>
              <Field label="Monthly token budget">
                <input
                  name="budget"
                  type="number"
                  min="1000"
                  defaultValue={settings.monthlyTokenBudget}
                />
              </Field>
              <Field label="Reply behavior">
                <select name="replies" defaultValue={settings.replies}>
                  <option value="review">Draft for staff review</option>
                  <option value="automatic">
                    Reply automatically from approved knowledge
                  </option>
                </select>
              </Field>
              <Field label="Resolved conversation retention (days)">
                <input
                  name="retention"
                  type="number"
                  min="7"
                  defaultValue={settings.retentionDays}
                />
              </Field>
              <Field label="Customer greeting">
                <input name="greeting" defaultValue={settings.greeting} />
              </Field>
              <Field label="Brand color">
                <input
                  name="color"
                  type="color"
                  defaultValue={settings.brandColor}
                />
              </Field>
            </div>
            <button className="primary" disabled={a.busy}>
              Save settings
            </button>
          </form>
        </section>
      )}
    </>
  );
}
function ActivityPage({ ws, admin }: { ws: string; admin: boolean }) {
  const l = useLoad(
      async () => ({
        ...(await api(ws, "/operations")),
        ...(admin ? await api(ws, "/operations/jobs") : {}),
        ...(admin ? await api(ws, "/audit") : {}),
      }),
      [ws],
    ),
    a = useAction();
  return (
    <>
      <Heading
        eyebrow="A CLEAR RECORD"
        title="See what happened. Know what’s next."
        action={<button onClick={l.reload}>Refresh</button>}
      >
        Confirmed actions, uncertain outcomes, background work, and the
        decisions behind them.
      </Heading>
      <Alert>{l.error || a.error}</Alert>
      <section className="panel">
        <h2>Account operations</h2>
        {l.data?.operations.length ? (
          l.data.operations.map((o: Row) => (
            <article className="activity-item" key={o.id}>
              <div>
                <Badge value={o.status} />
                <code>{o.id}</code>
              </div>
              <p>{o.error ?? o.resource}</p>
              {o.receipt && <pre>{JSON.stringify(o.receipt, null, 2)}</pre>}
              {admin && ["unknown", "sent"].includes(o.status) && (
                <button
                  onClick={() =>
                    void a.run(async () => {
                      await api(ws, `/operations/${o.id}/reconcile`, {});
                      l.reload();
                    })
                  }
                >
                  Look up provider outcome
                </button>
              )}
            </article>
          ))
        ) : (
          <Empty title="Every action will leave a record">
            Receipts appear here when an agent executes an approved account
            action.
          </Empty>
        )}
      </section>
      {admin && (
        <>
          <section className="panel">
            <h2>Background work requiring attention</h2>
            {l.data?.jobs?.map((j: Row) => (
              <article className="activity-item" key={j.id}>
                <strong>{j.name}</strong> <Badge value={j.state} />
                <p>{j.output?.message ?? JSON.stringify(j.output ?? {})}</p>
                {j.state === "failed" && (
                  <button
                    onClick={() =>
                      void a.run(async () => {
                        await api(ws, `/jobs/${j.id}/retry`, {});
                        l.reload();
                      })
                    }
                  >
                    Retry job
                  </button>
                )}
              </article>
            ))}
            {l.data?.deliveries?.map((d: Row) => (
              <article key={d.id}>
                <Badge value={d.status} />
                <p>{d.error ?? "Support update is queued"}</p>
              </article>
            ))}
            {!l.data?.jobs?.length && !l.data?.deliveries?.length && (
              <p className="muted">No background work needs attention.</p>
            )}
          </section>
          <section className="panel">
            <h2>Audit history</h2>
            <div className="timeline">
              {l.data?.events?.map((event: Row) => (
                <div key={event.id}>
                  <span className="timeline-dot" />
                  <div>
                    <strong>{event.kind.replaceAll(".", " · ")}</strong>
                    <small>{new Date(event.created_at).toLocaleString()}</small>
                    <details>
                      <summary>Details</summary>
                      <pre>{JSON.stringify(event.data, null, 2)}</pre>
                    </details>
                  </div>
                </div>
              ))}
            </div>
          </section>
        </>
      )}
    </>
  );
}
function Portal({ slug, widget = false }: { slug: string; widget?: boolean }) {
  const info = useLoad(
      () => request(`/v2/public/${slug}${widget ? "/widget/config" : ""}`),
      [slug],
    ),
    [authOpen, setAuthOpen] = useState(false),
    [joined, setJoined] = useState<any>(null),
    [bearer, setBearer] = useState<string | undefined>(),
    [selected, setSelected] = useState(""),
    [query, setQuery] = useState(""),
    [article, setArticle] = useState<Row | null>(null),
    a = useAction();
  const articles = useLoad(
    () =>
      widget
        ? Promise.resolve({ articles: [] })
        : request(`/v2/public/${slug}/articles?q=${encodeURIComponent(query)}`),
    [slug, query],
  );
  const tickets = useLoad(
    () =>
      joined && !bearer
        ? api(joined.workspaceId, "/conversations")
        : Promise.resolve({ conversations: [] }),
    [joined?.workspaceId, bearer, selected],
  );
  const detail = useLoad(
    () =>
      joined && selected
        ? api(
            joined.workspaceId,
            `/conversations/${selected}`,
            undefined,
            undefined,
            bearer,
          )
        : Promise.resolve(null),
    [joined?.workspaceId, selected, bearer],
  );
  useConversationEvents(
    joined?.workspaceId ?? "",
    selected,
    detail.reload,
    bearer,
  );
  const join = async () => {
    const value = await request(`/v2/public/${slug}/join`, {});
    setJoined(value);
    setBearer(undefined);
    setAuthOpen(false);
  };
  useEffect(() => {
    if (!widget) void join().catch(() => {});
  }, [slug]);
  useEffect(() => {
    if (!widget || !info.data) return;
    const receive = (event: MessageEvent) => {
      if (
        event.source !== window.parent ||
        !info.data.origins?.includes(event.origin) ||
        event.data?.type !== "fieldkit:identity"
      )
        return;
      void a.run(async () => {
        const value = await request(`/v2/public/${slug}/widget/session`, {
          signedIdentity: event.data.identity,
          channel: "widget",
        });
        setJoined(value);
        setBearer(value.token);
        setSelected("");
      });
    };
    window.addEventListener("message", receive);
    window.parent.postMessage({ type: "fieldkit:ready" }, "*");
    return () => window.removeEventListener("message", receive);
  }, [widget, info.data]);
  if (info.error)
    return (
      <div className="portal-unavailable">
        <Logo />
        <h1>This support space isn’t open yet.</h1>
        <p>{info.error}</p>
        <a href="/">Back to workspace</a>
      </div>
    );
  if (!info.data) return <div className="loading">Loading support…</div>;
  async function send(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget,
      body = new FormData(form).get("body");
    await a.run(async () => {
      let identity = joined,
        credential = bearer;
      if (!identity) {
        identity = await request(`/v2/public/${slug}/widget/session`, {
          channel: widget ? "widget" : "portal",
        });
        credential = identity.token;
        setJoined(identity);
        setBearer(credential);
      }
      if (selected)
        await api(
          identity.workspaceId,
          `/conversations/${selected}/messages`,
          { body, requestKey: crypto.randomUUID() },
          undefined,
          credential,
        );
      else {
        const conv = await api(
          identity.workspaceId,
          "/conversations",
          {
            body,
            requestKey: crypto.randomUUID(),
            channelId: identity.channelId ?? info.data.channelId,
          },
          undefined,
          credential,
        );
        setSelected(conv.id);
      }
      form.reset();
      detail.reload();
      tickets.reload();
    });
  }
  const chat = (
    <section className="portal-chat">
      <div className="section-heading">
        <div>
          <span className="eyebrow">{info.data.name} SUPPORT</span>
          <h2>{selected ? "Your conversation" : info.data.greeting}</h2>
        </div>
        {selected && (
          <button onClick={() => setSelected("")}>New conversation</button>
        )}
      </div>
      <div className="messages">
        {detail.data ? (
          <MessageList messages={detail.data.messages} />
        ) : (
          <div className="chat-welcome">
            <span className="chat-mark">✦</span>
            <h3>A little help, right when you need it.</h3>
            <p>
              Ask a question about {info.data.name}. We’ll use the company’s
              approved knowledge, or connect you with the team.
            </p>
            {!joined?.contactId && (
              <small>
                Sign in to keep ticket history and get account-specific help.
              </small>
            )}
          </div>
        )}
      </div>
      <Alert>{a.error || detail.error}</Alert>
      <form className="reply-form" onSubmit={send}>
        <textarea
          name="body"
          aria-label="Your message"
          placeholder="How can we help?"
          required
          maxLength={12000}
        />
        <div>
          <small className="muted">
            AI-assisted support · Human help is available
          </small>
          <button className="primary" disabled={a.busy}>
            {a.busy ? "Sending…" : "Send"} →
          </button>
        </div>
      </form>
    </section>
  );
  return (
    <div
      className={widget ? "widget-page" : "portal-page"}
      style={{ "--accent": info.data.brandColor } as React.CSSProperties}
    >
      {!widget && (
        <header className="portal-header">
          <a href={`/support/${slug}`}>
            <span className="portal-monogram">{info.data.name[0]}</span>
            {info.data.name}
            <span className="muted"> / Help center</span>
          </a>
          <div>
            {joined && !bearer ? (
              <>
                <span className="subtle">Your support account</span>
                <button
                  onClick={() =>
                    void auth.signOut().then(() => {
                      setJoined(null);
                      setSelected("");
                    })
                  }
                >
                  Sign out
                </button>
              </>
            ) : (
              <button onClick={() => setAuthOpen(!authOpen)}>
                Sign in / Create account
              </button>
            )}
          </div>
        </header>
      )}
      {authOpen ? (
        <AuthScreen compact done={() => void a.run(join)} />
      ) : (
        <>
          {!widget && (
            <>
              <div className="portal-hero">
                <span className="eyebrow">HERE TO HELP</span>
                <h1>{info.data.greeting}</h1>
                <p>
                  Find an answer, start a conversation, or check in on a
                  request.
                </p>
                <input
                  type="search"
                  aria-label="Search help articles"
                  placeholder="Search our help center…"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
              </div>
              <div className="portal-content">
                <section>
                  <h2>Browse our knowledge</h2>
                  {article ? (
                    <article className="panel">
                      <button className="link" onClick={() => setArticle(null)}>
                        ← All articles
                      </button>
                      <h2>{article.title}</h2>
                      <div className="article-body">{article.body}</div>
                    </article>
                  ) : (
                    <div className="article-grid">
                      {articles.data?.articles.length ? (
                        articles.data.articles.map((d: Row) => (
                          <button
                            className="article-card"
                            key={d.id}
                            onClick={() =>
                              void a.run(async () =>
                                setArticle(
                                  await request(
                                    `/v2/public/${slug}/articles/${d.id}`,
                                  ),
                                ),
                              )
                            }
                          >
                            <Icon name="Knowledge" />
                            <h3>{d.title}</h3>
                            <p>{d.excerpt}</p>
                            <span>Read article →</span>
                          </button>
                        ))
                      ) : (
                        <p className="muted">
                          {query
                            ? "No articles match that search. Ask the team below."
                            : "Our team is building the help library. Start a conversation below."}
                        </p>
                      )}
                    </div>
                  )}
                </section>
                {joined && !bearer && (
                  <section>
                    <h2>Your tickets</h2>
                    {tickets.data?.conversations.length ? (
                      tickets.data.conversations.map((t: Row) => (
                        <button
                          className="portal-ticket"
                          key={t.id}
                          onClick={() => setSelected(t.id)}
                        >
                          <span>{t.subject}</span>
                          <Badge value={t.status} />
                          <span>→</span>
                        </button>
                      ))
                    ) : (
                      <p className="muted">
                        You haven’t opened a ticket yet. Your conversations will
                        be saved here.
                      </p>
                    )}
                  </section>
                )}
                {chat}
              </div>
            </>
          )}
          {widget && chat}
        </>
      )}
      <footer className="portal-footer">
        Powered by{" "}
        <a href="/" target="_blank" rel="noreferrer">
          FieldKit
        </a>
      </footer>
    </div>
  );
}
const portalMatch = location.pathname.match(/^\/(support|widget)\/([^/]+)/);
createRoot(document.getElementById("root")!).render(
  portalMatch ? (
    <Portal slug={portalMatch[2]} widget={portalMatch[1] === "widget"} />
  ) : (
    <App />
  ),
);
