import { z } from "zod";
import { ModelProvider } from "./model-providers.js";

const base = {
  id: z
    .string()
    .regex(/^[a-z][a-z0-9_-]{0,47}$/)
    .refine((v) => !v.includes("__"), "Reserved node ID"),
  title: z.string().trim().min(1).max(80),
  x: z.number().finite().min(0).max(4000),
  y: z.number().finite().min(0).max(3000),
};
const node = <T extends string, S extends z.ZodType>(type: T, data: S) =>
  z.object({ ...base, type: z.literal(type), data }).strict();
export const WorkflowNodeSchema = z.discriminatedUnion("type", [
  node("start", z.object({}).strict()),
  node(
    "knowledge",
    z
      .object({
        scope: z.enum(["all", "selected"]),
        sourceIds: z.array(z.string().max(200)).max(200),
        limit: z.number().int().min(1).max(12),
      })
      .strict(),
  ),
  node(
    "customer",
    z
      .object({
        profile: z.boolean(),
        billing: z.boolean(),
        modes: z.array(z.enum(["test", "live"])).max(2),
      })
      .strict(),
  ),
  node(
    "agent",
    z
      .object({
        instructions: z.string().max(4000),
        provider: z.union([z.literal(""), ModelProvider]).default(""),
        model: z.string().max(200),
      })
      .strict(),
  ),
  node(
    "condition",
    z
      .object({
        field: z.enum(["verified", "mapped", "channel", "evidence"]),
        value: z.string().max(80),
      })
      .strict(),
  ),
  node(
    "action",
    z
      .object({
        actionIds: z.array(z.string().max(200)).max(100),
        approval: z.enum(["always", "policy"]),
      })
      .strict(),
  ),
  node("reply", z.object({ mode: z.enum(["workspace", "review"]) }).strict()),
  node(
    "handoff",
    z
      .object({
        message: z.string().trim().min(1).max(1000),
        assignedTo: z.string().max(200),
        priority: z.enum(["keep", "low", "normal", "high", "urgent"]),
      })
      .strict(),
  ),
]);
export const WorkflowDefinition = z
  .object({
    format: z.literal(1),
    title: z.string().trim().min(1).max(100),
    nodes: z.array(WorkflowNodeSchema).min(2).max(24),
    edges: z
      .array(
        z
          .object({
            from: z.string().max(48),
            port: z.string().max(30),
            to: z.string().max(48),
          })
          .strict(),
      )
      .max(80),
  })
  .strict();
export type Workflow = z.infer<typeof WorkflowDefinition>;
export type WorkflowNode = z.infer<typeof WorkflowNodeSchema>;
export type NodeType = WorkflowNode["type"];
export const NODE_LABELS: Record<NodeType, string> = {
  start: "Incoming conversation",
  knowledge: "Search knowledge",
  customer: "Customer account",
  agent: "Agent decision",
  condition: "Condition",
  action: "Governed action",
  reply: "Reply to customer",
  handoff: "Human handoff",
};
export const PORTS: Record<NodeType, string[]> = {
  start: ["next"],
  knowledge: ["found", "empty", "failed"],
  customer: ["verified", "anonymous", "failed"],
  agent: ["answer", "clarify", "action", "handoff"],
  condition: ["yes", "no"],
  action: ["done", "failed"],
  reply: [],
  handoff: [],
};
export function newWorkflowNode(
  type: NodeType,
  id: string,
  x = 80,
  y = 80,
): WorkflowNode {
  const data = {
    start: {},
    knowledge: { scope: "all", sourceIds: [], limit: 8 },
    customer: { profile: true, billing: true, modes: ["test", "live"] },
    agent: { instructions: "", provider: "", model: "" },
    condition: { field: "verified", value: "" },
    action: { actionIds: [], approval: "always" },
    reply: { mode: "workspace" },
    handoff: {
      message:
        "I’m passing this to the support team so they can help you further.",
      assignedTo: "",
      priority: "keep",
    },
  }[type];
  return WorkflowNodeSchema.parse({
    id,
    type,
    title: NODE_LABELS[type],
    x,
    y,
    data,
  });
}
export function defaultWorkflow(actionIds: string[] = []): Workflow {
  const nodes = [
    newWorkflowNode("start", "start", 60, 40),
    newWorkflowNode("customer", "customer", 60, 210),
    newWorkflowNode("knowledge", "knowledge", 390, 210),
    newWorkflowNode("agent", "agent", 390, 420),
    newWorkflowNode("action", "action", 720, 420),
    newWorkflowNode("reply", "reply", 390, 680),
    newWorkflowNode("handoff", "handoff", 720, 680),
  ];
  const gate = nodes.find((n) => n.type === "action")!;
  if (gate.type === "action") gate.data.actionIds = actionIds;
  const edge = (from: string, port: string, to: string) => ({ from, port, to });
  return {
    format: 1,
    title: "Customer support",
    nodes,
    edges: [
      edge("start", "next", "customer"),
      edge("customer", "verified", "knowledge"),
      edge("customer", "anonymous", "knowledge"),
      edge("customer", "failed", "handoff"),
      edge("knowledge", "found", "agent"),
      edge("knowledge", "empty", "agent"),
      edge("knowledge", "failed", "handoff"),
      edge("agent", "answer", "reply"),
      edge("agent", "clarify", "reply"),
      edge("agent", "action", "action"),
      edge("agent", "handoff", "handoff"),
      edge("action", "done", "reply"),
      edge("action", "failed", "handoff"),
    ],
  };
}
export function workflowProblems(def: Workflow): string[] {
  const errors: string[] = [];
  const byId = new Map(def.nodes.map((n) => [n.id, n]));
  if (byId.size !== def.nodes.length) errors.push("Node IDs must be unique.");
  const starts = def.nodes.filter((n) => n.type === "start");
  if (starts.length !== 1)
    errors.push("Use exactly one incoming conversation step.");
  if (def.nodes.filter((n) => n.type === "action").length > 1)
    errors.push("Use at most one governed action step per turn.");
  if (def.nodes.filter((n) => n.type === "agent").length > 3)
    errors.push("Use at most three model decision steps per turn.");
  if (def.nodes.filter((n) => n.type === "customer").length > 1)
    errors.push("Use at most one customer account step per turn.");
  for (const e of def.edges) {
    const from = byId.get(e.from),
      to = byId.get(e.to);
    if (!from || !to) errors.push("A connection refers to a removed step.");
    else if (!PORTS[from.type].includes(e.port) || to.type === "start")
      errors.push(`Invalid connection from ${from.title} (${e.port}).`);
  }
  for (const n of def.nodes) {
    if (n.type === "agent" && n.data.provider && !n.data.model.trim())
      errors.push(
        `${n.title}: choose a model ID when overriding the response provider.`,
      );
    for (const port of PORTS[n.type])
      if (
        def.edges.filter((e) => e.from === n.id && e.port === port).length !== 1
      )
        errors.push(`Connect ${n.title} → ${port} to exactly one step.`);
    if (
      n.type === "knowledge" &&
      n.data.scope === "selected" &&
      !n.data.sourceIds.length
    )
      errors.push(`Choose at least one source for ${n.title}.`);
    if (n.type === "customer" && n.data.billing && !n.data.modes.length)
      errors.push("Choose a Stripe environment or turn off billing reads.");
    if (
      n.type === "condition" &&
      n.data.field === "mapped" &&
      !/^[a-z][a-z0-9_]{1,40}$/.test(n.data.value)
    )
      errors.push("A mapping condition needs a valid mapping key.");
    if (
      n.type === "condition" &&
      n.data.field === "channel" &&
      !["portal", "widget", "zendesk"].includes(n.data.value)
    )
      errors.push("Choose portal, widget, or zendesk for a channel condition.");
  }
  const visited = new Set<string>(),
    active = new Set<string>();
  const walk = (id: string) => {
    if (active.has(id)) {
      errors.push(
        "Loops are not allowed; each turn must finish at a reply or handoff.",
      );
      return;
    }
    if (visited.has(id)) return;
    visited.add(id);
    active.add(id);
    for (const e of def.edges.filter((e) => e.from === id)) walk(e.to);
    active.delete(id);
  };
  if (starts[0]) walk(starts[0].id);
  for (const n of def.nodes)
    if (!visited.has(n.id))
      errors.push(
        `${n.title} cannot be reached from the incoming conversation.`,
      );
  if (!errors.length) {
    const paths = new Set<string>();
    const check = (id: string, agent: boolean, acted: boolean) => {
      const key = `${id}:${agent}:${acted}`;
      if (paths.has(key)) return;
      paths.add(key);
      const n = byId.get(id)!;
      if ((n.type === "action" || n.type === "reply") && !agent)
        errors.push(
          `${n.title} needs an agent decision on every incoming path.`,
        );
      if (n.type === "agent" && acted)
        errors.push(
          "An agent decision cannot run after an action; route its receipt to a reply or handoff.",
        );
      for (const e of def.edges.filter((e) => e.from === id))
        check(e.to, agent || n.type === "agent", acted || n.type === "action");
    };
    check(starts[0].id, false, false);
  }
  return [...new Set(errors)];
}
