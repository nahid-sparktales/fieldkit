import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { Platform } from "../packages/platform/src/platform.js";
import {
  newWorkflowNode as node,
  WorkflowDefinition,
  defaultWorkflow,
  type Workflow,
} from "../packages/platform/src/workflow-definition.js";
import {
  bindValues,
  renderReply,
  valueAt,
  matches,
  EMPTY_SCHEMA,
} from "../packages/platform/src/workflow-values.js";
import { WorkflowExecution } from "../packages/platform/src/workflow-execution.js";
import { uid } from "../packages/platform/src/db.js";
import {
  testConfig,
  resetDatabase,
  TestModel,
  TestProviders,
  workspace,
  knowledge,
} from "./helpers.js";

const c = testConfig(),
  model = new TestModel(),
  providers = new TestProviders();
let calls = 0,
  modelCalls = 0,
  apiCalls = 0,
  hook: (() => Promise<void>) | undefined;
const runner = async ({ input }: any) => {
  calls++;
  await hook?.();
  return {
    output: { eligible: input.amount <= 100 },
    logs: "Eligibility evaluated",
  };
};
const app = new Platform(c, {
  model,
  runner,
  mailer: async () => {},
  fetch: async (url, init) => {
    if (url === "https://status.example.com/api") {
      apiCalls++;
      return Response.json({ status: "operational" });
    }
    return providers.fetch(url, init);
  },
});
before(async () => {
  await resetDatabase(c.DATABASE_URL);
  await app.migrate();
});
after(() => app.close());
beforeEach(() => {
  calls = 0;
  modelCalls = 0;
  apiCalls = 0;
  hook = undefined;
  model.hook = async () => {
    modelCalls++;
  };
});
const schema = (properties: any) => ({
  type: "object",
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});
const code = (customerSafe = true) => ({
  kind: "code",
  name: "Eligibility",
  language: "python",
  code: 'def run(input):\n    return {"eligible": input["amount"] <= 100}',
  inputSchema: schema({ amount: { type: "number" } }),
  outputSchema: schema({ eligible: { type: "boolean" } }),
  customerSafe,
});
const reply = (
  id = "reply",
  text = "Thanks, we received your request.",
  content = "exact",
) => ({ ...node("reply", id), data: { mode: "workspace", content, text } });
const edge = (from: string, port: string, to: string) => ({ from, port, to });
const graph = (nodes: any[], edges: any[]) =>
  WorkflowDefinition.parse({
    format: 1,
    title: "Custom workflow",
    nodes,
    edges,
  });
const simple = (text: string, content = "exact") =>
  graph(
    [node("start", "start"), reply("reply", text, content)],
    [edge("start", "next", "reply")],
  );
const save = async (w: any, definition: any, id?: string, revision = 0) =>
  app.workflows.components.save(w.owner, { revision, definition }, id);
const publish = async (w: any, definition: Workflow) => {
  const current = await app.workflows.get(w.owner);
  const draft = await app.workflows.save(w.owner, {
    revision: current.revision,
    definition,
  });
  return app.workflows.publish(w.owner, draft.revision);
};
const turn = async (w: any, body = "Hello") => {
  const conv = await app.newConversation(w.customer, {
    body,
    requestKey: uid(),
  });
  const initial = (await app.db.one(
    "SELECT * FROM runs WHERE conversation_id=$1",
    [conv.id],
  ))!;
  await app.agent.advance(w.ws.id, initial.id);
  return (await app.db.one("SELECT * FROM runs WHERE id=$1", [initial.id]))!;
};
const preview = (w: any, definition: Workflow, verified = true) =>
  app.workflows.preview(w.owner, {
    definition,
    question: "Hello",
    ...(verified ? { contactId: w.contactId } : {}),
  });
const customGraph = (
  component: any,
  text = "Eligible: {{steps.check.output.eligible}}",
  type = "custom",
) =>
  graph(
    [
      node("start", "start"),
      {
        ...node(type as any, "check"),
        data: {
          componentId: component.id,
          version: component.revision,
          inputs: { amount: { type: "value", value: 40 } },
        },
      },
      reply("reply", text, "template"),
      node("handoff", "handoff"),
    ],
    [
      edge("start", "next", "check"),
      edge("check", "done", "reply"),
      edge("check", "failed", "handoff"),
    ],
  );
const componentFlow = (component: any) =>
  graph(
    [
      node("start", "start"),
      {
        ...node("custom", "compute"),
        data: {
          componentId: component.id,
          version: component.revision,
          inputs: { amount: { type: "path", path: "inputs.amount" } },
        },
      },
      {
        ...node("return", "done"),
        data: {
          outcome: "done",
          outputs: {
            eligible: { type: "path", path: "steps.compute.output.eligible" },
          },
        },
      },
      {
        ...node("return", "failed"),
        data: {
          outcome: "failed",
          outputs: { eligible: { type: "value", value: false } },
        },
      },
    ],
    [
      edge("start", "next", "compute"),
      edge("compute", "done", "done"),
      edge("compute", "failed", "failed"),
    ],
  );

test("exact and templated replies run without a model, preserve review mode, and do not trust anonymous customer variables", async () => {
  const w = await workspace(app);
  await app.db.pool.query("DELETE FROM connections WHERE workspace_id=$1", [
    w.ws.id,
  ]);
  await publish(w, simple("Support opens at 9 AM."));
  const run = await turn(w);
  assert.equal(run.status, "completed");
  assert.equal(run.state.response, "Support opens at 9 AM.");
  assert.equal(modelCalls, 0);
  const templated = simple(
    "Hi {{ customer.name }}, your email is {{customer.email}}.",
    "template",
  );
  assert.equal(
    (await preview(w, templated)).answer,
    "Hi Customer, your email is customer@example.test.",
  );
  const anonymous = await preview(w, templated, false);
  assert.equal(anonymous.intent, "handoff");
  assert.ok(!anonymous.answer.includes("customer@example.test"));
  const review = simple("A staff member must review this reply.");
  (review.nodes[1] as any).data.mode = "review";
  await publish(w, review);
  const reviewed = await turn(w);
  assert.equal(reviewed.status, "handed_off");
  assert.equal(
    (await app.db.one("SELECT role FROM messages WHERE request_key=$1", [
      "run:" + reviewed.id,
    ]))!.role,
    "note",
  );
  assert.equal(
    (await app.db.one(
      "SELECT count(*)::int n FROM usage WHERE workspace_id=$1",
      [w.ws.id],
    ))!.n,
    0,
  );
});

test("value mappings and comparisons reject missing, prototype, object and oversized reply values", () => {
  assert.throws(() => valueAt({}, "customer.constructor.name"), /Invalid/);
  assert.throws(
    () => bindValues({ x: { type: "path", path: "customer.email" } }, {}),
    /Missing/,
  );
  assert.throws(
    () => renderReply("{{customer}}", { customer: { id: "x" } }),
    /simple value/,
  );
  assert.throws(
    () =>
      renderReply("{{customer.name}}", {
        customer: { name: "x".repeat(12001) },
      }),
    /12000/,
  );
  assert.equal(matches(undefined, "not_equals", "x"), false);
  assert.equal(matches(40, "less", "100"), true);
  assert.equal(matches("40", "less", "100"), false);
  assert.equal(matches(true, "is_true", ""), true);
});

test("custom step output drives conditions and replies; failed schema validation follows the failure edge", async () => {
  const w = await workspace(app),
    comp = await save(w, code()),
    def = customGraph(comp);
  def.nodes.splice(2, 0, {
    ...node("condition", "eligible"),
    data: {
      field: "value",
      path: "steps.check.output.eligible",
      operator: "is_true",
      value: "",
    },
  } as any);
  def.edges.find((e) => e.from === "check" && e.port === "done")!.to =
    "eligible";
  def.edges.push(
    edge("eligible", "yes", "reply"),
    edge("eligible", "no", "handoff"),
  );
  const result = await preview(w, def);
  assert.equal(result.answer, "Eligible: true");
  assert.equal(modelCalls, 0);
  assert.equal(calls, 1);
  assert.deepEqual(result.trace.find((t) => t.type === "task")!.output, {
    eligible: true,
  });
  const broken = await save(w, {
    ...code(),
    outputSchema: schema({ amount: { type: "number" } }),
  });
  const failed = await preview(w, customGraph(broken));
  assert.equal(failed.intent, "handoff");
  assert.match(
    failed.trace.find((t) => t.type === "task")!.error,
    /Step output/,
  );
});

test("private step output cannot be used in replies or model evidence, including via subflow inputs", async () => {
  const w = await workspace(app),
    comp = await save(w, code(false));
  const result = await preview(w, customGraph(comp));
  assert.equal(result.intent, "handoff");
  assert.match(result.trace.at(-1)!.error, /Missing reply variable/);
  const inner = await save(w, {
    kind: "subflow",
    name: "Message",
    inputSchema: schema({ secret: { type: "boolean" } }),
    outputSchema: EMPTY_SCHEMA,
    workflow: graph(
      [
        node("start", "start"),
        reply("reply", "Private: {{inputs.secret}}", "template"),
      ],
      [edge("start", "next", "reply")],
    ),
  });
  const def = customGraph(comp);
  def.nodes = def.nodes.filter((n) => n.id !== "reply");
  def.nodes.push({
    ...node("subflow", "nested"),
    data: {
      componentId: inner.id,
      version: 1,
      inputs: { secret: { type: "path", path: "steps.check.output.eligible" } },
    },
  } as any);
  def.edges.find((e) => e.from === "check" && e.port === "done")!.to = "nested";
  def.edges.push(
    edge("nested", "done", "handoff"),
    edge("nested", "failed", "handoff"),
  );
  const nested = await preview(w, def);
  assert.equal(nested.intent, "handoff");
  assert.ok(!nested.answer.includes("Private:"));
  const ai = defaultWorkflow();
  ai.nodes.push({
    ...node("custom", "check"),
    data: {
      componentId: comp.id,
      version: 1,
      inputs: { amount: { type: "value", value: 40 } },
    },
  } as any);
  ai.edges.find((e) => e.from === "start")!.to = "check";
  ai.edges.push(
    edge("check", "done", "customer"),
    edge("check", "failed", "handoff"),
  );
  model.hook = async (input) => assert.equal(input.evidence.length, 0);
  assert.equal((await preview(w, ai)).intent, "handoff");
});

test("subflows map inputs and outputs, branch on failure, and pin all nested component versions", async () => {
  const w = await workspace(app),
    comp = await save(w, code());
  const sub = await save(w, {
    kind: "subflow",
    name: "Eligibility subflow",
    customerSafe: true,
    inputSchema: code().inputSchema,
    outputSchema: code().outputSchema,
    workflow: componentFlow(comp),
  });
  const def = customGraph(
    sub,
    "Eligible: {{steps.check.output.eligible}}",
    "subflow",
  );
  assert.equal((await preview(w, def)).answer, "Eligible: true");
  await publish(w, def);
  const savedSnapshot = (await app.db.one(
    "SELECT compiled_definition FROM workflow_versions WHERE workspace_id=$1 AND version=1",
    [w.ws.id],
  ))!.compiled_definition;
  await save(
    w,
    { ...code(), code: 'def run(input):\n    return {"eligible": False}' },
    comp.id,
    1,
  );
  await app.workflows.components.archive(w.owner, comp.id);
  const run = await turn(w);
  assert.equal(run.status, "completed", JSON.stringify(run.state));
  assert.equal(run.state.response, "Eligible: true");
  assert.deepEqual(run.workflow_definition, savedSnapshot);
  assert.equal(
    (await app.db.one(
      "SELECT count(*)::int n FROM workflow_step_results WHERE run_id=$1",
      [run.id],
    ))!.n,
    1,
  );
  await assert.rejects(() => preview(w, def), /existing component version/);
  const changed = await save(w, code());
  const failedSub = await save(w, {
    kind: "subflow",
    name: "Failure subflow",
    customerSafe: true,
    inputSchema: code().inputSchema,
    outputSchema: code().outputSchema,
    workflow: componentFlow(changed),
  });
  hook = async () => {
    throw new Error("runner unavailable");
  };
  assert.equal(
    (await preview(w, customGraph(failedSub, "x", "subflow"))).intent,
    "handoff",
  );
});

test("a completed custom step is reused during recovery and new input cannot replay its cached result", async () => {
  const w = await workspace(app),
    comp = await save(w, code());
  await publish(w, customGraph(comp));
  const run = await turn(w);
  assert.equal(calls, 1);
  const task = run.workflow_definition.nodes.find(
    (n: any) => n.type === "task",
  );
  const execution = new WorkflowExecution(app.db, app.actions, runner);
  run.state.outputs = {};
  await execution.task(run, task);
  assert.equal(calls, 1);
  assert.deepEqual(run.state.outputs[""].check.output, { eligible: true });
  task.data.inputs.amount.value = 999;
  await execution.task(run, task);
  assert.equal(calls, 1);
  assert.equal(run.state.outcome, "failed");
  assert.match(run.state.error, /inputs changed/);
});

test("components enforce tenant, staff, optimistic revision, fixed destinations and recursion rules", async () => {
  const w = await workspace(app),
    other = await workspace(app),
    comp = await save(w, code());
  await assert.rejects(
    () =>
      app.workflows.components.save(
        { ...w.owner, role: "agent" },
        { revision: 0, definition: code() },
      ),
    /owner|admin/i,
  );
  await assert.rejects(
    () => app.workflows.components.version(other.ws.id, comp.id, 1),
    /existing component/,
  );
  await assert.rejects(() => save(w, code(), comp.id, 0), /changed/);
  await assert.rejects(
    () =>
      save(w, {
        kind: "api",
        name: "Unsafe",
        source: "public_get",
        endpoint: "http://127.0.0.1/private",
      }),
    /HTTPS|public|private/,
  );
  await assert.rejects(
    () => save(w, { ...code(), inputSchema: { type: "object" } }),
    /closed object/,
  );
  const sub = await save(w, {
    kind: "subflow",
    name: "Reusable",
    inputSchema: EMPTY_SCHEMA,
    outputSchema: EMPTY_SCHEMA,
    workflow: graph(
      [node("start", "start"), node("return", "done")],
      [edge("start", "next", "done")],
    ),
  });
  const recursive = graph(
    [
      node("start", "start"),
      {
        ...node("subflow", "nested"),
        data: { componentId: sub.id, version: 1, inputs: {} },
      },
      node("return", "done"),
    ],
    [
      edge("start", "next", "nested"),
      edge("nested", "done", "done"),
      edge("nested", "failed", "done"),
    ],
  );
  await assert.rejects(
    () => save(w, { ...sub.definition, workflow: recursive }, sub.id, 1),
    /Recursive/,
  );
});

test("public API steps work anonymously and customer reads reject unverified identity or write actions", async () => {
  const w = await workspace(app),
    api = await save(w, {
      kind: "api",
      name: "Service status",
      source: "public_get",
      endpoint: "https://status.example.com/api",
      outputSchema: schema({ status: { type: "string" } }),
      customerSafe: true,
    });
  const def = customGraph(api, "Status: {{steps.check.output.status}}");
  (def.nodes.find((n) => n.id === "check") as any).data.inputs = {};
  assert.equal((await preview(w, def, false)).answer, "Status: operational");
  assert.equal(apiCalls, 1);
  const action = await app.actions.save(w.ws.id, {
    name: "read_order",
    description: "Read order",
    kind: "custom_read",
    enabled: true,
    config: {
      endpoint: "https://backend.example.com/read",
      mappingKey: "customer_id",
      inputSchema: schema({ orderId: { type: "string" } }),
      outputSchema: schema({
        status: { type: "string" },
        orderId: { type: "string" },
      }),
    },
  });
  const customerApi = await save(w, {
    kind: "api",
    name: "Order lookup",
    source: "customer_action",
    actionId: action.id,
    inputSchema: action.config.inputSchema,
    outputSchema: action.config.outputSchema,
    customerSafe: true,
  });
  const request = customGraph(
    customerApi,
    "Order {{steps.check.output.orderId}}",
  );
  (request.nodes.find((n) => n.id === "check") as any).data.inputs = {
    orderId: { type: "value", value: "order-123" },
  };
  assert.equal((await preview(w, request)).answer, "Order order-123");
  assert.equal((await preview(w, request, false)).intent, "handoff");
  await app.db.pool.query(
    "UPDATE actions SET kind='custom_write',revision=revision+1 WHERE id=$1",
    [action.id],
  );
  assert.equal((await preview(w, request)).intent, "handoff");
  await assert.rejects(
    () => save(w, { ...customerApi.definition }),
    /custom read action/,
  );
});

test("identity changes and staff takeover during custom execution prevent customer publication", async () => {
  const w = await workspace(app),
    comp = await save(w, code());
  await publish(w, customGraph(comp));
  hook = async () => {
    await app.db.pool.query(
      "UPDATE contacts SET revision=revision+1 WHERE id=$1",
      [w.contactId],
    );
  };
  const changed = await turn(w);
  assert.equal(changed.status, "handed_off");
  assert.ok(!changed.state.response.includes("Eligible:"));
  hook = async () => {
    const conv = (await app.db.one(
      "SELECT id FROM conversations WHERE workspace_id=$1 ORDER BY created_at DESC LIMIT 1",
      [w.ws.id],
    ))!;
    await app.control(w.owner, conv.id, { mode: "human" });
  };
  const takeover = await turn(w);
  assert.equal(takeover.status, "stale");
  assert.equal(
    (await app.db.one(
      "SELECT count(*)::int n FROM messages WHERE conversation_id=$1 AND role='assistant'",
      [takeover.conversation_id],
    ))!.n,
    0,
  );
});

test("a custom reply cannot acknowledge an unexecuted account action", async () => {
  const w = await workspace(app);
  await knowledge(app, w.ws.id);
  const action = await app.actions.save(w.ws.id, {
    name: "refund_payment",
    description: "Refund payment",
    kind: "stripe_refund",
    enabled: true,
  });
  const def = defaultWorkflow([action.id]);
  def.nodes = def.nodes.filter((n) => n.type !== "action");
  def.edges = def.edges.filter((e) => e.from !== "action");
  def.edges.find((e) => e.from === "agent" && e.port === "action")!.to =
    "reply";
  (def.nodes.find((n) => n.type === "reply") as any).data = {
    mode: "workspace",
    content: "exact",
    text: "Your refund is complete.",
  };
  await publish(w, def);
  const result = await turn(w, "refund please");
  assert.equal(result.status, "handed_off");
  assert.ok(!result.state.response.includes("refund is complete"));
});

test("governed actions inside expanded subflows retain exact approvals and one effect", async () => {
  const w = await workspace(app);
  await knowledge(app, w.ws.id);
  providers.writes = 0;
  providers.refunds = [];
  const action = await app.actions.save(w.ws.id, {
    name: "refund_payment",
    description: "Refund the selected payment",
    kind: "stripe_refund",
    enabled: true,
  });
  const component = await save(w, {
    kind: "subflow",
    name: "Reviewed refund",
    workflow: defaultWorkflow([action.id]),
  });
  const def = graph(
    [
      node("start", "start"),
      {
        ...node("subflow", "refund"),
        data: { componentId: component.id, version: 1, inputs: {} },
      },
      node("handoff", "handoff"),
    ],
    [
      edge("start", "next", "refund"),
      edge("refund", "done", "handoff"),
      edge("refund", "failed", "handoff"),
    ],
  );
  await publish(w, def);
  const run = await turn(w, "refund please");
  assert.equal(run.status, "waiting_approval", JSON.stringify(run.state));
  assert.equal(providers.writes, 0);
  const approval = (await app.db.one(
    "SELECT * FROM approvals WHERE run_id=$1",
    [run.id],
  ))!;
  await app.decide(w.owner, approval.id, approval.hash, "approve");
  await app.agent.advance(w.ws.id, run.id);
  await app.agent.advance(w.ws.id, run.id);
  assert.equal(providers.writes, 1);
  assert.equal(
    (await app.db.one("SELECT status FROM runs WHERE id=$1", [run.id]))!.status,
    "completed",
  );
});

test("customer-safe step evidence is cited by AI and ticket variables route without model calls", async () => {
  const w = await workspace(app),
    comp = await save(w, code());
  const def = defaultWorkflow();
  def.nodes.push({
    ...node("custom", "check"),
    data: {
      componentId: comp.id,
      version: 1,
      inputs: { amount: { type: "value", value: 40 } },
    },
  } as any);
  def.edges.find((e) => e.from === "start")!.to = "check";
  def.edges.push(
    edge("check", "done", "customer"),
    edge("check", "failed", "handoff"),
  );
  model.hook = async (input) => {
    assert.ok(
      input.evidence.some(
        (e) => e.title === "Eligibility" && e.excerpt.includes("true"),
      ),
    );
  };
  const result = await preview(w, def);
  assert.equal(result.citations[0].title, "Eligibility");
  const routed = graph(
    [
      node("start", "start"),
      {
        ...node("condition", "priority"),
        data: {
          field: "value",
          path: "ticket.priority",
          operator: "equals",
          value: "normal",
        },
      },
      reply("reply", "Normal priority"),
      node("handoff", "handoff"),
    ],
    [
      edge("start", "next", "priority"),
      edge("priority", "yes", "reply"),
      edge("priority", "no", "handoff"),
    ],
  );
  assert.equal((await preview(w, routed)).answer, "Normal priority");
});

test("queued Zendesk replies recheck custom-read authority before delivering account data", async () => {
  const w = await workspace(app);
  await app.connections.save(
    w.ws.id,
    "zendesk",
    { access_token: "test-zendesk" },
    { subdomain: "test" },
  );
  const action = await app.actions.save(w.ws.id, {
    name: "order_lookup",
    description: "Read customer order",
    kind: "custom_read",
    enabled: true,
    config: {
      endpoint: "https://backend.example.com/read",
      mappingKey: "customer_id",
      inputSchema: schema({ orderId: { type: "string" } }),
      outputSchema: schema({
        status: { type: "string" },
        orderId: { type: "string" },
      }),
    },
  });
  const comp = await save(w, {
    kind: "api",
    name: "Order lookup",
    source: "customer_action",
    actionId: action.id,
    inputSchema: action.config.inputSchema,
    outputSchema: action.config.outputSchema,
    customerSafe: true,
  });
  const def = customGraph(comp, "Order: {{steps.check.output.orderId}}");
  (def.nodes.find((n) => n.id === "check") as any).data.inputs = {
    orderId: { type: "value", value: "order-123" },
  };
  await publish(w, def);
  const conv = await app.newConversation(w.customer, {
    body: "Find my order",
    requestKey: uid(),
  });
  await app.db.pool.query(
    "UPDATE conversations SET external_id='11',external_version=$1 WHERE id=$2",
    [providers.zendeskVersion, conv.id],
  );
  const run = (await app.db.one("SELECT * FROM runs WHERE conversation_id=$1", [
    conv.id,
  ]))!;
  await app.agent.advance(w.ws.id, run.id);
  const delivery = (await app.db.one(
    "SELECT * FROM deliveries WHERE conversation_id=$1",
    [conv.id],
  ))!;
  assert.equal(delivery.payload.workflowRunId, run.id);
  await app.db.pool.query(
    "UPDATE actions SET enabled=false,revision=revision+1 WHERE id=$1",
    [action.id],
  );
  providers.writes = 0;
  await app.support.deliver(w.ws.id, delivery.id);
  assert.equal(providers.writes, 0);
  assert.equal(
    (await app.db.one("SELECT status FROM deliveries WHERE id=$1", [
      delivery.id,
    ]))!.status,
    "cancelled",
  );
});
