import { useState } from "react";
import {
  NODE_LABELS,
  PORTS,
  type Workflow,
  type WorkflowNode,
  type NodeType,
} from "../../../packages/platform/src/workflow-definition.js";
import {
  orderedWorkflowSteps,
  outcomeLabel,
  WORKFLOW_TEMPLATES,
  type WorkflowTemplate,
} from "./workflow-guidance.js";
import "./guided-workflow.css";

const hints: Record<NodeType, string> = {
  start: "Each new customer message starts here.",
  knowledge: "Find evidence in customer-approved documents and FAQs.",
  customer: "Look up the verified customer and allowed account details.",
  agent: "Use AI to answer, ask a question, propose an action, or hand off.",
  condition:
    "Choose a path based on customer, channel, knowledge, or a saved value.",
  action:
    "Run only selected actions, with their permissions and approval checks.",
  reply: "Send a response or hold it as a draft for staff review.",
  handoff: "Pause the agent and pass the conversation to your team.",
  custom: "Use a saved Python, JavaScript, or fixed API step.",
  subflow: "Use a saved group of steps and its mapped inputs and outputs.",
  return: "Return the result to the workflow that called this subflow.",
  task: "Run the pinned custom component.",
  scope: "Enter or leave a reusable subflow.",
};

function summary(n: WorkflowNode) {
  if (n.type === "reply")
    return `${n.data.content === "agent" ? "Agent response" : n.data.content === "exact" ? "Saved reply" : "Reply with variables"} · ${n.data.mode === "review" ? "Staff review required" : "Workspace delivery setting"}`;
  if (n.type === "action")
    return `${n.data.actionIds.length} selected actions · ${n.data.approval === "always" ? "Staff approval required" : "Each action’s policy applies"}`;
  if (n.type === "custom" || n.type === "subflow")
    return n.data.componentId
      ? `Pinned version ${n.data.version}`
      : "Choose a saved component in settings";
  if (n.type === "knowledge")
    return n.data.scope === "all"
      ? "All customer-approved knowledge"
      : `${n.data.sourceIds.length} selected sources`;
  return hints[n.type];
}

export function GuidedWorkflow({
  definition,
  selected,
  canEdit,
  subflow,
  visited,
  onSelect,
  onTemplate,
}: {
  definition: Workflow;
  selected: string;
  canEdit: boolean;
  subflow: boolean;
  visited: Set<string>;
  onSelect: (id: string) => void;
  onTemplate: (kind: WorkflowTemplate) => void;
}) {
  const { nodes, reachable } = orderedWorkflowSteps(definition);
  return (
    <div className="wf-guide">
      <div className="wf-guide-intro">
        <span className="eyebrow">BUILD WITH STEPS</span>
        <h2>A clear path for every question.</h2>
        <p>
          Select a step to edit it. Choose what happens next for each outcome,
          or insert a new step. Branches can split and meet again.
        </p>
        {!subflow && (
          <details className="wf-template-picker">
            <summary>Start from a template</summary>
            <p>
              Replaces this draft. Your published workflow stays active until
              you publish again. Undo restores the previous draft.
            </p>
            <div className="wf-template-grid">
              {WORKFLOW_TEMPLATES.map((t) => (
                <button
                  key={t.id}
                  disabled={!canEdit}
                  onClick={() => onTemplate(t.id)}
                >
                  <strong>{t.title}</strong>
                  <span>{t.description}</span>
                </button>
              ))}
            </div>
          </details>
        )}
      </div>
      <ul className="wf-step-list" aria-label="Workflow steps">
        {nodes.map((n) => (
          <li
            key={n.id}
            className={`wf-step-card ${n.type}${n.id === selected ? " selected" : ""}${visited.has(n.id) ? " visited" : ""}`}
          >
            <button
              className="wf-step-heading"
              aria-label={`Edit ${n.title}`}
              aria-pressed={n.id === selected}
              onClick={() => onSelect(n.id)}
            >
              <span className="wf-step-marker" aria-hidden="true">
                {n.type === "start"
                  ? "↳"
                  : n.type === "condition"
                    ? "⑂"
                    : !PORTS[n.type].length
                      ? "■"
                      : "•"}
              </span>
              <span>
                <small>{NODE_LABELS[n.type]}</small>
                <strong>{n.title}</strong>
                <span>{summary(n)}</span>
              </span>
              <span aria-hidden="true" className="wf-step-edit">
                Edit →
              </span>
            </button>
            {!reachable.has(n.id) && (
              <p className="wf-step-warning">
                Not connected to the incoming message. Connect this step or
                remove it before publishing.
              </p>
            )}
            <ul className="wf-step-outcomes" aria-label={`${n.title} outcomes`}>
              {PORTS[n.type].map((port) => {
                const target = definition.nodes.find(
                  (t) =>
                    t.id ===
                    definition.edges.find(
                      (e) => e.from === n.id && e.port === port,
                    )?.to,
                );
                return (
                  <li key={port}>
                    <span>{outcomeLabel(n.type, port)}</span>
                    <span aria-hidden="true">→</span>
                    <button
                      className={!target ? "wf-missing-route" : ""}
                      onClick={() => onSelect(target?.id ?? n.id)}
                      aria-label={
                        target
                          ? `Go to ${target.title} from ${n.title}: ${outcomeLabel(n.type, port)}`
                          : `Choose next step for ${n.title}: ${outcomeLabel(n.type, port)}`
                      }
                    >
                      {target?.title ?? "Choose next step"}
                    </button>
                  </li>
                );
              })}
            </ul>
            {!PORTS[n.type].length && (
              <p className="wf-step-end">This path ends here</p>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function GuidedInsertion({
  node,
  port,
  disabled,
  subflow,
  onInsert,
}: {
  node: WorkflowNode;
  port: string;
  disabled: boolean;
  subflow: boolean;
  onInsert: (type: NodeType) => void;
}) {
  const [type, setType] = useState<NodeType>("condition");
  return (
    <details className="wf-insert-step">
      <summary>Add a new step here</summary>
      <label>
        <span>New step for {outcomeLabel(node.type, port).toLowerCase()}</span>
        <select
          aria-label={`New step for ${port}`}
          value={type}
          disabled={disabled}
          onChange={(e) => setType(e.target.value as NodeType)}
        >
          {(Object.keys(NODE_LABELS) as NodeType[])
            .filter(
              (t) =>
                !["start", "task", "scope"].includes(t) &&
                (t !== "return" || subflow),
            )
            .map((t) => (
              <option key={t} value={t}>
                {NODE_LABELS[t]}
              </option>
            ))}
        </select>
      </label>
      <p>{hints[type]}</p>
      <p>
        {PORTS[type].length
          ? "The first outcome keeps the current next step. Choose the other outcomes after adding."
          : "This ends the path. Any following steps stay in the draft for you to reconnect or remove."}
      </p>
      <button disabled={disabled} onClick={() => onInsert(type)}>
        Insert step
      </button>
    </details>
  );
}
