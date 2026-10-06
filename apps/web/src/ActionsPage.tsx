import { useRef, useState } from "react";
import { api, useLoad } from "./request.js";
import { useAction } from "./useAction.js";
import { Field, Notice, type Row } from "./quality-ui.js";
import { LoadingState } from "./ui.js";
import { useUnsavedChanges, confirmDiscardChanges } from "./unsaved-changes.js";
import { ActionInput } from "../../../packages/platform/src/contracts.js";

const defaults = () => ({
  name: "refund_payment",
  description:
    "Refund a verified captured payment when the customer requests a refund.",
  kind: "stripe_refund",
  enabled: false,
  config: { idempotent: false, mappingKey: "customer_id", stripeMode: "test" },
  policy: {
    mode: "approval",
    maxAmountMinor: 0,
    currency: "usd",
    dailyLimit: 10,
  },
});
function money(minor: number, currency: string) {
  try {
    const format = new Intl.NumberFormat(undefined, {
      style: "currency",
      currency,
    });
    const digits = format.resolvedOptions().maximumFractionDigits ?? 2;
    return format.format(minor / 10 ** digits);
  } catch {
    return "Choose a valid currency code";
  }
}
export function ActionsPage({ ws, owner }: { ws: string; owner: boolean }) {
  const l = useLoad(() => api(ws, "/actions"), [ws]),
    a = useAction();
  const [edit, setEdit] = useState<Row | null>(null),
    [original, setOriginal] = useState<Row | null>(null),
    [configText, setConfigText] = useState("{}"),
    [query, setQuery] = useState("");
  const list = useRef<HTMLDivElement>(null),
    heading = useRef<HTMLHeadingElement>(null),
    trigger = useRef<HTMLButtonElement | null>(null);
  const dirty =
    !!edit &&
    (JSON.stringify(edit) !== JSON.stringify(original) ||
      configText !== JSON.stringify(original?.config ?? {}, null, 2));
  useUnsavedChanges(dirty);
  const canSwitch = () =>
    !dirty || confirmDiscardChanges("Discard unsaved changes to this action?");
  const select = (row: Row, button: HTMLButtonElement) => {
    if (a.busy || (edit && row.id && edit.id === row.id)) return;
    if (!canSwitch()) return;
    trigger.current = button;
    setEdit(structuredClone(row));
    setOriginal(structuredClone(row));
    setConfigText(JSON.stringify(row.config, null, 2));
    a.setError("");
    a.setSuccess("");
    requestAnimationFrame(() => {
      heading.current?.focus();
      heading.current?.scrollIntoView({ block: "nearest" });
    });
  };
  const close = (saved = false) => {
    if (!saved && !canSwitch()) return;
    setEdit(null);
    setOriginal(null);
    requestAnimationFrame(() =>
      (trigger.current?.isConnected ? trigger.current : list.current)?.focus(),
    );
  };
  const policy = (patch: Row) =>
    setEdit((old) =>
      old ? { ...old, policy: { ...old.policy, ...patch } } : old,
    );
  const rows: Row[] = (l.data?.actions ?? []).filter((row: Row) =>
    `${row.name} ${row.description}`
      .toLowerCase()
      .includes(query.toLowerCase()),
  );
  return (
    <div className="actions-page">
      <header className="page-heading">
        <div>
          <span className="eyebrow">USEFUL ACTIONS. EXPLICIT PERMISSION.</span>
          <h1>Actions</h1>
          <p>
            Choose what the agent can do and when your team must approve it.
          </p>
        </div>
        {owner && (
          <button
            className="primary"
            disabled={a.busy}
            onClick={(e) => select(defaults(), e.currentTarget)}
          >
            ＋ Create action
          </button>
        )}
      </header>
      <Notice action={{ ...a, error: edit ? "" : a.error }} error={l.error} />
      {l.error && <button onClick={l.reload}>Retry actions</button>}
      {l.loading && !l.data && <LoadingState label="Loading actions…" />}
      <div className={`actions-workspace ${edit ? "has-action" : ""}`}>
        <div
          className="action-list"
          ref={list}
          tabIndex={-1}
          aria-label="Actions"
        >
          <input
            type="search"
            aria-label="Search actions"
            placeholder="Find an action…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {rows.map((action) => (
            <section
              className={`panel action-card ${edit?.id === action.id ? "selected" : ""}`}
              key={action.id}
            >
              <div className="section-heading">
                <h2>{action.name}</h2>
                <span className="badge neutral">
                  {action.enabled ? "Enabled" : "Disabled"}
                </span>
              </div>
              <p>{action.description}</p>
              <p className="muted">
                {action.policy.mode === "approval"
                  ? "All actions require approval"
                  : `${action.policy.dailyLimit} automatic actions / day`}
                {action.policy.mode === "automatic" &&
                  action.kind === "stripe_refund" &&
                  ` · Up to ${money(action.policy.maxAmountMinor, action.policy.currency)} per refund`}
              </p>
              {owner && (
                <button
                  disabled={a.busy}
                  aria-current={edit?.id === action.id ? "true" : undefined}
                  onClick={(e) => select(action, e.currentTarget)}
                >
                  Configure action →
                </button>
              )}
            </section>
          ))}
          {l.data && !rows.length && (
            <p className="panel">
              {query
                ? "No actions match this search."
                : "Create an action to connect an approved tool to your agent."}
            </p>
          )}
        </div>
        {edit ? (
          <section
            className="panel action-editor"
            onKeyDown={(e) => {
              if (e.key === "Escape" && !a.busy) {
                e.preventDefault();
                close();
              }
            }}
          >
            <div className="section-heading">
              <div>
                <h2 ref={heading} tabIndex={-1}>
                  {edit.id
                    ? `Edit action: ${original?.name}`
                    : "Create an action"}
                </h2>
                <p className="muted">Changes apply only after you save.</p>
              </div>
              <button disabled={a.busy} onClick={() => close()}>
                Back to actions
              </button>
            </div>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void a.run(async () => {
                  const data = ActionInput.parse({
                    name: edit.name,
                    description: edit.description,
                    kind: edit.kind,
                    enabled: edit.enabled,
                    config: edit.kind.startsWith("custom")
                      ? JSON.parse(configText)
                      : {
                          ...edit.config,
                          stripeMode: edit.config.stripeMode ?? "test",
                        },
                    policy: {
                      ...edit.policy,
                      maxAmountMinor: Number(edit.policy.maxAmountMinor),
                      dailyLimit: Number(edit.policy.dailyLimit),
                    },
                  });
                  await api(
                    ws,
                    `/actions${edit.id ? "/" + edit.id : ""}`,
                    data,
                    edit.id ? "PUT" : "POST",
                  );
                  close(true);
                  l.reload();
                }, "Action saved.");
              }}
            >
              <fieldset disabled={a.busy} className="editor-fields">
                <div className="form-grid">
                  <Field label="Action name">
                    <input
                      name="name"
                      required
                      pattern="[a-z][a-z0-9_]{2,49}"
                      value={edit.name}
                      onChange={(e) =>
                        setEdit({ ...edit, name: e.target.value })
                      }
                    />
                  </Field>
                  <Field label="Tool">
                    <select
                      value={edit.kind}
                      onChange={(e) =>
                        setEdit({ ...edit, kind: e.target.value })
                      }
                    >
                      <option value="stripe_refund">
                        Stripe: refund a payment
                      </option>
                      <option value="stripe_cancel">
                        Stripe: cancel at period end
                      </option>
                      <option value="custom_read">Custom API: read data</option>
                      <option value="custom_write">
                        Custom API: change data
                      </option>
                    </select>
                  </Field>
                </div>
                <Field label="What should the agent use this for?">
                  <textarea
                    name="description"
                    minLength={8}
                    maxLength={1000}
                    required
                    value={edit.description}
                    onChange={(e) =>
                      setEdit({ ...edit, description: e.target.value })
                    }
                  />
                </Field>
                {edit.kind.startsWith("stripe") && (
                  <Field label="Stripe environment">
                    <select
                      value={edit.config.stripeMode ?? "test"}
                      onChange={(e) =>
                        setEdit({
                          ...edit,
                          config: {
                            ...edit.config,
                            stripeMode: e.target.value,
                          },
                        })
                      }
                    >
                      <option value="test">Test mode</option>
                      <option value="live">
                        Live mode — real account changes
                      </option>
                    </select>
                  </Field>
                )}
                {edit.kind.startsWith("custom") && (
                  <>
                    <Field label="Custom API configuration">
                      <textarea
                        className="code-editor"
                        value={configText}
                        onChange={(e) => setConfigText(e.target.value)}
                        rows={12}
                      />
                    </Field>
                    <p className="muted">
                      Provide endpoint, inputSchema, outputSchema and
                      mappingKey. Automatic writes also require idempotent and
                      lookupEndpoint. Enable diagnosticTest only for a dedicated
                      test endpoint.
                    </p>
                  </>
                )}
                <Field label="Approval policy">
                  <select
                    value={edit.policy.mode}
                    onChange={(e) => policy({ mode: e.target.value })}
                  >
                    <option value="approval">Always require approval</option>
                    <option value="automatic">Automatic within limits</option>
                  </select>
                </Field>
                {edit.policy.mode === "approval" ? (
                  <p className="muted">
                    Your team reviews every proposed action. Automatic limits
                    are inactive.
                  </p>
                ) : (
                  <div className="form-grid">
                    {edit.kind === "stripe_refund" && (
                      <>
                        <Field label="Currency">
                          <input
                            pattern="[a-z]{3}"
                            required
                            value={edit.policy.currency}
                            onChange={(e) =>
                              policy({ currency: e.target.value.toLowerCase() })
                            }
                          />
                        </Field>
                        <Field label="Automatic refund limit (minor units)">
                          <input
                            type="number"
                            min="0"
                            step="1"
                            required
                            value={edit.policy.maxAmountMinor}
                            onChange={(e) =>
                              policy({ maxAmountMinor: e.target.value })
                            }
                          />
                          <small>
                            Maximum per refund:{" "}
                            {money(
                              Number(edit.policy.maxAmountMinor),
                              edit.policy.currency,
                            )}
                            . For USD, 100 minor units = $1.00.
                          </small>
                        </Field>
                      </>
                    )}
                    <Field label="Daily automatic action limit">
                      <input
                        type="number"
                        min="1"
                        max="10000"
                        step="1"
                        required
                        value={edit.policy.dailyLimit}
                        onChange={(e) => policy({ dailyLimit: e.target.value })}
                      />
                    </Field>
                  </div>
                )}
                <label className="checkbox">
                  <input
                    type="checkbox"
                    checked={edit.enabled}
                    onChange={(e) =>
                      setEdit({ ...edit, enabled: e.target.checked })
                    }
                  />
                  Enable this action
                </label>
                {a.error && (
                  <p role="alert" className="error">
                    {a.error}
                  </p>
                )}
                <div className="editor-save-bar">
                  <span role="status">
                    {a.busy
                      ? "Saving…"
                      : dirty
                        ? "Unsaved changes"
                        : edit.id
                          ? "All changes saved"
                          : "New action"}
                  </span>
                  <button
                    type="button"
                    disabled={!dirty}
                    onClick={() => {
                      if (
                        confirmDiscardChanges(
                          "Discard unsaved changes to this action?",
                        )
                      ) {
                        setEdit(structuredClone(original));
                        setConfigText(
                          JSON.stringify(original?.config ?? {}, null, 2),
                        );
                      }
                    }}
                  >
                    Discard changes
                  </button>
                  <button className="primary" disabled={!!edit.id && !dirty}>
                    Save action
                  </button>
                </div>
              </fieldset>
            </form>
          </section>
        ) : (
          <section className="panel action-placeholder">
            <h2>Choose an action</h2>
            <p>Review its approval policy and configuration here.</p>
          </section>
        )}
      </div>
    </div>
  );
}
