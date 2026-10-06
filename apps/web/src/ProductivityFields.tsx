import { useEffect, useState } from "react";
import { api, customerApi, useLoad } from "./request.js";
import { useAction } from "./useAction.js";
import { useUnsavedChanges, confirmDiscardChanges } from "./unsaved-changes.js";
import {
  visibleFormFields,
  matchesConditions,
  type FormField,
  type TicketField,
  type Values,
} from "../../../packages/platform/src/productivity-contracts.js";
import "./productivity.css";
export function FieldControl({
  field,
  value,
  onChange,
  required = false,
  disabled = false,
  validation = true,
}: {
  field: TicketField;
  value: Values[string] | undefined;
  onChange: (v: Values[string]) => void;
  required?: boolean;
  disabled?: boolean;
  validation?: boolean;
}) {
  const id = `ticket-field-${field.id}`;
  return (
    <div className="productivity-field">
      <label htmlFor={id}>
        {field.label}
        {required && " *"}
      </label>
      {field.description && (
        <p id={`${id}-help`} className="field-hint">
          {field.description}
        </p>
      )}
      {field.type === "multiline" ? (
        <textarea
          id={id}
          aria-describedby={`${id}-help`}
          rows={3}
          maxLength={field.maxLength}
          value={String(value ?? "")}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
          required={required && validation}
        />
      ) : field.type === "select" || field.type === "boolean" ? (
        <select
          id={id}
          aria-describedby={`${id}-help`}
          value={value === null || value === undefined ? "" : String(value)}
          onChange={(e) =>
            onChange(
              e.target.value === ""
                ? null
                : field.type === "boolean"
                  ? e.target.value === "true"
                  : e.target.value,
            )
          }
          disabled={disabled}
          required={required && validation}
        >
          <option value="">Choose…</option>
          {field.type === "boolean" ? (
            <>
              <option value="true">Yes</option>
              <option value="false">No</option>
            </>
          ) : (
            field.options
              .filter((o) => !o.archived)
              .map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label}
                </option>
              ))
          )}
        </select>
      ) : field.type === "multiselect" ? (
        <fieldset id={id} disabled={disabled} aria-describedby={`${id}-help`}>
          <legend className="sr-only">{field.label}</legend>
          {field.options
            .filter((o) => !o.archived)
            .map((o) => (
              <label key={o.id} className="checkbox">
                <input
                  type="checkbox"
                  checked={Array.isArray(value) && value.includes(o.id)}
                  onChange={(e) =>
                    onChange(
                      e.target.checked
                        ? [...(Array.isArray(value) ? value : []), o.id]
                        : (Array.isArray(value) ? value : []).filter(
                            (v) => v !== o.id,
                          ),
                    )
                  }
                />
                {o.label}
              </label>
            ))}
        </fieldset>
      ) : (
        <input
          id={id}
          aria-describedby={`${id}-help`}
          type={
            field.type === "number"
              ? "number"
              : field.type === "date"
                ? "date"
                : "text"
          }
          step={field.type === "number" ? "any" : undefined}
          min={field.min}
          max={field.max}
          maxLength={Math.min(field.maxLength, 500)}
          required={required && validation}
          value={String(value ?? "")}
          onChange={(e) =>
            onChange(
              field.type === "number"
                ? e.target.value === ""
                  ? null
                  : Number(e.target.value)
                : e.target.value,
            )
          }
          disabled={disabled}
        />
      )}
    </div>
  );
}
export function FormFields({
  fields,
  values,
  onChange,
  disabled = false,
  validation = true,
}: {
  fields: FormField[];
  values: Values;
  onChange: (v: Values) => void;
  disabled?: boolean;
  validation?: boolean;
}) {
  return (
    <div className="productivity-fields">
      {visibleFormFields(fields, values).map((entry) => (
        <FieldControl
          key={entry.fieldId}
          field={entry.definition}
          value={values[entry.fieldId]}
          required={Boolean(
            entry.required ||
              (entry.requiredWhen.length &&
                matchesConditions(entry.requiredWhen, values)),
          )}
          disabled={disabled}
          validation={validation}
          onChange={(v) => onChange({ ...values, [entry.fieldId]: v })}
        />
      ))}
    </div>
  );
}
export function visibleValues(fields: FormField[], values: Values): Values {
  return Object.fromEntries(
    visibleFormFields(fields, values)
      .filter((f) => values[f.fieldId] !== undefined)
      .map((f) => [f.fieldId, values[f.fieldId]]),
  );
}
function display(value: any, definition: TicketField) {
  if (value === null || value === undefined || value === "")
    return "Not provided";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  const label = (v: string) =>
    definition.options?.find((o) => o.id === v)?.label ?? v;
  return Array.isArray(value)
    ? value.map(label).join(", ")
    : definition.type === "select"
      ? label(String(value))
      : String(value);
}
export function TicketFields({
  ws,
  id,
  customer = false,
  changed,
  onDirtyChange,
}: {
  ws: string;
  id: string;
  customer?: boolean;
  changed?: () => void;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const request = customer ? customerApi : api;
  const l = useLoad(
    () => request(ws, `/conversations/${id}/fields`),
    [ws, id, customer],
  );
  const a = useAction(),
    [editing, setEditing] = useState(false),
    [values, setValues] = useState<Values>({});
  const dirty =
    editing && JSON.stringify(values) !== JSON.stringify(l.data?.values ?? {});
  useUnsavedChanges(dirty);
  useEffect(() => {
    onDirtyChange?.(dirty);
    return () => onDirtyChange?.(false);
  }, [dirty, onDirtyChange]);
  if (l.error)
    return (
      <div role="alert">
        {l.error}
        <button onClick={l.reload}>Try again</button>
      </div>
    );
  if (!l.data) return <p role="status">Loading ticket fields…</p>;
  const fields: TicketField[] = l.data.fields;
  if (!fields.length && !l.data.historical.length) return null;
  return (
    <section className="ticket-custom-fields">
      <div className="section-heading">
        <div>
          <h3>Ticket information</h3>
          {l.data.form && (
            <p className="muted">
              {l.data.form.name} · submission version {l.data.form.version}
            </p>
          )}
        </div>
        {l.data.editable && !editing && (
          <button
            onClick={() => {
              setValues(l.data.values);
              setEditing(true);
            }}
          >
            Edit fields
          </button>
        )}
      </div>
      {l.data.missing.length > 0 && (
        <p className="field-hint">
          Missing information: {l.data.missing.join(", ")}. This does not block
          ordinary replies.
        </p>
      )}
      {a.error && (
        <p role="alert" className="alert">
          {a.error}
        </p>
      )}
      {a.success && (
        <p role="status" className="success">
          {a.success}
        </p>
      )}
      {!editing ? (
        <dl className="ticket-field-summary">
          {l.data.historical.map((r: any) => (
            <div key={r.fieldId}>
              <dt>
                {r.definition.label}
                {!r.definition.customerVisible && " · Internal"}
              </dt>
              <dd>{display(r.value, r.definition)}</dd>
            </div>
          ))}
        </dl>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void a.run(async () => {
              const patch = Object.fromEntries(
                Object.entries(
                  customer ? visibleValues(l.data.formFields, values) : values,
                ).filter(
                  ([key, v]) =>
                    JSON.stringify(l.data.values[key]) !== JSON.stringify(v),
                ),
              );
              await request(
                ws,
                `/conversations/${id}/fields`,
                { values: patch },
                "PUT",
              );
              setEditing(false);
              l.reload();
              changed?.();
            }, "Ticket fields saved.");
          }}
        >
          <div className="productivity-fields">
            {fields.map((f) => (
              <FieldControl
                key={f.id}
                field={f}
                value={values[f.id]}
                disabled={a.busy || !(f as any).writable}
                onChange={(v) => setValues({ ...values, [f.id]: v })}
              />
            ))}
          </div>
          <div className="button-row">
            <button className="primary" disabled={a.busy || !dirty}>
              Save fields
            </button>
            <button
              type="button"
              disabled={a.busy}
              onClick={() => {
                if (
                  !dirty ||
                  confirmDiscardChanges("Discard these ticket field changes?")
                )
                  setEditing(false);
              }}
            >
              Cancel
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
