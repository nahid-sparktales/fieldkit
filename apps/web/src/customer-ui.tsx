import type { MouseEvent } from "react";
import { inboxState, inboxStates, inboxTime } from "./inbox-state.js";
import type { Row } from "./quality-ui.js";
import { confirmDiscardChanges } from "./unsaved-changes.js";

export function replaceCurrentRoute(path: string) {
  history.replaceState({}, "", path);
  // Selection updates the URL without remounting the current editor.
  window.dispatchEvent(new Event("app-route-replaced"));
}
export function navigate(path: string) {
  if (!confirmDiscardChanges()) return;
  history.pushState({}, "", path);
  window.dispatchEvent(
    new PopStateEvent("popstate", { state: { approvedNavigation: true } }),
  );
  window.scrollTo({ top: 0 });
}
export function appLink(event: MouseEvent<HTMLAnchorElement>) {
  if (
    event.button ||
    event.metaKey ||
    event.ctrlKey ||
    event.shiftKey ||
    event.altKey
  )
    return;
  event.preventDefault();
  navigate(event.currentTarget.getAttribute("href")!);
}
export function customerUrl(ws: string, id: string) {
  return `/?workspace=${ws}&view=customers&customer=${id}`;
}
export function conversationUrl(ws: string, id: string) {
  return `/?workspace=${ws}&view=inbox&conversation=${id}`;
}
export function channelLabel(c: Row) {
  return c.channel_kind === "widget"
    ? "Chatbot"
    : c.external_id || c.channel_kind === "zendesk"
      ? "Ticket · Zendesk"
      : "Ticket";
}
export function assigneeLabel(c: Row, members: Row[] = []) {
  return c.assigned_to
    ? (members.find((member) => member.user_id === c.assigned_to)?.name ??
        "Assigned teammate")
    : "Unassigned";
}
export function CustomerStatus({ c }: { c: Row }) {
  const state =
    inboxStates[
      (c.inbox_state ??
        inboxState(
          c as { status: string; mode: string },
        )) as keyof typeof inboxStates
    ];
  return (
    <span className={`badge inbox-status ${state.tone}`}>
      <span aria-hidden="true">{state.symbol}</span>
      {state.label}
    </span>
  );
}
export function Pagination({
  page,
  total,
  size = 40,
  onChange,
  label = "results",
}: {
  page: number;
  total: number;
  size?: number;
  onChange: (p: number) => void;
  label?: string;
}) {
  if (total <= size && page === 1) return null;
  return (
    <nav className="customer-pagination" aria-label={`${label} pages`}>
      <button disabled={page === 1} onClick={() => onChange(page - 1)}>
        Previous
      </button>
      <span>
        Page {page} of {Math.max(1, Math.ceil(total / size))}
      </span>
      <button
        disabled={page * size >= total}
        onClick={() => onChange(page + 1)}
      >
        Next
      </button>
    </nav>
  );
}
export function ConversationCard({
  c,
  selected,
  draft,
  onSelect,
  compact = false,
  members = [],
}: {
  c: Row;
  selected: string;
  draft?: string;
  onSelect: (c: Row) => void;
  compact?: boolean;
  members?: Row[];
}) {
  return (
    <button
      aria-current={selected === c.id ? "true" : undefined}
      className={`conversation-card ${selected === c.id ? "active" : ""} ${compact ? "grouped-ticket" : ""} ${c.unread ? "is-unread" : ""}`}
      onClick={() => onSelect(c)}
    >
      <div className="conversation-person">
        {!compact && (
          <>
            <span className="avatar small" aria-hidden="true">
              {(c.customer_name || "V")[0]}
            </span>
            <strong>{c.customer_name || "Visitor"}</strong>
          </>
        )}
        {compact && (
          <span className="conversation-channel">{channelLabel(c)}</span>
        )}
        <time
          dateTime={c.updated_at}
          title={new Date(c.updated_at).toLocaleString()}
        >
          {inboxTime(c.updated_at)}
        </time>
      </div>
      <h3>
        {c.unread && <span className="unread-dot" aria-label="Unread" />}
        {c.subject}
      </h3>
      <p className="conversation-preview">
        {draft?.trim() ? (
          <>
            <span className="draft-label">Draft: </span>
            {draft}
          </>
        ) : (
          c.last_message || "No messages yet"
        )}
      </p>
      <div className="conversation-labels">
        <span
          className="conversation-owner"
          title={`Assigned to: ${assigneeLabel(c, members)}`}
        >
          {assigneeLabel(c, members)}
        </span>
        <CustomerStatus c={c} />
        {c.sla && (
          <span
            className={`badge ${c.sla.urgency === "overdue" ? "bad" : c.sla.urgency === "at risk" ? "warning" : "neutral"}`}
            title={new Date(c.sla.dueAt).toLocaleString()}
          >
            Response {c.sla.urgency} ·{" "}
            {new Date(c.sla.dueAt).toLocaleTimeString([], {
              hour: "2-digit",
              minute: "2-digit",
            })}
          </span>
        )}
        {["high", "urgent"].includes(c.priority) && (
          <span className="badge warning">{c.priority}</span>
        )}
        {c.feedback_count > 0 && (
          <span
            className={`conversation-feedback-flag ${c.feedback_resolved === false || c.feedback_rating === "bad" ? "negative" : ""}`}
          >
            {c.feedback_resolved === false
              ? "Still needs help"
              : "Feedback received"}
          </span>
        )}
        {!compact && (
          <span className="conversation-channel">{channelLabel(c)}</span>
        )}
      </div>
    </button>
  );
}
