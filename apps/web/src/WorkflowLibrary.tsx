import React, { useId, useState } from "react";
import {
  EMPTY_SCHEMA,
  type ValueBindings,
} from "../../../packages/platform/src/workflow-values.js";
type Row = Record<string, any>;
export const initialCode = (language: string) =>
  language === "python"
    ? 'def run(input):\n    return {"eligible": input["amount"] <= 100}\n'
    : "async function run(input) {\n  return { eligible: input.amount <= 100 };\n}\n";
export const objectSchema = (properties: Row = {}) => ({
  type: "object",
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});
export function MappingFields({
  schema,
  values,
  onChange,
  label = "Input",
  paths = [],
}: {
  schema: Row;
  values: ValueBindings;
  onChange: (v: ValueBindings) => void;
  label?: string;
  paths?: string[];
}) {
  const pathListId = useId();
  return (
    <div className="wf-mappings">
      <datalist id={pathListId}>
        {paths.map((path) => (
          <option key={path} value={path} />
        ))}
      </datalist>
      {Object.keys(schema.properties ?? {}).map((key) => {
        const binding = values[key] ?? { type: "path" as const, path: "" };
        return (
          <fieldset key={key}>
            <legend>
              {label}: {key}
              {schema.required?.includes(key) ? " *" : ""}
            </legend>
            <select
              aria-label={`${label} ${key} source`}
              value={values[key]?.type ?? "unset"}
              onChange={(e) => {
                const next = { ...values };
                if (e.target.value === "unset") delete next[key];
                else
                  next[key] =
                    e.target.value === "path"
                      ? { type: "path", path: "" }
                      : { type: "value", value: "" };
                onChange(next);
              }}
            >
              <option value="unset">Not supplied</option>
              <option value="path">Workflow variable</option>
              <option value="value">Fixed value</option>
            </select>
            {values[key] &&
              (binding.type === "path" ? (
                <>
                  <input
                    aria-label={`${label} ${key} variable`}
                    value={binding.path}
                    list={pathListId}
                    placeholder="steps.lookup.output.plan"
                    onChange={(e) =>
                      onChange({
                        ...values,
                        [key]: { type: "path", path: e.target.value },
                      })
                    }
                  />
                </>
              ) : (
                <input
                  aria-label={`${label} ${key} value`}
                  value={
                    typeof binding.value === "string"
                      ? binding.value
                      : JSON.stringify(binding.value)
                  }
                  placeholder="Text, 123, true, or JSON"
                  onChange={(e) => {
                    let value: any = e.target.value;
                    try {
                      value = JSON.parse(value);
                    } catch {}
                    onChange({ ...values, [key]: { type: "value", value } });
                  }}
                />
              ))}
          </fieldset>
        );
      })}
      {!Object.keys(schema.properties ?? {}).length && (
        <p className="wf-note">No named inputs in this schema.</p>
      )}
    </div>
  );
}
export function SchemaFields({
  input,
  output,
  onInput,
  onOutput,
}: {
  input: string;
  output: string;
  onInput: (v: string) => void;
  onOutput: (v: string) => void;
}) {
  return (
    <div className="form-grid">
      <label className="wf-field">
        <span>Input JSON schema</span>
        <textarea
          aria-label="Input JSON schema"
          rows={7}
          spellCheck={false}
          value={input}
          onChange={(e) => onInput(e.target.value)}
        />
      </label>
      <label className="wf-field">
        <span>Output JSON schema</span>
        <textarea
          aria-label="Output JSON schema"
          rows={7}
          spellCheck={false}
          value={output}
          onChange={(e) => onOutput(e.target.value)}
        />
      </label>
    </div>
  );
}
export function WorkflowLibrary({
  resources,
  admin,
  request,
  onChanged,
  onSubflow,
}: {
  resources: Row;
  admin: boolean;
  request: (path: string, data?: unknown, method?: string) => Promise<any>;
  onChanged: () => Promise<void>;
  onSubflow: (component: Row | null) => void;
}) {
  const [editing, setEditing] = useState<Row | null>(null),
    [draft, setDraft] = useState<Row | null>(null),
    [input, setInput] = useState("{}"),
    [output, setOutput] = useState("{}"),
    [testInput, setTestInput] = useState("{}"),
    [contact, setContact] = useState(""),
    [result, setResult] = useState<Row | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [recent, setRecent] = useState<Row[] | null>(null);
  const load = (definition: Row, row: Row | null = null) => {
    setEditing(row);
    setDraft(definition);
    setInput(JSON.stringify(definition.inputSchema, null, 2));
    setOutput(JSON.stringify(definition.outputSchema, null, 2));
    setError("");
    setResult(null);
    setTestInput(definition.kind === "code" ? '{"amount": 40}' : "{}");
  };
  const create = (kind: string, language = "python") =>
    load({
      kind,
      name: "",
      description: "",
      customerSafe: false,
      inputSchema:
        kind === "code"
          ? objectSchema({ amount: { type: "number" } })
          : EMPTY_SCHEMA,
      outputSchema:
        kind === "code"
          ? objectSchema({ eligible: { type: "boolean" } })
          : EMPTY_SCHEMA,
      ...(kind === "code"
        ? { language, code: initialCode(language) }
        : { source: "public_get", endpoint: "", actionId: "" }),
    });
  const act = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const definition = () => ({
    ...draft,
    inputSchema: JSON.parse(input),
    outputSchema: JSON.parse(output),
  });
  return (
    <details className="panel wf-library">
      <summary>
        Reusable steps and subflows{" "}
        <small>{resources.components?.length ?? 0} saved</small>
      </summary>
      <p>
        Create a step once, then use a specific version in any branch. Saving a
        new version does not change published workflows.
      </p>
      {admin && (
        <div className="button-row">
          <button onClick={() => create("code", "python")}>
            New Python step
          </button>
          <button onClick={() => create("code", "javascript")}>
            New JavaScript step
          </button>
          <button onClick={() => create("api")}>New API step</button>
          <button onClick={() => onSubflow(null)}>New subflow</button>
        </div>
      )}
      {!resources.runnerConfigured && (
        <p className="wf-note">
          Python and JavaScript execution needs the optional isolated runner.
          API steps, templates, and conditions can run without it.
        </p>
      )}
      <div className="wf-library-items">
        {resources.components?.map((c: Row) => (
          <article key={c.id}>
            <div>
              <strong>{c.name}</strong>
              <small>
                {c.kind} · version {c.revision}
              </small>
              <p>{c.definition.description}</p>
            </div>
            {admin && (
              <div className="button-row">
                <button
                  onClick={() =>
                    c.kind === "subflow" ? onSubflow(c) : load(c.definition, c)
                  }
                >
                  Edit {c.name}
                </button>
                <button
                  onClick={() => {
                    if (
                      confirm(
                        "Archive this component? Published workflow snapshots keep working.",
                      )
                    )
                      void act(async () => {
                        await request(
                          `/workflow/components/${c.id}`,
                          {},
                          "DELETE",
                        );
                        await onChanged();
                      });
                  }}
                >
                  Archive
                </button>
              </div>
            )}
          </article>
        ))}
      </div>
      {draft && (
        <form
          className="wf-component-editor"
          onSubmit={(e) => {
            e.preventDefault();
            void act(async () => {
              const saved = await request(
                `/workflow/components${editing ? `/${editing.id}` : ""}`,
                { revision: editing?.revision ?? 0, definition: definition() },
                editing ? "PUT" : "POST",
              );
              setEditing({ ...saved, kind: draft.kind, name: draft.name });
              await onChanged();
              setDraft(null);
            });
          }}
        >
          <h3>{editing ? `Edit ${editing.name}` : "Create reusable step"}</h3>
          <fieldset disabled={busy || !admin}>
            <label className="wf-field">
              <span>Component name</span>
              <input
                aria-label="Component name"
                required
                maxLength={80}
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              />
            </label>
            <label className="wf-field">
              <span>Component description</span>
              <input
                aria-label="Component description"
                maxLength={1000}
                value={draft.description}
                onChange={(e) =>
                  setDraft({ ...draft, description: e.target.value })
                }
              />
            </label>
            {draft.kind === "code" ? (
              <>
                <label className="wf-field">
                  <span>
                    {draft.language === "python"
                      ? "Python code"
                      : "JavaScript code"}
                  </span>
                  <textarea
                    aria-label="Step code"
                    className="wf-code"
                    spellCheck={false}
                    rows={10}
                    maxLength={20000}
                    value={draft.code}
                    onChange={(e) =>
                      setDraft({ ...draft, code: e.target.value })
                    }
                  />
                </label>
                <p>
                  Define <code>run(input)</code> and return a JSON object. The
                  container has no network, credentials, or application files;
                  use an API action for account changes.
                </p>
              </>
            ) : (
              <>
                <label className="wf-field">
                  <span>API source</span>
                  <select
                    aria-label="API source"
                    value={draft.source}
                    onChange={(e) =>
                      setDraft({ ...draft, source: e.target.value })
                    }
                  >
                    <option value="public_get">
                      Public JSON endpoint (GET)
                    </option>
                    <option value="customer_action">
                      Existing customer read action
                    </option>
                  </select>
                </label>
                {draft.source === "public_get" ? (
                  <label className="wf-field">
                    <span>Public API URL</span>
                    <input
                      aria-label="Public API URL"
                      type="url"
                      required
                      value={draft.endpoint}
                      placeholder="https://status.example.com/api/status"
                      onChange={(e) =>
                        setDraft({ ...draft, endpoint: e.target.value })
                      }
                    />
                  </label>
                ) : (
                  <label className="wf-field">
                    <span>Customer read action</span>
                    <select
                      aria-label="Customer read action"
                      required
                      value={draft.actionId}
                      onChange={(e) => {
                        setDraft({ ...draft, actionId: e.target.value });
                        const action = resources.actions.find(
                          (a: Row) => a.id === e.target.value,
                        );
                        if (action) {
                          setInput(
                            JSON.stringify(
                              action.input_schema ?? EMPTY_SCHEMA,
                              null,
                              2,
                            ),
                          );
                          setOutput(
                            JSON.stringify(
                              action.output_schema ?? EMPTY_SCHEMA,
                              null,
                              2,
                            ),
                          );
                        }
                      }}
                    >
                      <option value="">Choose action</option>
                      {resources.actions
                        .filter(
                          (a: Row) => a.kind === "custom_read" && a.enabled,
                        )
                        .map((a: Row) => (
                          <option key={a.id} value={a.id}>
                            {a.name}
                          </option>
                        ))}
                    </select>
                  </label>
                )}
                <p>
                  Public endpoints are fixed HTTPS URLs. Customer actions use
                  verified identity and reviewed provider mappings. These steps
                  perform reads only.
                </p>
              </>
            )}
            <SchemaFields
              input={input}
              output={output}
              onInput={setInput}
              onOutput={setOutput}
            />
            <label className="wf-check">
              <input
                type="checkbox"
                checked={draft.customerSafe}
                onChange={(e) =>
                  setDraft({ ...draft, customerSafe: e.target.checked })
                }
              />{" "}
              Allow this step’s output in customer replies and AI answers
            </label>
            <div className="button-row">
              <button className="primary">Save component version</button>
              <button type="button" onClick={() => setDraft(null)}>
                Close component editor
              </button>
            </div>
            <details>
              <summary>Test this step</summary>
              <label className="wf-field">
                <span>Test input JSON</span>
                <textarea
                  aria-label="Test input JSON"
                  value={testInput}
                  onChange={(e) => setTestInput(e.target.value)}
                />
              </label>
              <label className="wf-field">
                <span>Test identity</span>
                <select
                  aria-label="Component test customer"
                  value={contact}
                  onChange={(e) => setContact(e.target.value)}
                >
                  <option value="">Anonymous</option>
                  {resources.contacts
                    .filter((c: Row) => c.verified)
                    .map((c: Row) => (
                      <option key={c.id} value={c.id}>
                        {c.name || c.email}
                      </option>
                    ))}
                </select>
              </label>
              <button
                type="button"
                onClick={() =>
                  void act(async () =>
                    setResult(
                      await request("/workflow/components/test", {
                        definition: definition(),
                        input: JSON.parse(testInput),
                        ...(contact ? { contactId: contact } : {}),
                      }),
                    ),
                  )
                }
              >
                Test component
              </button>
            </details>
          </fieldset>
          {result && (
            <pre aria-label="Component test output">
              {JSON.stringify(
                { output: result.output, trace: result.trace },
                null,
                2,
              )}
            </pre>
          )}
        </form>
      )}
      {error && (
        <p className="alert" role="alert">
          {error}
        </p>
      )}
      <button
        onClick={() =>
          void act(async () =>
            setRecent((await request("/workflow/step-results")).steps),
          )
        }
      >
        Load recent step runs
      </button>
      {recent && (
        <div className="wf-run-list">
          {recent.length ? (
            recent.map((r: Row) => (
              <details key={`${r.run_id}:${r.node_id}`}>
                <summary>
                  {r.node_id} · {r.status} ·{" "}
                  {new Date(r.created_at).toLocaleString()}
                </summary>
                <p>Run {r.run_id}</p>
                <pre>{JSON.stringify(r.output?.result ?? null, null, 2)}</pre>
                {r.logs && <pre>{r.logs}</pre>}
                {r.error && <p className="alert">{r.error}</p>}
              </details>
            ))
          ) : (
            <p>No custom steps have run in a conversation yet.</p>
          )}
        </div>
      )}
    </details>
  );
}
