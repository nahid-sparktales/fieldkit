import { useEffect, useId, useRef, useState } from "react";
import { api, useLoad } from "./request.js";
import { inboxStates } from "./inbox-state.js";
import { ConversationCard, Pagination } from "./customer-ui.js";
import type { Row } from "./quality-ui.js";

export function InboxQueue({
  ws,
  selected,
  members,
  drafts,
  onSelect,
  version,
}: {
  ws: string;
  selected: string;
  members: Row[];
  drafts: Record<string, { body: string }>;
  onSelect: (c: Row) => void;
  version: number;
}) {
  const saved = (key: string, fallback: string) => {
    try {
      return sessionStorage.getItem(`fieldkit-inbox:${ws}:${key}`) || fallback;
    } catch {
      return fallback;
    }
  };
  const [type, setType] = useState(() => saved("type", "all")),
    [group, setGroup] = useState(() => saved("group", "conversation")),
    [query, setQuery] = useState(""),
    [search, setSearch] = useState(""),
    [status, setStatus] = useState("all"),
    [section, setSection] = useState("open"),
    [assignment, setAssignment] = useState("all"),
    [page, setPage] = useState(1),
    [expanded, setExpanded] = useState(""),
    [filtersOpen, setFiltersOpen] = useState(false);
  const filtersId = useId();
  useEffect(() => {
    try {
      sessionStorage.setItem(`fieldkit-inbox:${ws}:type`, type);
      sessionStorage.setItem(`fieldkit-inbox:${ws}:group`, group);
    } catch {}
  }, [ws, type, group]);
  useEffect(() => {
    const timer = setTimeout(() => {
      setSearch(query.trim());
      setPage(1);
    }, 200);
    return () => clearTimeout(timer);
  }, [query]);
  const params = new URLSearchParams({
    type,
    group,
    q: search,
    state: status,
    section,
    assignee: assignment,
    page: String(page),
  }).toString();
  const l = useLoad(() => api(ws, `/inbox?${params}`), [ws, params, version]);
  const reload = useRef(l.reload);
  reload.current = l.reload;
  useEffect(() => {
    const refresh = () => {
      if (!document.hidden) reload.current();
    };
    const timer = setInterval(refresh, 15000);
    window.addEventListener("focus", refresh);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", refresh);
    };
  }, [ws]);
  const change = (set: (s: string) => void, value: string) => {
    set(value);
    setPage(1);
    setExpanded("");
  };
  const changeSection = (value: string) => {
    change(setSection, value);
    setStatus("all");
  };
  const clearFilters = () => {
    setQuery("");
    setSearch("");
    setType("all");
    setStatus("all");
    setSection("open");
    setAssignment("all");
    setPage(1);
    setExpanded("");
  };
  const filterCount = [
    type !== "all",
    status !== "all",
    assignment !== "all",
    section === "read",
  ].filter(Boolean).length;
  const hasFilters = filterCount > 0 || Boolean(query.trim());
  const rows: Row[] = l.data?.conversations ?? [];
  return (
    <>
      <div className="inbox-queue-search">
        <input
          type="search"
          aria-label="Search conversations"
          placeholder="Search customer, email, or subject…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      <div className="inbox-sections" role="group" aria-label="Inbox sections">
        {[
          ["open", "Open"],
          ["unread", "Unread"],
          ["closed", "Closed"],
          ["all", "All"],
        ].map(([key, label]) => (
          <button
            key={key}
            aria-label={
              key === "all"
                ? `All conversations ${l.data?.section_counts?.[key] ?? ""}`
                : undefined
            }
            aria-pressed={
              section === key || (key === "open" && section === "read")
            }
            onClick={() => changeSection(key)}
          >
            {label} <span>{l.data?.section_counts?.[key] ?? "–"}</span>
          </button>
        ))}
      </div>
      <div className="inbox-queue-toolbar">
        <select
          aria-label="Inbox status"
          value={status}
          onChange={(e) => {
            change(setStatus, e.target.value);
            if (e.target.value === "resolved") setSection("closed");
            else if (section === "closed" && e.target.value !== "all")
              setSection("open");
          }}
        >
          <option value="all">All statuses</option>
          {Object.entries(inboxStates).map(([value, s]) => (
            <option key={value} value={value}>
              {s.label} · {l.data?.counts[value] ?? 0}
            </option>
          ))}
        </select>
        <button
          className="inbox-filter-toggle"
          aria-expanded={filtersOpen}
          aria-controls={filtersId}
          onClick={() => setFiltersOpen(!filtersOpen)}
        >
          Filters
          {filterCount > 0 && (
            <span className="inbox-filter-count">{filterCount}</span>
          )}
        </button>
      </div>
      <div className="inbox-filter-panel" id={filtersId} hidden={!filtersOpen}>
        <div
          className="inbox-types"
          role="group"
          aria-label="Conversation type"
        >
          {[
            ["all", "All"],
            ["ticket", "Tickets"],
            ["chat", "Chatbot"],
          ].map(([value, label]) => (
            <button
              key={value}
              aria-pressed={type === value}
              onClick={() => change(setType, value)}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="inbox-filter-pair">
          <label>
            <span>Group by</span>
            <select
              aria-label="Group inbox by"
              value={group}
              onChange={(e) => change(setGroup, e.target.value)}
            >
              <option value="customer">Customer</option>
              <option value="conversation">Conversation</option>
            </select>
          </label>
          <label>
            <span>Assigned to</span>
            <select
              aria-label="Filter by assignee"
              value={assignment}
              onChange={(e) => change(setAssignment, e.target.value)}
            >
              <option value="all">Everyone</option>
              <option value="unassigned">Unassigned</option>
              {members.map((m) => (
                <option key={m.user_id} value={m.user_id}>
                  {m.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label className="inbox-read-filter">
          <span>Read status</span>
          <select
            aria-label="Filter by read status"
            value={section === "read" || section === "unread" ? section : "all"}
            onChange={(e) =>
              changeSection(e.target.value === "all" ? "open" : e.target.value)
            }
          >
            <option value="all">Any read status</option>
            <option value="unread">Unread</option>
            <option value="read">Read</option>
          </select>
        </label>
        <p className="inbox-filter-help">
          Read status is just for you. Closed conversations are resolved.
        </p>
      </div>
      <div className="queue-caption inbox-queue-caption">
        <span>
          {l.loading
            ? "Loading…"
            : `${l.data?.total ?? 0} ${group === "customer" ? "customer" : "conversation"}${l.data?.total === 1 ? "" : "s"}`}
          {section === "read" && " · Read"}
        </span>
        {hasFilters ? (
          <button className="inbox-clear-filters" onClick={clearFilters}>
            Clear filters
          </button>
        ) : (
          <span>Latest activity</span>
        )}
      </div>
      {l.error && (
        <div className="alert" role="alert">
          {l.error}
          <button onClick={l.reload}>Try again</button>
        </div>
      )}
      <div className="conversation-items">
        {rows.map((c) =>
          group === "conversation" ? (
            <ConversationCard
              key={c.id}
              c={c}
              members={members}
              selected={selected}
              onSelect={onSelect}
              draft={drafts[c.id]?.body}
            />
          ) : (
            <section
              key={c.contact_id}
              className={`customer-queue-group ${expanded === c.contact_id ? "expanded" : ""}`}
            >
              <button
                className="customer-group-toggle"
                aria-expanded={expanded === c.contact_id}
                onClick={() =>
                  setExpanded(expanded === c.contact_id ? "" : c.contact_id)
                }
              >
                <span className="avatar small" aria-hidden="true">
                  {(c.customer_name || "V")[0]}
                </span>
                <span className="customer-group-info">
                  <strong>
                    {c.customer_name || "Visitor"}
                    {c.group_unread > 0 && (
                      <span className="unread-label">
                        {c.group_unread} unread
                      </span>
                    )}
                  </strong>
                  <span>
                    {c.customer_email ||
                      `Visitor · ${c.contact_id.slice(0, 8)}`}
                  </span>
                  <span>
                    {c.group_count} conversation{c.group_count === 1 ? "" : "s"}{" "}
                    · {c.group_open} open
                  </span>
                  <span className="group-channels">
                    {c.group_tickets} ticket{c.group_tickets === 1 ? "" : "s"} ·{" "}
                    {c.group_chats} chat{c.group_chats === 1 ? "" : "s"}
                  </span>
                  {!!(c.group_human || c.group_approval) && (
                    <span className="group-attention">
                      {c.group_human > 0 && (
                        <span className="badge bad">
                          {c.group_human}{" "}
                          {c.group_human === 1 ? "needs" : "need"} a person
                        </span>
                      )}
                      {c.group_approval > 0 && (
                        <span className="badge warning">
                          {c.group_approval} awaiting approval
                        </span>
                      )}
                    </span>
                  )}
                </span>
                <span aria-hidden="true">
                  {expanded === c.contact_id ? "−" : "+"}
                </span>
              </button>
              {expanded === c.contact_id && (
                <CustomerThreads
                  key={`${c.contact_id}:${params}`}
                  ws={ws}
                  id={c.contact_id}
                  params={params}
                  selected={selected}
                  drafts={drafts}
                  members={members}
                  onSelect={onSelect}
                  version={`${version}:${c.updated_at}:${c.group_count}:${c.group_unread}`}
                />
              )}
            </section>
          ),
        )}
        {!l.loading && !l.error && !rows.length && (
          <div className="empty">
            <h3>No matching conversations</h3>
            <p>Try another type, search, status, or assignee.</p>
            {!hasFilters && (
              <button onClick={clearFilters}>Show open conversations</button>
            )}
          </div>
        )}
      </div>
      <Pagination
        page={page}
        total={l.data?.total ?? 0}
        onChange={setPage}
        label="Inbox"
      />
    </>
  );
}
function CustomerThreads({
  ws,
  id,
  params,
  selected,
  drafts,
  onSelect,
  version,
  members,
}: {
  ws: string;
  id: string;
  params: string;
  selected: string;
  drafts: Record<string, { body: string }>;
  onSelect: (c: Row) => void;
  version: string;
  members: Row[];
}) {
  const [page, setPage] = useState(1);
  const query = new URLSearchParams(params);
  query.set("page", String(page));
  query.set("group", "conversation");
  query.set("contactId", id);
  const l = useLoad(
    () => api(ws, `/inbox?${query}`),
    [ws, id, params, page, version],
  );
  return (
    <div className="customer-group-threads" aria-label="Customer conversations">
      {l.loading && !l.data && <p role="status">Loading conversations…</p>}
      {l.error && (
        <p role="alert">
          {l.error}
          <button onClick={l.reload}>Try again</button>
        </p>
      )}
      {l.data?.conversations.map((c: Row) => (
        <ConversationCard
          key={c.id}
          compact
          c={c}
          members={members}
          selected={selected}
          onSelect={onSelect}
          draft={drafts[c.id]?.body}
        />
      ))}
      <Pagination
        page={page}
        total={l.data?.total ?? 0}
        onChange={setPage}
        label="Customer conversations"
      />
    </div>
  );
}
