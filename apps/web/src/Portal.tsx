import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ComponentType,
  type FormEvent,
} from "react";
import { request, customerApi as api, useLoad } from "./request.js";
import { useAction } from "./useAction.js";
import { auth } from "./auth-client.js";
import { ProfileSettings } from "./ProfileSettings.js";
import {
  PortalHeader,
  PortalHero,
  PortalFooter,
  brandStyle,
} from "./PortalBrand.js";
import {
  AttachmentPicker,
  attachmentIds,
  attachmentsPending,
} from "./Attachments.js";
import { MessageList, useConversationEvents } from "./conversation-ui.js";
import { ConversationFeedback } from "./ConversationFeedback.js";
import { Field, Notice, type Row } from "./quality-ui.js";
import "./customer-support.css";

type Identity = {
  workspaceId: string;
  contactId: string;
  channelId?: string;
  email?: string;
  token?: string;
};
const date = (s: string) =>
  new Date(s).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
function TicketStatus({ conv, messages }: { conv: Row; messages?: Row[] }) {
  const last =
      messages?.at(-1) ??
      (conv.last_message_role ? { role: conv.last_message_role } : null),
    closed = conv.status === "resolved";
  const label = closed
    ? "Closed"
    : last?.role === "customer"
      ? "Waiting for support"
      : last
        ? "Support replied"
        : "Open";
  return (
    <span
      className={`support-status ${closed ? "closed" : label === "Support replied" ? "replied" : "waiting"}`}
    >
      <span aria-hidden="true">●</span> {label}
    </span>
  );
}
function ClosedFeedback({
  identity,
  id,
  detail,
  onSubmitted,
  onRefresh,
}: {
  identity: Identity;
  id: string;
  detail: Row;
  onSubmitted: (resolved: boolean) => void;
  onRefresh: () => void;
}) {
  const last = detail.messages.at(-1),
    feedback = detail.feedback?.find((f: Row) => f.source === "native");
  return feedback ||
    (detail.conversation.status === "resolved" &&
      last?.delivered_at &&
      ["assistant", "staff"].includes(last.role)) ? (
    <ConversationFeedback
      key={id}
      ws={identity.workspaceId}
      id={id}
      message={last}
      feedback={feedback}
      bearer={identity.token}
      external={Boolean(detail.conversation.external_id)}
      onSubmitted={onSubmitted}
      onRefresh={onRefresh}
    />
  ) : null;
}
export function Portal({
  slug,
  widget = false,
  AuthScreen,
}: {
  slug: string;
  widget?: boolean;
  AuthScreen: ComponentType<{
    compact?: boolean;
    brandName?: string;
    done: () => void;
  }>;
}) {
  const info = useLoad(
    () => request(`/v2/public/${slug}${widget ? "/widget/config" : ""}`),
    [slug, widget],
  );
  const [identity, setIdentity] = useState<Identity | null>(null),
    [authOpen, setAuthOpen] = useState(false),
    [view, setView] = useState(
      new URLSearchParams(location.search).has("ticket") ? "tickets" : "home",
    ),
    [selected, setSelected] = useState(
      new URLSearchParams(location.search).get("ticket") ?? "",
    ),
    [query, setQuery] = useState(""),
    [article, setArticle] = useState<Row | null>(null);
  useEffect(() => {
    const refresh = () => info.reload();
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [slug, widget]);
  const unsent = useRef(false);
  const onDraftChange = useCallback((dirty: boolean) => {
    unsent.current = dirty;
  }, []);
  const a = useAction();
  const articles = useLoad(
    () =>
      widget
        ? Promise.resolve({ articles: [] })
        : request(`/v2/public/${slug}/articles?q=${encodeURIComponent(query)}`),
    [slug, query, widget],
  );
  const tickets = useLoad(
    () =>
      identity
        ? api(identity.workspaceId, "/conversations")
        : Promise.resolve({ conversations: [] }),
    [identity?.contactId, view, selected],
  );
  const join = async () => {
    const next = await request(`/v2/public/${slug}/join`, {});
    setIdentity(next);
    setAuthOpen(false);
  };
  useEffect(() => {
    if (!widget) void join().catch(() => {});
  }, [slug, widget]);
  useEffect(() => {
    window.scrollTo({ top: 0, behavior: "instant" });
    const url = new URL(location.href);
    if (view === "tickets" && selected)
      url.searchParams.set("ticket", selected);
    else url.searchParams.delete("ticket");
    history.replaceState(null, "", url);
  }, [view, selected, authOpen]);
  useEffect(() => {
    if (!info.data) return;
    document.title = `${info.data.name} · Help center`;
    const description =
      document.querySelector<HTMLMetaElement>('meta[name="description"]') ??
      document.head.appendChild(document.createElement("meta"));
    description.name = "description";
    description.content = info.data.appearance.config.description;
    const theme = document.querySelector<HTMLMetaElement>(
      'meta[name="theme-color"]',
    );
    if (theme) theme.content = info.data.appearance.config.accentColor;
    const icon =
      document.querySelector<HTMLLinkElement>('link[rel="icon"]') ??
      document.head.appendChild(document.createElement("link"));
    icon.rel = "icon";
    icon.href = info.data.appearance.logoUrl || "/favicon.svg";
    const touchIcon = document.querySelector<HTMLLinkElement>(
      'link[rel="apple-touch-icon"]',
    );
    if (touchIcon)
      touchIcon.href =
        info.data.appearance.logoUrl || "/brand/apple-touch-icon.png";
  }, [info.data]);
  function select(id: string) {
    setSelected(id);
    setView("tickets");
    const url = new URL(location.href);
    if (id) url.searchParams.set("ticket", id);
    else url.searchParams.delete("ticket");
    history.replaceState(null, "", url);
  }
  if (info.error)
    return (
      <main className="portal-unavailable">
        <h1>This support space isn’t available.</h1>
        <p role="alert">{info.error}</p>
        <button onClick={info.reload}>Try again</button>
      </main>
    );
  if (!info.data)
    return (
      <div className="loading" role="status">
        Loading support…
      </div>
    );
  const brand = info.data,
    appearance = brand.appearance;
  return (
    <div
      className={`${widget ? "widget-page" : "portal-page"} branded-portal customer-support`}
      onKeyDown={(e) => {
        if (widget && window.parent !== window && e.key === "Escape") {
          e.preventDefault();
          window.parent.postMessage({ type: "fieldkit:close" }, "*");
        }
      }}
      onClickCapture={(e) => {
        const target = e.target as HTMLElement;
        if (unsent.current && target.closest(".portal-header")) {
          if (!confirm("Discard your unsent message and leave this page?")) {
            e.preventDefault();
            e.stopPropagation();
          } else unsent.current = false;
        }
      }}
      style={brandStyle(
        widget
          ? { ...appearance.config, backgroundColor: "#ffffff" }
          : appearance.config,
      )}
    >
      {!widget && (
        <PortalHeader
          name={brand.name}
          logoUrl={appearance.logoUrl}
          home={`/support/${slug}`}
          websiteUrl={appearance.config.websiteUrl}
        >
          <nav aria-label="Support navigation">
            <button
              aria-current={view === "home" ? "page" : undefined}
              onClick={() => setView("home")}
            >
              Help center
            </button>
            {(brand.ticketsEnabled || identity) && (
              <button
                aria-current={view === "tickets" ? "page" : undefined}
                onClick={() => {
                  setView("tickets");
                  setSelected("");
                }}
              >
                My tickets
              </button>
            )}
            {identity ? (
              <>
                <button onClick={() => setView("profile")}>
                  Your support account
                </button>
                <button
                  onClick={() =>
                    void a.run(async () => {
                      await auth.signOut();
                      setIdentity(null);
                      setSelected("");
                      setView("home");
                    })
                  }
                >
                  Sign out
                </button>
              </>
            ) : (
              <button onClick={() => setAuthOpen(true)}>
                {brand.ticketsEnabled ? "Sign in / Create account" : "Sign in"}
              </button>
            )}
          </nav>
        </PortalHeader>
      )}
      {authOpen ? (
        <div className="portal-content">
          <button onClick={() => setAuthOpen(false)}>← Back to support</button>
          <AuthScreen
            compact
            brandName={brand.name}
            done={() => void a.run(join)}
          />
          <Notice action={a} />
        </div>
      ) : widget ? (
        <LiveChat
          slug={slug}
          brand={brand}
          onDraftChange={onDraftChange}
          onClose={
            window.parent !== window
              ? () => window.parent.postMessage({ type: "fieldkit:close" }, "*")
              : undefined
          }
        />
      ) : view === "profile" && identity ? (
        <div className="portal-content">
          <button onClick={() => setView("home")}>← Back to help center</button>
          <ProfileSettings />
        </div>
      ) : view === "tickets" || view === "new" ? (
        <main className="portal-content ticket-page">
          {selected && identity ? (
            <TicketThread
              key={`${identity.contactId}:${selected}`}
              identity={identity}
              id={selected}
              brand={brand}
              back={() => select("")}
              onChange={tickets.reload}
              onDraftChange={onDraftChange}
            />
          ) : (
            <>
              <div className="section-heading">
                <div>
                  <span className="eyebrow">YOUR SUPPORT REQUESTS</span>
                  <h1>{view === "new" ? "Submit a ticket" : "My tickets"}</h1>
                  <p>
                    {brand.ticketsEnabled
                      ? "Send a message. We’ll email you when support replies."
                      : "Your previous conversations and replies are still available."}
                  </p>
                </div>
                {view !== "new" && identity && brand.ticketsEnabled && (
                  <button className="primary" onClick={() => setView("new")}>
                    New ticket
                  </button>
                )}
              </div>
              {!identity ? (
                <section className="support-empty">
                  <span className="support-symbol" aria-hidden="true">
                    ✉
                  </span>
                  <h2>Keep your requests in one place.</h2>
                  <p>
                    {brand.ticketsEnabled
                      ? "Sign in with a verified email to submit tickets, receive replies, and see your history."
                      : "Sign in to view and reply to your previous conversations."}
                  </p>
                  <button className="primary" onClick={() => setAuthOpen(true)}>
                    Sign in to continue
                  </button>
                </section>
              ) : view === "new" && brand.ticketsEnabled ? (
                <NewTicket
                  identity={identity}
                  onDraftChange={onDraftChange}
                  onCreated={select}
                  cancel={() => setView("tickets")}
                />
              ) : (
                <section className="ticket-list" aria-label="Your tickets">
                  {tickets.loading && !tickets.data ? (
                    <p role="status">Loading your tickets…</p>
                  ) : tickets.error ? (
                    <>
                      <p role="alert">{tickets.error}</p>
                      <button onClick={tickets.reload}>Try again</button>
                    </>
                  ) : tickets.data?.conversations.length ? (
                    tickets.data.conversations.map((t: Row) => (
                      <button
                        key={t.id}
                        className="ticket-row"
                        onClick={() => select(t.id)}
                      >
                        <span className="ticket-row-main">
                          <strong>{t.subject}</strong>
                          <span>
                            {t.last_message || "View your conversation"}
                          </span>
                          <small>
                            {t.channel_kind === "widget" ? "Chat" : "Ticket"} ·
                            #{t.id.slice(0, 8)} · {date(t.updated_at)}
                          </small>
                        </span>
                        <TicketStatus conv={t} />
                        <span aria-hidden="true">→</span>
                      </button>
                    ))
                  ) : (
                    <div className="support-empty">
                      <h2>No tickets yet</h2>
                      <p>
                        {brand.ticketsEnabled
                          ? "Need a hand? Send your first request to the support team."
                          : "Any previous support conversations will appear here. New tickets are currently unavailable."}
                      </p>
                      {brand.ticketsEnabled && (
                        <button
                          className="primary"
                          onClick={() => setView("new")}
                        >
                          Submit a ticket
                        </button>
                      )}
                    </div>
                  )}
                </section>
              )}
            </>
          )}
        </main>
      ) : (
        <>
          <PortalHero config={appearance.config}>
            {appearance.config.showArticles && (
              <input
                type="search"
                aria-label="Search help articles"
                placeholder="Search our help center…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            )}
          </PortalHero>
          <main className="portal-content">
            {appearance.config.showArticles && (
              <section className="help-articles">
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
                    {articles.data?.articles.map((d: Row) => (
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
                        <h3>{d.title}</h3>
                        <p>{d.excerpt}</p>
                        <span>Read article →</span>
                      </button>
                    ))}
                    {!articles.loading && !articles.data?.articles.length && (
                      <p className="muted">
                        {query
                          ? "No matching articles. Try a different search."
                          : "There are no help articles yet."}
                      </p>
                    )}
                  </div>
                )}
                {articles.error && <p role="alert">{articles.error}</p>}
              </section>
            )}
            {brand.ticketsEnabled && (
              <section className="support-choices" aria-label="Contact support">
                <div className="support-choice">
                  <span className="support-symbol" aria-hidden="true">
                    ✉
                  </span>
                  <h2>Send us a message</h2>
                  <p>
                    For detailed questions or account help. Submit a ticket and
                    get a reply by email. Your history stays here.
                  </p>
                  <button
                    className="primary"
                    onClick={() => {
                      setSelected("");
                      setView("new");
                    }}
                  >
                    Submit a ticket
                  </button>
                </div>
              </section>
            )}
            <Notice action={a} />
          </main>
        </>
      )}
      <PortalFooter config={appearance.config} />
      {!widget && brand.chatEnabled && !authOpen && (
        <FloatingChat
          key={identity?.contactId ?? "visitor"}
          slug={slug}
          brand={brand}
          account={identity ?? undefined}
        />
      )}
    </div>
  );
}
const keepChatDraft = () => {};
function FloatingChat({
  slug,
  brand,
  account,
}: {
  slug: string;
  brand: Row;
  account?: Identity;
}) {
  const [open, setOpen] = useState(false),
    [started, setStarted] = useState(false);
  const launcher = useRef<HTMLButtonElement>(null),
    panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (open)
      panel.current?.querySelector<HTMLButtonElement>(".chat-close")?.focus();
  }, [open]);
  function close() {
    setOpen(false);
    launcher.current?.focus();
  }
  return (
    <aside className="support-chat-float" aria-label="Support chatbot">
      <div
        id="support-chat-panel"
        ref={panel}
        role="dialog"
        aria-label="Support chat"
        hidden={!open}
        className="support-chat-popup"
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            close();
          }
        }}
      >
        {started && (
          <LiveChat
            slug={slug}
            brand={brand}
            account={account}
            onDraftChange={keepChatDraft}
            onClose={close}
          />
        )}
      </div>
      <button
        ref={launcher}
        type="button"
        className="support-chat-launcher"
        aria-label={open ? "Minimize support chat" : "Open support chat"}
        aria-expanded={open}
        aria-controls="support-chat-panel"
        onClick={() => {
          if (open) close();
          else {
            setStarted(true);
            setOpen(true);
          }
        }}
      >
        <svg
          viewBox="0 0 24 24"
          width="24"
          height="24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          aria-hidden="true"
        >
          <path d="M21 11.5a8.5 8.5 0 0 1-8.5 8.5H4l-2 2V11.5a9.5 9.5 0 0 1 19 0Z" />
          <path d="M7 10h10M7 14h6" />
        </svg>
        <span>{open ? "Minimize chat" : "Chat with us"}</span>
      </button>
    </aside>
  );
}
function NewTicket({
  identity,
  onCreated,
  cancel,
  onDraftChange,
}: {
  onDraftChange: (dirty: boolean) => void;
  identity: Identity;
  onCreated: (id: string) => void;
  cancel: () => void;
}) {
  const a = useAction(),
    [subject, setSubject] = useState(""),
    [body, setBody] = useState(""),
    [files, setFiles] = useState<Row[]>([]),
    key = useRef(crypto.randomUUID());
  useDraftWarning(Boolean(body || subject || files.length), onDraftChange);
  return (
    <form
      className="ticket-compose"
      onSubmit={(e) => {
        e.preventDefault();
        void a.run(async () => {
          const c = await api(identity.workspaceId, "/conversations", {
            subject,
            body,
            requestKey: key.current,
            attachments: attachmentIds(files),
            channelId: identity.channelId,
          });
          onCreated(c.id);
        });
      }}
    >
      <Field label="Subject">
        <input
          autoFocus
          required
          maxLength={160}
          value={subject}
          onChange={(e) => {
            setSubject(e.target.value);
            key.current = crypto.randomUUID();
          }}
          placeholder="What can we help you with?"
        />
      </Field>
      <Field label="Message">
        <textarea
          required={!attachmentIds(files).length}
          maxLength={12000}
          rows={7}
          value={body}
          onChange={(e) => {
            setBody(e.target.value);
            key.current = crypto.randomUUID();
          }}
          placeholder="Tell us what happened, what you expected, and any details that might help."
        />
      </Field>
      <AttachmentPicker
        ws={identity.workspaceId}
        channelId={identity.channelId}
        customer
        files={files}
        onChange={(rows) => {
          setFiles(rows);
          key.current = crypto.randomUUID();
        }}
        disabled={a.busy}
      />
      <p className="email-hint">
        Replies will be emailed to <strong>{identity.email}</strong>. Please
        don’t include passwords or payment details.
      </p>
      <Notice action={a} />
      <div className="button-row">
        <button
          className="primary"
          disabled={
            a.busy ||
            (!body.trim() && !attachmentIds(files).length) ||
            attachmentsPending(files) ||
            !subject.trim()
          }
        >
          {a.busy ? "Submitting…" : "Send ticket"}
        </button>
        <button
          type="button"
          disabled={a.busy}
          onClick={() => {
            if ((!body && !subject) || confirm("Discard this unsent ticket?"))
              cancel();
          }}
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
function useDraftWarning(
  dirty: boolean,
  onDraftChange: (dirty: boolean) => void,
) {
  useEffect(() => {
    onDraftChange(dirty);
    return () => onDraftChange(false);
  }, [dirty, onDraftChange]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
}
function TicketThread({
  identity,
  id,
  brand,
  back,
  onChange,
  onDraftChange,
}: {
  onDraftChange: (dirty: boolean) => void;
  identity: Identity;
  id: string;
  brand: Row;
  back: () => void;
  onChange: () => void;
}) {
  const l = useLoad(
      () => api(identity.workspaceId, `/conversations/${id}`),
      [identity.workspaceId, id],
    ),
    a = useAction(),
    [reply, setReply] = useState(false),
    [body, setBody] = useState(""),
    [files, setFiles] = useState<Row[]>([]),
    key = useRef(crypto.randomUUID());
  useDraftWarning(Boolean(body || files.length), onDraftChange);
  useConversationEvents(
    identity.workspaceId,
    id,
    () => {
      l.reload();
      onChange();
    },
    undefined,
    true,
  );
  if (!l.data)
    return (
      <>
        <button onClick={back}>← My tickets</button>
        {l.error ? (
          <>
            <p role="alert">{l.error}</p>
            <button onClick={l.reload}>Try again</button>
          </>
        ) : (
          <p role="status">Loading ticket…</p>
        )}
      </>
    );
  const conv = l.data.conversation,
    closed = conv.status === "resolved",
    last = l.data.messages.at(-1),
    waiting = last?.role === "customer";
  return (
    <>
      <button
        className="link"
        onClick={() => {
          if (!body || confirm("Discard your unsent reply?")) back();
        }}
      >
        ← My tickets
      </button>
      <header className="ticket-heading">
        <div>
          <span className="eyebrow">
            {conv.channel_kind === "widget" ? "CHAT HISTORY" : "SUPPORT TICKET"}{" "}
            · #{id.slice(0, 8)}
          </span>
          <h1>{conv.subject}</h1>
          <p>Opened {date(conv.created_at)}</p>
        </div>
        <TicketStatus conv={conv} messages={l.data.messages} />
      </header>
      <div className={`ticket-notice ${closed ? "closed" : ""}`} role="status">
        <strong>
          {closed
            ? "This conversation is closed."
            : waiting
              ? "Your message is with the support team."
              : "You have a reply from support."}
        </strong>
        <p>
          {closed
            ? "Still need help? Reply below to reopen the conversation."
            : `You can leave this page. Replies ${conv.channel_kind === "portal" ? `will be emailed to ${identity.email}.` : "are saved here in your chat history."}`}
          {!closed &&
            conv.channel_kind === "portal" &&
            brand.emailReplies &&
            " You can also reply directly to the email."}
        </p>
      </div>
      <section className="ticket-correspondence" aria-label="Ticket messages">
        <MessageList
          messages={l.data.messages}
          ws={identity.workspaceId}
          customer
        />
      </section>
      <ClosedFeedback
        identity={identity}
        id={id}
        detail={l.data}
        onRefresh={l.reload}
        onSubmitted={(resolved) => {
          l.reload();
          onChange();
          if (!resolved) setReply(true);
        }}
      />
      <section className="ticket-reply">
        <Notice action={a} error={l.error} />
        {reply ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void a.run(async () => {
                await api(
                  identity.workspaceId,
                  `/conversations/${id}/messages`,
                  {
                    body,
                    requestKey: key.current,
                    attachments: attachmentIds(files),
                  },
                );
                setBody("");
                setFiles([]);
                key.current = crypto.randomUUID();
                setReply(false);
                l.reload();
                onChange();
              }, "Your reply was sent.");
            }}
          >
            <Field label="Your reply">
              <textarea
                autoFocus
                disabled={a.busy}
                required={!attachmentIds(files).length}
                maxLength={12000}
                rows={5}
                value={body}
                onChange={(e) => {
                  setBody(e.target.value);
                  key.current = crypto.randomUUID();
                }}
              />
            </Field>
            <AttachmentPicker
              ws={identity.workspaceId}
              conversationId={id}
              customer
              files={files}
              onChange={(rows) => {
                setFiles(rows);
                key.current = crypto.randomUUID();
              }}
              disabled={a.busy}
            />
            <div className="button-row">
              <button
                className="primary"
                disabled={
                  a.busy ||
                  (!body.trim() && !attachmentIds(files).length) ||
                  attachmentsPending(files)
                }
              >
                {a.busy
                  ? "Sending…"
                  : closed
                    ? "Send reply & reopen"
                    : "Send reply"}
              </button>
              <button
                type="button"
                disabled={a.busy}
                onClick={() => setReply(false)}
              >
                Keep as draft
              </button>
            </div>
          </form>
        ) : (
          <div className="button-row">
            <button
              className={waiting ? "" : "primary"}
              onClick={() => setReply(true)}
            >
              {body
                ? "Continue your draft"
                : closed
                  ? "Reply & reopen"
                  : waiting
                    ? "Add more details"
                    : "Reply to support"}
            </button>
            {!closed && !conv.external_id && (
              <button
                disabled={a.busy}
                onClick={() =>
                  void a.run(async () => {
                    await api(
                      identity.workspaceId,
                      `/conversations/${id}/status`,
                      { status: "resolved" },
                    );
                    l.reload();
                    onChange();
                  })
                }
              >
                Close ticket
              </button>
            )}
          </div>
        )}
      </section>
    </>
  );
}
function LiveChat({
  slug,
  brand,
  account,
  onDraftChange,
  onClose,
}: {
  onDraftChange: (dirty: boolean) => void;
  slug: string;
  brand: Row;
  account?: Identity;
  onClose?: () => void;
}) {
  const storageKey = `fieldkit-chat:${slug}:${account?.contactId ?? "visitor"}`;
  const [reopening, setReopening] = useState(false);
  const [session, setSession] = useState<Identity | undefined>(() => {
      try {
        return (
          JSON.parse(sessionStorage.getItem(storageKey) || "null")?.identity ||
          account
        );
      } catch {
        return account;
      }
    }),
    [selected, setSelected] = useState(() => {
      try {
        return (
          JSON.parse(sessionStorage.getItem(storageKey) || "null")?.id || ""
        );
      } catch {
        return "";
      }
    }),
    [body, setBody] = useState(""),
    [files, setFiles] = useState<Row[]>([]);
  const a = useAction(),
    key = useRef(crypto.randomUUID()),
    composer = useRef<HTMLTextAreaElement>(null),
    end = useRef<HTMLDivElement>(null),
    scroll = useRef<HTMLDivElement>(null),
    nearBottom = useRef(true);
  const config = useLoad(
    () => request(`/v2/public/${slug}/widget/config`),
    [slug],
  );
  const l = useLoad(
    () =>
      session && selected
        ? api(
            session.workspaceId,
            `/conversations/${selected}`,
            undefined,
            undefined,
            session.token,
          )
        : Promise.resolve(null),
    [session?.contactId, selected],
  );
  useConversationEvents(
    session?.workspaceId ?? "",
    selected,
    l.reload,
    session?.token,
    true,
  );
  useDraftWarning(Boolean(body || files.length), onDraftChange);
  useEffect(() => {
    setReopening(false);
  }, [selected, l.data?.conversation.status]);
  useEffect(() => {
    try {
      sessionStorage.setItem(
        storageKey,
        JSON.stringify({ identity: session, id: selected }),
      );
    } catch {}
  }, [session, selected, storageKey]);
  useEffect(() => {
    if (nearBottom.current) end.current?.scrollIntoView({ block: "nearest" });
  }, [l.data?.messages.length]);
  useEffect(() => {
    if (!config.data || window.parent === window) return;
    const receive = (event: MessageEvent) => {
      if (
        event.source !== window.parent ||
        !config.data.origins.includes(event.origin) ||
        event.data?.type !== "fieldkit:identity"
      )
        return;
      void a.run(async () => {
        const v = await request(`/v2/public/${slug}/widget/session`, {
          signedIdentity: event.data.identity,
          channel: "widget",
        });
        setSession(v);
        setSelected("");
        setBody("");
        setFiles([]);
      });
    };
    window.addEventListener("message", receive);
    window.parent.postMessage({ type: "fieldkit:ready" }, "*");
    return () => window.removeEventListener("message", receive);
  }, [config.data]);
  async function send(e: FormEvent) {
    e.preventDefault();
    await a.run(
      async () => {
        let identity = session;
        if (!identity) {
          identity = await request(`/v2/public/${slug}/widget/session`, {
            channel: "widget",
          });
          setSession(identity);
        }
        if (!identity) return;
        if (selected)
          await api(
            identity.workspaceId,
            `/conversations/${selected}/messages`,
            {
              body,
              requestKey: key.current,
              attachments: attachmentIds(files),
            },
            undefined,
            identity.token,
          );
        else {
          const c = await api(
            identity.workspaceId,
            "/conversations",
            {
              body,
              requestKey: key.current,
              channelId: config.data.channelId,
              attachments: attachmentIds(files),
            },
            undefined,
            identity.token,
          );
          setSelected(c.id);
        }
        setBody("");
        setFiles([]);
        key.current = crypto.randomUUID();
        nearBottom.current = true;
        l.reload();
      },
      l.data?.conversation.mode === "human"
        ? "Message sent. Waiting for the support team to reply."
        : "Message sent.",
    );
  }
  const closed = l.data?.conversation.status === "resolved",
    human = l.data?.conversation.mode === "human",
    waiting = l.data?.messages.at(-1)?.role === "customer";
  return (
    <section className="live-chat" aria-label="Live support chat">
      <header>
        <div>
          {brand.appearance.logoUrl && (
            <img
              className="widget-logo"
              src={brand.appearance.logoUrl}
              alt={`${brand.name} logo`}
            />
          )}
          <span className="eyebrow">{brand.name}</span>
          <h2>Support chat</h2>
          <small>AI-assisted · A person can take over</small>
        </div>
        <div className="chat-header-actions">
          {selected && (
            <button
              onClick={() => {
                if (
                  body &&
                  !confirm("Discard your draft and start a new chat?")
                )
                  return;
                setSelected("");
                if (!account) setSession(undefined);
                setBody("");
                setFiles([]);
                a.setError("");
              }}
            >
              New chat
            </button>
          )}
          {onClose && (
            <button
              type="button"
              className="chat-close"
              aria-label="Minimize support chat"
              onClick={onClose}
            >
              ×
            </button>
          )}
        </div>
      </header>
      <div
        className="live-chat-messages"
        ref={scroll}
        onScroll={() => {
          const el = scroll.current!;
          nearBottom.current =
            el.scrollHeight - el.scrollTop - el.clientHeight < 90;
        }}
        aria-label="Chat messages"
        aria-live="polite"
        aria-relevant="additions text"
      >
        {!selected ? (
          <div className="chat-welcome">
            <span className="chat-mark" aria-hidden="true">
              ✦
            </span>
            <h3>{brand.greeting}</h3>
            <p>
              Ask a question about {brand.name}. We’ll use approved guides or
              pass your question to the team.
            </p>
            <small>
              {account
                ? "You’re signed in. Your conversation is saved to your support account."
                : brand.ticketsEnabled
                  ? "For account-specific help, sign in and submit a ticket."
                  : "General questions don’t need an account. The team may need to verify your identity for account-specific help."}
            </small>
          </div>
        ) : l.data ? (
          <>
            <MessageList
              messages={l.data.messages}
              ws={session?.workspaceId}
              bearer={session?.token}
              customer
            />
            {closed ? (
              <div className="chat-state">
                Chat closed. Continue the conversation if you need more help.
              </div>
            ) : human ? (
              <div className="chat-state">
                {waiting
                  ? "Your message was sent to the support team. Waiting for a person to reply."
                  : "A person is handling this conversation. You can add details below; the assistant is paused."}
              </div>
            ) : waiting ? (
              <div className="chat-state" role="status">
                Your message was received. Waiting for a response…
              </div>
            ) : null}
            <ClosedFeedback
              identity={session!}
              id={selected}
              detail={l.data}
              onRefresh={l.reload}
              onSubmitted={(resolved) => {
                l.reload();
                if (!resolved) {
                  setReopening(true);
                  requestAnimationFrame(() => composer.current?.focus());
                }
              }}
            />
          </>
        ) : (
          !l.error && <p role="status">Loading conversation…</p>
        )}
        <div ref={end} />
      </div>
      <Notice action={a} error={l.error || config.error} />
      {l.error && (
        <p className="chat-state">
          Your chat session may have expired. Start a new chat, or sign in to
          access saved tickets.
        </p>
      )}
      {closed && !reopening ? (
        <div className="closed-chat-actions">
          <button onClick={() => setReopening(true)}>
            {body ? "Continue your draft" : "Continue conversation"}
          </button>
        </div>
      ) : (
        <form className="chat-composer" onSubmit={send}>
          <textarea
            ref={composer}
            autoFocus={reopening}
            disabled={a.busy}
            aria-label="Your message"
            placeholder={
              closed ? "Send a message to reopen…" : "Type your question…"
            }
            required={!attachmentIds(files).length}
            maxLength={12000}
            rows={2}
            value={body}
            onChange={(e) => {
              setBody(e.target.value);
              key.current = crypto.randomUUID();
              a.setSuccess("");
            }}
            onKeyDown={(e) => {
              if (
                e.key === "Enter" &&
                !e.shiftKey &&
                !e.nativeEvent.isComposing
              ) {
                e.preventDefault();
                if (
                  (body.trim() || attachmentIds(files).length) &&
                  !attachmentsPending(files) &&
                  !a.busy &&
                  !l.error &&
                  config.data
                )
                  e.currentTarget.form?.requestSubmit();
              }
            }}
          />
          {session && selected && (
            <AttachmentPicker
              ws={session.workspaceId}
              conversationId={selected}
              bearer={session.token}
              customer
              files={files}
              onChange={(rows) => {
                setFiles(rows);
                key.current = crypto.randomUUID();
              }}
              disabled={a.busy}
            />
          )}
          <div>
            <small>Enter to send · Shift + Enter for a new line</small>
            <button
              className="primary"
              disabled={
                a.busy ||
                (!body.trim() && !attachmentIds(files).length) ||
                attachmentsPending(files) ||
                !config.data ||
                !!l.error
              }
            >
              {a.busy ? "Sending…" : "Send"}
            </button>
          </div>
        </form>
      )}
      {selected && !closed && l.data && !l.data.conversation.external_id && (
        <button
          className="link end-chat"
          disabled={a.busy}
          onClick={() =>
            void a.run(async () => {
              await api(
                session!.workspaceId,
                `/conversations/${selected}/status`,
                { status: "resolved" },
                undefined,
                session?.token,
              );
              l.reload();
            })
          }
        >
          End chat
        </button>
      )}
    </section>
  );
}
