import type { MouseEvent } from "react";
import { inboxState, inboxStates, inboxTime } from "./inbox-state.js";
import type { Row } from "./quality-ui.js";

export function navigate(path: string) {
  history.pushState({}, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
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
}: {
  c: Row;
  selected: string;
  draft?: string;
  onSelect: (c: Row) => void;
  compact?: boolean;
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
        <CustomerStatus c={c} />
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
