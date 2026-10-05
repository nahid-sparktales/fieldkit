import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { Platform } from "../packages/platform/src/platform.js";
import {
  testConfig,
  resetDatabase,
  workspace,
  knowledge,
  TestModel,
  TestProviders,
} from "./helpers.js";
import { defaultWorkflow } from "../packages/platform/src/workflow-definition.js";
import { uid } from "../packages/platform/src/db.js";
import { selected } from "../packages/platform/src/shadow.js";
import { LiveModel } from "../packages/platform/src/model.js";
import { usageContext } from "../packages/platform/src/usage-context.js";
const config = testConfig(),
  model = new TestModel(),
  providers = new TestProviders();
let mails = 0,
  reads = 0;
const app = new Platform(config, {
  model,
  fetch: async (u, i) => {
    reads++;
    return providers.fetch(u, i);
  },
  mailer: async () => {
    mails++;
  },
});
before(async () => {
  await resetDatabase(config.DATABASE_URL);
  await app.migrate();
});
after(() => app.close());
beforeEach(() => {
  model.hook = undefined;
  model.fail = false;
  mails = 0;
  reads = 0;
  providers.writes = 0;
});
async function setup() {
  const x = await workspace(app);
  await knowledge(app, x.ws.id);
  const def = defaultWorkflow();
  const saved = await app.workflows.save(x.owner, {
    revision: 0,
    definition: def,
  });
  await app.workflows.publish(x.owner, saved.revision);
  const current = await app.workflows.get(x.owner);
  const candidate = await app.shadow.createCandidate(x.owner, {
    name: "Candidate",
    channel: "portal",
    revision: current.revision,
  });
  const exp = await app.shadow.start(x.owner, {
    candidateId: candidate!.id,
    samplePercent: 100,
    hours: 24,
    maxSamples: 100,
    concurrency: 1,
    perRunTokenCap: 20000,
    tokenCap: 100000,
    productionReserve: 10000,
    verifiedOnly: true,
    judge: false,
    authorizedPaid: true,
    requestKey: uid(),
  });
  return { ...x, def, candidate: candidate!, exp };
}
async function turn(x: any, body = "How do returns work?") {
  const conv = await app.newConversation(x.customer, {
    channelId: x.channelId,
    body,
    requestKey: uid(),
  });
  const run = await app.db.one("SELECT * FROM runs WHERE conversation_id=$1", [
    conv.id,
  ]);
  await app.agent.advance(x.ws.id, run.id);
  return {
    conv,
    run: await app.db.one("SELECT * FROM runs WHERE id=$1", [run.id]),
    shadow: await app.db.one(
      "SELECT * FROM shadow_results WHERE source_run_id=$1",
      [run.id],
    ),
  };
}
async function counts(ws: string) {
  const result: any = {};
  for (const table of [
    "conversations",
    "messages",
    "runs",
    "approvals",
    "deliveries",
    "operations",
    "customer_feedback",
    "knowledge_gaps",
    "sla_observations",
    "sla_obligations",
    "sla_notifications",
  ])
    result[table] = Number(
      (
        await app.db.one(
          `SELECT count(*) n FROM ${table} WHERE workspace_id=$1`,
          [ws],
        )
      ).n,
    );
  result.checkpoints = Number(
    (
      await app.db.one(
        "SELECT count(*) n FROM checkpoints.checkpoints WHERE thread_id LIKE $1",
        [`${ws}:%`],
      )
    ).n,
  );
  return result;
}
test("sampling is stable and private; candidate snapshots never publish or follow later draft edits", async () => {
  assert.equal(
    selected("fixed secret", "turn:1", 10),
    selected("fixed secret", "turn:1", 10),
  );
  assert.equal(selected("fixed secret", "turn:1", 100), true);
  assert.equal(selected("fixed secret", "turn:1", 0), false);
  const x = await setup();
  const published = (await app.workflows.get(x.owner)).publishedVersion;
  const def = structuredClone(x.def);
  def.title = "Different draft";
  await app.workflows.save(x.owner, {
    revision: (await app.workflows.get(x.owner)).revision,
    definition: def,
  });
  const snapshot = await app.db.one(
    "SELECT * FROM shadow_candidates WHERE id=$1",
    [x.candidate.id],
  );
  assert.equal(snapshot.snapshot.definition.title, x.def.title);
  assert.equal((await app.workflows.get(x.owner)).publishedVersion, published);
  await assert.rejects(() => app.shadow.dashboard(x.customer), /Staff/);
  const other = await workspace(app);
  await assert.rejects(() => app.shadow.results(other.owner, x.exp.id));
  assert.equal(
    "sampling_key" in (await app.shadow.dashboard(x.owner)).experiments[0],
    false,
  );
});
test("actual workflow shadow uses captured account reads and changes zero customer/business/checkpoint records", async () => {
  const x = await setup(),
    t = await turn(x);
  assert.equal(t.shadow.status, "queued");
  assert.ok(Object.keys(t.shadow.fixtures).length);
  assert.equal(
    t.shadow.history.some((m: any) => m.body === t.run.state.response),
    false,
  );
  const before = await counts(x.ws.id),
    beforeReads = reads,
    beforeMails = mails;
  await app.shadow.advance(x.ws.id, t.shadow.id);
  const r = (await app.shadow.results(x.owner, x.exp.id)).results[0];
  assert.equal(r.status, "completed", r.error);
  assert.equal(r.output.actionsExecuted, false);
  assert.ok(r.output.answer);
  assert.ok(r.rules.every((c: any) => c.passed));
  assert.deepEqual(await counts(x.ws.id), before);
  assert.equal(reads, beforeReads);
  assert.equal(mails, beforeMails);
  assert.equal(providers.writes, 0);
  await app.shadow.advance(x.ws.id, t.shadow.id);
  assert.deepEqual(await counts(x.ws.id), before);
  await app.shadow.review(x.owner, t.shadow.id, {
    verdict: "pass",
    note: "Reviewed the cited return policy.",
  });
  assert.equal(
    (await app.shadow.results(x.owner, x.exp.id)).results[0].reviews.length,
    1,
  );
});
test("missing or wrong-contract fixtures block; identity or source revocation hides derived data", async () => {
  const x = await setup(),
    t = await turn(x);
  await app.db.pool.query(
    "UPDATE shadow_results SET fixtures='{}' WHERE id=$1",
    [t.shadow.id],
  );
  const before = reads;
  await app.shadow.advance(x.ws.id, t.shadow.id);
  assert.equal(reads, before);
  assert.equal(
    (
      await app.db.one("SELECT status FROM shadow_results WHERE id=$1", [
        t.shadow.id,
      ])
    ).status,
    "blocked_missing_fixture",
  );
  await app.db.pool.query(
    "UPDATE contacts SET revision=revision+1 WHERE id=$1",
    [x.contactId],
  );
  const result = await app.shadow.results(x.owner, x.exp.id);
  assert.equal(result.results[0].output, null);
  assert.deepEqual(result.results[0].history, []);
});
test("cancellation between nodes stops work; interrupted evaluations need explicit retry; budgets reserve production capacity", async () => {
  const x = await setup(),
    t = await turn(x);
  await app.db.pool.query(
    "UPDATE shadow_results SET status='running' WHERE id=$1",
    [t.shadow.id],
  );
  await app.shadow.advance(x.ws.id, t.shadow.id);
  assert.equal(
    (
      await app.db.one("SELECT status FROM shadow_results WHERE id=$1", [
        t.shadow.id,
      ])
    ).status,
    "uncertain",
  );
  await assert.rejects(
    () =>
      app.shadow.control(x.owner, x.exp.id, {
        action: "retry",
        resultId: t.shadow.id,
      }),
    /acknowledge/,
  );
  await app.shadow.control(x.owner, x.exp.id, {
    action: "retry",
    resultId: t.shadow.id,
    acknowledgeUncertain: true,
  });
  const live: any = new LiveModel(app.db, app.connections);
  await app.db.pool.query(
    "UPDATE shadow_results SET status='running' WHERE id=$1",
    [t.shadow.id],
  );
  await usageContext.run(
    { purpose: "shadow", shadowId: t.shadow.id, experimentId: x.exp.id },
    async () => {
      await live.reserve(x.ws.id, "response", "test-model", 15000);
      await assert.rejects(
        () => live.reserve(x.ws.id, "response", "test-model", 10000),
        /token cap/,
      );
    },
  );
  await app.shadow.control(x.owner, x.exp.id, { action: "stop" });
  assert.equal(
    (
      await app.db.one("SELECT status FROM shadow_results WHERE id=$1", [
        t.shadow.id,
      ])
    ).status,
    "canceled",
  );
  assert.ok(
    Number(
      (
        await app.db.one(
          "SELECT sum(reserved) n FROM usage WHERE context_id=$1",
          [t.shadow.id],
        )
      ).n,
    ) > 0,
  );
});
test("canary requires review, assigns only new conversations, keeps version per conversation and revokes pending effects on stop", async () => {
  const x = await setup(),
    prior = await turn(x);
  const input = {
    experimentId: x.exp.id,
    percent: 50 as const,
    hours: 24,
    tokenCap: 100000,
    reviewThreshold: 1,
    maxFailures: 5,
    authorizedLiveEffects: true as const,
    decision: "Reviewed exact candidate behavior and accept live replies.",
    requestKey: uid(),
  };
  await assert.rejects(
    () => app.shadow.startCanary(x.owner, input),
    /Review enough/,
  );
  await app.shadow.advance(x.ws.id, prior.shadow.id);
  await app.shadow.review(x.owner, prior.shadow.id, {
    verdict: "pass",
    note: "Citations and behavior reviewed.",
  });
  const rollout = await app.shadow.startCanary(x.owner, input);
  await app.message(x.customer, prior.conv.id, {
    body: "An existing conversation",
    requestKey: uid(),
  });
  assert.equal(
    await app.db.one(
      "SELECT 1 FROM canary_assignments WHERE conversation_id=$1",
      [prior.conv.id],
    ),
    undefined,
  );
  let assigned: any;
  for (let i = 0; i < 30 && !assigned; i++) {
    const conv = await app.newConversation(x.customer, {
      channelId: x.channelId,
      body: "New request",
      requestKey: uid(),
    });
    const a = await app.db.one(
      "SELECT * FROM canary_assignments WHERE conversation_id=$1",
      [conv.id],
    );
    if (a?.variant === "candidate")
      assigned = {
        conv,
        a,
        run: await app.db.one("SELECT * FROM runs WHERE conversation_id=$1", [
          conv.id,
        ]),
      };
  }
  assert.ok(assigned, "Expected a deterministic sample to include a candidate");
  assert.equal(assigned.run.workflow_version, x.candidate.workflow_version);
  await app.shadow.authority(assigned.run);
  await app.message(x.customer, assigned.conv.id, {
    body: "More details",
    requestKey: uid(),
  });
  const next = await app.db.one(
    "SELECT * FROM runs WHERE conversation_id=$1 ORDER BY revision DESC LIMIT 1",
    [assigned.conv.id],
  );
  assert.equal(next.workflow_version, assigned.run.workflow_version);
  await app.shadow.controlCanary(x.owner, rollout.id, {
    action: "stop",
    reason: "Operator kill switch test",
  });
  await assert.rejects(() => app.shadow.authority(next), /revoked/);
  const c = await app.db.one("SELECT * FROM conversations WHERE id=$1", [
    assigned.conv.id,
  ]);
  assert.equal(c.mode, "human");
  assert.equal(c.status, "needs_staff");
  const before = await counts(x.ws.id);
  await app.agent.advance(x.ws.id, next.id);
  assert.deepEqual(await counts(x.ws.id), before);
  assert.equal(providers.writes, 0);
});

test("shadow cancellation during a model request cannot save outputs or change SLA and customer state", async () => {
  const x = await setup(),
    t = await turn(x);
  const before = await counts(x.ws.id);
  model.hook = async () => {
    await app.shadow.control(x.owner, x.exp.id, { action: "stop" });
  };
  await app.shadow.advance(x.ws.id, t.shadow.id);
  const row = await app.db.one("SELECT * FROM shadow_results WHERE id=$1", [
    t.shadow.id,
  ]);
  assert.equal(row!.status, "canceled");
  assert.equal(row!.output, null);
  assert.deepEqual(await counts(x.ws.id), before);
  assert.equal(providers.writes, 0);
});
test("routine OAuth refresh preserves a candidate; explicit credential replacement invalidates it", async () => {
  const x = await setup(),
    before = (await app.shadow.dependencies(x.ws.id, x.channelId)).fingerprint;
  await app.db.pool.query(
    "UPDATE connections SET secret=secret||'refreshed',updated_at=now() WHERE workspace_id=$1 AND provider='stripe_test'",
    [x.ws.id],
  );
  assert.equal(
    (await app.shadow.dependencies(x.ws.id, x.channelId)).fingerprint,
    before,
  );
  await app.db.pool.query(
    "UPDATE connections SET revision=revision+1 WHERE workspace_id=$1 AND provider='stripe_test'",
    [x.ws.id],
  );
  assert.notEqual(
    (await app.shadow.dependencies(x.ws.id, x.channelId)).fingerprint,
    before,
  );
});
