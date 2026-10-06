import { useState } from "react";
import { api, useLoad } from "./request.js";
import { useAction } from "./useAction.js";
import { useUnsavedChanges, confirmDiscardChanges } from "./unsaved-changes.js";
import { FormFields, FieldControl } from "./ProductivityFields.js";
import {
  FieldDefinition,
  FormDefinition,
  MacroDefinition,
  ViewDefinition,
  type FormField,
  type Values,
} from "../../../packages/platform/src/productivity-contracts.js";
import "./productivity.css";
type Row = Record<string, any>;
const choices = [
  ["text", "Single-line text"],
  ["multiline", "Multiline text"],
  ["number", "Number"],
  ["boolean", "Yes / no"],
  ["date", "Date"],
  ["select", "Single choice"],
  ["multiselect", "Multiple choices"],
];
const builtins = [
  "status",
  "priority",
  "assignee",
  "team",
  "channel",
  "tags",
  "form",
  "created",
  "updated",
  "sla",
];
const columns = [
  "subject",
  "customer",
  "status",
  "priority",
  "assignee",
  "team",
  "channel",
  "tags",
  "form",
  "created",
  "updated",
  "sla",
];
const clone = <T,>(v: T): T => structuredClone(v);
export function ProductivityPage({ ws }: { ws: string }) {
  const config = useLoad(() => api(ws, "/productivity"), [ws]);
  const [tab, setTab] = useState("macros");
  if (config.error)
    return (
      <div className="alert" role="alert">
        {config.error}
        <button onClick={config.reload}>Try again</button>
      </div>
    );
  if (!config.data) return <p role="status">Loading productivity tools…</p>;
  return (
    <div className="productivity-page">
      <header className="page-heading">
        <div>
          <span className="eyebrow">STAFF PRODUCTIVITY</span>
          <h1>Forms, macros & views</h1>
          <p>Collect useful details and make daily ticket work consistent.</p>
        </div>
      </header>
      <nav className="settings-tabs" aria-label="Productivity sections">
        {[
          ["fields", "Ticket fields"],
          ["forms", "Request forms"],
          ["macros", "Macros"],
          ["views", "Saved views"],
        ]
          .filter(
            ([key]) =>
              !["fields", "forms"].includes(key) ||
              config.data.permissions["fields:manage"],
          )
          .map(([key, label]) => (
            <button
              key={key}
              aria-current={tab === key ? "page" : undefined}
              onClick={() => {
                if (tab !== key && confirmDiscardChanges()) setTab(key);
              }}
            >
              {label}
            </button>
          ))}
      </nav>
      <ProductivityEditor
        key={`${ws}:${tab}`}
        ws={ws}
        kind={tab}
        config={config.data}
      />
    </div>
  );
}
function ProductivityEditor({
  ws,
  kind,
  config,
}: {
  ws: string;
  kind: string;
  config: Row;
}) {
  const path =
    kind === "fields"
      ? "ticket-fields"
      : kind === "forms"
        ? "ticket-forms"
        : kind === "views"
          ? "saved-views"
          : "macros";
  const list = useLoad(
    () => api(ws, `/${path}?${kind === "forms" ? "admin=1" : "archived=1"}`),
    [ws, path],
  );
  const fieldsLoad = useLoad(() => api(ws, "/ticket-fields"), [ws]);
  const members = useLoad(() => api(ws, "/members"), [ws]);
  const fields: Row[] = fieldsLoad.data?.fields ?? [];
  const filterField = (key: string): Row => {
    const custom = fields.find((f) => `field.${f.id}` === key);
    if (custom) return custom;
    const values: Record<string, string[]> = {
      status: ["open", "needs_staff", "waiting_approval", "resolved"],
      priority: ["low", "normal", "high", "urgent"],
      channel: ["portal", "widget", "email", "zendesk"],
      sla: ["at risk", "overdue", "on track"],
    };
    const named = (rows: Row[]) =>
      rows.map((r) => ({ id: r.id, label: r.name }));
    const options =
      values[key]?.map((value) => ({
        id: value,
        label: value.replaceAll("_", " "),
      })) ??
      (key === "assignee"
        ? [
            { id: "me", label: "Me" },
            { id: "unassigned", label: "Unassigned" },
            ...(members.data?.members ?? []).map((m: Row) => ({
              id: m.user_id,
              label: m.name || m.email || m.user_id,
            })),
          ]
        : key === "team"
          ? [
              { id: "my_teams", label: "My teams" },
              ...named(config.viewTeams ?? config.teams),
            ]
          : key === "form"
            ? named(config.formOptions ?? [])
            : []);
    return {
      type: ["created", "updated"].includes(key)
        ? "date"
        : options.length
          ? "select"
          : "text",
      options,
    };
  };
  const [selected, setSelected] = useState<Row | null>(null),
    [draft, setDraft] = useState<Row | null>(null),
    [baseline, setBaseline] = useState(""),
    [search, setSearch] = useState(""),
    [preview, setPreview] = useState<Values>({});
  const dirty = !!draft && JSON.stringify(draft) !== baseline;
  useUnsavedChanges(dirty);
  const action = useAction();
  const change = (key: string, value: any) =>
    setDraft((d) => ({ ...d, [key]: value }));
  const canCreate =
    kind === "fields" || kind === "forms"
      ? config.permissions["fields:manage"]
      : config.permissions[`${kind}:personal`] ||
        config.permissions[`${kind}:shared`];
  const select = (row: Row | null, example?: Row) => {
    if (dirty && !confirmDiscardChanges("Discard changes in this editor?"))
      return;
    let value: Row;
    if (kind === "fields")
      value = row
        ? FieldDefinition.parse(
            Object.fromEntries(
              Object.entries(row).filter(
                ([k]) => !["id", "revision", "ownerId"].includes(k),
              ),
            ),
          )
        : FieldDefinition.parse({ label: "", type: "text" });
    else if (kind === "forms")
      value = row
        ? {
            ...row,
            fields: row.fields.map(({ definition, ...entry }: Row) => entry),
          }
        : {
            name: "",
            description: "",
            position: 0,
            active: false,
            archived: false,
            emailDefault: false,
            defaultTeamId: null,
            fields: [],
          };
    else if (kind === "macros")
      value = row ?? {
        name: "",
        description: "",
        scope: "personal",
        teamId: null,
        body: "",
        note: false,
        changes: {},
        archived: false,
        ...example,
      };
    else
      value = row ?? {
        name: "",
        scope: "personal",
        teamId: null,
        filters: [],
        sort: "updated_desc",
        columns: ["subject", "customer", "status", "priority", "assignee"],
        archived: false,
      };
    value = clone(value);
    for (const key of [
      "id",
      "revision",
      "ownerId",
      "canManage",
      "builtin",
      "needsReview",
    ])
      delete value[key];
    if (row?.builtin) {
      value.scope = "personal";
      value.name = `${row.name} copy`;
    }
    setSelected(row?.builtin ? null : row);
    setDraft(value);
    setBaseline(JSON.stringify(value));
    setPreview({});
    action.setError("");
    action.setSuccess("");
  };
  // Empty names are intentional in an unsaved editor; server schemas validate Save.
  const newEditor = () => {
    if (kind === "fields") {
      if (dirty && !confirmDiscardChanges("Discard changes in this editor?"))
        return;
      const d = {
        label: "",
        type: "text",
        description: "",
        position: 0,
        customerVisible: false,
        customerEditable: false,
        options: [],
        maxLength: 500,
        archived: false,
      };
      setDraft(d);
      setSelected(null);
      setBaseline(JSON.stringify(d));
      action.setError("");
    } else select(null);
  };
  const rows: Row[] = list.data?.[kind] ?? [];
  const patch = (key: string, value: any) =>
    change("changes", { ...draft!.changes, [key]: value });
  return (
    <div className="productivity-layout">
      <section className="productivity-library" aria-label={`${kind} library`}>
        <div className="section-heading">
          <h2>
            {kind === "fields"
              ? "Ticket fields"
              : kind === "forms"
                ? "Request forms"
                : kind === "macros"
                  ? "Macros"
                  : "Saved views"}
          </h2>
          {canCreate && (
            <button onClick={newEditor}>
              Create{" "}
              {kind === "fields"
                ? "field"
                : kind === "forms"
                  ? "form"
                  : kind === "macros"
                    ? "macro"
                    : "view"}
            </button>
          )}
        </div>
        <label>
          Search
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </label>
        {list.error && (
          <p role="alert">
            {list.error}
            <button onClick={list.reload}>Try again</button>
          </p>
        )}
        {!list.data && !list.error && <p role="status">Loading…</p>}
        {rows
          .filter((r) =>
            (r.name ?? r.label).toLowerCase().includes(search.toLowerCase()),
          )
          .map((r) => (
            <button
              className="productivity-library-row"
              key={r.id}
              aria-current={selected?.id === r.id ? "true" : undefined}
              onClick={() => select(r)}
            >
              <strong>{r.name ?? r.label}</strong>
              <small>
                {r.archived
                  ? "Archived"
                  : kind === "forms"
                    ? r.needsReview
                      ? "Review field changes"
                      : r.active
                        ? "Active"
                        : "Draft"
                    : (r.scope ?? r.type)}
                {r.builtin ? " · Default" : ""}
              </small>
            </button>
          ))}
        {list.data && !rows.length && (
          <p>No {kind} yet. Create one to get started.</p>
        )}
        {kind === "macros" && canCreate && (
          <details>
            <summary>Start from an editable example</summary>
            {list.data?.examples?.map((m: Row) => (
              <button key={m.name} onClick={() => select(null, m)}>
                {m.name}
              </button>
            ))}
          </details>
        )}
      </section>
      <section
        className="panel productivity-editor"
        aria-label={`${kind} editor`}
      >
        {!draft ? (
          <div className="empty">
            <h3>Choose an item to review</h3>
            <p>
              {kind === "macros"
                ? "Macros stage editable drafts. Sending still requires the composer’s Send or Save action."
                : kind === "views"
                  ? "A shared view never grants access to another team’s tickets."
                  : "Stable identifiers and submission versions preserve historical ticket meaning."}
            </p>
          </div>
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void action.run(async () => {
                const schema =
                  kind === "fields"
                    ? FieldDefinition
                    : kind === "forms"
                      ? FormDefinition
                      : kind === "macros"
                        ? MacroDefinition
                        : ViewDefinition;
                const definition = schema.parse(draft);
                const result = await api(
                  ws,
                  `/${path}${selected ? `/${selected.id}` : ""}`,
                  {
                    definition,
                    ...(selected ? { revision: selected.revision } : {}),
                  },
                  selected ? "PUT" : "POST",
                );
                setSelected(result);
                setBaseline(JSON.stringify(draft));
                list.reload();
                fieldsLoad.reload();
              }, "Saved.");
            }}
          >
            <h2>
              {selected ? "Edit" : "Create"}{" "}
              {kind === "fields"
                ? "ticket field"
                : kind === "forms"
                  ? "request form"
                  : kind === "macros"
                    ? "macro"
                    : "saved view"}
            </h2>
            {action.error && (
              <p className="alert" role="alert">
                {action.error}
              </p>
            )}
            {action.success && (
              <p className="success" role="status">
                {action.success}
              </p>
            )}
            <fieldset
              disabled={
                action.busy ||
                Boolean(
                  selected &&
                    !selected.builtin &&
                    (kind === "macros" || kind === "views") &&
                    selected.canManage === false,
                )
              }
              className="productivity-form-fields"
            >
              <label>
                {kind === "fields" ? "Field label" : "Name"}
                <input
                  required
                  maxLength={120}
                  value={draft.label ?? draft.name}
                  onChange={(e) =>
                    change(kind === "fields" ? "label" : "name", e.target.value)
                  }
                />
              </label>
              {kind !== "views" && (
                <label>
                  Description / help text
                  <textarea
                    rows={2}
                    maxLength={500}
                    value={draft.description}
                    onChange={(e) => change("description", e.target.value)}
                  />
                </label>
              )}
              {kind === "fields" && (
                <>
                  <label>
                    Field type
                    <select
                      value={draft.type}
                      disabled={!!selected}
                      onChange={(e) => change("type", e.target.value)}
                    >
                      {choices.map(([v, l]) => (
                        <option key={v} value={v}>
                          {l}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Order
                    <input
                      type="number"
                      min={0}
                      max={1000}
                      value={draft.position}
                      onChange={(e) =>
                        change("position", Number(e.target.value))
                      }
                    />
                  </label>
                  <label className="checkbox">
                    <input
                      type="checkbox"
                      checked={draft.customerVisible}
                      onChange={(e) => {
                        setDraft({
                          ...draft,
                          customerVisible: e.target.checked,
                          customerEditable:
                            e.target.checked && draft.customerEditable,
                        });
                      }}
                    />
                    Visible to customers
                  </label>
                  <label className="checkbox">
                    <input
                      type="checkbox"
                      checked={draft.customerEditable}
                      disabled={!draft.customerVisible}
                      onChange={(e) =>
                        change("customerEditable", e.target.checked)
                      }
                    />
                    Customers may edit
                  </label>
                  {["text", "multiline"].includes(draft.type) && (
                    <label>
                      Maximum characters
                      <input
                        type="number"
                        min={1}
                        max={draft.type === "text" ? 500 : 6000}
                        value={draft.maxLength}
                        onChange={(e) =>
                          change("maxLength", Number(e.target.value))
                        }
                      />
                    </label>
                  )}
                  {draft.type === "number" && (
                    <div className="form-grid">
                      {["min", "max"].map((key) => (
                        <label key={key}>
                          {key === "min" ? "Minimum" : "Maximum"}
                          <input
                            type="number"
                            step="any"
                            value={draft[key] ?? ""}
                            onChange={(e) =>
                              change(
                                key,
                                e.target.value === ""
                                  ? undefined
                                  : Number(e.target.value),
                              )
                            }
                          />
                        </label>
                      ))}
                    </div>
                  )}
                  {["select", "multiselect"].includes(draft.type) && (
                    <>
                      <h3>Options</h3>
                      <p className="field-hint">
                        Each option keeps its ID. Archive obsolete options;
                        historical submissions retain their original labels.
                      </p>
                      {draft.options.map((o: Row, i: number) => (
                        <div className="productivity-option" key={o.id}>
                          <label>
                            Option {i + 1}
                            <input
                              value={o.label}
                              required
                              onChange={(e) =>
                                change(
                                  "options",
                                  draft.options.map((v: Row, index: number) =>
                                    index === i
                                      ? { ...v, label: e.target.value }
                                      : v,
                                  ),
                                )
                              }
                            />
                          </label>
                          <label className="checkbox">
                            <input
                              type="checkbox"
                              checked={o.archived}
                              onChange={(e) =>
                                change(
                                  "options",
                                  draft.options.map((v: Row, index: number) =>
                                    index === i
                                      ? { ...v, archived: e.target.checked }
                                      : v,
                                  ),
                                )
                              }
                            />
                            Archived
                          </label>
                        </div>
                      ))}
                      <button
                        type="button"
                        onClick={() =>
                          change("options", [
                            ...draft.options,
                            {
                              id: crypto.randomUUID(),
                              label: "",
                              archived: false,
                            },
                          ])
                        }
                      >
                        Add option
                      </button>
                    </>
                  )}
                </>
              )}
              {kind === "forms" && (
                <>
                  <label>
                    Form order
                    <input
                      type="number"
                      min={0}
                      max={1000}
                      value={draft.position}
                      onChange={(e) =>
                        change("position", Number(e.target.value))
                      }
                    />
                  </label>
                  <label className="checkbox">
                    <input
                      type="checkbox"
                      checked={draft.active}
                      onChange={(e) => change("active", e.target.checked)}
                    />
                    Active in the customer portal
                  </label>
                  <label className="checkbox">
                    <input
                      type="checkbox"
                      checked={draft.emailDefault}
                      onChange={(e) => change("emailDefault", e.target.checked)}
                    />
                    Default email intake form (missing required values are
                    collected later)
                  </label>
                  <label>
                    Default team
                    <select
                      value={draft.defaultTeamId ?? ""}
                      onChange={(e) =>
                        change("defaultTeamId", e.target.value || null)
                      }
                    >
                      <option value="">No form team</option>
                      {(config.formTeams ?? config.teams).map((t: Row) => (
                        <option key={t.id} value={t.id}>
                          {t.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <h3>Form fields</h3>
                  {draft.fields.map((entry: Row, index: number) => (
                    <div
                      className="productivity-form-entry"
                      key={entry.fieldId}
                    >
                      <div className="section-heading">
                        <strong>
                          {fields.find((f) => f.id === entry.fieldId)?.label ??
                            entry.fieldId}
                        </strong>
                        <div className="button-row">
                          <button
                            type="button"
                            disabled={index === 0}
                            aria-label={`Move field ${index + 1} up`}
                            onClick={() => {
                              const next = [...draft.fields];
                              [next[index - 1], next[index]] = [
                                next[index],
                                next[index - 1],
                              ];
                              change("fields", next);
                            }}
                          >
                            ↑
                          </button>
                          <button
                            type="button"
                            disabled={index === draft.fields.length - 1}
                            aria-label={`Move field ${index + 1} down`}
                            onClick={() => {
                              const next = [...draft.fields];
                              [next[index + 1], next[index]] = [
                                next[index],
                                next[index + 1],
                              ];
                              change("fields", next);
                            }}
                          >
                            ↓
                          </button>
                          <button
                            type="button"
                            onClick={() =>
                              change(
                                "fields",
                                draft.fields.filter(
                                  (_: Row, i: number) => i !== index,
                                ),
                              )
                            }
                          >
                            Remove
                          </button>
                        </div>
                      </div>
                      <label className="checkbox">
                        <input
                          type="checkbox"
                          checked={entry.required}
                          onChange={(e) =>
                            change(
                              "fields",
                              draft.fields.map((f: Row, i: number) =>
                                i === index
                                  ? { ...f, required: e.target.checked }
                                  : f,
                              ),
                            )
                          }
                        />
                        Always required when visible
                      </label>
                      {["visibleWhen", "requiredWhen"].map((key) => (
                        <RuleEditor
                          key={key}
                          label={
                            key === "visibleWhen"
                              ? "Visible when all match"
                              : "Required when all match"
                          }
                          rules={entry[key]}
                          fields={fields.filter(
                            (f) =>
                              draft.fields.some(
                                (e: Row) => e.fieldId === f.id,
                              ) && f.id !== entry.fieldId,
                          )}
                          change={(rules) =>
                            change(
                              "fields",
                              draft.fields.map((f: Row, i: number) =>
                                i === index ? { ...f, [key]: rules } : f,
                              ),
                            )
                          }
                        />
                      ))}
                    </div>
                  ))}
                  <label>
                    Add field
                    <select
                      aria-label="Add field"
                      value=""
                      onChange={(e) => {
                        if (e.target.value)
                          change("fields", [
                            ...draft.fields,
                            {
                              fieldId: e.target.value,
                              required: false,
                              visibleWhen: [],
                              requiredWhen: [],
                            },
                          ]);
                      }}
                    >
                      <option value="">Choose a customer-editable field</option>
                      {fields
                        .filter(
                          (f) =>
                            f.customerVisible &&
                            f.customerEditable &&
                            !draft.fields.some((e: Row) => e.fieldId === f.id),
                        )
                        .map((f) => (
                          <option key={f.id} value={f.id}>
                            {f.label}
                          </option>
                        ))}
                    </select>
                  </label>
                  <details>
                    <summary>Preview this form</summary>
                    <p>
                      Subject and message are always included. This preview does
                      not create a ticket.
                    </p>
                    <FormFields
                      fields={
                        draft.fields
                          .map((e: Row) => ({
                            ...e,
                            definition: fields.find((f) => f.id === e.fieldId),
                          }))
                          .filter((e: Row) => e.definition) as FormField[]
                      }
                      values={preview}
                      onChange={setPreview}
                      validation={false}
                    />
                  </details>
                </>
              )}
              {(kind === "macros" || kind === "views") && (
                <>
                  <label>
                    Sharing
                    <select
                      value={draft.scope}
                      onChange={(e) =>
                        setDraft({
                          ...draft,
                          scope: e.target.value,
                          teamId: null,
                        })
                      }
                    >
                      {config.permissions[`${kind}:personal`] && (
                        <option value="personal">Only me</option>
                      )}
                      {config.permissions[`${kind}:shared`] && (
                        <>
                          <option value="team">My team</option>
                          <option value="workspace">Workspace</option>
                        </>
                      )}
                    </select>
                  </label>
                  {draft.scope === "team" && (
                    <label>
                      Team
                      <select
                        required
                        value={draft.teamId ?? ""}
                        onChange={(e) =>
                          change("teamId", e.target.value || null)
                        }
                      >
                        <option value="">Choose your team</option>
                        {config.teams.map((t: Row) => (
                          <option key={t.id} value={t.id}>
                            {t.name}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                </>
              )}
              {kind === "macros" && (
                <>
                  <label>
                    Response type
                    <select
                      value={draft.note ? "note" : "reply"}
                      onChange={(e) =>
                        change("note", e.target.value === "note")
                      }
                    >
                      <option value="reply">Public reply draft</option>
                      <option value="note">Internal note draft</option>
                    </select>
                  </label>
                  <label>
                    Reply or note template
                    <textarea
                      rows={8}
                      maxLength={12000}
                      value={draft.body}
                      onChange={(e) => change("body", e.target.value)}
                    />
                  </label>
                  <p className="field-hint">
                    Placeholders:{" "}
                    {
                      "{{customer.name}}, {{customer.email}}, {{ticket.id}}, {{ticket.subject}}, {{ticket.priority}}"
                    }
                    . Custom fields: {"{{field.FIELD_ID}}"}. Missing values are
                    marked in preview. Templates cannot execute code.
                  </p>
                  <h3>Proposed ticket changes</h3>
                  <p className="field-hint">
                    Optional changes are staged for review and committed only
                    with the normal Send or Save action.
                  </p>
                  <div className="form-grid">
                    <label>
                      Priority
                      <select
                        aria-label="Priority"
                        value={draft.changes.priority ?? ""}
                        onChange={(e) =>
                          patch("priority", e.target.value || undefined)
                        }
                      >
                        <option value="">Keep unchanged</option>
                        {["low", "normal", "high", "urgent"].map((v) => (
                          <option key={v}>{v}</option>
                        ))}
                      </select>
                    </label>
                    <label>
                      Status
                      <select
                        value={draft.changes.status ?? ""}
                        onChange={(e) =>
                          patch("status", e.target.value || undefined)
                        }
                      >
                        <option value="">Keep unchanged</option>
                        <option value="open">Open</option>
                        <option value="resolved">Resolved</option>
                      </select>
                    </label>
                    <label>
                      Replace tags (comma separated)
                      <input
                        value={(draft.changes.tags ?? []).join(", ")}
                        onChange={(e) =>
                          patch(
                            "tags",
                            e.target.value
                              ? e.target.value
                                  .split(",")
                                  .map((v) => v.trim())
                                  .filter(Boolean)
                              : undefined,
                          )
                        }
                      />
                    </label>
                    <label>
                      Team
                      <select
                        value={
                          draft.changes.teamId === null
                            ? "none"
                            : (draft.changes.teamId ?? "")
                        }
                        onChange={(e) =>
                          patch(
                            "teamId",
                            e.target.value === ""
                              ? undefined
                              : e.target.value === "none"
                                ? null
                                : e.target.value,
                          )
                        }
                      >
                        <option value="">Keep unchanged</option>
                        <option value="none">Remove team</option>
                        {(config.viewTeams ?? config.teams).map((t: Row) => (
                          <option key={t.id} value={t.id}>
                            {t.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      Assignee
                      <select
                        value={
                          draft.changes.assignedTo === null
                            ? "none"
                            : (draft.changes.assignedTo ?? "")
                        }
                        onChange={(e) =>
                          patch(
                            "assignedTo",
                            e.target.value === ""
                              ? undefined
                              : e.target.value === "none"
                                ? null
                                : e.target.value,
                          )
                        }
                      >
                        <option value="">Keep unchanged</option>
                        <option value="none">Unassign</option>
                        {members.data?.members.map((m: Row) => (
                          <option key={m.user_id} value={m.user_id}>
                            {m.name}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                  {Object.entries(draft.changes.fields ?? {}).map(
                    ([id, value]) => {
                      const f = fields.find((f) => f.id === id);
                      return f ? (
                        <div key={id}>
                          <FieldControl
                            field={f as any}
                            value={value as any}
                            onChange={(v) =>
                              patch("fields", {
                                ...draft.changes.fields,
                                [id]: v,
                              })
                            }
                          />
                          <button
                            type="button"
                            onClick={() => {
                              const next = { ...draft.changes.fields };
                              delete next[id];
                              patch("fields", next);
                            }}
                          >
                            Remove field change
                          </button>
                        </div>
                      ) : (
                        <p key={id}>Unavailable field: {id}</p>
                      );
                    },
                  )}
                  <label>
                    Add custom field change
                    <select
                      value=""
                      onChange={(e) =>
                        e.target.value &&
                        patch("fields", {
                          ...draft.changes.fields,
                          [e.target.value]: null,
                        })
                      }
                    >
                      <option value="">Choose a field</option>
                      {fields
                        .filter(
                          (f) =>
                            !Object.hasOwn(draft.changes.fields ?? {}, f.id),
                        )
                        .map((f) => (
                          <option key={f.id} value={f.id}>
                            {f.label}
                          </option>
                        ))}
                    </select>
                  </label>
                </>
              )}
              {kind === "views" && (
                <>
                  <h3>Match all filters</h3>
                  {draft.filters.map((f: Row, i: number) => (
                    <div className="saved-view-filter" key={i}>
                      <label>
                        Field
                        <select
                          aria-label="Field"
                          value={f.field}
                          onChange={(e) =>
                            change(
                              "filters",
                              draft.filters.map((v: Row, n: number) =>
                                n === i
                                  ? {
                                      field: e.target.value,
                                      op: "eq",
                                      value: "",
                                    }
                                  : v,
                              ),
                            )
                          }
                        >
                          {builtins.map((v) => (
                            <option key={v}>{v}</option>
                          ))}
                          {fields.map((v) => (
                            <option key={v.id} value={`field.${v.id}`}>
                              {v.label}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label>
                        Operator
                        <select
                          value={f.op}
                          onChange={(e) =>
                            change(
                              "filters",
                              draft.filters.map((v: Row, n: number) =>
                                n === i
                                  ? {
                                      ...v,
                                      op: e.target.value,
                                      value: e.target.value === "in" ? [] : "",
                                    }
                                  : v,
                              ),
                            )
                          }
                        >
                          {[
                            "eq",
                            "neq",
                            "in",
                            "contains",
                            "is_set",
                            "before",
                            "after",
                            "gte",
                            "lte",
                          ].map((v) => (
                            <option key={v}>{v}</option>
                          ))}
                        </select>
                      </label>
                      {f.op !== "is_set" && (
                        <FilterValue
                          field={filterField(f.field)}
                          operator={f.op}
                          value={f.value}
                          change={(value) =>
                            change(
                              "filters",
                              draft.filters.map((v: Row, n: number) =>
                                n === i ? { ...v, value } : v,
                              ),
                            )
                          }
                        />
                      )}
                      <button
                        type="button"
                        onClick={() =>
                          change(
                            "filters",
                            draft.filters.filter(
                              (_: Row, n: number) => n !== i,
                            ),
                          )
                        }
                      >
                        Remove
                      </button>
                    </div>
                  ))}
                  <button
                    type="button"
                    disabled={draft.filters.length >= 12}
                    onClick={() =>
                      change("filters", [
                        ...draft.filters,
                        { field: "status", op: "eq", value: "open" },
                      ])
                    }
                  >
                    Add filter
                  </button>
                  <p className="field-hint">
                    Use “me” or “unassigned” for assignee; “my_teams” for team;
                    “at risk”, “overdue”, or “on track” for SLA. For “in”,
                    separate values with commas. Statuses: open, needs_staff,
                    waiting_approval, resolved. Invalid and archived-field
                    filters fail safely.
                  </p>
                  <label>
                    Sort
                    <select
                      value={draft.sort}
                      onChange={(e) => change("sort", e.target.value)}
                    >
                      {[
                        ["updated_desc", "Latest activity"],
                        ["created_desc", "Newest first"],
                        ["created_asc", "Oldest first"],
                        ["priority_desc", "Highest priority"],
                        ["sla_asc", "Next SLA deadline"],
                      ].map(([v, l]) => (
                        <option key={v} value={v}>
                          {l}
                        </option>
                      ))}
                    </select>
                  </label>
                  <fieldset>
                    <legend>Visible columns (up to 12)</legend>
                    {[...columns, ...fields.map((f) => `field.${f.id}`)].map(
                      (col) => (
                        <label className="checkbox" key={col}>
                          <input
                            type="checkbox"
                            checked={draft.columns.includes(col)}
                            disabled={
                              col === "subject" ||
                              (!draft.columns.includes(col) &&
                                draft.columns.length >= 12)
                            }
                            onChange={(e) =>
                              change(
                                "columns",
                                e.target.checked
                                  ? [...draft.columns, col]
                                  : draft.columns.filter(
                                      (c: string) => c !== col,
                                    ),
                              )
                            }
                          />
                          {fields.find((f) => `field.${f.id}` === col)?.label ??
                            col}
                        </label>
                      ),
                    )}
                  </fieldset>
                </>
              )}
              {selected && (
                <label className="checkbox">
                  <input
                    type="checkbox"
                    checked={draft.archived}
                    onChange={(e) => change("archived", e.target.checked)}
                  />
                  Archived — keep history, stop new use
                </label>
              )}
              <div className="button-row">
                <button
                  className="primary"
                  disabled={action.busy || (!dirty && !!selected)}
                >
                  {action.busy ? "Saving…" : "Save"}
                </button>
                <button
                  type="button"
                  disabled={action.busy}
                  onClick={() => {
                    if (
                      !dirty ||
                      confirmDiscardChanges("Discard changes in this editor?")
                    ) {
                      setDraft(null);
                      setSelected(null);
                    }
                  }}
                >
                  Cancel
                </button>
                {dirty && <span role="status">Unsaved changes</span>}
              </div>
            </fieldset>
          </form>
        )}
      </section>
    </div>
  );
}
function RuleEditor({
  label,
  rules,
  fields,
  change,
}: {
  label: string;
  rules: Row[];
  fields: Row[];
  change: (rules: Row[]) => void;
}) {
  return (
    <details className="form-rule-editor" open={rules.length > 0}>
      <summary>
        {label}
        {rules.length
          ? ` · ${rules.length} condition${rules.length === 1 ? "" : "s"}`
          : " · Optional"}
      </summary>
      {!rules.length && <p className="field-hint">No condition.</p>}
      {rules.map((r, i) => (
        <div className="saved-view-filter" key={i}>
          <label>
            Depends on
            <select
              value={r.fieldId}
              onChange={(e) =>
                change(
                  rules.map((v, n) =>
                    n === i ? { ...v, fieldId: e.target.value } : v,
                  ),
                )
              }
            >
              {fields.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            Operator
            <select
              value={r.op}
              onChange={(e) =>
                change(
                  rules.map((v, n) =>
                    n === i
                      ? {
                          ...v,
                          op: e.target.value,
                          value: e.target.value === "in" ? [] : undefined,
                        }
                      : v,
                  ),
                )
              }
            >
              {["eq", "neq", "in", "contains", "is_set"].map((v) => (
                <option key={v}>{v}</option>
              ))}
            </select>
          </label>
          {r.op !== "is_set" && (
            <FilterValue
              field={fields.find((f) => f.id === r.fieldId)}
              operator={r.op}
              value={r.value}
              change={(value) =>
                change(rules.map((v, n) => (n === i ? { ...v, value } : v)))
              }
            />
          )}
          <button
            type="button"
            onClick={() => change(rules.filter((_, n) => n !== i))}
          >
            Remove condition
          </button>
        </div>
      ))}
      <button
        type="button"
        disabled={!fields.length || rules.length >= 8}
        onClick={() =>
          change([...rules, { fieldId: fields[0].id, op: "is_set" }])
        }
      >
        Add condition
      </button>
      <p className="field-hint">
        Choose option labels directly. “in” matches any selected value; text
        lists use commas. Up to eight dependencies; cycles are rejected.
      </p>
    </details>
  );
}

function FilterValue({
  field,
  operator,
  value,
  change,
}: {
  field?: Row;
  operator: string;
  value: any;
  change: (value: any) => void;
}) {
  const options =
    field?.options?.filter((option: Row) => !option.archived) ?? [];
  const multiple =
    operator === "in" ||
    (field?.type === "multiselect" && ["eq", "neq"].includes(operator));
  if (options.length && multiple)
    return (
      <fieldset className="filter-value-options">
        <legend>Values</legend>
        {options.map((option: Row) => (
          <label className="checkbox" key={option.id}>
            <input
              type="checkbox"
              checked={Array.isArray(value) && value.includes(option.id)}
              onChange={(e) =>
                change(
                  e.target.checked
                    ? [...(Array.isArray(value) ? value : []), option.id]
                    : (Array.isArray(value) ? value : []).filter(
                        (v) => v !== option.id,
                      ),
                )
              }
            />
            {option.label}
          </label>
        ))}
      </fieldset>
    );
  if (options.length || field?.type === "boolean")
    return (
      <label>
        Value
        <select
          aria-label="Value"
          value={typeof value === "boolean" ? String(value) : (value ?? "")}
          onChange={(e) =>
            change(
              field?.type === "boolean"
                ? e.target.value === ""
                  ? undefined
                  : e.target.value === "true"
                : e.target.value,
            )
          }
        >
          <option value="">Choose a value</option>
          {field?.type === "boolean" ? (
            <>
              <option value="true">Yes</option>
              <option value="false">No</option>
            </>
          ) : (
            options.map((option: Row) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))
          )}
        </select>
      </label>
    );
  return (
    <label>
      Value
      <input
        type={
          multiple
            ? "text"
            : field?.type === "number"
              ? "number"
              : field?.type === "date"
                ? "date"
                : "text"
        }
        value={Array.isArray(value) ? value.join(", ") : (value ?? "")}
        onChange={(e) =>
          change(
            multiple
              ? e.target.value
                  .split(",")
                  .map((v) => v.trim())
                  .filter(Boolean)
              : field?.type === "number"
                ? e.target.value === ""
                  ? undefined
                  : Number(e.target.value)
                : e.target.value,
          )
        }
      />
    </label>
  );
}
