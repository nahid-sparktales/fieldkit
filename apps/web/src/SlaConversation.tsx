import { useState } from "react";
import { api, useLoad } from "./request.js";
import { useAction } from "./useAction.js";
import { Notice, link, type Row } from "./quality-ui.js";
import { useSlaEvents } from "./sla-events.js";
import "./sla.css";
const date = (v: string) => new Date(v).toLocaleString();
export function SlaConversation({
  ws,
  id,
  revision,
}: {
  ws: string;
  id: string;
  revision: number;
}) {
  const l = useLoad(
      () => api(ws, `/conversations/${id}/sla`),
      [ws, id, revision],
    ),
    a = useAction(),
    [reminder, setReminder] = useState(false);
  useSlaEvents(ws, l.reload);
  return (
    <section className="sla-conversation">
      <h3>Response deadlines and follow-up</h3>
      <Notice action={a} error={l.error} />
      {!l.data ? (
        <p>Loading timers…</p>
      ) : (
        <>
          <p>
            <a href={link(ws, "needs attention")}>
              Open Needs attention and policy settings ↗
            </a>
          </p>
          {!l.data.obligations.length && (
            <p>
              No recorded SLA obligation. Timers begin with new eligible events
              after tracking is enabled.
            </p>
          )}
          {l.data.obligations.map((o: Row) => (
            <p key={o.id}>
              <strong>
                {o.kind} response · {o.state}
              </strong>{" "}
              · {date(o.due_at)}
              {o.breached_at ? " · Breach retained" : ""}
              <br />
              <small>
                {o.cause} · Policy v{o.policy_revision}
              </small>
            </p>
          ))}
          {l.data.waiting?.status === "waiting" ? (
            <>
              <p>
                Waiting on the customer.{" "}
                {l.data.waiting.allowed
                  ? "Reviewed reminder allowed."
                  : "No automatic reminder."}
              </p>
              <button
                disabled={a.busy}
                onClick={() =>
                  a.run(async () => {
                    await api(
                      ws,
                      `/conversations/${id}/waiting`,
                      { waiting: false },
                      "PUT",
                    );
                    l.reload();
                  })
                }
              >
                End waiting cycle
              </button>
            </>
          ) : (
            <>
              <label className="check-label">
                <input
                  type="checkbox"
                  checked={reminder}
                  onChange={(e) => setReminder(e.target.checked)}
                />
                Allow the administrator’s reviewed reminder for this waiting
                cycle
              </label>
              <button
                disabled={a.busy}
                onClick={() =>
                  a.run(async () => {
                    await api(
                      ws,
                      `/conversations/${id}/waiting`,
                      { waiting: true, allowReminder: reminder },
                      "PUT",
                    );
                    l.reload();
                  }, "Marked as waiting on the customer.")
                }
              >
                Mark waiting after my reply
              </button>
            </>
          )}
          {l.data.waiting?.reason && <p>Follow-up: {l.data.waiting.reason}</p>}
        </>
      )}
    </section>
  );
}
