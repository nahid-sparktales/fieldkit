import { StaffRolesEditor } from "./RolesEditor.js";
import { SecurityPage, MfaChallenge, SsoSignIn } from "./SecurityPage.js";
import "./validation-config.js";
const ShadowPage = React.lazy(() =>
  import("./ShadowPage.js").then((m) => ({ default: m.ShadowPage })),
);
const SlaPage = React.lazy(() =>
  import("./SlaPage.js").then((m) => ({ default: m.SlaPage })),
);
import { SlaConversation } from "./SlaConversation.js";
const TestLabPage = React.lazy(() =>
  import("./TestLabPage.js").then((m) => ({ default: m.TestLabPage })),
);
const KnowledgeGapsPage = React.lazy(() =>
  import("./KnowledgeGapsPage.js").then((m) => ({
    default: m.KnowledgeGapsPage,
  })),
);
const AnalyticsPage = React.lazy(() =>
  import("./AnalyticsPage.js").then((m) => ({ default: m.AnalyticsPage })),
);
const ReadinessPage = React.lazy(() =>
  import("./ReadinessPage.js").then((m) => ({ default: m.ReadinessPage })),
);
import { ReadinessLink } from "./ReadinessLink.js";
const Portal = React.lazy(() =>
  import("./Portal.js").then((m) => ({ default: m.Portal })),
);
import { MessageList, useConversationEvents } from "./conversation-ui.js";
import { NotesPanel, FeedbackPanel, feedbackLabel } from "./InboxInsights.js";
import { ConnectorLogo } from "./ConnectorLogo.js";
import { InboxReadControl } from "./InboxReadControl.js";
import {
  AttachmentPicker,
  AttachmentSettingsPanel,
  attachmentIds,
  attachmentsPending,
} from "./Attachments.js";
import { InboxQueue } from "./InboxQueue.js";
const CustomerProfile = React.lazy(() =>
  import("./CustomersPage.js").then((m) => ({ default: m.CustomerProfile })),
);
const CustomersPage = React.lazy(() =>
  import("./CustomersPage.js").then((m) => ({ default: m.CustomersPage })),
);
import { appLink, assigneeLabel, replaceCurrentRoute } from "./customer-ui.js";
import { confirmDiscardChanges, useUnsavedChanges } from "./unsaved-changes.js";
import { useSettingsForm } from "./settings-form.js";
import { ActivityPage } from "./ActivityPage.js";
const ProductivityPage = React.lazy(() =>
  import("./ProductivityPage.js").then((m) => ({
    default: m.ProductivityPage,
  })),
);
const TeamsPage = React.lazy(() =>
  import("./TeamsPage.js").then((m) => ({ default: m.TeamsPage })),
);
import { AgentAvailabilityControl, RoutingAssignment } from "./TeamsPage.js";
import { TicketFields } from "./ProductivityFields.js";
import { MacroPicker, MacroChanges, type MacroDraft } from "./MacroPicker.js";
import { ActionsPage } from "./ActionsPage.js";
import "./admin-workspace.css";
import { SupportOptions } from "./SupportOptions.js";
import { TicketEmailSettings } from "./TicketEmailSettings.js";
import { request, api, useLoad } from "./request.js";
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
  useId,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { createRoot } from "react-dom/client";
import { auth } from "./auth-client.js";
import { AppearanceEditor } from "./AppearanceEditor.js";
const SettingsPage = React.lazy(() =>
  import("./ProfileSettings.js").then((m) => ({ default: m.SettingsPage })),
);

import "./style.css";
const WorkflowPage = React.lazy(() =>
  import("./WorkflowPage.js").then((m) => ({ default: m.WorkflowPage })),
);
import { useAction } from "./useAction.js";
import { LoadingState, PreviewDialog } from "./ui.js";
import "./refinements.css";
import "./inbox.css";
import "./customers.css";
import "./inbox-layout.css";
import "./content-workspace.css";
import {
  inboxStates,
  inboxState,
  parameterLabel,
  actionParameter,
  statusTone,
} from "./inbox-state.js";
import {
  MODEL_PROVIDERS,
  EmbeddingProvider,
  type ModelProviderId,
} from "../../../packages/platform/src/model-providers.js";

type Row = Record<string, any>;
function Logo() {
  return (
    <span className="brand" aria-label="Navigated Support">
      <img
        className="brand-mark"
        src="/brand/icon-charcoal.svg"
        alt=""
        width="56"
        height="56"
      />
      <span className="brand-name">
        Navigated<span>Support</span>
      </span>
    </span>
  );
}
function Icon({ name }: { name: string }) {
  const paths: Record<string, string> = {
    Setup: "M4 12l5 5L20 6",
    Refresh:
      "M20 7v5h-5 M4 17v-5h5 M6 7a7 7 0 0112-1l2 3 M4 15l2 3a7 7 0 0012-1",
    Inbox: "M3 4h18v16H3z M3 13h5l2 3h4l2-3h5",
    Workflow: "M3 3h6v6H3z M15 15h6v6h-6z M15 3h6v6h-6z M9 6h6 M6 9v9h9",
    Knowledge:
      "M4 3h6c2 0 2 2 2 2s0-2 2-2h6v17h-6c-2 0-2 1-2 1s0-1-2-1H4z M12 5v16",
    Connections:
      "M10 13a5 5 0 007 0l3-3a5 5 0 00-7-7l-2 2 M14 11a5 5 0 00-7 0l-3 3a5 5 0 007 7l2-2",
    Actions: "M13 2L4 14h7l-1 8 10-13h-8z",
    Publish: "M12 3v12 M7 8l5-5 5 5 M4 14v7h16v-7",
    Customers:
      "M20 21v-2a6 6 0 00-6-6H8a6 6 0 00-6 6v2 M11 11a4 4 0 100-8 4 4 0 000 8 M17 11l2 2 4-4",
    Team: "M16 21v-2a4 4 0 00-4-4H6a4 4 0 00-4 4v2 M9 11a4 4 0 100-8 4 4 0 000 8 M18 3a4 4 0 010 8 M22 21v-2a4 4 0 00-3-4",
    Settings:
      "M12 8a4 4 0 100 8 4 4 0 000-8 M12 2v3 M12 19v3 M2 12h3 M19 12h3 M5 5l2 2 M17 17l2 2 M5 19l2-2 M17 7l2-2",
    "Test Lab": "M8 3h8 M10 3v7l-6 10h16l-6-10V3 M7 15h10",
    Analytics: "M4 20V10 M12 20V4 M20 20V7",
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
    <span className={`badge ${statusTone(value)}`}>
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
      <span className="empty-symbol" aria-hidden="true">
        <Icon name="Inbox" />
      </span>
      <h3>{title}</h3>
      <div className="empty-description">{children}</div>
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
  const labelId = useId(),
    hintId = useId();
  return (
    <div className="field">
      <label>
        <span id={labelId}>{label}</span>
        {React.isValidElement(children) &&
        ["input", "textarea", "select"].includes(String(children.type))
          ? React.cloneElement(
              children as React.ReactElement<{
                "aria-labelledby"?: string;
                "aria-describedby"?: string;
              }>,
              {
                "aria-labelledby": labelId,
                "aria-describedby": hint ? hintId : undefined,
              },
            )
          : children}
      </label>
      {hint && <small id={hintId}>{hint}</small>}
    </div>
  );
}
function AuthScreen({
  done,
  compact = false,
  brandName = "NAVIGATED SUPPORT",
}: {
  done: () => void;
  compact?: boolean;
  brandName?: string;
}) {
  const [mode, setMode] = useState(
      new URLSearchParams(location.search).has("mfa")
        ? "mfa"
        : new URLSearchParams(location.search).has("token")
          ? "reset"
          : "login",
    ),
    a = useAction();
  useEffect(() => {
    a.setError("");
    a.setSuccess("");
  }, [mode]);
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
        if (mode === "login") {
          if (result.data?.twoFactorRedirect) setMode("mfa");
          else done();
        }
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
  if (mode === "mfa")
    return (
      <div className="auth-page">
        <MfaChallenge done={done} />
      </div>
    );
  return (
    <div className={compact ? "auth-inline" : "auth-page"}>
      {!compact && (
        <div className="auth-story">
          <Logo />
          <div>
            <span className="eyebrow">GUIDE · RESOLVE · TOGETHER</span>
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
        <span className="eyebrow">WELCOME TO {brandName}</span>
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
            : mode === "forgot"
              ? "We’ll email you a link to reset your password."
              : mode === "reset"
                ? "Choose a password with at least 12 characters."
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
        {!compact && mode === "login" && <SsoSignIn />}
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
const navigation = [
  {
    label: "Support",
    items: ["Inbox", "Needs attention", "Customers", "Knowledge", "Analytics"],
  },
  {
    label: "Agent",
    items: ["Workflow", "Test Lab", "Shadow & rollout", "Actions"],
  },
  {
    label: "Workspace",
    items: [
      "Setup",
      "Readiness",
      "Connections",
      "Publish",
      "Team",
      "Teams & routing",
      "Productivity",
      "Settings",
      "Security",
      "Activity",
    ],
  },
];
const sections = navigation.flatMap((group) => group.items);
const viewSlug = (section: string) =>
  section === "Teams & routing" ? "teams" : section.toLowerCase();
const staffSections = [
  "Teams & routing",
  "Productivity",
  "Settings",
  "Inbox",
  "Needs attention",
  "Customers",
  "Knowledge",
  "Workflow",
  "Actions",
  "Activity",
  "Test Lab",
  "Shadow & rollout",
  "Analytics",
  "Readiness",
];
function App() {
  const [session, setSession] = useState<any>(undefined),
    [ws, setWs] = useState(
      new URLSearchParams(location.search).get("workspace") ?? "",
    ),
    [view, setView] = useState(() => {
      const v = new URLSearchParams(location.search).get("view");
      return sections.find((s) => viewSlug(s) === v) ?? "Setup";
    }),
    [menu, setMenu] = useState(false),
    [mobile, setMobile] = useState(
      () => matchMedia("(max-width: 760px)").matches,
    ),
    [routeRevision, setRouteRevision] = useState(0);
  const [inboxDrafts, setInboxDrafts] = useState<
    Record<string, Record<string, InboxDraft>>
  >({});
  useEffect(() => {
    setInboxDrafts({});
  }, [session?.user?.id]);
  useEffect(() => {
    if (
      !Object.values(inboxDrafts).some((workspace) =>
        Object.values(workspace).some(
          (draft) => draft.body.trim() || draft.files?.length || draft.macro,
        ),
      )
    )
      return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [inboxDrafts]);
  const currentRoute = useRef(location.href);
  useEffect(() => {
    currentRoute.current = location.href;
  }, [ws, view, routeRevision]);
  const sidebar = useRef<HTMLElement>(null),
    toggle = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const media = matchMedia("(max-width: 760px)");
    const change = () => {
      setMobile(media.matches);
      setMenu(false);
    };
    media.addEventListener("change", change);
    const back = (event: PopStateEvent) => {
      if (!event.state?.approvedNavigation && !confirmDiscardChanges()) {
        history.pushState({}, "", currentRoute.current);
        return;
      }
      currentRoute.current = location.href;
      const params = new URLSearchParams(location.search);
      const target = params.get("workspace");
      if (target) setWs(target);
      setView(
        sections.find((s) => viewSlug(s) === params.get("view")) ?? "Setup",
      );
      setMenu(false);
      setRouteRevision((v) => v + 1);
    };
    window.addEventListener("popstate", back);
    const rememberRoute = () => {
      currentRoute.current = location.href;
    };
    window.addEventListener("app-route-replaced", rememberRoute);
    return () => {
      media.removeEventListener("change", change);
      window.removeEventListener("popstate", back);
      window.removeEventListener("app-route-replaced", rememberRoute);
    };
  }, []);
  useEffect(() => {
    if (!menu || !mobile) return;
    const panel = sidebar.current!;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    panel.querySelector<HTMLElement>("button")?.focus();
    const keys = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setMenu(false);
      }
      if (event.key !== "Tab") return;
      const controls = Array.from(
        panel.querySelectorAll<HTMLElement>(
          'button, select, a[href], [tabindex="0"]',
        ),
      ).filter((el) => !el.hasAttribute("disabled"));
      const first = controls[0],
        last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      }
      if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    panel.addEventListener("keydown", keys);
    return () => {
      document.body.style.overflow = overflow;
      panel.removeEventListener("keydown", keys);
      toggle.current?.focus();
    };
  }, [menu, mobile]);
  useEffect(() => {
    document.title = `${view} · Navigated Support`;
  }, [view]);
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
  const viewCapabilities: Record<string, string> = {
    Inbox: "tickets:read",
    "Needs attention": "tickets:read",
    Customers: "customers:read",
    Knowledge: "knowledge:read",
    Analytics: "analytics:read",
    Workflow: "workflow:read",
    "Test Lab": "workflow:read",
    "Shadow & rollout": "workflow:read",
    Actions: "actions:read",
    Setup: "settings:manage",
    Readiness: "tickets:read",
    Connections: "settings:manage",
    Publish: "settings:manage",
    Team: "members:manage",
    "Teams & routing": "tickets:read",
    Productivity: "tickets:read",
    Activity: "audit:read",
  };
  const canView = (name: string) =>
    ["Settings", "Security"].includes(name) ||
    (workspace?.capabilities
      ? workspace.capabilities.includes(viewCapabilities[name])
      : role !== "agent" || staffSections.includes(name));
  const activeView = workspace?.identityError
    ? "Security"
    : canView(view)
      ? view
      : canView("Inbox")
        ? "Inbox"
        : "Settings";
  const go = (v: string, tab?: string) => {
    if (v === view && !tab) {
      setMenu(false);
      return;
    }
    if (!confirmDiscardChanges()) return;
    setView(v);
    setMenu(false);
    if (v !== view || tab)
      history.pushState(
        {},
        "",
        `/?workspace=${ws}&view=${encodeURIComponent(viewSlug(v))}${tab ? `&tab=${encodeURIComponent(tab)}` : ""}`,
      );
    if (tab) setRouteRevision((value) => value + 1);
    window.scrollTo({ top: 0 });
  };
  return (
    <div className="shell">
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>
      {menu && mobile && (
        <div
          className="navigation-backdrop"
          onClick={() => setMenu(false)}
          aria-hidden="true"
        />
      )}
      <aside
        ref={sidebar}
        id="main-navigation"
        className={menu ? "sidebar mobile-open" : "sidebar"}
        inert={mobile && !menu}
        aria-hidden={mobile && !menu}
        role={mobile && menu ? "dialog" : undefined}
        aria-modal={mobile && menu ? true : undefined}
        aria-label="Workspace navigation"
      >
        <div className="sidebar-brand">
          <Logo />
          <button
            className="navigation-close"
            onClick={() => setMenu(false)}
            aria-label="Close navigation"
          >
            ×
          </button>
        </div>
        <label className="workspace-switch">
          <span>WORKSPACE</span>
          <select
            aria-label="Workspace"
            value={ws}
            onChange={(e) => {
              if (!confirmDiscardChanges()) return;
              setWs(e.target.value);
              setMenu(false);
              history.pushState(
                {},
                "",
                `/?workspace=${e.target.value}&view=${encodeURIComponent(viewSlug(activeView))}`,
              );
            }}
          >
            {session.workspaces.map((w: Row) => (
              <option value={w.id} key={w.id}>
                {w.name}
              </option>
            ))}
          </select>
        </label>
        <nav aria-label="Main navigation">
          {navigation.map((group) => {
            const items = group.items.filter((s) => canView(s));
            return (
              items.length > 0 && (
                <div className="nav-group" key={group.label}>
                  <span className="nav-group-label">{group.label}</span>
                  {items.map((s) => (
                    <button
                      className={
                        activeView === s ? "nav-item selected" : "nav-item"
                      }
                      aria-current={activeView === s ? "page" : undefined}
                      onClick={() => go(s)}
                      key={s}
                    >
                      <Icon name={s} />
                      {s}
                    </button>
                  ))}
                </div>
              )
            );
          })}
        </nav>
        <div className="sidebar-bottom">
          <AgentAvailabilityControl key={ws} ws={ws} />
          <div className="own-it">
            <span className="status-dot" /> Your infrastructure. Your data.
          </div>
          <div className="profile">
            <span className="avatar">
              {session.user.name.slice(0, 1).toUpperCase()}
            </span>
            <button
              className="profile-link"
              onClick={() => go("Settings", "profile")}
              aria-label="Open my profile"
            >
              <strong>{session.user.name}</strong>
              <small>{role}</small>
            </button>
            <button
              title="Sign out"
              aria-label="Sign out"
              onClick={() => {
                if (!confirmDiscardChanges()) return;
                setMenu(false);
                void auth.signOut().then(() => refresh());
              }}
            >
              ↗
            </button>
          </div>
        </div>
      </aside>
      <main className="workspace" inert={menu && mobile}>
        <header className="topbar">
          <button
            className="mobile-toggle"
            ref={toggle}
            aria-expanded={menu}
            aria-controls="main-navigation"
            onClick={() => setMenu(!menu)}
            aria-label="Toggle navigation"
          >
            ☰
          </button>
          <div>
            <span className="breadcrumb">{workspace?.name}</span>
            <span className="separator">/</span>
            <strong>{activeView}</strong>
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
        <div
          className={`workspace-body ${activeView === "Inbox" ? "inbox-body" : ""}`}
          id="main-content"
          tabIndex={-1}
          key={ws + activeView + routeRevision}
        >
          <React.Suspense
            fallback={<LoadingState label="Opening this section…" />}
          >
            {activeView === "Security" ? (
              <>
                <Alert>{workspace?.identityError}</Alert>
                <SecurityPage
                  ws={ws}
                  canManage={
                    !workspace?.identityError &&
                    workspace?.capabilities?.includes("identity:manage")
                  }
                  changed={() => void refresh()}
                >
                  {!workspace?.identityError &&
                    (workspace?.capabilities?.includes("roles:manage") ||
                      workspace?.capabilities?.includes("members:manage")) && (
                      <StaffRolesEditor ws={ws} />
                    )}
                </SecurityPage>
              </>
            ) : activeView === "Setup" ? (
              <Setup ws={ws} go={go} />
            ) : activeView === "Inbox" ? (
              <Inbox
                ws={ws}
                role={role}
                drafts={inboxDrafts[ws] ?? {}}
                setDrafts={(update) =>
                  setInboxDrafts((all) => ({
                    ...all,
                    [ws]: update(all[ws] ?? {}),
                  }))
                }
              />
            ) : activeView === "Customers" ? (
              <CustomersPage ws={ws} admin={role !== "agent"} />
            ) : activeView === "Knowledge" ? (
              <KnowledgePage
                ws={ws}
                admin={role !== "agent"}
                owner={role === "owner"}
              />
            ) : activeView === "Workflow" ? (
              <WorkflowPage
                ws={ws}
                admin={role !== "agent"}
                request={(path, data, method) => api(ws, path, data, method)}
              />
            ) : activeView === "Test Lab" ? (
              <TestLabPage ws={ws} admin={role !== "agent"} />
            ) : activeView === "Analytics" ? (
              <AnalyticsPage ws={ws} />
            ) : activeView === "Shadow & rollout" ? (
              <ShadowPage ws={ws} role={role} />
            ) : activeView === "Needs attention" ? (
              <SlaPage ws={ws} role={role} />
            ) : activeView === "Readiness" ? (
              <ReadinessPage ws={ws} role={role} />
            ) : activeView === "Connections" ? (
              <ConnectionsPage ws={ws} owner={role === "owner"} />
            ) : activeView === "Actions" ? (
              <ActionsPage ws={ws} owner={role === "owner"} />
            ) : activeView === "Publish" ? (
              <PublishPage
                ws={ws}
                slug={workspace.slug}
                name={workspace.name}
                owner={role === "owner"}
              />
            ) : activeView === "Team" ? (
              <TeamPage
                ws={ws}
                owner={role === "owner"}
                userId={session.user.id}
                workspaceName={workspace.name}
              />
            ) : activeView === "Teams & routing" ? (
              <TeamsPage ws={ws} />
            ) : activeView === "Productivity" ? (
              <ProductivityPage ws={ws} />
            ) : activeView === "Settings" ? (
              <SettingsPage
                ws={ws}
                admin={role !== "agent"}
                changed={() => void refresh()}
                agentSettings={<AgentSettingsPage ws={ws} />}
                appearance={() => go("Publish", "appearance")}
              />
            ) : (
              <ActivityPage ws={ws} admin={role !== "agent"} />
            )}
          </React.Suspense>
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
      text: "Connect your response and embedding providers, then set a usage budget.",
      view: "Connections",
      done:
        d?.connections.connections.some(
          (c: Row) =>
            c.provider ===
              (d?.base.workspace.settings.responseProvider ?? "openai") &&
            c.status === "connected",
        ) &&
        d?.connections.connections.some(
          (c: Row) =>
            c.provider ===
              (d?.base.workspace.settings.embeddingProvider ?? "openai") &&
            c.status === "connected",
        ),
    },
    {
      title: "Give your agent the right knowledge",
      text: "Add sources, then approve the ones your agent can use for customer answers.",
      view: "Knowledge",
      done: d?.knowledge.sources.some(
        (s: Row) => s.status === "ready" && s.visibility === "customer",
      ),
    },
    {
      title: "Add business actions",
      optional: true,
      text: "Optional: connect account actions with rules for human approval.",
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
  const required = tasks.filter((t) => !t.optional);
  const complete = required.filter((t) => t.done).length;
  const next = required.find((t) => !t.done);
  if (!d && !l.error) return <LoadingState label="Loading your workspace…" />;
  return (
    <>
      <Heading eyebrow="YOUR WORKSPACE" title="Let’s get your agent ready.">
        Connect your knowledge, test the answers, and choose where customers can
        reach you.
      </Heading>
      <ReadinessLink ws={ws} />
      <Alert>{l.error}</Alert>
      {l.error && <button onClick={l.reload}>Try again</button>}
      <div className="setup-summary">
        <span className="setup-mark" aria-hidden="true">
          <Icon name={next ? "Setup" : "Inbox"} />
        </span>
        <div>
          <span className="eyebrow">
            {next ? "YOUR NEXT STEP" : "YOUR CHANNELS ARE OPEN"}
          </span>
          <h2>{next ? next.title : "Ready for your next conversation"}</h2>
          <p>
            {next
              ? next.text
              : "Keep improving your answers with Test Lab and your team’s feedback."}
          </p>
        </div>
        <button
          className="primary"
          onClick={() => go(next?.view ?? "Inbox")}
          disabled={!d}
        >
          {next ? "Continue setup →" : "Open inbox →"}
        </button>
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
              ? (
                  Number(d.base.usage.input_tokens) +
                  Number(d.base.usage.output_tokens)
                ).toLocaleString()
              : "—"}
          </strong>
          <span>Actual recorded usage</span>
        </div>
      </div>
      <div className="setup-layout">
        <section className="setup-checklist">
          <div className="section-heading">
            <h2>Your launch checklist</h2>
            <span className="count-label">
              {complete} of {required.length} essentials
            </span>
          </div>
          <progress
            aria-label="Setup progress"
            value={complete}
            max={required.length}
          />
          <div className="checklist">
            {tasks.map((t, i) => (
              <button key={t.title} onClick={() => go(t.view)}>
                <span className={t.done ? "step done" : "step"}>
                  {t.done ? "✓" : `0${i + 1}`}
                </span>
                <div>
                  <strong>{t.title}</strong>
                  {t.optional && (
                    <span className="optional-label">Optional</span>
                  )}
                  <p>{t.text}</p>
                </div>
                <span>↗</span>
              </button>
            ))}
          </div>
        </section>
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
              setPreviewResult(null);
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
            <button
              className="primary"
              disabled={preview.busy || !tasks[0].done || !tasks[1].done}
            >
              {preview.busy ? "Thinking…" : "Test answer"}
            </button>
          </form>
          {(!tasks[0].done || !tasks[1].done) && (
            <p className="inline-note">
              Connect a model and approve at least one knowledge source to test
              an answer.
            </p>
          )}
          <div className="preview-next">
            <button className="link" onClick={() => go("Test Lab")}>
              Run repeatable scenarios in Test Lab →
            </button>
          </div>
          <Alert>{preview.error}</Alert>
          {previewResult && (
            <div className="preview-result">
              <Badge value={previewResult.intent} />
              <p>{previewResult.answer}</p>
              {previewResult.citations.map((c: Row) => (
                <blockquote key={c.id}>
                  {c.url ? (
                    <a href={c.url} target="_blank" rel="noreferrer">
                      {c.title} ↗
                    </a>
                  ) : (
                    c.title
                  )}{" "}
                  · v{c.version}
                  <p>{c.excerpt}</p>
                </blockquote>
              ))}
            </div>
          )}
        </section>
      </div>
    </>
  );
}
function InboxStatus({ conversation }: { conversation: Row }) {
  const state =
    inboxStates[inboxState(conversation as { status: string; mode: string })];
  return (
    <span className={`badge inbox-status ${state.tone}`}>
      <span aria-hidden="true">{state.symbol}</span>
      {state.label}
    </span>
  );
}
type InboxDraft = {
  body: string;
  note: boolean;
  requestKey: string;
  files?: Row[];
  macro?: MacroDraft;
};
function Inbox({
  ws,
  role,
  drafts,
  setDrafts,
}: {
  ws: string;
  role: string;
  drafts: Record<string, InboxDraft>;
  setDrafts: (
    update: (drafts: Record<string, InboxDraft>) => Record<string, InboxDraft>,
  ) => void;
}) {
  const [selected, setSelected] = useState(
    new URLSearchParams(location.search).get("conversation") ?? "",
  );
  const [summary, setSummary] = useState<Row>();
  const [showDetail, setShowDetail] = useState(Boolean(selected)),
    [wide, setWide] = useState(false),
    [version, setVersion] = useState(0);
  const listRef = useRef<HTMLElement>(null);
  const members = useLoad(() => api(ws, "/members"), [ws]);
  const refresh = () => setVersion((v) => v + 1);
  const back = () => {
    setShowDetail(false);
    setWide(false);
    replaceCurrentRoute(`/?workspace=${ws}&view=inbox`);
    requestAnimationFrame(() =>
      listRef.current
        ?.querySelector<HTMLElement>('[aria-current="true"]')
        ?.focus(),
    );
  };
  return (
    <div
      className={`inbox-workspace inbox-split ${selected ? "has-selection" : "no-selection"} ${showDetail ? "show-detail" : "show-queue"} ${wide ? "wide-conversation" : ""}`}
    >
      <header className="inbox-heading">
        <div>
          <h1>Inbox</h1>
        </div>
        <div className="inbox-view-controls">
          <button
            disabled={!selected}
            className="queue-width-toggle"
            aria-pressed={wide}
            onClick={() => setWide(!wide)}
          >
            {wide ? "Show conversation list" : "Expand conversation"}
          </button>
          <button onClick={refresh} aria-label="Refresh inbox">
            <Icon name="Refresh" /> Refresh
          </button>
        </div>
      </header>
      <div className="inbox">
        <section
          className="conversation-list"
          aria-label="Conversation queue"
          ref={listRef}
        >
          <InboxQueue
            ws={ws}
            selected={selected}
            members={members.data?.members ?? []}
            drafts={drafts}
            version={version}
            onSelect={(c) => {
              if (c.id !== selected && !confirmDiscardChanges()) return;
              setSelected(c.id);
              setSummary(c);
              setShowDetail(true);
              replaceCurrentRoute(
                `/?workspace=${ws}&view=inbox&conversation=${c.id}`,
              );
            }}
          />
        </section>
        {selected ? (
          <InboxConversation
            key={selected}
            ws={ws}
            role={role}
            id={selected}
            summary={summary}
            members={members.data?.members ?? []}
            membersError={members.error}
            reloadQueue={refresh}
            back={back}
            showDetail={showDetail}
            draft={drafts[selected]}
            changeDraft={(draft) =>
              setDrafts((all) => ({ ...all, [selected]: draft }))
            }
            clearDraft={(sent) =>
              setDrafts((all) =>
                all[selected] === sent
                  ? {
                      ...all,
                      [selected]: {
                        body: "",
                        note: sent.note,
                        requestKey: crypto.randomUUID(),
                      },
                    }
                  : all,
              )
            }
          />
        ) : (
          <section className="conversation-detail">
            <Empty title="Ready for the next conversation">
              Choose a conversation from the list to read its history and reply.
            </Empty>
          </section>
        )}
      </div>
    </div>
  );
}
function InboxConversation({
  ws,
  role,
  id,
  summary,
  members,
  membersError,
  reloadQueue,
  back,
  showDetail,
  draft,
  changeDraft,
  clearDraft,
}: {
  ws: string;
  role: string;
  id: string;
  summary?: Row;
  members: Row[];
  membersError?: string;
  reloadQueue: () => void;
  back: () => void;
  showDetail: boolean;
  draft?: InboxDraft;
  changeDraft: (draft: InboxDraft) => void;
  clearDraft: (sent: InboxDraft) => void;
}) {
  const detail = useLoad(() => api(ws, `/conversations/${id}`), [ws, id]);
  const a = useAction();
  const [tab, setTab] = useState("conversation");
  const [customerViewed, setCustomerViewed] = useState(false);
  useEffect(() => {
    if (tab === "customer") setCustomerViewed(true);
  }, [tab]);
  const [now, setNow] = useState(Date.now());
  const heading = useRef<HTMLHeadingElement>(null),
    composer = useRef<HTMLTextAreaElement>(null);
  const assistantPanel = useRef<HTMLDetailsElement>(null);
  const thread = useRef<HTMLDivElement>(null);
  const nearBottom = useRef(true);
  const lastMessage = useRef<string | undefined>(undefined);
  const currentDraft = draft ?? { body: "", note: false, requestKey: "" };
  const updateDraft = (changes: Partial<InboxDraft>) => {
    if (
      changes.note !== undefined &&
      changes.note !== currentDraft.note &&
      currentDraft.files?.length
    ) {
      a.setError(
        "Remove attached files before changing between a public reply and an internal note.",
      );
      return;
    }
    changeDraft({
      ...currentDraft,
      ...changes,
      requestKey: crypto.randomUUID(),
    });
  };
  const refresh = () => {
    detail.reload();
    reloadQueue();
  };
  useConversationEvents(ws, id, refresh);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    if (showDetail && detail.data)
      heading.current?.focus({ preventScroll: true });
  }, [showDetail, Boolean(detail.data)]);
  useEffect(() => {
    const last = detail.data?.messages.at(-1)?.id;
    if (thread.current && (nearBottom.current || !lastMessage.current)) {
      const approval =
        thread.current.querySelector<HTMLElement>(".approval-box");
      thread.current.scrollTop = approval
        ? approval.getBoundingClientRect().top -
          thread.current.getBoundingClientRect().top +
          thread.current.scrollTop -
          18
        : thread.current.scrollHeight;
    }
    lastMessage.current = last;
  }, [detail.data?.messages.at(-1)?.id, tab]);
  const control = (d: Row, message: string) =>
    a.run(async () => {
      await api(ws, `/conversations/${id}/control`, d);
      refresh();
    }, message);
  const openAssistant = () => {
    setTab("assistant");
    if (currentDraft.body.trim() === "/customer-support")
      updateDraft({ body: "" });
  };
  const conv = detail.data?.conversation;
  if (!conv)
    return (
      <section className="conversation-detail">
        <button className="inbox-back" onClick={back}>
          ← All conversations
        </button>
        <Alert>{detail.error}</Alert>
        {detail.loading ? (
          <LoadingState label="Opening conversation…" />
        ) : (
          <button onClick={detail.reload}>Try again</button>
        )}
      </section>
    );
  const pending = detail.data.approvals.filter(
    (p: Row) => p.status === "pending",
  );
  const customer =
    detail.data.customer?.name || summary?.customer_name || "Visitor";
  const feedback: Row[] = detail.data.feedback ?? [];
  const notes = detail.data.messages.filter((m: Row) => m.role === "note");
  const ticketTabs = [
    ["conversation", "Conversation", pending.length],
    ["customer", "Customer", 0],
    ["notes", "Notes", notes.length],
    ["feedback", "Feedback", feedback.length],
    ["assistant", "✦ Support assistant", 0],
    ["activity", "Activity & tools", 0],
  ] as const;

  return (
    <section className="conversation-detail" aria-label="Selected conversation">
      <header className="ticket-header">
        <button className="inbox-back" onClick={back}>
          ← All conversations
        </button>
        <div className="ticket-title">
          <div className="ticket-customer">
            <span className="avatar small" aria-hidden="true">
              {customer[0]}
            </span>
            <button
              className="customer-profile-trigger"
              onClick={() => setTab("customer")}
              aria-label={`View customer: ${customer}`}
            >
              {customer} ↗
            </button>
            <span>
              {conv.external_id
                ? `Zendesk #${conv.external_id}`
                : summary?.channel_kind === "widget"
                  ? "Chat widget"
                  : "Support portal"}
            </span>
          </div>
          <h2 tabIndex={-1} ref={heading}>
            {conv.subject}
          </h2>
        </div>
        <button
          aria-label={conv.status === "resolved" ? "Reopen" : "Resolve"}
          className={conv.status === "resolved" ? "" : "resolve-button"}
          disabled={a.busy}
          onClick={() =>
            void control(
              { status: conv.status === "resolved" ? "open" : "resolved" },
              conv.status === "resolved"
                ? "Conversation reopened."
                : "Conversation resolved.",
            )
          }
        >
          {conv.status === "resolved" ? "Reopen" : "✓ Resolve"}
        </button>
      </header>
      <div className="ticket-status-line">
        <span className="conversation-owner">
          Assigned to: {assigneeLabel(conv, members)}
        </span>
        <InboxStatus
          conversation={{
            ...conv,
            approval_expires_at: pending[0]?.expires_at ?? null,
          }}
        />
        <span className="agent-state">
          {conv.status === "resolved"
            ? "Conversation closed"
            : conv.mode === "human"
              ? "Agent paused · your team is in control"
              : conv.status === "waiting_approval" && !pending.length
                ? "Approval no longer available · staff review needed"
                : pending.length
                  ? "Account action paused"
                  : "Agent can reply automatically"}
        </span>
      </div>
      <details className="ticket-management">
        <summary>Manage conversation</summary>
        <div className="conversation-controls">
          <InboxReadControl
            ws={ws}
            id={id}
            state={detail.data.read_state}
            active={showDetail && tab === "conversation"}
            onChange={reloadQueue}
          />
          <label className="assignment-control">
            <span>Assigned to</span>
            <select
              aria-label="Assign conversation"
              disabled={a.busy || !members.length}
              value={conv.assigned_to ?? ""}
              onChange={(e) =>
                void control(
                  { assignedTo: e.target.value || null },
                  "Assignment updated.",
                )
              }
            >
              <option value="">Unassigned</option>
              {members.map((m) => (
                <option key={m.user_id} value={m.user_id}>
                  {m.name}
                </option>
              ))}
            </select>
          </label>
          {conv.status !== "resolved" && (
            <button
              disabled={a.busy}
              onClick={() =>
                void control(
                  { mode: conv.mode === "agent" ? "human" : "agent" },
                  conv.mode === "agent"
                    ? "You’re in control. Automatic replies and actions are paused."
                    : "Agent resumed.",
                )
              }
            >
              {conv.mode === "agent" ? "Take over" : "Resume agent"}
            </button>
          )}
        </div>
        <details>
          <summary>Team, capacity & assignment history</summary>
          <RoutingAssignment ws={ws} conv={conv} onChange={refresh} />
        </details>
        <TicketFields key={id} ws={ws} id={id} changed={refresh} />
        <div className="ticket-context">
          <span className={`ticket-priority ${statusTone(conv.priority)}`}>
            Priority: {conv.priority}
            {conv.category ? ` · ${conv.category}` : ""}
          </span>
        </div>
      </details>
      {!!feedback.length &&
        (feedback[0].resolved === false || feedback[0].rating === "bad") && (
          <button
            className={`customer-feedback-summary ${feedback[0].resolved === false || feedback[0].rating === "bad" ? "negative" : ""}`}
            onClick={() => setTab("feedback")}
          >
            <span>
              Customer feedback: <strong>{feedbackLabel(feedback[0])}</strong>
              {feedback[0].rating ? ` · ${feedback[0].rating} experience` : ""}
            </span>
            <span>View feedback →</span>
          </button>
        )}
      <Alert>{a.error || membersError || detail.error}</Alert>
      {a.success && (
        <p className="inbox-feedback" role="status">
          {a.success}
        </p>
      )}
      <div
        className="ticket-tabs"
        role="tablist"
        aria-label="Conversation tools"
        onKeyDown={(e) => {
          if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key))
            return;
          e.preventDefault();
          const tabs: string[] = ticketTabs.map(([key]) => key);
          const next =
            e.key === "Home"
              ? 0
              : e.key === "End"
                ? tabs.length - 1
                : (tabs.indexOf(tab) +
                    (e.key === "ArrowRight" ? 1 : tabs.length - 1)) %
                  tabs.length;
          setTab(tabs[next]);
          e.currentTarget
            .querySelectorAll<HTMLButtonElement>('[role="tab"]')
            [next].focus();
        }}
      >
        {ticketTabs.map(([value, label, count]) => (
          <button
            key={value}
            id={`ticket-tab-${value}`}
            role="tab"
            aria-label={label}
            aria-selected={tab === value}
            aria-controls={`ticket-panel-${value}`}
            tabIndex={tab === value ? 0 : -1}
            onClick={() => setTab(value)}
          >
            {value === "assistant"
              ? "Assistant"
              : value === "activity"
                ? "Activity"
                : label}
            {count > 0 && (
              <span className="tab-count" aria-hidden="true">
                {count}
                {value === "conversation" ? " to review" : ""}
              </span>
            )}
          </button>
        ))}
      </div>
      <div
        className="ticket-panel messages"
        id="ticket-panel-conversation"
        role="tabpanel"
        aria-labelledby="ticket-tab-conversation"
        tabIndex={0}
        hidden={tab !== "conversation"}
        ref={thread}
        onScroll={(e) => {
          const el = e.currentTarget;
          nearBottom.current =
            el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
      >
        <MessageList messages={detail.data.messages} ws={ws} />
        {pending.map((p: Row) => {
          const expired = new Date(p.expires_at).getTime() <= now;
          return (
            <section
              className={`approval-box ${expired ? "expired" : ""}`}
              key={p.id}
              aria-label="Action approval"
            >
              <div className="approval-title">
                <span className={`badge ${expired ? "bad" : "warning"}`}>
                  {expired ? "Approval expired" : "◷ Approval required"}
                </span>
                <span>{new Date(p.expires_at).toLocaleString()}</span>
              </div>
              <h3>
                {p.action_name
                  ? parameterLabel(p.action_name)
                  : "Review proposed action"}
              </h3>
              <p>{p.proposal.reason}</p>
              <dl className="approval-parameters">
                {Object.entries(p.proposal.parameters).map(([key, value]) => (
                  <div key={key}>
                    <dt>{parameterLabel(key)}</dt>
                    <dd>
                      {actionParameter(
                        p.action_kind,
                        key,
                        value,
                        p.proposal.parameters,
                      )}
                    </dd>
                  </div>
                ))}
              </dl>
              <p>
                {expired
                  ? "This request can no longer be approved. Take over to help the customer. Resuming the agent after takeover will request a fresh proposal."
                  : `Review the exact details for ${customer} before allowing this account change.`}
              </p>
              <details>
                <summary>Approval safeguards</summary>
                <p>
                  Applies only to this customer, these parameters, and the
                  current action and policy revisions. Navigated Support
                  rechecks them before execution.
                </p>
              </details>
              {role === "agent" ? (
                <p className="approval-permission">
                  An owner or administrator must approve or reject this action.
                </p>
              ) : (
                <div className="button-row">
                  <button
                    disabled={a.busy || expired}
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
                          refresh();
                        }, "Action approved. Follow its progress in Activity & tools.");
                    }}
                    className="approve-button"
                  >
                    Approve action
                  </button>
                  <button
                    disabled={a.busy || expired}
                    onClick={() =>
                      void a.run(async () => {
                        await api(ws, `/approvals/${p.id}/decision`, {
                          hash: p.hash,
                          decision: "reject",
                        });
                        refresh();
                      }, "Action rejected. No message was sent. Your team is in control.")
                    }
                  >
                    Reject
                  </button>
                </div>
              )}
            </section>
          );
        })}
      </div>
      <div
        className="ticket-panel customer-panel"
        id="ticket-panel-customer"
        role="tabpanel"
        aria-labelledby="ticket-tab-customer"
        hidden={tab !== "customer"}
        tabIndex={0}
      >
        {customerViewed && (
          <React.Suspense fallback={<LoadingState />}>
            <CustomerProfile
              key={conv.contact_id}
              ws={ws}
              id={conv.contact_id}
              admin={role !== "agent"}
              compact
              currentConversation={id}
              active={tab === "customer"}
            />
          </React.Suspense>
        )}
      </div>
      <div
        className="ticket-panel notes-panel"
        id="ticket-panel-notes"
        role="tabpanel"
        aria-labelledby="ticket-tab-notes"
        tabIndex={0}
        hidden={tab !== "notes"}
      >
        <NotesPanel
          ws={ws}
          messages={detail.data.messages}
          compose={() => {
            updateDraft({ note: true });
            setTab("conversation");
            requestAnimationFrame(() => composer.current?.focus());
          }}
        />
      </div>
      <div
        className="ticket-panel feedback-panel"
        id="ticket-panel-feedback"
        role="tabpanel"
        aria-labelledby="ticket-tab-feedback"
        tabIndex={0}
        hidden={tab !== "feedback"}
      >
        <FeedbackPanel feedback={feedback} />
      </div>
      <div
        className="ticket-panel assistant-panel"
        id="ticket-panel-assistant"
        role="tabpanel"
        aria-labelledby="ticket-tab-assistant"
        tabIndex={0}
        hidden={tab !== "assistant"}
      >
        <SupportAssistant
          panelRef={assistantPanel}
          ws={ws}
          conversation={conv}
          admin={role !== "agent"}
          onChange={refresh}
          onCompose={(body, note) => {
            updateDraft({ body, note });
            setTab("conversation");
            requestAnimationFrame(() => composer.current?.focus());
          }}
        />
      </div>
      <div
        className="ticket-panel activity-panel"
        id="ticket-panel-activity"
        role="tabpanel"
        aria-labelledby="ticket-tab-activity"
        tabIndex={0}
        hidden={tab !== "activity"}
      >
        <SlaConversation ws={ws} id={id} revision={conv.revision} />
        <h3>Improve future answers</h3>
        <p>
          Capture this conversation for testing or highlight missing knowledge.
        </p>
        <div className="button-row">
          <a
            href={`/?workspace=${ws}&view=test%20lab&importConversation=${id}`}
          >
            Create regression test ↗
          </a>
          <button
            disabled={a.busy}
            onClick={() =>
              void a.run(
                () => api(ws, `/conversations/${id}/gap`, {}),
                "Conversation flagged under Knowledge → Gaps.",
              )
            }
          >
            Flag knowledge gap
          </button>
        </div>
        {(!!detail.data.emailDeliveries?.length ||
          !!detail.data.inboundEmails?.length) && (
          <section>
            <h3>Ticket email</h3>
            <p>
              Sent means SMTP accepted the message. Check the provider for final
              delivery or bounces.
            </p>
            {detail.data.emailDeliveries?.map((mail: Row) => (
              <div className="email-job" key={mail.id}>
                <Badge value={mail.status} />
                <time>{new Date(mail.created_at).toLocaleString()}</time>
                <small>{mail.error}</small>
              </div>
            ))}
            {detail.data.inboundEmails
              ?.filter((mail: Row) => mail.status === "rejected")
              .map((mail: Row) => (
                <p className="error" key={mail.provider_id}>
                  Incoming reply rejected: {mail.error}
                </p>
              ))}
            {role !== "agent" && (
              <a href={`/?workspace=${ws}&view=publish`}>
                Email setup & recovery →
              </a>
            )}
          </section>
        )}
        <h3>Agent activity & evidence</h3>
        {!detail.data.runs.length && (
          <p>No agent runs for this conversation yet.</p>
        )}
        {detail.data.runs.map((r: Row) => (
          <article className="inbox-run" key={r.id}>
            <div>
              <Badge value={r.status} />
              <time dateTime={r.created_at}>
                {new Date(r.created_at).toLocaleString()}
              </time>
            </div>
            <p>
              {r.state.error ?? r.state.draft?.reason ?? "Processing request"}
            </p>
            <details>
              <summary>Technical details & evidence</summary>
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
            </details>
          </article>
        ))}
      </div>
      <form
        className={`reply-form ${currentDraft.note ? "is-note" : ""}`}
        hidden={tab !== "conversation"}
        onSubmit={(e) => {
          e.preventDefault();
          if (
            a.busy ||
            !draft ||
            (!draft.body.trim() && !attachmentIds(draft.files).length) ||
            attachmentsPending(draft.files)
          )
            return;
          if (draft.body.trim() === "/customer-support") {
            openAssistant();
            return;
          }
          const sent = draft;
          void a.run(
            async () => {
              await api(
                ws,
                `/conversations/${id}/${sent.note ? "notes" : "messages"}`,
                {
                  body: sent.body,
                  requestKey: sent.requestKey,
                  attachments: attachmentIds(sent.files),
                  ...(sent.macro ? { macro: sent.macro } : {}),
                },
              );
              clearDraft(sent);
              refresh();
            },
            sent.note
              ? "Private note added."
              : conv.external_id
                ? "Reply queued for Zendesk delivery."
                : "Reply sent.",
          );
        }}
      >
        <div className="composer-heading">
          <strong>
            {currentDraft.note ? "Internal note" : `Reply to ${customer}`}
          </strong>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={currentDraft.note}
              disabled={!!currentDraft.files?.length}
              title={
                currentDraft.files?.length
                  ? "Remove files before changing their visibility"
                  : undefined
              }
              onChange={(e) => updateDraft({ note: e.target.checked })}
            />
            Internal note
          </label>
        </div>
        <MacroPicker
          ws={ws}
          id={id}
          disabled={a.busy}
          onApply={(macroDraft) => {
            if (
              currentDraft.body.trim() &&
              !confirm(
                "Replace this unsent response with the reviewed macro draft?",
              )
            )
              return;
            updateDraft({
              body: macroDraft.body,
              note: macroDraft.note,
              macro: macroDraft.macro,
            });
            requestAnimationFrame(() => composer.current?.focus());
          }}
        />
        {currentDraft.macro && (
          <MacroChanges
            macro={currentDraft.macro}
            onChange={(macro) => updateDraft({ macro })}
          />
        )}
        <textarea
          ref={composer}
          aria-label="Reply"
          aria-describedby="composer-audience"
          name="body"
          value={currentDraft.body}
          onChange={(e) => updateDraft({ body: e.target.value })}
          onKeyDown={(e) => {
            if (
              e.key === "Enter" &&
              !e.nativeEvent.isComposing &&
              (e.metaKey ||
                e.ctrlKey ||
                (!e.shiftKey &&
                  currentDraft.body.trim() === "/customer-support"))
            ) {
              e.preventDefault();
              if (currentDraft.body.trim() === "/customer-support")
                openAssistant();
              else e.currentTarget.form?.requestSubmit();
            }
          }}
          required={!attachmentIds(currentDraft.files).length}
          placeholder={
            currentDraft.note
              ? "Write a private note for your team…"
              : "Write a reply to the customer…"
          }
        />
        <AttachmentPicker
          ws={ws}
          conversationId={id}
          privateNote={currentDraft.note}
          files={currentDraft.files ?? []}
          onChange={(files) => updateDraft({ files })}
          disabled={a.busy}
        />
        <div className="composer-footer">
          <div>
            <small id="composer-audience">
              {currentDraft.note
                ? "Only visible to your team"
                : currentDraft.macro?.changes.status === "resolved"
                  ? "Sending this reply resolves the conversation"
                  : conv.status === "resolved"
                    ? "Sending a reply reopens this conversation"
                    : "Visible to the customer · pauses the agent"}
            </small>
            <small className="composer-shortcut">
              ⌘ / Ctrl + Enter to send
            </small>
          </div>
          <button
            className="primary"
            disabled={
              a.busy ||
              (!currentDraft.body.trim() &&
                !attachmentIds(currentDraft.files).length) ||
              attachmentsPending(currentDraft.files)
            }
          >
            {a.busy
              ? "Working…"
              : currentDraft.note
                ? "Add note"
                : "Send reply"}
            <span aria-hidden="true"> ↑</span>
          </button>
        </div>
      </form>
    </section>
  );
}
const assistanceLabels: Record<string, string> = {
  faq_review: "Review all documents",
  triage: "Triage and prioritize",
  research: "Research across all sources",
  response: "Draft a customer response",
  escalation: "Package an engineering escalation",
  article: "Turn resolved ticket into an article",
};
function useAssistance(ws: string, conversationId?: string) {
  const l = useLoad(
    () =>
      api(
        ws,
        "/assistance" +
          (conversationId
            ? `?conversationId=${encodeURIComponent(conversationId)}`
            : ""),
      ),
    [ws, conversationId],
  );
  const running = l.data?.tasks.some((t: Row) =>
    ["queued", "running"].includes(t.status),
  );
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(l.reload, 1500);
    return () => clearInterval(timer);
  }, [ws, conversationId, running]);
  return l;
}
function AssistanceProgress({
  task,
  ws,
  reload,
}: {
  task: Row;
  ws: string;
  reload: () => void;
}) {
  const a = useAction();
  return (
    <div className="assistance-progress">
      <div className="section-heading">
        <strong>{assistanceLabels[task.kind]}</strong>
        <Badge value={task.status} />
      </div>
      {task.kind === "faq_review" && (
        <>
          <progress
            aria-label="Document review progress"
            max={task.total}
            value={task.completed}
          />
          <p>
            {task.completed} of {task.total} batches reviewed across{" "}
            {task.document_count} documents · {task.output.generated ?? 0}{" "}
            private FAQ drafts created
          </p>
        </>
      )}
      <Alert>{task.error || a.error}</Alert>
      {["queued", "running"].includes(task.status) && (
        <button
          disabled={a.busy}
          onClick={() =>
            void a.run(async () => {
              await api(ws, `/assistance/${task.id}/cancel`, {});
              reload();
            })
          }
        >
          Cancel workflow
        </button>
      )}
      {task.status === "failed" && (
        <button
          disabled={a.busy}
          onClick={() =>
            void a.run(async () => {
              await api(ws, `/assistance/${task.id}/retry`, {});
              reload();
            })
          }
        >
          Retry workflow
        </button>
      )}
    </div>
  );
}
function FaqReview({ ws, onChange }: { ws: string; onChange: () => void }) {
  const l = useAssistance(ws),
    a = useAction();
  useEffect(() => {
    onChange();
  }, [l.data?.tasks[0]?.completed]);
  return (
    <section className="panel faq-review">
      <details className="faq-generation">
        <summary>
          Build FAQs from your whole library{" "}
          <span className="optional-label">AI assisted</span>
        </summary>
        <p>
          Review every passage of every ready, customer-approved document,
          including each imported documentation page. Existing FAQs are
          excluded. The agent saves new private drafts as it works and avoids
          repeated questions.
        </p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const instructions = String(
              new FormData(e.currentTarget).get("instructions") ?? "",
            );
            void a.run(async () => {
              await api(ws, "/assistance", {
                kind: "faq_review",
                instructions,
              });
              l.reload();
            }, "Document review queued. You can leave this page and come back.");
          }}
        >
          <Field label="Full review focus (optional)">
            <input
              name="instructions"
              maxLength={2000}
              placeholder="For example: onboarding and troubleshooting"
            />
          </Field>
          <button
            className="primary"
            disabled={
              a.busy ||
              l.data?.tasks.some((t: Row) =>
                ["queued", "running"].includes(t.status),
              )
            }
          >
            Review all documents and create FAQs
          </button>
          <small>
            Uses your connected model and token budget, with one request per
            small batch. Private or unfinished imports are excluded until
            approved and ready.
          </small>
        </form>
      </details>
      <Alert>{a.error || l.error}</Alert>
      {a.success && (
        <p className="success" role="status">
          {a.success}
        </p>
      )}
      {l.data?.tasks.slice(0, 5).map((task: Row) => (
        <AssistanceProgress
          key={task.id}
          task={task}
          ws={ws}
          reload={l.reload}
        />
      ))}
    </section>
  );
}
function SupportAssistant({
  panelRef,
  ws,
  conversation,
  admin,
  onChange,
  onCompose,
}: {
  panelRef: React.RefObject<HTMLDetailsElement | null>;
  ws: string;
  conversation: Row;
  admin: boolean;
  onChange: () => void;
  onCompose: (body: string, internal: boolean) => void;
}) {
  const l = useAssistance(ws, conversation.id),
    a = useAction();
  const [selected, setSelected] = useState(""),
    [instructions, setInstructions] = useState("");
  const [draft, setDraft] = useState<Row | null>(null);
  const task =
    l.data?.tasks.find((t: Row) => t.id === selected) ?? l.data?.tasks[0];
  useEffect(() => {
    setDraft(task?.output.draft ?? null);
  }, [task?.id, task?.status]);
  const stale = task && task.conversation_revision !== conversation.revision;
  const apply = () =>
    a.run(
      async () => {
        await api(ws, `/assistance/${task.id}/apply`, {
          title: draft!.title,
          body: draft!.body,
          priority: draft!.priority,
          category: draft!.category,
        });
        l.reload();
        onChange();
      },
      task.kind === "article"
        ? "Private article saved in Knowledge → Sources. Review it before approving or publishing."
        : "Ticket priority and category updated.",
    );
  return (
    <details className="support-assistant" ref={panelRef} open>
      <summary>Support assistant</summary>
      <p>
        Choose a workflow, review the evidence, then edit the result. Nothing is
        sent or published automatically.
      </p>
      <Field label="Workflow focus (optional)">
        <input
          value={instructions}
          onChange={(e) => setInstructions(e.target.value)}
          maxLength={2000}
          placeholder="Add context or describe what to investigate"
        />
      </Field>
      <div className="assistance-actions">
        {["triage", "research", "response", "escalation", "article"].map(
          (kind) => (
            <button
              key={kind}
              disabled={
                a.busy ||
                l.data?.tasks.some(
                  (t: Row) =>
                    t.kind === kind && ["queued", "running"].includes(t.status),
                ) ||
                (kind === "article" &&
                  (!admin || conversation.status !== "resolved"))
              }
              onClick={() =>
                void a.run(async () => {
                  const created = await api(ws, "/assistance", {
                    kind,
                    conversationId: conversation.id,
                    instructions,
                  });
                  setSelected(created.id);
                  l.reload();
                })
              }
            >
              {assistanceLabels[kind]}
            </button>
          ),
        )}
      </div>
      <small>
        Article creation requires an administrator and a resolved ticket.
        Research searches all ready knowledge sources, including internal
        material. Customer reply drafts use approved knowledge only. Model usage
        counts toward your workspace budget.
      </small>
      <Alert>{l.error || a.error}</Alert>
      {a.success && (
        <p className="success" role="status">
          {a.success}
        </p>
      )}
      {!!l.data?.tasks.length && (
        <Field label="Workflow history">
          <select
            value={task?.id ?? ""}
            onChange={(e) => setSelected(e.target.value)}
          >
            {l.data.tasks.map((t: Row) => (
              <option key={t.id} value={t.id}>
                {assistanceLabels[t.kind]} · {t.status} ·{" "}
                {new Date(t.created_at).toLocaleTimeString()}
              </option>
            ))}
          </select>
        </Field>
      )}
      {task && (
        <AssistanceProgress
          key={task.id}
          task={task}
          ws={ws}
          reload={l.reload}
        />
      )}
      {draft && task?.status === "completed" && (
        <div className="assistance-result">
          {stale && !task.output.applied && (
            <p className="error">
              The ticket changed after this draft. Run the workflow again for
              current context.
            </p>
          )}
          <Field label="Draft title">
            <input
              value={draft.title}
              maxLength={200}
              onChange={(e) => setDraft({ ...draft, title: e.target.value })}
            />
          </Field>
          {task.kind === "triage" && (
            <div className="button-row">
              <Field label="Suggested priority">
                <select
                  value={draft.priority}
                  onChange={(e) =>
                    setDraft({ ...draft, priority: e.target.value })
                  }
                >
                  {["low", "normal", "high", "urgent"].map((v) => (
                    <option key={v}>{v}</option>
                  ))}
                </select>
              </Field>
              <Field label="Ticket category">
                <input
                  value={draft.category}
                  maxLength={80}
                  onChange={(e) =>
                    setDraft({ ...draft, category: e.target.value })
                  }
                />
              </Field>
            </div>
          )}
          <Field label="Workflow draft">
            <textarea
              rows={10}
              value={draft.body}
              maxLength={12000}
              onChange={(e) => setDraft({ ...draft, body: e.target.value })}
            />
          </Field>
          <p>{draft.reason}</p>
          {!!draft.gaps.length && (
            <div>
              <strong>Still needs clarification</strong>
              <ul>
                {draft.gaps.map((gap: string, i: number) => (
                  <li key={i}>{gap}</li>
                ))}
              </ul>
            </div>
          )}
          <details className="citations">
            <summary>Evidence and search coverage</summary>
            <p>
              Searched{" "}
              {task.output.coverage
                .map((c: Row) => `${c.sources} ${c.kind} source(s)`)
                .join(", ") || "the conversation"}
              . Up to 24 relevant passages are used, balanced across sources.
            </p>
            {task.output.citations.map((c: Row) => (
              <blockquote key={c.id}>
                <strong>
                  {c.title}
                  {c.visibility === "staff" ? " · Internal" : ""}
                </strong>
                <p>{c.excerpt}</p>
              </blockquote>
            ))}
          </details>
          <div className="button-row">
            {["triage", "article"].includes(task.kind) ? (
              <button
                className="primary"
                disabled={
                  a.busy ||
                  stale ||
                  task.output.applied ||
                  !draft.title.trim() ||
                  !draft.body.trim()
                }
                onClick={() => void apply()}
              >
                {task.output.applied
                  ? "Applied"
                  : task.kind === "triage"
                    ? "Apply triage"
                    : "Save private article"}
              </button>
            ) : (
              <button
                disabled={stale || !draft.body.trim()}
                onClick={() =>
                  void a.run(async () => {
                    const result = await api(
                      ws,
                      `/assistance/${task.id}/compose`,
                      { body: draft.body },
                    );
                    onCompose(result.body, result.internal);
                  }, "Draft added to the composer for your review.")
                }
              >
                {task.kind === "response"
                  ? "Use in reply"
                  : "Use as internal note"}
              </button>
            )}
            <button
              onClick={() =>
                void a.run(
                  () =>
                    navigator.clipboard.writeText(
                      `${draft.title}\n\n${draft.body}\n\nOpen questions\n${draft.gaps.join("\n")}\n\nEvidence\n${task.output.citations.map((c: Row) => `${c.title}: ${c.url || c.id}\n${c.excerpt}`).join("\n\n")}`,
                    ),
                  "Copied draft and evidence.",
                )
              }
            >
              Copy draft and evidence
            </button>
          </div>
        </div>
      )}
    </details>
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
function KnowledgePage({
  ws,
  admin,
  owner,
}: {
  ws: string;
  admin: boolean;
  owner: boolean;
}) {
  const l = useLoad(() => api(ws, "/sources"), [ws]),
    a = useAction(),
    [preview, setPreview] = useState<Row | null>(null),
    [kind, setKind] = useState("website"),
    [adding, setAdding] = useState(false),
    [query, setQuery] = useState(""),
    [audience, setAudience] = useState("all"),
    [section, setSection] = useState(
      new URLSearchParams(location.search).has("gap") ? "gaps" : "sources",
    );
  const sources = (l.data?.sources ?? []).filter((s: Row) => s.kind !== "faq");
  const filtered = sources.filter(
    (s: Row) =>
      s.title.toLowerCase().includes(query.toLowerCase()) &&
      (audience === "all" || s.visibility === audience),
  );
  const importing = l.data?.sources.some((s: Row) =>
    ["queued", "processing"].includes(s.status),
  );
  useEffect(() => {
    if (!importing) return;
    const timer = setInterval(l.reload, 2000);
    return () => clearInterval(timer);
  }, [ws, importing]);
  const upload = useRef<HTMLInputElement>(null);
  return (
    <>
      <Heading
        eyebrow="A SHARED SOURCE OF TRUTH"
        title="Knowledge"
        action={
          admin &&
          section === "sources" && (
            <div className="button-row">
              <button
                aria-expanded={adding}
                aria-controls="source-import"
                onClick={() => setAdding(!adding)}
              >
                ＋ Connect source
              </button>
              <button
                className="primary"
                disabled={a.busy}
                onClick={() => upload.current?.click()}
              >
                {a.busy ? "Working…" : "＋ Upload documents"}
              </button>
            </div>
          )
        }
      >
        Bring in your documents and connected knowledge. Review what customers
        can see before you publish.
      </Heading>
      <nav className="knowledge-tabs" aria-label="Knowledge sections">
        <button
          aria-pressed={section === "sources"}
          onClick={() => {
            setSection("sources");
            l.reload();
          }}
        >
          Sources
        </button>
        <button
          aria-pressed={section === "faqs"}
          onClick={() => setSection("faqs")}
        >
          FAQs
        </button>
        <button
          aria-pressed={section === "gaps"}
          onClick={() => setSection("gaps")}
        >
          Gaps
        </button>
      </nav>
      <div hidden={section !== "gaps"}>
        {section === "gaps" && (
          <KnowledgeGapsPage ws={ws} admin={admin} owner={owner} />
        )}
      </div>
      <div hidden={section !== "faqs"}>
        <FaqPage key={ws} ws={ws} admin={admin} />
      </div>
      <div hidden={section !== "sources"}>
        <input
          ref={upload}
          hidden
          type="file"
          accept=".pdf,.docx,.md,.txt"
          multiple
          onChange={(e) => {
            const files = Array.from(e.target.files ?? []);
            e.target.value = "";
            if (!files.length) return;
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
        {l.error && (
          <div className="content-load-recovery">
            <p>
              {l.data
                ? "Showing the last loaded knowledge. Its status may have changed."
                : "Your knowledge could not be loaded. Try again to check your saved sources."}
            </p>
            <button onClick={l.reload} disabled={l.loading}>
              Try loading knowledge again
            </button>
          </div>
        )}
        {a.success && (
          <p className="success" role="status">
            {a.success}
          </p>
        )}
        <div className="knowledge-banner">
          <Icon name="Knowledge" />
          <p>
            <strong>Private until you say otherwise.</strong> Imported documents
            start as staff-only knowledge. Approving customer answers and
            publishing an article are separate choices.
          </p>
        </div>
        {admin && adding && (
          <section className="panel source-import" id="source-import">
            <h2>Connect a knowledge source</h2>
            <form
              className="source-form"
              onSubmit={(e) => {
                e.preventDefault();
                const form = e.currentTarget;
                const d = new FormData(form);
                void a.run(async () => {
                  await api(ws, "/sources", {
                    kind: kind === "site" ? "website" : kind,
                    scope: kind === "site" ? "site" : "page",
                    title: d.get("title"),
                    locator: d.get("locator"),
                  });
                  form.reset();
                  setAdding(false);
                  l.reload();
                }, "Source added. Indexing will continue in the background.");
              }}
            >
              <Field label="Source">
                <select value={kind} onChange={(e) => setKind(e.target.value)}>
                  <option value="website">Website page</option>
                  <option value="site">Documentation site</option>
                  <option value="notion">Notion page</option>
                  <option value="zendesk">Zendesk article</option>
                </select>
              </Field>
              <Field label="Title">
                <input
                  name="title"
                  autoFocus
                  required
                  placeholder="Getting started"
                />
              </Field>
              <Field
                label={
                  kind === "site"
                    ? "Documentation URL"
                    : kind === "website"
                      ? "Page URL"
                      : kind === "notion"
                        ? "Shared page ID"
                        : "Article ID"
                }
              >
                <input
                  name="locator"
                  type={kind === "site" || kind === "website" ? "url" : "text"}
                  required
                  placeholder={
                    kind === "site"
                      ? "https://docs.locushost.co/"
                      : kind === "website"
                        ? "https://example.com/help"
                        : kind === "notion"
                          ? "Page ID shared with your connection"
                          : "123456789"
                  }
                />
              </Field>
              <button disabled={a.busy}>Add source →</button>
            </form>
            {kind === "site" && (
              <p className="inline-note">
                Import Docusaurus, GitBook, or other public documentation. Scans
                pages on this domain and under this path using sitemaps and
                links. Up to 500 pages; refreshes hourly.
              </p>
            )}
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
          <div className="library-filters">
            <input
              type="search"
              aria-label="Search knowledge sources"
              placeholder="Search your sources…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <select
              aria-label="Filter source audience"
              value={audience}
              onChange={(e) => setAudience(e.target.value)}
            >
              <option value="all">All audiences</option>
              <option value="staff">Staff only</option>
              <option value="customer">Customer answers</option>
            </select>
            {l.data && (
              <span className="count-label">
                {filtered.length} {filtered.length === 1 ? "source" : "sources"}
              </span>
            )}
          </div>
          {!l.data ? (
            l.error ? null : (
              <LoadingState label="Loading your knowledge…" />
            )
          ) : filtered.length ? (
            <div className="table-wrap">
              <table className="knowledge-table">
                <thead>
                  <tr>
                    <th scope="col">Source</th>
                    <th scope="col">Index status</th>
                    <th scope="col">Audience</th>
                    <th scope="col">Article</th>
                    <th scope="col">
                      <span className="sr-only">Manage source</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((s: Row) => {
                    const docs = l.data.documents.filter(
                      (d: Row) => d.source_id === s.id && d.active,
                    );
                    const site =
                      s.kind === "website" && s.metadata.scope === "site";
                    const progress = s.metadata.crawl;
                    return (
                      <tr key={s.id}>
                        <td data-label="Source">
                          <strong>{s.title}</strong>
                          <small>
                            {site ? "Documentation site" : s.kind} ·{" "}
                            {s.last_synced
                              ? new Date(s.last_synced).toLocaleString()
                              : "Not indexed yet"}
                          </small>
                          {s.error && (
                            <small className="error-text">{s.error}</small>
                          )}
                        </td>
                        <td data-label="Index status">
                          <Badge value={s.status} />
                          {site && progress && (
                            <small role="status">
                              {s.status === "failed"
                                ? `Stopped during ${progress.phase === "discovering" ? "discovery" : "indexing"}`
                                : progress.phase === "complete"
                                  ? `${progress.indexed} pages indexed`
                                  : progress.phase === "discovering"
                                    ? "Discovering pages…"
                                    : progress.phase === "indexing"
                                      ? `Indexing ${progress.indexed} of ${progress.scanned - progress.skipped.length} pages`
                                      : `Scanned ${progress.scanned} of ${progress.discovered} discovered pages`}
                            </small>
                          )}
                          {site && progress?.skipped.length > 0 && (
                            <details>
                              <summary>
                                {progress.skipped.length} pages skipped
                              </summary>
                              {progress.skipped.map((item: Row) => (
                                <small key={item.url}>
                                  {item.url}: {item.reason}
                                </small>
                              ))}
                            </details>
                          )}
                        </td>
                        <td data-label="Audience">
                          {admin ? (
                            <select
                              aria-label={`Audience for ${s.title}`}
                              disabled={a.busy}
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
                        <td data-label="Articles">
                          {docs.length ? (
                            <details open={!site}>
                              <summary>
                                {site
                                  ? `${docs.length} indexed pages`
                                  : "Article"}
                              </summary>
                              {docs.map((doc: Row) => (
                                <div key={doc.id}>
                                  {site && (
                                    <small>
                                      <a
                                        href={doc.locator}
                                        target="_blank"
                                        rel="noreferrer"
                                      >
                                        {doc.title} ↗
                                      </a>
                                    </small>
                                  )}
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
                                      disabled={
                                        s.visibility !== "customer" || a.busy
                                      }
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
                                </div>
                              ))}
                            </details>
                          ) : (
                            <span className="muted">—</span>
                          )}
                        </td>
                        <td data-label="Manage">
                          {admin && (
                            <div className="row-actions">
                              <button
                                title="Reindex"
                                aria-label={`Reindex ${s.title}`}
                                disabled={
                                  a.busy ||
                                  ["queued", "processing"].includes(s.status)
                                }
                                onClick={() =>
                                  void a.run(async () => {
                                    await api(
                                      ws,
                                      `/sources/${s.id}/refresh`,
                                      {},
                                    );
                                    l.reload();
                                  })
                                }
                              >
                                Refresh
                              </button>
                              <button
                                title="Delete source"
                                aria-label={`Delete ${s.title}`}
                                disabled={a.busy}
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
                                Delete
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
            <Empty
              title={
                sources.length
                  ? "No matching sources"
                  : "Start with what your business knows"
              }
            >
              <p>
                {sources.length
                  ? "Try another search or audience."
                  : "Upload a PDF, DOCX, Markdown, or text file, or connect your documentation site."}
              </p>
              {sources.length ? (
                <button
                  onClick={() => {
                    setQuery("");
                    setAudience("all");
                  }}
                >
                  Clear filters
                </button>
              ) : (
                admin && (
                  <button onClick={() => setAdding(true)}>
                    Connect your first source →
                  </button>
                )
              )}
            </Empty>
          )}
        </section>
        {preview && (
          <PreviewDialog title={preview.title} close={() => setPreview(null)}>
            <div className="article-body">{preview.body}</div>
          </PreviewDialog>
        )}
      </div>
    </>
  );
}
function FaqPage({ ws, admin }: { ws: string; admin: boolean }) {
  const l = useLoad(async () => {
    const [faqs, knowledge] = await Promise.all([
      api(ws, "/faqs"),
      api(ws, "/sources"),
    ]);
    return { ...faqs, ...knowledge };
  }, [ws]);
  const a = useAction(),
    ai = useAction();
  const [editing, setEditing] = useState<Row | null>(null),
    [question, setQuestion] = useState(""),
    [answer, setAnswer] = useState(""),
    [sourceId, setSourceId] = useState(""),
    [writing, setWriting] = useState(""),
    [mode, setMode] = useState<"list" | "write" | "generate">("list"),
    [generationScope, setGenerationScope] = useState("selected");
  const dirty =
    question !== (editing?.title ?? "") ||
    answer !== (editing?.metadata.answer ?? "") ||
    !!writing;
  useUnsavedChanges(dirty);
  const editorHeading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (mode !== "list") editorHeading.current?.focus();
  }, [mode]);
  const editor = useRef<HTMLTextAreaElement>(null);
  const processing = l.data?.faqs.some((f: Row) =>
    ["queued", "processing"].includes(f.status),
  );
  useEffect(() => {
    if (!processing) return;
    const timer = setInterval(l.reload, 2000);
    return () => clearInterval(timer);
  }, [ws, processing]);
  const busy = a.busy || ai.busy;
  const reset = () => {
    setEditing(null);
    setQuestion("");
    setAnswer("");
    setWriting("");
  };
  const discard = () => {
    if (dirty && !confirmDiscardChanges("Discard this unsaved FAQ draft?"))
      return;
    reset();
    setMode("list");
  };
  return (
    <>
      <div className="knowledge-banner">
        <p>
          <strong>Answers you can stand behind.</strong> Write FAQs yourself or
          use AI to draft them. Review and approve each FAQ for customer
          answers; publishing it on your help center is a separate step.
        </p>
      </div>
      <Alert>{l.error || a.error || ai.error}</Alert>
      {(a.success || ai.success) && (
        <p className="success" role="status">
          {a.success || ai.success}
        </p>
      )}
      {l.error && (
        <div className="content-load-recovery">
          <p>
            {l.data
              ? "Showing the last loaded FAQs."
              : "Your FAQs are unavailable. Try loading them again."}
          </p>
          <button onClick={l.reload}>Try again</button>
        </div>
      )}
      {admin && (
        <div className="content-toolbar">
          {mode === "list" ? (
            <button className="primary" onClick={() => setMode("write")}>
              {dirty || editing ? "Resume FAQ draft" : "Create FAQ"}
            </button>
          ) : (
            <>
              <button onClick={() => setMode("list")}>
                ← All FAQs{dirty ? " · draft kept" : ""}
              </button>
              <nav
                className="content-mode-switch"
                aria-label="Create FAQ method"
              >
                <button
                  aria-pressed={mode === "write"}
                  onClick={() => setMode("write")}
                >
                  Write manually
                </button>
                <button
                  aria-pressed={mode === "generate"}
                  onClick={() => setMode("generate")}
                >
                  Generate drafts
                </button>
              </nav>
            </>
          )}
        </div>
      )}
      {admin && (
        <div className="content-faq-editor" hidden={mode === "list"}>
          <section className="panel" hidden={mode !== "write"}>
            <div className="section-heading">
              <h2
                ref={mode === "write" ? editorHeading : undefined}
                tabIndex={-1}
              >
                {editing ? "Edit FAQ" : "Write an FAQ"}
              </h2>
              {editing && (
                <button
                  disabled={busy}
                  onClick={() => {
                    if (
                      dirty &&
                      !confirmDiscardChanges(
                        "Discard this FAQ draft and start another?",
                      )
                    )
                      return;
                    reset();
                  }}
                >
                  New FAQ
                </button>
              )}
            </div>
            <form
              className="faq-form"
              onSubmit={(e) => {
                e.preventDefault();
                void a.run(async () => {
                  await api(
                    ws,
                    editing ? `/faqs/${editing.id}` : "/faqs",
                    {
                      question,
                      answer,
                      ...(editing ? { revision: editing.revision } : {}),
                    },
                    editing ? "PUT" : "POST",
                  );
                  reset();
                  setMode("list");
                  l.reload();
                }, "FAQ saved as a private draft.");
              }}
            >
              <Field label="FAQ question">
                <textarea
                  ref={editor}
                  rows={2}
                  value={question}
                  onChange={(e) => setQuestion(e.target.value)}
                  minLength={3}
                  maxLength={200}
                  required
                  disabled={busy}
                  placeholder="How do I reset my password?"
                />
              </Field>
              <Field label="FAQ answer">
                <textarea
                  rows={7}
                  value={answer}
                  onChange={(e) => setAnswer(e.target.value)}
                  minLength={3}
                  maxLength={12000}
                  required
                  disabled={busy}
                  placeholder="Write the answer customers should receive…"
                />
              </Field>
              <Field label="Writing instructions (optional)">
                <input
                  value={writing}
                  onChange={(e) => setWriting(e.target.value)}
                  maxLength={2000}
                  disabled={busy}
                  placeholder="For example: keep it short and friendly"
                />
              </Field>
              <div className="button-row">
                <button className="primary" disabled={busy}>
                  Save draft
                </button>
                <button
                  type="button"
                  disabled={busy || question.trim().length < 3}
                  onClick={() =>
                    void ai.run(async () => {
                      const result = await api(ws, "/faqs/assist", {
                        question,
                        answer,
                        instructions: writing,
                        ...(sourceId ? { sourceId } : {}),
                      });
                      setQuestion(result.question);
                      setAnswer(result.answer);
                    }, "AI suggestion added to the editor. Review it, then save your draft.")
                  }
                >
                  {ai.busy
                    ? "Writing…"
                    : answer.trim()
                      ? "Improve with AI"
                      : "Draft answer with AI"}
                </button>
                <button type="button" disabled={busy} onClick={discard}>
                  Discard draft
                </button>
                <span className="muted" role="status">
                  {dirty
                    ? "Unsaved changes"
                    : editing
                      ? "Saved draft"
                      : "New draft"}
                </span>
              </div>
              <small className="muted">
                Saving an edited FAQ returns it to a private draft and removes
                its previous public answer until you approve it again.
              </small>
            </form>
          </section>
          <section className="panel" hidden={mode !== "generate"}>
            <h2
              ref={mode === "generate" ? editorHeading : undefined}
              tabIndex={-1}
            >
              Generate FAQ drafts
            </h2>
            <p className="muted">
              Turn your customer-approved knowledge into questions and answers.
              AI suggestions are saved as private drafts for you to review.
            </p>
            <Field label="Generation scope">
              <select
                value={generationScope}
                onChange={(e) => setGenerationScope(e.target.value)}
              >
                <option value="selected">
                  A focused set from selected knowledge
                </option>
                <option value="library">Review the whole library</option>
              </select>
            </Field>
            <div hidden={generationScope !== "library"}>
              <FaqReview ws={ws} onChange={l.reload} />
            </div>
            <form
              hidden={generationScope !== "selected"}
              className="faq-form"
              onSubmit={(e) => {
                e.preventDefault();
                const form = new FormData(e.currentTarget);
                void ai.run(async () => {
                  await api(ws, "/faqs/generate", {
                    count: Number(form.get("count")),
                    instructions: String(form.get("focus") || ""),
                    ...(sourceId ? { sourceId } : {}),
                  });
                  l.reload();
                  if (!dirty) setMode("list");
                }, "AI drafts saved. Review them before approving customer answers.");
              }}
            >
              <Field label="Knowledge to use">
                <select
                  value={sourceId}
                  onChange={(e) => setSourceId(e.target.value)}
                  disabled={busy}
                >
                  <option value="">All customer-approved knowledge</option>
                  {l.data?.sources
                    .filter(
                      (s: Row) =>
                        s.active &&
                        s.status === "ready" &&
                        s.visibility === "customer",
                    )
                    .map((s: Row) => (
                      <option key={s.id} value={s.id}>
                        {s.title}
                      </option>
                    ))}
                </select>
              </Field>
              <Field label="FAQ focus (optional)">
                <textarea
                  name="focus"
                  rows={3}
                  maxLength={2000}
                  disabled={busy}
                  placeholder="For example: getting started, billing, and troubleshooting"
                />
              </Field>
              <Field label="Number of FAQs">
                <input
                  type="number"
                  name="count"
                  min={1}
                  max={8}
                  defaultValue={5}
                  required
                  disabled={busy}
                />
              </Field>
              <button disabled={busy}>
                {ai.busy ? "Writing…" : "Generate FAQs"}
              </button>
              <small className="muted">
                AI help uses your connected model and token budget. It uses the
                selected knowledge; improving an existing answer can also use
                the text you wrote.
              </small>
            </form>
          </section>
        </div>
      )}
      <section
        className="panel content-faq-inventory"
        hidden={admin && mode !== "list"}
      >
        <div className="section-heading">
          <h2>Your FAQs</h2>
          <button onClick={l.reload}>Refresh FAQ status</button>
        </div>
        {!l.data ? (
          l.error ? null : (
            <LoadingState label="Loading FAQs…" />
          )
        ) : l.data.faqs.length ? (
          <div className="faq-list">
            {l.data.faqs.map((faq: Row) => {
              const doc = l.data.documents.find(
                (d: Row) => d.source_id === faq.id && d.active,
              );
              return (
                <article key={faq.id} className="faq-card">
                  <div className="section-heading">
                    <h3>{faq.title}</h3>
                    <Badge value={faq.status} />
                  </div>
                  <p className="faq-answer">{faq.metadata.answer}</p>
                  <small className="muted">
                    {faq.metadata.aiGenerated ? "AI-assisted · " : ""}
                    {faq.visibility === "customer"
                      ? faq.status === "ready"
                        ? "Approved for customer answers"
                        : "Approved · Not indexed yet"
                      : "Private until approved"}
                    {doc?.published ? " · Published in help center" : ""}
                  </small>
                  {faq.error && <Alert>{faq.error}</Alert>}
                  {faq.metadata.evidence?.length > 0 && (
                    <details>
                      <summary>Draft references</summary>
                      {faq.metadata.evidence.map((c: Row) => (
                        <p key={c.id}>
                          {c.url ? (
                            <a href={c.url} target="_blank" rel="noreferrer">
                              {c.title}
                            </a>
                          ) : (
                            c.title
                          )}{" "}
                          · v{c.version}
                        </p>
                      ))}
                    </details>
                  )}
                  {admin && (
                    <div className="button-row">
                      <button
                        disabled={busy}
                        onClick={() => {
                          if (
                            editing?.id !== faq.id &&
                            dirty &&
                            !confirmDiscardChanges(
                              "Discard this FAQ draft and open another FAQ?",
                            )
                          )
                            return;
                          if (editing?.id === faq.id) {
                            setMode("write");
                            return;
                          }
                          setMode("write");
                          setEditing(faq);
                          setQuestion(faq.title);
                          setAnswer(faq.metadata.answer);
                          setWriting("");
                        }}
                      >
                        Edit FAQ
                      </button>
                      {!(
                        faq.visibility === "customer" && faq.status === "ready"
                      ) && (
                        <button
                          disabled={
                            busy ||
                            ["queued", "processing"].includes(faq.status)
                          }
                          onClick={() => {
                            if (
                              editing?.id === faq.id &&
                              dirty &&
                              !confirmDiscardChanges(
                                "Discard your unsaved edits and approve the saved FAQ?",
                              )
                            )
                              return;
                            void a.run(async () => {
                              await api(ws, `/faqs/${faq.id}/approve`, {
                                revision: faq.revision,
                              });
                              l.reload();
                              if (editing?.id === faq.id) reset();
                            }, "FAQ approved and queued for indexing.");
                          }}
                        >
                          Approve for answers
                        </button>
                      )}
                      {doc &&
                        faq.visibility === "customer" &&
                        faq.status === "ready" && (
                          <button
                            disabled={busy}
                            onClick={() =>
                              void a.run(async () => {
                                await api(ws, `/documents/${doc.id}/publish`, {
                                  published: !doc.published,
                                });
                                l.reload();
                              })
                            }
                          >
                            {doc.published ? "Unpublish FAQ" : "Publish FAQ"}
                          </button>
                        )}
                      {faq.visibility === "customer" && (
                        <button
                          disabled={busy}
                          onClick={() => {
                            if (
                              editing?.id === faq.id &&
                              dirty &&
                              !confirmDiscardChanges(
                                "Discard your unsaved edits and make the saved FAQ private?",
                              )
                            )
                              return;
                            void a.run(async () => {
                              await api(
                                ws,
                                `/faqs/${faq.id}`,
                                {
                                  question: faq.title,
                                  answer: faq.metadata.answer,
                                  revision: faq.revision,
                                },
                                "PUT",
                              );
                              if (editing?.id === faq.id) reset();
                              l.reload();
                            }, "FAQ is private and has been withdrawn from customer answers.");
                          }}
                        >
                          Make private
                        </button>
                      )}
                      <button
                        disabled={busy}
                        onClick={() => {
                          if (
                            confirm(
                              "Delete this FAQ and remove its indexed answer?",
                            )
                          )
                            void a.run(async () => {
                              await api(ws, `/faqs/${faq.id}`, {}, "DELETE");
                              if (editing?.id === faq.id) reset();
                              l.reload();
                            }, "FAQ deleted.");
                        }}
                      >
                        Delete FAQ
                      </button>
                    </div>
                  )}
                </article>
              );
            })}
          </div>
        ) : (
          <Empty title="Start with your customers’ common questions">
            Create your first FAQ manually or generate drafts from approved
            knowledge.
          </Empty>
        )}
      </section>
    </>
  );
}
function ConnectionsPage({ ws, owner }: { ws: string; owner: boolean }) {
  const l = useLoad(() => api(ws, "/connections"), [ws]),
    a = useAction(),
    [selected, setSelected] = useState("openai"),
    [query, setQuery] = useState(""),
    [detail, setDetail] = useState(false);
  const detailHeading = useRef<HTMLHeadingElement>(null);
  const providerTrigger = useRef<HTMLButtonElement | null>(null);
  const showProvider = (provider: string, trigger: HTMLButtonElement) => {
    providerTrigger.current = trigger;
    setSelected(provider);
    setDetail(true);
    requestAnimationFrame(() => {
      if (matchMedia("(max-width: 760px)").matches) {
        detailHeading.current?.focus();
        detailHeading.current?.scrollIntoView({ block: "start" });
      }
    });
  };
  useEffect(() => {
    a.setError("");
    a.setSuccess("");
  }, [selected]);
  const modelProvider = MODEL_PROVIDERS[selected as ModelProviderId];
  const selectedConnection = l.data?.connections.find(
    (r: Row) => r.provider === selected,
  );
  const providers = [
    ...Object.entries(MODEL_PROVIDERS).map(([id, p]) => ({
      id,
      name: p.name,
      description: p.description,
    })),
    {
      id: "zendesk",
      name: "Zendesk",
      description:
        "Bring AI capabilities to your existing helpdesk and conversations.",
    },
    {
      id: "stripe_test",
      name: "Stripe test",
      description:
        "Read verified billing records and perform approved account actions.",
    },
    {
      id: "stripe_live",
      name: "Stripe live",
      description:
        "A separate live connection. Actions must explicitly select live mode.",
    },
    {
      id: "notion",
      name: "Notion",
      description:
        "Keep the pages you choose connected to your knowledge library.",
    },
    {
      id: "google",
      name: "Google Drive",
      description: "Import selected files without opening your entire Drive.",
    },
  ];
  const filtered = providers.filter((p) =>
    `${p.name} ${p.description}`.toLowerCase().includes(query.toLowerCase()),
  );
  if (!l.data)
    return (
      <>
        <Heading eyebrow="WORKS WITH YOUR BUSINESS" title="Connections">
          Connect the tools and models your support team uses.
        </Heading>
        {l.error ? (
          <section className="panel">
            <Alert>{l.error}</Alert>
            <p>
              Connection status is unavailable. Your saved connections have not
              been removed.
            </p>
            <button onClick={l.reload} disabled={l.loading}>
              Try loading connections again
            </button>
          </section>
        ) : (
          <LoadingState label="Loading connection status…" />
        )}
      </>
    );
  return (
    <>
      <Heading eyebrow="WORKS WITH YOUR BUSINESS" title="Connections">
        Credentials stay encrypted on your server. Each connection belongs to
        this workspace.
      </Heading>
      <ReadinessLink ws={ws} />
      <Alert>{l.error || a.error}</Alert>
      {l.error && (
        <div className="content-load-recovery">
          <p>
            Showing last-known connection status. Refresh before changing a
            connection.
          </p>
          <button onClick={l.reload}>Try again</button>
        </div>
      )}
      {a.success && <p className="success">{a.success}</p>}
      <div
        className={`connections-layout content-connections ${detail ? "detail-open" : ""}`}
      >
        <section className="provider-picker">
          <label className="field">
            <span>Find a connection</span>
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search models and tools…"
            />
          </label>
          {!filtered.length && (
            <Empty title="No matching connections">
              Try a provider name, such as OpenAI, Claude, or Zendesk.
            </Empty>
          )}
          <div className="connection-grid">
            {filtered.map((provider) => {
              const row = l.data?.connections.find(
                (r: Row) => r.provider === provider.id,
              );
              return (
                <button
                  className={`connection-card ${selected === provider.id ? "chosen" : ""}`}
                  key={provider.id}
                  aria-pressed={selected === provider.id}
                  disabled={a.busy}
                  onClick={(e) => showProvider(provider.id, e.currentTarget)}
                >
                  <ConnectorLogo provider={provider.id} />
                  <h3>{provider.name}</h3>
                  <p>{provider.description}</p>
                  <Badge value={row?.status ?? "not connected"} />
                  {row?.metadata.mode && (
                    <small>{row.metadata.mode} mode</small>
                  )}
                </button>
              );
            })}
          </div>
        </section>
        <section className="panel connection-settings">
          <button
            className="content-mobile-back"
            onClick={() => {
              setDetail(false);
              requestAnimationFrame(() => {
                providerTrigger.current?.focus();
                providerTrigger.current?.scrollIntoView({ block: "nearest" });
              });
            }}
          >
            ← All connections
          </button>
          <h2 ref={detailHeading} tabIndex={-1}>
            Configure{" "}
            {modelProvider?.name ??
              (selected === "google" ? "Google Drive" : selected)}
          </h2>
          <p className="muted">
            {
              providers.find((provider) => provider.id === selected)
                ?.description
            }
          </p>
          <fieldset className="content-fieldset" disabled={!!l.error}>
            {[
              ...Object.keys(MODEL_PROVIDERS),
              "stripe_test",
              "stripe_live",
              "notion",
            ].includes(selected) && (
              <form
                key={selected}
                onSubmit={(e) => {
                  e.preventDefault();
                  const form = e.currentTarget;
                  const d = new FormData(form);
                  void a.run(async () => {
                    await api(ws, "/connections/key", {
                      provider: selected,
                      apiKey: d.get("key"),
                      ...(modelProvider
                        ? {
                            ...(d.get("model")
                              ? { model: d.get("model") }
                              : {}),
                            ...(d.get("baseUrl")
                              ? { baseUrl: d.get("baseUrl") }
                              : {}),
                            ...(d.get("jsonMode")
                              ? { jsonMode: d.get("jsonMode") }
                              : {}),
                          }
                        : {}),
                    });
                    l.reload();
                    form.reset();
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
                  <input
                    name="key"
                    type="password"
                    autoComplete="off"
                    required={!["vllm", "openai_compatible"].includes(selected)}
                  />
                </Field>
                {modelProvider && (
                  <>
                    <Field
                      label="Model ID to validate (optional)"
                      hint="Use the exact provider model ID. After connecting, choose the active response and embedding providers in Settings."
                    >
                      <input
                        name="model"
                        maxLength={200}
                        defaultValue={
                          selectedConnection?.metadata.model ??
                          (selected === "openai" ? "gpt-5.4-mini" : "")
                        }
                        list="provider-model-list"
                        placeholder="Model ID from your provider"
                      />
                      <datalist id="provider-model-list">
                        {selectedConnection?.metadata.models?.map(
                          (m: string) => (
                            <option key={m} value={m} />
                          ),
                        )}
                      </datalist>
                    </Field>
                    {["vllm", "openai_compatible"].includes(selected) && (
                      <>
                        <Field
                          label="Model API base URL"
                          hint="Include /v1 where required. Private HTTP servers must be explicitly listed in FIELDKIT_MODEL_ENDPOINTS on the server; API keys are optional for trusted local deployments."
                        >
                          <input
                            name="baseUrl"
                            type="url"
                            required
                            defaultValue={
                              selectedConnection?.metadata.baseUrl ?? ""
                            }
                            placeholder="https://models.example.com/v1"
                          />
                        </Field>
                        <Field
                          label="Structured output format"
                          hint="Choose the format your server supports. Every response is still validated against Navigated Support’s schema."
                        >
                          <select
                            name="jsonMode"
                            defaultValue={
                              selectedConnection?.metadata.jsonMode ?? "schema"
                            }
                          >
                            <option value="schema">JSON schema</option>
                            <option value="json">JSON object</option>
                          </select>
                        </Field>
                      </>
                    )}
                    <p>
                      Responses and embeddings can use different providers.
                      Configure both in Settings. Connection checks read
                      account/model metadata; test a question to verify
                      generation.
                    </p>
                  </>
                )}
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
                {selected === "google" && l.data?.googleSetup && (
                  <div className="google-setup">
                    <h3>Google Drive setup</h3>
                    <ul>
                      {Object.entries(l.data.googleSetup.checks).map(
                        ([label, ready]) => (
                          <li key={label}>
                            <span
                              className={`badge ${ready ? "good" : "warning"}`}
                            >
                              {ready ? "Configured" : "Missing"}
                            </span>{" "}
                            {label}
                          </li>
                        ),
                      )}
                    </ul>
                    <p>
                      Connect your account, then choose individual files in
                      Knowledge. Only selected files are available to Navigated
                      Support.
                    </p>
                    <details>
                      <summary>Server setup details</summary>
                      <p>
                        Enable Google Drive API and Google Picker API in the
                        same Cloud project. Set the OAuth web client and
                        restricted Picker key in your server environment, then
                        restart the app and worker.
                      </p>
                      <p>
                        Authorized origin:{" "}
                        <code>{l.data.googleSetup.origin}</code>
                      </p>
                      <p>
                        Redirect URI:{" "}
                        <code>{l.data.googleSetup.callbackUrl}</code>
                      </p>
                      <p>
                        <code>GOOGLE_CLIENT_ID</code>,{" "}
                        <code>GOOGLE_CLIENT_SECRET</code>,{" "}
                        <code>GOOGLE_PICKER_KEY</code>,{" "}
                        <code>GOOGLE_APP_ID</code> (numeric project number).
                      </p>
                    </details>
                  </div>
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
                  Configure a signed Zendesk webhook with your ticket trigger.
                  Send a JSON body containing <code>ticket_id</code> to:
                </p>
                <code className="copyable">{l.data?.webhookUrl}</code>
                <Field label="Webhook signing secret">
                  <input name="secret" type="password" required />
                </Field>
                <button disabled={a.busy}>Save signing secret</button>
              </form>
            )}
            {selectedConnection?.status === "connected" && (
              <button
                disabled={a.busy}
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
                Disconnect {modelProvider?.name ?? selected}
              </button>
            )}
          </fieldset>
        </section>
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
    </>
  );
}
function PublishPage({
  ws,
  slug,
  name,
  owner,
}: {
  ws: string;
  slug: string;
  name: string;
  owner: boolean;
}) {
  const l = useLoad(() => api(ws, ""), [ws]),
    connections = useLoad(() => api(ws, "/connections"), [ws]),
    a = useAction(),
    [secret, setSecret] = useState(""),
    [tab, setTab] = useState(() =>
      new URLSearchParams(location.search).get("tab") === "appearance"
        ? "appearance"
        : "channels",
    ),
    [managed, setManaged] = useState("");
  const managementHeading = useRef<HTMLHeadingElement>(null);
  const managementTrigger = useRef<HTMLButtonElement | null>(null);
  const channelName = (kind: string) =>
    kind === "portal"
      ? "Support portal"
      : kind === "widget"
        ? "Embedded chatbot"
        : "Zendesk agent";
  const manage = (id: string, trigger: HTMLButtonElement) => {
    managementTrigger.current = trigger;
    setManaged(id);
    requestAnimationFrame(() => {
      managementHeading.current?.focus();
      managementHeading.current?.scrollIntoView({ block: "start" });
    });
  };
  const identityConfigured =
    !!secret ||
    connections.data?.connections.some(
      (connection: Row) => connection.provider === "widget_identity",
    );
  return (
    <div className="content-publish">
      <Heading eyebrow="MEET YOUR CUSTOMERS" title="Publish">
        Manage your live channels and the experience customers see.
      </Heading>
      <nav className="settings-tabs" aria-label="Publish sections">
        <button
          aria-current={tab === "channels" ? "page" : undefined}
          onClick={() => setTab("channels")}
        >
          Channels
        </button>
        <button
          aria-current={tab === "appearance" ? "page" : undefined}
          onClick={() => setTab("appearance")}
        >
          Appearance
        </button>
        {owner && (
          <button
            aria-current={tab === "developer" ? "page" : undefined}
            onClick={() => setTab("developer")}
          >
            Developer integration
          </button>
        )}
      </nav>
      <div hidden={tab !== "appearance"}>
        <AppearanceEditor ws={ws} name={name} slug={slug} />
      </div>
      <div hidden={tab !== "channels"}>
        <Alert>{l.error}</Alert>
        {l.error && (
          <div className="content-load-recovery">
            <p>
              {l.data
                ? "Showing last-loaded channels. Their status may have changed."
                : "Channel status is unavailable."}
            </p>
            <button onClick={l.reload}>Try again</button>
          </div>
        )}
        {!l.data && !l.error && (
          <LoadingState label="Loading channel status…" />
        )}
        {l.data && (
          <>
            <div hidden={!!managed}>
              <div className="section-heading">
                <h2>Your channels</h2>
                <ReadinessLink ws={ws} />
              </div>
              <div className="content-channel-list">
                {l.data.channels.map((channel: Row) => (
                  <section
                    className="panel content-channel-row"
                    key={channel.id}
                  >
                    <div>
                      <h3>{channelName(channel.kind)}</h3>
                      <p className="muted">
                        {channel.kind === "portal"
                          ? "Your help center and customer accounts."
                          : channel.kind === "widget"
                            ? "The pop-up assistant on your website and help center."
                            : "Support inside your existing helpdesk."}
                      </p>
                    </div>
                    <Badge
                      value={
                        l.error
                          ? "status unavailable"
                          : channel.published
                            ? "published"
                            : "unpublished"
                      }
                    />
                    <button
                      aria-label={`Manage ${channelName(channel.kind)}`}
                      onClick={(e) => manage(channel.id, e.currentTarget)}
                    >
                      Manage
                    </button>
                  </section>
                ))}
              </div>
              <section className="panel content-channel-preferences">
                <h2>Customer contact settings</h2>
                <p className="muted">
                  Choose support options, email replies and attachment
                  permissions.
                </p>
                <div className="button-row">
                  <button onClick={(e) => manage("support", e.currentTarget)}>
                    Support options
                  </button>
                  <button onClick={(e) => manage("email", e.currentTarget)}>
                    Email support
                  </button>
                  <button
                    onClick={(e) => manage("attachments", e.currentTarget)}
                  >
                    Customer attachments
                  </button>
                </div>
              </section>
            </div>
            <div hidden={!managed} className="content-channel-detail">
              <button
                onClick={() => {
                  setManaged("");
                  requestAnimationFrame(() =>
                    managementTrigger.current?.focus(),
                  );
                }}
              >
                ← All channels
              </button>
              <h2 ref={managementHeading} tabIndex={-1}>
                {managed === "support"
                  ? "Support options"
                  : managed === "email"
                    ? "Email support"
                    : managed === "attachments"
                      ? "Customer attachments"
                      : channelName(
                          l.data.channels.find(
                            (channel: Row) => channel.id === managed,
                          )?.kind ?? "",
                        )}
              </h2>
              <div hidden={managed !== "support"}>
                <SupportOptions
                  ws={ws}
                  owner={owner}
                  channels={l.data.channels}
                  saved={l.reload}
                />
              </div>
              <div hidden={managed !== "email"}>
                <TicketEmailSettings ws={ws} />
              </div>
              <div hidden={managed !== "attachments"}>
                <AttachmentSettingsPanel ws={ws} owner={owner} />
              </div>
              {l.data.channels.map((channel: Row) => (
                <div key={channel.id} hidden={managed !== channel.id}>
                  <PublishChannelSettings
                    ws={ws}
                    slug={slug}
                    channel={channel}
                    reload={l.reload}
                    supportOptions={() => setManaged("support")}
                  />
                </div>
              ))}
            </div>
          </>
        )}
      </div>
      {owner && (
        <div hidden={tab !== "developer"}>
          <ServiceCredentials ws={ws} />
          <section className="panel">
            <h2>Identify customers from your website</h2>
            <p>
              Sign short-lived customer identities on your server. Keep the
              signing key out of browser code.
            </p>
            <Alert>{connections.error || a.error}</Alert>
            {connections.error ? (
              <button onClick={connections.reload}>
                Try loading signing-key status again
              </button>
            ) : !connections.data ? (
              <LoadingState label="Loading signing-key status…" />
            ) : (
              <>
                <p className="muted">
                  {identityConfigured
                    ? "A signing key is configured. Rotating it replaces the current key. Update your website server to use the new key; identities signed with the previous key will stop working."
                    : "Create a signing key, then add it to your website server to identify signed-in customers."}
                </p>
                <button
                  disabled={a.busy}
                  onClick={() => {
                    if (a.busy) return;
                    if (
                      identityConfigured &&
                      !confirm(
                        "Rotate the identity signing key? The current key will stop working. You must update your website server with the new key before customers can use signed identities again.",
                      )
                    )
                      return;
                    void a.run(
                      async () => {
                        setSecret((await api(ws, "/identity-key", {})).secret);
                        connections.reload();
                      },
                      identityConfigured
                        ? "Signing key rotated. Update your website server with the new key."
                        : "Signing key created. Add it to your website server.",
                    );
                  }}
                >
                  {a.busy
                    ? "Working…"
                    : identityConfigured
                      ? "Rotate identity signing key"
                      : "Create identity signing key"}
                </button>
              </>
            )}
            {a.success && (
              <p role="status" className="success">
                {a.success}
              </p>
            )}
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
        </div>
      )}
    </div>
  );
}
function PublishChannelSettings({
  ws,
  slug,
  channel,
  reload,
  supportOptions,
}: {
  ws: string;
  slug: string;
  channel: Row;
  reload: () => void;
  supportOptions: () => void;
}) {
  const a = useAction();
  const saved = {
    origins: (channel.settings.origins ?? []).join("\n"),
    handoff: channel.settings.handoff ?? "native",
    published: channel.published,
  };
  const [draft, setDraft] = useState(saved);
  useEffect(
    () => setDraft(saved),
    [saved.origins, saved.handoff, saved.published],
  );
  const dirty =
    draft.origins !== saved.origins ||
    draft.handoff !== saved.handoff ||
    draft.published !== saved.published;
  useUnsavedChanges(dirty);
  return (
    <section
      className="panel"
      aria-label={`${channel.kind === "portal" ? "Support portal" : channel.kind === "widget" ? "Chat widget" : "Zendesk"} settings`}
    >
      <Alert>{a.error}</Alert>
      {a.success && (
        <p className="success" role="status">
          {a.success}
        </p>
      )}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void a.run(async () => {
            await api(
              ws,
              `/channels/${channel.id}`,
              {
                published:
                  channel.kind === "widget"
                    ? channel.published
                    : draft.published,
                settings: {
                  origins: draft.origins
                    .split("\n")
                    .map((value: string) => value.trim())
                    .filter(Boolean),
                  handoff: draft.handoff,
                },
              },
              "PUT",
            );
            reload();
          }, "Channel settings saved.");
        }}
      >
        {channel.kind === "widget" && (
          <Field
            label="Allowed website origins"
            hint="One exact origin per line, for example https://www.yourcompany.com"
          >
            <textarea
              name="origins"
              value={draft.origins}
              onChange={(e) => setDraft({ ...draft, origins: e.target.value })}
            />
          </Field>
        )}
        {channel.kind !== "zendesk" && (
          <Field label="When a person needs to help">
            <select
              name="handoff"
              value={draft.handoff}
              onChange={(e) => setDraft({ ...draft, handoff: e.target.value })}
            >
              <option value="native">
                Hand off to Navigated Support inbox
              </option>
              <option value="zendesk">Create a Zendesk ticket</option>
            </select>
          </Field>
        )}
        {channel.kind !== "widget" && (
          <label className="checkbox">
            <input
              name="published"
              type="checkbox"
              checked={draft.published}
              onChange={(e) =>
                setDraft({ ...draft, published: e.target.checked })
              }
            />
            Publish this channel
          </label>
        )}
        {channel.kind === "widget" && (
          <p className="muted">
            Turn the chatbot on or off in{" "}
            <button type="button" className="link" onClick={supportOptions}>
              Support options
            </button>
            . It appears in your help center and can also be embedded on your
            website.
          </p>
        )}
        <div className="content-save-bar">
          <span role="status">
            {dirty ? "Unsaved changes" : "All changes saved"}
          </span>
          <div className="button-row">
            <button className="primary" disabled={a.busy || !dirty}>
              {a.busy ? "Saving…" : "Save channel"}
            </button>
            <button
              type="button"
              disabled={a.busy || !dirty}
              onClick={() => {
                if (confirmDiscardChanges("Discard unsaved channel changes?"))
                  setDraft(saved);
              }}
            >
              Discard changes
            </button>
          </div>
        </div>
      </form>
      <a
        className="portal-link"
        href={`/?workspace=${ws}&view=workflow&channel=${channel.kind}`}
      >
        Edit{" "}
        {channel.kind === "portal"
          ? "ticket / email"
          : channel.kind === "widget"
            ? "live chat"
            : "Zendesk"}{" "}
        workflow →
      </a>
      {channel.kind === "portal" && (
        <a
          className="portal-link"
          href={`/support/${slug}`}
          target="_blank"
          rel="noreferrer"
        >
          Open support portal ↗
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
                  scopes: [d.get("scope")],
                  days: Number(d.get("days")),
                })
              ).token,
            );
            l.reload();
          });
        }}
      >
        <div className="form-grid">
          <Field label="Key permission">
            <select name="scope">
              <option value="requests:create">Customer requests</option>
              <option value="diagnostics:read">
                Read diagnostic summaries only
              </option>
            </select>
          </Field>
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
function TeamPage({
  ws,
  owner,
  userId,
  workspaceName,
}: {
  ws: string;
  owner: boolean;
  userId: string;
  workspaceName: string;
}) {
  const l = useLoad(() => api(ws, "/members"), [ws]),
    a = useAction();
  return (
    <>
      <Heading eyebrow="PEOPLE & PERMISSIONS" title="Team">
        Manage staff access to this workspace. Customer profiles and linked
        accounts are in Customers.
      </Heading>
      <Alert>{l.error || a.error}</Alert>
      {a.success && <p className="success">{a.success}</p>}
      <section className="panel">
        <h2>Invite a teammate</h2>
        <p>
          Invitations, removals, and role changes require recent verification.{" "}
          <a href={`/?workspace=${encodeURIComponent(ws)}&view=security`}>
            Verify your identity in Security
          </a>{" "}
          before changing access.
        </p>
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
              <div className="team-member-actions">
                {owner && m.role !== "owner" && m.user_id !== userId ? (
                  <button
                    disabled={a.busy}
                    aria-label={`Remove access for ${m.name}`}
                    onClick={() => {
                      if (
                        !confirm(
                          `Remove ${m.name} (${m.email}) from ${workspaceName}? They will lose access to this workspace. Their past activity will remain in the audit history.`,
                        )
                      )
                        return;
                      void a.run(async () => {
                        await api(
                          ws,
                          `/members/${encodeURIComponent(m.user_id)}`,
                          undefined,
                          "DELETE",
                        );
                        l.reload();
                      }, `Access removed for ${m.name}.`);
                    }}
                  >
                    Remove access
                  </button>
                ) : (
                  <small>
                    {m.role === "owner"
                      ? "Owner access is protected"
                      : m.user_id === userId
                        ? "Your account"
                        : "Only the owner can remove access"}
                  </small>
                )}
              </div>
            </div>
          ))}
        </div>
      </section>
      <p className="muted">
        Looking for a customer?{" "}
        <a href={`/?workspace=${ws}&view=customers`} onClick={appLink}>
          Open Customers →
        </a>
      </p>
    </>
  );
}
function AgentSettingsPage({ ws }: { ws: string }) {
  const l = useLoad(() => api(ws, ""), [ws]),
    a = useAction(),
    draft = useSettingsForm(ws);
  const settings = l.data?.workspace.settings;
  return (
    <>
      <h2>Agent preferences</h2>
      <p className="muted">
        Set the tone, control model usage, and choose how your agent starts
        working.
      </p>
      <Alert>{l.error || a.error}</Alert>
      {a.success && <p className="success">{a.success}</p>}
      {settings && (
        <section className="panel">
          <form
            ref={draft.ref}
            onChange={draft.onChange}
            onSubmit={(e) => {
              e.preventDefault();
              const d = new FormData(e.currentTarget);
              void a.run(async () => {
                await api(
                  ws,
                  "/settings",
                  {
                    ...settings,
                    responseProvider: d.get("responseProvider"),
                    model: d.get("model"),
                    embeddingProvider: d.get("embeddingProvider"),
                    embeddingModel: d.get("embeddingModel"),
                    embeddingDimensions: Number(d.get("embeddingDimensions")),
                    instructions: d.get("instructions"),
                    monthlyTokenBudget: Number(d.get("budget")),
                    retentionDays: Number(d.get("retention")),
                    replies: d.get("replies"),
                  },
                  "PUT",
                );
                draft.saved();
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
                disabled={a.busy}
                defaultValue={settings.instructions}
                rows={5}
              />
            </Field>
            <div className="form-grid">
              <Field label="Response provider">
                <select
                  aria-label="Response provider"
                  name="responseProvider"
                  disabled={a.busy}
                  defaultValue={settings.responseProvider ?? "openai"}
                >
                  {Object.entries(MODEL_PROVIDERS).map(([id, p]) => (
                    <option key={id} value={id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Response model">
                <input
                  name="model"
                  disabled={a.busy}
                  defaultValue={settings.model}
                  required
                  maxLength={200}
                />
              </Field>
              <Field label="Embedding provider">
                <select
                  aria-label="Embedding provider"
                  name="embeddingProvider"
                  disabled={a.busy}
                  defaultValue={settings.embeddingProvider ?? "openai"}
                >
                  {EmbeddingProvider.options.map((id) => (
                    <option key={id} value={id}>
                      {MODEL_PROVIDERS[id].name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field
                label="Embedding model"
                hint="Changing the provider, model, or dimensions queues a full knowledge reindex. Existing answers may hand off while indexing finishes."
              >
                <input
                  name="embeddingModel"
                  disabled={a.busy}
                  defaultValue={
                    settings.embeddingModel ?? "text-embedding-3-small"
                  }
                  required
                  maxLength={200}
                />
              </Field>
              <Field
                label="Embedding dimensions"
                hint="Must match your embedding model’s output size (for example, 1536 for OpenAI text-embedding-3-small)."
              >
                <input
                  name="embeddingDimensions"
                  disabled={a.busy}
                  type="number"
                  min={32}
                  max={4096}
                  defaultValue={settings.embeddingDimensions ?? 1536}
                  required
                />
              </Field>
              <Field label="Monthly token budget">
                <input
                  name="budget"
                  disabled={a.busy}
                  type="number"
                  min="1000"
                  defaultValue={settings.monthlyTokenBudget}
                />
              </Field>
              <Field label="Reply behavior">
                <select
                  name="replies"
                  disabled={a.busy}
                  defaultValue={settings.replies}
                >
                  <option value="review">Draft for staff review</option>
                  <option value="automatic">
                    Reply automatically from approved knowledge
                  </option>
                </select>
              </Field>
              <Field label="Resolved conversation retention (days)">
                <input
                  name="retention"
                  disabled={a.busy}
                  type="number"
                  min="7"
                  defaultValue={settings.retentionDays}
                />
              </Field>
            </div>
            <div className="settings-save-actions">
              <button className="primary" disabled={a.busy || !draft.dirty}>
                {a.busy ? "Saving…" : "Save settings"}
              </button>
              {draft.dirty && (
                <>
                  <button
                    type="button"
                    disabled={a.busy}
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
      )}
    </>
  );
}
const portalMatch = location.pathname.match(/^\/(support|widget)\/([^/]+)/);
createRoot(document.getElementById("root")!).render(
  <React.Suspense fallback={<LoadingState />}>
    {portalMatch ? (
      <Portal
        slug={portalMatch[2]}
        widget={portalMatch[1] === "widget"}
        AuthScreen={AuthScreen}
      />
    ) : (
      <App />
    )}
  </React.Suspense>,
);
