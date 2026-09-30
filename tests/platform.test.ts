import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createApp } from "../apps/api/server.js";
import {
  testConfig,
  resetDatabase,
  TestModel,
  TestProviders,
  workspace,
  knowledge,
} from "./helpers.js";
import {
  seal,
  unseal,
  externalURL,
  publicAddress,
  digest,
} from "../packages/platform/src/security.js";
import { uid } from "../packages/platform/src/db.js";
import { extract } from "../packages/platform/src/knowledge.js";
import { Settings } from "../packages/platform/src/contracts.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { FieldKitClient } from "../packages/sdk/src/index.js";
import { token, tokenHash } from "../packages/platform/src/security.js";

const c = testConfig(),
  model = new TestModel(),
  providers = new TestProviders(),
  emails: { to: string; text: string }[] = [];
let server: Awaited<ReturnType<typeof createApp>>,
  app: ReturnType<typeof Object>;
before(async () => {
  await resetDatabase(c.DATABASE_URL);
  server = await createApp(c, {
    migrate: true,
    model,
    fetch: providers.fetch,
    mailer: async (to, _subject, text) => {
      emails.push({ to, text });
    },
  });
  app = server.app;
  await new Promise<void>((r) =>
    server.server.listen(c.FIELDKIT_PORT, "127.0.0.1", r),
  );
});
after(async () => {
  await server.close();
});
async function call(path: string, data?: any, cookie = "", method?: string) {
  const response = await fetch(c.FIELDKIT_URL + path, {
    method: method ?? (data ? "POST" : "GET"),
    headers: {
      "Content-Type": "application/json",
      Origin: c.FIELDKIT_URL,
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: data ? JSON.stringify(data) : undefined,
    redirect: "manual",
  });
  let json: any;
  try {
    json = await response.json();
  } catch {}
  return { response, json };
}
async function runText(w: any, text: string) {
  const conv = await app.newConversation(w.customer, {
    body: text,
    requestKey: uid(),
  });
  const run = await app.db.one("SELECT * FROM runs WHERE conversation_id=$1", [
    conv.id,
  ]);
  await app.agent.advance(w.ws.id, run.id);
  return {
    conv,
    run: await app.db.one("SELECT * FROM runs WHERE id=$1", [run.id]),
  };
}
async function refundAction(ws: string, automatic = false) {
  return app.actions.save(ws, {
    name: "refund_payment",
    description: "Refund the selected verified captured charge",
    kind: "stripe_refund",
    enabled: true,
    policy: {
      mode: automatic ? "automatic" : "approval",
      maxAmountMinor: 5000,
      currency: "usd",
      dailyLimit: 2,
    },
  });
}

test("fresh install is empty; real Better Auth verifies email, authenticates, and protects bootstrap", async () => {
  assert.equal((await app.db.rows("SELECT id FROM workspaces")).length, 0);
  const email = `owner-${uid()}@example.test`,
    password = "correct-horse-battery-staple";
  const signup = await call("/api/auth/sign-up/email", {
    name: "Owner",
    email,
    password,
  });
  assert.equal(signup.response.status, 200, JSON.stringify(signup.json));
  const denied = await call("/api/auth/sign-in/email", { email, password });
  assert.equal(denied.response.status, 403);
  const mail = emails.find((e) => e.to === email)!;
  assert.ok(mail);
  const verifyURL = new URL(mail.text.match(/https?:\/\/\S+/)![0]);
  const verified = await fetch(verifyURL, { redirect: "manual" });
  assert.ok([200, 302].includes(verified.status));
  const login = await call("/api/auth/sign-in/email", { email, password });
  assert.equal(login.response.status, 200);
  const cookie = login.response.headers
    .getSetCookie()
    .map((x) => x.split(";")[0])
    .join("; ");
  assert.ok(cookie);
  const missing = await call(
    "/v2/workspaces",
    { name: "Actual workspace", slug: "real-workspace" },
    cookie,
  );
  assert.equal(missing.response.status, 403);
  const created = await call(
    "/v2/workspaces",
    {
      name: "Actual workspace",
      slug: "real-workspace",
      setupToken: c.FIELDKIT_SETUP_TOKEN,
    },
    cookie,
  );
  assert.equal(created.response.status, 201, JSON.stringify(created.json));
  const me = await call("/v2/me", undefined, cookie);
  assert.equal(me.json.workspaces[0].role, "owner");
  // The remaining direct domain tests use an additional owner fixture inside this isolated database.
  await app.db.pool.query(
    "INSERT INTO memberships VALUES($1,'test-owner','owner')",
    [created.json.id],
  );
  const jobs = await call(
    `/v2/workspaces/${created.json.id}/operations/jobs`,
    undefined,
    cookie,
  );
  assert.equal(jobs.response.status, 200, JSON.stringify(jobs.json));
  const invite = await call(
    `/v2/workspaces/${created.json.id}/invitations`,
    { email: "teammate@example.test", role: "agent" },
    cookie,
  );
  assert.equal(invite.response.status, 200);
  assert.ok(emails.some((e) => e.to === "teammate@example.test"));
});
test("secret encryption is scope-bound and URL validation blocks local network destinations", () => {
  const ciphertext = seal(c.FIELDKIT_ENCRYPTION_KEY, "workspace:openai", {
    key: "private-value",
  });
  assert.deepEqual(
    unseal(c.FIELDKIT_ENCRYPTION_KEY, "workspace:openai", ciphertext),
    { key: "private-value" },
  );
  assert.throws(() =>
    unseal(c.FIELDKIT_ENCRYPTION_KEY, "other:openai", ciphertext),
  );
  for (const url of [
    "http://example.com",
    "https://127.0.0.1",
    "https://169.254.169.254",
    "https://[::1]",
    "https://example.com:8443",
    "https://user:pass@example.com",
  ])
    assert.throws(() => externalURL(url));
  assert.equal(publicAddress("10.1.2.3"), false);
  assert.equal(publicAddress("2606:4700:4700::1111"), true);
});
test("document ingestion, publication and removal maintain independent audience boundaries", async () => {
  const w = await workspace(app);
  const source = await app.knowledge.upload(
    w.ws.id,
    "returns.md",
    Buffer.from("Unused items can be returned within 30 days."),
  );
  await app.knowledge.ingest(w.ws.id, source.id);
  assert.equal(
    (await app.knowledge.retrieve(w.ws.id, "return policy")).length,
    0,
  );
  await app.db.pool.query(
    "UPDATE sources SET visibility='customer' WHERE id=$1",
    [source.id],
  );
  const evidence = await app.knowledge.retrieve(w.ws.id, "return policy");
  assert.equal(evidence.length, 1);
  const doc = await app.db.one("SELECT * FROM documents WHERE source_id=$1", [
    source.id,
  ]);
  assert.equal(doc.published, false);
  await app.knowledge.remove(w.ws.id, source.id);
  assert.equal(await app.knowledge.validEvidence(w.ws.id, evidence), false);
  assert.equal(
    (await app.knowledge.retrieve(w.ws.id, "return policy")).length,
    0,
  );
});
test("website, Notion, Drive and Zendesk ingest real provider-shaped content and revoke indexed access", async () => {
  const w = await workspace(app);
  await app.connections.save(w.ws.id, "notion", { apiKey: "test" }, {});
  await app.connections.save(w.ws.id, "google", { apiKey: "test" }, {});
  await app.connections.save(
    w.ws.id,
    "zendesk",
    { apiKey: "test" },
    { subdomain: "example" },
  );
  for (const [kind, locator] of [
    ["website", "https://docs.example.com/returns"],
    ["notion", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
    ["google", "abcdefghijk"],
    ["zendesk", "123"],
  ]) {
    const s = await app.knowledge.add(w.ws.id, {
      kind,
      locator,
      title: kind + " policy",
    });
    await app.knowledge.ingest(w.ws.id, s.id);
    const result = await app.db.one("SELECT * FROM sources WHERE id=$1", [
      s.id,
    ]);
    assert.equal(result.status, "ready");
    await app.db.pool.query(
      "UPDATE sources SET visibility='customer' WHERE id=$1",
      [s.id],
    );
  }
  const before = await app.knowledge.retrieve(w.ws.id, "returns");
  assert.equal(before.length, 4);
  const google = await app.db.one(
    "SELECT id FROM sources WHERE workspace_id=$1 AND kind='google'",
    [w.ws.id],
  );
  providers.readDenied = true;
  await assert.rejects(app.knowledge.ingest(w.ws.id, google.id));
  providers.readDenied = false;
  assert.equal((await app.knowledge.retrieve(w.ws.id, "returns")).length, 3);
  await app.connections.disconnect(w.ws.id, "notion");
  assert.equal((await app.knowledge.retrieve(w.ws.id, "returns")).length, 2);
});
test("extraction rejects unreadable/unsupported and oversized content", async () => {
  await assert.rejects(
    extract(Buffer.from(""), "empty.txt"),
    /No readable text/,
  );
  await assert.rejects(
    extract(Buffer.from("hello there"), "script.js"),
    /Supported files/,
  );
  await assert.rejects(
    extract(Buffer.alloc(21 * 1024 * 1024), "large.txt"),
    /20 MB/,
  );
});
test("a cited answer persists through the real LangGraph graph and a follow-up keeps the conversation", async () => {
  const w = await workspace(app);
  await knowledge(app, w.ws.id);
  const { conv, run } = await runText(w, "What is your return policy?");
  assert.equal(run.status, "completed");
  assert.equal(run.state.draft.intent, "answer");
  const messages = await app.db.rows(
    "SELECT * FROM messages WHERE conversation_id=$1 ORDER BY created_at",
    [conv.id],
  );
  assert.equal(messages.length, 2);
  assert.ok(messages[1].citations.length);
  await app.message(w.customer, conv.id, {
    body: "Does this include unused items?",
    requestKey: uid(),
  });
  const next = await app.db.one(
    "SELECT * FROM runs WHERE conversation_id=$1 ORDER BY revision DESC",
    [conv.id],
  );
  await app.agent.advance(w.ws.id, next.id);
  assert.equal(
    (
      await app.db.rows("SELECT * FROM messages WHERE conversation_id=$1", [
        conv.id,
      ])
    ).length,
    4,
  );
  const snapshot = await app.agent.graph.getState({
    configurable: { thread_id: `${w.ws.id}:${run.id}` },
  });
  assert.ok(snapshot.config.configurable?.checkpoint_id);
});
test("missing evidence, invalid citations and model outages hand off without fabricated answers", async () => {
  const w = await workspace(app);
  let r = await runText(w, "Unknown question");
  assert.equal(r.run.status, "handed_off");
  await knowledge(app, w.ws.id);
  model.invalidCitation = true;
  r = await runText(w, "Returns?");
  model.invalidCitation = false;
  assert.equal(r.run.status, "handed_off");
  assert.match(r.run.state.error, /cited evidence/);
  model.fail = true;
  r = await runText(w, "Returns?");
  model.fail = false;
  assert.equal(r.run.status, "handed_off");
});
test("staff takeover during model generation prevents publication and execution", async () => {
  const w = await workspace(app);
  await knowledge(app, w.ws.id);
  const conv = await app.newConversation(w.customer, {
    body: "Returns?",
    requestKey: uid(),
  });
  const run = await app.db.one("SELECT * FROM runs WHERE conversation_id=$1", [
    conv.id,
  ]);
  model.hook = async () => {
    await app.control(w.owner, conv.id, { mode: "human" });
  };
  await app.agent.advance(w.ws.id, run.id);
  model.hook = undefined;
  assert.equal(
    (await app.db.one("SELECT status FROM runs WHERE id=$1", [run.id])).status,
    "stale",
  );
  assert.equal(
    (
      await app.db.rows(
        "SELECT * FROM messages WHERE conversation_id=$1 AND role='assistant'",
        [conv.id],
      )
    ).length,
    0,
  );
});
test("newer customer messages invalidate a response generated from old context", async () => {
  const w = await workspace(app);
  await knowledge(app, w.ws.id);
  const conv = await app.newConversation(w.customer, {
    body: "Returns?",
    requestKey: uid(),
  });
  const run = await app.db.one("SELECT * FROM runs WHERE conversation_id=$1", [
    conv.id,
  ]);
  model.hook = async () => {
    await app.message(w.customer, conv.id, {
      body: "Actually I have another question",
      requestKey: uid(),
    });
  };
  await app.agent.advance(w.ws.id, run.id);
  model.hook = undefined;
  assert.equal(
    (await app.db.one("SELECT status FROM runs WHERE id=$1", [run.id])).status,
    "stale",
  );
});
test("refund pauses for an exact approval, rejects an agent role, and confirms one provider effect", async () => {
  providers.refunds = [];
  providers.writes = 0;
  const w = await workspace(app);
  await refundAction(w.ws.id);
  const { run } = await runText(w, "Please refund this charge");
  assert.equal(run.status, "waiting_approval");
  assert.equal(providers.writes, 0);
  const a = await app.db.one("SELECT * FROM approvals WHERE run_id=$1", [
    run.id,
  ]);
  await assert.rejects(
    app.decide({ ...w.owner, role: "agent" }, a.id, a.hash, "approve"),
    /administrator/,
  );
  await assert.rejects(
    app.decide(w.owner, a.id, "0".repeat(64), "approve"),
    /changed/,
  );
  await app.decide(w.owner, a.id, a.hash, "approve");
  await app.agent.advance(w.ws.id, run.id);
  assert.equal(providers.writes, 1);
  assert.equal(
    (
      await app.db.one("SELECT status FROM operations WHERE run_id=$1", [
        run.id,
      ])
    ).status,
    "confirmed",
  );
  await app.agent.advance(w.ws.id, run.id);
  assert.equal(providers.writes, 1);
});
test("stale policy, another customer’s charge, and ambiguous/changed ownership prevent writes", async () => {
  providers.refunds = [];
  providers.writes = 0;
  const w = await workspace(app);
  const action = await refundAction(w.ws.id);
  let { run } = await runText(w, "refund please");
  let a = await app.db.one("SELECT * FROM approvals WHERE run_id=$1", [run.id]);
  await app.db.pool.query(
    "UPDATE actions SET revision=revision+1 WHERE id=$1",
    [action.id],
  );
  await assert.rejects(app.decide(w.owner, a.id, a.hash, "approve"), /changed/);
  ({ run } = await runText(w, "refund other customer please"));
  a = await app.db.one("SELECT * FROM approvals WHERE run_id=$1", [run.id]);
  await app.decide(w.owner, a.id, a.hash, "approve");
  await app.agent.advance(w.ws.id, run.id);
  assert.equal(providers.writes, 0);
  assert.match(
    (await app.db.one("SELECT state FROM runs WHERE id=$1", [run.id])).state
      .error,
    /ownership/,
  );
});
test("timeout after committed Stripe refund remains unknown, then reconciles without a second write", async () => {
  providers.refunds = [];
  providers.writes = 0;
  providers.timeoutAfterCommit = true;
  const w = await workspace(app);
  await refundAction(w.ws.id, true);
  const { run } = await runText(w, "refund please");
  providers.timeoutAfterCommit = false;
  const op = await app.db.one("SELECT * FROM operations WHERE run_id=$1", [
    run.id,
  ]);
  assert.equal(op.status, "unknown");
  assert.equal(providers.writes, 1);
  const { action, identity } = await app.actions.revalidate(
    w.ws.id,
    run.state.proposal,
  );
  const receipt = await app.actions.reconcile(
    w.ws.id,
    op,
    run.state.proposal,
    action,
    identity,
  );
  assert.equal(receipt.result.amountMinor, 4900);
  assert.equal(providers.writes, 1);
});
test("period-end cancellation and schema-bound custom writes use the approved identity", async () => {
  providers.cancelled = false;
  providers.writes = 0;
  const w = await workspace(app);
  await app.actions.save(w.ws.id, {
    name: "cancel_subscription",
    description: "Cancel the explicitly selected subscription at period end",
    kind: "stripe_cancel",
    enabled: true,
    policy: { mode: "automatic", dailyLimit: 2 },
  });
  let result = await runText(w, "cancel my subscription");
  assert.equal(result.run.state.receipt.result.cancelAtPeriodEnd, true);
  const custom = {
    name: "custom_action",
    description: "Update an owned customer order",
    kind: "custom_write",
    enabled: true,
    config: {
      endpoint: "https://backend.example.com/update",
      lookupEndpoint: "https://backend.example.com/lookup",
      idempotent: true,
      mappingKey: "customer_id",
      inputSchema: {
        type: "object",
        properties: { orderId: { type: "string" } },
        required: ["orderId"],
        additionalProperties: false,
      },
      outputSchema: {
        type: "object",
        properties: { status: { type: "string" }, orderId: { type: "string" } },
        required: ["status", "orderId"],
        additionalProperties: false,
      },
    },
    policy: { mode: "automatic", dailyLimit: 2 },
  };
  await app.actions.save(w.ws.id, custom);
  result = await runText(w, "custom order update");
  assert.equal(result.run.state.receipt.result.status, "updated");
  await assert.rejects(
    app.actions.save(w.ws.id, {
      ...custom,
      name: "bad_custom",
      config: { ...custom.config, idempotent: false },
    }),
    /idempotency/,
  );
});
test("tenant and customer isolation plus duplicate-message protection hold at shared boundaries", async () => {
  const a = await workspace(app),
    b = await workspace(app);
  const conv = await app.newConversation(a.customer, {
    body: "A private question",
    requestKey: "stable-request-key",
  });
  await assert.rejects(
    app.message(b.customer, conv.id, {
      body: "Read someone else",
      requestKey: uid(),
    }),
    /not found/i,
  );
  const second = await app.newConversation(a.customer, {
    body: "A private question",
    requestKey: "stable-request-key",
  });
  assert.equal(second.id, conv.id);
  await assert.rejects(
    app.newConversation(a.customer, {
      body: "Changed request",
      requestKey: "stable-request-key",
    }),
    /different message/,
  );
  await assert.rejects(
    app.message({ ...a.customer, contactId: b.contactId }, conv.id, {
      body: "Wrong customer",
      requestKey: uid(),
    }),
    /not found/i,
  );
});
test("queue insertion rolls back with its canonical transaction", async () => {
  const id = uid();
  await assert.rejects(
    app.db.tx(async (q: any) => {
      await app.db.enqueue(q, "turn", {
        workspaceId: "rollback-test",
        runId: id,
      });
      throw new Error("rollback");
    }),
  );
  const jobs = await app.db.rows(
    "SELECT id FROM jobs.job WHERE data->>'runId'=$1",
    [id],
  );
  assert.equal(jobs.length, 0);
});
test("approval survives a fresh process and competing decisions cannot both succeed", async () => {
  const w = await workspace(app);
  await refundAction(w.ws.id);
  const { run } = await runText(w, "refund please");
  const a = await app.db.one("SELECT * FROM approvals WHERE run_id=$1", [
    run.id,
  ]);
  const results = await Promise.allSettled([
    app.decide(w.owner, a.id, a.hash, "approve"),
    app.decide(w.owner, a.id, a.hash, "approve"),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
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
  const after = await app.db.one("SELECT * FROM runs WHERE id=$1", [run.id]);
  assert.equal(after.status, "completed");
  assert.equal(after.state.receipt.result.amountMinor, 4900);
});
test("widget identities reject forged signatures and public tokens cannot read staff data", async () => {
  const w = await workspace(app),
    signingSecret = token();
  await app.connections.save(w.ws.id, "widget_identity", { signingSecret }, {});
  await app.db.pool.query(
    "UPDATE channels SET published=true,settings=$1 WHERE workspace_id=$2 AND kind='widget'",
    [{ origins: [c.FIELDKIT_URL], handoff: "native" }, w.ws.id],
  );
  const forged = await call(`/v2/public/${w.ws.slug}/widget/session`, {
    signedIdentity: "anything.invalid",
  });
  assert.equal(forged.response.status, 401);
  const encoded = Buffer.from(
      JSON.stringify({
        sub: "signed-customer",
        name: "Signed customer",
        exp: Math.floor(Date.now() / 1000) + 300,
      }),
    ).toString("base64url"),
    signature = createHmac("sha256", signingSecret)
      .update(encoded)
      .digest("base64url");
  const identity = await call(`/v2/public/${w.ws.slug}/widget/session`, {
    signedIdentity: encoded + "." + signature,
  });
  assert.equal(identity.response.status, 200, JSON.stringify(identity.json));
  const response = await fetch(
    `${c.FIELDKIT_URL}/v2/workspaces/${w.ws.id}/connections`,
    { headers: { Authorization: `Bearer ${identity.json.token}` } },
  );
  assert.equal(response.status, 403);
  const contact = await app.db.one("SELECT * FROM contacts WHERE id=$1", [
    identity.json.contactId,
  ]);
  assert.equal(contact.verified, true);
  assert.deepEqual(contact.mappings, {});
});
test("v2 SDK authenticates service calls and customer-bound status cannot read another customer", async () => {
  const w = await workspace(app),
    secret = token();
  await app.db.pool.query(
    "INSERT INTO credentials(hash,workspace_id,kind,scopes,expires_at) VALUES($1,$2,'service',$3,now()+interval '1 hour')",
    [tokenHash(secret), w.ws.id, ["requests:create"]],
  );
  const sdk = new FieldKitClient({
    url: c.FIELDKIT_URL,
    workspaceId: w.ws.id,
    token: secret,
    customerId: "sdk-customer",
  });
  await sdk.identify({
    externalCustomerId: "sdk-customer",
    name: "SDK customer",
  });
  const conv = await sdk.request({
    externalCustomerId: "sdk-customer",
    body: "Hello, I need help",
    requestKey: uid(),
  });
  assert.equal(
    (await sdk.status(conv.id)).messages[0].body,
    "Hello, I need help",
  );
  const wrong = new FieldKitClient({
    url: c.FIELDKIT_URL,
    workspaceId: w.ws.id,
    token: secret,
    customerId: "someone-else",
  });
  await assert.rejects(wrong.status(conv.id), /not found/);
  await sdk.reply(conv.id, {
    externalCustomerId: "sdk-customer",
    body: "A follow-up question",
    requestKey: uid(),
  });
  assert.equal(
    (await sdk.status(conv.id)).messages.at(-1)?.body,
    "A follow-up question",
  );
});
test("removed source evidence prevents pending execution", async () => {
  const w = await workspace(app);
  const source = await knowledge(app, w.ws.id);
  await refundAction(w.ws.id);
  const { run } = await runText(w, "refund please");
  const approval = await app.db.one("SELECT * FROM approvals WHERE run_id=$1", [
    run.id,
  ]);
  await app.decide(w.owner, approval.id, approval.hash, "approve");
  await app.knowledge.remove(w.ws.id, source.id);
  const previous = providers.writes;
  await app.agent.advance(w.ws.id, run.id);
  assert.equal(providers.writes, previous);
  assert.equal(
    (await app.db.one("SELECT status FROM runs WHERE id=$1", [run.id])).status,
    "handed_off",
  );
});
test("resolved-conversation retention removes messages and schedules checkpoint deletion", async () => {
  const w = await workspace(app);
  const { conv, run } = await runText(w, "unknown question");
  await app.db.pool.query(
    "UPDATE conversations SET status='resolved',updated_at=now()-interval '100 days' WHERE id=$1",
    [conv.id],
  );
  await app.maintenance();
  assert.equal(
    await app.db.one("SELECT * FROM conversations WHERE id=$1", [conv.id]),
    undefined,
  );
  assert.ok(
    await app.db.one(
      "SELECT * FROM jobs.job WHERE name='maintenance' AND data->'deleteThreads' ? $1",
      [`${w.ws.id}:${run.id}`],
    ),
  );
});
test("Zendesk signatures, deduplication, safe update and unknown-write reconciliation work", async () => {
  providers.writes = 0;
  providers.zendeskVersion = "2026-09-30T00:00:00Z";
  const w = await workspace(app);
  await knowledge(app, w.ws.id);
  const secret = "webhook-test-secret";
  await app.connections.save(
    w.ws.id,
    "zendesk",
    { apiKey: "test", webhookSecret: secret },
    { subdomain: "example" },
  );
  await app.db.pool.query(
    "UPDATE channels SET published=true WHERE workspace_id=$1 AND kind='zendesk'",
    [w.ws.id],
  );
  const raw = Buffer.from(JSON.stringify({ ticket_id: 11 })),
    timestamp = new Date().toISOString(),
    signature = createHmac("sha256", secret)
      .update(timestamp + raw.toString())
      .digest("base64");
  await assert.rejects(
    app.support.webhook(w.ws.id, raw, "bad", timestamp, "event-1"),
    /signature/,
  );
  await app.support.webhook(w.ws.id, raw, signature, timestamp, "event-1");
  await app.support.webhook(w.ws.id, raw, signature, timestamp, "event-1");
  assert.equal(
    (
      await app.db.rows("SELECT * FROM inbound_events WHERE workspace_id=$1", [
        w.ws.id,
      ])
    ).length,
    1,
  );
  await app.support.sync(w.ws.id, "11");
  const conv = await app.db.one(
    "SELECT * FROM conversations WHERE workspace_id=$1 AND external_id='11'",
    [w.ws.id],
  );
  const run = await app.db.one("SELECT * FROM runs WHERE conversation_id=$1", [
    conv.id,
  ]);
  await app.agent.advance(w.ws.id, run.id);
  const delivery = await app.db.one(
    "SELECT * FROM deliveries WHERE conversation_id=$1",
    [conv.id],
  );
  providers.timeoutAfterCommit = true;
  await assert.rejects(app.support.deliver(w.ws.id, delivery.id));
  providers.timeoutAfterCommit = false;
  assert.equal(providers.writes, 1);
  await app.support.deliver(w.ws.id, delivery.id);
  assert.equal(providers.writes, 1);
  assert.equal(
    (
      await app.db.one("SELECT status FROM deliveries WHERE id=$1", [
        delivery.id,
      ])
    ).status,
    "delivered",
  );
});

test("real PDF and DOCX parsers extract selectable text from binary documents", async () => {
  const { readFile } = await import("node:fs/promises");
  for (const name of ["returns.pdf", "returns.docx"]) {
    const text = await extract(await readFile(`tests/fixtures/${name}`), name);
    assert.match(text, /returned within 30 days/);
  }
});

test("Stripe test and live keys remain independent and environment mismatches are rejected", async () => {
  const { ws } = await workspace(app);
  await app.connections.connectKey(ws.id, "stripe_test", "rk_test_connection");
  await app.connections.connectKey(ws.id, "stripe_live", "rk_live_connection");
  assert.equal(
    (await app.db.connection(ws.id, "stripe_test")).metadata.mode,
    "test",
  );
  assert.equal(
    (await app.db.connection(ws.id, "stripe_live")).metadata.mode,
    "live",
  );
  await assert.rejects(
    () =>
      app.connections.connectKey(ws.id, "stripe_live", "rk_test_connection"),
    /does not match/,
  );
  await app.connections.disconnect(ws.id, "stripe_live");
  assert.equal(
    (await app.db.connection(ws.id, "stripe_test")).status,
    "connected",
  );
});

test("Zendesk automatic delivery is cancelled after takeover and cancelled deliveries cannot replay", async () => {
  const { ws, owner, customer } = await workspace(app);
  await app.connections.save(
    ws.id,
    "zendesk",
    { access_token: "test-zendesk" },
    { subdomain: "test" },
  );
  const conv = await app.newConversation(customer, {
    body: "Please help",
    requestKey: uid(),
  });
  await app.db.pool.query(
    "UPDATE conversations SET external_id=$1,external_version=$2 WHERE id=$3",
    ["11", providers.zendeskVersion, conv.id],
  );
  const id = await app.db.tx((q: any) =>
    app.support.queue(q, ws.id, conv.id, {
      body: "Automatic answer",
      public: true,
      guardRevision: conv.revision,
    }),
  );
  await app.control(owner, conv.id, { mode: "human" });
  const before = providers.writes;
  await app.support.deliver(ws.id, id);
  await app.support.deliver(ws.id, id);
  assert.equal(providers.writes, before);
  assert.equal(
    (await app.db.one("SELECT status FROM deliveries WHERE id=$1", [id]))
      .status,
    "cancelled",
  );
});

test("encryption-key rotation preserves scoped credentials and rejects the old key", async () => {
  const { writeFile, mkdir } = await import("node:fs/promises");
  const { randomBytes } = await import("node:crypto");
  await mkdir(".fieldkit/key-test", { recursive: true });
  const next = randomBytes(32).toString("base64");
  await writeFile(".fieldkit/key-test/new", next, { mode: 0o600 });
  await writeFile(".fieldkit/key-test/old", c.FIELDKIT_ENCRYPTION_KEY, {
    mode: 0o600,
  });
  const rows = await app.db.rows("SELECT * FROM connections WHERE secret<>''");
  const original = rows.map((row: any) =>
    unseal(
      c.FIELDKIT_ENCRYPTION_KEY,
      `${row.workspace_id}:${row.provider}`,
      row.secret,
    ),
  );
  await promisify(execFile)(
    process.execPath,
    [
      "--import",
      "tsx",
      "scripts/rotate-encryption-key.ts",
      ".fieldkit/key-test/new",
    ],
    {
      env: {
        ...process.env,
        ...Object.fromEntries(
          Object.entries(c).map(([k, v]) => [k, String(v)]),
        ),
      },
    },
  );
  for (const [i, row] of rows.entries()) {
    const updated = await app.db.one(
      "SELECT secret FROM connections WHERE id=$1",
      [row.id],
    );
    assert.deepEqual(
      unseal(next, `${row.workspace_id}:${row.provider}`, updated.secret),
      original[i],
    );
    assert.throws(() =>
      unseal(
        c.FIELDKIT_ENCRYPTION_KEY,
        `${row.workspace_id}:${row.provider}`,
        updated.secret,
      ),
    );
  }
  await promisify(execFile)(
    process.execPath,
    [
      "--import",
      "tsx",
      "scripts/rotate-encryption-key.ts",
      ".fieldkit/key-test/old",
    ],
    {
      env: {
        ...process.env,
        ...Object.fromEntries(
          Object.entries(c).map(([k, v]) => [k, String(v)]),
        ),
        FIELDKIT_ENCRYPTION_KEY: next,
      },
    },
  );
});

test("MCP exposes only customer-bound request and status tools over real stdio transport", async () => {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StdioClientTransport } = await import(
    "@modelcontextprotocol/sdk/client/stdio.js"
  );
  const { ws, contactId } = await workspace(app);
  await app.db.pool.query(
    "UPDATE contacts SET external_id='host:mcp-customer' WHERE id=$1",
    [contactId],
  );
  const key = token();
  await app.db.pool.query(
    "INSERT INTO credentials(hash,workspace_id,kind,scopes,expires_at) VALUES($1,$2,'service',$3,now()+interval '1 hour')",
    [tokenHash(key), ws.id, ["requests:create"]],
  );
  const client = new Client({ name: "verification", version: "1" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", "packages/mcp/src/server.ts"],
    env: {
      PATH: process.env.PATH!,
      FIELDKIT_URL: c.FIELDKIT_URL,
      FIELDKIT_WORKSPACE: ws.id,
      FIELDKIT_TOKEN: key,
      FIELDKIT_CUSTOMER: "mcp-customer",
    },
    stderr: "pipe",
  });
  try {
    await client.connect(transport);
    assert.deepEqual(
      (await client.listTools()).tools.map((t) => t.name).sort(),
      ["request_support", "support_status"],
    );
    const result: any = await client.callTool({
      name: "request_support",
      arguments: { message: "How do returns work?", idempotencyKey: uid() },
    });
    assert.equal(result.isError, undefined);
    const conv = JSON.parse(result.content[0].text);
    const status: any = await client.callTool({
      name: "support_status",
      arguments: { conversationId: conv.id },
    });
    assert.equal(
      JSON.parse(status.content[0].text).messages[0].body,
      "How do returns work?",
    );
  } finally {
    await client.close();
  }
});

test("portal follow-up on a Zendesk handoff is forwarded as the requester before continuing the agent", async () => {
  const w = await workspace(app);
  await app.connections.save(
    w.ws.id,
    "zendesk",
    { access_token: "test-zendesk" },
    { subdomain: "test" },
  );
  providers.zendeskComments = [];
  providers.zendeskAudits = [];
  const conv = await app.newConversation(w.customer, {
    body: "Initial question",
    requestKey: uid(),
  });
  await app.db.pool.query(
    "UPDATE conversations SET external_id='11',external_requester_id='123',external_version=$1 WHERE id=$2",
    [providers.zendeskVersion, conv.id],
  );
  await app.message(w.customer, conv.id, {
    body: "Here is my follow-up",
    requestKey: uid(),
  });
  const delivery = await app.db.one(
    "SELECT * FROM deliveries WHERE conversation_id=$1",
    [conv.id],
  );
  assert.equal(delivery.payload.customer, true);
  assert.equal(
    (
      await app.db.rows(
        "SELECT id FROM runs WHERE conversation_id=$1 AND revision=2",
        [conv.id],
      )
    ).length,
    0,
  );
  await app.support.deliver(w.ws.id, delivery.id);
  assert.equal(providers.lastZendeskWrite.comment.author_id, 123);
  assert.equal(providers.lastZendeskWrite.comment.body, "Here is my follow-up");
  await app.support.sync(w.ws.id, "11", true);
  assert.equal(
    (
      await app.db.rows(
        "SELECT id FROM runs WHERE conversation_id=$1 AND revision=2",
        [conv.id],
      )
    ).length,
    1,
  );
  assert.equal(
    (await app.db.one("SELECT mode FROM conversations WHERE id=$1", [conv.id]))
      .mode,
    "agent",
  );
});

test("revoked evidence cannot leak through a handoff citation after generation", async () => {
  const w = await workspace(app),
    source = await knowledge(app, w.ws.id);
  model.hook = async () => {
    await app.db.pool.query(
      "UPDATE sources SET visibility='staff',revision=revision+1 WHERE id=$1",
      [source.id],
    );
  };
  try {
    const { conv, run } = await runText(w, "What is the return window?");
    assert.equal(run.status, "handed_off");
    const message = await app.db.one(
      "SELECT * FROM messages WHERE conversation_id=$1 AND role='assistant'",
      [conv.id],
    );
    assert.deepEqual(message.citations, []);
    assert.doesNotMatch(message.body, /30 days/);
  } finally {
    model.hook = undefined;
  }
});
