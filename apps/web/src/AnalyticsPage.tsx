import { useState } from "react";
import { LoadingState } from "./ui.js";
import { api, useLoad } from "./request.js";
import { Field, Inspect, link, type Row } from "./quality-ui.js";
export function AnalyticsPage({ ws }: { ws: string }) {
  const [from, setFrom] = useState(
      new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10),
    ),
    [to, setTo] = useState(new Date().toISOString().slice(0, 10)),
    [channel, setChannel] = useState("");
  const rangeError =
    !from || !to
      ? "Choose a start and end date."
      : from > to
        ? "The end date must be on or after the start date."
        : (Date.parse(to) - Date.parse(from)) / 86400000 >= 366
          ? "Choose a date range of 366 days or less."
          : "";
  const l = useLoad(
    () =>
      rangeError
        ? Promise.resolve(null)
        : api(
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
            max={to || undefined}
            aria-invalid={Boolean(rangeError)}
            aria-describedby={rangeError ? "analytics-range-error" : undefined}
            value={from}
            onChange={(e) => setFrom(e.target.value)}
          />
        </Field>
        <Field label="Through (UTC)">
          <input
            type="date"
            min={from || undefined}
            aria-invalid={Boolean(rangeError)}
            aria-describedby={rangeError ? "analytics-range-error" : undefined}
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
        <button disabled={Boolean(rangeError) || l.loading} onClick={l.reload}>
          {l.loading ? "Refreshing…" : "Refresh analytics"}
        </button>
        <button
          onClick={() => {
            setFrom(
              new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10),
            );
            setTo(new Date().toISOString().slice(0, 10));
            setChannel("");
          }}
        >
          Reset filters
        </button>
      </div>
      {rangeError && (
        <p className="alert" id="analytics-range-error" role="alert">
          {rangeError}
        </p>
      )}
      {l.loading && !rangeError && <LoadingState label="Loading analytics…" />}
      {l.error && <p role="alert">{l.error}</p>}
      {t && (
        <>
          {Number(t.conversations) === 0 && (
            <div className="quality-empty">
              <h2>No conversations in this period</h2>
              <p>
                Change your filters, or return here after customers start a
                conversation. Usage can still appear below.
              </p>
            </div>
          )}
          <div className="quality-metrics">
            {[
              {
                label: "Conversations",
                value: t.conversations,
                detail: "Started in this period",
              },
              {
                label: "AI participation",
                value: t.conversations
                  ? `${Math.round((t.ai_conversations / t.conversations) * 100)}%`
                  : "—",
                detail: `${t.ai_conversations} / ${t.conversations} conversations received an AI reply`,
              },
              {
                label: "Customer-confirmed resolution",
                value: t.ai_conversations
                  ? `${Math.round((t.confirmed_resolution / t.ai_conversations) * 100)}%`
                  : "—",
                detail: `${t.confirmed_resolution} / ${t.ai_conversations} conversations with an AI reply`,
              },
              {
                label: "AI-only confirmed resolution",
                value: t.ai_only_conversations
                  ? `${Math.round((t.ai_only_confirmed / t.ai_only_conversations) * 100)}%`
                  : "—",
                detail: `${t.ai_only_confirmed} / ${t.ai_only_conversations} eligible conversations, without staff replies or handoffs`,
              },
              {
                label: "Staff resolutions",
                value: t.staff_resolved,
                detail: "Explicitly resolved by your team",
              },
              {
                label: "Handoffs",
                value: t.handoffs,
                detail: "Passed from the agent to your team",
              },
            ].map(({ label, value, detail }) => (
              <section className="panel" key={label}>
                <small>{label}</small>
                <p className="quality-metric-value">{String(value)}</p>
                <p className="quality-metric-detail">{detail}</p>
              </section>
            ))}
          </div>
          <details className="panel operational-metrics">
            <summary>
              Response times, reopened tickets & historical coverage
            </summary>
            <dl>
              <div>
                <dt>Average first response</dt>
                <dd>
                  {t.response_time_denominator
                    ? `${Math.round(t.average_first_response_ms / 1000)}s · ${t.response_time_denominator} delivered replies`
                    : "No measured replies"}
                </dd>
              </div>
              <div>
                <dt>Reopened conversations</dt>
                <dd>{t.reopened}</dd>
              </div>
              <div>
                <dt>Unknown delivery timestamps</dt>
                <dd>{t.unknown_delivery}</dd>
              </div>
              <div>
                <dt>Unrecorded outcome history</dt>
                <dd>{t.unknown_history}</dd>
              </div>
            </dl>
          </details>
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
                <div className="satisfaction-source" key={source}>
                  <h3>
                    {
                      {
                        native: "Portal & widget",
                        zendesk_modern: "Zendesk surveys",
                        zendesk_legacy: "Zendesk legacy ratings",
                      }[source]
                    }
                  </h3>
                  <p>
                    {Number(r.rated)
                      ? `${percent(r.good, r.rated)} good · ${r.bad} bad · ${r.neutral} neutral`
                      : "No ratings submitted."}
                  </p>
                  <p className="muted">
                    {r.unrated} conversations without a rating from this source
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
              {!d.handoffs.length && (
                <p className="muted">No recorded handoffs in this period.</p>
              )}
              {d.handoffs.map((h: Row) => (
                <p key={h.reason}>
                  {h.reason.replaceAll("_", " ")}: {h.conversations}
                </p>
              ))}
            </section>
            <section className="panel">
              <h2>Common gap topics</h2>
              {!d.topics.length && (
                <p className="muted">
                  No knowledge gaps recorded in this period.
                </p>
              )}
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
                  {!d.usage.length && (
                    <tr>
                      <td colSpan={6}>
                        No model usage recorded in this period.
                      </td>
                    </tr>
                  )}
                  {d.usage.map((u: Row, i: number) => (
                    <tr key={i}>
                      <td>{u.purpose}</td>
                      <td>
                        {u.provider} / {u.model}
                      </td>
                      <td>{u.input_tokens}</td>
                      <td>{u.output_tokens}</td>
                      <td>{u.reserved}</td>
                      <td>
                        {u.duration_ms == null
                          ? "Unknown"
                          : `${Number(u.duration_ms).toLocaleString()} ms`}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
          <section className="panel">
            <h2>Conversation drill-down</h2>
            <p>Most recent 200 conversations in this cohort.</p>
            {!d.conversations.length && (
              <p className="muted">No conversations match these filters.</p>
            )}
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
