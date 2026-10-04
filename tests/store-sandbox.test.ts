import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { Platform } from "../packages/platform/src/platform.js";
import type { Principal } from "../packages/platform/src/auth.js";
import { uid } from "../packages/platform/src/db.js";
import { testConfig, resetDatabase } from "./helpers.js";
import { sandboxDatabase } from "../scripts/store-sandbox/config.js";
import { StoreModel } from "../scripts/store-sandbox/model.js";
import {
  storeProviders,
  chargeFixture,
} from "../scripts/store-sandbox/providers.js";
import { seedStore } from "../scripts/store-sandbox/seed.js";

const config = { ...testConfig(), FIELDKIT_DATA: ".fieldkit/tests-store" };
const model = new StoreModel();
const makeApp = (): Platform =>
  new Platform(config, {
    model,
    mailer: async () => {},
    fetch: (url, init) => storeProviders(app.db)(url, init),
  });
let app = makeApp(),
  ws: string,
  owner: Principal;
const password = "Sandbox-tests-only-12345";
before(async () => {
  await resetDatabase(config.DATABASE_URL);
  await app.migrate();
  ws = await seedStore(app, password, "http://127.0.0.1:4321");
  const user = await app.db.one('SELECT id FROM "user" WHERE email=$1', [
    "owner@trail.example.test",
  ]);
  owner = { workspaceId: ws, userId: user!.id, role: "owner" };
});
after(() => app.close());

test("sandbox database guard refuses production names, remote hosts and connection overrides", () => {
  assert.equal(
    sandboxDatabase("postgresql://localhost/fieldkit_store_sandbox").pathname,
    "/fieldkit_store_sandbox",
  );
  for (const url of [
    "postgresql://localhost/fieldkit",
    "postgresql://example.com/fieldkit_store_sandbox",
    "postgresql://localhost/fieldkit_test",
    "postgresql://localhost/fieldkit_store_sandbox?host=example.com",
    "postgresql://localhost/fieldkit_store_sandbox%22",
    "https://localhost/fieldkit_store_sandbox",
  ])
    assert.throws(() => sandboxDatabase(url));
});

test("store seed publishes real knowledge and workflows while keeping internal documents private", async () => {
  assert.equal(
    (await app.db.one("SELECT count(*) n FROM sources WHERE workspace_id=$1", [
      ws,
    ]))!.n,
    "6",
  );
  const evidence = await app.knowledge.retrieve(
    ws,
    "internal supplier recovery code",
  );
  assert.ok(evidence.every((e) => !e.excerpt.includes("TRAIL-INTERNAL-42")));
  assert.equal((await app.workflows.get(owner)).publishedVersion, 1);
  const messages = await app.db.rows(
    "SELECT body FROM messages WHERE role='assistant'",
  );
  assert.ok(
    messages.some(
      (m) =>
        m.body.includes("30 days") && m.body.includes("Sandbox simulation"),
    ),
  );
  assert.ok(messages.every((m) => !m.body.includes("TRAIL-INTERNAL-42")));
  assert.equal((await app.db.one("SELECT count(*) n FROM usage"))!.n, "0");
});

test("simulated refund requires staff approval and persists exactly one receipt across restart", async () => {
  const approval = (await app.db.one(
    "SELECT * FROM approvals WHERE status='pending'",
  ))!;
  assert.ok(approval);
  assert.equal(
    (await app.db.one("SELECT count(*) n FROM sandbox_receipts"))!.n,
    "0",
  );
  await app.decide(owner, approval.id, approval.hash, "approve");
  await app.agent.advance(ws, approval.run_id);
  const receipt = (await app.db.one("SELECT * FROM sandbox_receipts"))!;
  assert.equal(receipt.receipt.amount, 2000);
  assert.equal(receipt.receipt.simulated, true);
  await app.close();
  app = makeApp();
  await app.start();
  await app.agent.advance(ws, approval.run_id);
  const duplicate = await storeProviders(app.db)(
    "https://api.stripe.com/v1/refunds",
    {
      method: "POST",
      headers: { "Idempotency-Key": receipt.id },
      body: new URLSearchParams({
        charge: chargeFixture.id,
        amount: "2000",
      }).toString(),
    },
  );
  assert.deepEqual(await duplicate.json(), receipt.receipt);
  assert.equal(
    (await app.db.one("SELECT count(*) n FROM sandbox_receipts"))!.n,
    "1",
  );
  const charge = await storeProviders(app.db)(
    `https://api.stripe.com/v1/charges/${chargeFixture.id}`,
  );
  assert.equal((await charge.json()).amount_refunded, 2000);
  await assert.rejects(() =>
    app.decide(owner, approval.id, approval.hash, "approve"),
  );
});

test("restarting the seed preserves edits, user accounts and conversations without duplicates", async () => {
  const old = await app.branding.get(ws);
  await app.branding.save(owner, {
    revision: old.revision,
    config: { ...old.config, greeting: "My edited store" },
  });
  const count = async () =>
    app.db.one(
      'SELECT (SELECT count(*) FROM "user") users,(SELECT count(*) FROM conversations) conversations,(SELECT count(*) FROM sources) sources',
    );
  const before = await count();
  assert.equal(await seedStore(app, password, "http://127.0.0.1:4321"), ws);
  assert.deepEqual(await count(), before);
  assert.equal((await app.branding.get(ws)).config.greeting, "My edited store");
});

test("store Test Lab suite checks all scenarios without business writes or simulated AI grading", async () => {
  const suite = (await app.quality.suites(owner))[0];
  const job = await app.quality.startEvaluation(owner, {
    suiteId: suite.id,
    tokenCap: 10000,
    variants: [{ name: "Offline rules" }],
    judge: { enabled: false },
  });
  for (let i = 0; i < 30; i++) {
    const current = await app.db.one(
      "SELECT status FROM quality_jobs WHERE id=$1",
      [job.id],
    );
    if (!["queued", "running"].includes(current!.status)) break;
    await app.quality.advance(ws, job.id);
  }
  const result = await app.quality.job(owner, job.id);
  assert.equal(result.status, "completed", JSON.stringify(result));
  assert.equal(result.results.length, 6);
  for (const r of result.results) {
    assert.equal(r.status, "completed", JSON.stringify(r));
    assert.ok(
      r.rules.every((rule: any) => rule.passed),
      JSON.stringify(r.rules),
    );
    assert.equal(r.judge, null);
  }
  assert.equal(
    (await app.db.one("SELECT count(*) n FROM sandbox_receipts"))!.n,
    "1",
  );
  await assert.rejects(() => model.judge(), /unavailable/);
  await assert.rejects(() => model.analyzeGap(), /unavailable/);
  await assert.rejects(
    () => storeProviders(app.db)("https://api.openai.com/v1/responses"),
    /external connections/,
  );
  await assert.rejects(
    () =>
      storeProviders(app.db)("https://api.stripe.com/v1/payouts", {
        method: "POST",
      }),
    /no fixture/,
  );
});

test("a second customer cannot use Alex's purchase or see Alex's conversation", async () => {
  const contact = (await app.db.one("SELECT * FROM contacts WHERE email=$1", [
    "sam@trail.example.test",
  ]))!;
  const account = await app.actions.account(ws, contact);
  assert.ok(account?.every((a) => a.charges.length === 0));
  const principal: Principal = {
    workspaceId: ws,
    role: "customer",
    contactId: contact.id,
    userId: contact.user_id,
  };
  const conv = await app.newConversation(principal, {
    body: "Please refund my order",
    requestKey: uid(),
  });
  const run = (await app.db.one(
    "SELECT id FROM runs WHERE conversation_id=$1",
    [conv.id],
  ))!;
  await app.agent.advance(ws, run.id);
  const message = (await app.db.one(
    "SELECT body FROM messages WHERE conversation_id=$1 AND role='assistant'",
    [conv.id],
  ))!;
  assert.match(message.body, /no mapped sample purchase/i);
  const alex = (await app.db.one(
    "SELECT c.id FROM conversations c JOIN contacts p ON p.id=c.contact_id WHERE p.email='alex@trail.example.test' LIMIT 1",
  ))!;
  const { conversation } = await import("../packages/platform/src/auth.js");
  await assert.rejects(() => conversation(app.db, principal, alex.id));
});
