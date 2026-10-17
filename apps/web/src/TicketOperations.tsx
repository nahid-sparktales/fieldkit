import { useEffect, useRef, useState } from "react";
import { api, useLoad } from "./request.js";
import type { Row } from "./quality-ui.js";
import "./ticket-operations.css";

export function TicketPresence({
  ws,
  id,
  typing,
}: {
  ws: string;
  id: string;
  typing: boolean;
}) {
  const tab = useRef(crypto.randomUUID()),
    typingRef = useRef(typing),
    [people, setPeople] = useState<Row[]>([]);
  typingRef.current = typing;
  useEffect(() => {
    let live = true;
    const send = () =>
      api(
        ws,
        `/conversations/${id}/presence`,
        { tabId: tab.current, typing: typingRef.current && !document.hidden },
        "PUT",
      )
        .then((r) => {
          if (live) setPeople(r.people);
        })
        .catch(() => {
          if (live) setPeople([]);
        });
    void send();
    const timer = setInterval(send, 5000);
    return () => {
      live = false;
      clearInterval(timer);
      void api(
        ws,
        `/conversations/${id}/presence`,
        { tabId: tab.current, typing: false, leave: true },
        "PUT",
      ).catch(() => {});
    };
  }, [ws, id]);
  if (!people.length) return null;
  return (
    <p className="ticket-presence" role="status">
      {people
        .map((p) => `${p.name} is ${p.typing ? "typing" : "viewing"}`)
        .join(" · ")}
      <small>Check recent replies before sending.</small>
    </p>
  );
}
export function MergeTicket({
  ws,
  id,
  onMerged,
}: {
  ws: string;
  id: string;
  onMerged: (id: string) => void;
}) {
  const [open, setOpen] = useState(false),
    [target, setTarget] = useState(""),
    [preview, setPreview] = useState<Row | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [confirmed, setConfirmed] = useState(false);
  const requestKey = useRef(crypto.randomUUID()),
    generation = useRef(0);
  useEffect(() => {
    generation.current++;
    setPreview(null);
    setTarget("");
    setConfirmed(false);
    setBusy(false);
    return () => {
      generation.current++;
    };
  }, [ws, id]);
  const candidates = useLoad(
    () =>
      open
        ? api(ws, `/conversations/${id}/merge-candidates`)
        : Promise.resolve({ tickets: [] }),
    [ws, id, open],
  );
  const run = async (commit = false) => {
    if (busy) return;
    if (commit && (!preview || preview.target.id !== target)) {
      setError("Review a fresh preview before merging.");
      return;
    }
    const current = ++generation.current;
    setBusy(true);
    setError("");
    try {
      if (commit && preview) {
        const result = await api(ws, `/conversations/${id}/merge`, {
          targetId: preview.target.id,
          sourceVersion: preview.source.editVersion,
          targetVersion: preview.target.editVersion,
          requestKey: requestKey.current,
        });
        if (generation.current === current) onMerged(result.id);
      } else {
        setPreview(null);
        const next = await api(ws, `/conversations/${id}/merge-preview`, {
          targetId: target,
        });
        if (generation.current !== current) return;
        setPreview(next);
        requestKey.current = crypto.randomUUID();
        setConfirmed(false);
      }
    } catch (e) {
      if (generation.current === current) {
        setError((e as Error).message);
        if (!commit) setPreview(null);
      }
    } finally {
      if (generation.current === current) setBusy(false);
    }
  };
  return (
    <section className="merge-ticket">
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)}>
        Merge duplicate ticket
      </button>
      {open && (
        <div className="panel">
          <h3>Choose the ticket to keep</h3>
          <p>
            Only native tickets for this requester and intake address can be
            merged. The source becomes a read-only alias.
          </p>
          <label>
            Keep this ticket
            <select
              disabled={busy}
              value={target}
              onChange={(e) => {
                setTarget(e.target.value);
                setPreview(null);
              }}
            >
              <option value="">Select a ticket…</option>
              {candidates.data?.tickets.map((t: Row) => (
                <option key={t.id} value={t.id}>
                  {t.subject} · {t.status} · #{t.id.slice(0, 8)}
                </option>
              ))}
            </select>
          </label>
          <button disabled={!target || busy} onClick={() => void run()}>
            Preview merge
          </button>
          {(error || candidates.error) && (
            <p role="alert">{error || candidates.error}</p>
          )}
          {preview && (
            <>
              <p>{preview.notice}</p>
              <p>
                <strong>{preview.messageCount} messages</strong> from “
                {preview.source.subject}” will appear with “
                {preview.target.subject}”.
              </p>
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={confirmed}
                  disabled={busy}
                  onChange={(e) => setConfirmed(e.target.checked)}
                />
                I reviewed the target and understand this merge cannot be
                undone.
              </label>
              <button
                className="primary"
                disabled={!confirmed || busy}
                onClick={() => void run(true)}
              >
                {busy ? "Merging…" : "Merge into selected ticket"}
              </button>
            </>
          )}
        </div>
      )}
    </section>
  );
}
export function BulkActionBar({
  ws,
  tickets,
  members,
  onDone,
  onClear,
}: {
  ws: string;
  tickets: Row[];
  members: Row[];
  onDone: () => void;
  onClear: () => void;
}) {
  const [kind, setKind] = useState("status"),
    [value, setValue] = useState("resolved"),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [result, setResult] = useState<Row | null>(null);
  const key = useRef(crypto.randomUUID()),
    teams = useLoad(() => api(ws, "/routing"), [ws]);
  useEffect(() => {
    key.current = crypto.randomUUID();
    setResult(null);
  }, [tickets.map((t) => `${t.id}:${t.edit_version}`).join(","), kind, value]);
  const submit = async () => {
    setBusy(true);
    setError("");
    try {
      const action =
        kind === "status"
          ? { kind, status: value }
          : kind === "priority"
            ? { kind, priority: value }
            : kind === "assign"
              ? { kind, assignedTo: value || null }
              : kind === "team"
                ? { kind, teamId: value || null }
                : {
                    kind: "tags",
                    add:
                      kind === "addTags"
                        ? value
                            .split(",")
                            .map((t) => t.trim())
                            .filter(Boolean)
                        : [],
                    remove:
                      kind === "removeTags"
                        ? value
                            .split(",")
                            .map((t) => t.trim())
                            .filter(Boolean)
                        : [],
                  };
      setResult(
        await api(ws, "/ticket-batches", {
          requestKey: key.current,
          action,
          tickets: tickets.map((t) => ({
            id: t.id,
            expectedEditVersion: t.edit_version,
          })),
        }),
      );
      onDone();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div
      className="bulk-actions"
      role="region"
      aria-label="Bulk ticket actions"
    >
      <div className="button-row">
        <strong>{tickets.length} selected</strong>
        <button onClick={onClear} disabled={busy}>
          Clear selection
        </button>
      </div>
      <div className="bulk-action-inputs">
        <select
          aria-label="Bulk action"
          value={kind}
          onChange={(e) => {
            setKind(e.target.value);
            setValue(
              e.target.value === "status"
                ? "resolved"
                : e.target.value === "priority"
                  ? "normal"
                  : "",
            );
          }}
        >
          <option value="status">Change status</option>
          <option value="assign">Assign agent</option>
          <option value="team">Change team</option>
          <option value="priority">Set priority</option>
          <option value="addTags">Add tags</option>
          <option value="removeTags">Remove tags</option>
        </select>
        {kind === "status" ? (
          <select
            aria-label="Bulk status"
            value={value}
            onChange={(e) => setValue(e.target.value)}
          >
            <option value="resolved">Resolve</option>
            <option value="open">Reopen</option>
          </select>
        ) : kind === "priority" ? (
          <select
            aria-label="Bulk priority"
            value={value}
            onChange={(e) => setValue(e.target.value)}
          >
            {["low", "normal", "high", "urgent"].map((v) => (
              <option key={v}>{v}</option>
            ))}
          </select>
        ) : kind === "assign" ? (
          <select
            aria-label="Bulk assignee"
            value={value}
            onChange={(e) => setValue(e.target.value)}
          >
            <option value="">Unassigned</option>
            {members.map((m) => (
              <option key={m.user_id} value={m.user_id}>
                {m.name}
              </option>
            ))}
          </select>
        ) : kind === "team" ? (
          <select
            aria-label="Bulk team"
            value={value}
            onChange={(e) => setValue(e.target.value)}
          >
            <option value="">No team</option>
            {teams.data?.teams
              ?.filter((t: Row) => t.active)
              .map((t: Row) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
          </select>
        ) : (
          <input
            aria-label="Bulk tags"
            placeholder="Tags, separated by commas"
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
        )}
        <button
          className="primary"
          disabled={busy || !!result || (!value && kind.includes("Tags"))}
          onClick={() => void submit()}
        >
          {busy ? "Applying…" : "Apply"}
        </button>
      </div>
      {error && (
        <p role="alert">
          {error}
          <button disabled={busy} onClick={() => void submit()}>
            Retry this batch
          </button>
        </p>
      )}
      {result && (
        <div role="status">
          <p>
            {result.items.filter((i: Row) => i.status === "updated").length} of{" "}
            {tickets.length} updated.
          </p>
          {result.items
            .filter((i: Row) => i.status !== "updated")
            .map((i: Row) => (
              <p key={i.conversation_id}>
                #{i.conversation_id.slice(0, 8)}: {i.result?.error ?? i.status}
              </p>
            ))}
          <p>
            Clear the selection, review changed tickets, then select them again
            to retry.
          </p>
        </div>
      )}
    </div>
  );
}
