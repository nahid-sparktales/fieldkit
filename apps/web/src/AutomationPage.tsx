import { useEffect, useState } from "react";
import { api, useLoad } from "./request.js";
import { useAction } from "./useAction.js";
import { Field, Notice, link, type Row } from "./quality-ui.js";
import { LoadingState } from "./ui.js";
import { confirmDiscardChanges, useUnsavedChanges } from "./unsaved-changes.js";
import {
  AutomationDefinition,
  type AutomationDefinitionValue as Definition,
  type AutomationConditionValue as Condition,
  type AutomationActionValue as Action,
} from "../../../packages/platform/src/ticket-automation-contracts.js";
import "./automations.css";
const calendar = {
  timezone: "UTC",
  shifts: [1, 2, 3, 4, 5].map((day) => ({ day, start: "09:00", end: "17:00" })),
  holidays: [] as string[],
};
const blank = (): Definition => ({
  name: "",
  description: "",
  trigger: { type: "event", event: "created" },
  all: [],
  any: [],
  actions: [{ type: "note", body: "" }],
});
const labels: Row = {
  created: "Ticket created",
  customer_message: "Customer message received",
  staff_reply: "Staff reply delivered",
  ticket_changed: "Ticket properties changed",
  sla_warning: "SLA warning reached",
  sla_breach: "SLA breached",
  last_customer: "Last customer message",
  last_staff: "Last delivered staff reply",
  ticket_changed_anchor: "Last ticket change",
  waiting: "Waiting for the customer",
  priority: "Set priority",
  tags: "Add or remove tags",
  route: "Move to team / requeue",
  note: "Add private note",
  notify: "Notify staff",
  reply: "Send public template",
  resolve: "Resolve ticket",
};
const csv = (value: string) =>
  value
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
function CommaInput({
  value,
  onChange,
  placeholder,
}: {
  value: string[];
  onChange: (v: string[]) => void;
  placeholder?: string;
}) {
  const [text, setText] = useState(value.join(", ")),
    [editing, setEditing] = useState(false);
  useEffect(() => {
    if (!editing) setText(value.join(", "));
  }, [value, editing]);
  return (
    <input
      value={text}
      placeholder={placeholder}
      onFocus={() => setEditing(true)}
      onBlur={() => setEditing(false)}
      onChange={(e) => {
        setText(e.target.value);
        onChange(csv(e.target.value));
      }}
    />
  );
}
export function AutomationPage({
  ws,
  manage = true,
}: {
  ws: string;
  manage?: boolean;
}) {
  const l = useLoad(
      () => (manage ? api(ws, "/automations") : Promise.resolve(null)),
      [ws, manage],
    ),
    a = useAction();
  const [selected, setSelected] = useState<Row | null>(null),
    [draft, setDraft] = useState<Definition>(blank),
    [position, setPosition] = useState(0),
    [tab, setTab] = useState("rules"),
    [preview, setPreview] = useState<Row | null>(null),
    [confirm, setConfirm] = useState(false);
  const dirty =
    JSON.stringify(draft) !== JSON.stringify(selected?.definition ?? blank()) ||
    position !== (selected?.position ?? 0);
  useUnsavedChanges(dirty);
  const change = (next: Definition) => {
    setDraft(next);
    setPreview(null);
    setConfirm(false);
  };
  const select = (r: Row | null) => {
    if (
      a.busy ||
      (dirty && !confirmDiscardChanges("Discard unsaved automation changes?"))
    )
      return;
    setSelected(r);
    setDraft(r?.definition ?? blank());
    setPosition(r?.position ?? 0);
    setPreview(null);
    setConfirm(false);
  };
  const save = () =>
    a.run(async () => {
      const saved = await api(ws, "/automations", {
        ...(selected ? { id: selected.id, revision: selected.revision } : {}),
        position,
        definition: AutomationDefinition.parse(draft),
      });
      setSelected(saved);
      setDraft(saved.definition);
      l.reload();
      setConfirm(false);
    }, "Draft saved. Preview it before activation.");
  const options = l.data ?? {};
  if (!manage)
    return (
      <section className="automation-page">
        <header className="page-header">
          <div>
            <h1>Automation notifications</h1>
            <p>Updates from your team's ticket rules.</p>
          </div>
        </header>
        <AutomationNotifications ws={ws} />
      </section>
    );
  return (
    <section className="automation-page">
      <header className="page-header">
        <div>
          <h1>Automations</h1>
          <p>
            Follow up, notify your team, and keep tickets moving with reviewed
            rules.
          </p>
        </div>
        <button
          disabled={a.busy}
          onClick={() => {
            select(null);
            setTab("rules");
          }}
        >
          New rule
        </button>
      </header>
      <Notice action={a} error={l.error} />
      <nav className="automation-tabs" aria-label="Automation views">
        {["rules", "history", "notifications"].map((t) => (
          <button key={t} aria-pressed={tab === t} onClick={() => setTab(t)}>
            {t[0].toUpperCase() + t.slice(1)}
          </button>
        ))}
      </nav>
      {tab === "history" ? (
        <AutomationHistory ws={ws} />
      ) : tab === "notifications" ? (
        <AutomationNotifications ws={ws} />
      ) : !l.data ? (
        <LoadingState />
      ) : (
        <div className="automation-layout">
          <aside aria-label="Automation rules">
            <p className="muted">
              Rules run in priority order. New rules start inactive.
            </p>
            {!options.rules.length && (
              <p>No rules yet. Start with a private notification or note.</p>
            )}
            {options.rules.map((r: Row) => (
              <button
                className={selected?.id === r.id ? "selected" : ""}
                key={r.id}
                disabled={a.busy}
                onClick={() => select(r)}
              >
                <strong>{r.definition.name}</strong>
                <span>
                  {r.legacy_sla
                    ? "SLA reminder"
                    : r.enabled
                      ? `Active · v${r.active_revision}`
                      : "Inactive"}
                  {r.enabled && r.revision !== r.active_revision
                    ? " · draft changes"
                    : ""}
                </span>
                <small>Order {r.position}</small>
              </button>
            ))}
          </aside>
          <fieldset disabled={a.busy} className="automation-editor">
            {selected?.legacy_sla ? (
              <div className="automation-section">
                <h2>{draft.name}</h2>
                <p>
                  This existing reminder is managed by SLA policy settings. Its
                  original waiting deadlines and reminder counts are preserved.
                </p>
                <p>{draft.actions.find((a) => a.type === "reply")?.body}</p>
                <a href={link(ws, "needs attention")}>Open SLA settings</a>
                <AutomationHistory ws={ws} id={selected.id} />
              </div>
            ) : (
              <>
                <div className="automation-section">
                  <h2>{selected ? "Edit rule" : "Create a rule"}</h2>
                  <div className="automation-fields">
                    <Field label="Rule name">
                      <input
                        value={draft.name}
                        maxLength={100}
                        onChange={(e) =>
                          change({ ...draft, name: e.target.value })
                        }
                      />
                    </Field>
                    <Field label="Run order">
                      <input
                        type="number"
                        min={0}
                        max={1000}
                        value={position}
                        onChange={(e) => {
                          setPosition(Number(e.target.value));
                          setPreview(null);
                          setConfirm(false);
                        }}
                      />
                    </Field>
                  </div>
                  <Field label="Description">
                    <input
                      value={draft.description}
                      maxLength={500}
                      onChange={(e) =>
                        change({ ...draft, description: e.target.value })
                      }
                    />
                  </Field>
                </div>
                <div className="automation-section">
                  <h3>1. When this happens</h3>
                  <Field label="Trigger type">
                    <select
                      value={draft.trigger.type}
                      onChange={(e) =>
                        change({
                          ...draft,
                          trigger:
                            e.target.value === "event"
                              ? { type: "event", event: "created" }
                              : {
                                  type: "inactivity",
                                  anchor: "last_customer",
                                  minutes: 60,
                                  clock: "elapsed",
                                },
                        })
                      }
                    >
                      <option value="event">Ticket event</option>
                      <option value="inactivity">
                        Time since a ticket event
                      </option>
                    </select>
                  </Field>
                  {draft.trigger.type === "event" ? (
                    <Field label="Ticket event">
                      <select
                        value={draft.trigger.event}
                        onChange={(e) =>
                          change({
                            ...draft,
                            trigger: {
                              type: "event",
                              event: e.target.value as any,
                            },
                          })
                        }
                      >
                        {[
                          "created",
                          "customer_message",
                          "staff_reply",
                          "ticket_changed",
                          "sla_warning",
                          "sla_breach",
                        ].map((v) => (
                          <option key={v} value={v}>
                            {labels[v]}
                          </option>
                        ))}
                      </select>
                    </Field>
                  ) : (
                    <>
                      <div className="automation-fields">
                        <Field label="Start timer from">
                          <select
                            value={draft.trigger.anchor}
                            onChange={(e) =>
                              draft.trigger.type === "inactivity" &&
                              change({
                                ...draft,
                                trigger: {
                                  ...draft.trigger,
                                  anchor: e.target.value as any,
                                },
                              })
                            }
                          >
                            {[
                              "created",
                              "last_customer",
                              "last_staff",
                              "ticket_changed",
                              "waiting",
                            ].map((v) => (
                              <option key={v} value={v}>
                                {
                                  labels[
                                    v === "ticket_changed"
                                      ? "ticket_changed_anchor"
                                      : v
                                  ]
                                }
                              </option>
                            ))}
                          </select>
                        </Field>
                        <Field label="Wait minutes">
                          <input
                            type="number"
                            min={1}
                            max={43200}
                            value={draft.trigger.minutes}
                            onChange={(e) =>
                              draft.trigger.type === "inactivity" &&
                              change({
                                ...draft,
                                trigger: {
                                  ...draft.trigger,
                                  minutes: Number(e.target.value),
                                },
                              })
                            }
                          />
                        </Field>
                      </div>
                      <Field label="Count time">
                        <select
                          value={draft.trigger.clock}
                          onChange={(e) =>
                            draft.trigger.type === "inactivity" &&
                            change({
                              ...draft,
                              trigger: {
                                ...draft.trigger,
                                clock: e.target.value as any,
                                calendar:
                                  e.target.value === "business"
                                    ? (draft.trigger.calendar ?? calendar)
                                    : undefined,
                              },
                            })
                          }
                        >
                          <option value="elapsed">
                            Elapsed time, including nights and weekends
                          </option>
                          <option value="business">Business hours</option>
                        </select>
                      </Field>
                      {draft.trigger.clock === "business" && (
                        <CalendarEditor
                          value={draft.trigger.calendar ?? calendar}
                          onChange={(c) =>
                            draft.trigger.type === "inactivity" &&
                            change({
                              ...draft,
                              trigger: { ...draft.trigger, calendar: c },
                            })
                          }
                        />
                      )}
                      <p className="muted">
                        New messages or ticket changes invalidate stale timers.
                        Activation applies to future observed events.
                      </p>
                    </>
                  )}
                </div>
                <div className="automation-section">
                  <h3>2. Match these conditions</h3>
                  <ConditionGroup
                    title="All of these"
                    conditions={draft.all}
                    options={options}
                    onChange={(all) => change({ ...draft, all })}
                  />
                  <ConditionGroup
                    title="Any of these (optional)"
                    conditions={draft.any}
                    options={options}
                    onChange={(any) => change({ ...draft, any })}
                  />
                  <p className="muted">
                    With no conditions, every eligible native ticket can match
                    this trigger.
                  </p>
                </div>
                <div className="automation-section">
                  <h3>3. Take these actions</h3>
                  {draft.actions.map((action, index) => (
                    <ActionEditor
                      key={index}
                      index={index}
                      value={action}
                      options={options}
                      onChange={(v) =>
                        change({
                          ...draft,
                          actions: draft.actions.map((a, i) =>
                            i === index ? v : a,
                          ),
                        })
                      }
                      remove={() =>
                        change({
                          ...draft,
                          actions: draft.actions.filter((_, i) => i !== index),
                        })
                      }
                    />
                  ))}
                  <button
                    disabled={draft.actions.length >= 8}
                    onClick={() =>
                      change({
                        ...draft,
                        actions: [...draft.actions, { type: "note", body: "" }],
                      })
                    }
                  >
                    Add action
                  </button>
                  <p className="muted">
                    Automation cannot call a model or run account actions.
                    Public text is sent exactly as reviewed. One follow-up is
                    allowed per source message.
                  </p>
                </div>
                <div className="automation-savebar">
                  <span>
                    {dirty
                      ? "Unsaved changes"
                      : selected
                        ? `Saved v${selected.revision}${selected.enabled ? ` · active v${selected.active_revision}` : " · inactive"}`
                        : "Not saved"}
                  </span>
                  <button
                    disabled={a.busy || !dirty}
                    onClick={() => void save()}
                  >
                    Save draft
                  </button>
                  <button
                    disabled={a.busy}
                    onClick={() =>
                      void a.run(async () => {
                        setPreview(
                          await api(
                            ws,
                            "/automations/preview",
                            AutomationDefinition.parse(draft),
                          ),
                        );
                      }, "Preview ready. No actions were run.")
                    }
                  >
                    Preview matches
                  </button>
                  {selected?.enabled && (
                    <button
                      disabled={a.busy}
                      onClick={() =>
                        void a.run(async () => {
                          await api(
                            ws,
                            `/automations/${selected.id}/activation`,
                            { revision: selected.revision, enabled: false },
                            "PUT",
                          );
                          setSelected({ ...selected, enabled: false });
                          l.reload();
                        }, "Rule disabled; pending work will be suppressed.")
                      }
                    >
                      Disable rule
                    </button>
                  )}
                  {selected && (
                    <button
                      disabled={a.busy || dirty || !preview}
                      onClick={() => setConfirm(true)}
                    >
                      Activate saved rule
                    </button>
                  )}
                </div>
                {preview && (
                  <section
                    className="automation-section"
                    aria-label="Rule preview"
                  >
                    <h3>Preview: {preview.matched} matching tickets</h3>
                    <p>
                      {preview.scanned} tickets sampled
                      {preview.truncated ? " (most recent 500)" : ""}. This
                      preview has not run any actions.
                    </p>
                    {preview.tickets.map((t: Row) => (
                      <div className="automation-history-row" key={t.id}>
                        <a
                          href={link(
                            ws,
                            "inbox",
                            `&conversation=${encodeURIComponent(t.id)}`,
                          )}
                        >
                          {t.subject}
                        </a>
                        <span>
                          {t.eligible ? "Eligible" : "Skipped"} · {t.reason}
                          {t.dueAt
                            ? ` · due ${new Date(t.dueAt).toLocaleString()}`
                            : ""}
                        </span>
                      </div>
                    ))}
                  </section>
                )}
                {confirm && (
                  <section
                    role="region"
                    aria-label="Confirm rule activation"
                    className="automation-activation"
                  >
                    <h3>Activate “{selected?.definition.name}”?</h3>
                    <p>
                      New matching events will run these actions:{" "}
                      {draft.actions.map((a) => labels[a.type]).join(", ")}.
                      Review public text and recipients before enabling.
                    </p>
                    <button
                      disabled={a.busy}
                      onClick={() =>
                        void a.run(async () => {
                          await api(
                            ws,
                            `/automations/${selected!.id}/activation`,
                            {
                              revision: selected!.revision,
                              enabled: true,
                              confirm: true,
                            },
                            "PUT",
                          );
                          setSelected({
                            ...selected,
                            enabled: true,
                            active_revision: selected!.revision,
                          });
                          setConfirm(false);
                          l.reload();
                        }, "Rule activated for new matching events.")
                      }
                    >
                      Confirm activation
                    </button>
                    <button disabled={a.busy} onClick={() => setConfirm(false)}>
                      Cancel
                    </button>
                  </section>
                )}
                {selected && (
                  <details className="automation-section">
                    <summary>Rule history and saved versions</summary>
                    <AutomationHistory ws={ws} id={selected.id} />
                  </details>
                )}
              </>
            )}
          </fieldset>
        </div>
      )}
    </section>
  );
}
function CalendarEditor({
  value,
  onChange,
}: {
  value: Row;
  onChange: (v: any) => void;
}) {
  return (
    <div className="automation-calendar">
      <Field label="Business timezone">
        <input
          value={value.timezone}
          placeholder="America/Toronto"
          onChange={(e) => onChange({ ...value, timezone: e.target.value })}
        />
      </Field>
      {value.shifts.map((s: Row, i: number) => (
        <div className="automation-fields" key={i}>
          <Field label={`Business day ${i + 1}`}>
            <select
              value={s.day}
              onChange={(e) =>
                onChange({
                  ...value,
                  shifts: value.shifts.map((v: Row, j: number) =>
                    j === i ? { ...v, day: Number(e.target.value) } : v,
                  ),
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
              ].map((v, j) => (
                <option key={v} value={j + 1}>
                  {v}
                </option>
              ))}
            </select>
          </Field>
          {["start", "end"].map((k) => (
            <Field key={k} label={`Shift ${i + 1} ${k}`}>
              <input
                value={s[k]}
                placeholder="09:00"
                onChange={(e) =>
                  onChange({
                    ...value,
                    shifts: value.shifts.map((v: Row, j: number) =>
                      j === i ? { ...v, [k]: e.target.value } : v,
                    ),
                  })
                }
              />
            </Field>
          ))}
          <button
            aria-label={`Remove business shift ${i + 1}`}
            onClick={() =>
              onChange({
                ...value,
                shifts: value.shifts.filter((_: unknown, j: number) => j !== i),
              })
            }
          >
            Remove
          </button>
        </div>
      ))}
      <button
        disabled={value.shifts.length >= 28}
        onClick={() =>
          onChange({
            ...value,
            shifts: [...value.shifts, { day: 1, start: "09:00", end: "17:00" }],
          })
        }
      >
        Add business shift
      </button>
      <Field label="Holidays (comma-separated YYYY-MM-DD)">
        <CommaInput
          value={value.holidays}
          onChange={(holidays) => onChange({ ...value, holidays })}
        />
      </Field>
    </div>
  );
}
function ConditionGroup({
  title,
  conditions,
  options,
  onChange,
}: {
  title: string;
  conditions: Condition[];
  options: Row;
  onChange: (v: Condition[]) => void;
}) {
  const fields: Row[] = [
    ...[
      "status",
      "channel",
      "priority",
      "team",
      "assignee",
      "tags",
      "form",
      "organization",
      "waiting",
      "sla",
    ].map((id) => ({
      id,
      name: id === "sla" ? "SLA state" : id[0].toUpperCase() + id.slice(1),
    })),
    ...(options.fields ?? [])
      .filter((f: Row) => !["text", "multiline"].includes(f.definition.type))
      .map((f: Row) => ({
        id: `field.${f.id}`,
        name: f.definition.name,
        type: f.definition.type,
        definition: f.definition,
      })),
  ];
  return (
    <fieldset className="automation-conditions">
      <legend>{title}</legend>
      {conditions.map((c, index) => {
        const f = fields.find((f) => f.id === c.field),
          type = f?.type ?? (c.field === "waiting" ? "boolean" : "select"),
          list: Row[] =
            c.field === "status"
              ? ["open", "needs_staff", "waiting_approval", "resolved"].map(
                  (id) => ({ id, name: id.replaceAll("_", " ") }),
                )
              : c.field === "channel"
                ? ["portal", "widget", "email", "zendesk"].map((id) => ({
                    id,
                    name: id,
                  }))
                : c.field === "priority"
                  ? ["low", "normal", "high", "urgent"].map((id) => ({
                      id,
                      name: id,
                    }))
                  : c.field === "sla"
                    ? ["none", "on_track", "at_risk", "overdue"].map((id) => ({
                        id,
                        name: id.replaceAll("_", " "),
                      }))
                    : c.field === "team"
                      ? options.teams
                      : c.field === "assignee"
                        ? options.members.map((m: Row) => ({
                            id: m.user_id,
                            name: m.name || m.email || m.user_id,
                          }))
                        : c.field === "form"
                          ? options.forms
                          : c.field === "organization"
                            ? options.organizations
                            : (f?.definition?.options
                                ?.filter((o: Row) => !o.archived)
                                .map((o: Row) => ({
                                  id: o.id,
                                  name: o.label,
                                })) ?? []);
        const update = (next: Condition) =>
          onChange(conditions.map((v, i) => (i === index ? next : v)));
        const ops =
          c.field === "tags" || type === "multiselect"
            ? ["contains", "in", "is_set"]
            : type === "number"
              ? ["eq", "neq", "gte", "lte", "is_set"]
              : type === "date" || type === "boolean"
                ? ["eq", "neq", "is_set"]
                : ["eq", "neq", "in", "is_set"];
        return (
          <div className="automation-condition" key={index}>
            <Field label={`${title} field ${index + 1}`}>
              <select
                value={c.field}
                onChange={(e) =>
                  update({
                    field: e.target.value,
                    op:
                      e.target.value === "tags" ||
                      fields.find((f) => f.id === e.target.value)?.type ===
                        "multiselect"
                        ? "contains"
                        : "eq",
                    value:
                      e.target.value === "waiting" ||
                      fields.find((f) => f.id === e.target.value)?.type ===
                        "boolean"
                        ? true
                        : fields.find((f) => f.id === e.target.value)?.type ===
                            "number"
                          ? 0
                          : "",
                  })
                }
              >
                {fields.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={`${title} comparison ${index + 1}`}>
              <select
                value={c.op}
                onChange={(e) =>
                  update({
                    ...c,
                    op: e.target.value as any,
                    value:
                      e.target.value === "in"
                        ? []
                        : Array.isArray(c.value)
                          ? (c.value[0] ?? "")
                          : c.value,
                  })
                }
              >
                {ops.map((op) => (
                  <option key={op} value={op}>
                    {
                      (
                        {
                          eq: "is",
                          neq: "is not",
                          in: "is any of",
                          contains: "includes",
                          is_set: "has a value",
                          gte: "is at least",
                          lte: "is at most",
                        } as Row
                      )[op]
                    }
                  </option>
                ))}
              </select>
            </Field>
            {c.op !== "is_set" && (
              <Field label={`${title} value ${index + 1}`}>
                {c.field === "tags" ? (
                  c.op === "in" ? (
                    <CommaInput
                      value={Array.isArray(c.value) ? c.value : []}
                      placeholder="billing, urgent"
                      onChange={(value) => update({ ...c, value })}
                    />
                  ) : (
                    <input
                      value={String(c.value ?? "")}
                      placeholder="billing"
                      onChange={(e) => update({ ...c, value: e.target.value })}
                    />
                  )
                ) : type === "boolean" ? (
                  <select
                    value={String(c.value)}
                    onChange={(e) =>
                      update({ ...c, value: e.target.value === "true" })
                    }
                  >
                    <option value="true">Yes</option>
                    <option value="false">No</option>
                  </select>
                ) : type === "number" || type === "date" ? (
                  <input
                    type={type === "date" ? "date" : "number"}
                    value={String(c.value ?? "")}
                    onChange={(e) =>
                      update({
                        ...c,
                        value:
                          type === "number"
                            ? Number(e.target.value)
                            : e.target.value,
                      })
                    }
                  />
                ) : (
                  <select
                    multiple={c.op === "in"}
                    value={
                      c.op === "in"
                        ? Array.isArray(c.value)
                          ? c.value
                          : []
                        : String(c.value ?? "")
                    }
                    onChange={(e) =>
                      update({
                        ...c,
                        value:
                          c.op === "in"
                            ? Array.from(
                                e.target.selectedOptions,
                                (o) => o.value,
                              )
                            : e.target.value,
                      })
                    }
                  >
                    {c.op !== "in" && <option value="">Choose a value</option>}
                    {list.map((v) => (
                      <option key={v.id} value={v.id}>
                        {v.name}
                      </option>
                    ))}
                  </select>
                )}
              </Field>
            )}
            <button
              aria-label={`Remove ${title.toLowerCase()} condition ${index + 1}`}
              onClick={() => onChange(conditions.filter((_, i) => i !== index))}
            >
              Remove
            </button>
          </div>
        );
      })}
      <button
        disabled={conditions.length >= 12}
        onClick={() =>
          onChange([
            ...conditions,
            { field: "status", op: "eq", value: "open" },
          ])
        }
      >
        Add {title.toLowerCase()} condition
      </button>
    </fieldset>
  );
}
function ActionEditor({
  index,
  value: a,
  options,
  onChange,
  remove,
}: {
  index: number;
  value: Action;
  options: Row;
  onChange: (v: Action) => void;
  remove: () => void;
}) {
  const defaults: Row = {
    priority: { type: "priority", value: "normal" },
    tags: { type: "tags", add: [], remove: [] },
    route: { type: "route", teamId: options.teams[0]?.id ?? "", requeue: true },
    note: { type: "note", body: "" },
    notify: {
      type: "notify",
      recipient: "assignee",
      userIds: [],
      body: "",
      email: false,
    },
    reply: { type: "reply", body: "" },
    resolve: { type: "resolve" },
  };
  return (
    <fieldset className="automation-action">
      <legend>Action {index + 1}</legend>
      <div className="automation-fields">
        <Field label={`Action ${index + 1} type`}>
          <select
            value={a.type}
            onChange={(e) => onChange(defaults[e.target.value])}
          >
            {Object.keys(defaults).map((v) => (
              <option key={v} value={v}>
                {labels[v]}
              </option>
            ))}
          </select>
        </Field>
        <button aria-label={`Remove action ${index + 1}`} onClick={remove}>
          Remove action
        </button>
      </div>
      {a.type === "priority" && (
        <Field label={`Action ${index + 1} priority`}>
          <select
            value={a.value}
            onChange={(e) => onChange({ ...a, value: e.target.value as any })}
          >
            {["low", "normal", "high", "urgent"].map((v) => (
              <option key={v}>{v}</option>
            ))}
          </select>
        </Field>
      )}
      {a.type === "tags" && (
        <div className="automation-fields">
          {["add", "remove"].map((k) => (
            <Field key={k} label={`Tags to ${k}`}>
              <CommaInput
                value={a[k as "add" | "remove"]}
                placeholder="Comma-separated tags"
                onChange={(value) => onChange({ ...a, [k]: value })}
              />
            </Field>
          ))}
        </div>
      )}
      {a.type === "route" && (
        <>
          <Field label={`Action ${index + 1} team`}>
            <select
              value={a.teamId}
              onChange={(e) => onChange({ ...a, teamId: e.target.value })}
            >
              <option value="">Choose a team</option>
              {options.teams.map((t: Row) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </Field>
          <label>
            <input
              type="checkbox"
              checked={a.requeue}
              onChange={(e) => onChange({ ...a, requeue: e.target.checked })}
            />{" "}
            Requeue for an available agent
          </label>
          <p className="muted">
            Uses team membership, availability, and capacity. Manual ownership
            and routing policy still apply.
          </p>
        </>
      )}
      {"body" in a && (
        <Field
          label={`Action ${index + 1} ${a.type === "reply" ? "public message" : a.type === "note" ? "private note" : "notification text"}`}
        >
          <textarea
            rows={4}
            value={a.body}
            onChange={(e) => onChange({ ...a, body: e.target.value })}
          />
        </Field>
      )}
      {a.type === "reply" && (
        <p className="automation-caution">
          Customers will see this text. Use a brief follow-up with no sensitive
          information. Variables are not supported.
        </p>
      )}
      {a.type === "notify" && (
        <>
          <Field label={`Action ${index + 1} recipients`}>
            <select
              value={a.recipient}
              onChange={(e) =>
                onChange({ ...a, recipient: e.target.value as any })
              }
            >
              <option value="assignee">Current assignee</option>
              <option value="staff">Selected staff</option>
            </select>
          </Field>
          {a.recipient === "staff" && (
            <Field label={`Action ${index + 1} staff`}>
              <select
                multiple
                value={a.userIds}
                onChange={(e) =>
                  onChange({
                    ...a,
                    userIds: Array.from(
                      e.target.selectedOptions,
                      (o) => o.value,
                    ),
                  })
                }
              >
                {options.members.map((m: Row) => (
                  <option key={m.user_id} value={m.user_id}>
                    {m.name || m.email || m.user_id}
                  </option>
                ))}
              </select>
            </Field>
          )}
          <label>
            <input
              type="checkbox"
              checked={a.email}
              onChange={(e) => onChange({ ...a, email: e.target.checked })}
            />{" "}
            Also send staff email
          </label>
        </>
      )}
      {a.type === "resolve" && (
        <p className="automation-caution">
          Requires a waiting-for-customer timer of at least 1,440 minutes (24
          hours). Customer activity, pending approvals, and uncertain business
          operations prevent closure.
        </p>
      )}
    </fieldset>
  );
}
function AutomationHistory({ ws, id }: { ws: string; id?: string }) {
  const l = useLoad(
    () => api(ws, id ? `/automations/${id}/history` : "/automations/history"),
    [ws, id],
  );
  return (
    <section className="automation-history">
      <div className="automation-history-heading">
        <h2>{id ? "This rule’s history" : "Execution history"}</h2>
        <button onClick={l.reload}>Refresh history</button>
      </div>
      {l.error ? (
        <p role="alert">{l.error}</p>
      ) : !l.data ? (
        <LoadingState />
      ) : (
        <>
          <p className="muted">
            Most recent 100 executions. A completed public reply was published
            to the ticket; email transport is tracked separately.
          </p>
          {!l.data.executions.length && (
            <p>
              No executions yet. Activate a rule, then wait for its next
              matching event.
            </p>
          )}
          {l.data.executions.map((e: Row) => (
            <details key={e.id} className="automation-history-row">
              <summary>
                <strong>
                  {e.rule_name} · v{e.rule_revision}
                </strong>
                <span>
                  {e.status} · {new Date(e.created_at).toLocaleString()}
                </span>
              </summary>
              <a
                href={link(
                  ws,
                  "inbox",
                  `&conversation=${encodeURIComponent(e.conversation_id)}`,
                )}
              >
                {e.subject}
              </a>
              <p>
                {e.reason ||
                  `Scheduled for ${new Date(e.due_at).toLocaleString()}`}
              </p>
              {e.actions.map((a: Row) => (
                <p key={a.index}>
                  {labels[a.kind]} ·{" "}
                  {a.result.semantics ??
                    (a.result.recipients
                      ? `${a.result.recipients.length} recipients`
                      : "Applied")}
                </p>
              ))}
            </details>
          ))}
          {l.data.versions.length > 0 && (
            <details>
              <summary>Saved versions ({l.data.versions.length})</summary>
              {l.data.versions.map((v: Row) => (
                <p key={v.revision}>
                  v{v.revision} · {v.definition.name} ·{" "}
                  {new Date(v.created_at).toLocaleString()} ·{" "}
                  {v.definition.actions
                    .map((a: Row) => labels[a.type])
                    .join(", ")}
                </p>
              ))}
            </details>
          )}
        </>
      )}
    </section>
  );
}
function AutomationNotifications({ ws }: { ws: string }) {
  const l = useLoad(() => api(ws, "/automations/notifications"), [ws]),
    a = useAction();
  return (
    <section className="automation-history">
      <h2>My automation notifications</h2>
      <Notice action={a} error={l.error} />
      {!l.data ? (
        <LoadingState />
      ) : !l.data.notifications.length ? (
        <p>No automation notifications for you.</p>
      ) : (
        l.data.notifications.map((n: Row) => (
          <article key={n.id} className="automation-history-row">
            <a
              href={link(
                ws,
                "inbox",
                `&conversation=${encodeURIComponent(n.conversation_id)}`,
              )}
            >
              {n.subject}
            </a>
            <p>{n.body}</p>
            <small>
              {new Date(n.created_at).toLocaleString()} · Email {n.email_status}
            </small>
            {!n.read_at && (
              <button
                disabled={a.busy}
                onClick={() =>
                  void a.run(async () => {
                    await api(
                      ws,
                      `/automations/notifications/${n.id}/read`,
                      {},
                    );
                    l.reload();
                  })
                }
              >
                Mark read
              </button>
            )}
          </article>
        ))
      )}
    </section>
  );
}
