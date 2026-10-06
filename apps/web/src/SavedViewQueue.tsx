import { useState } from "react";
import { api, useLoad } from "./request.js";
import { Pagination } from "./customer-ui.js";
import type { Row } from "./quality-ui.js";
import "./productivity.css";
export function SavedViewQueue({
  ws,
  viewId,
  onSelect,
  selected,
  version,
}: {
  ws: string;
  viewId: string;
  onSelect: (c: Row) => void;
  selected: string;
  version: number;
}) {
  const [page, setPage] = useState(1),
    [query, setQuery] = useState("");
  const l = useLoad(
    () =>
      api(
        ws,
        `/saved-views/${viewId}/results?${new URLSearchParams({ page: String(page), q: query })}`,
      ),
    [ws, viewId, page, query, version],
  );
  const value = (row: Row, column: string) => {
    if (column.startsWith("field.")) {
      const id = column.slice(6),
        v = row.fields?.[id],
        field = l.data?.fieldColumns?.find((f: Row) => f.id === id);
      const label = (id: string) =>
        field?.options.find((o: Row) => o.id === id)?.label ?? id;
      return Array.isArray(v)
        ? v.map(label).join(", ")
        : field?.type === "select"
          ? label(v)
          : v === true
            ? "Yes"
            : v === false
              ? "No"
              : String(v ?? "Not provided");
    }
    return (
      (
        {
          customer: row.customer_name || "Visitor",
          assignee: row.assignee_name || "Unassigned",
          team: row.team_name || "No team",
          form: row.form_name || "General support",
          channel: row.channel_kind,
          tags: (row.tags ?? []).join(", ") || "No tags",
          created: new Date(row.created_at).toLocaleDateString(),
          updated: new Date(row.updated_at).toLocaleString(),
          sla: row.sla_due
            ? new Date(row.sla_due).toLocaleString()
            : "No active deadline",
        } as Row
      )[column] ??
      row[column] ??
      "—"
    );
  };
  return (
    <>
      <label className="saved-view-search">
        Search this view
        <input
          type="search"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setPage(1);
          }}
        />
      </label>
      {l.error && (
        <p className="alert" role="alert">
          {l.error}
          <button onClick={l.reload}>Try again</button>
        </p>
      )}
      {l.loading && !l.data && <p role="status">Loading saved view…</p>}
      {l.data && (
        <>
          <div className="saved-view-caption">
            <strong>{l.data.view.name}</strong>
            <span>{l.data.total} conversations</span>
            <button onClick={l.reload}>Refresh</button>
          </div>
          <div className="conversation-items">
            {l.data.conversations.map((row: Row) => (
              <button
                key={row.id}
                className="saved-view-ticket"
                aria-current={selected === row.id ? "true" : undefined}
                onClick={() => onSelect(row)}
              >
                <h3>{row.subject}</h3>
                <dl>
                  {l.data.view.columns
                    .filter((c: string) => c !== "subject")
                    .map((column: string) => (
                      <div key={column}>
                        <dt>
                          {l.data.fieldColumns?.find(
                            (f: Row) => `field.${f.id}` === column,
                          )?.label ?? column}
                        </dt>
                        <dd>{value(row, column)}</dd>
                      </div>
                    ))}
                </dl>
              </button>
            ))}
          </div>
          {!l.data.conversations.length && (
            <div className="empty">
              <h3>No matching conversations</h3>
              <p>
                This view only includes tickets you currently have permission to
                read.
              </p>
            </div>
          )}
          <Pagination
            page={page}
            total={l.data.total}
            size={40}
            onChange={setPage}
            label="Saved view"
          />
        </>
      )}
    </>
  );
}
