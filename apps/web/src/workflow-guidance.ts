import {
  defaultWorkflow,
  newWorkflowNode,
  PORTS,
  type NodeType,
  type Workflow,
  type WorkflowNode,
} from "../../../packages/platform/src/workflow-definition.js";

export const WORKFLOW_TEMPLATES = [
  {
    id: "knowledge",
    title: "Answer from knowledge",
    description:
      "Search approved docs, answer questions, and hand off when help is needed.",
  },
  {
    id: "support",
    title: "Support with account actions",
    description:
      "Add verified customer context and actions that require staff approval.",
  },
  {
    id: "handoff",
    title: "Send to your team",
    description:
      "Pass incoming conversations to a person. Choose the message and assignment.",
  },
  {
    id: "reply",
    title: "Send a saved reply",
    description:
      "Write a specific response without a model call. Add conditions as needed.",
  },
] as const;
export type WorkflowTemplate = (typeof WORKFLOW_TEMPLATES)[number]["id"];

export function workflowTemplate(
  kind: WorkflowTemplate,
  actionIds: string[] = [],
): Workflow {
  if (kind === "support") return defaultWorkflow(actionIds);
  if (kind === "knowledge") {
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
    return d;
  }
  const end = newWorkflowNode(kind, kind, 390, 230);
  if (end.type === "reply") end.data.content = "exact";
  return {
    format: 1,
    title: kind === "reply" ? "Saved reply" : "Human support",
    nodes: [newWorkflowNode("start", "start", 80, 60), end],
    edges: [{ from: "start", port: "next", to: kind }],
  };
}

const outcomes: Partial<Record<NodeType, Record<string, string>>> = {
  start: { next: "When a message arrives" },
  knowledge: {
    found: "If knowledge is found",
    empty: "If no knowledge is found",
    failed: "If search fails",
  },
  customer: {
    verified: "If identity is verified",
    anonymous: "If identity is not verified",
    failed: "If account lookup fails",
  },
  agent: {
    answer: "When the agent has an answer",
    clarify: "When more detail is needed",
    action: "When an action is proposed",
    handoff: "When a person is needed",
  },
  condition: { yes: "If the condition matches", no: "Otherwise" },
};
export function outcomeLabel(type: NodeType, port: string) {
  return (
    outcomes[type]?.[port] ??
    {
      done: "When complete",
      failed: "If this step fails",
      next: "Then continue",
    }[port] ??
    port
  );
}

// Keep all branches and disconnected steps visible, and order prerequisites first.
// Invalid cycles are still editable; publication uses the existing validator.
export function orderedWorkflowSteps(def: Workflow) {
  const reachable = new Set<string>();
  const visit = (id: string) => {
    if (reachable.has(id)) return;
    reachable.add(id);
    def.edges.filter((e) => e.from === id).forEach((e) => visit(e.to));
  };
  def.nodes.filter((n) => n.type === "start").forEach((n) => visit(n.id));
  const remaining = [...def.nodes],
    ordered: WorkflowNode[] = [];
  while (remaining.length) {
    const index = remaining.findIndex(
      (n) =>
        !def.edges.some(
          (e) => e.to === n.id && remaining.some((r) => r.id === e.from),
        ),
    );
    ordered.push(remaining.splice(index < 0 ? 0 : index, 1)[0]);
  }
  return {
    nodes: ordered
      .filter((n) => reachable.has(n.id))
      .concat(ordered.filter((n) => !reachable.has(n.id))),
    reachable,
  };
}

export function insertWorkflowStep(
  def: Workflow,
  from: string,
  port: string,
  node: WorkflowNode,
): Workflow {
  const source = def.nodes.find((n) => n.id === from);
  if (
    !source ||
    !PORTS[source.type].includes(port) ||
    def.nodes.some((n) => n.id === node.id)
  )
    throw new Error("Choose an existing outcome and a new step.");
  const target = def.edges.find((e) => e.from === from && e.port === port)?.to;
  const primary = PORTS[node.type][0];
  return {
    ...def,
    nodes: [...def.nodes, node],
    edges: [
      ...def.edges.filter((e) => !(e.from === from && e.port === port)),
      { from, port, to: node.id },
      ...(target && primary
        ? [{ from: node.id, port: primary, to: target }]
        : []),
    ],
  };
}
