import { useEffect, useRef, useState } from "react";
import { api, useLoad } from "./request.js";
import { useAction } from "./useAction.js";
import { Field, Notice, type Row } from "./quality-ui.js";
import { LoadingState } from "./ui.js";
import { CustomerNote } from "../../../packages/platform/src/customer-contracts.js";
import {
  appLink,
  customerUrl,
  conversationUrl,
  channelLabel,
  CustomerStatus,
  Pagination,
} from "./customer-ui.js";

const date = (value?: string) =>
  value ? new Date(value).toLocaleString() : "No activity yet";
function identityLabel(c: Row) {
  return c.user_id
    ? "Portal account"
    : c.external_id?.startsWith("host:")
      ? "Signed website identity"
      : c.external_id
        ? "Connected support identity"
        : "Visitor";
}
export function CustomersPage({ ws, admin }: { ws: string; admin: boolean }) {
  const [query, setQuery] = useState(""),
    [search, setSearch] = useState(""),
    [kind, setKind] = useState("all"),
    [page, setPage] = useState(1);
  const [selected, setSelected] = useState(
    new URLSearchParams(location.search).get("customer") ?? "",
  );
  useEffect(() => {
    const timer = setTimeout(() => {
      setSearch(query.trim());
      setPage(1);
    }, 200);
    return () => clearTimeout(timer);
  }, [query]);
  const params = new URLSearchParams({ q: search, kind, page: String(page) });
  const l = useLoad(
    () => api(ws, `/customers?${params}`),
    [ws, search, kind, page],
  );
  return (
    <div className={`customers-page ${selected ? "has-customer" : ""}`}>
      <header className="page-heading">
        <div>
          <span className="eyebrow">CUSTOMER RELATIONSHIPS</span>
          <h1>Customers</h1>
          <p>
            Support history, private context, and linked accounts in one place.
          </p>
        </div>
        <button onClick={l.reload} aria-label="Refresh customers">
          ↻ Refresh
        </button>
      </header>
      <div className="customers-layout">
        <section className="customer-directory" aria-label="Customer directory">
          <div className="customer-directory-filters">
            <input
              type="search"
              aria-label="Search customers"
              placeholder="Find a name, email, or identity…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <select
              aria-label="Filter customer accounts"
              value={kind}
              onChange={(e) => {
                setKind(e.target.value);
                setPage(1);
              }}
            >
              <option value="all">All customers</option>
              <option value="verified">Verified identities</option>
              <option value="visitor">Unverified visitors</option>
            </select>
            <small>
              {l.data?.total ?? 0} customer{l.data?.total === 1 ? "" : "s"} ·
              recent activity first
            </small>
          </div>
          {l.error && (
            <p className="alert" role="alert">
              {l.error}
              <button onClick={l.reload}>Try again</button>
            </p>
          )}
          {!l.data && l.loading && <LoadingState label="Loading customers…" />}
          {l.data?.customers.map((c: Row) => (
            <button
              key={c.id}
              className={`customer-directory-card ${selected === c.id ? "selected" : ""}`}
              aria-current={selected === c.id ? "true" : undefined}
              onClick={() => {
                setSelected(c.id);
                history.replaceState({}, "", customerUrl(ws, c.id));
              }}
            >
              <span className="avatar" aria-hidden="true">
                {(c.name || "V")[0]}
              </span>
              <span>
                <strong>{c.name || "Visitor"}</strong>
                <small>{c.email || `Visitor · ${c.id.slice(0, 8)}`}</small>
                <span className="customer-card-counts">
                  {c.open_conversations} open · {c.conversations} total
                </span>
                <small>
                  {c.verified ? "Verified identity" : "Unverified visitor"}
                </small>
              </span>
            </button>
          ))}
          {l.data && !l.data.customers.length && (
            <div className="customer-empty">
              <h3>No customers found</h3>
              <p>
                Try a different search. Customers appear when they use your
                support channels.
              </p>
            </div>
          )}
          <Pagination
            page={page}
            total={l.data?.total ?? 0}
            onChange={setPage}
            label="Customers"
          />
        </section>
        <section className="customer-detail" aria-label="Customer profile">
          {selected ? (
            <>
              <button
                className="customer-back"
                onClick={() => {
                  setSelected("");
                  history.replaceState(
                    {},
                    "",
                    `/?workspace=${ws}&view=customers`,
                  );
                }}
              >
                ← All customers
              </button>
              <CustomerProfile
                key={selected}
                ws={ws}
                id={selected}
                admin={admin}
              />
            </>
          ) : (
            <div className="customer-empty">
              <h2>Know the person behind the ticket</h2>
              <p>
                Choose a customer to see their conversations, team notes, and
                connected account identities. Customers remain separate from
                staff accounts.
              </p>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
export function CustomerProfile({
  ws,
  id,
  admin,
  compact = false,
  currentConversation,
  active = true,
}: {
  ws: string;
  id: string;
  admin: boolean;
  compact?: boolean;
  currentConversation?: string;
  active?: boolean;
}) {
  const [tab, setTab] = useState("history");
  const l = useLoad(() => api(ws, `/customers/${id}`), [ws, id]);
  useEffect(() => {
    if (active) l.reload();
  }, [active]);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (l.data && !compact) heading.current?.focus({ preventScroll: true });
  }, [Boolean(l.data), compact]);
  if (!l.data)
    return l.error ? (
      <p role="alert" className="alert">
        {l.error}
        <button onClick={l.reload}>Try again</button>
      </p>
    ) : (
      <LoadingState label="Loading customer profile…" />
    );
  const { contact: c, summary: s } = l.data;
  const tabs = [
    ["history", "Conversations"],
    ["notes", "Customer notes"],
    ["accounts", "Linked accounts"],
  ];
  return (
    <div className={`customer-profile ${compact ? "compact" : ""}`}>
      <header className="customer-profile-header">
        <span className="avatar" aria-hidden="true">
          {(c.name || "V")[0]}
        </span>
        <div>
          <h2 tabIndex={-1} ref={heading}>
            {c.name || "Visitor"}
          </h2>
          <p>{c.email || "No email provided"}</p>
          <div className="customer-identity">
            <span className={`badge ${c.verified ? "good" : "neutral"}`}>
              {c.verified ? "Verified identity" : "Unverified visitor"}
            </span>
            <span>{identityLabel(c)}</span>
          </div>
        </div>
        {compact && (
          <a href={customerUrl(ws, id)} onClick={appLink}>
            Full profile ↗
          </a>
        )}
      </header>
      <div className="customer-stats" aria-label="Customer support totals">
        {[
          [s.open, "Open"],
          [s.tickets, "Tickets"],
          [s.chats, "Chats"],
          [s.notes, "Notes"],
        ].map(([value, label]) => (
          <div key={label}>
            <strong>{value}</strong>
            <span>{label}</span>
          </div>
        ))}
      </div>
      <div className="customer-activity-dates">
        <span>
          First conversation:{" "}
          {s.first_contact
            ? new Date(s.first_contact).toLocaleDateString()
            : "None yet"}
        </span>
        <span>Last activity: {date(s.last_activity)}</span>
      </div>
      <div
        className="customer-profile-tabs"
        role="tablist"
        aria-label="Customer profile sections"
      >
        {tabs.map(([value, label], index) => (
          <button
            key={value}
            role="tab"
            aria-selected={tab === value}
            aria-controls={`customer-${id}-${value}`}
            id={`customer-tab-${id}-${value}`}
            tabIndex={tab === value ? 0 : -1}
            onClick={() => setTab(value)}
            onKeyDown={(e) => {
              const next =
                e.key === "ArrowRight"
                  ? (index + 1) % tabs.length
                  : e.key === "ArrowLeft"
                    ? (index + tabs.length - 1) % tabs.length
                    : e.key === "Home"
                      ? 0
                      : e.key === "End"
                        ? tabs.length - 1
                        : -1;
              if (next >= 0) {
                e.preventDefault();
                setTab(tabs[next][0]);
                (
                  e.currentTarget.parentElement?.children[next] as HTMLElement
                ).focus();
              }
            }}
          >
            {label}
          </button>
        ))}
      </div>
      {tabs.map(([value]) => (
        <div
          key={value}
          className="customer-section"
          role="tabpanel"
          id={`customer-${id}-${value}`}
          aria-labelledby={`customer-tab-${id}-${value}`}
          hidden={tab !== value}
        >
          {value === "history" ? (
            <CustomerHistory
              ws={ws}
              id={id}
              currentConversation={currentConversation}
              active={active && tab === "history"}
            />
          ) : value === "notes" ? (
            <CustomerNotes
              ws={ws}
              id={id}
              changed={l.reload}
              active={active && tab === "notes"}
            />
          ) : (
            <AccountLinks
              key={c.revision}
              ws={ws}
              contact={c}
              admin={admin}
              changed={l.reload}
            />
          )}
        </div>
      ))}
    </div>
  );
}
function CustomerHistory({
  ws,
  id,
  currentConversation,
  active,
}: {
  ws: string;
  id: string;
  currentConversation?: string;
  active: boolean;
}) {
  const [page, setPage] = useState(1),
    [type, setType] = useState("all");
  const l = useLoad(
    () => api(ws, `/customers/${id}/conversations?type=${type}&page=${page}`),
    [ws, id, type, page],
  );
  useEffect(() => {
    if (active) l.reload();
  }, [active]);
  return (
    <>
      <div className="customer-section-heading">
        <div>
          <h3>Support history</h3>
          <p>Every retained ticket and chat for this customer.</p>
        </div>
        <select
          aria-label="Customer history type"
          value={type}
          onChange={(e) => {
            setType(e.target.value);
            setPage(1);
          }}
        >
          <option value="all">Tickets & chats</option>
          <option value="ticket">Tickets</option>
          <option value="chat">Chatbot</option>
        </select>
        <button aria-label="Refresh customer history" onClick={l.reload}>
          ↻
        </button>
      </div>
      {l.error && <p role="alert">{l.error}</p>}
      {!l.data && l.loading && <p role="status">Loading history…</p>}
      {l.data?.conversations.map((c: Row) => (
        <a
          className={`customer-history-card ${c.id === currentConversation ? "current" : ""}`}
          key={c.id}
          href={conversationUrl(ws, c.id)}
          onClick={appLink}
        >
          <div>
            <span>
              {channelLabel(c)}
              {c.id === currentConversation ? " · Current conversation" : ""}
            </span>
            <time dateTime={c.updated_at}>{date(c.updated_at)}</time>
          </div>
          <h4>{c.subject}</h4>
          <p>{c.last_message || "No messages yet"}</p>
          <CustomerStatus c={c} />
          <span className="history-open">Open conversation ↗</span>
        </a>
      ))}
      {l.data && !l.data.total && (
        <div className="customer-empty">
          <h4>No conversations yet</h4>
          <p>Customer conversations will appear here.</p>
        </div>
      )}
      <Pagination
        page={page}
        total={l.data?.total ?? 0}
        onChange={setPage}
        label="Support history"
      />
    </>
  );
}
function CustomerNotes({
  ws,
  id,
  changed,
  active,
}: {
  ws: string;
  id: string;
  changed: () => void;
  active: boolean;
}) {
  const [page, setPage] = useState(1),
    [body, setBody] = useState("");
  const key = useRef(crypto.randomUUID());
  const l = useLoad(
    () => api(ws, `/customers/${id}/notes?page=${page}`),
    [ws, id, page],
  );
  const a = useAction();
  useEffect(() => {
    if (active) l.reload();
  }, [active]);
  return (
    <>
      <div className="customer-section-heading">
        <div>
          <h3>Private customer notes</h3>
          <p>
            Account context and notes from past conversations. Only your team
            can see these.
          </p>
        </div>
      </div>
      <form
        className="customer-note-composer"
        onSubmit={(e) => {
          e.preventDefault();
          if (!body.trim() || a.busy) return;
          void a.run(async () => {
            await api(
              ws,
              `/customers/${id}/notes`,
              CustomerNote.parse({ body, requestKey: key.current }),
            );
            setBody("");
            key.current = crypto.randomUUID();
            setPage(1);
            l.reload();
            changed();
          }, "Customer note added. Nothing was sent to the customer.");
        }}
      >
        <label>
          <span>Add a customer note</span>
          <textarea
            aria-label="Add a customer note"
            maxLength={12000}
            rows={3}
            value={body}
            onChange={(e) => {
              setBody(e.target.value);
              key.current = crypto.randomUUID();
            }}
            placeholder="Keep useful context for the next person who helps…"
            disabled={a.busy}
          />
        </label>
        <div>
          <small>Private · applies to this customer across conversations</small>
          <button disabled={a.busy || !body.trim()}>
            {a.busy ? "Adding…" : "Add customer note"}
          </button>
        </div>
      </form>
      <Notice action={a} error={l.error} />
      {!l.data && l.loading && <p role="status">Loading notes…</p>}
      {l.data?.notes.map((n: Row) => (
        <article className="customer-note-card" key={n.id}>
          <header>
            <strong>{n.author_name || "Support team"}</strong>
            <time dateTime={n.created_at}>{date(n.created_at)}</time>
          </header>
          <p>{n.body}</p>
          {n.conversation_id ? (
            <a href={conversationUrl(ws, n.conversation_id)} onClick={appLink}>
              From: {n.subject} ↗
            </a>
          ) : (
            <small>Customer note</small>
          )}
        </article>
      ))}
      {l.data && !l.data.total && (
        <div className="customer-empty">
          <h4>No notes yet</h4>
          <p>
            Add account context here. Internal notes on their tickets also
            appear in this list.
          </p>
        </div>
      )}
      <Pagination
        page={page}
        total={l.data?.total ?? 0}
        onChange={setPage}
        label="Customer notes"
      />
    </>
  );
}
function AccountLinks({
  ws,
  contact: c,
  admin,
  changed,
}: {
  ws: string;
  contact: Row;
  admin: boolean;
  changed: () => void;
}) {
  const [userId, setUserId] = useState(c.user_id ?? "");
  const [editing, setEditing] = useState(false),
    [entries, setEntries] = useState(() =>
      Object.entries(c.mappings ?? {}).map(([provider, value]) => ({
        provider,
        value: String(value),
      })),
    );
  const a = useAction();
  return (
    <>
      <div className="customer-section-heading">
        <div>
          <h3>Linked accounts</h3>
          <p>
            Reviewed provider identities used for account lookups and approved
            actions.
          </p>
        </div>
        {admin && !editing && (
          <button onClick={() => setEditing(true)}>Edit account links</button>
        )}
      </div>
      <dl className="customer-account-facts">
        <div>
          <dt>Identity</dt>
          <dd>{identityLabel(c)}</dd>
        </div>
        <div>
          <dt>Verification</dt>
          <dd>
            {c.verified
              ? "Verified"
              : "Not verified — account actions unavailable"}
          </dd>
        </div>
        <div>
          <dt>FieldKit customer ID</dt>
          <dd>{c.id}</dd>
        </div>
        {c.external_id && (
          <div>
            <dt>External identity</dt>
            <dd>{c.external_id}</dd>
          </div>
        )}
        {c.user_id && (
          <div>
            <dt>Portal user ID</dt>
            <dd>{c.user_id}</dd>
          </div>
        )}
      </dl>
      {!editing &&
        (entries.length ? (
          <div className="account-link-list">
            {entries.map((e) => (
              <div key={e.provider}>
                <strong>{e.provider.replaceAll("_", " ")}</strong>
                <code>{e.value}</code>
              </div>
            ))}
          </div>
        ) : (
          <div className="customer-empty">
            <h4>No provider accounts linked</h4>
            <p>
              An owner or admin can link an account after reviewing customer
              ownership.
            </p>
          </div>
        ))}
      {editing && (
        <form
          className="customer-account-editor"
          onSubmit={(e) => {
            e.preventDefault();
            void a.run(async () => {
              const mappings: Record<string, string> = {};
              for (const entry of entries) {
                const provider = entry.provider.trim(),
                  value = entry.value.trim();
                if (!provider || !value)
                  throw new Error(
                    "Enter a provider and account ID for every row, or remove the empty row.",
                  );
                if (provider in mappings)
                  throw new Error("Each provider can only appear once.");
                mappings[provider] = value;
              }
              await api(
                ws,
                `/contacts/${c.id}/mapping`,
                {
                  mappings,
                  ...(userId.trim() ? { userId: userId.trim() } : {}),
                },
                "PUT",
              );
              setEditing(false);
              changed();
            }, "Account links updated.");
          }}
        >
          <p className="mapping-explanation">
            Verify ownership before linking. An email match or a
            customer-supplied account ID is not proof of ownership. Changes
            affect which account data and actions this customer can access.
          </p>
          {entries.map((entry, index) => (
            <div className="account-link-editor-row" key={index}>
              <Field label={`Provider ${index + 1}`}>
                <input
                  required
                  pattern="[a-z][a-z0-9_]{1,40}"
                  value={entry.provider}
                  placeholder="stripe_test"
                  onChange={(e) =>
                    setEntries((rows) =>
                      rows.map((r, i) =>
                        i === index ? { ...r, provider: e.target.value } : r,
                      ),
                    )
                  }
                />
              </Field>
              <Field label={`Account ID ${index + 1}`}>
                <input
                  required
                  maxLength={200}
                  value={entry.value}
                  placeholder="cus_…"
                  onChange={(e) =>
                    setEntries((rows) =>
                      rows.map((r, i) =>
                        i === index ? { ...r, value: e.target.value } : r,
                      ),
                    )
                  }
                />
              </Field>
              <button
                type="button"
                aria-label={`Remove account link ${index + 1}`}
                onClick={() =>
                  setEntries((rows) => rows.filter((_, i) => i !== index))
                }
              >
                ×
              </button>
            </div>
          ))}
          <button
            type="button"
            onClick={() =>
              setEntries((rows) => [...rows, { provider: "", value: "" }])
            }
          >
            + Add account link
          </button>
          <Field label="Verified portal user ID (optional)">
            <input
              value={userId}
              onChange={(e) => setUserId(e.target.value)}
              placeholder="Existing verified portal user ID"
            />
          </Field>
          <p className="muted">
            Use stripe_test or stripe_live for Stripe. Custom actions use their
            configured identity mapping key.
          </p>
          <div className="button-row">
            <button disabled={a.busy} className="primary">
              Save reviewed links
            </button>
            <button
              type="button"
              disabled={a.busy}
              onClick={() => {
                setEditing(false);
                setEntries(
                  Object.entries(c.mappings ?? {}).map(([provider, value]) => ({
                    provider,
                    value: String(value),
                  })),
                );
                a.setError("");
              }}
            >
              Cancel
            </button>
          </div>
        </form>
      )}
      <Notice action={a} />
    </>
  );
}
