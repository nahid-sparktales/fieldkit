import { useState } from "react";
import { api, useLoad } from "./request.js";
import { Field, Inspect, link, type Row } from "./quality-ui.js";
export function AnalyticsPage({ ws }: { ws: string }) {
  const [from, setFrom] = useState(
      new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10),
    ),
    [to, setTo] = useState(new Date().toISOString().slice(0, 10)),
    [channel, setChannel] = useState("");
  const l = useLoad(
    () =>
      api(
        ws,
        `/analytics?from=${encodeURIComponent(new Date(from).toISOString())}&to=${encodeURIComponent(new Date(Date.parse(to) + 86400000).toISOString())}${channel ? "&channel=" + channel : ""}`,
      ),
    [ws, from, to, channel],
  );
  const d = l.data,
    t = d?.totals;
  const percent = (value: number, total: number) =>
    total
      ? `${Math.round((value / total) * 100)}% (${value} / ${total})`
      : `No eligible conversations (0 / 0)`;
  return (
    <div className="quality-page">
      <header>
        <span className="eyebrow">CUSTOMER OUTCOMES</span>
        <h1>Analytics</h1>
        <p>
          Resolution, satisfaction, and model usage are measured separately.
        </p>
      </header>
      <div className="quality-filters">
        <Field label="From (UTC)">
          <input
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
          />
        </Field>
        <Field label="Through (UTC)">
          <input
            type="date"
            value={to}
            onChange={(e) => setTo(e.target.value)}
          />
        </Field>
        <Field label="Channel">
          <select value={channel} onChange={(e) => setChannel(e.target.value)}>
            <option value="">All channels</option>
            {["portal", "widget", "zendesk"].map((v) => (
              <option key={v}>{v}</option>
            ))}
          </select>
        </Field>
        <button onClick={l.reload}>Refresh analytics</button>
      </div>
      {l.error && <p role="alert">{l.error}</p>}
      {t && (
        <>
          <div className="quality-metrics">
            {Object.entries({
              Conversations: t.conversations,
              "AI participation": percent(t.ai_conversations, t.conversations),
              "Customer-confirmed resolution": percent(
                t.confirmed_resolution,
                t.ai_conversations,
              ),
              "AI-only confirmed resolution": percent(
                t.ai_only_confirmed,
                t.ai_only_conversations,
              ),
              "Staff resolutions": t.staff_resolved,
              Handoffs: t.handoffs,
              "Reopened conversations": t.reopened,
              "Average first response": t.response_time_denominator
                ? `${Math.round(t.average_first_response_ms / 1000)}s (${t.response_time_denominator} delivered replies)`
                : "No measured replies",
              "Unknown delivery timestamps": t.unknown_delivery,
              "Unrecorded outcome history": t.unknown_history,
            }).map(([label, value]) => (
              <section className="panel" key={label}>
                <small>{label}</small>
                <h3>{String(value)}</h3>
              </section>
            ))}
          </div>
          <section className="panel">
            <h2>Satisfaction</h2>
            <p>
              Latest submitted rating per conversation and source. Ratings do
              not confirm resolution.
            </p>
            {["native", "zendesk_modern", "zendesk_legacy"].map((source) => {
              const r = d.satisfaction.find(
                (r: Row) => r.source === source,
              ) ?? {
                rated: 0,
                good: 0,
                bad: 0,
                neutral: 0,
                unrated: t.conversations,
              };
              return (
                <div key={source}>
                  <h3>{source.replaceAll("_", " ")}</h3>
                  <p>
                    {percent(r.good, r.rated)} good · {r.bad} bad · {r.neutral}{" "}
                    neutral · {r.unrated} conversations without a rating from
                    this source
                  </p>
                </div>
              );
            })}
            {d.feedbackSync.sync_error && (
              <p role="alert">
                Zendesk import needs attention: {d.feedbackSync.sync_error}
              </p>
            )}
            <small>
              Zendesk last completed import:{" "}
              {d.feedbackSync.sync_at
                ? new Date(d.feedbackSync.sync_at).toLocaleString()
                : "Not recorded"}
            </small>
          </section>
          <div className="quality-grid">
            <section className="panel">
              <h2>Handoff reasons</h2>
              {d.handoffs.map((h: Row) => (
                <p key={h.reason}>
                  {h.reason.replaceAll("_", " ")}: {h.conversations}
                </p>
              ))}
            </section>
            <section className="panel">
              <h2>Common gap topics</h2>
              {d.topics.map((g: Row) => (
                <p key={g.id}>
                  <a href={link(ws, "knowledge", `&gap=${g.id}`)}>{g.title}</a>{" "}
                  · {g.occurrences}
                </p>
              ))}
            </section>
          </div>
          <section className="panel">
            <h2>Model usage</h2>
            <p>
              Provider-reported tokens and unresolved reservations. No monetary
              estimates.
            </p>
            <div className="quality-table">
              <table>
                <thead>
                  <tr>
                    <th>Purpose</th>
                    <th>Provider / model</th>
                    <th>Input</th>
                    <th>Output</th>
                    <th>Reserved</th>
                    <th>Duration</th>
                  </tr>
                </thead>
                <tbody>
                  {d.usage.map((u: Row, i: number) => (
                    <tr key={i}>
                      <td>{u.purpose}</td>
                      <td>
                        {u.provider} / {u.model}
                      </td>
                      <td>{u.input_tokens}</td>
                      <td>{u.output_tokens}</td>
                      <td>{u.reserved}</td>
                      <td>{u.duration_ms ?? "Unknown"} ms</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
          <section className="panel">
            <h2>Conversation drill-down</h2>
            <p>Most recent 200 conversations in this cohort.</p>
            {d.conversations.map((c: Row) => (
              <a
                className="quality-list-item"
                href={link(ws, "inbox", `&conversation=${c.id}`)}
                key={c.id}
              >
                {c.subject}
                <small>
                  {c.ai ? "AI reply delivered" : "No recorded AI delivery"} ·{" "}
                  {c.confirmed
                    ? "Customer confirmed"
                    : "No current confirmation"}{" "}
                  · {c.status}
                </small>
              </a>
            ))}
          </section>
          <Inspect
            title="Metric definitions and historical limits"
            value={d.definitions}
          />
        </>
      )}
    </div>
  );
}
