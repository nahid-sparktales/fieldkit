import { useRef, useState } from "react";
import { api, useLoad } from "./request.js";
import { useAction } from "./useAction.js";
import { LoadingState } from "./ui.js";
import { ReadinessLink } from "./ReadinessLink.js";
import "./activity.css";

type Row = Record<string, any>;
type Section = "operations" | "background" | "audit";
const PAGE_SIZE = 20;
const words = (value: unknown) => String(value ?? "").replace(/[._-]/g, " ");
const jobName = (name: string) =>
  (
    ({
      ingest: "Knowledge import",
      delivery: "Customer reply delivery",
    }) as Record<string, string>
  )[name] ?? words(name);
const timestamp = (row: Row) => row.created_at ?? row.created_on;
const conversationId = (row: Row) =>
  row.conversation_id ?? row.data?.conversationId ?? row.data?.conversation_id;

export function ActivityPage({ ws, admin }: { ws: string; admin: boolean }) {
  const load = useLoad(async () => {
    const [operations, background, audit, members] = await Promise.all([
      api(ws, "/operations"),
      admin ? api(ws, "/operations/jobs") : {},
      admin ? api(ws, "/audit") : {},
      admin ? api(ws, "/members") : {},
    ]);
    return { ...operations, ...background, ...audit, ...members };
  }, [ws, admin]);
  const action = useAction();
  const [section, setSection] = useState<Section | null>(null);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [page, setPage] = useState(1);
  const sectionHeading = useRef<HTMLHeadingElement>(null);
  const changePage = (next: number) => {
    setPage(next);
    requestAnimationFrame(() => {
      sectionHeading.current?.focus({ preventScroll: true });
      sectionHeading.current?.scrollIntoView({ block: "start" });
    });
  };
  const operations: Row[] = load.data?.operations ?? [];
  const background: Row[] = [
    ...(load.data?.jobs ?? []).map((row: Row) => ({
      ...row,
      recordType: "job",
    })),
    ...(load.data?.deliveries ?? []).map((row: Row) => ({
      ...row,
      recordType: "delivery",
    })),
  ].sort(
    (a, b) =>
      new Date(timestamp(b) ?? 0).getTime() -
      new Date(timestamp(a) ?? 0).getTime(),
  );
  const events: Row[] = load.data?.events ?? [];
  const active =
    section ?? (admin && background.length ? "background" : "operations");
  const allRows =
    active === "background"
      ? background
      : active === "audit"
        ? events
        : operations;
  const rowStatus = (row: Row) =>
    active === "audit" ? row.kind : (row.status ?? row.state);
  const statuses = [...new Set(allRows.map(rowStatus).filter(Boolean))].sort();
  const names = Object.fromEntries(
    (load.data?.members ?? []).map((member: Row) => [
      member.user_id,
      member.name || member.email,
    ]),
  );
  const filtered = allRows.filter((row) => {
    const day = timestamp(row)
      ? new Date(timestamp(row)).toLocaleDateString("en-CA")
      : "";
    const searchable = [JSON.stringify(row), names[row.data?.actor] ?? ""]
      .join(" ")
      .toLowerCase();
    return (
      (!filter || rowStatus(row) === filter) &&
      (!search.trim() || searchable.includes(search.trim().toLowerCase())) &&
      (!from || (!!day && day >= from)) &&
      (!to || (!!day && day <= to))
    );
  });
  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const visible = filtered.slice(
    (currentPage - 1) * PAGE_SIZE,
    currentPage * PAGE_SIZE,
  );
  const selectSection = (next: Section) => {
    setSection(next);
    setSearch("");
    setFilter("");
    setFrom("");
    setTo("");
    setPage(1);
  };
  const reset = () => {
    setSearch("");
    setFilter("");
    setFrom("");
    setTo("");
    setPage(1);
  };
  return (
    <div className="activity-page">
      <div className="page-heading">
        <div>
          <span className="eyebrow">A CLEAR RECORD</span>
          <h1>Activity</h1>
          <p>Find customer actions, background work, and workspace changes.</p>
        </div>
        <button disabled={load.loading} onClick={load.reload}>
          Refresh
        </button>
      </div>
      <ReadinessLink ws={ws} />
      {(load.error || action.error) && (
        <div className="alert" role="alert">
          {load.error || action.error}
          {load.error && <button onClick={load.reload}>Try again</button>}
        </div>
      )}
      {action.success && (
        <p className="success" role="status">
          {action.success}
        </p>
      )}
      {load.loading && !load.data && <LoadingState label="Loading activity…" />}
      {load.data && (
        <>
          {load.error && (
            <p role="status">
              Showing the last loaded activity. Refresh to get current results.
            </p>
          )}
          <div
            className="activity-sections"
            role="group"
            aria-label="Activity sections"
          >
            <button
              aria-pressed={active === "operations"}
              onClick={() => selectSection("operations")}
            >
              Account operations <span>{operations.length}</span>
            </button>
            {admin && (
              <>
                <button
                  aria-pressed={active === "background"}
                  onClick={() => selectSection("background")}
                >
                  Background work <span>{background.length}</span>
                </button>
                <button
                  aria-pressed={active === "audit"}
                  onClick={() => selectSection("audit")}
                >
                  Audit history <span>{events.length}</span>
                </button>
              </>
            )}
          </div>
          <section className="panel" aria-labelledby="activity-section-title">
            <h2 id="activity-section-title" ref={sectionHeading} tabIndex={-1}>
              {active === "audit"
                ? "Audit history"
                : active === "background"
                  ? "Background work requiring attention"
                  : "Account operations"}
            </h2>
            <p className="muted">
              {active === "audit"
                ? "Search the latest 300 recorded workspace changes."
                : active === "background"
                  ? "Search up to 100 recent jobs needing attention and 100 undelivered replies."
                  : "Search recorded account actions and their confirmed outcomes."}
            </p>
            <div className="activity-filters">
              <label className="activity-search">
                Search activity
                <input
                  type="search"
                  value={search}
                  onChange={(e) => {
                    setSearch(e.target.value);
                    setPage(1);
                  }}
                  placeholder={
                    active === "audit"
                      ? "Action, person, or resource…"
                      : "Source, conversation, or error…"
                  }
                />
              </label>
              <label>
                {active === "audit" ? "Event type" : "Status"}
                <select
                  aria-label={active === "audit" ? "Event type" : "Status"}
                  value={filter}
                  onChange={(e) => {
                    setFilter(e.target.value);
                    setPage(1);
                  }}
                >
                  <option value="">
                    {active === "audit" ? "All event types" : "All statuses"}
                  </option>
                  {statuses.map((status) => (
                    <option key={status} value={status}>
                      {words(status)}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                From date
                <input
                  type="date"
                  value={from}
                  max={to || undefined}
                  onChange={(e) => {
                    setFrom(e.target.value);
                    setPage(1);
                  }}
                />
              </label>
              <label>
                To date
                <input
                  type="date"
                  value={to}
                  min={from || undefined}
                  onChange={(e) => {
                    setTo(e.target.value);
                    setPage(1);
                  }}
                />
              </label>
            </div>
            {(search || filter || from || to) && (
              <button className="activity-clear" onClick={reset}>
                Clear filters
              </button>
            )}
            <p className="activity-count" role="status">
              {filtered.length
                ? `Showing ${(currentPage - 1) * PAGE_SIZE + 1}–${Math.min(currentPage * PAGE_SIZE, filtered.length)} of ${filtered.length}`
                : "No matching records"}
            </p>
            {!visible.length && (
              <div className="activity-empty">
                <h3>
                  {allRows.length
                    ? "No activity matches your filters"
                    : active === "background"
                      ? "No background work needs attention"
                      : active === "audit"
                        ? "No workspace changes recorded yet"
                        : "Every action will leave a record"}
                </h3>
                <p>
                  {allRows.length
                    ? "Try a different search or clear the filters."
                    : active === "operations"
                      ? "Receipts appear here when an approved account action runs."
                      : "New records will appear here as your workspace is used."}
                </p>
              </div>
            )}
            <div className="activity-records">
              {visible.map((row: Row) => {
                const status = rowStatus(row);
                const id = conversationId(row);
                const actor = row.data?.actor ?? row.data?.actorId;
                const title =
                  active === "audit"
                    ? words(row.kind)
                    : active === "background"
                      ? row.recordType === "job"
                        ? jobName(row.name)
                        : "Customer reply delivery"
                      : words(
                          row.resource || row.action_id || "Account action",
                        );
                return (
                  <article
                    className="activity-record"
                    key={`${row.recordType ?? active}:${row.id}`}
                  >
                    <div className="activity-record-heading">
                      <h3>{title}</h3>
                      {active !== "audit" && (
                        <span
                          className={`badge ${["failed", "unknown"].includes(status) ? "bad" : "neutral"}`}
                        >
                          {words(status)}
                        </span>
                      )}
                    </div>
                    <div className="activity-meta">
                      {timestamp(row) && (
                        <time dateTime={timestamp(row)}>
                          {new Date(timestamp(row)).toLocaleString()}
                        </time>
                      )}
                      {actor && <span>By {names[actor] ?? actor}</span>}
                      {row.source_title && (
                        <a href={`/?workspace=${ws}&view=knowledge`}>
                          Source: {row.source_title}
                        </a>
                      )}
                      {!row.source_title && row.source_id && (
                        <span>Source: {row.source_id}</span>
                      )}
                      {id && (
                        <a
                          href={`/?workspace=${ws}&view=inbox&conversation=${encodeURIComponent(id)}`}
                        >
                          Open conversation →
                        </a>
                      )}
                      {row.retry_count != null && (
                        <span>{row.retry_count} retries</span>
                      )}
                      {row.attempts != null && (
                        <span>{row.attempts} delivery attempts</span>
                      )}
                    </div>
                    {(row.error || row.output?.message) && (
                      <p>{row.error ?? row.output.message}</p>
                    )}
                    {active === "audit" && (
                      <p>
                        {Object.entries(row.data ?? {})
                          .filter(
                            ([key, value]) =>
                              !["actor", "actorId"].includes(key) &&
                              ["string", "number", "boolean"].includes(
                                typeof value,
                              ),
                          )
                          .slice(0, 3)
                          .map(
                            ([key, value]) => `${words(key)}: ${String(value)}`,
                          )
                          .join(" · ") || "Workspace activity recorded."}
                      </p>
                    )}
                    <div className="activity-record-actions">
                      {admin &&
                        active === "operations" &&
                        ["unknown", "sent"].includes(row.status) && (
                          <button
                            disabled={action.busy}
                            onClick={() =>
                              void action.run(async () => {
                                await api(
                                  ws,
                                  `/operations/${row.id}/reconcile`,
                                  {},
                                );
                                load.reload();
                              }, "Provider outcome refreshed.")
                            }
                          >
                            Look up provider outcome
                          </button>
                        )}
                      {active === "background" &&
                        row.recordType === "job" &&
                        row.state === "failed" && (
                          <button
                            disabled={action.busy}
                            onClick={() =>
                              void action.run(async () => {
                                await api(ws, `/jobs/${row.id}/retry`, {});
                                load.reload();
                              }, "Job queued for retry.")
                            }
                          >
                            Retry job
                          </button>
                        )}
                    </div>
                    <details>
                      <summary>
                        {active === "audit"
                          ? "Event details"
                          : "Record details"}
                      </summary>
                      <p className="activity-record-id">Record: {row.id}</p>
                      <pre>
                        {JSON.stringify(
                          active === "audit"
                            ? row.data
                            : (row.receipt ??
                                row.output ?? {
                                  conversation: id,
                                  attempts: row.attempts,
                                }),
                          null,
                          2,
                        )}
                      </pre>
                    </details>
                  </article>
                );
              })}
            </div>
            {totalPages > 1 && (
              <nav className="activity-pagination" aria-label="Activity pages">
                <button
                  disabled={currentPage === 1}
                  onClick={() => changePage(currentPage - 1)}
                >
                  Previous page
                </button>
                <span>
                  Page {currentPage} of {totalPages}
                </span>
                <button
                  disabled={currentPage === totalPages}
                  onClick={() => changePage(currentPage + 1)}
                >
                  Next page
                </button>
              </nav>
            )}
          </section>
        </>
      )}
    </div>
  );
}
