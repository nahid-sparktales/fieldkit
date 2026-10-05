import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { Platform } from "../packages/platform/src/platform.js";
import {
  testConfig,
  resetDatabase,
  workspace,
  TestModel,
  TestProviders,
} from "./helpers.js";
import { uid } from "../packages/platform/src/db.js";
import { LiveModel } from "../packages/platform/src/model.js";
import { usageContext } from "../packages/platform/src/usage-context.js";
const config = testConfig(),
  model = new TestModel(),
  providers = new TestProviders();
let sent = 0,
  failSend = false;
const app = new Platform(config, {
  model,
  fetch: providers.fetch,
  mailer: async () => {
    sent++;
    if (failSend)
      throw new Error("SMTP uncertain after acceptance; secret=never-store");
  },
});
before(async () => {
  await resetDatabase(config.DATABASE_URL);
  await app.migrate();
});
after(() => app.close());
beforeEach(() => {
  sent = 0;
  failSend = false;
});
async function run(p: any, id: string, extra = {}) {
  const [r] = await app.readiness.start(p, {
    requestKey: uid(),
    checkIds: [id],
    ...extra,
  });
  await app.readiness.advance(p.workspaceId, r.id);
  return (await app.readiness.history(p, id)).runs.find((x) => x.id === r.id)!;
}
test("dashboard is read-only and evidence is scoped, stale and private", async () => {
  const { owner, customer, ws } = await workspace(app);
  assert.equal((await app.readiness.settings(owner)).strict, false);
  const d = await app.readiness.dashboard(owner);
  assert.equal(
    d.checks.find((ch) => ch.id === "response_access")!.level,
    "configured_untested",
  );
  assert.equal(
    await app.db.one("SELECT 1 FROM diagnostic_runs WHERE workspace_id=$1", [
      ws.id,
    ]),
    undefined,
  );
  await assert.rejects(() => app.readiness.dashboard(customer), /Staff access/);
  await assert.rejects(
    () =>
      app.readiness.start(
        { ...owner, role: "agent" },
        { requestKey: uid(), checkIds: ["core"] },
      ),
    /administrator/,
  );
  const result = await run(owner, "response_access");
  assert.equal(result.health, "current");
  assert.equal(result.evidence_level, "access_verified");
  assert.equal(JSON.stringify(result).includes("test-only-placeholder"), false);
  assert.equal(result.request, undefined);
  await app.connections.save(
    ws.id,
    "openai",
    { apiKey: "rotated-test-only" },
    {},
  );
  const updated = await app.readiness.dashboard(owner);
  assert.equal(
    updated.checks.find((ch) => ch.id === "response_access")!.health,
    "stale",
  );
  assert.equal(
    (await app.readiness.history(owner, "response_access")).runs.length,
    1,
  );
  const other = await workspace(app);
  await assert.rejects(
    () => app.readiness.control(other.owner, result.id, { action: "cancel" }),
    /Not found/,
  );
  assert.equal(
    (
      await app.db.rows(
        "SELECT * FROM events WHERE workspace_id=$1 AND kind LIKE 'readiness.%' AND public",
        [ws.id],
      )
    ).length,
    0,
  );
});
test("core failure is actionable, repairs can pass, and migrations preserve evidence", async () => {
  const { owner, ws } = await workspace(app);
  await app.db.pool.query("DELETE FROM worker_heartbeats");
  const failed = await run(owner, "core");
  assert.equal(failed.health, "blocked");
  assert.match(failed.evidence.summary, /heartbeat/);
  await app.db.pool.query(
    "INSERT INTO worker_heartbeats VALUES('diagnostic-test-worker',now())",
  );
  const passed = await run(owner, "core");
  assert.equal(passed.health, "current");
  await app.db.pool.query(
    "UPDATE diagnostic_runs SET finished_at=now()-interval '6 minutes' WHERE id=$1",
    [passed.id],
  );
  assert.equal(
    (await app.readiness.dashboard(owner)).checks.find(
      (ch) => ch.id === "core",
    )!.health,
    "stale",
  );
  await app.migrate();
  assert.equal(
    (await app.db.one(
      "SELECT count(*) n FROM diagnostic_runs WHERE workspace_id=$1",
      [ws.id],
    ))!.n,
    "2",
  );
});
test("duplicate request identity is durable and cannot reuse changed input", async () => {
  const { owner, ws } = await workspace(app),
    request = { requestKey: uid(), checkIds: ["response_access"] };
  const [a, b] = await Promise.all([
    app.readiness.start(owner, request),
    app.readiness.start(owner, request),
  ]);
  assert.equal(a[0].id, b[0].id);
  await Promise.all([
    app.readiness.advance(ws.id, a[0].id),
    app.readiness.advance(ws.id, a[0].id),
  ]);
  assert.equal(
    (await app.readiness.history(owner, "response_access")).runs.length,
    1,
  );
  await assert.rejects(
    () => app.readiness.start(owner, { ...request, tokenCap: 1000 }),
    /different diagnostic/,
  );
});
test("revoked operator, canceled work and changed config execute zero email effects", async () => {
  for (const reason of ["revoke", "cancel", "config"]) {
    const { owner, ws } = await workspace(app);
    const [r] = await app.readiness.start(owner, {
      requestKey: uid(),
      checkIds: ["smtp_acceptance"],
      authorizedEffects: true,
      testEmail: "operator@example.test",
    });
    if (reason === "revoke")
      await app.db.pool.query(
        "UPDATE memberships SET role='agent' WHERE workspace_id=$1 AND user_id=$2",
        [ws.id, owner.userId],
      );
    if (reason === "cancel")
      await app.readiness.control(owner, r.id, { action: "cancel" });
    if (reason === "config") config.SMTP_FROM = "Changed diagnostic sender";
    await app.readiness.advance(ws.id, r.id);
    const state = await app.db.one(
      "SELECT health FROM diagnostic_runs WHERE id=$1",
      [r.id],
    );
    assert.equal(state!.health, reason === "cancel" ? "canceled" : "stale");
  }
  assert.equal(sent, 0);
});
test("paid/effectful checks require exact authorization and never claim receipt or retry uncertain sends", async () => {
  const { owner, ws } = await workspace(app);
  await assert.rejects(
    () =>
      app.readiness.start(owner, {
        requestKey: uid(),
        checkIds: ["smtp_acceptance"],
      }),
    /Explicitly authorize/,
  );
  await assert.rejects(
    () =>
      app.readiness.start(owner, {
        requestKey: uid(),
        checkIds: ["response_probe"],
        authorizedEffects: true,
      }),
    /token cap/,
  );
  const accepted = await run(owner, "smtp_acceptance", {
    authorizedEffects: true,
    testEmail: "operator@example.test",
  });
  assert.equal(accepted.evidence.facts.inboxReceipt, false);
  assert.equal(sent, 1);
  await app.readiness.advance(ws.id, accepted.id);
  assert.equal(sent, 1);
  failSend = true;
  const uncertain = await run(owner, "smtp_acceptance", {
    authorizedEffects: true,
    testEmail: "operator@example.test",
  });
  assert.equal(uncertain.health, "uncertain");
  assert.equal(sent, 2);
  assert.equal(JSON.stringify(uncertain).includes("never-store"), false);
  await app.readiness.advance(ws.id, uncertain.id);
  assert.equal(sent, 2);
  await assert.rejects(
    () => app.readiness.control(owner, uncertain.id, { action: "retry" }),
    /Acknowledge/,
  );
  const [interrupted] = await app.readiness.start(owner, {
    requestKey: uid(),
    checkIds: ["smtp_acceptance"],
    authorizedEffects: true,
    testEmail: "operator@example.test",
  });
  await app.db.pool.query(
    "UPDATE diagnostic_runs SET status='running',effect_started_at=now() WHERE id=$1",
    [interrupted.id],
  );
  await app.readiness.advance(ws.id, interrupted.id);
  assert.equal(sent, 2);
  assert.equal(
    (await app.db.one("SELECT health FROM diagnostic_runs WHERE id=$1", [
      interrupted.id,
    ]))!.health,
    "uncertain",
  );
});
test("manual notes cannot bypass strict publication, legacy publication defaults remain", async () => {
  const { owner, ws } = await workspace(app);
  await app.readiness.assertPublication(ws.id);
  await app.readiness.settings(owner, { strict: true });
  await app.readiness.attest(owner, "core", {
    note: "Operator says this is ready; manual evidence only.",
  });
  await assert.rejects(
    () => app.readiness.assertPublication(ws.id),
    /Strict readiness/,
  );
  assert.equal(
    (await app.db.one(
      "SELECT published FROM channels WHERE workspace_id=$1 AND kind='portal'",
      [ws.id],
    ))!.published,
    true,
  );
  assert.equal(
    (await app.readiness.dashboard(owner)).checks.find(
      (ch) => ch.id === "core",
    )!.level,
    "configured_untested",
  );
});
test("diagnostic token cap is atomic within the workspace budget", async () => {
  const { owner, ws } = await workspace(app);
  const [r] = await app.readiness.start(owner, {
    requestKey: uid(),
    checkIds: ["response_probe"],
    authorizedEffects: true,
    tokenCap: 1000,
  });
  await app.db.pool.query(
    "UPDATE diagnostic_runs SET status='running' WHERE id=$1",
    [r.id],
  );
  const live = new LiveModel(app.db, app.connections);
  const attempt = () =>
    usageContext.run({ purpose: "diagnostic", diagnosticId: r.id }, () =>
      (live as any).reserve(ws.id, "response", "test", 600),
    );
  const results = await Promise.allSettled([attempt(), attempt()]);
  assert.equal(results.filter((x) => x.status === "fulfilled").length, 1);
  assert.equal(
    (await app.db.one("SELECT sum(reserved) n FROM usage WHERE context_id=$1", [
      r.id,
    ]))!.n,
    "600",
  );
  await app.readiness.control(owner, r.id, { action: "cancel" });
  await assert.rejects(attempt, /no longer authorized/);
});
