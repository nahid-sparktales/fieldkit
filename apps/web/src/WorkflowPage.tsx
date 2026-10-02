import React, { useEffect, useId, useRef, useState } from "react";
import {
  WorkflowDefinition,
  NODE_LABELS,
  PORTS,
  defaultWorkflow,
  newWorkflowNode,
  workflowProblems,
  type Workflow,
  type WorkflowNode,
  type NodeType,
} from "../../../packages/platform/src/workflow-definition.js";
import "./workflow.css";

type Row = Record<string, any>;
const descriptions: Record<NodeType, string> = {
  start:
    "A new customer message starts this workflow, in the portal, widget, or Zendesk.",
  knowledge:
    "Search approved documents and FAQs. Every answer keeps its source citations.",
  customer:
    "Read the verified customer attached to this conversation. A supplied email or model output cannot establish ownership.",
  agent:
    "Use your connected model to answer, clarify, propose an allowed action, or hand off.",
  condition:
    "Route using trusted application state, not a model’s claim about identity.",
  action:
    "Choose the actions this workflow can propose. Execution always rechecks identity, provider ownership, policies, and approval.",
  reply:
    "Send the answer or confirmed action receipt. Missing evidence or an unexecuted action goes to staff.",
  handoff:
    "Stop automatic processing and pass the conversation to your team through the channel’s configured handoff destination.",
};
function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  const labelId = useId();
  return (
    <label className="wf-field">
      <span id={labelId}>{label}</span>
      {React.isValidElement(children)
        ? React.cloneElement(
            children as React.ReactElement<{ "aria-labelledby": string }>,
            { "aria-labelledby": labelId },
          )
        : children}
    </label>
  );
}
function Checks({
  items,
  selected,
  onChange,
  disabled = false,
}: {
  items: Row[];
  selected: string[];
  onChange: (ids: string[]) => void;
  disabled?: boolean;
}) {
  return (
    <div className="wf-checks">
      {items.length ? (
        items.map((item) => (
          <label key={item.id}>
            <input
              type="checkbox"
              disabled={disabled || item.unavailable}
              checked={selected.includes(item.id)}
              onChange={(e) =>
                onChange(
                  e.target.checked
                    ? [...selected, item.id]
                    : selected.filter((id) => id !== item.id),
                )
              }
            />
            <span>
              {item.title ?? item.name}
              <small>{item.detail}</small>
            </span>
          </label>
        ))
      ) : (
        <p>No resources yet. Create them in Knowledge or Actions.</p>
      )}
    </div>
  );
}
export function WorkflowPage({
  ws,
  admin,
  request,
}: {
  ws: string;
  admin: boolean;
  request: (path: string, data?: unknown, method?: string) => Promise<any>;
}) {
  const [loaded, setLoaded] = useState<Row | null>(null),
    [definition, setDefinition] = useState<Workflow | null>(null),
    [saved, setSaved] = useState("");
  const [selected, setSelected] = useState("start"),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [success, setSuccess] = useState("");
  const [link, setLink] = useState<{ from: string; port: string } | null>(null),
    [zoom, setZoom] = useState(0.8),
    [past, setPast] = useState<Workflow[]>([]),
    [future, setFuture] = useState<Workflow[]>([]);
  const [test, setTest] = useState<Row | null>(null),
    [question, setQuestion] = useState(""),
    [customer, setCustomer] = useState(""),
    [channel, setChannel] = useState("portal"),
    [historyVersion, setHistoryVersion] = useState("");
  const drag = useRef<{
      id: string;
      x: number;
      y: number;
      clientX: number;
      clientY: number;
    } | null>(null),
    importFile = useRef<HTMLInputElement>(null);
  const accept = (data: Row) => {
    setLoaded(data);
    setDefinition(data.draft);
    setSaved(JSON.stringify(data.draft));
    setPast([]);
    setFuture([]);
  };
  useEffect(() => {
    let live = true;
    request("/workflow")
      .then((data) => {
        if (live) accept(data);
      })
      .catch((e) => {
        if (live) setError(e.message);
      });
    return () => {
      live = false;
    };
  }, [ws]);
  const act = async (fn: () => Promise<void>, message = "") => {
    setBusy(true);
    setError("");
    setSuccess("");
    try {
      await fn();
      setSuccess(message);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Workflow request failed");
    } finally {
      setBusy(false);
    }
  };
  if (!loaded || !definition)
    return (
      <section className="panel">
        <h1>Workflow</h1>
        {error ? (
          <p role="alert">{error}</p>
        ) : (
          <p>Loading your agent workflow…</p>
        )}
      </section>
    );
  const def = definition,
    resources = loaded.resources,
    dirty = JSON.stringify(def) !== saved,
    node = def.nodes.find((n) => n.id === selected),
    problems = workflowProblems(def);
  const replace = (next: Workflow, remember = true) => {
    if (remember) setPast([...past.slice(-29), def]);
    setFuture([]);
    setDefinition(next);
    setTest(null);
    setSuccess("");
  };
  const patch = (changes: Row) => {
    if (!node) return;
    replace({
      ...def,
      nodes: def.nodes.map((n) =>
        n.id === node.id
          ? ({ ...n, data: { ...n.data, ...changes } } as WorkflowNode)
          : n,
      ),
    });
  };
  const connect = (from: string, port: string, to: string) => {
    replace({
      ...def,
      edges: [
        ...def.edges.filter((e) => !(e.from === from && e.port === port)),
        ...(to ? [{ from, port, to }] : []),
      ],
    });
    setLink(null);
  };
  const width = Math.max(1080, ...def.nodes.map((n) => n.x + 300)),
    height = Math.max(850, ...def.nodes.map((n) => n.y + 230));
  const pathNodes = new Set(test?.trace.map((s: Row) => s.nodeId) ?? []);
  const pathEdges = new Set(
    test?.trace.map((s: Row) => `${s.nodeId}:${s.outcome}`) ?? [],
  );
  const canEdit = admin && !busy;
  const save = () =>
    act(async () => {
      accept(
        await request(
          "/workflow",
          { revision: loaded.revision, definition: def },
          "PUT",
        ),
      );
    }, "Draft saved. Publish it to use it for new conversations.");
  return (
    <div className="workflow-page">
      <div className="page-heading">
        <div>
          <span className="eyebrow">LANGGRAPH WORKFLOW</span>
          <h1>Design how your agent helps.</h1>
          <p>
            Connect steps, choose their resources, and test the route before
            publishing.
          </p>
        </div>
      </div>
      <div className="wf-toolbar">
        <div>
          <strong>
            {loaded.publishedVersion
              ? `Published version ${loaded.publishedVersion}`
              : "Built-in workflow is active"}
          </strong>
          <small>
            {dirty
              ? "Unsaved changes"
              : loaded.revision
                ? "Draft saved"
                : "Unsaved template"}{" "}
            · New turns use the published version.
          </small>
        </div>
        <div className="button-row">
          <button
            disabled={busy}
            onClick={() =>
              void act(async () => {
                if (dirty && !confirm("Discard unsaved workflow changes?"))
                  return;
                accept(await request("/workflow"));
              }, "Workflow reloaded.")
            }
          >
            Reload
          </button>
          {admin && (
            <>
              <button
                disabled={busy || (!dirty && loaded.revision > 0)}
                onClick={() => void save()}
              >
                Save draft
              </button>
              <button
                className="primary"
                disabled={
                  busy || dirty || !loaded.revision || !!problems.length
                }
                onClick={() =>
                  void act(async () => {
                    accept(
                      await request("/workflow/publish", {
                        revision: loaded.revision,
                      }),
                    );
                  }, "Workflow published. New turns use this version; previous pending action approvals are invalidated.")
                }
              >
                Publish workflow
              </button>
            </>
          )}
        </div>
      </div>
      {error && (
        <div className="alert" role="alert">
          {error}
        </div>
      )}
      {success && (
        <p className="success" role="status">
          {success}
        </p>
      )}
      <div className="wf-palette" aria-label="Workflow step palette">
        {(Object.keys(NODE_LABELS) as NodeType[])
          .filter((t) => t !== "start")
          .map((type) => (
            <button
              key={type}
              disabled={!canEdit || def.nodes.length >= 24}
              onClick={() => {
                const id = `step-${crypto.randomUUID().slice(0, 8)}`,
                  n = newWorkflowNode(
                    type,
                    id,
                    80 + (def.nodes.length % 3) * 310,
                    100 + Math.floor(def.nodes.length / 3) * 230,
                  );
                replace({ ...def, nodes: [...def.nodes, n] });
                setSelected(id);
              }}
            >
              ＋ {NODE_LABELS[type]}
            </button>
          ))}
      </div>
      <div className="wf-editor">
        <section className="wf-map-panel" aria-label="Workflow map">
          <div className="wf-map-tools">
            <div className="button-row">
              <button
                aria-label="Zoom out"
                onClick={() => setZoom((z) => Math.max(0.35, z - 0.1))}
              >
                −
              </button>
              <span>{Math.round(zoom * 100)}%</span>
              <button
                aria-label="Zoom in"
                onClick={() => setZoom((z) => Math.min(1.4, z + 0.1))}
              >
                ＋
              </button>
              <button
                disabled={!canEdit || !past.length}
                onClick={() => {
                  setFuture([def, ...future]);
                  setDefinition(past.at(-1)!);
                  setPast(past.slice(0, -1));
                  setTest(null);
                }}
              >
                Undo
              </button>
              <button
                disabled={!canEdit || !future.length}
                onClick={() => {
                  setPast([...past, def]);
                  setDefinition(future[0]);
                  setFuture(future.slice(1));
                  setTest(null);
                }}
              >
                Redo
              </button>
            </div>
            <span>
              {link
                ? `Connect ${link.port}: select a step’s input`
                : "Drag a step to move it. Connect an outcome to an input."}
            </span>
            {link && (
              <button onClick={() => setLink(null)}>Cancel connection</button>
            )}
          </div>
          <div
            className="wf-canvas-scroll"
            tabIndex={0}
            aria-label="Scrollable workflow canvas"
            onKeyDown={(e) => {
              if (e.key === "Escape") setLink(null);
            }}
          >
            <div style={{ width: width * zoom, height: height * zoom }}>
              <div
                className="wf-canvas"
                style={{ width, height, transform: `scale(${zoom})` }}
              >
                <svg
                  width={width}
                  height={height}
                  className="wf-lines"
                  aria-hidden="true"
                >
                  <defs>
                    <marker
                      id="wf-arrow"
                      markerWidth="8"
                      markerHeight="8"
                      refX="7"
                      refY="4"
                      orient="auto"
                    >
                      <path d="M0 0L8 4L0 8" fill="currentColor" />
                    </marker>
                  </defs>
                  {def.edges.map((e) => {
                    const from = def.nodes.find((n) => n.id === e.from),
                      to = def.nodes.find((n) => n.id === e.to);
                    if (!from || !to) return null;
                    const x = from.x + 240,
                      y = from.y + 77 + PORTS[from.type].indexOf(e.port) * 25,
                      tx = to.x + 120,
                      ty = to.y - 7;
                    return (
                      <path
                        key={`${e.from}:${e.port}:${e.to}`}
                        className={
                          pathEdges.has(`${e.from}:${e.port}`) ? "visited" : ""
                        }
                        d={`M${x} ${y} C${x + 70} ${y},${tx} ${ty - 70},${tx} ${ty}`}
                        markerEnd="url(#wf-arrow)"
                      />
                    );
                  })}
                </svg>
                {def.nodes.map((n) => (
                  <article
                    key={n.id}
                    className={`wf-node ${n.type} ${selected === n.id ? "selected" : ""} ${pathNodes.has(n.id) ? "visited" : ""}`}
                    style={{ left: n.x, top: n.y }}
                  >
                    {n.type !== "start" && (
                      <button
                        className="wf-input"
                        aria-label={`Connect to ${n.title}`}
                        disabled={!canEdit}
                        onPointerUp={() => {
                          if (link) connect(link.from, link.port, n.id);
                        }}
                        onClick={() => {
                          if (link) connect(link.from, link.port, n.id);
                          else setSelected(n.id);
                        }}
                      >
                        ●
                      </button>
                    )}
                    <button
                      className="wf-node-title"
                      aria-label={`Select ${n.title}`}
                      onClick={() => setSelected(n.id)}
                      onPointerDown={(e) => {
                        setSelected(n.id);
                        if (!canEdit || e.button !== 0) return;
                        drag.current = {
                          id: n.id,
                          x: n.x,
                          y: n.y,
                          clientX: e.clientX,
                          clientY: e.clientY,
                        };
                        setPast((p) => [...p.slice(-29), def]);
                        setFuture([]);
                        e.currentTarget.setPointerCapture(e.pointerId);
                      }}
                      onPointerMove={(e) => {
                        const d = drag.current;
                        if (!d || !canEdit) return;
                        const x = Math.max(
                            0,
                            Math.min(
                              4000,
                              Math.round(
                                (d.x + (e.clientX - d.clientX) / zoom) / 10,
                              ) * 10,
                            ),
                          ),
                          y = Math.max(
                            0,
                            Math.min(
                              3000,
                              Math.round(
                                (d.y + (e.clientY - d.clientY) / zoom) / 10,
                              ) * 10,
                            ),
                          );
                        setDefinition((current) =>
                          current
                            ? {
                                ...current,
                                nodes: current.nodes.map((v) =>
                                  v.id === d.id ? { ...v, x, y } : v,
                                ),
                              }
                            : current,
                        );
                      }}
                      onPointerUp={() => {
                        drag.current = null;
                      }}
                      onPointerCancel={() => {
                        drag.current = null;
                      }}
                      onKeyDown={(e) => {
                        if (
                          !canEdit ||
                          ![
                            "ArrowUp",
                            "ArrowDown",
                            "ArrowLeft",
                            "ArrowRight",
                          ].includes(e.key)
                        )
                          return;
                        e.preventDefault();
                        replace({
                          ...def,
                          nodes: def.nodes.map((v) =>
                            v.id === n.id
                              ? {
                                  ...v,
                                  x: Math.max(
                                    0,
                                    Math.min(
                                      4000,
                                      v.x +
                                        (e.key === "ArrowRight"
                                          ? 20
                                          : e.key === "ArrowLeft"
                                            ? -20
                                            : 0),
                                    ),
                                  ),
                                  y: Math.max(
                                    0,
                                    Math.min(
                                      3000,
                                      v.y +
                                        (e.key === "ArrowDown"
                                          ? 20
                                          : e.key === "ArrowUp"
                                            ? -20
                                            : 0),
                                    ),
                                  ),
                                }
                              : v,
                          ),
                        });
                      }}
                    >
                      <small>{NODE_LABELS[n.type]}</small>
                      <strong>{n.title}</strong>
                    </button>
                    <div className="wf-ports">
                      {PORTS[n.type].map((port) => (
                        <button
                          key={port}
                          disabled={!canEdit}
                          className={
                            link?.from === n.id && link.port === port
                              ? "connecting"
                              : ""
                          }
                          aria-label={`Connect ${n.title} ${port}`}
                          onPointerDown={() => setLink({ from: n.id, port })}
                          onClick={() => setLink({ from: n.id, port })}
                        >
                          <span>{port}</span>●
                        </button>
                      ))}
                    </div>
                    {!PORTS[n.type].length && (
                      <p className="wf-terminal">End of turn</p>
                    )}
                  </article>
                ))}
              </div>
            </div>
          </div>
        </section>
        <aside className="wf-inspector">
          <Field label="Selected step">
            <select
              value={selected}
              onChange={(e) => setSelected(e.target.value)}
            >
              {def.nodes.map((n) => (
                <option key={n.id} value={n.id}>
                  {n.title}
                </option>
              ))}
            </select>
          </Field>
          {node && (
            <>
              <h2>{NODE_LABELS[node.type]}</h2>
              <p>{descriptions[node.type]}</p>
              <fieldset disabled={!canEdit}>
                <Field label="Step name">
                  <input
                    value={node.title}
                    maxLength={80}
                    onChange={(e) =>
                      replace({
                        ...def,
                        nodes: def.nodes.map((n) =>
                          n.id === node.id
                            ? { ...n, title: e.target.value }
                            : n,
                        ),
                      })
                    }
                  />
                </Field>
                {node.type === "knowledge" && (
                  <>
                    <Field label="Knowledge scope">
                      <select
                        value={node.data.scope}
                        onChange={(e) => patch({ scope: e.target.value })}
                      >
                        <option value="all">
                          All approved knowledge and FAQs
                        </option>
                        <option value="selected">Selected sources</option>
                      </select>
                    </Field>
                    {node.data.scope === "selected" && (
                      <Checks
                        items={resources.sources.map((s: Row) => ({
                          ...s,
                          detail: `${s.kind} · ${s.visibility} · ${s.status}`,
                          unavailable:
                            s.visibility !== "customer" || s.status !== "ready",
                        }))}
                        selected={node.data.sourceIds}
                        onChange={(sourceIds) => patch({ sourceIds })}
                      />
                    )}
                    <Field label="Maximum passages">
                      <input
                        type="number"
                        min={1}
                        max={12}
                        value={node.data.limit}
                        onChange={(e) =>
                          patch({ limit: Number(e.target.value) })
                        }
                      />
                    </Field>
                  </>
                )}
                {node.type === "customer" && (
                  <>
                    <label className="wf-check">
                      <input
                        type="checkbox"
                        checked={node.data.profile}
                        onChange={(e) => patch({ profile: e.target.checked })}
                      />{" "}
                      Include verified customer name and email
                    </label>
                    <label className="wf-check">
                      <input
                        type="checkbox"
                        checked={node.data.billing}
                        onChange={(e) => patch({ billing: e.target.checked })}
                      />{" "}
                      Read mapped Stripe purchases and subscriptions
                    </label>
                    {node.data.billing && (
                      <Checks
                        items={[
                          {
                            id: "test",
                            name: "Stripe test",
                            detail: "Dedicated test accounts",
                          },
                          {
                            id: "live",
                            name: "Stripe live",
                            detail: "Read-only lookup of the current customer",
                          },
                        ]}
                        selected={node.data.modes}
                        onChange={(modes) => patch({ modes })}
                      />
                    )}
                    <p className="wf-note">
                      Uses the current conversation’s customer. Provider account
                      IDs must come from a reviewed mapping or trusted server
                      identity.
                    </p>
                  </>
                )}
                {node.type === "agent" && (
                  <>
                    <Field label="Step instructions">
                      <textarea
                        rows={7}
                        value={node.data.instructions}
                        maxLength={4000}
                        placeholder="For example: ask one clarifying question if the request is ambiguous."
                        onChange={(e) =>
                          patch({ instructions: e.target.value })
                        }
                      />
                    </Field>
                    <Field label="Response model (optional)">
                      <input
                        value={node.data.model}
                        maxLength={100}
                        placeholder="Use workspace model"
                        onChange={(e) => patch({ model: e.target.value })}
                      />
                    </Field>
                    <p className="wf-note">
                      Available tools come from the governed action step on this
                      route. Workspace usage budgets and timeouts always apply.
                    </p>
                  </>
                )}
                {node.type === "condition" && (
                  <>
                    <Field label="Condition">
                      <select
                        value={node.data.field}
                        onChange={(e) =>
                          patch({
                            field: e.target.value,
                            value:
                              e.target.value === "channel"
                                ? "portal"
                                : e.target.value === "mapped"
                                  ? "customer_id"
                                  : "",
                          })
                        }
                      >
                        <option value="verified">
                          Customer identity is verified
                        </option>
                        <option value="mapped">
                          Customer has a provider mapping
                        </option>
                        <option value="channel">
                          Message came from a channel
                        </option>
                        <option value="evidence">Knowledge was found</option>
                      </select>
                    </Field>
                    {node.data.field === "mapped" && (
                      <Field label="Provider mapping key">
                        <input
                          value={node.data.value}
                          onChange={(e) => patch({ value: e.target.value })}
                          placeholder="stripe_test or customer_id"
                        />
                      </Field>
                    )}
                    {node.data.field === "channel" && (
                      <Field label="Channel">
                        <select
                          value={node.data.value}
                          onChange={(e) => patch({ value: e.target.value })}
                        >
                          {["portal", "widget", "zendesk"].map((v) => (
                            <option key={v}>{v}</option>
                          ))}
                        </select>
                      </Field>
                    )}
                  </>
                )}
                {node.type === "action" && (
                  <>
                    <Checks
                      items={resources.actions.map((a: Row) => ({
                        ...a,
                        detail: `${a.kind} · ${a.enabled ? a.policy.mode : "disabled"}${a.stripe_mode ? ` · ${a.stripe_mode}` : ""}${a.mapping_key ? ` · mapping: ${a.mapping_key}` : ""}`,
                        unavailable: !a.enabled,
                      }))}
                      selected={node.data.actionIds}
                      onChange={(actionIds) => patch({ actionIds })}
                    />
                    <Field label="Action approval">
                      <select
                        value={node.data.approval}
                        onChange={(e) => patch({ approval: e.target.value })}
                      >
                        <option value="always">
                          Always require staff approval
                        </option>
                        <option value="policy">
                          Follow each action’s configured policy
                        </option>
                      </select>
                    </Field>
                    <p className="wf-note">
                      Policy limits, approved parameters, customer ownership,
                      receipts, and uncertain-outcome handling cannot be
                      bypassed by changing connections.
                    </p>
                  </>
                )}
                {node.type === "reply" && (
                  <Field label="Reply behavior">
                    <select
                      value={node.data.mode}
                      onChange={(e) => patch({ mode: e.target.value })}
                    >
                      <option value="workspace">
                        Follow workspace reply setting
                      </option>
                      <option value="review">
                        Always save a draft for staff review
                      </option>
                    </select>
                  </Field>
                )}
                {node.type === "handoff" && (
                  <>
                    <Field label="Customer handoff message">
                      <textarea
                        rows={4}
                        value={node.data.message}
                        maxLength={1000}
                        onChange={(e) => patch({ message: e.target.value })}
                      />
                    </Field>
                    <Field label="Assign to staff">
                      <select
                        value={node.data.assignedTo}
                        onChange={(e) => patch({ assignedTo: e.target.value })}
                      >
                        <option value="">Keep current assignment</option>
                        {resources.members.map((m: Row) => (
                          <option key={m.id} value={m.id}>
                            {m.name} · {m.role}
                          </option>
                        ))}
                      </select>
                    </Field>
                    <Field label="Ticket priority">
                      <select
                        value={node.data.priority}
                        onChange={(e) => patch({ priority: e.target.value })}
                      >
                        {["keep", "low", "normal", "high", "urgent"].map(
                          (v) => (
                            <option key={v} value={v}>
                              {v === "keep" ? "Keep current priority" : v}
                            </option>
                          ),
                        )}
                      </select>
                    </Field>
                    <p className="wf-note">
                      Channel settings choose the native inbox or Zendesk. This
                      pauses the agent until staff resume it.
                    </p>
                  </>
                )}
                {!!PORTS[node.type].length && (
                  <div className="wf-routing">
                    <h3>Outcome connections</h3>
                    {PORTS[node.type].map((port) => (
                      <Field key={port} label={`Route ${port}`}>
                        <select
                          value={
                            def.edges.find(
                              (e) => e.from === node.id && e.port === port,
                            )?.to ?? ""
                          }
                          onChange={(e) =>
                            connect(node.id, port, e.target.value)
                          }
                        >
                          <option value="">Choose next step</option>
                          {def.nodes
                            .filter(
                              (n) => n.id !== node.id && n.type !== "start",
                            )
                            .map((n) => (
                              <option key={n.id} value={n.id}>
                                {n.title}
                              </option>
                            ))}
                        </select>
                      </Field>
                    ))}
                  </div>
                )}
                {node.type !== "start" && (
                  <button
                    className="danger"
                    onClick={() => {
                      replace({
                        ...def,
                        nodes: def.nodes.filter((n) => n.id !== node.id),
                        edges: def.edges.filter(
                          (e) => e.from !== node.id && e.to !== node.id,
                        ),
                      });
                      setSelected("start");
                      setLink(null);
                    }}
                  >
                    Remove step
                  </button>
                )}
              </fieldset>
            </>
          )}
        </aside>
      </div>
      {!!problems.length && (
        <div className="alert" role="status">
          <strong>Fix these connections before publishing</strong>
          <ul>
            {problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </div>
      )}
      {!dirty && !!loaded.problems.length && !problems.length && (
        <div className="alert" role="status">
          {loaded.problems.join("\n")}
        </div>
      )}
      <div className="wf-bottom">
        <section className="panel">
          <h2>Test the draft</h2>
          <p>
            Follow the actual LangGraph route with a sample question. Uses your
            model and, if selected, reads the verified customer’s account. Stops
            before action execution, approvals, replies, or ticket changes.
          </p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void act(async () => {
                setTest(
                  await request("/workflow/test", {
                    definition: def,
                    question,
                    ...(customer ? { contactId: customer } : {}),
                    channel,
                  }),
                );
              }, "Preview complete. No action was executed or message sent.");
            }}
          >
            <fieldset disabled={!canEdit}>
              <Field label="Test question">
                <textarea
                  value={question}
                  required
                  maxLength={12000}
                  rows={3}
                  onChange={(e) => setQuestion(e.target.value)}
                />
              </Field>
              <Field label="Test customer">
                <select
                  value={customer}
                  onChange={(e) => setCustomer(e.target.value)}
                >
                  <option value="">Anonymous visitor</option>
                  {resources.contacts
                    .filter((c: Row) => c.verified)
                    .map((c: Row) => (
                      <option key={c.id} value={c.id}>
                        {c.name || c.email || c.id} · {c.mapping_keys.length}{" "}
                        mappings
                      </option>
                    ))}
                </select>
              </Field>
              <Field label="Test channel">
                <select
                  value={channel}
                  onChange={(e) => setChannel(e.target.value)}
                >
                  {["portal", "widget", "zendesk"].map((v) => (
                    <option key={v}>{v}</option>
                  ))}
                </select>
              </Field>
              <button
                className="primary"
                disabled={!!problems.length || !question.trim()}
              >
                Test workflow
              </button>
            </fieldset>
          </form>
          {test && (
            <div className="wf-test-result" aria-label="Workflow test result">
              <p>{test.answer}</p>
              {test.action && (
                <p>
                  <strong>{test.action.name}</strong> ·{" "}
                  {test.action.requiresApproval
                    ? "Would require approval"
                    : "Within automatic policy; execution skipped"}
                </p>
              )}
              <ol>
                {test.trace.map((step: Row, i: number) => (
                  <li key={i}>
                    <button onClick={() => setSelected(step.nodeId)}>
                      {step.title}
                    </button>{" "}
                    → {step.outcome}
                    {step.error && <p className="error-text">{step.error}</p>}
                    <small>
                      {step.evidenceCount} cited passages available
                      {step.hasAccount ? " · verified account loaded" : ""}
                    </small>
                  </li>
                ))}
              </ol>
              {!!test.citations.length && (
                <details>
                  <summary>Answer sources</summary>
                  {test.citations.map((c: Row) => (
                    <blockquote key={c.id}>
                      <strong>{c.title}</strong>
                      <p>{c.excerpt}</p>
                    </blockquote>
                  ))}
                </details>
              )}
            </div>
          )}
        </section>
        <section className="panel">
          <h2>Versions and resources</h2>
          <Field label="Workflow name">
            <input
              disabled={!canEdit}
              value={def.title}
              maxLength={100}
              onChange={(e) => replace({ ...def, title: e.target.value })}
            />
          </Field>
          <Field label="Published version">
            <select
              value={historyVersion}
              onChange={(e) => setHistoryVersion(e.target.value)}
            >
              <option value="">Choose a version</option>
              {loaded.versions.map((v: Row) => (
                <option key={v.version} value={v.version}>
                  Version {v.version} ·{" "}
                  {new Date(v.created_at).toLocaleString()}
                </option>
              ))}
            </select>
          </Field>
          <button
            disabled={!canEdit || !historyVersion}
            onClick={() =>
              void act(async () => {
                const version = await request(
                  `/workflow/versions/${historyVersion}`,
                );
                replace(version.definition);
              }, "Version loaded as an unsaved draft. Save and publish to use it.")
            }
          >
            Load version into draft
          </button>
          <details className="wf-resource-details">
            <summary>Workspace resources</summary>
            <p>
              {
                resources.sources.filter(
                  (s: Row) =>
                    s.visibility === "customer" && s.status === "ready",
                ).length
              }{" "}
              approved sources and FAQs ·{" "}
              {resources.actions.filter((a: Row) => a.enabled).length} enabled
              actions ·{" "}
              {resources.contacts.filter((c: Row) => c.verified).length}{" "}
              verified customers listed
            </p>
            {resources.connections.map((c: Row) => (
              <p key={c.provider}>
                {c.provider}: {c.status}
              </p>
            ))}
            {resources.channels.map((c: Row) => (
              <p key={c.id}>
                {c.kind}: {c.published ? "published" : "not published"} ·
                handoff to {c.settings.handoff ?? "native"}
              </p>
            ))}
            <p>
              Manage actions in Actions, customer mappings in Team, and channel
              destinations in Publish. Workflow changes never grant account
              ownership or change credentials.
            </p>
          </details>
          <details className="wf-resource-details">
            <summary>Templates and portability</summary>
            <div className="button-row">
              <button
                disabled={!canEdit}
                onClick={() =>
                  replace(
                    defaultWorkflow(
                      resources.actions
                        .filter((a: Row) => a.enabled)
                        .map((a: Row) => a.id),
                    ),
                  )
                }
              >
                Support template
              </button>
              <button
                disabled={!canEdit}
                onClick={() => {
                  const d = defaultWorkflow();
                  d.title = "Knowledge support";
                  d.nodes = d.nodes.filter(
                    (n) => n.type !== "action" && n.type !== "customer",
                  );
                  d.edges = d.edges
                    .filter((e) => !["customer", "action"].includes(e.from))
                    .map((e) =>
                      e.from === "start"
                        ? { ...e, to: "knowledge" }
                        : e.to === "action"
                          ? { ...e, to: "handoff" }
                          : e,
                    );
                  replace(d);
                }}
              >
                Knowledge-only template
              </button>
              <button
                disabled={!canEdit}
                onClick={() =>
                  replace({
                    format: 1,
                    title: "Human support",
                    nodes: [
                      newWorkflowNode("start", "start", 80, 60),
                      newWorkflowNode("handoff", "handoff", 390, 230),
                    ],
                    edges: [{ from: "start", port: "next", to: "handoff" }],
                  })
                }
              >
                Handoff template
              </button>
              <button
                onClick={() => {
                  const url = URL.createObjectURL(
                    new Blob([JSON.stringify(def, null, 2)], {
                      type: "application/json",
                    }),
                  );
                  const a = document.createElement("a");
                  a.href = url;
                  a.download = "fieldkit-workflow.json";
                  a.click();
                  URL.revokeObjectURL(url);
                }}
              >
                Export JSON
              </button>
              <button
                disabled={!canEdit}
                onClick={() => importFile.current?.click()}
              >
                Import JSON
              </button>
              <input
                ref={importFile}
                type="file"
                accept="application/json,.json"
                hidden
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file)
                    void act(async () => {
                      if (file.size > 150000)
                        throw new Error("Workflow file is too large");
                      replace(
                        WorkflowDefinition.parse(JSON.parse(await file.text())),
                      );
                    }, "Imported as an unsaved draft. Resource IDs must belong to this workspace.");
                  e.target.value = "";
                }}
              />
            </div>
          </details>
          <p className="wf-note">
            Publishing changes new turns and invalidates pending action
            approvals. Existing runs keep their saved graph version. No
            arbitrary scripts, URLs, or credentials are embedded in a workflow.
          </p>
        </section>
      </div>
    </div>
  );
}
