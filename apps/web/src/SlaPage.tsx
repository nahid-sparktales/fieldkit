import { useEffect, useState } from "react";
import { api, useLoad } from "./request.js";
import { useAction } from "./useAction.js";
import { Field, Notice, link, type Row } from "./quality-ui.js";
import { LoadingState } from "./ui.js";
import type { SlaPolicyValue } from "../../../packages/platform/src/sla-contracts.js";
import "./sla.css";
import { useSlaEvents } from "./sla-events.js";
const date = (v: string) => new Date(v).toLocaleString();
const drafts = new Map<string, { policy: SlaPolicyValue; revision: number }>();
export function SlaPage({ ws, role }: { ws: string; role: string }) {
  const l = useLoad(() => api(ws, "/sla"), [ws]),
    a = useAction();
  useSlaEvents(ws, l.reload);
  const [filter, setFilter] = useState("actionable"),
    [tab, setTab] = useState("queue");
  const rows = (l.data?.obligations ?? []).filter(
    (o: Row) =>
      filter === "all" || (o.state !== "paused" && o.urgency !== "on_track"),
  );
  return (
    <div className="quality-page sla-page">
      <header>
        <span className="eyebrow">RESPONSE COMMITMENTS</span>
        <h1>Needs attention</h1>
        <p>
          Response deadlines, staff notifications and reviewed follow-ups.
          Timers use recorded deliveries, not proof of email receipt.
        </p>
      </header>
      <Notice action={a} error={l.error} />
      <div className="quality-actions">
        <button aria-pressed={tab === "queue"} onClick={() => setTab("queue")}>
          Deadlines
        </button>
        <button
          aria-pressed={tab === "notifications"}
          onClick={() => setTab("notifications")}
        >
          My notifications ·{" "}
          {(l.data?.notifications ?? []).filter((n: Row) => !n.read_at).length}
        </button>
        <button
          aria-pressed={tab === "policy"}
          onClick={() => setTab("policy")}
        >
          SLA policy
        </button>
        <button onClick={l.reload}>Refresh</button>
      </div>
      {!l.data && <LoadingState label="Loading response deadlines…" />}
      {tab === "queue" && l.data && (
        <section className="panel">
          <div className="sla-title">
            <h2>Response queue</h2>
            <label>
              Show{" "}
              <select
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
              >
                <option value="actionable">At risk and overdue</option>
                <option value="all">All active timers</option>
              </select>
            </label>
          </div>
          {!l.data.settings.policy.enabled && (
            <p className="callout">
              SLA tracking is off. An owner or administrator can configure
              business hours and enable it for new events. Existing history is
              not backfilled.
            </p>
          )}
          {!rows.length ? (
            <p>
              No {filter === "all" ? "active" : "at-risk or overdue"} deadlines.
            </p>
          ) : (
            <div className="sla-queue">
              {rows.map((o: Row) => (
                <a
                  className="sla-queue-row"
                  key={o.id}
                  href={link(ws, "inbox", `&conversation=${o.conversation_id}`)}
                >
                  <div>
                    <strong>{o.subject}</strong>
                    <span>
                      {o.customer_name || o.customer_email || "Visitor"} ·{" "}
                      {o.channel} · {o.kind} response
                    </span>
                  </div>
                  <div>
                    <span
                      className={`badge ${o.state === "paused" ? "neutral" : o.urgency === "overdue" ? "bad" : o.urgency === "at_risk" ? "warning" : "good"}`}
                    >
                      {o.state === "paused"
                        ? "Waiting on customer"
                        : o.urgency.replace("_", " ")}
                    </span>
                    <time dateTime={o.due_at}>{date(o.due_at)}</time>
                    <small>
                      Policy v{o.policy_revision} · {o.policy.calendar.timezone}
                    </small>
                  </div>
                </a>
              ))}
            </div>
          )}
        </section>
      )}
      {tab === "notifications" && l.data && (
        <section className="panel">
          <h2>My notifications</h2>
          {!l.data.notifications.length && (
            <p>Warnings and escalations assigned to you will appear here.</p>
          )}
          {l.data.notifications.map((n: Row) => (
            <article className="sla-notification" key={n.id}>
              <div>
                <a
                  href={link(ws, "inbox", `&conversation=${n.conversation_id}`)}
                >
                  {n.subject}
                </a>
                <p>
                  {n.threshold} · {date(n.created_at)} ·{" "}
                  {n.read_at ? "Read" : "Unread"}
                </p>
                {n.email_status !== "disabled" && (
                  <small>
                    Email: {n.email_status}
                    {n.error ? ` · ${n.error}` : ""}
                  </small>
                )}
              </div>
              {!n.read_at && (
                <button
                  disabled={a.busy}
                  onClick={() =>
                    a.run(async () => {
                      await api(ws, `/sla/notifications/${n.id}/read`, {});
                      l.reload();
                    })
                  }
                >
                  Mark read
                </button>
              )}
            </article>
          ))}
        </section>
      )}
      {tab === "policy" && l.data && (
        <PolicyEditor
          key={ws}
          ws={ws}
          initial={l.data.settings}
          editable={["owner", "admin"].includes(role)}
          onSave={l.reload}
        />
      )}
    </div>
  );
}
function PolicyEditor({
  ws,
  initial,
  editable,
  onSave,
}: {
  ws: string;
  initial: Row;
  editable: boolean;
  onSave: () => void;
}) {
  const [saved, setSaved] = useState(initial),
    [policy, setPolicy] = useState<SlaPolicyValue>(
      drafts.get(ws)?.policy ?? initial.policy,
    ),
    [revision, setRevision] = useState(
      drafts.get(ws)?.revision ?? initial.revision,
    );
  const [preview, setPreview] = useState<Row | null>(null),
    [changes, setChanges] = useState<Row | null>(null),
    [start, setStart] = useState(new Date().toISOString().slice(0, 16)),
    [minutes, setMinutes] = useState(240),
    a = useAction();
  const members = useLoad(() => api(ws, "/members"), [ws]),
    dirty = JSON.stringify(policy) !== JSON.stringify(saved.policy);
  useEffect(() => {
    if (dirty) drafts.set(ws, { policy, revision });
    else drafts.delete(ws);
    const warn = (e: BeforeUnloadEvent) => {
      if (dirty) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [ws, policy, revision, dirty]);
  const update = (patch: Partial<SlaPolicyValue>) => {
    setPolicy((old) => ({ ...old, ...patch }));
    a.setSuccess("");
    setPreview(null);
  };
  const rule = (index: number, patch: Row) =>
    update({
      rules: policy.rules.map((r, i) => (i === index ? { ...r, ...patch } : r)),
    });
  return (
    <form
      className="panel sla-policy"
      onSubmit={(e) => {
        e.preventDefault();
        void a.run(async () => {
          const result = await api(
            ws,
            "/sla/policy",
            { revision, policy },
            "PUT",
          );
          setSaved(result);
          setRevision(result.revision);
          setPolicy(result.policy);
          drafts.delete(ws);
          onSave();
        }, "SLA policy saved. New obligations use this version.");
      }}
    >
      <h2>SLA policy</h2>
      <p>
        Rules run from top to bottom; the first matching rule wins. Editing the
        policy does not change active timers. Turning tracking off cancels
        future timer effects.
      </p>
      <Notice action={a} />
      <fieldset disabled={!editable || a.busy}>
        <legend>Tracking and business calendar</legend>
        <label className="check-label">
          <input
            type="checkbox"
            checked={policy.enabled}
            onChange={(e) => update({ enabled: e.target.checked })}
          />
          Enable SLA tracking for new events
        </label>
        <Field label="Business timezone">
          <input
            value={policy.calendar.timezone}
            placeholder="America/Toronto"
            onChange={(e) =>
              update({
                calendar: { ...policy.calendar, timezone: e.target.value },
              })
            }
          />
        </Field>
        <p>
          Split shifts are supported. Day numbers use Monday through Sunday. End
          at 24:00 to include midnight.
        </p>
        {policy.calendar.shifts.map((s, i) => (
          <div className="sla-shift" key={i}>
            <label>
              Day
              <select
                value={s.day}
                onChange={(e) =>
                  update({
                    calendar: {
                      ...policy.calendar,
                      shifts: policy.calendar.shifts.map((x, j) =>
                        i === j ? { ...x, day: Number(e.target.value) } : x,
                      ),
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
                ].map((day, j) => (
                  <option value={j + 1} key={day}>
                    {day}
                  </option>
                ))}
              </select>
            </label>
            {(["start", "end"] as const).map((key) => (
              <label key={key}>
                {key === "start" ? "Opens" : "Closes"}
                <input
                  value={s[key]}
                  aria-label={`${key} for shift ${i + 1}`}
                  pattern="[0-2][0-9]:[0-5][0-9]"
                  onChange={(e) =>
                    update({
                      calendar: {
                        ...policy.calendar,
                        shifts: policy.calendar.shifts.map((x, j) =>
                          i === j ? { ...x, [key]: e.target.value } : x,
                        ),
                      },
                    })
                  }
                />
              </label>
            ))}
            <button
              type="button"
              onClick={() =>
                update({
                  calendar: {
                    ...policy.calendar,
                    shifts: policy.calendar.shifts.filter((_, j) => j !== i),
                  },
                })
              }
              aria-label={`Remove shift ${i + 1}`}
            >
              Remove
            </button>
          </div>
        ))}
        <button
          type="button"
          onClick={() =>
            update({
              calendar: {
                ...policy.calendar,
                shifts: [
                  ...policy.calendar.shifts,
                  { day: 6, start: "09:00", end: "17:00" },
                ],
              },
            })
          }
        >
          Add business interval
        </button>
        <Field label="Holidays (one YYYY-MM-DD date per line)">
          <textarea
            rows={3}
            value={policy.calendar.holidays.join("\n")}
            onChange={(e) =>
              update({
                calendar: {
                  ...policy.calendar,
                  holidays: e.target.value.split("\n").filter(Boolean),
                },
              })
            }
          />
        </Field>
      </fieldset>
      <fieldset disabled={!editable || a.busy}>
        <legend>Ordered response rules</legend>
        {policy.rules.map((r, i) => (
          <section className="sla-rule" key={r.id}>
            <div className="sla-title">
              <h3>Rule {i + 1}</h3>
              <div>
                <button
                  type="button"
                  disabled={!i}
                  onClick={() => {
                    const list = [...policy.rules];
                    [list[i - 1], list[i]] = [list[i], list[i - 1]];
                    update({ rules: list });
                  }}
                >
                  Move up
                </button>
                <button
                  type="button"
                  disabled={policy.rules.length === 1}
                  onClick={() =>
                    update({ rules: policy.rules.filter((_, j) => j !== i) })
                  }
                >
                  Remove rule
                </button>
              </div>
            </div>
            <Field label="Rule name">
              <input
                value={r.name}
                onChange={(e) => rule(i, { name: e.target.value })}
              />
            </Field>
            <div className="sla-choice-row">
              {(["portal", "widget", "zendesk"] as const).map((v) => (
                <label key={v}>
                  <input
                    type="checkbox"
                    checked={r.channels.includes(v)}
                    onChange={(e) =>
                      rule(i, {
                        channels: e.target.checked
                          ? [...r.channels, v]
                          : r.channels.filter((c) => c !== v),
                      })
                    }
                  />
                  {v === "portal"
                    ? "Tickets"
                    : v === "widget"
                      ? "Chatbot"
                      : "Zendesk"}
                </label>
              ))}
            </div>
            <div className="sla-choice-row">
              {(["low", "normal", "high", "urgent"] as const).map((v) => (
                <label key={v}>
                  <input
                    type="checkbox"
                    checked={r.priorities.includes(v)}
                    onChange={(e) =>
                      rule(i, {
                        priorities: e.target.checked
                          ? [...r.priorities, v]
                          : r.priorities.filter((c) => c !== v),
                      })
                    }
                  />
                  {v}
                </label>
              ))}
            </div>
            <div className="sla-targets">
              {[
                ["firstMinutes", "First response"],
                ["nextMinutes", "Next response"],
                ["handoffMinutes", "Human response after handoff"],
                ["warningMinutes", "Warn before deadline"],
                ["escalateMinutes", "Escalate after deadline"],
              ].map(([key, label]) => (
                <Field label={`${label} (business minutes)`} key={key}>
                  <input
                    type="number"
                    min={
                      key.includes("warning") || key.includes("escalate")
                        ? 0
                        : 1
                    }
                    max={43200}
                    value={(r as Row)[key]}
                    onChange={(e) => rule(i, { [key]: Number(e.target.value) })}
                  />
                </Field>
              ))}
            </div>
            <Field label="What counts as a response?">
              <select
                value={r.replies}
                onChange={(e) => rule(i, { replies: e.target.value })}
              >
                <option value="staff_only">Delivered staff replies only</option>
                <option value="public_ai_or_staff">
                  Delivered public AI or staff replies
                </option>
              </select>
            </Field>
            <Field label="Escalation recipient">
              <select
                value={r.escalationUserId ?? ""}
                onChange={(e) =>
                  rule(i, { escalationUserId: e.target.value || null })
                }
              >
                <option value="">Workspace owners and admins</option>
                {(members.data?.members ?? []).map((m: Row) => (
                  <option key={m.user_id} value={m.user_id}>
                    {m.name || m.email}
                  </option>
                ))}
              </select>
            </Field>
          </section>
        ))}
        <button
          type="button"
          onClick={() =>
            update({
              rules: [
                ...policy.rules,
                {
                  ...policy.rules[0],
                  id: crypto.randomUUID(),
                  name: "New rule",
                },
              ],
            })
          }
        >
          Add response rule
        </button>
      </fieldset>
      <fieldset disabled={!editable || a.busy}>
        <legend>Notifications and customer follow-ups</legend>
        <label className="check-label">
          <input
            type="checkbox"
            checked={policy.staffEmail}
            onChange={(e) => update({ staffEmail: e.target.checked })}
          />
          Email staff about warnings and escalations
        </label>
        <label className="check-label">
          <input
            type="checkbox"
            checked={policy.followup.enabled}
            onChange={(e) =>
              update({
                followup: { ...policy.followup, enabled: e.target.checked },
              })
            }
          />
          Allow reviewed customer reminders
        </label>
        <p>
          Each waiting cycle still needs an explicit staff opt-in after a
          delivered staff reply. Changes, replies or later takeover suppress
          stale reminders. Tickets are never closed automatically.
        </p>
        <Field label="Exact reminder message">
          <textarea
            rows={3}
            value={policy.followup.template}
            onChange={(e) =>
              update({
                followup: { ...policy.followup, template: e.target.value },
              })
            }
          />
        </Field>
        <div className="sla-targets">
          <Field label="Wait between reminders (business minutes)">
            <input
              type="number"
              min="1"
              max="43200"
              value={policy.followup.afterMinutes}
              onChange={(e) =>
                update({
                  followup: {
                    ...policy.followup,
                    afterMinutes: Number(e.target.value),
                  },
                })
              }
            />
          </Field>
          <Field label="Maximum reminders per cycle">
            <input
              type="number"
              min="1"
              max="3"
              value={policy.followup.maxReminders}
              onChange={(e) =>
                update({
                  followup: {
                    ...policy.followup,
                    maxReminders: Number(e.target.value),
                  },
                })
              }
            />
          </Field>
        </div>
      </fieldset>
      {editable && (
        <div className="quality-actions">
          <button
            className="primary"
            disabled={a.busy || (!dirty && revision > 0)}
          >
            Save SLA policy
          </button>
          <span>
            {dirty
              ? "Unsaved changes — kept while you navigate this workspace"
              : `Saved version ${revision}`}
          </span>
        </div>
      )}
      <details>
        <summary>Preview a deadline</summary>
        <p>
          Enter a UTC start time. The calculation applies the selected business
          timezone.
        </p>
        <Field label="Start time (UTC)">
          <input
            type="datetime-local"
            value={start}
            onChange={(e) => setStart(e.target.value)}
          />
        </Field>
        <Field label="Business minutes">
          <input
            type="number"
            min="1"
            max="43200"
            value={minutes}
            onChange={(e) => setMinutes(Number(e.target.value))}
          />
        </Field>
        <button
          type="button"
          disabled={a.busy}
          onClick={() =>
            a.run(async () =>
              setPreview(
                await api(ws, "/sla/preview", {
                  policy,
                  start: new Date(`${start}Z`).toISOString(),
                  minutes,
                }),
              ),
            )
          }
        >
          Calculate deadline
        </button>
        {preview && (
          <p role="status">
            Due {date(preview.dueAt)} · {preview.timezone}
          </p>
        )}
      </details>
      {editable && (
        <details>
          <summary>Apply the saved policy to active timers</summary>
          <p>
            Review every changed deadline first. Original start times and
            previous breaches are preserved.
          </p>
          <button
            type="button"
            disabled={a.busy || dirty}
            onClick={() =>
              a.run(async () =>
                setChanges(
                  await api(ws, "/sla/recalculate", { commit: false }),
                ),
              )
            }
          >
            Preview recalculation
          </button>
          {changes && (
            <>
              <ul>
                {changes.changes.map((c: Row) => (
                  <li key={c.id}>
                    {date(c.previousDue)} → {date(c.dueAt)}{" "}
                    {c.breached ? "(previous breach retained)" : ""}
                  </li>
                ))}
              </ul>
              <button
                type="button"
                disabled={a.busy || changes.applied || dirty}
                onClick={() =>
                  a.run(async () => {
                    setChanges(
                      await api(ws, "/sla/recalculate", {
                        commit: true,
                        previewHash: changes.previewHash,
                      }),
                    );
                    onSave();
                  }, "Active deadlines recalculated. Prior breaches remain in history.")
                }
              >
                Apply reviewed recalculation
              </button>
            </>
          )}
        </details>
      )}
    </form>
  );
}
