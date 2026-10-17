import { useEffect, useRef, useState, type PointerEvent } from "react";
import { api, useLoad } from "./request.js";
import { useAction } from "./useAction.js";
import { Field, Notice, type Row } from "./quality-ui.js";
import { LoadingState, PreviewDialog } from "./ui.js";
import { appLink, replaceCurrentRoute } from "./customer-ui.js";
import { useUnsavedChanges, confirmDiscardChanges } from "./unsaved-changes.js";
import { ReportChart, reportValue } from "./ReportCharts.js";
import {
  defaultReportFilters,
  REPORT_METRICS,
  type ReportFilter,
  type ReportWidget,
  type ReportQueryInput,
} from "../../../packages/platform/src/reporting-contracts.js";
import "./dashboards.css";

const dimensionName = (value: string) =>
  value.replaceAll("_", " ").replace(/^./, (c) => c.toUpperCase());
const json = (value: unknown) => JSON.stringify(value);
const starter = () => ({
  name: "Support overview",
  description: "Customer outcomes and the work waiting for your team.",
  visibility: "personal",
  revision: 0,
  definition: {
    filters: { ...defaultReportFilters },
    widgets: [
      {
        id: "volume",
        title: "Conversation volume",
        metric: "conversations",
        type: "kpi",
        groupBy: "none",
        overrides: {},
        restrictions: {},
        layout: { x: 0, y: 0, w: 3, h: 5 },
      },
      {
        id: "backlog",
        title: "Current open backlog",
        metric: "current_backlog",
        type: "kpi",
        groupBy: "none",
        overrides: {},
        restrictions: {},
        layout: { x: 3, y: 0, w: 3, h: 5 },
      },
      {
        id: "response",
        title: "First response",
        metric: "first_response_ms",
        type: "kpi",
        groupBy: "none",
        overrides: {},
        restrictions: {},
        layout: { x: 6, y: 0, w: 3, h: 5 },
      },
      {
        id: "csat",
        title: "Customer satisfaction",
        metric: "csat_good_rate",
        type: "kpi",
        groupBy: "none",
        overrides: {},
        restrictions: {},
        layout: { x: 9, y: 0, w: 3, h: 5 },
      },
      {
        id: "trend",
        title: "Conversation volume over time",
        metric: "conversations",
        type: "line",
        groupBy: "day",
        overrides: {},
        restrictions: {},
        layout: { x: 0, y: 5, w: 8, h: 7 },
      },
      {
        id: "channels",
        title: "Where requests arrive",
        metric: "conversations",
        type: "donut",
        groupBy: "channel",
        overrides: {},
        restrictions: {},
        layout: { x: 8, y: 5, w: 4, h: 7 },
      },
    ],
  },
});
const queryFor = (
  w: ReportWidget,
  filters: ReportFilter,
): ReportQueryInput => ({
  metric: w.metric,
  groupBy: w.groupBy,
  stackBy: w.stackBy,
  filters: { ...filters, ...w.overrides },
  restrictions: w.restrictions ?? {},
});
const overlaps = (a: ReportWidget["layout"], b: ReportWidget["layout"]) =>
  a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
export function settleWidgets(
  widgets: ReportWidget[],
  id: string,
  layout: ReportWidget["layout"],
) {
  const normalized = {
    ...layout,
    x: Math.max(0, Math.min(12 - layout.w, layout.x)),
    y: Math.max(0, Math.min(380, layout.y)),
    w: Math.max(2, Math.min(12, layout.w)),
    h: Math.max(3, Math.min(14, layout.h)),
  };
  normalized.x = Math.min(normalized.x, 12 - normalized.w);
  const placed: ReportWidget[] = [
    { ...widgets.find((w) => w.id === id)!, layout: normalized },
  ];
  for (const w of widgets
    .filter((w) => w.id !== id)
    .sort((a, b) => a.layout.y - b.layout.y || a.layout.x - b.layout.x)) {
    const next = { ...w, layout: { ...w.layout } };
    while (placed.some((p) => overlaps(p.layout, next.layout)))
      next.layout.y = Math.max(
        ...placed
          .filter((p) => overlaps(p.layout, next.layout))
          .map((p) => p.layout.y + p.layout.h),
      );
    placed.push(next);
  }
  return widgets.map((w) => placed.find((p) => p.id === w.id)!);
}

function Filters({
  value,
  onChange,
  catalog,
  disabled = false,
}: {
  value: ReportFilter;
  onChange: (v: ReportFilter) => void;
  catalog: Row;
  disabled?: boolean;
}) {
  const set = (key: string, v: any) => onChange({ ...value, [key]: v }),
    select = (
      key: "channels" | "organizationIds" | "teamIds" | "agentIds",
      title: string,
      options: Row[],
    ) => (
      <Field label={title}>
        <select
          disabled={disabled}
          value={value[key][0] ?? ""}
          onChange={(e) => set(key, e.target.value ? [e.target.value] : [])}
        >
          <option value="">All {title.toLowerCase()}s</option>
          {options.map((o) => (
            <option key={o.id} value={o.id}>
              {o.name}
            </option>
          ))}
        </select>
      </Field>
    );
  return (
    <div className="report-filters">
      <Field label="Date range">
        <select
          disabled={disabled}
          value={value.period}
          onChange={(e) =>
            onChange({
              ...value,
              period: e.target.value as ReportFilter["period"],
              ...(e.target.value === "custom"
                ? {
                    from:
                      new Date(Date.now() - 30 * 86400000)
                        .toISOString()
                        .slice(0, 10) + "T00:00:00.000Z",
                    to:
                      new Date(Date.now() + 86400000)
                        .toISOString()
                        .slice(0, 10) + "T00:00:00.000Z",
                  }
                : {}),
            })
          }
        >
          <option value="last7">Last 7 days</option>
          <option value="last30">Last 30 days</option>
          <option value="last90">Last 90 days</option>
          <option value="custom">Custom dates (UTC)</option>
        </select>
      </Field>
      {value.period === "custom" && (
        <>
          <Field label="From (UTC)">
            <input
              disabled={disabled}
              type="date"
              value={value.from?.slice(0, 10) ?? ""}
              onChange={(e) =>
                set(
                  "from",
                  e.target.value
                    ? e.target.value + "T00:00:00.000Z"
                    : undefined,
                )
              }
            />
          </Field>
          <Field label="Through (UTC)">
            <input
              disabled={disabled}
              type="date"
              value={
                value.to
                  ? new Date(Date.parse(value.to) - 86400000)
                      .toISOString()
                      .slice(0, 10)
                  : ""
              }
              onChange={(e) =>
                set(
                  "to",
                  e.target.value
                    ? new Date(
                        Date.parse(e.target.value) + 86400000,
                      ).toISOString()
                    : undefined,
                )
              }
            />
          </Field>
        </>
      )}
      {select(
        "channels",
        "Channel",
        ["portal", "email", "widget", "zendesk"].map((id) => ({
          id,
          name: dimensionName(id),
        })),
      )}
      {catalog.organizations.length > 0 &&
        select("organizationIds", "Organization", catalog.organizations)}
      {select("teamIds", "Team", catalog.teams)}
      {select("agentIds", "Agent", catalog.agents)}
      <label className="report-check">
        <input
          disabled={disabled}
          type="checkbox"
          checked={value.comparison}
          onChange={(e) => set("comparison", e.target.checked)}
        />
        Compare previous period
      </label>
      <details className="report-more-filters">
        <summary>
          More filters
          {value.statuses.length +
            value.priorities.length +
            value.tags.length +
            (value.query ? 1 : 0) >
          0
            ? " · active"
            : ""}
        </summary>
        <div>
          <Field label="Status">
            <select
              disabled={disabled}
              value={value.statuses[0] ?? ""}
              onChange={(e) =>
                set("statuses", e.target.value ? [e.target.value] : [])
              }
            >
              <option value="">All statuses</option>
              {["open", "needs_staff", "waiting_approval", "resolved"].map(
                (s) => (
                  <option key={s} value={s}>
                    {dimensionName(s)}
                  </option>
                ),
              )}
            </select>
          </Field>
          <Field label="Priority">
            <select
              disabled={disabled}
              value={value.priorities[0] ?? ""}
              onChange={(e) =>
                set("priorities", e.target.value ? [e.target.value] : [])
              }
            >
              <option value="">All priorities</option>
              {["low", "normal", "high", "urgent"].map((s) => (
                <option key={s} value={s}>
                  {dimensionName(s)}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Tags (comma separated)">
            <input
              disabled={disabled}
              value={value.tags.join(", ")}
              onChange={(e) =>
                set(
                  "tags",
                  e.target.value
                    .split(",")
                    .map((x) => x.trim())
                    .filter(Boolean),
                )
              }
            />
          </Field>
          <Field label="Find a subject or ticket ID">
            <input
              disabled={disabled}
              type="search"
              value={value.query}
              onChange={(e) => set("query", e.target.value)}
            />
          </Field>
        </div>
      </details>
    </div>
  );
}

function WidgetEditor({
  widget,
  filters,
  catalog,
  save,
  close,
}: {
  widget: ReportWidget;
  filters: ReportFilter;
  catalog: Row;
  save: (w: ReportWidget) => void;
  close: () => void;
}) {
  const [draft, setDraft] = useState(widget),
    [error, setError] = useState("");
  useUnsavedChanges(json(draft) !== json(widget));
  const metric = catalog.metrics.find((m: Row) => m.id === draft.metric),
    set = (patch: Partial<ReportWidget>) => setDraft({ ...draft, ...patch });
  return (
    <PreviewDialog
      title={widget.title ? "Configure widget" : "Add a widget"}
      close={close}
    >
      <form
        className="report-widget-editor"
        onSubmit={(e) => {
          e.preventDefault();
          if (!draft.title.trim()) {
            setError("Add a widget title.");
            return;
          }
          if (draft.type === "stacked_bar" && !draft.stackBy) {
            setError("Choose a series for your stacked bar chart.");
            return;
          }
          save(draft);
        }}
      >
        <Field label="Widget title">
          <input
            required
            maxLength={120}
            value={draft.title}
            onChange={(e) => set({ title: e.target.value })}
          />
        </Field>
        <Field label="Metric">
          <select
            value={draft.metric}
            onChange={(e) => {
              const m = catalog.metrics.find(
                (v: Row) => v.id === e.target.value,
              );
              set({
                metric: e.target.value as ReportWidget["metric"],
                title: draft.title === metric.label ? m.label : draft.title,
                groupBy: m.dimensions.includes(draft.groupBy)
                  ? draft.groupBy
                  : "none",
                stackBy: undefined,
                ...(["donut", "stacked_bar"].includes(draft.type) &&
                ["percent", "milliseconds"].includes(m.unit)
                  ? { type: "bar" as const }
                  : {}),
              });
            }}
          >
            {catalog.metrics.map((m: Row) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
        </Field>
        <p className="muted">{metric.description}</p>
        <div className="report-editor-grid">
          <Field label="Chart type">
            <select
              value={draft.type}
              onChange={(e) => {
                const type = e.target.value as ReportWidget["type"];
                set({
                  type,
                  groupBy:
                    type === "kpi"
                      ? "none"
                      : draft.groupBy === "none"
                        ? metric.dimensions.includes("day")
                          ? "day"
                          : "status"
                        : draft.groupBy,
                  stackBy:
                    type === "stacked_bar"
                      ? metric.dimensions.includes("channel")
                        ? "channel"
                        : "status"
                      : undefined,
                });
              }}
            >
              {[
                ["kpi", "Metric card"],
                ["line", "Line chart"],
                ["bar", "Bar chart"],
                ["stacked_bar", "Stacked bar chart"],
                ["donut", "Donut chart"],
                ["table", "Table"],
              ].map(([id, name]) => (
                <option
                  key={id}
                  value={id}
                  disabled={
                    ["donut", "stacked_bar"].includes(id) &&
                    ["percent", "milliseconds"].includes(metric.unit)
                  }
                >
                  {name}
                </option>
              ))}
            </select>
          </Field>
          {draft.type !== "kpi" && (
            <Field label="Group by">
              <select
                value={draft.groupBy}
                onChange={(e) =>
                  set({
                    groupBy: e.target.value as ReportWidget["groupBy"],
                    ...(e.target.value === draft.stackBy
                      ? { stackBy: undefined }
                      : {}),
                  })
                }
              >
                {metric.dimensions
                  .filter((d: string) => d !== "none" || draft.type === "table")
                  .map((d: string) => (
                    <option key={d} value={d}>
                      {dimensionName(d)}
                    </option>
                  ))}
              </select>
            </Field>
          )}
          {draft.type === "stacked_bar" && (
            <Field label="Series">
              <select
                required
                value={draft.stackBy ?? ""}
                onChange={(e) =>
                  set({ stackBy: e.target.value as ReportWidget["stackBy"] })
                }
              >
                <option value="">Choose series</option>
                {metric.dimensions
                  .filter((d: string) => d !== "none" && d !== draft.groupBy)
                  .map((d: string) => (
                    <option key={d} value={d}>
                      {dimensionName(d)}
                    </option>
                  ))}
              </select>
            </Field>
          )}
        </div>
        <details>
          <summary>
            Additional filters ·{" "}
            {Object.values(draft.restrictions ?? {}).some((v) => v?.length)
              ? "active"
              : "none"}
          </summary>
          <p>
            These narrow the dashboard filters. They never broaden the selected
            audience.
          </p>
          <div className="report-editor-grid">
            {Object.entries({
              channels: ["portal", "email", "widget", "zendesk"].map((id) => ({
                id,
                name: dimensionName(id),
              })),
              organizationIds: catalog.organizations,
              teamIds: catalog.teams,
              agentIds: catalog.agents,
              statuses: [
                "open",
                "needs_staff",
                "waiting_approval",
                "resolved",
              ].map((id) => ({ id, name: dimensionName(id) })),
              priorities: ["low", "normal", "high", "urgent"].map((id) => ({
                id,
                name: dimensionName(id),
              })),
            }).map(([key, options]) => (
              <Field
                key={key}
                label={`Additional ${dimensionName(key.replace("Ids", ""))}`}
              >
                <select
                  value={(draft.restrictions as Row)?.[key]?.[0] ?? ""}
                  onChange={(e) =>
                    set({
                      restrictions: {
                        ...draft.restrictions,
                        [key]: e.target.value ? [e.target.value] : [],
                      },
                    })
                  }
                >
                  <option value="">No additional restriction</option>
                  {(options as Row[]).map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.name}
                    </option>
                  ))}
                </select>
              </Field>
            ))}
          </div>
        </details>
        <details>
          <summary>
            Widget filter overrides ·{" "}
            {Object.keys(draft.overrides).length
              ? "active"
              : "using dashboard filters"}
          </summary>
          <p>
            Changed filters override this dashboard's filters for this widget.
            Use “Inherit all filters” to remove overrides.
          </p>
          <button type="button" onClick={() => set({ overrides: {} })}>
            Inherit all filters
          </button>
          <Filters
            value={{ ...filters, ...draft.overrides }}
            catalog={catalog}
            onChange={(value) => {
              const previous = { ...filters, ...draft.overrides },
                overrides = { ...draft.overrides };
              for (const k of Object.keys(value) as (keyof ReportFilter)[])
                if (json(value[k]) !== json(previous[k]))
                  (overrides as Row)[k] = value[k];
              set({ overrides });
            }}
          />
          {Object.keys(draft.overrides).length > 0 && (
            <div className="report-filter-tags">
              {Object.keys(draft.overrides).map((key) => (
                <button
                  type="button"
                  key={key}
                  onClick={() => {
                    const overrides = { ...draft.overrides };
                    delete (overrides as Row)[key];
                    set({ overrides });
                  }}
                >
                  {dimensionName(key)} override ×
                </button>
              ))}
            </div>
          )}
        </details>
        {error && <p role="alert">{error}</p>}
        <div className="report-actions">
          <button type="submit" className="primary">
            Apply widget
          </button>
          <button type="button" onClick={close}>
            Cancel
          </button>
        </div>
      </form>
    </PreviewDialog>
  );
}

function Drilldown({
  ws,
  query,
  selection,
  title,
  close,
  canExport,
  onExport,
}: {
  ws: string;
  query: ReportQueryInput;
  selection: Row;
  title: string;
  close: () => void;
  canExport: boolean;
  onExport: () => void;
}) {
  const [offset, setOffset] = useState(0),
    l = useLoad(
      () =>
        api(ws, "/reports/drilldown", { query, selection, offset, limit: 50 }),
      [ws, json(query), json(selection), offset],
    );
  return (
    <PreviewDialog title={title} close={close}>
      <div className="report-drilldown">
        <p>
          Contributing records for the same query. Ticket subjects and metadata
          are shown; messages and internal field values are excluded.
        </p>
        {l.loading && <LoadingState label="Loading report records…" />}
        {l.error && (
          <p role="alert">
            {l.error} <button onClick={l.reload}>Try again</button>
          </p>
        )}
        {l.data && (
          <>
            <p>
              <strong>{l.data.total.toLocaleString()}</strong> matching records
              · {offset + 1}–
              {Math.min(offset + l.data.rows.length, l.data.total)} shown
            </p>
            <div className="report-table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Ticket / record</th>
                    <th>Date (UTC)</th>
                    <th>Status</th>
                    <th>Team</th>
                    <th>Agent</th>
                    <th>Value</th>
                  </tr>
                </thead>
                <tbody>
                  {l.data.rows.map((r: Row) => (
                    <tr key={r.record_id}>
                      <td>
                        {r.ticket_id ? (
                          <a
                            onClick={appLink}
                            href={`/?workspace=${encodeURIComponent(ws)}&view=inbox&conversation=${encodeURIComponent(r.ticket_id)}`}
                          >
                            {r.subject || r.ticket_id}
                          </a>
                        ) : (
                          <span>Unattributed model call</span>
                        )}
                        <small>{r.record_id}</small>
                      </td>
                      <td>
                        {new Date(r.occurred_at).toLocaleString(undefined, {
                          timeZone: "UTC",
                        })}
                      </td>
                      <td>{r.status ? dimensionName(r.status) : "—"}</td>
                      <td>{r.team ?? "—"}</td>
                      <td>{r.agent ?? "—"}</td>
                      <td>
                        {reportValue(
                          l.data.metric.unit === "percent"
                            ? r.denominator
                              ? (100 * r.numerator) / r.denominator
                              : null
                            : r.numerator,
                          l.data.metric.unit,
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {!l.data.total && (
              <p>No contributing records match these filters.</p>
            )}
            <div className="report-actions">
              <button
                disabled={!offset || l.loading}
                onClick={() => setOffset(Math.max(0, offset - 50))}
              >
                Previous 50
              </button>
              <span>
                Page {Math.floor(offset / 50) + 1} of{" "}
                {Math.max(1, Math.ceil(l.data.total / 50))}
              </span>
              <button
                disabled={!l.data.hasMore || l.loading}
                onClick={() => setOffset(offset + 50)}
              >
                Next 50
              </button>
              {canExport && (
                <button onClick={onExport}>Export these records</button>
              )}
            </div>
          </>
        )}
      </div>
    </PreviewDialog>
  );
}

function ExportDialog({
  ws,
  query,
  selection,
  close,
  done,
}: {
  ws: string;
  query: ReportQueryInput;
  selection: Row;
  close: () => void;
  done: () => void;
}) {
  const [limit, setLimit] = useState(10000),
    [mode, setMode] = useState("rows"),
    a = useAction();
  return (
    <PreviewDialog
      title="Export report"
      close={() => {
        if (!a.busy) close();
      }}
    >
      <form
        className="report-widget-editor"
        onSubmit={(e) => {
          e.preventDefault();
          void a.run(async () => {
            await api(ws, "/reports/exports", {
              requestKey: crypto.randomUUID(),
              query,
              selection,
              mode,
              rowLimit: limit,
            });
            done();
          }, "Export queued");
        }}
      >
        <p>
          The export uses these exact filters. Downloads require your current
          staff access and expire after 24 hours.
        </p>
        <fieldset disabled={a.busy}>
          <Field label="Export contents">
            <select value={mode} onChange={(e) => setMode(e.target.value)}>
              <option value="rows">Contributing records</option>
              <option value="summary">Chart summary</option>
            </select>
          </Field>
          <Field label="Maximum exported rows">
            <input
              type="number"
              min={1}
              max={50000}
              required
              value={limit}
              onChange={(e) => setLimit(Number(e.target.value))}
            />
          </Field>
          <p className="muted">
            Up to 50,000 records. If more records match, the export is labeled
            truncated.
          </p>
        </fieldset>
        <Notice action={a} />
        <div className="report-actions">
          <button
            className="primary"
            disabled={a.busy || limit < 1 || limit > 50000}
          >
            {a.busy ? "Queuing…" : "Create CSV export"}
          </button>
          <button type="button" disabled={a.busy} onClick={close}>
            Cancel
          </button>
        </div>
      </form>
    </PreviewDialog>
  );
}

function ReportJobs({ ws, version }: { ws: string; version: number }) {
  const l = useLoad(() => api(ws, "/reports/jobs"), [ws, version]);
  useEffect(() => {
    if (!l.data?.some((j: Row) => ["queued", "running"].includes(j.status)))
      return;
    const timer = setInterval(l.reload, 3000);
    return () => clearInterval(timer);
  }, [l.data]);
  return (
    <section className="report-jobs">
      <h2>Recent reports & exports</h2>
      <p>
        Only your reports appear here. Files expire 24 hours after they are
        requested.
      </p>
      {l.error && <p role="alert">{l.error}</p>}
      {!l.data?.length && <p>No reports yet.</p>}
      {l.data?.map((j: Row) => (
        <div className="report-library-row" key={j.id}>
          <div>
            <strong>
              {j.kind === "csv" ? "CSV export" : "Scheduled dashboard"}
            </strong>
            <small>
              {new Date(j.created_at).toLocaleString()} ·{" "}
              {dimensionName(j.status)}
              {j.row_count !== null
                ? ` · ${j.row_count} ${j.kind === "csv" ? "rows" : "widgets"}`
                : ""}
              {j.truncated
                ? " · Truncated · narrow filters for all records"
                : ""}
            </small>
            {j.error && <p role="alert">{j.error}</p>}
            {j.mail_error && <p>{j.mail_error}</p>}
          </div>
          {j.status === "completed" &&
            new Date(j.expires_at) > new Date() &&
            (j.kind === "csv" ? (
              <a
                className="button"
                href={`/v2/workspaces/${ws}/reports/jobs/${j.id}/download`}
              >
                Download CSV
              </a>
            ) : (
              <a
                onClick={appLink}
                href={`/?workspace=${encodeURIComponent(ws)}&view=dashboards&report=${encodeURIComponent(j.id)}`}
              >
                Open report
              </a>
            ))}
        </div>
      ))}
    </section>
  );
}

function Schedules({
  ws,
  catalog,
  dashboard,
}: {
  ws: string;
  catalog: Row;
  dashboard: Row;
}) {
  const l = useLoad(() => api(ws, "/reports/schedules"), [ws]),
    a = useAction(),
    [draft, setDraft] = useState<Row | null>(null);
  useUnsavedChanges(!!draft);
  return (
    <section className="report-schedules">
      <div className="report-section-heading">
        <div>
          <h2>Scheduled reports</h2>
          <p>
            Send a report-ready link to current staff. Each recipient's access
            is checked when the report runs and when they open it.
          </p>
        </div>
        <button
          disabled={!dashboard.id || dashboard.visibility !== "workspace"}
          onClick={() =>
            setDraft({
              dashboardId: dashboard.id,
              revision: 0,
              enabled: true,
              definition: {
                frequency: "weekly",
                time: "09:00",
                weekday: 1,
                timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
                recipientIds: [catalog.userId],
              },
            })
          }
        >
          Schedule this dashboard
        </button>
      </div>
      {(!dashboard.id || dashboard.visibility !== "workspace") && (
        <p className="muted">Save a workspace dashboard to schedule it.</p>
      )}
      <Notice action={a} error={l.error} />
      {!l.data?.length && <p>No scheduled reports.</p>}
      {l.data?.map((s: Row) => (
        <div className="report-library-row" key={s.id}>
          <div>
            <strong>{s.dashboard_name}</strong>
            <small>
              {s.enabled ? "Active" : "Paused"} · {s.definition.frequency} at{" "}
              {s.definition.time} {s.definition.timeZone} ·{" "}
              {s.definition.recipientIds.length} recipients
            </small>
            <small>Next: {new Date(s.next_run_at).toLocaleString()}</small>
            {s.last_error && <p role="alert">{s.last_error}</p>}
          </div>
          <button
            onClick={() =>
              setDraft({
                id: s.id,
                dashboardId: s.dashboard_id,
                revision: s.revision,
                enabled: s.enabled,
                definition: s.definition,
              })
            }
          >
            Edit schedule
          </button>
          <button
            disabled={a.busy}
            onClick={() =>
              void a.run(
                async () => {
                  await api(
                    ws,
                    `/reports/schedules/${s.id}`,
                    {
                      dashboardId: s.dashboard_id,
                      revision: s.revision,
                      enabled: !s.enabled,
                      definition: s.definition,
                    },
                    "PUT",
                  );
                  l.reload();
                },
                s.enabled ? "Schedule paused" : "Schedule enabled",
              )
            }
          >
            {s.enabled ? "Pause" : "Resume"}
          </button>
          <button
            disabled={a.busy}
            onClick={() => {
              if (
                confirmDiscardChanges(
                  "Delete this report schedule and its generated report links?",
                )
              )
                void a.run(async () => {
                  await api(
                    ws,
                    `/reports/schedules/${s.id}?revision=${s.revision}`,
                    undefined,
                    "DELETE",
                  );
                  l.reload();
                }, "Schedule deleted");
            }}
          >
            Delete
          </button>
        </div>
      ))}
      {draft && (
        <PreviewDialog
          title="Report delivery schedule"
          close={() => {
            if (!a.busy) setDraft(null);
          }}
        >
          <form
            className="report-widget-editor"
            onSubmit={(e) => {
              e.preventDefault();
              const { id, ...payload } = draft;
              void a.run(async () => {
                await api(
                  ws,
                  id ? `/reports/schedules/${id}` : "/reports/schedules",
                  payload,
                  id ? "PUT" : "POST",
                );
                setDraft(null);
                l.reload();
              }, "Schedule saved");
            }}
          >
            <fieldset disabled={a.busy}>
              <div className="report-editor-grid">
                <Field label="Frequency">
                  <select
                    value={draft.definition.frequency}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        definition: {
                          ...draft.definition,
                          frequency: e.target.value,
                        },
                      })
                    }
                  >
                    <option value="daily">Daily</option>
                    <option value="weekly">Weekly</option>
                  </select>
                </Field>
                {draft.definition.frequency === "weekly" && (
                  <Field label="Day of week">
                    <select
                      value={draft.definition.weekday}
                      onChange={(e) =>
                        setDraft({
                          ...draft,
                          definition: {
                            ...draft.definition,
                            weekday: Number(e.target.value),
                          },
                        })
                      }
                    >
                      {[
                        "Monday",
                        "Tuesday",
                        "Wednesday",
                        "Thursday",
                        "Friday",
                        "Saturday",
                        "Sunday",
                      ].map((d, i) => (
                        <option key={d} value={i + 1}>
                          {d}
                        </option>
                      ))}
                    </select>
                  </Field>
                )}
                <Field label="Delivery time">
                  <input
                    type="time"
                    required
                    value={draft.definition.time}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        definition: {
                          ...draft.definition,
                          time: e.target.value,
                        },
                      })
                    }
                  />
                </Field>
                <Field label="Time zone">
                  <input
                    required
                    value={draft.definition.timeZone}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        definition: {
                          ...draft.definition,
                          timeZone: e.target.value,
                        },
                      })
                    }
                  />
                </Field>
              </div>
              <fieldset>
                <legend>Recipients</legend>
                <div className="report-recipients">
                  {(catalog.recipients ?? catalog.agents).map((m: Row) => (
                    <label key={m.id}>
                      <input
                        type="checkbox"
                        checked={draft.definition.recipientIds.includes(m.id)}
                        onChange={(e) =>
                          setDraft({
                            ...draft,
                            definition: {
                              ...draft.definition,
                              recipientIds: e.target.checked
                                ? [...draft.definition.recipientIds, m.id]
                                : draft.definition.recipientIds.filter(
                                    (id: string) => id !== m.id,
                                  ),
                            },
                          })
                        }
                      />
                      {m.name || m.id}
                    </label>
                  ))}
                </div>
              </fieldset>
              <label className="report-check">
                <input
                  type="checkbox"
                  checked={draft.enabled}
                  onChange={(e) =>
                    setDraft({ ...draft, enabled: e.target.checked })
                  }
                />
                Schedule enabled
              </label>
            </fieldset>
            <Notice action={a} />
            <div className="report-actions">
              <button
                className="primary"
                disabled={a.busy || !draft.definition.recipientIds.length}
              >
                Save schedule
              </button>
              <button
                type="button"
                disabled={a.busy}
                onClick={() => setDraft(null)}
              >
                Cancel
              </button>
            </div>
          </form>
        </PreviewDialog>
      )}
    </section>
  );
}

export function DashboardPage({ ws }: { ws: string }) {
  const catalog = useLoad(() => api(ws, "/reports/catalog"), [ws]),
    a = useAction(),
    [selected, setSelected] = useState(
      () => new URLSearchParams(location.search).get("dashboard") ?? "",
    ),
    [reportId, setReportId] = useState(
      () => new URLSearchParams(location.search).get("report") ?? "",
    ),
    saved = useLoad(
      () =>
        selected ? api(ws, `/dashboards/${selected}`) : Promise.resolve(null),
      [ws, selected],
    ),
    snapshot = useLoad(
      () =>
        reportId
          ? api(ws, `/reports/jobs/${reportId}?artifact=true`)
          : Promise.resolve(null),
      [ws, reportId],
    );
  const [draft, setDraft] = useState<Row>(starter),
    [baseline, setBaseline] = useState(() => json(starter())),
    [editing, setEditing] = useState(false),
    [filters, setFilters] = useState<ReportFilter>({ ...defaultReportFilters }),
    [widgetEditor, setWidgetEditor] = useState<ReportWidget | null>(null),
    [drill, setDrill] = useState<Row | null>(null),
    [exporting, setExporting] = useState<Row | null>(null),
    [tab, setTab] = useState("dashboard"),
    [jobsVersion, setJobsVersion] = useState(0),
    [announcement, setAnnouncement] = useState("");
  const grid = useRef<HTMLDivElement>(null),
    gesture = useRef<Row | null>(null),
    dirty = editing && json(draft) !== baseline;
  useUnsavedChanges(dirty);
  useEffect(() => {
    if (saved.data) {
      setDraft(saved.data);
      setBaseline(json(saved.data));
      setFilters(saved.data.definition.filters);
      setEditing(false);
    }
  }, [saved.data]);
  const active = snapshot.data?.artifact
      ? {
          ...snapshot.data.artifact,
          definition: snapshot.data.artifact.definition,
        }
      : draft,
    widgets: ReportWidget[] = [...active.definition.widgets].sort(
      (a, b) => a.layout.y - b.layout.y || a.layout.x - b.layout.x,
    ),
    activeFilters = reportId
      ? active.definition.filters
      : editing
        ? draft.definition.filters
        : filters;
  const requestQueries = widgets.map((w) => ({
      id: w.id,
      query: queryFor(w, activeFilters),
    })),
    results = useLoad(
      () =>
        reportId
          ? Promise.resolve({ results: {} })
          : api(ws, "/reports/queries", { queries: requestQueries }),
      [ws, reportId, json(requestQueries)],
    ),
    data = reportId ? snapshot.data?.artifact?.results : results.data?.results;
  const route = (id: string, report = "") => {
    const url = new URL(location.href);
    url.searchParams.set("view", "dashboards");
    id
      ? url.searchParams.set("dashboard", id)
      : url.searchParams.delete("dashboard");
    report
      ? url.searchParams.set("report", report)
      : url.searchParams.delete("report");
    replaceCurrentRoute(url.pathname + url.search);
  };
  const select = (id: string) => {
    if (dirty && !confirmDiscardChanges()) return;
    setSelected(id);
    setReportId("");
    setEditing(false);
    route(id);
    if (!id) {
      const next = starter();
      setDraft(next);
      setBaseline(json(next));
      setFilters(next.definition.filters);
    }
  };
  const changeWidgets = (next: ReportWidget[]) =>
    setDraft((v: Row) => ({
      ...v,
      definition: { ...v.definition, widgets: next },
    }));
  const move = (id: string, patch: Partial<ReportWidget["layout"]>) => {
    const widget = widgets.find((w) => w.id === id)!;
    changeWidgets(settleWidgets(widgets, id, { ...widget.layout, ...patch }));
    setAnnouncement(
      `${widget.title}: column ${(patch.x ?? widget.layout.x) + 1}, row ${(patch.y ?? widget.layout.y) + 1}, width ${patch.w ?? widget.layout.w}`,
    );
  };
  const begin = (
    event: PointerEvent<HTMLButtonElement>,
    widget: ReportWidget,
    resize = false,
  ) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    gesture.current = {
      id: widget.id,
      startX: event.clientX,
      startY: event.clientY,
      layout: widget.layout,
      widgets: structuredClone(widgets),
      width: (grid.current?.clientWidth ?? 1200) / 12,
      resize,
    };
  };
  const drag = (event: PointerEvent<HTMLButtonElement>) => {
    const g = gesture.current;
    if (!g) return;
    const dx = Math.round((event.clientX - g.startX) / g.width),
      dy = Math.round((event.clientY - g.startY) / 48),
      layout = g.resize
        ? {
            ...g.layout,
            w: Math.max(2, Math.min(12 - g.layout.x, g.layout.w + dx)),
            h: Math.max(3, Math.min(14, g.layout.h + dy)),
          }
        : { ...g.layout, x: g.layout.x + dx, y: g.layout.y + dy };
    changeWidgets(settleWidgets(g.widgets, g.id, layout));
  };
  const end = () => {
    if (gesture.current)
      setAnnouncement(
        "Widget layout updated. Save dashboard to keep these changes.",
      );
    gesture.current = null;
  };
  const save = () =>
    void a.run(async () => {
      const value = await api(
        ws,
        draft.id ? `/dashboards/${draft.id}` : "/dashboards",
        {
          name: draft.name,
          description: draft.description,
          visibility: draft.visibility,
          revision: draft.revision,
          definition: draft.definition,
        },
        draft.id ? "PUT" : "POST",
      );
      setDraft(value);
      setBaseline(json(value));
      setFilters(value.definition.filters);
      setEditing(false);
      setSelected(value.id);
      route(value.id);
      catalog.reload();
    }, "Dashboard saved");
  if (catalog.loading && !catalog.data)
    return <LoadingState label="Loading dashboards…" />;
  if (catalog.error)
    return (
      <div className="quality-page">
        <h1>Dashboards</h1>
        <p role="alert">{catalog.error}</p>
        <button onClick={catalog.reload}>Try again</button>
      </div>
    );
  const canEdit =
    !reportId &&
    (!draft.id ||
      draft.visibility === "personal" ||
      catalog.data.permissions.shared);
  return (
    <div className="quality-page dashboard-page">
      <header className="report-page-header">
        <div>
          <span className="eyebrow">SUPPORT REPORTING</span>
          <h1>Dashboards</h1>
          <p>A shared view of outcomes, response times and the work ahead.</p>
        </div>
        <div className="report-actions">
          <button
            disabled={a.busy}
            onClick={() => {
              if (dirty && !confirmDiscardChanges()) return;
              const next = starter();
              next.name = "Untitled dashboard";
              setDraft(next);
              setBaseline("");
              setSelected("");
              setReportId("");
              setEditing(true);
              setTab("dashboard");
              route("");
            }}
          >
            New dashboard
          </button>
          {!editing && !reportId && draft.id && (
            <button
              onClick={() =>
                void a.run(async () => {
                  const copy = await api(
                    ws,
                    `/dashboards/${draft.id}/duplicate`,
                    {},
                  );
                  setDraft(copy);
                  setBaseline(json(copy));
                  setSelected(copy.id);
                  setFilters(copy.definition.filters);
                  setEditing(true);
                  route(copy.id);
                  catalog.reload();
                }, "Dashboard duplicated")
              }
            >
              Duplicate
            </button>
          )}
        </div>
      </header>
      <Notice action={a} error={saved.error || snapshot.error} />
      <div className="report-navigation">
        <Field label="Dashboard">
          <select
            value={reportId ? "report" : selected}
            disabled={a.busy}
            onChange={(e) => select(e.target.value)}
          >
            {reportId && (
              <option value="report">Scheduled report snapshot</option>
            )}
            <option value="">Starter overview</option>
            {catalog.data.dashboards.map((d: Row) => (
              <option key={d.id} value={d.id}>
                {d.name} ·{" "}
                {d.visibility === "workspace" ? "Workspace" : "Personal"}
              </option>
            ))}
          </select>
        </Field>
        <div
          className="report-tabs"
          role="group"
          aria-label="Reporting sections"
        >
          {[
            ["dashboard", "Dashboard"],
            ["exports", "Reports & exports"],
            ...(catalog.data.permissions.schedule
              ? [["schedules", "Schedules"]]
              : []),
          ].map(([id, label]) => (
            <button
              key={id}
              aria-pressed={tab === id}
              onClick={() => setTab(id)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      {tab === "exports" ? (
        <ReportJobs ws={ws} version={jobsVersion} />
      ) : tab === "schedules" ? (
        <Schedules ws={ws} catalog={catalog.data} dashboard={draft} />
      ) : (
        <>
          <div className="report-title-row">
            <div>
              {editing ? (
                <>
                  <Field label="Dashboard name">
                    <input
                      disabled={a.busy}
                      maxLength={120}
                      required
                      value={draft.name}
                      onChange={(e) =>
                        setDraft({ ...draft, name: e.target.value })
                      }
                    />
                  </Field>
                  <Field label="Description">
                    <input
                      disabled={a.busy}
                      maxLength={500}
                      value={draft.description}
                      onChange={(e) =>
                        setDraft({ ...draft, description: e.target.value })
                      }
                    />
                  </Field>
                </>
              ) : (
                <>
                  <h2>{active.name}</h2>
                  <p>{active.description ?? "Saved report snapshot"}</p>
                </>
              )}
            </div>
            <div className="report-actions">
              {editing ? (
                <>
                  <Field label="Visibility">
                    <select
                      disabled={a.busy}
                      value={draft.visibility}
                      onChange={(e) =>
                        setDraft({ ...draft, visibility: e.target.value })
                      }
                    >
                      <option value="personal">Personal</option>
                      {catalog.data.permissions.shared && (
                        <option value="workspace">Workspace</option>
                      )}
                    </select>
                  </Field>
                  <button
                    className="primary"
                    disabled={a.busy || !draft.name.trim()}
                    onClick={save}
                  >
                    {a.busy ? "Saving…" : "Save dashboard"}
                  </button>
                  <button
                    disabled={a.busy}
                    onClick={() => {
                      const next = baseline ? JSON.parse(baseline) : starter();
                      setDraft(next);
                      setBaseline(json(next));
                      setEditing(false);
                    }}
                  >
                    Discard
                  </button>
                </>
              ) : canEdit ? (
                <button className="primary" onClick={() => setEditing(true)}>
                  {draft.id ? "Edit dashboard" : "Save as dashboard"}
                </button>
              ) : null}
              {!reportId && (
                <button disabled={results.loading} onClick={results.reload}>
                  Refresh
                </button>
              )}
              {!editing && draft.id && canEdit && (
                <button
                  onClick={() => {
                    if (
                      confirmDiscardChanges(
                        "Delete this dashboard and its schedules?",
                      )
                    )
                      void a.run(async () => {
                        await api(
                          ws,
                          `/dashboards/${draft.id}?revision=${draft.revision}`,
                          undefined,
                          "DELETE",
                        );
                        select("");
                        catalog.reload();
                      }, "Dashboard deleted");
                  }}
                >
                  Delete
                </button>
              )}
            </div>
          </div>
          {reportId ? (
            <p className="report-snapshot">
              Saved{" "}
              {snapshot.data?.artifact?.asOf
                ? new Date(snapshot.data.artifact.asOf).toLocaleString()
                : ""}{" "}
              · This snapshot expires{" "}
              {snapshot.data?.expires_at
                ? new Date(snapshot.data.expires_at).toLocaleString()
                : ""}
              .{" "}
              <button onClick={() => select(snapshot.data?.dashboard_id ?? "")}>
                Open live dashboard
              </button>
            </p>
          ) : (
            <Filters
              value={activeFilters}
              catalog={catalog.data}
              disabled={a.busy}
              onChange={(value) =>
                editing
                  ? setDraft({
                      ...draft,
                      definition: { ...draft.definition, filters: value },
                    })
                  : setFilters(value)
              }
            />
          )}
          <div className="report-status-row">
            <p className="muted">
              {reportId
                ? "Read-only snapshot"
                : editing
                  ? "Drag widget handles to move; drag the corner to resize. Arrow keys move; Shift + arrows resize. Save to keep changes."
                  : "Select a chart value to inspect its contributing records. Dates use UTC; outcomes reflect retained history through now."}
            </p>
            {editing && (
              <button
                disabled={a.busy || widgets.length >= 24}
                onClick={() =>
                  setWidgetEditor({
                    id: crypto.randomUUID(),
                    title: "Conversation volume",
                    metric: "conversations",
                    type: "kpi",
                    groupBy: "none",
                    overrides: {},
                    restrictions: {},
                    layout: {
                      x: 0,
                      y: Math.max(
                        0,
                        ...widgets.map((w) => w.layout.y + w.layout.h),
                      ),
                      w: 4,
                      h: 5,
                    },
                  })
                }
              >
                Add widget
              </button>
            )}
          </div>
          <p className="sr-only" role="status" aria-live="polite">
            {announcement}
          </p>
          {results.error && !reportId && (
            <p role="alert">
              {results.error}{" "}
              <button onClick={results.reload}>Retry reports</button>
            </p>
          )}
          {((results.loading && !results.data && !reportId) ||
            (reportId && snapshot.loading)) && (
            <LoadingState label="Calculating report metrics…" />
          )}
          <div
            ref={grid}
            inert={a.busy}
            className={`report-grid ${editing ? "is-editing" : ""}`}
          >
            {widgets.map((w) => (
              <section
                className="report-widget"
                key={w.id}
                aria-label={w.title}
                style={{
                  gridColumn: `${w.layout.x + 1} / span ${w.layout.w}`,
                  gridRow: `${w.layout.y + 1} / span ${w.layout.h}`,
                }}
              >
                <header>
                  {editing && (
                    <button
                      className="report-drag-handle"
                      aria-label={`Move ${w.title}. Arrow keys move; Shift arrow keys resize.`}
                      onPointerDown={(e) => begin(e, w)}
                      onPointerMove={drag}
                      onPointerUp={end}
                      onPointerCancel={end}
                      onKeyDown={(e) => {
                        const deltas: Row = {
                          ArrowLeft: [-1, 0],
                          ArrowRight: [1, 0],
                          ArrowUp: [0, -1],
                          ArrowDown: [0, 1],
                        };
                        if (!deltas[e.key]) return;
                        e.preventDefault();
                        const [x, y] = deltas[e.key];
                        move(
                          w.id,
                          e.shiftKey
                            ? {
                                w: Math.max(
                                  2,
                                  Math.min(12 - w.layout.x, w.layout.w + x),
                                ),
                                h: Math.max(3, Math.min(14, w.layout.h + y)),
                              }
                            : { x: w.layout.x + x, y: w.layout.y + y },
                        );
                      }}
                    >
                      ⠿
                    </button>
                  )}
                  <h3>{w.title}</h3>
                  {editing ? (
                    <div>
                      <button
                        aria-label={`Configure ${w.title}`}
                        onClick={() => setWidgetEditor(w)}
                      >
                        Edit
                      </button>
                      <button
                        aria-label={`Remove ${w.title}`}
                        onClick={() =>
                          changeWidgets(widgets.filter((v) => v.id !== w.id))
                        }
                      >
                        ×
                      </button>
                    </div>
                  ) : !reportId && catalog.data.permissions.export ? (
                    <button
                      aria-label={`Export ${w.title}`}
                      onClick={() =>
                        setExporting({
                          query:
                            data?.[w.id]?.query ?? queryFor(w, activeFilters),
                          selection: {},
                        })
                      }
                    >
                      ↓
                    </button>
                  ) : null}
                </header>
                {Object.values(w.restrictions ?? {}).some((v) => v?.length) && (
                  <p className="report-override">
                    Additional filters:{" "}
                    {Object.entries(w.restrictions ?? {})
                      .filter(([, v]) => v?.length)
                      .map(([key]) => dimensionName(key))
                      .join(", ")}
                  </p>
                )}
                {Object.keys(w.overrides).length > 0 && (
                  <p className="report-override">
                    Overrides:{" "}
                    {Object.keys(w.overrides).map(dimensionName).join(", ")}
                  </p>
                )}
                <div className="report-widget-body">
                  {data?.[w.id] ? (
                    <ReportChart
                      widget={w}
                      result={data[w.id]}
                      inspect={(selection) =>
                        setDrill({
                          title: w.title,
                          query: data[w.id].query ?? queryFor(w, activeFilters),
                          selection: selection ?? {},
                        })
                      }
                    />
                  ) : (
                    <p className="muted">
                      {results.error
                        ? "Unable to load this widget."
                        : "Loading metric…"}
                    </p>
                  )}
                </div>
                <details className="report-definition">
                  <summary>Metric definition</summary>
                  <p>
                    {REPORT_METRICS.find((m) => m.id === w.metric)?.description}
                  </p>
                  {data?.[w.id]?.truncatedGroups && (
                    <p>
                      Showing the first 100 groups. Narrow the filters to see
                      the remaining groups; totals include all records.
                    </p>
                  )}
                </details>
                {editing && (
                  <button
                    className="report-resize-handle"
                    aria-label={`Resize ${w.title}`}
                    onPointerDown={(e) => begin(e, w, true)}
                    onPointerMove={drag}
                    onPointerUp={end}
                    onPointerCancel={end}
                    onKeyDown={(e) => {
                      if (!e.key.startsWith("Arrow")) return;
                      e.preventDefault();
                      move(w.id, {
                        w: Math.max(
                          2,
                          Math.min(
                            12 - w.layout.x,
                            w.layout.w +
                              (e.key === "ArrowRight"
                                ? 1
                                : e.key === "ArrowLeft"
                                  ? -1
                                  : 0),
                          ),
                        ),
                        h: Math.max(
                          3,
                          Math.min(
                            14,
                            w.layout.h +
                              (e.key === "ArrowDown"
                                ? 1
                                : e.key === "ArrowUp"
                                  ? -1
                                  : 0),
                          ),
                        ),
                      });
                    }}
                  >
                    ◢
                  </button>
                )}
              </section>
            ))}
          </div>
          {!widgets.length && (
            <div className="quality-empty">
              <h3>Your dashboard starts here</h3>
              <p>
                Add a metric card or chart, then arrange it for your team's
                work.
              </p>
            </div>
          )}
        </>
      )}
      {widgetEditor && (
        <WidgetEditor
          widget={widgetEditor}
          filters={activeFilters}
          catalog={catalog.data}
          close={() => setWidgetEditor(null)}
          save={(w) => {
            const exists = widgets.some((v) => v.id === w.id);
            changeWidgets(
              exists
                ? widgets.map((v) => (v.id === w.id ? w : v))
                : [...widgets, w],
            );
            setWidgetEditor(null);
          }}
        />
      )}
      {drill && (
        <Drilldown
          ws={ws}
          query={drill.query}
          selection={drill.selection}
          title={drill.title}
          close={() => setDrill(null)}
          canExport={catalog.data.permissions.export && !reportId}
          onExport={() => {
            setExporting({ query: drill.query, selection: drill.selection });
            setDrill(null);
          }}
        />
      )}
      {exporting && (
        <ExportDialog
          ws={ws}
          query={exporting.query}
          selection={exporting.selection}
          close={() => setExporting(null)}
          done={() => {
            setExporting(null);
            setJobsVersion((v) => v + 1);
            setTab("exports");
          }}
        />
      )}
    </div>
  );
}
