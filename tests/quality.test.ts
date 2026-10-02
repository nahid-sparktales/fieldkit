import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { Platform } from "../packages/platform/src/platform.js";
import { uid } from "../packages/platform/src/db.js";
import { defaultWorkflow } from "../packages/platform/src/workflow-definition.js";
import { classifyHandoff } from "../packages/platform/src/quality.js";
import { modernRating } from "../packages/platform/src/feedback-sync.js";
import { LiveModel } from "../packages/platform/src/model.js";
import { usageContext } from "../packages/platform/src/usage-context.js";
import {
  testConfig,
  resetDatabase,
  workspace,
  knowledge,
  TestModel,
  TestProviders,
} from "./helpers.js";
const config = testConfig(),
  model = new TestModel(),
  providers = new TestProviders(),
  app = new Platform(config, {
    model,
    fetch: providers.fetch,
    mailer: async () => {},
  });
before(async () => {
  await resetDatabase(config.DATABASE_URL);
  await app.migrate();
});
after(() => app.close());
beforeEach(() => {
  model.hook = undefined;
  model.fail = false;
  model.invalidCitation = false;
  providers.writes = 0;
});
async function setup() {
  const w = await workspace(app);
  await knowledge(app, w.ws.id);
  return { ...w, agent: { ...w.owner, role: "agent" as const } };
}
async function suite(
  w: any,
  turns: any[] = [
    {
      question: "Return policy?",
      expected: {
        intent: "answer",
        nodes: ["knowledge"],
        reference: "30 days",
      },
    },
  ],
  fixtures: any = {},
) {
  return app.quality.saveSuite(w.owner, {
    name: "Regression suite",
    cases: [{ id: "case", name: "Returns", turns, fixtures }],
  });
}
async function finish(ws: string, id: string) {
  for (let i = 0; i < 30; i++) {
    const j = (await app.db.one("SELECT status FROM quality_jobs WHERE id=$1", [
      id,
    ]))!;
    if (!["queued", "running"].includes(j.status)) return j;
    await app.quality.advance(ws, id);
  }
  throw new Error("Run did not finish");
}
async function answer(w: any) {
  const c = await app.newConversation(w.customer, {
    body: "Return policy?",
    requestKey: uid(),
  });
  const r = (await app.db.one("SELECT id FROM runs WHERE conversation_id=$1", [
    c.id,
  ]))!;
  await app.agent.advance(w.ws.id, r.id);
  const m = (await app.db.one(
    "SELECT * FROM messages WHERE conversation_id=$1 AND role='assistant'",
    [c.id],
  ))!;
  return { c, m };
}
test("evaluation snapshots compare models across multi-turn real workflows without customer writes", async () => {
  const w = await setup(),
    s = await suite(w, [
      { question: "Return policy?", expected: { intent: "answer" } },
      { question: "And the deadline?", expected: { intent: "handoff" } },
    ]);
  const observed: any[] = [];
  model.hook = async (i) => {
    observed.push(structuredClone(i));
  };
  const before = await app.db.one(
    "SELECT (SELECT count(*) FROM messages)n,(SELECT count(*) FROM approvals)a,(SELECT count(*) FROM operations)o,(SELECT count(*) FROM deliveries)d",
  );
  const j = await app.quality.startEvaluation(w.owner, {
    suiteId: s.id,
    tokenCap: 100000,
    variants: [
      { name: "A", model: "model-a" },
      { name: "B", model: "model-b" },
    ],
  });
  await app.quality.saveSuite(
    w.owner,
    { name: s.name, revision: s.revision, cases: [] },
    s.id,
  );
  assert.equal((await finish(w.ws.id, j.id)).status, "completed");
  const result = await app.quality.job(w.owner, j.id);
  assert.equal(result.results.length, 4);
  assert.equal(result.snapshot.cases.length, 1);
  assert.deepEqual(
    observed.map((i) => i.model),
    ["model-a", "model-a", "model-b", "model-b"],
  );
  assert.equal(observed[1].messages[1].role, "assistant");
  assert.ok(observed[1].messages[1].body.includes("30 days"));
  assert.equal(
    result.results[1].rules.find((r: any) => r.name === "Expected outcome")
      .passed,
    false,
  );
  assert.equal(result.results[1].judge.grounding, 5);
  await app.quality.review(w.agent, j.id, result.results[1].id, {
    verdict: "pass",
    note: "Reviewed exception",
  });
  const reviewed = await app.quality.job(w.owner, j.id);
  assert.equal(reviewed.results[1].rules[0].passed, false);
  assert.equal(reviewed.results[1].reviews.length, 1);
  assert.deepEqual(
    await app.db.one(
      "SELECT (SELECT count(*) FROM messages)n,(SELECT count(*) FROM approvals)a,(SELECT count(*) FROM operations)o,(SELECT count(*) FROM deliveries)d",
    ),
    before,
  );
  assert.equal(providers.writes, 0);
});
test("fixture account actions stop at approval boundary; missing account fixtures are blocked", async () => {
  const w = await setup();
  const action = await app.actions.save(w.ws.id, {
    name: "refund_payment",
    description: "Refund a selected charge",
    kind: "stripe_refund",
    enabled: true,
  });
  const definition = defaultWorkflow([action.id]);
  const s = await suite(
    w,
    [
      {
        question: "refund",
        expected: {
          intent: "action",
          actionName: "refund_payment",
          parameters: {
            chargeId: "ch_123",
            amountMinor: 4900,
            currency: "usd",
          },
          requiresApproval: true,
        },
      },
    ],
    {
      customer: { verified: true, mappings: { stripe_test: "cus_fixture" } },
      account: {
        billing: [
          {
            mode: "test",
            charges: [
              {
                id: "ch_123",
                amountMinor: 5000,
                refundedMinor: 0,
                currency: "usd",
                paid: true,
                captured: true,
              },
            ],
            subscriptions: [],
          },
        ],
      },
    },
  );
  const j = await app.quality.startEvaluation(w.owner, {
    suiteId: s.id,
    tokenCap: 100000,
    variants: [{ name: "With fixtures", definition }],
    judge: { enabled: false },
  });
  await finish(w.ws.id, j.id);
  let result = await app.quality.job(w.owner, j.id);
  assert.equal(result.status, "completed");
  assert.equal(result.results[0].output.action.requiresApproval, true);
  assert.ok(result.results[0].rules.every((r: any) => r.passed));
  assert.equal(providers.writes, 0);
  s.cases[0].fixtures.account = undefined;
  await app.quality.saveSuite(
    w.owner,
    { name: s.name, revision: s.revision, cases: s.cases },
    s.id,
  );
  const missing = await app.quality.startEvaluation(w.owner, {
    suiteId: s.id,
    tokenCap: 100000,
    variants: [{ name: "Missing", definition }],
  });
  await finish(w.ws.id, missing.id);
  result = await app.quality.job(w.owner, missing.id);
  assert.equal(result.results[0].status, "blocked");
  assert.match(result.results[0].error, /fixture/i);
});
test("knowledge changes, revoked access, cancellation and interrupted attempts cannot silently resume", async () => {
  const w = await setup(),
    s = await suite(w),
    start = () =>
      app.quality.startEvaluation(w.owner, {
        suiteId: s.id,
        tokenCap: 100000,
        variants: [{ name: "A" }],
      });
  const cancelled = await start();
  await app.quality.control(w.owner, cancelled.id, { action: "cancel" });
  await app.quality.advance(w.ws.id, cancelled.id);
  assert.equal(
    (await app.quality.job(w.owner, cancelled.id)).status,
    "cancelled",
  );
  const interrupted = await start();
  await app.db.pool.query(
    "UPDATE evaluation_results SET status='running' WHERE job_id=$1",
    [interrupted.id],
  );
  await app.quality.advance(w.ws.id, interrupted.id);
  assert.equal(
    (await app.quality.job(w.owner, interrupted.id)).status,
    "uncertain",
  );
  await assert.rejects(
    app.quality.control(w.owner, interrupted.id, { action: "retry" }),
    /acknowledgement/,
  );
  await app.quality.control(w.owner, interrupted.id, {
    action: "retry",
    acknowledgeRetry: true,
  });
  assert.equal((await finish(w.ws.id, interrupted.id)).status, "completed");
  const changed = await start();
  await app.db.pool.query(
    "UPDATE sources SET revision=revision+1 WHERE workspace_id=$1",
    [w.ws.id],
  );
  await finish(w.ws.id, changed.id);
  assert.match(
    (await app.quality.job(w.owner, changed.id)).error,
    /Knowledge changed/,
  );
  const revoked = await start();
  await app.db.pool.query(
    "UPDATE memberships SET role='agent' WHERE workspace_id=$1 AND user_id=$2",
    [w.ws.id, w.owner.userId],
  );
  await finish(w.ws.id, revoked.id);
  assert.match(
    (await app.quality.job(w.agent, revoked.id)).error,
    /administrator access/,
  );
});
test("feedback updates preserve history without inflating counts; follow-ups invalidate resolution", async () => {
  const w = await setup(),
    { c, m } = await answer(w);
  assert.ok(m.delivered_at);
  await app.quality.feedback(w.customer, c.id, {
    messageId: m.id,
    resolved: true,
    rating: "good",
  });
  await app.quality.feedback(w.customer, c.id, {
    messageId: m.id,
    resolved: true,
    rating: "good",
    comment: "Thanks",
  });
  let metrics = await app.quality.analytics(w.owner, {});
  assert.equal(metrics.totals!.confirmed_resolution, 1);
  assert.equal(metrics.satisfaction[0].rated, 1);
  assert.equal(
    (await app.quality.feedback(w.customer, c.id))[0].raw.history.length,
    2,
  );
  await app.message(w.customer, c.id, {
    body: "One more issue",
    requestKey: uid(),
  });
  metrics = await app.quality.analytics(w.owner, {});
  assert.equal(metrics.totals!.confirmed_resolution, 0);
  assert.equal(metrics.satisfaction[0].good, 1);
  await app.quality.feedback(w.customer, c.id, {
    messageId: m.id,
    resolved: false,
    rating: "bad",
  });
  await app.quality.feedback(w.customer, c.id, {
    messageId: m.id,
    resolved: false,
    rating: "bad",
  });
  assert.equal((await app.quality.gaps(w.owner))[0].occurrences, 1);
  await app.control(w.owner, c.id, { status: "resolved" });
  await app.control(w.owner, c.id, { status: "open" });
  metrics = await app.quality.analytics(w.owner, {});
  assert.equal(metrics.totals!.reopened, 1);
  assert.equal(metrics.totals!.staff_resolved, 1);
  assert.equal(metrics.totals!.confirmed_resolution, 0);
  const other = await setup();
  await assert.rejects(
    app.quality.feedback(other.customer, c.id, {
      messageId: m.id,
      resolved: true,
    }),
  );
  await assert.rejects(
    app.quality.feedback(
      { ...w.customer, contactId: other.customer.contactId },
      c.id,
      { messageId: m.id, resolved: true },
    ),
  );
  await assert.rejects(
    app.quality.feedback(w.owner, c.id, { messageId: m.id, resolved: true }),
    /Only the customer/,
  );
});
test("gap analysis is incremental, grounded and private; merges and resolution require staff decisions", async () => {
  const w = await setup(),
    { c } = await answer(w);
  const id = await app.quality.flag(w.agent, c.id);
  await app.quality.flag(w.agent, c.id);
  assert.equal((await app.quality.gaps(w.owner))[0].occurrences, 1);
  assert.equal((await app.quality.settings(w.owner)).nightly, false);
  const job = await app.quality.startAnalysis(w.owner, { tokenCap: 100000 });
  assert.equal((await finish(w.ws.id, job.id)).status, "completed");
  const gap = await app.quality.gap(w.owner, id!);
  assert.equal(gap.recommendation.needsStaffInput, false);
  const draft = await app.quality.draft(w.owner, id!);
  assert.equal(draft!.status, "draft");
  assert.equal(draft!.visibility, "staff");
  assert.equal((await app.quality.gap(w.owner, id!)).status, "in_progress");
  await assert.rejects(
    app.quality.startAnalysis(w.owner, { tokenCap: 100000 }),
    /No new/,
  );
  await assert.rejects(
    app.quality.updateGap(w.agent, id!, { status: "resolved" }),
    /reason/,
  );
  await app.quality.updateGap(w.agent, id!, {
    status: "resolved",
    reason: "Reviewed regression result and policy",
  });
  assert.equal((await app.quality.gap(w.owner, id!)).status, "resolved");
  await assert.rejects(
    app.quality.settings(w.agent, { nightly: true, dailyTokenCap: 10000 }),
    /owner/,
  );
  await assert.rejects(
    app.quality.settings(w.owner, { nightly: true, dailyTokenCap: 0 }),
  );
  const another = await app.newConversation(w.customer, {
    body: "Different issue",
    requestKey: uid(),
  });
  const target = await app.quality.flag(w.agent, another.id);
  await app.quality.merge(w.agent, id!, target!);
  assert.equal((await app.quality.gap(w.owner, target!)).occurrences.length, 2);
  assert.equal(classifyHandoff("Model unavailable"), "operational");
  assert.equal(classifyHandoff("Verify identity mapping"), "identity");
  assert.equal(classifyHandoff("No supporting evidence"), "missing_knowledge");
});
test("imports exclude internal notes, require personal-data review and are removed with their source", async () => {
  const w = await setup(),
    { c } = await answer(w);
  await app.message(
    w.owner,
    c.id,
    { body: "PRIVATE INTERNAL NOTE", requestKey: uid() },
    true,
  );
  const imported = await app.quality.importCase(w.owner, c.id);
  assert.ok(!JSON.stringify(imported).includes("PRIVATE INTERNAL NOTE"));
  await assert.rejects(
    app.quality.saveSuite(w.owner, { name: "Import", cases: [imported] }),
    /personal information/,
  );
  imported.personalDataReviewed = true;
  const s = await app.quality.saveSuite(w.owner, {
    name: "Import",
    cases: [imported],
  });
  const j = await app.quality.startEvaluation(w.owner, {
    suiteId: s.id,
    tokenCap: 100000,
    variants: [{ name: "A" }],
  });
  await app.deleteConversation(w.ws.id, c.id);
  await assert.rejects(app.quality.job(w.owner, j.id));
  assert.equal(
    (await app.quality.suites(w.owner))[0].cases[0].unavailable,
    true,
  );
});
test("run and daily budgets reserve tokens atomically before any provider call", async () => {
  const w = await setup(),
    s = await suite(w),
    j = await app.quality.startEvaluation(w.owner, {
      suiteId: s.id,
      tokenCap: 1000,
      variants: [{ name: "A" }],
    });
  await app.db.pool.query(
    "UPDATE quality_jobs SET status='running' WHERE id=$1",
    [j.id],
  );
  const live = new LiveModel(app.db, app.connections);
  await assert.rejects(
    usageContext.run({ purpose: "judging", jobId: j.id }, () =>
      live.judge({ workspaceId: w.ws.id, model: "test-model", payload: {} }),
    ),
    /token cap/,
  );
  assert.equal(
    (await app.db.one("SELECT count(*)::int n FROM usage WHERE context_id=$1", [
      j.id,
    ]))!.n,
    0,
  );
});
test("modern and legacy Zendesk ratings preserve neutral values and reject unanswered responses", () => {
  assert.equal(modernRating({ answers: [] }), null);
  assert.equal(
    modernRating({
      answers: [
        {
          question: { sub_type: "customer_satisfaction" },
          type: "skipped",
          rating_category: "good",
        },
      ],
    }),
    null,
  );
  assert.equal(
    modernRating({
      answers: [
        {
          question: { sub_type: "customer_satisfaction" },
          type: "rating_scale",
          rating: 3,
          rating_category: "neutral",
          updated_at: "2026-01-01",
        },
      ],
    })?.rating,
    "neutral",
  );
});

test("read API fixtures and unavailable code runners are isolated from business systems", async () => {
  const { newWorkflowNode: node, WorkflowDefinition } = await import(
    "../packages/platform/src/workflow-definition.js"
  );
  const w = await setup(),
    empty = {
      type: "object",
      properties: {},
      additionalProperties: false,
      required: [],
    };
  const apiStep = await app.workflows.components.save(w.owner, {
    revision: 0,
    definition: {
      kind: "api",
      name: "Status",
      source: "public_get",
      endpoint: "https://status.example.com/api",
      inputSchema: empty,
      outputSchema: {
        type: "object",
        properties: { status: { type: "string" } },
        required: ["status"],
        additionalProperties: false,
      },
      customerSafe: true,
    },
  });
  const definition = (component: any) =>
    WorkflowDefinition.parse({
      format: 1,
      title: "Fixture flow",
      nodes: [
        node("start", "start"),
        {
          ...node("custom", "check"),
          data: { componentId: component.id, version: 1, inputs: {} },
        },
        {
          ...node("reply", "reply"),
          data: {
            mode: "workspace",
            content: "exact",
            text: "Service is ready.",
          },
        },
        node("handoff", "handoff"),
      ],
      edges: [
        { from: "start", port: "next", to: "check" },
        { from: "check", port: "done", to: "reply" },
        { from: "check", port: "failed", to: "handoff" },
      ],
    });
  const s = await suite(
    w,
    [
      {
        question: "Service status?",
        expected: { intent: "answer", nodes: ["check"] },
      },
    ],
    { steps: { check: { output: { status: "operational" } } } },
  );
  const old = app.connections.fetch;
  let calls = 0;
  app.connections.fetch = async () => {
    calls++;
    throw new Error("Business-system network is forbidden during evaluation");
  };
  try {
    const j = await app.quality.startEvaluation(w.owner, {
      suiteId: s.id,
      tokenCap: 100000,
      variants: [{ name: "API", definition: definition(apiStep) }],
      judge: { enabled: false },
    });
    await finish(w.ws.id, j.id);
    const r = await app.quality.job(w.owner, j.id);
    assert.equal(r.results[0].status, "completed");
    assert.equal(r.results[0].output.answer, "Service is ready.");
    assert.equal(calls, 0);
  } finally {
    app.connections.fetch = old;
  }
  const code = await app.workflows.components.save(w.owner, {
    revision: 0,
    definition: {
      kind: "code",
      name: "Code",
      language: "python",
      code: "def run(input):\n    return {}",
      inputSchema: empty,
      outputSchema: empty,
      customerSafe: true,
    },
  });
  const j = await app.quality.startEvaluation(w.owner, {
    suiteId: s.id,
    tokenCap: 100000,
    variants: [{ name: "Code", definition: definition(code) }],
  });
  await finish(w.ws.id, j.id);
  const r = await app.quality.job(w.owner, j.id);
  assert.equal(r.results[0].status, "blocked");
  assert.match(r.results[0].error, /runner.*not configured/i);
});
test("analysis without authoritative support requests staff input and cannot create policy", async () => {
  const w = await workspace(app),
    c = await app.newConversation(w.customer, {
      body: "Promise me lifetime free shipping.",
      requestKey: uid(),
    });
  await app.connections.connectKey(w.ws.id, "openai", "synthetic-key");
  const id = await app.quality.flag(w.owner, c.id);
  const j = await app.quality.startAnalysis(w.owner, { tokenCap: 100000 });
  await finish(w.ws.id, j.id);
  const g = await app.quality.gap(w.owner, id!);
  assert.equal(g.recommendation.needsStaffInput, true);
  await assert.rejects(
    app.quality.draft(w.owner, id!),
    /Authoritative support/,
  );
});
test("Zendesk imports only linked tickets, pages modern surveys, updates legacy ratings, and exposes revoked access", async () => {
  const w = await setup(),
    { c } = await answer(w);
  await app.db.pool.query(
    "UPDATE conversations SET external_id=$2 WHERE id=$1",
    [c.id, "42"],
  );
  await app.connections.save(
    w.ws.id,
    "zendesk",
    { access_token: "synthetic-token" },
    { subdomain: "fieldkit-test" },
  );
  const original = app.connections.json;
  let score = "neutral",
    legacy = "good",
    denied = false,
    calls = 0;
  const survey = (id: string, ticket: string, category: string) => ({
    id,
    subjects: [{ type: "ticket", id: ticket }],
    answers: [
      {
        type: "rating_scale",
        rating: 3,
        rating_category: category,
        question: {
          sub_type: "customer_satisfaction",
          type: "rating_scale_numeric",
        },
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      { type: "open_ended", value: "A comment", question: {} },
    ],
  });
  app.connections.json = async (_ws, _provider, path) => {
    calls++;
    if (path.includes("/satisfaction_ratings/"))
      return {
        satisfaction_rating: {
          id: 9,
          ticket_id: 42,
          score: legacy,
          comment: "Legacy rating",
          updated_at: new Date().toISOString(),
        },
      };
    if (path.includes("/tickets/"))
      return {
        ticket: {
          updated_at: new Date().toISOString(),
          satisfaction_rating: {
            id: 9,
            score: legacy,
            comment: "Legacy rating",
          },
        },
      };
    if (denied) throw new Error("zendesk returned 403");
    return {
      meta: { has_more: !path.includes("after"), after_cursor: "cursor-2" },
      survey_responses: [
        survey("modern-1", "42", score),
        survey("foreign", "999", "good"),
        {
          id: "unanswered",
          subjects: [{ type: "ticket", id: "42" }],
          answers: [],
        },
      ],
    };
  };
  try {
    await app.feedbackSync.advance(w.ws.id, "999");
    assert.equal(calls, 0);
    await app.feedbackSync.advance(w.ws.id, "42");
    await app.feedbackSync.advance(
      w.ws.id,
      "42",
      "/api/v2/guide/survey_responses?page[after]=cursor-2",
    );
    let f = await app.quality.feedback(w.owner, c.id);
    assert.equal(f.length, 2);
    assert.equal(
      f.find((r: any) => r.source === "zendesk_modern").rating,
      "neutral",
    );
    assert.equal(
      f.find((r: any) => r.source === "zendesk_modern").raw.answers[0].rating,
      3,
    );
    score = "bad";
    legacy = "bad";
    await app.feedbackSync.advance(w.ws.id, "42");
    f = await app.quality.feedback(w.owner, c.id);
    assert.equal(f.length, 2);
    assert.ok(f.every((r: any) => r.rating === "bad"));
    assert.equal((await app.quality.gaps(w.owner))[0].occurrences, 2);
    denied = true;
    await assert.rejects(app.feedbackSync.advance(w.ws.id, "42"), /403/);
    assert.match((await app.quality.settings(w.owner)).sync_error, /403/);
  } finally {
    app.connections.json = original;
  }
});

test("judging validates structured output, attributes usage, and enforces in-flight and daily caps", async () => {
  const w = await setup(),
    s = await suite(w),
    job = await app.quality.startEvaluation(w.owner, {
      suiteId: s.id,
      tokenCap: 100000,
      variants: [{ name: "A" }],
    });
  await app.db.pool.query(
    "UPDATE quality_jobs SET status='running' WHERE id=$1",
    [job.id],
  );
  await app.connections.save(w.ws.id, "deepseek", { apiKey: "synthetic" }, {});
  const old = app.connections.modelRequest;
  let invalid = false,
    release: () => void = () => {},
    started: () => void = () => {};
  let gate: Promise<void> | undefined;
  const live = new LiveModel(app.db, app.connections);
  app.connections.modelRequest = async () => {
    started();
    await gate;
    return {
      choices: [
        {
          finish_reason: "stop",
          message: {
            content: JSON.stringify(
              invalid
                ? {}
                : {
                    grounding: 4,
                    relevance: 4,
                    completeness: 4,
                    referenceConsistency: "not_applicable",
                    explanation: "Evidence reviewed",
                    citationIds: [],
                  },
            ),
          },
        },
      ],
      usage: { prompt_tokens: 13, completion_tokens: 9 },
    };
  };
  const call = () =>
    usageContext.run({ purpose: "judging", jobId: job.id }, () =>
      live.judge({
        workspaceId: w.ws.id,
        provider: "deepseek",
        model: "test-judge",
        payload: {},
      }),
    );
  try {
    await call();
    invalid = true;
    await assert.rejects(call());
    invalid = false;
    let rows = await app.db.rows("SELECT * FROM usage WHERE context_id=$1", [
      job.id,
    ]);
    assert.equal(rows.length, 2);
    assert.ok(
      rows.every(
        (r) =>
          r.purpose === "judging" &&
          r.input_tokens === 13 &&
          r.output_tokens === 9 &&
          r.reserved === 0 &&
          r.duration_ms !== null,
      ),
    );
    const entered = new Promise<void>((r) => (started = r));
    gate = new Promise<void>((r) => (release = r));
    const pending = call();
    await entered;
    const reserved = Number(
      (await app.db.one(
        "SELECT sum(input_tokens+output_tokens+reserved) n FROM usage WHERE context_id=$1",
        [job.id],
      ))!.n,
    );
    await app.db.pool.query(
      "UPDATE quality_jobs SET token_cap=$2 WHERE id=$1",
      [job.id, reserved],
    );
    await assert.rejects(call(), /token cap/);
    release();
    await pending;
    gate = undefined;
    const c = await app.newConversation(w.customer, {
      body: "Unknown policy",
      requestKey: uid(),
    });
    await app.quality.flag(w.owner, c.id);
    const analysis = await app.quality.startAnalysis(w.owner, {
      tokenCap: 100000,
    });
    await app.db.pool.query(
      "UPDATE quality_jobs SET status='running' WHERE id=$1",
      [analysis.id],
    );
    await app.quality.settings(w.owner, {
      nightly: false,
      dailyTokenCap: 1000,
    });
    await assert.rejects(
      usageContext.run({ purpose: "gap_analysis", jobId: analysis.id }, () =>
        live.analyzeGap({
          workspaceId: w.ws.id,
          provider: "deepseek",
          model: "test-judge",
          payload: {},
        }),
      ),
      /Daily analysis/,
    );
  } finally {
    release();
    app.connections.modelRequest = old;
  }
});

test("analytics uses explicit denominators and delivered reply times, with historical unknowns", async () => {
  const w = await setup(),
    first = await answer(w),
    second = await answer(w);
  const queued = await app.newConversation(w.customer, {
      body: "Queued reply",
      requestKey: uid(),
    }),
    closed = await app.newConversation(w.customer, {
      body: "Closed by staff",
      requestKey: uid(),
    });
  await app.db.pool.query(
    "INSERT INTO messages(id,workspace_id,conversation_id,role,body,request_key) VALUES($1,$2,$3,'assistant','Still queued',$1)",
    [uid(), w.ws.id, queued.id],
  );
  const instant = new Date(Date.now() - 60000).toISOString();
  for (const [item, delay] of [
    [first, 2],
    [second, 4],
  ] as const) {
    await app.db.pool.query(
      "UPDATE messages SET created_at=$2 WHERE conversation_id=$1 AND role='customer'",
      [item.c.id, instant],
    );
    await app.db.pool.query(
      "UPDATE messages SET created_at=$2::timestamptz+($3*interval '1 second'),delivered_at=$2::timestamptz+($3*interval '1 second') WHERE id=$1",
      [item.m.id, instant, delay],
    );
  }
  await app.quality.feedback(w.customer, first.c.id, {
    messageId: first.m.id,
    resolved: true,
    rating: "good",
  });
  await app.control(w.owner, closed.id, { status: "resolved" });
  await app.db.pool.query(
    "UPDATE conversations SET created_at=(SELECT applied_at-interval '1 day' FROM app_migrations WHERE version=9) WHERE id=$1",
    [queued.id],
  );
  const metrics = await app.quality.analytics(w.owner, {});
  assert.equal(metrics.totals!.conversations, 4);
  assert.equal(metrics.totals!.ai_conversations, 2);
  assert.equal(metrics.totals!.confirmed_resolution, 1);
  assert.equal(metrics.totals!.staff_resolved, 1);
  assert.equal(metrics.totals!.response_time_denominator, 2);
  assert.equal(metrics.totals!.average_first_response_ms, 3000);
  assert.equal(metrics.totals!.unknown_delivery, 1);
  assert.equal(metrics.totals!.unknown_history, 1);
  assert.equal(metrics.satisfaction[0].rated, 1);
  assert.equal(metrics.satisfaction[0].unrated, 3);
});
test("gap evidence retains the original question, source changes permit reanalysis, and nightly scheduling is opt-in", async () => {
  const w = await setup(),
    { c } = await answer(w),
    id = await app.quality.flag(w.owner, c.id);
  const j = await app.quality.startAnalysis(w.owner, { tokenCap: 100000 });
  await finish(w.ws.id, j.id);
  await app.message(w.customer, c.id, {
    body: "A different question",
    requestKey: uid(),
  });
  assert.equal(
    (await app.quality.gap(w.owner, id!)).occurrences[0].question,
    "Return policy?",
  );
  await app.quality.flag(w.owner, c.id);
  await app.quality.flag(w.owner, c.id);
  assert.equal((await app.quality.gaps(w.owner)).length, 2);
  const time = new Date("2026-10-02T02:00:00Z");
  await app.quality.schedule(time);
  assert.equal((await app.quality.jobs(w.owner, "analysis")).length, 1);
  await app.quality.settings(w.owner, { nightly: true, dailyTokenCap: 100000 });
  await app.quality.schedule(time);
  await app.quality.schedule(time);
  assert.equal((await app.quality.jobs(w.owner, "analysis")).length, 2);
  await app.db.pool.query(
    "UPDATE sources SET revision=revision+1 WHERE workspace_id=$1",
    [w.ws.id],
  );
  const changed = await app.quality.startAnalysis(w.owner, {
    tokenCap: 100000,
    gapIds: [id],
  });
  assert.equal(changed.snapshot.gaps[0].id, id);
  await app.quality.settings(w.owner, {
    nightly: false,
    dailyTokenCap: 100000,
  });
  const nightly = (await app.db.one(
    "SELECT id FROM quality_jobs WHERE workspace_id=$1 AND request_key LIKE 'nightly:%'",
    [w.ws.id],
  ))!;
  await app.quality.advance(w.ws.id, nightly.id);
  assert.match((await app.quality.job(w.owner, nightly.id)).error, /disabled/);
});
