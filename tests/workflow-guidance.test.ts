import { test } from "node:test";
import assert from "node:assert/strict";
import {
  defaultWorkflow,
  newWorkflowNode,
  workflowProblems,
  WorkflowDefinition,
} from "../packages/platform/src/workflow-definition.js";
import {
  insertWorkflowStep,
  orderedWorkflowSteps,
  workflowTemplate,
} from "../apps/web/src/workflow-guidance.js";

test("guided insertion preserves other branches and component settings, and requires explicit fallback routes", () => {
  const original = defaultWorkflow(["refund-policy"]);
  const custom = newWorkflowNode("custom", "lookup");
  if (custom.type !== "custom") throw new Error("fixture");
  custom.data = {
    componentId: "saved-read",
    version: 3,
    inputs: { id: { type: "path", path: "customer.id" } },
  };
  original.nodes.push(custom);
  original.edges.push(
    { from: "lookup", port: "done", to: "customer" },
    { from: "lookup", port: "failed", to: "handoff" },
  );
  original.edges[0].to = "lookup";
  const before = JSON.stringify(original);
  const updated = insertWorkflowStep(
    original,
    "knowledge",
    "found",
    newWorkflowNode("condition", "check"),
  );
  assert.equal(JSON.stringify(original), before);
  assert.deepEqual(
    updated.nodes.find((n) => n.id === "lookup"),
    custom,
  );
  assert.deepEqual(
    updated.edges.filter((e) => e.from === "knowledge" && e.port !== "found"),
    original.edges.filter((e) => e.from === "knowledge" && e.port !== "found"),
  );
  assert.deepEqual(
    updated.edges.filter((e) => e.from === "check"),
    [{ from: "check", port: "yes", to: "agent" }],
  );
  assert.ok(
    workflowProblems(updated).includes(
      "Connect Condition → no to exactly one step.",
    ),
  );
  updated.edges.push({ from: "check", port: "no", to: "handoff" });
  assert.deepEqual(workflowProblems(updated), []);
  assert.deepEqual(
    updated.nodes.find((n) => n.type === "action"),
    original.nodes.find((n) => n.type === "action"),
  );
  assert.throws(() =>
    insertWorkflowStep(
      original,
      "reply",
      "next",
      newWorkflowNode("condition", "check"),
    ),
  );
});

test("guided saved replies and incomplete routes cannot silently orphan or execute following steps", () => {
  const original = workflowTemplate("handoff");
  const reply = newWorkflowNode("reply", "thanks");
  if (reply.type !== "reply") throw new Error("fixture");
  reply.data.content = "exact";
  reply.data.text = "Thanks for contacting support.";
  const updated = insertWorkflowStep(original, "start", "next", reply);
  assert.ok(updated.nodes.some((n) => n.id === "handoff"));
  assert.ok(!updated.edges.some((e) => e.from === "thanks"));
  assert.ok(
    workflowProblems(updated).some((p) => p.includes("cannot be reached")),
  );
  const unconnected = { ...original, edges: [] };
  const added = insertWorkflowStep(
    unconnected,
    "start",
    "next",
    newWorkflowNode("knowledge", "search"),
  );
  assert.equal(added.edges.length, 1);
  assert.ok(workflowProblems(added).some((p) => p.includes("found")));
});

test("guided ordering retains joins, disconnected steps and invalid cycles without modifying the draft", () => {
  const def = defaultWorkflow();
  def.nodes.push(newWorkflowNode("reply", "disconnected"));
  def.edges.push({ from: "agent", port: "answer", to: "customer" });
  const before = JSON.stringify(def);
  const order = orderedWorkflowSteps(def);
  assert.equal(order.nodes.length, def.nodes.length);
  assert.equal(new Set(order.nodes.map((n) => n.id)).size, def.nodes.length);
  assert.equal(order.nodes[0].id, "start");
  assert.equal(order.nodes.at(-1)?.id, "disconnected");
  assert.equal(order.reachable.has("disconnected"), false);
  assert.equal(JSON.stringify(def), before);
});

test("guided templates use ordinary valid workflows and keep action approval required", () => {
  for (const kind of ["knowledge", "support", "handoff"] as const) {
    const def = workflowTemplate(kind, ["approved-action"]);
    WorkflowDefinition.parse(def);
    assert.deepEqual(workflowProblems(def), []);
    if (kind === "support") {
      const action = def.nodes.find((n) => n.type === "action")!;
      assert.equal(action.data.approval, "always");
      assert.deepEqual(action.data.actionIds, ["approved-action"]);
    }
  }
  const reply = workflowTemplate("reply");
  assert.ok(
    workflowProblems(reply).some((p) => p.includes("enter the customer reply")),
  );
  const node = reply.nodes.find((n) => n.type === "reply")!;
  node.data.text = "Thanks. A team member will help.";
  assert.deepEqual(workflowProblems(reply), []);
});
