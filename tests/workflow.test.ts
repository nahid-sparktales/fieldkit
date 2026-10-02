import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Platform } from "../packages/platform/src/platform.js";
import {
  defaultWorkflow,
  newWorkflowNode,
  WorkflowDefinition,
  workflowProblems,
  type Workflow,
} from "../packages/platform/src/workflow-definition.js";
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
  providers = new TestProviders(),
  app = new Platform(c, {
    model,
    fetch: providers.fetch,
    mailer: async () => {},
  });
before(async () => {
  await resetDatabase(c.DATABASE_URL);
  await app.migrate();
});
after(() => app.close());
beforeEach(() => {
  model.hook = undefined;
  model.fail = false;
  model.invalidCitation = false;
  providers.writes = 0;
  providers.refunds = [];
  providers.timeoutAfterCommit = false;
});
const publish = async (w: any, def: Workflow) => {
  const current = await app.workflows.get(w.owner);
  const saved = await app.workflows.save(w.owner, {
    revision: current.revision,
    definition: def,
  });
  return app.workflows.publish(w.owner, saved.revision);
};
const turn = async (w: any, body = "What is the return policy?") => {
  const conv = await app.newConversation(w.customer, {
    body,
    requestKey: uid(),
  });
  const run = (await app.db.one("SELECT * FROM runs WHERE conversation_id=$1", [
    conv.id,
  ]))!;
  await app.agent.advance(w.ws.id, run.id);
  return {
    conv,
    run: (await app.db.one("SELECT * FROM runs WHERE id=$1", [run.id]))!,
  };
};
const refund = async (ws: string) =>
  app.actions.save(ws, {
    name: "refund_payment",
    description: "Refund this customer's selected charge",
    kind: "stripe_refund",
    enabled: true,
    policy: {
      mode: "automatic",
      maxAmountMinor: 5000,
      currency: "usd",
      dailyLimit: 5,
    },
  });

test("visual workflow validation rejects loops, missing outcomes, unreachable steps, unbounded decisions and executable config", () => {
  assert.deepEqual(workflowProblems(defaultWorkflow()), []);
  const cycle = defaultWorkflow();
  cycle.edges.find((e) => e.from === "knowledge" && e.port === "empty")!.to =
    "customer";
  assert.ok(workflowProblems(cycle).some((e) => e.includes("Loops")));
  const missing = defaultWorkflow();
  missing.edges.pop();
  assert.ok(workflowProblems(missing).some((e) => e.includes("exactly one")));
  const orphan = defaultWorkflow();
  orphan.nodes.push(newWorkflowNode("agent", "orphan"));
  assert.ok(
    workflowProblems(orphan).some((e) => e.includes("cannot be reached")),
  );
  const bypass = defaultWorkflow();
  bypass.edges.find((e) => e.from === "start")!.to = "action";
  assert.ok(workflowProblems(bypass).length);
  assert.throws(() =>
    WorkflowDefinition.parse({
      ...defaultWorkflow(),
      script: "run arbitrary code",
    }),
  );
  assert.throws(() =>
    WorkflowDefinition.parse({
      ...defaultWorkflow(),
      nodes: [
        {
          ...newWorkflowNode("agent", "agent"),
          data: {
            instructions: "",
            model: "",
            endpoint: "https://evil.example",
          },
        },
      ],
    }),
  );
});

test("workflow drafts use optimistic revisions and cannot publish foreign resources or be edited by agents", async () => {
  const w = await workspace(app),
    other = await workspace(app),
    a = await refund(other.ws.id);
  await knowledge(app, w.ws.id);
  const initial = await app.workflows.get(w.owner);
  assert.equal(initial.publishedVersion, null);
  const def = defaultWorkflow([a.id]);
  const saved = await app.workflows.save(w.owner, {
    revision: 0,
    definition: def,
  });
  assert.equal(saved.revision, 1);
  assert.ok(saved.problems.length);
  await assert.rejects(app.workflows.publish(w.owner, 1), /enabled actions/);
  await assert.rejects(
    app.workflows.save(w.owner, { revision: 0, definition: defaultWorkflow() }),
    /another editor/,
  );
  await assert.rejects(
    app.workflows.save(
      { ...w.owner, role: "agent" },
      { revision: 1, definition: defaultWorkflow() },
    ),
    /administrator/,
  );
  await assert.rejects(app.workflows.get(w.customer), /Staff/);
  const source = await knowledge(app, other.ws.id);
  const sourceNode = def.nodes.find((n) => n.type === "knowledge")!;
  if (sourceNode.type === "knowledge") {
    sourceNode.data.scope = "selected";
    sourceNode.data.sourceIds = [source.id];
  }
  assert.ok(
    (await app.workflows.problems(w.ws.id, def)).some((p) =>
      p.includes("customer-approved"),
    ),
  );
});

test("published workflows pin a graph version and apply source selection, account context and step instructions to the real agent", async () => {
  const w = await workspace(app),
    source = await knowledge(app, w.ws.id);
  const excluded = await app.knowledge.upload(
    w.ws.id,
    "extra.txt",
    Buffer.from("Excluded company information for a different product."),
  );
  await app.knowledge.ingest(w.ws.id, excluded.id);
  await app.db.pool.query(
    "UPDATE sources SET visibility='customer' WHERE id=$1",
    [excluded.id],
  );
  const def = defaultWorkflow();
  const k = def.nodes.find((n) => n.type === "knowledge")!;
  if (k.type === "knowledge") {
    k.data.scope = "selected";
    k.data.sourceIds = [source.id];
  }
  const agent = def.nodes.find((n) => n.type === "agent")!;
  if (agent.type === "agent")
    agent.data.instructions = "Keep the answer to two sentences.";
  await publish(w, def);
  model.hook = async (input) => {
    assert.ok(input.instructions.includes("two sentences"));
    assert.ok(input.evidence.every((e) => e.sourceId === source.id));
    assert.deepEqual(input.actions, []);
    assert.ok((input.account as any).customer);
    assert.ok((input.account as any).billing);
  };
  const result = await turn(w);
  assert.equal(
    result.run.status,
    "completed",
    JSON.stringify(result.run.state),
  );
  assert.equal(result.run.graph_version, "support-v3");
  assert.equal(result.run.workflow_version, 1);
  assert.deepEqual(
    result.run.workflow_definition,
    await app.workflows.components.expand(w.ws.id, def),
  );
  const events = await app.db.rows(
    "SELECT data FROM events WHERE conversation_id=$1 AND kind='agent.step'",
    [result.conv.id],
  );
  assert.deepEqual(events.find((e) => e.data.node === "agent")?.data, {
    runId: result.run.id,
    node: "agent",
    title: agent.title,
    operation: "node",
    workflowVersion: 1,
    status: "running",
    route: "answer",
  });
});

test("a second agent step can review the prior unsent draft within the same bounded turn", async () => {
  const w = await workspace(app);
  await knowledge(app, w.ws.id);
  const def = defaultWorkflow();
  const review = newWorkflowNode("agent", "review");
  if (review.type === "agent")
    review.data.instructions = "Review the prior draft for accuracy.";
  def.nodes.push(review);
  def.edges.find((e) => e.from === "agent" && e.port === "answer")!.to =
    review.id;
  for (const port of ["answer", "clarify", "action", "handoff"])
    def.edges.push({
      from: review.id,
      port,
      to:
        port === "action" ? "action" : port === "handoff" ? "handoff" : "reply",
    });
  await publish(w, def);
  let calls = 0;
  model.hook = async (input) => {
    calls++;
    const prior = input.messages.find((m) => m.role === "workflow_draft");
    if (calls === 1) assert.equal(prior, undefined);
    else {
      assert.ok(prior?.body.includes("not sent to the customer"));
      assert.ok(prior?.body.includes("30 days"));
      assert.ok(input.instructions.includes("Review the prior draft"));
    }
  };
  const result = await turn(w);
  assert.equal(
    result.run.status,
    "completed",
    JSON.stringify(result.run.state),
  );
  assert.equal(calls, 2);
  assert.equal(
    (
      await app.db.rows(
        "SELECT id FROM messages WHERE conversation_id=$1 AND role='assistant'",
        [result.conv.id],
      )
    ).length,
    1,
  );
});

test("the configured approval gate survives a fresh process and executes one authorized effect", async () => {
  const w = await workspace(app);
  await knowledge(app, w.ws.id);
  const a = await refund(w.ws.id);
  await publish(w, defaultWorkflow([a.id]));
  const { run } = await turn(w, "Please refund this charge");
  assert.equal(run.status, "waiting_approval", JSON.stringify(run.state));
  assert.equal(providers.writes, 0);
  const approval = (await app.db.one(
    "SELECT * FROM approvals WHERE run_id=$1",
    [run.id],
  ))!;
  await app.decide(w.owner, approval.id, approval.hash, "approve");
  const child = await promisify(execFile)(
    process.execPath,
    ["--import", "tsx", "tests/recovery-worker.ts", w.ws.id, run.id],
    {
      env: {
        ...process.env,
        ...Object.fromEntries(
          Object.entries(c)
            .filter(([, v]) => v !== undefined)
            .map(([k, v]) => [k, String(v)]),
        ),
      },
      timeout: 30000,
    },
  );
  assert.match(child.stdout, /"writes":1/);
  const final = (await app.db.one("SELECT * FROM runs WHERE id=$1", [run.id]))!;
  assert.equal(final.status, "completed");
  assert.equal(final.state.receipt.result.amountMinor, 4900);
  const steps = await app.db.rows(
    "SELECT data FROM events WHERE kind='agent.step' AND data->>'runId'=$1 AND data->>'operation' IN ('approve','execute') ORDER BY id",
    [run.id],
  );
  assert.deepEqual(
    steps.map(({ data }) => ({
      node: data.node,
      operation: data.operation,
      route: data.route,
      workflowVersion: data.workflowVersion,
    })),
    [
      {
        node: "action",
        operation: "approve",
        route: "execute",
        workflowVersion: 1,
      },
      {
        node: "action",
        operation: "execute",
        route: "respond",
        workflowVersion: 1,
      },
    ],
  );
  await app.agent.advance(w.ws.id, run.id);
  assert.equal(providers.writes, 0);
});

test("publishing a new workflow revokes pending approvals and keeps old run snapshots intact", async () => {
  const w = await workspace(app);
  await knowledge(app, w.ws.id);
  const a = await refund(w.ws.id);
  const legacyConversation = await app.newConversation(w.customer, {
    body: "refund please",
    requestKey: uid(),
  });
  const legacyRun = (await app.db.one(
    "SELECT * FROM runs WHERE conversation_id=$1",
    [legacyConversation.id],
  ))!;
  assert.equal(legacyRun.graph_version, "support-v2");
  const def = defaultWorkflow([a.id]);
  await publish(w, def);
  await app.agent.advance(w.ws.id, legacyRun.id);
  assert.equal(
    (await app.db.one("SELECT status FROM runs WHERE id=$1", [legacyRun.id]))!
      .status,
    "handed_off",
  );
  assert.equal(providers.writes, 0);
  const { run } = await turn(w, "refund please");
  assert.equal(run.status, "waiting_approval");
  const replacement = defaultWorkflow();
  replacement.title = "No refunds in workflow";
  await publish(w, replacement);
  assert.equal(
    (await app.db.one("SELECT status FROM approvals WHERE run_id=$1", [
      run.id,
    ]))!.status,
    "stale",
  );
  await app.agent.advance(w.ws.id, run.id);
  assert.equal(providers.writes, 0);
  const saved = (await app.db.one("SELECT * FROM runs WHERE id=$1", [run.id]))!;
  assert.deepEqual(
    saved.workflow_definition,
    await app.workflows.components.expand(w.ws.id, def),
  );
  assert.equal(saved.status, "handed_off");
  const next = await turn(w, "refund please");
  assert.equal(next.run.workflow_version, 2);
  assert.equal(next.run.status, "handed_off");
  assert.equal(providers.writes, 0);
});

test("anonymous and unmapped customers cannot run account actions; malicious routing cannot skip execution guards", async () => {
  const w = await workspace(app);
  await knowledge(app, w.ws.id);
  const a = await refund(w.ws.id);
  const def = defaultWorkflow([a.id]);
  const gate = def.nodes.find((n) => n.type === "action")!;
  if (gate.type === "action") gate.data.approval = "policy";
  await publish(w, def);
  await app.db.pool.query("UPDATE contacts SET verified=false WHERE id=$1", [
    w.contactId,
  ]);
  model.hook = async (input) => {
    assert.deepEqual(input.actions, []);
    assert.equal(input.account, null);
  };
  assert.equal((await turn(w, "refund please")).run.status, "handed_off");
  assert.equal(providers.writes, 0);
  model.hook = undefined;
  await app.db.pool.query(
    "UPDATE contacts SET verified=true,mappings='{}',revision=revision+1 WHERE id=$1",
    [w.contactId],
  );
  assert.equal((await turn(w, "refund please")).run.status, "handed_off");
  assert.equal(providers.writes, 0);
  const bypass = defaultWorkflow();
  bypass.nodes = bypass.nodes.filter((n) => n.type !== "action");
  bypass.edges = bypass.edges
    .filter((e) => e.from !== "action")
    .map((e) => (e.to === "action" ? { ...e, to: "reply" } : e));
  await publish(w, bypass);
  assert.equal((await turn(w, "refund please")).run.status, "handed_off");
  assert.equal(providers.writes, 0);
});

test("condition branches, explicit staff review, handoff assignment and preview match the published routes", async () => {
  const w = await workspace(app);
  await knowledge(app, w.ws.id);
  const def = defaultWorkflow();
  const condition = newWorkflowNode("condition", "verified", 80, 120);
  def.nodes.push(condition);
  def.edges.find((e) => e.from === "start")!.to = "verified";
  def.edges.push(
    { from: "verified", port: "yes", to: "customer" },
    { from: "verified", port: "no", to: "handoff" },
  );
  const handoff = def.nodes.find((n) => n.type === "handoff")!;
  if (handoff.type === "handoff") {
    handoff.data.message = "Our team will help you sign in.";
    handoff.data.assignedTo = w.owner.userId!;
    handoff.data.priority = "high";
  }
  const reply = def.nodes.find((n) => n.type === "reply")!;
  if (reply.type === "reply") reply.data.mode = "review";
  await publish(w, def);
  const preview = await app.workflows.preview(w.owner, {
    definition: def,
    question: "Return policy?",
    channel: "widget",
  });
  assert.deepEqual(
    preview.trace.map((s) => s.nodeId),
    ["start", "verified", "handoff"],
  );
  assert.equal(preview.answer, "Our team will help you sign in.");
  assert.equal(preview.actionsExecuted, false);
  const reviewed = await turn(w);
  assert.equal(reviewed.run.status, "handed_off");
  assert.equal(
    (await app.db.one("SELECT role FROM messages WHERE request_key=$1", [
      `run:${reviewed.run.id}`,
    ]))!.role,
    "note",
  );
  await app.db.pool.query("UPDATE contacts SET verified=false WHERE id=$1", [
    w.contactId,
  ]);
  const result = await turn(w);
  const conv = (await app.db.one("SELECT * FROM conversations WHERE id=$1", [
    result.conv.id,
  ]))!;
  assert.equal(conv.mode, "human");
  assert.equal(conv.assigned_to, w.owner.userId);
  assert.equal(conv.priority, "high");
});

test("draft preview reads only the selected verified customer and stops before approvals or writes", async () => {
  const w = await workspace(app),
    other = await workspace(app);
  await knowledge(app, w.ws.id);
  const a = await refund(w.ws.id);
  const def = defaultWorkflow([a.id]);
  await assert.rejects(
    app.workflows.preview(w.owner, {
      definition: def,
      question: "refund please",
      contactId: other.contactId,
    }),
    /Not found/,
  );
  const before = (
    await app.db.rows("SELECT id FROM conversations WHERE workspace_id=$1", [
      w.ws.id,
    ])
  ).length;
  const preview = await app.workflows.preview(w.owner, {
    definition: def,
    question: "refund please",
    contactId: w.contactId,
  });
  assert.equal(preview.action.requiresApproval, true);
  assert.equal(preview.action.name, "refund_payment");
  assert.equal(providers.writes, 0);
  assert.equal(preview.trace.at(-1).nodeId, "action");
  assert.equal(
    (
      await app.db.rows("SELECT id FROM conversations WHERE workspace_id=$1", [
        w.ws.id,
      ])
    ).length,
    before,
  );
  assert.equal(
    (
      await app.db.rows("SELECT id FROM approvals WHERE workspace_id=$1", [
        w.ws.id,
      ])
    ).length,
    0,
  );
});

test("takeover and changed customer mappings prevent publication from configured workflows", async () => {
  const w = await workspace(app);
  await knowledge(app, w.ws.id);
  await publish(w, defaultWorkflow());
  model.hook = async () => {
    await app.db.pool.query(
      "UPDATE contacts SET revision=revision+1 WHERE id=$1",
      [w.contactId],
    );
  };
  const changed = await turn(w);
  assert.equal(changed.run.status, "handed_off");
  assert.match(changed.run.state.error, /identity changed/);
  model.hook = async (input) => {
    const run = (await app.db.one(
      "SELECT conversation_id FROM runs WHERE id=$1",
      [input.runId],
    ))!;
    await app.control(w.owner, run.conversation_id, { mode: "human" });
  };
  const taken = await turn(w);
  assert.equal(taken.run.status, "stale");
  assert.equal(
    (
      await app.db.rows("SELECT id FROM messages WHERE request_key=$1", [
        `run:${taken.run.id}`,
      ])
    ).length,
    0,
  );
});
