import {
  WorkflowLibrary,
  MappingFields,
  SchemaFields,
} from "./WorkflowLibrary.js";
import {
  EMPTY_SCHEMA,
  OPERATORS,
} from "../../../packages/platform/src/workflow-values.js";
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
import { WorkflowFocus } from "./WorkflowFocus.js";
import { useAction } from "./useAction.js";
import { MODEL_PROVIDERS } from "../../../packages/platform/src/model-providers.js";

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
  custom:
    "Run a saved Python, JavaScript, or read-only API step with mapped inputs.",
  subflow:
    "Reuse a saved group of steps with explicit inputs and done/failed outcomes.",
  return: "Return mapped values to the calling workflow.",
  task: "Pinned custom step execution.",
  scope: "Subflow boundary.",
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
function WorkflowEditor({
  ws,
  admin,
  request,
  profile,
  onProfile,
}: {
  profile: string;
  onProfile: (value: string) => void;
  ws: string;
  admin: boolean;
  request: (path: string, data?: unknown, method?: string) => Promise<any>;
}) {
  const [loaded, setLoaded] = useState<Row | null>(null),
    [definition, setDefinition] = useState<Workflow | null>(null),
    [saved, setSaved] = useState("");
  const [selected, setSelected] = useState("start"),
    [expanded, setExpanded] = useState(false),
    [showInspector, setShowInspector] = useState(true);
  const canvas = useRef<HTMLDivElement>(null),
    expandToggle = useRef<HTMLButtonElement>(null),
    inspectorToggle = useRef<HTMLButtonElement>(null);
  const inspectorId = useId();
  const {
    busy,
    error,
    success,
    setError,
    setSuccess,
    run: act,
  } = useAction("Workflow request failed");
  const [link, setLink] = useState<{ from: string; port: string } | null>(null),
    [zoom, setZoom] = useState(0.8),
    [past, setPast] = useState<Workflow[]>([]),
    [future, setFuture] = useState<Workflow[]>([]);
  const [test, setTest] = useState<Row | null>(null),
    [question, setQuestion] = useState(""),
    [customer, setCustomer] = useState(""),
    [channel, setChannel] = useState(
      profile === "default" ? "portal" : profile,
    ),
    [historyVersion, setHistoryVersion] = useState("");
  const [editingSubflow, setEditingSubflow] = useState<Row | null>(null),
    [subflowInput, setSubflowInput] = useState(
      JSON.stringify(EMPTY_SCHEMA, null, 2),
    ),
    [subflowOutput, setSubflowOutput] = useState(
      JSON.stringify(EMPTY_SCHEMA, null, 2),
    ),
    [subflowSafe, setSubflowSafe] = useState(false),
    [subflowDescription, setSubflowDescription] = useState(""),
    [testInputs, setTestInputs] = useState("{}"),
    [componentVersions, setComponentVersions] = useState<Row>({});
  const mainDraft = useRef<Row | null>(null);
  const selectedNode = definition?.nodes.find((n) => n.id === selected);
  const componentRef =
    selectedNode &&
    (selectedNode.type === "custom" || selectedNode.type === "subflow")
      ? selectedNode.data
      : null;
  useEffect(() => {
    if (!componentRef?.componentId) return;
    let live = true;
    request(
      `/workflow/components/${componentRef.componentId}/versions/${componentRef.version}`,
    )
      .then((r) => {
        if (live)
          setComponentVersions((old) => ({
            ...old,
            [`${componentRef.componentId}:${componentRef.version}`]:
              r.definition,
          }));
      })
      .catch((e) => {
        if (live) setError(e.message);
      });
    return () => {
      live = false;
    };
  }, [ws, componentRef?.componentId, componentRef?.version]);
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
    dirty = Boolean(editingSubflow) || JSON.stringify(def) !== saved,
    node = def.nodes.find((n) => n.id === selected),
    problems = workflowProblems(def, { subflow: Boolean(editingSubflow) });
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
  const changeZoom = (value: number) => {
    const viewport = canvas.current;
    if (!viewport) return;
    const centerX = (viewport.scrollLeft + viewport.clientWidth / 2) / zoom;
    const centerY = (viewport.scrollTop + viewport.clientHeight / 2) / zoom;
    const next = Math.max(0.05, Math.min(1.4, value));
    setZoom(next);
    requestAnimationFrame(() =>
      canvas.current?.scrollTo({
        left: Math.max(0, centerX * next - viewport.clientWidth / 2),
        top: Math.max(0, centerY * next - viewport.clientHeight / 2),
      }),
    );
  };
  const fitWorkflow = () => {
    const viewport = canvas.current;
    if (
      !viewport ||
      viewport.clientWidth <= 48 ||
      viewport.clientHeight <= 48 ||
      !def.nodes.length
    )
      return;
    const left = Math.min(...def.nodes.map((n) => n.x)) - 20;
    const top = Math.min(...def.nodes.map((n) => n.y)) - 24;
    const right = Math.max(...def.nodes.map((n) => n.x + 280));
    const bottom = Math.max(
      ...def.nodes.map((n) => n.y + 100 + PORTS[n.type].length * 25),
    );
    const next = Math.max(
      0.05,
      Math.min(
        1.4,
        (viewport.clientWidth - 48) / (right - left),
        (viewport.clientHeight - 48) / (bottom - top),
      ),
    );
    setZoom(next);
    requestAnimationFrame(() =>
      canvas.current?.scrollTo({
        left: Math.max(0, ((left + right) * next - viewport.clientWidth) / 2),
        top: Math.max(0, ((top + bottom) * next - viewport.clientHeight) / 2),
      }),
    );
  };
  const pathNodes = new Set(test?.trace.map((s: Row) => s.nodeId) ?? []);
  const pathEdges = new Set(
    test?.trace.map((s: Row) => `${s.nodeId}:${s.outcome}`) ?? [],
  );
  const canEdit = admin && !busy;
  const refreshResources = async () => {
    const data = await request("/workflow");
    setLoaded((old) => (old ? { ...old, resources: data.resources } : data));
  };
  const subflowDefinition = () => ({
    kind: "subflow",
    name: def.title,
    description: subflowDescription,
    inputSchema: JSON.parse(subflowInput),
    outputSchema: JSON.parse(subflowOutput),
    customerSafe: subflowSafe,
    workflow: def,
  });
  const returnToMain = () => {
    const prior = mainDraft.current;
    if (prior) {
      setDefinition(prior.definition);
      setSaved(prior.saved);
      setPast(prior.past);
      setFuture(prior.future);
      setSelected(prior.selected);
    }
    setEditingSubflow(null);
    setTest(null);
    setLink(null);
  };
  const editSubflow = (component: Row | null) => {
    if (editingSubflow && !confirm("Discard unsaved subflow edits?")) return;
    if (!editingSubflow)
      mainDraft.current = { definition: def, saved, past, future, selected };
    const d = component?.definition;
    setEditingSubflow(component ?? { id: null, revision: 0 });
    setSubflowInput(JSON.stringify(d?.inputSchema ?? EMPTY_SCHEMA, null, 2));
    setSubflowOutput(JSON.stringify(d?.outputSchema ?? EMPTY_SCHEMA, null, 2));
    setSubflowDescription(d?.description ?? "");
    setSubflowSafe(d?.customerSafe ?? false);
    setTestInputs("{}");
    setDefinition(
      d?.workflow ?? {
        format: 1,
        title: "New subflow",
        nodes: [
          newWorkflowNode("start", "start", 80, 40),
          newWorkflowNode("return", "result", 420, 260),
        ],
        edges: [{ from: "start", port: "next", to: "result" }],
      },
    );
    setSelected("start");
    setPast([]);
    setFuture([]);
    setTest(null);
    setLink(null);
  };
  const save = () =>
    act(
      async () => {
        if (editingSubflow) {
          await request(
            `/workflow/components${editingSubflow.id ? `/${editingSubflow.id}` : ""}`,
            {
              revision: editingSubflow.revision,
              definition: subflowDefinition(),
            },
            editingSubflow.id ? "PUT" : "POST",
          );
          await refreshResources();
          returnToMain();
        } else
          accept(
            await request(
              "/workflow",
              { revision: loaded.revision, definition: def },
              "PUT",
            ),
          );
      },
      editingSubflow
        ? "Subflow version saved. Select it in a Subflow step and publish the main workflow."
        : "Draft saved. Publish it to use it for new conversations.",
    );
  const activeComponent = componentRef
    ? componentVersions[`${componentRef.componentId}:${componentRef.version}`]
    : null;
  const variablePaths = [
    "customer.name",
    "customer.email",
    "customer.id",
    "customer.verified",
    "account.billing",
    "ticket.id",
    "ticket.subject",
    "ticket.category",
    "ticket.priority",
    "ticket.status",
    "message.text",
    "channel.kind",
    "agent.intent",
    "action.reference",
  ];
  for (const n of def.nodes) {
    if (n.type !== "custom" && n.type !== "subflow") continue;
    const c =
      componentVersions[`${n.data.componentId}:${n.data.version}`] ??
      resources.components?.find(
        (c: Row) =>
          c.id === n.data.componentId && c.revision === n.data.version,
      )?.definition;
    for (const key of Object.keys(c?.outputSchema?.properties ?? {}))
      variablePaths.push(`steps.${n.id}.output.${key}`);
  }
  if (editingSubflow)
    try {
      for (const key of Object.keys(JSON.parse(subflowInput).properties ?? {}))
        variablePaths.push(`inputs.${key}`);
    } catch {}
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
      <Field label="Channel workflow">
        <select
          value={profile}
          disabled={busy || Boolean(editingSubflow)}
          onChange={(e) => {
            if (
              !dirty ||
              confirm("Discard unsaved changes and switch channel workflows?")
            )
              onProfile(e.target.value);
          }}
        >
          <option value="default">Workspace default</option>
          <option value="portal">Support tickets & email</option>
          <option value="widget">Live chat & embedded widget</option>
          <option value="zendesk">Zendesk</option>
        </select>
      </Field>
      <p className="muted">
        Each channel can publish its own workflow. Channels without a published
        version use the workspace default. Reusable steps, knowledge, customers,
        and actions are shared.
      </p>
      <div className="wf-toolbar">
        <div>
          <strong>
            {editingSubflow
              ? `Editing reusable subflow${editingSubflow.revision ? ` · version ${editingSubflow.revision}` : ""}`
              : loaded.publishedVersion
                ? `Published version ${loaded.publishedVersion}`
                : loaded.inheritedVersion
                  ? `Using workspace default · version ${loaded.inheritedVersion}`
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
            disabled={busy || Boolean(editingSubflow)}
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
                {editingSubflow ? "Save subflow version" : "Save draft"}
              </button>
              <button
                className="primary"
                disabled={
                  busy ||
                  Boolean(editingSubflow) ||
                  dirty ||
                  !loaded.revision ||
                  !!problems.length
                }
                onClick={() =>
                  void act(async () => {
                    accept(
                      await request("/workflow/publish", {
                        revision: loaded.revision,
                      }),
                    );
                  }, "Workflow published. New turns on this channel use this version; affected pending approvals are invalidated.")
                }
              >
                Publish workflow
              </button>
            </>
          )}
        </div>
      </div>
      {error && !expanded && (
        <div className="alert" role="alert">
          {error}
        </div>
      )}
      {success && !expanded && (
        <p className="success" role="status">
          {success}
        </p>
      )}
      {!editingSubflow && (
        <WorkflowLibrary
          resources={resources}
          admin={admin}
          request={request}
          onChanged={refreshResources}
          onSubflow={editSubflow}
        />
      )}
      {editingSubflow && (
        <section className="panel">
          <div className="button-row">
            <h2>Reusable subflow</h2>
            <button
              onClick={() => {
                if (
                  confirm(
                    "Return to the main workflow? Unsaved subflow edits will be discarded.",
                  )
                )
                  returnToMain();
              }}
            >
              Back to main workflow
            </button>
          </div>
          <p>
            Connect a Return step to finish with done or failed and map the
            values returned to the caller. Reply and handoff steps finish the
            entire customer turn.
          </p>
          <Field label="Subflow description">
            <input
              value={subflowDescription}
              onChange={(e) => setSubflowDescription(e.target.value)}
              maxLength={1000}
            />
          </Field>
          <SchemaFields
            input={subflowInput}
            output={subflowOutput}
            onInput={setSubflowInput}
            onOutput={setSubflowOutput}
          />
          <label className="wf-check">
            <input
              type="checkbox"
              checked={subflowSafe}
              onChange={(e) => setSubflowSafe(e.target.checked)}
            />{" "}
            Allow returned values in customer reply templates
          </label>
        </section>
      )}
      <WorkflowFocus
        expanded={expanded}
        triggerRef={expandToggle}
        close={() => setExpanded(false)}
        title={editingSubflow ? `Subflow · ${def.title}` : def.title}
        actions={
          <>
            <span className="wf-save-status">
              {dirty
                ? "Unsaved changes"
                : loaded.revision
                  ? "Draft saved"
                  : "Unsaved template"}
            </span>
            {admin && (
              <button
                className="primary"
                disabled={busy || (!dirty && loaded.revision > 0)}
                onClick={() => void save()}
              >
                {busy
                  ? "Saving…"
                  : editingSubflow
                    ? "Save subflow version"
                    : "Save draft"}
              </button>
            )}
          </>
        }
      >
        {expanded && error && (
          <div className="alert" role="alert">
            {error}
          </div>
        )}
        {expanded && success && (
          <p className="success" role="status">
            {success}
          </p>
        )}
        <div className="wf-palette" aria-label="Workflow step palette">
          {(Object.keys(NODE_LABELS) as NodeType[])
            .filter(
              (t) =>
                !["start", "task", "scope"].includes(t) &&
                (t !== "return" || editingSubflow),
            )
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
        <div
          className={`wf-editor${showInspector ? "" : " wf-inspector-hidden"}`}
        >
          <section className="wf-map-panel" aria-label="Workflow map">
            <div className="wf-map-tools">
              <div className="button-row">
                <button
                  aria-label="Zoom out"
                  onClick={() => changeZoom(zoom - 0.1)}
                  disabled={zoom <= 0.05}
                >
                  −
                </button>
                <span className="wf-zoom-level" aria-label="Zoom level">
                  {Math.round(zoom * 100)}%
                </span>
                <button
                  aria-label="Zoom in"
                  onClick={() => changeZoom(zoom + 0.1)}
                  disabled={zoom >= 1.4}
                >
                  ＋
                </button>
                <button onClick={fitWorkflow}>Fit workflow</button>
                <button
                  onClick={() => changeZoom(1)}
                  aria-label="Reset zoom to 100%"
                >
                  100%
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
              <div className="button-row wf-view-controls">
                <button
                  ref={inspectorToggle}
                  aria-expanded={showInspector}
                  aria-controls={inspectorId}
                  onClick={() => setShowInspector(!showInspector)}
                >
                  {showInspector ? "Hide step settings" : "Show step settings"}
                </button>
                <button
                  hidden={expanded}
                  ref={expandToggle}
                  onClick={() => {
                    if (matchMedia("(max-width: 760px)").matches)
                      setShowInspector(false);
                    setExpanded(true);
                  }}
                  aria-haspopup="dialog"
                >
                  Expand editor ⤢
                </button>
              </div>
              <span className="wf-canvas-hint">
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
              ref={canvas}
              tabIndex={0}
              aria-label="Scrollable workflow canvas"
              onKeyDown={(e) => {
                if (e.key === "Escape" && link) {
                  e.preventDefault();
                  setLink(null);
                }
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
                            pathEdges.has(`${e.from}:${e.port}`)
                              ? "visited"
                              : ""
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
          <aside
            className="wf-inspector"
            id={inspectorId}
            hidden={!showInspector}
            aria-label="Step settings"
          >
            <button
              className="wf-inspector-close"
              onClick={() => {
                setShowInspector(false);
                requestAnimationFrame(() => inspectorToggle.current?.focus());
              }}
            >
              Back to canvas
            </button>
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
                              s.visibility !== "customer" ||
                              s.status !== "ready",
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
                              detail:
                                "Read-only lookup of the current customer",
                            },
                          ]}
                          selected={node.data.modes}
                          onChange={(modes) => patch({ modes })}
                        />
                      )}
                      <p className="wf-note">
                        Uses the current conversation’s customer. Provider
                        account IDs must come from a reviewed mapping or trusted
                        server identity.
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
                      <Field label="Response provider (optional)">
                        <select
                          value={node.data.provider ?? ""}
                          onChange={(e) =>
                            patch({ provider: e.target.value, model: "" })
                          }
                        >
                          <option value="">Use workspace provider</option>
                          {Object.entries(MODEL_PROVIDERS).map(([id, p]) => (
                            <option key={id} value={id}>
                              {p.name}
                            </option>
                          ))}
                        </select>
                      </Field>
                      <Field label="Response model (optional)">
                        <input
                          value={node.data.model}
                          maxLength={200}
                          placeholder="Use workspace model"
                          onChange={(e) => patch({ model: e.target.value })}
                        />
                      </Field>
                      <p className="wf-note">
                        Available tools come from the governed action step on
                        this route. Workspace usage budgets and timeouts always
                        apply.
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
                          <option value="value">
                            Compare a workflow variable
                          </option>
                        </select>
                      </Field>
                      {node.data.field === "value" && (
                        <>
                          <Field label="Variable to compare">
                            <input
                              value={node.data.path}
                              list="condition-variables"
                              onChange={(e) => patch({ path: e.target.value })}
                              placeholder="steps.lookup.output.plan"
                            />
                          </Field>
                          <datalist id="condition-variables">
                            {variablePaths.map((path) => (
                              <option key={path} value={path} />
                            ))}
                          </datalist>
                          <Field label="Comparison">
                            <select
                              value={node.data.operator}
                              onChange={(e) =>
                                patch({ operator: e.target.value })
                              }
                            >
                              {OPERATORS.map((op) => (
                                <option key={op} value={op}>
                                  {op.replaceAll("_", " ")}
                                </option>
                              ))}
                            </select>
                          </Field>
                          {!["exists", "is_true"].includes(
                            node.data.operator,
                          ) && (
                            <Field label="Compare with">
                              <input
                                value={node.data.value}
                                onChange={(e) =>
                                  patch({ value: e.target.value })
                                }
                                placeholder="Text, 123, or true"
                              />
                            </Field>
                          )}
                        </>
                      )}
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
                  {(node.type === "custom" || node.type === "subflow") && (
                    <>
                      <Field label="Reusable component">
                        <select
                          value={node.data.componentId}
                          onChange={(e) => {
                            const c = resources.components.find(
                              (c: Row) => c.id === e.target.value,
                            );
                            if (c)
                              replace({
                                ...def,
                                nodes: def.nodes.map((n) =>
                                  n.id === node.id
                                    ? ({
                                        ...n,
                                        title: c.name,
                                        data: {
                                          componentId: c.id,
                                          version: c.revision,
                                          inputs: {},
                                        },
                                      } as WorkflowNode)
                                    : n,
                                ),
                              });
                          }}
                        >
                          <option value="">
                            Choose a saved{" "}
                            {node.type === "subflow" ? "subflow" : "step"}
                          </option>
                          {resources.components
                            ?.filter(
                              (c: Row) =>
                                (node.type === "subflow") ===
                                (c.kind === "subflow"),
                            )
                            .map((c: Row) => (
                              <option key={c.id} value={c.id}>
                                {c.name} · latest v{c.revision}
                              </option>
                            ))}
                        </select>
                      </Field>
                      <p>
                        Using version {node.data.version}. Updates are explicit;
                        published runs keep their snapshot.
                      </p>
                      {resources.components?.some(
                        (c: Row) =>
                          c.id === node.data.componentId &&
                          c.revision !== node.data.version,
                      ) && (
                        <button
                          onClick={() =>
                            patch({
                              version: resources.components.find(
                                (c: Row) => c.id === node.data.componentId,
                              ).revision,
                            })
                          }
                        >
                          Use latest component version
                        </button>
                      )}
                      {activeComponent && (
                        <>
                          <p>{activeComponent.description}</p>
                          <MappingFields
                            schema={activeComponent.inputSchema}
                            values={node.data.inputs}
                            onChange={(inputs) => patch({ inputs })}
                            paths={variablePaths}
                          />
                          <details>
                            <summary>Output fields</summary>
                            <pre>
                              {JSON.stringify(
                                activeComponent.outputSchema,
                                null,
                                2,
                              )}
                            </pre>
                            <p>
                              Read results as{" "}
                              <code>steps.{node.id}.output.field</code>.
                            </p>
                          </details>
                        </>
                      )}
                    </>
                  )}
                  {node.type === "return" && (
                    <>
                      <Field label="Return outcome">
                        <select
                          value={node.data.outcome}
                          onChange={(e) => patch({ outcome: e.target.value })}
                        >
                          <option value="done">done</option>
                          <option value="failed">failed</option>
                        </select>
                      </Field>
                      <MappingFields
                        schema={(() => {
                          try {
                            return JSON.parse(subflowOutput);
                          } catch {
                            return EMPTY_SCHEMA;
                          }
                        })()}
                        values={node.data.outputs}
                        onChange={(outputs) => patch({ outputs })}
                        label="Output"
                        paths={variablePaths}
                      />
                    </>
                  )}
                  {node.type === "reply" && (
                    <>
                      <Field label="Reply content">
                        <select
                          value={node.data.content}
                          onChange={(e) => patch({ content: e.target.value })}
                        >
                          <option value="agent">
                            AI answer or confirmed action receipt
                          </option>
                          <option value="exact">Exact reply (no AI)</option>
                          <option value="template">
                            Reply template (no AI)
                          </option>
                        </select>
                      </Field>
                      {node.data.content !== "agent" && (
                        <>
                          <Field label="Customer reply">
                            <textarea
                              rows={6}
                              value={node.data.text}
                              maxLength={12000}
                              onChange={(e) => patch({ text: e.target.value })}
                              placeholder={
                                node.data.content === "template"
                                  ? "Hi {{customer.name}}, your ticket is {{ticket.id}}."
                                  : "Your approved customer reply"
                              }
                            />
                          </Field>
                          {node.data.content === "template" && (
                            <details>
                              <summary>Available reply variables</summary>
                              {variablePaths
                                .filter((p) => p !== "message.text")
                                .map((path) => (
                                  <button
                                    key={path}
                                    className="wf-variable"
                                    onClick={() =>
                                      patch({
                                        text: node.data.text + `{{${path}}}`,
                                      })
                                    }
                                  >{`{{${path}}}`}</button>
                                ))}
                              <p>
                                Only verified customer values and
                                customer-approved step outputs can be inserted.
                                Missing values cause a handoff.
                              </p>
                            </details>
                          )}
                        </>
                      )}
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
                    </>
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
                          onChange={(e) =>
                            patch({ assignedTo: e.target.value })
                          }
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
                        Channel settings choose the native inbox or Zendesk.
                        This pauses the agent until staff resume it.
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
      </WorkflowFocus>
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
            Follow the actual route with a sample question. Code and API reads
            run during tests. Model steps use your model quota. No account
            changes, approvals, messages, or ticket updates are made.
          </p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void act(async () => {
                setTest(
                  editingSubflow
                    ? await request("/workflow/components/test", {
                        definition: subflowDefinition(),
                        input: JSON.parse(testInputs),
                        ...(customer ? { contactId: customer } : {}),
                      })
                    : await request("/workflow/test", {
                        definition: def,
                        question,
                        ...(customer ? { contactId: customer } : {}),
                        channel,
                      }),
                );
              }, "Preview complete. No account changes or messages were sent.");
            }}
          >
            <fieldset disabled={!canEdit}>
              {editingSubflow && (
                <Field label="Subflow test input JSON">
                  <textarea
                    value={testInputs}
                    onChange={(e) => setTestInputs(e.target.value)}
                    rows={4}
                  />
                </Field>
              )}
              <Field label="Test question">
                <textarea
                  value={question}
                  required={!editingSubflow}
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
                disabled={
                  !!problems.length || (!editingSubflow && !question.trim())
                }
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
                    {step.output && (
                      <details>
                        <summary>Step output</summary>
                        <pre>{JSON.stringify(step.output, null, 2)}</pre>
                      </details>
                    )}
                    {step.logs && (
                      <details>
                        <summary>Step logs</summary>
                        <pre>{step.logs}</pre>
                      </details>
                    )}
                    <small>
                      {step.evidenceCount} cited passages available
                      {step.hasAccount ? " · verified account loaded" : ""}
                    </small>
                  </li>
                ))}
              </ol>
              {!!test.citations?.length && (
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
            disabled={!canEdit || Boolean(editingSubflow) || !historyVersion}
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
            approvals. Existing runs keep their saved graph and component
            versions.
          </p>
        </section>
      </div>
    </div>
  );
}

export function WorkflowPage(props: {
  ws: string;
  admin: boolean;
  request: (path: string, data?: unknown, method?: string) => Promise<any>;
}) {
  const [profile, setProfile] = useState(() => {
    const c = new URLSearchParams(location.search).get("channel");
    return c && ["portal", "widget", "zendesk"].includes(c) ? c : "default";
  });
  return (
    <WorkflowEditor
      {...props}
      key={`${props.ws}:${profile}`}
      profile={profile}
      onProfile={(value) => {
        setProfile(value);
        const url = new URL(location.href);
        url.searchParams.set("channel", value);
        history.replaceState(null, "", url);
      }}
      request={(path, data, method) =>
        props.request(
          ["/workflow", "/workflow/publish"].includes(path)
            ? `${path}?channel=${profile}`
            : path,
          data,
          method,
        )
      }
    />
  );
}
