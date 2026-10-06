import { useEffect, useRef, useState } from "react";
import { LoadingState } from "./ui.js";
import { api, useLoad } from "./request.js";
import { Field, Inspect, link, type Row } from "./quality-ui.js";
import { appLink, Pagination } from "./customer-ui.js";

const day = 86400000;
const isoDay = (time: number) => new Date(time).toISOString().slice(0, 10);
const statuses: Record<string, string> = {
  needs_staff: "Needs a person",
  waiting_approval: "Awaiting approval",
  open: "Open",
  resolved: "Resolved",
};
const cohorts = [
  ["all", "All conversations"],
  ["ai", "AI participation"],
  ["confirmed", "Customer-confirmed resolution"],
  ["ai_only", "AI-only confirmed resolution"],
  ["staff_resolved", "Staff resolutions"],
  ["handoff", "Handoffs"],
];
const matches = (row: Row, cohort: string) =>
  cohort === "all" ||
  (cohort === "confirmed"
    ? row.ai && row.confirmed
    : cohort === "ai_only"
      ? row.ai_only && row.confirmed
      : row[cohort]);
const initial = (key: string, fallback: string) =>
  new URLSearchParams(location.search).get(key) ?? fallback;
const initialChoice = (key: string, options: string[], fallback: string) => {
  const value = initial(key, fallback);
  return options.includes(value) ? value : fallback;
};
export function AnalyticsPage({ ws }: { ws: string }) {
  const [from, setFrom] = useState(() =>
      initial("from", isoDay(Date.now() - 30 * day)),
    ),
    [to, setTo] = useState(() => initial("to", isoDay(Date.now()))),
    [channel, setChannel] = useState(() =>
      initialChoice("channel", ["", "portal", "widget", "zendesk"], ""),
    ),
    [tab, setTab] = useState(() =>
      initialChoice(
        "section",
        ["overview", "conversations", "usage"],
        "overview",
      ),
    ),
    [cohort, setCohort] = useState(() =>
      initialChoice(
        "cohort",
        cohorts.map(([id]) => id),
        "all",
      ),
    ),
    [query, setQuery] = useState(() => initial("q", "")),
    [status, setStatus] = useState(() =>
      initialChoice("status", ["all", ...Object.keys(statuses)], "all"),
    ),
    [order, setOrder] = useState(() =>
      initialChoice("order", ["newest", "oldest", "subject"], "newest"),
    ),
    [page, setPage] = useState(() =>
      Math.min(10, Math.max(1, Math.floor(Number(initial("page", "1"))) || 1)),
    );
  const detail = useRef<HTMLHeadingElement>(null);
  const rangeError =
    !/^\d{4}-\d{2}-\d{2}$/.test(from) ||
    !/^\d{4}-\d{2}-\d{2}$/.test(to) ||
    !Number.isFinite(Date.parse(from)) ||
    !Number.isFinite(Date.parse(to)) ||
    isoDay(Date.parse(from)) !== from ||
    isoDay(Date.parse(to)) !== to
      ? "Choose a start and end date."
      : from > to
        ? "The end date must be on or after the start date."
        : (Date.parse(to) - Date.parse(from)) / day >= 366
          ? "Choose a date range of 366 days or less."
          : "";
  useEffect(() => {
    const url = new URL(location.href);
    for (const [key, value] of Object.entries({
      from,
      to,
      channel,
      section: tab,
      cohort,
      q: query,
      status,
      order,
      page: String(page),
    })) {
      if (value) url.searchParams.set(key, value);
      else url.searchParams.delete(key);
    }
    history.replaceState(history.state, "", url);
  }, [from, to, channel, tab, cohort, query, status, order, page]);
  const l = useLoad(
    () =>
      rangeError
        ? Promise.resolve(null)
        : api(
            ws,
            `/analytics?from=${encodeURIComponent(new Date(from).toISOString())}&to=${encodeURIComponent(new Date(Date.parse(to) + day).toISOString())}${channel ? "&channel=" + encodeURIComponent(channel) : ""}`,
          ),
    [ws, from, to, channel, rangeError],
  );
  const d = l.data,
    t = d?.totals,
    previous = d?.comparison?.totals;
  const rate = (value: number, total: number) =>
    total ? `${Math.round((value / total) * 100)}%` : "—";
  const percent = (value: number, total: number) =>
    total
      ? `${rate(value, total)} (${value} / ${total})`
      : "No eligible conversations (0 / 0)";
  const inspect = (value: string) => {
    setCohort(value);
    setQuery("");
    setStatus("all");
    setPage(1);
    setTab("conversations");
    requestAnimationFrame(() => {
      detail.current?.focus();
      detail.current?.scrollIntoView({ block: "start" });
    });
  };
  const rows: Row[] = (d?.conversations ?? [])
    .filter(
      (c: Row) =>
        matches(c, cohort) &&
        (status === "all" || status === c.status) &&
        c.subject.toLowerCase().includes(query.toLowerCase()),
    )
    .sort((a: Row, b: Row) =>
      order === "subject"
        ? a.subject.localeCompare(b.subject)
        : (order === "oldest" ? 1 : -1) *
          (Date.parse(a.created_at) - Date.parse(b.created_at)),
    );
  const pages = Math.max(1, Math.ceil(rows.length / 20)),
    activePage = Math.min(page, pages);
  const days = rangeError
    ? 0
    : Math.round((Date.parse(to) - Date.parse(from)) / day) + 1;
  const bucket = days > 60 ? 7 : 1;
  const series = Array.from({ length: Math.ceil(days / bucket) }, (_, i) => {
    const start = isoDay(Date.parse(from) + i * bucket * day),
      end = isoDay(
        Math.min(Date.parse(to), Date.parse(start) + (bucket - 1) * day),
      );
    return {
      start,
      end,
      count: (d?.trend ?? [])
        .filter((v: Row) => v.day >= start && v.day <= end)
        .reduce((sum: number, v: Row) => sum + v.conversations, 0),
    };
  });
  const max = Math.max(1, ...series.map((v) => v.count));
  const metrics = t
    ? [
        {
          key: "all",
          label: "Conversations",
          value: t.conversations,
          before: previous?.conversations,
          detail: "Started in this period",
        },
        {
          key: "ai",
          label: "AI participation",
          value: rate(t.ai_conversations, t.conversations),
          before:
            previous && rate(previous.ai_conversations, previous.conversations),
          detail: `${t.ai_conversations} / ${t.conversations} conversations received an AI reply`,
        },
        {
          key: "confirmed",
          label: "Customer-confirmed resolution",
          value: rate(t.confirmed_resolution, t.ai_conversations),
          before:
            previous &&
            rate(previous.confirmed_resolution, previous.ai_conversations),
          detail: `${t.confirmed_resolution} / ${t.ai_conversations} conversations with an AI reply`,
        },
        {
          key: "ai_only",
          label: "AI-only confirmed resolution",
          value: rate(t.ai_only_confirmed, t.ai_only_conversations),
          before:
            previous &&
            rate(previous.ai_only_confirmed, previous.ai_only_conversations),
          detail: `${t.ai_only_confirmed} / ${t.ai_only_conversations} eligible conversations, without staff replies or handoffs`,
        },
        {
          key: "staff_resolved",
          label: "Staff resolutions",
          value: t.staff_resolved,
          before: previous?.staff_resolved,
          detail: "Explicitly resolved by your team",
        },
        {
          key: "handoff",
          label: "Handoffs",
          value: t.handoffs,
          before: previous?.handoffs,
          detail: "Passed from the agent to your team",
        },
      ]
    : [];
  return (
    <div className="quality-page analytics-page">
      <header>
        <span className="eyebrow">CUSTOMER OUTCOMES</span>
        <h1>Analytics</h1>
        <p>
          Understand support outcomes, then investigate the conversations behind
          them.
        </p>
      </header>
      <div className="quality-filters">
        <Field label="From (UTC)">
          <input
            type="date"
            max={to || undefined}
            value={from}
            aria-invalid={!!rangeError}
            aria-describedby={rangeError ? "analytics-range-error" : undefined}
            onChange={(e) => {
              setFrom(e.target.value);
              setPage(1);
            }}
          />
        </Field>
        <Field label="Through (UTC)">
          <input
            type="date"
            min={from || undefined}
            value={to}
            aria-invalid={!!rangeError}
            aria-describedby={rangeError ? "analytics-range-error" : undefined}
            onChange={(e) => {
              setTo(e.target.value);
              setPage(1);
            }}
          />
        </Field>
        <Field label="Channel">
          <select
            value={channel}
            onChange={(e) => {
              setChannel(e.target.value);
              setPage(1);
            }}
          >
            <option value="">All channels</option>
            <option value="portal">Support portal</option>
            <option value="widget">Chat widget</option>
            <option value="zendesk">Zendesk</option>
          </select>
        </Field>
        <button disabled={!!rangeError || l.loading} onClick={l.reload}>
          {l.loading ? "Refreshing…" : "Refresh analytics"}
        </button>
        <button
          onClick={() => {
            setFrom(isoDay(Date.now() - 30 * day));
            setTo(isoDay(Date.now()));
            setChannel("");
            setCohort("all");
            setStatus("all");
            setQuery("");
            setPage(1);
          }}
        >
          Reset filters
        </button>
      </div>
      {rangeError && (
        <p id="analytics-range-error" role="alert" className="alert">
          {rangeError}
        </p>
      )}
      {l.loading && !rangeError && !d && (
        <LoadingState label="Loading analytics…" />
      )}
      {l.error && (
        <p role="alert">
          {l.error} {d && "Showing the last loaded results."}{" "}
          <button onClick={l.reload}>Retry analytics</button>
        </p>
      )}
      {t && (
        <>
          <div
            className="analytics-section-nav"
            role="group"
            aria-label="Analytics sections"
          >
            {[
              ["overview", "Overview"],
              ["conversations", "Conversations"],
              ["usage", "Usage & definitions"],
            ].map(([id, title]) => (
              <button
                key={id}
                aria-pressed={tab === id}
                onClick={() => setTab(id)}
              >
                {title}
              </button>
            ))}
          </div>
          {tab === "overview" && (
            <>
              {!t.conversations && (
                <div className="quality-empty">
                  <h2>No conversations in this period</h2>
                  <p>
                    Change your filters, or return after customers start a
                    conversation. Model usage may still be available.
                  </p>
                </div>
              )}
              <p className="muted">
                Compared with{" "}
                {d.comparison
                  ? `${d.comparison.from.slice(0, 10)} through ${isoDay(Date.parse(d.comparison.to) - day)} (UTC)`
                  : "an unavailable previous period"}
                . Outcomes reflect retained history through now, not just
                activity during each period.
              </p>
              <div className="quality-metrics">
                {metrics.map((m) => (
                  <button
                    className="panel analytics-metric-button"
                    key={m.key}
                    onClick={() => inspect(m.key)}
                    aria-label={
                      m.key === "all"
                        ? "View all conversations"
                        : `View ${m.label.toLowerCase()} conversations`
                    }
                  >
                    <small>{m.label}</small>
                    <p className="quality-metric-value">{m.value}</p>
                    <p className="quality-metric-detail">{m.detail}</p>
                    <span className="analytics-comparison">
                      Previous period: {m.before ?? "Unavailable"} · View
                      conversations →
                    </span>
                  </button>
                ))}
              </div>
              <section className="panel">
                <h2>Conversation volume over time</h2>
                <p>
                  {bucket === 1 ? "Daily" : "7-day periods"}, UTC ·
                  conversations created in the selected period.
                </p>
                {d.trend ? (
                  <>
                    <div
                      className="analytics-trend"
                      role="img"
                      aria-label={`${t.conversations} conversations from ${from} through ${to}. Exact counts in the table below.`}
                    >
                      {series.map((v) => (
                        <span
                          key={v.start}
                          title={`${v.start}${bucket > 1 ? ` – ${v.end}` : ""}: ${v.count}`}
                        >
                          <i style={{ height: `${(v.count / max) * 100}%` }} />
                        </span>
                      ))}
                    </div>
                    <div className="analytics-trend-labels">
                      <span>{from}</span>
                      <span>
                        Peak: {max === 1 && !t.conversations ? 0 : max}
                      </span>
                      <span>{to}</span>
                    </div>
                    <details>
                      <summary>View exact counts</summary>
                      <div className="analytics-table">
                        <table>
                          <thead>
                            <tr>
                              <th>Period (UTC)</th>
                              <th>Conversations</th>
                            </tr>
                          </thead>
                          <tbody>
                            {series.map((v) => (
                              <tr key={v.start}>
                                <td>
                                  {v.start}
                                  {bucket > 1 && ` – ${v.end}`}
                                </td>
                                <td>{v.count}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </details>
                  </>
                ) : (
                  <p>Historical volume is unavailable.</p>
                )}
              </section>
              <div className="quality-grid">
                <section className="panel">
                  <h2>Why conversations need your team</h2>
                  {!d.handoffs.length && (
                    <p>No recorded handoffs in this period.</p>
                  )}
                  <ul className="analytics-bar-chart">
                    {d.handoffs.map((h: Row) => (
                      <li key={h.reason}>
                        <span>{h.reason.replaceAll("_", " ")}</span>
                        <meter
                          aria-label={h.reason.replaceAll("_", " ")}
                          min={0}
                          max={Math.max(
                            ...d.handoffs.map((v: Row) => v.conversations),
                            1,
                          )}
                          value={h.conversations}
                        />
                        <strong>{h.conversations}</strong>
                      </li>
                    ))}
                  </ul>
                  <button onClick={() => inspect("handoff")}>
                    Review handoff conversations
                  </button>
                </section>
                <section className="panel">
                  <h2>Common gap topics</h2>
                  {!d.topics.length && (
                    <p>No knowledge gaps recorded in this period.</p>
                  )}
                  {d.topics.map((g: Row) => (
                    <p key={g.id}>
                      <a
                        href={link(ws, "knowledge", `&gap=${g.id}`)}
                        onClick={appLink}
                      >
                        {g.title}
                      </a>{" "}
                      · {g.occurrences}
                    </p>
                  ))}
                </section>
              </div>
              <details className="panel operational-metrics">
                <summary>
                  Response times, reopened tickets & historical coverage
                </summary>
                <dl>
                  <dt>Average first response</dt>
                  <dd>
                    {t.response_time_denominator
                      ? `${Math.round(t.average_first_response_ms / 1000)}s · ${t.response_time_denominator} delivered replies`
                      : "No measured replies"}
                  </dd>
                  <dt>Reopened conversations</dt>
                  <dd>{t.reopened}</dd>
                  <dt>Unknown delivery timestamps</dt>
                  <dd>{t.unknown_delivery}</dd>
                  <dt>Unrecorded outcome history</dt>
                  <dd>{t.unknown_history}</dd>
                </dl>
              </details>
              <section className="panel">
                <h2>Satisfaction</h2>
                <p>
                  Latest rating per conversation and source. Ratings do not
                  confirm resolution.
                </p>
                {["native", "zendesk_modern", "zendesk_legacy"].map(
                  (source) => {
                    const r = d.satisfaction.find(
                      (v: Row) => v.source === source,
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
                          {r.rated
                            ? `${percent(r.good, r.rated)} good · ${r.bad} bad · ${r.neutral} neutral`
                            : "No ratings submitted."}
                        </p>
                        <small>
                          {r.unrated} conversations without a rating from this
                          source
                        </small>
                      </div>
                    );
                  },
                )}
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
            </>
          )}
          {tab === "conversations" && (
            <section className="panel">
              <h2 ref={detail} tabIndex={-1}>
                Conversation drill-down
              </h2>
              <p>
                Search and filter the most recent 200 conversations in this
                period. Metrics above include the entire cohort.
              </p>
              <div className="quality-filters">
                <Field label="Search conversation subjects">
                  <input
                    type="search"
                    value={query}
                    onChange={(e) => {
                      setQuery(e.target.value);
                      setPage(1);
                    }}
                  />
                </Field>
                <Field label="Outcome">
                  <select
                    value={cohort}
                    onChange={(e) => {
                      setCohort(e.target.value);
                      setPage(1);
                    }}
                  >
                    {cohorts.map(([id, title]) => (
                      <option key={id} value={id}>
                        {title}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Status">
                  <select
                    value={status}
                    onChange={(e) => {
                      setStatus(e.target.value);
                      setPage(1);
                    }}
                  >
                    <option value="all">All statuses</option>
                    {Object.entries(statuses).map(([id, title]) => (
                      <option key={id} value={id}>
                        {title}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Sort conversations">
                  <select
                    value={order}
                    onChange={(e) => {
                      setOrder(e.target.value);
                      setPage(1);
                    }}
                  >
                    <option value="newest">Newest first</option>
                    <option value="oldest">Oldest first</option>
                    <option value="subject">Subject A–Z</option>
                  </select>
                </Field>
              </div>
              <p role="status">
                {rows.length} matching conversations in the loaded cohort.
              </p>
              <div className="analytics-table">
                <table>
                  <thead>
                    <tr>
                      <th>Conversation</th>
                      <th>Created (UTC)</th>
                      <th>Status</th>
                      <th>Outcome</th>
                    </tr>
                  </thead>
                  <tbody>
                    {!rows.length && (
                      <tr>
                        <td colSpan={4}>
                          No conversations match. Try another outcome, status or
                          search.
                        </td>
                      </tr>
                    )}
                    {rows
                      .slice((activePage - 1) * 20, activePage * 20)
                      .map((c) => (
                        <tr key={c.id}>
                          <td>
                            <a
                              href={link(ws, "inbox", `&conversation=${c.id}`)}
                              onClick={appLink}
                            >
                              {c.subject}
                            </a>
                          </td>
                          <td>
                            {new Date(c.created_at).toISOString().slice(0, 10)}
                          </td>
                          <td>
                            {statuses[c.status] ??
                              c.status.replaceAll("_", " ")}
                          </td>
                          <td>
                            {c.ai
                              ? "AI reply delivered"
                              : "No recorded AI delivery"}{" "}
                            ·{" "}
                            {c.confirmed
                              ? "Customer confirmed"
                              : "No current confirmation"}
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
              <Pagination
                page={activePage}
                size={20}
                total={rows.length}
                onChange={setPage}
                label="Analytics conversations"
              />
            </section>
          )}
          {tab === "usage" && (
            <>
              <section className="panel">
                <h2>Model usage</h2>
                <p>
                  Provider-reported tokens and unresolved reservations. No
                  monetary estimates.
                </p>
                <div className="analytics-table">
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
                          <td>{u.purpose.replaceAll("_", " ")}</td>
                          <td>
                            {u.provider} / {u.model}
                          </td>
                          <td>{Number(u.input_tokens).toLocaleString()}</td>
                          <td>{Number(u.output_tokens).toLocaleString()}</td>
                          <td>{Number(u.reserved).toLocaleString()}</td>
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
              <Inspect
                title="Metric definitions and historical limits"
                value={d.definitions}
              />
            </>
          )}
        </>
      )}
    </div>
  );
}
