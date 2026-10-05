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
const c = testConfig(),
  app = new Platform(c, {
    model: new TestModel(),
    fetch: new TestProviders().fetch,
    mailer: async () => {},
  });
const original = app.connections.json.bind(app.connections);
before(async () => {
  await resetDatabase(c.DATABASE_URL);
  await app.migrate();
});
after(() => app.close());
beforeEach(() => {
  app.connections.json = original;
});
async function probe(p: any, kind: string, testResource: any) {
  const [r] = await app.readiness.start(p, {
    requestKey: uid(),
    checkIds: [`probe:${kind}`],
    authorizedEffects: true,
    testResource: { dedicated: true, ...testResource },
  });
  await app.readiness.advance(p.workspaceId, r.id);
  return (await app.readiness.history(p, `probe:${kind}`)).runs.find(
    (x) => x.id === r.id,
  )!;
}
test("dedicated refund checks exact customer, mode, marking and amount before sending", async () => {
  const x = await workspace(app);
  let writes = 0,
    marked = false;
  app.connections.json = async (_ws, provider, path, init) => {
    assert.equal(provider, "stripe_test");
    if (path.startsWith("/v1/customers/"))
      return {
        id: "cus_test",
        livemode: false,
        metadata: { fieldkit_diagnostic: "true" },
      };
    if (path.startsWith("/v1/charges/"))
      return {
        id: "ch_test",
        customer: marked ? "cus_test" : "cus_wrong",
        livemode: false,
        metadata: { fieldkit_diagnostic: "true" },
        paid: true,
        captured: true,
        amount: 1000,
        amount_refunded: 0,
      };
    if (init?.method === "POST") {
      writes++;
      return { id: "re_test", status: "succeeded", amount: 25 };
    }
    throw Error("Unexpected call");
  };
  const invalid = await probe(x.owner, "stripe_refund", {
    customerId: "cus_test",
    chargeId: "ch_test",
    amountMinor: 25,
  });
  assert.equal(invalid.health, "failed");
  assert.equal(writes, 0);
  marked = true;
  const valid = await probe(x.owner, "stripe_refund", {
    customerId: "cus_test",
    chargeId: "ch_test",
    amountMinor: 25,
  });
  assert.equal(valid.evidence_level, "dedicated_test_write_verified");
  assert.equal(valid.evidence.facts.evidenceOrigin, "local_test");
  assert.equal(writes, 1);
  await app.readiness.advance(x.ws.id, valid.id);
  assert.equal(writes, 1);
});
test("timeout-after-commit reconciles the original refund without issuing another write", async () => {
  const x = await workspace(app);
  let writes = 0,
    op = "";
  app.connections.json = async (_ws, _provider, path, init) => {
    if (path.startsWith("/v1/customers/"))
      return { livemode: false, metadata: { fieldkit_diagnostic: "true" } };
    if (path.startsWith("/v1/charges/"))
      return {
        customer: "cus_test",
        livemode: false,
        metadata: { fieldkit_diagnostic: "true" },
        paid: true,
        captured: true,
        amount: 1000,
        amount_refunded: 0,
      };
    if (init?.method === "POST") {
      writes++;
      op = new Headers(init.headers).get("Idempotency-Key")!;
      throw Error("Timeout after commit");
    }
    return {
      data: [
        {
          id: "re_original",
          amount: 25,
          status: "succeeded",
          metadata: { fieldkit_diagnostic: op },
        },
      ],
      has_more: false,
    };
  };
  const r = await probe(x.owner, "stripe_refund", {
    customerId: "cus_test",
    chargeId: "ch_test",
    amountMinor: 25,
  });
  assert.equal(r.health, "uncertain");
  await assert.rejects(
    () =>
      app.readiness.control(x.owner, r.id, {
        action: "retry",
        acknowledgeUncertain: true,
      }),
    /cannot be retried/,
  );
  await app.readiness.control(x.owner, r.id, { action: "reconcile" });
  assert.equal(writes, 1);
  assert.equal(
    (await app.readiness.history(x.owner, "probe:stripe_refund")).runs[0]
      .health,
    "current",
  );
});
test("revocation during provider preflight prevents diagnostic effect dispatch", async () => {
  const x = await workspace(app);
  let writes = 0;
  app.connections.json = async (_ws, _p, path, init) => {
    if (init?.method === "POST") {
      writes++;
      return {};
    }
    if (path.startsWith("/v1/customers/"))
      return { livemode: false, metadata: { fieldkit_diagnostic: "true" } };
    await app.db.pool.query(
      "UPDATE memberships SET role='agent' WHERE workspace_id=$1 AND user_id=$2",
      [x.ws.id, x.owner.userId],
    );
    return {
      id: "sub_test",
      customer: "cus_test",
      livemode: false,
      metadata: { fieldkit_diagnostic: "true" },
      status: "active",
      cancel_at_period_end: false,
    };
  };
  const r = await probe(x.owner, "stripe_cancel", {
    customerId: "cus_test",
    subscriptionId: "sub_test",
  });
  assert.equal(writes, 0);
  assert.equal(r.health, "failed");
});
test("Zendesk note requires an unlinked marked test ticket and uses safe update", async () => {
  const x = await workspace(app);
  await app.connections.save(
    x.ws.id,
    "zendesk",
    { access_token: "test-only" },
    { subdomain: "fixture" },
  );
  let writes = 0,
    tagged = false;
  app.connections.json = async (_ws, _p, _path, init) => {
    if (init?.method === "PUT") {
      writes++;
      const payload = JSON.parse(String(init.body));
      assert.equal(payload.ticket.safe_update, true);
      assert.equal(payload.ticket.comment.public, false);
      assert.ok(payload.ticket.comment.body.includes("diagnostic-"));
      return { audit: { id: 1 } };
    }
    return {
      ticket: {
        id: 123,
        updated_at: "2026-01-01T00:00:00Z",
        tags: tagged ? ["fieldkit_diagnostic_test"] : [],
      },
    };
  };
  assert.equal(
    (await probe(x.owner, "zendesk_note", { ticketId: "123" })).health,
    "failed",
  );
  assert.equal(writes, 0);
  tagged = true;
  assert.equal(
    (await probe(x.owner, "zendesk_note", { ticketId: "123" })).evidence_level,
    "dedicated_test_write_verified",
  );
  assert.equal(writes, 1);
});
test("diagnostic service summaries are narrow and cannot launch checks or read raw history", async () => {
  const x = await workspace(app),
    service = {
      workspaceId: x.ws.id,
      role: "service" as const,
      scopes: ["diagnostics:read"],
    };
  const summary = await app.readiness.summary(service);
  assert.equal(summary.evidenceOrigin, "local_test");
  assert.ok(summary.checks.length);
  assert.equal("result" in summary.checks[0], false);
  await assert.rejects(() => app.readiness.dashboard(service), /Staff/);
  await assert.rejects(
    () =>
      app.readiness.start(service, { requestKey: uid(), checkIds: ["core"] }),
    /administrator/,
  );
  await assert.rejects(
    () => app.readiness.summary({ ...service, scopes: ["requests:create"] }),
    /diagnostics:read/,
  );
});
