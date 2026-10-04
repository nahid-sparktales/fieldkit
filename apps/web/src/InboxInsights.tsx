import { useState } from "react";
import { MessageList } from "./conversation-ui.js";
import type { Row } from "./quality-ui.js";

export function feedbackLabel(feedback: Row) {
  return feedback.resolved === true
    ? "Issue solved"
    : feedback.resolved === false
      ? "Still needs help"
      : "Experience feedback";
}
export function FeedbackPanel({ feedback }: { feedback: Row[] }) {
  return (
    <section aria-label="Customer feedback">
      <h3>Customer feedback</h3>
      <p className="muted">
        Resolution, experience ratings, and comments sent by this customer.
        Overall results are in Analytics.
      </p>
      {!feedback.length ? (
        <div className="inbox-insight-empty">
          <h4>No feedback yet</h4>
          <p>
            Customers can send feedback once after the conversation is closed.
          </p>
        </div>
      ) : (
        feedback.map((f) => (
          <article className="inbox-feedback-card" key={f.id}>
            <header>
              <strong
                className={
                  f.resolved === false || f.rating === "bad"
                    ? "feedback-negative"
                    : ""
                }
              >
                {feedbackLabel(f)}
              </strong>
              <time dateTime={f.answered_at ?? f.updated_at}>
                {new Date(f.answered_at ?? f.updated_at).toLocaleString()}
              </time>
            </header>
            <div className="feedback-meta">
              <span>
                {f.source === "native"
                  ? "FieldKit customer"
                  : f.source === "zendesk_modern"
                    ? "Zendesk survey"
                    : "Zendesk rating"}
              </span>
              <span>
                Experience:{" "}
                {f.rating
                  ? f.rating[0].toUpperCase() + f.rating.slice(1)
                  : "Not rated"}
              </span>
            </div>
            {f.comment ? (
              <blockquote>{f.comment}</blockquote>
            ) : (
              <p className="muted">No comment included.</p>
            )}
            {f.source === "native" && (
              <small>
                Customer submission · preserved when the conversation reopens
              </small>
            )}
          </article>
        ))
      )}
    </section>
  );
}
export function NotesPanel({
  messages,
  compose,
}: {
  messages: Row[];
  compose: () => void;
}) {
  const [query, setQuery] = useState("");
  const notes = messages
    .filter((m) => m.role === "note")
    .slice()
    .reverse();
  const filtered = notes.filter((m) =>
    `${m.body} ${m.author_name ?? ""}`
      .toLowerCase()
      .includes(query.toLowerCase()),
  );
  return (
    <section aria-label="Internal notes">
      <div className="insight-heading">
        <div>
          <h3>Internal notes</h3>
          <p>Only visible to your team · newest first</p>
        </div>
        <button onClick={compose}>Write internal note</button>
      </div>
      {!!notes.length && (
        <input
          type="search"
          aria-label="Search internal notes"
          placeholder="Find a detail in your notes…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      )}
      {filtered.length ? (
        <div className="notes-list">
          <MessageList messages={filtered} />
        </div>
      ) : (
        <div className="inbox-insight-empty">
          <h4>
            {notes.length ? "No matching notes" : "No internal notes yet"}
          </h4>
          <p>
            {notes.length
              ? "Try a different search."
              : "Keep context, handoff details, and reminders here. Notes also stay in the conversation timeline."}
          </p>
        </div>
      )}
    </section>
  );
}
