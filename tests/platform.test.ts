import { test, before, after, mock } from "node:test";
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
} from "../packages/platform/src/security.js";
import { uid } from "../packages/platform/src/db.js";
import { extract } from "../packages/platform/src/knowledge.js";
import { Knowledge } from "../packages/platform/src/knowledge.js";
import { Connections } from "../packages/platform/src/connections.js";
import { docsFixture } from "./website-fixture.js";
import { DraftSchema } from "../packages/platform/src/contracts.js";
import { LiveModel } from "../packages/platform/src/model.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { FieldKitClient } from "../packages/sdk/src/index.js";
import { token, tokenHash } from "../packages/platform/src/security.js";
import {
  defaultWorkflow,
  newWorkflowNode,
} from "../packages/platform/src/workflow-definition.js";

const c = testConfig(),
  model = new TestModel(),
  providers = new TestProviders(),
  emails: { to: string; text: string }[] = [];
let server: Awaited<ReturnType<typeof createApp>>,
  app: ReturnType<typeof Object>;
let staffTestCookie = "";
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
test("manual FAQs need no model key, require exact approval, and edits withdraw indexed/public answers", async () => {
  const w = await workspace(app),
    other = await workspace(app);
  await app.connections.disconnect(w.ws.id, "openai");
  const [faq] = await app.knowledge.createFaqs(w.ws.id, [
    {
      question: "How do I get help?",
      answer: "Open a support ticket in the help center.",
      citationIds: [],
    },
  ]);
  assert.equal(faq.status, "draft");
  assert.equal(faq.visibility, "staff");
  await app.knowledge.ingest(w.ws.id, faq.id);
  assert.equal(
    (await app.db.rows("SELECT id FROM documents WHERE source_id=$1", [faq.id]))
      .length,
    0,
  );
  await assert.rejects(
    app.knowledge.approveFaq(w.ws.id, faq.id, faq.revision),
    /Connect openai/i,
  );
  await app.connections.save(w.ws.id, "openai", { apiKey: "test" }, {});
  await assert.rejects(
    app.knowledge.updateFaq(other.ws.id, faq.id, {
      question: faq.title,
      answer: "Wrong workspace",
      revision: faq.revision,
    }),
    /not found/i,
  );
  const approvals = await Promise.allSettled([
    app.knowledge.approveFaq(w.ws.id, faq.id, faq.revision),
    app.knowledge.approveFaq(w.ws.id, faq.id, faq.revision),
  ]);
  assert.equal(approvals.filter((r) => r.status === "fulfilled").length, 1);
  await app.knowledge.ingest(w.ws.id, faq.id);
  const evidence = await app.knowledge.retrieve(w.ws.id, "get help");
  assert.equal(evidence.length, 1);
  await app.db.pool.query(
    "UPDATE documents SET published=true WHERE source_id=$1",
    [faq.id],
  );
  const current = await app.db.one("SELECT revision FROM sources WHERE id=$1", [
    faq.id,
  ]);
  const updated = await app.knowledge.updateFaq(w.ws.id, faq.id, {
    question: "How do I contact support?",
    answer: "Use the contact form in the help center.",
    revision: current.revision,
  });
  assert.equal(updated.status, "draft");
  assert.equal(updated.visibility, "staff");
  assert.equal(await app.knowledge.validEvidence(w.ws.id, evidence), false);
  assert.equal((await app.knowledge.retrieve(w.ws.id, "help")).length, 0);
  assert.equal(
    (
      await app.db.rows(
        "SELECT id FROM documents WHERE source_id=$1 AND (active OR published)",
        [faq.id],
      )
    ).length,
    0,
  );
  await assert.rejects(
    app.knowledge.approveFaq(w.ws.id, faq.id, current.revision),
    /changed/,
  );
  await app.knowledge.approveFaq(w.ws.id, faq.id, updated.revision);
  await app.knowledge.ingest(w.ws.id, faq.id);
  const doc = await app.db.one(
    "SELECT version,published FROM documents WHERE source_id=$1 AND active",
    [faq.id],
  );
  assert.deepEqual(doc, { version: 2, published: false });
  await app.knowledge.remove(w.ws.id, faq.id);
  assert.equal((await app.knowledge.retrieve(w.ws.id, "help")).length, 0);
});
test("AI FAQ drafts use only approved tenant knowledge and reject fabricated or revoked citations", async () => {
  const w = await workspace(app),
    other = await workspace(app);
  await assert.rejects(
    app.knowledge.suggestFaqs(w.ws.id, { count: 3, instructions: "" }),
    /customer-approved knowledge/,
  );
  const source = await knowledge(app, w.ws.id);
  const secret = await app.knowledge.upload(
    w.ws.id,
    "private.txt",
    Buffer.from("Staff secret: use the private discount code SECRET-123."),
  );
  await app.knowledge.ingest(w.ws.id, secret.id);
  const foreign = await knowledge(app, other.ws.id);
  await assert.rejects(
    app.knowledge.suggestFaqs(w.ws.id, {
      count: 1,
      instructions: "",
      sourceId: foreign.id,
    }),
    /Choose available/,
  );
  model.faqHook = async (input) => {
    assert.equal(input.workspaceId, w.ws.id);
    assert.ok(input.evidence.length > 0);
    assert.ok(
      input.evidence.every(
        (e) => e.sourceId === source.id && !e.excerpt.includes("SECRET"),
      ),
    );
  };
  try {
    const result = await app.knowledge.suggestFaqs(w.ws.id, {
      count: 3,
      instructions: "Returns",
      sourceId: source.id,
    });
    const [faq] = await app.knowledge.createFaqs(
      w.ws.id,
      result.drafts,
      true,
      result.evidence,
    );
    assert.equal(faq.visibility, "staff");
    assert.equal(faq.status, "draft");
    assert.equal(faq.metadata.aiGenerated, true);
    await assert.rejects(
      app.knowledge.suggestFaqs(w.ws.id, {
        count: 3,
        instructions: "Returns",
        sourceId: source.id,
      }),
      /already exist/,
    );
    assert.equal(
      (
        await app.db.rows("SELECT id FROM documents WHERE source_id=$1", [
          faq.id,
        ])
      ).length,
      0,
    );
    const invalid = mock.method(model, "faqs", async () => [
      {
        question: "Can I get free products?",
        answer: "All products are free.",
        citationIds: ["invented"],
      },
    ]);
    try {
      await assert.rejects(
        app.knowledge.suggestFaqs(w.ws.id, { count: 1, instructions: "" }),
        /unsupported FAQ/,
      );
    } finally {
      invalid.mock.restore();
    }
    model.faqHook = async () => {
      await app.db.pool.query(
        "UPDATE sources SET visibility='staff' WHERE id=$1",
        [source.id],
      );
    };
    await assert.rejects(
      app.knowledge.suggestFaqs(w.ws.id, { count: 1, instructions: "" }),
      /knowledge changed/,
    );
    await assert.rejects(
      app.knowledge.createFaqs(w.ws.id, result.drafts, true, result.evidence),
      /knowledge changed/,
    );
    model.faqHook = undefined;
    const edit = await app.knowledge.suggestFaqs(w.ws.id, {
      count: 1,
      question: "How do I get help?",
      answer: "Use our support page.",
      instructions: "Be concise",
    });
    assert.match(edit.drafts[0].answer, /Use our support page/);
  } finally {
    model.faqHook = undefined;
  }
});
test("FAQ APIs enforce staff roles, tenant boundaries, input limits and draft-only creation", async () => {
  const w = await workspace(app),
    other = await workspace(app);
  const user = await app.db.one(
    'SELECT id,email FROM "user" WHERE "emailVerified"=true LIMIT 1',
  );
  await app.db.pool.query("INSERT INTO memberships VALUES($1,$2,'owner')", [
    w.ws.id,
    user.id,
  ]);
  const login = await call("/api/auth/sign-in/email", {
    email: user.email,
    password: "correct-horse-battery-staple",
  });
  const cookie = login.response.headers
    .getSetCookie()
    .map((v) => v.split(";")[0])
    .join("; ");
  const path = `/v2/workspaces/${w.ws.id}/faqs`;
  staffTestCookie = cookie;
  const created = await call(
    path,
    {
      question: "Where do I get support?",
      answer: "Visit our support portal.",
    },
    cookie,
  );
  assert.equal(created.response.status, 201, JSON.stringify(created.json));
  assert.equal(created.json.status, "draft");
  assert.equal(
    (await call(path + "/generate", { count: 999 }, cookie)).response.status,
    400,
  );
  assert.equal(
    (await call(`/v2/workspaces/${other.ws.id}/faqs`, undefined, cookie))
      .response.status,
    403,
  );
  await app.db.pool.query(
    "UPDATE memberships SET role='agent' WHERE workspace_id=$1 AND user_id=$2",
    [w.ws.id, user.id],
  );
  assert.equal((await call(path, undefined, cookie)).response.status, 200);
  for (const [suffix, method, body] of [
    ["", "POST", { question: "Another question?", answer: "Another answer." }],
    ["/generate", "POST", {}],
    ["/assist", "POST", { question: "Help me?" }],
    [`/${created.json.id}`, "DELETE", {}],
    [`/${created.json.id}/approve`, "POST", { revision: 1 }],
  ] as const)
    assert.equal(
      (await call(path + suffix, body, cookie, method)).response.status,
      403,
    );
});
test("assistance HTTP endpoints require staff sessions and keep jobs scoped to their workspace", async () => {
  const w = await workspace(app),
    other = await workspace(app);
  const user = await app.db.one(
    'SELECT id,email FROM "user" WHERE "emailVerified"=true LIMIT 1',
  );
  await app.db.pool.query("INSERT INTO memberships VALUES($1,$2,'owner')", [
    w.ws.id,
    user.id,
  ]);
  const cookie = staffTestCookie;
  assert.ok(cookie);
  await knowledge(app, w.ws.id);
  const path = `/v2/workspaces/${w.ws.id}/assistance`;
  assert.equal((await call(path)).response.status, 401);
  const started = await call(path, { kind: "faq_review" }, cookie);
  assert.equal(started.response.status, 202, JSON.stringify(started.json));
  assert.equal(
    (await call(path, undefined, cookie)).json.tasks[0].id,
    started.json.id,
  );
  assert.equal(
    (await call(`/v2/workspaces/${other.ws.id}/assistance`, undefined, cookie))
      .response.status,
    403,
  );
  const foreign = await app.assistance.start(other.owner, {
    kind: "research",
    conversationId: (
      await app.newConversation(other.customer, {
        body: "Help",
        requestKey: uid(),
      })
    ).id,
  });
  assert.equal(
    (await call(`${path}/${foreign.id}/cancel`, {}, cookie)).response.status,
    404,
  );
  assert.equal(
    (await call(path, { kind: "research" }, cookie)).response.status,
    400,
  );
  await app.db.pool.query(
    "UPDATE memberships SET role='agent' WHERE workspace_id=$1 AND user_id=$2",
    [w.ws.id, user.id],
  );
  assert.equal((await call(path, undefined, cookie)).response.status, 200);
  assert.equal(
    (await call(`${path}/${started.json.id}/cancel`, {}, cookie)).response
      .status,
    403,
  );
  assert.equal(
    (await call(path, { kind: "faq_review" }, cookie)).response.status,
    403,
  );
  await app.db.pool.query(
    "DELETE FROM memberships WHERE workspace_id=$1 AND user_id=$2",
    [w.ws.id, user.id],
  );
  assert.equal((await call(path, undefined, cookie)).response.status, 403);
});
test("workflow HTTP editing, previews and version history enforce current workspace roles", async () => {
  const w = await workspace(app),
    other = await workspace(app);
  const user = await app.db.one(
    'SELECT id FROM "user" WHERE "emailVerified"=true LIMIT 1',
  );
  await app.db.pool.query("INSERT INTO memberships VALUES($1,$2,'owner')", [
    w.ws.id,
    user.id,
  ]);
  const cookie = staffTestCookie,
    path = `/v2/workspaces/${w.ws.id}/workflow`;
  assert.equal((await call(path)).response.status, 401);
  assert.equal(
    (await call(`/v2/workspaces/${other.ws.id}/workflow`, undefined, cookie))
      .response.status,
    403,
  );
  assert.equal((await call(path, undefined, cookie)).json.revision, 0);
  const handoff = newWorkflowNode("handoff", "handoff");
  if (handoff.type === "handoff")
    handoff.data.message = "Our support team will help you.";
  const definition = {
    format: 1,
    title: "Team handoff",
    nodes: [newWorkflowNode("start", "start"), handoff],
    edges: [{ from: "start", port: "next", to: "handoff" }],
  };
  const saved = await call(path, { revision: 0, definition }, cookie, "PUT");
  assert.equal(saved.response.status, 200, JSON.stringify(saved.json));
  const published = await call(
    `${path}/publish`,
    { revision: saved.json.revision },
    cookie,
  );
  assert.equal(published.response.status, 200, JSON.stringify(published.json));
  assert.equal(published.json.publishedVersion, 1);
  assert.deepEqual(
    (await call(`${path}/versions/1`, undefined, cookie)).json.definition,
    definition,
  );
  assert.equal(
    (await call(`${path}/versions/2`, undefined, cookie)).response.status,
    404,
  );
  const preview = await call(
    `${path}/test`,
    { definition, question: "Hello" },
    cookie,
  );
  assert.equal(preview.json.answer, "Our support team will help you.");
  assert.equal(preview.json.actionsExecuted, false);
  const setupPreview = await call(
    `/v2/workspaces/${w.ws.id}/agent/test`,
    { question: "Hello" },
    cookie,
  );
  assert.equal(setupPreview.json.answer, preview.json.answer);
  const componentDefinition = {
    kind: "code",
    name: "Pure calculation",
    language: "python",
    code: "def run(input):\n    return {}",
  };
  const component = await call(
    `${path}/components`,
    { revision: 0, definition: componentDefinition },
    cookie,
  );
  assert.equal(component.response.status, 200, JSON.stringify(component.json));
  const componentPath = `${path}/components/${component.json.id}`;
  assert.equal(
    (await call(componentPath + "/versions/1", undefined, cookie)).response
      .status,
    200,
  );
  assert.equal(
    (await call(`${path}/step-results`, undefined, cookie)).response.status,
    200,
  );
  assert.equal(
    (
      await call(
        `/v2/workspaces/${other.ws.id}/workflow/components/${component.json.id}/versions/1`,
        undefined,
        cookie,
      )
    ).response.status,
    403,
  );
  assert.equal(
    (
      await call(
        `${path}/test`,
        { definition, question: "Hello", contactId: other.customer.contactId },
        cookie,
      )
    ).response.status,
    404,
  );
  await app.db.pool.query(
    "UPDATE memberships SET role='agent' WHERE workspace_id=$1 AND user_id=$2",
    [w.ws.id, user.id],
  );
  assert.equal((await call(path, undefined, cookie)).response.status, 200);
  assert.equal(
    (await call(`${path}/versions/1`, undefined, cookie)).response.status,
    200,
  );
  for (const [suffix, data, method] of [
    ["", { revision: published.json.revision, definition }, "PUT"],
    ["/publish", { revision: published.json.revision }, "POST"],
    ["/test", { definition, question: "Hello" }, "POST"],
    ["/components", { revision: 0, definition: componentDefinition }, "POST"],
    [
      "/components/test",
      { definition: componentDefinition, input: {} },
      "POST",
    ],
    [`/components/${component.json.id}`, {}, "DELETE"],
    [
      `/components/${component.json.id}`,
      { revision: 1, definition: componentDefinition },
      "PUT",
    ],
  ] as const)
    assert.equal(
      (await call(path + suffix, data, cookie, method)).response.status,
      403,
    );
  await app.db.pool.query(
    "DELETE FROM memberships WHERE workspace_id=$1 AND user_id=$2",
    [w.ws.id, user.id],
  );
  assert.equal(
    (await call(`${path}/versions/1`, undefined, cookie)).response.status,
    403,
  );
});
test("live model adapter removes transport-only JSON before strict draft validation and records actual usage", async () => {
  const w = await workspace(app),
    live = new LiveModel(app.db, app.connections);
  let parametersJson = '{"orderId":"order-123"}';
  const client = mock.method(live as any, "client", async () => ({
    responses: {
      parse: async () => ({
        output_parsed: {
          intent: "clarify",
          answer: "Which order do you mean?",
          citationIds: [],
          actionName: null,
          parametersJson,
          reason: "Need a specific order",
        },
        usage: { input_tokens: 31, output_tokens: 12 },
      }),
    },
  }));
  const input = {
    workspaceId: w.ws.id,
    runId: uid(),
    messages: [{ role: "customer", body: "test" }],
    evidence: [],
    actions: [],
    account: null,
    instructions: "Use approved evidence",
    model: "gpt-5.4-mini",
  };
  try {
    const draft = DraftSchema.parse(await live.answer(input));
    assert.deepEqual(draft.parameters, { orderId: "order-123" });
    assert.equal("parametersJson" in draft, false);
    const usage = await app.db.one(
      "SELECT input_tokens,output_tokens,reserved FROM usage WHERE workspace_id=$1",
      [w.ws.id],
    );
    assert.deepEqual(usage, {
      input_tokens: 31,
      output_tokens: 12,
      reserved: 0,
    });
    parametersJson = "[]";
    await assert.rejects(live.answer(input), /parameters must be an object/);
    parametersJson = "invalid";
    await assert.rejects(live.answer(input), /Invalid action parameters/);
  } finally {
    client.mock.restore();
  }
});
test("live FAQ adapter validates structured drafts, records usage and applies the workspace budget", async () => {
  const w = await workspace(app),
    live = new LiveModel(app.db, app.connections);
  let calls = 0;
  const client = mock.method(live as any, "client", async () => ({
    responses: {
      parse: async () => {
        calls++;
        return {
          output_parsed: {
            faqs: [
              {
                question: "How do I get help?",
                answer: "Use the support portal.",
                citationIds: [],
              },
            ],
          },
          usage: { input_tokens: 51, output_tokens: 29 },
        };
      },
    },
  }));
  const input = {
    workspaceId: w.ws.id,
    model: "gpt-5.4-mini",
    count: 1,
    instructions: "Be concise",
    question: "How do I get help?",
    answer: "Use the support portal.",
    evidence: [],
    existingQuestions: [],
  };
  try {
    assert.equal((await live.faqs(input))[0].answer, "Use the support portal.");
    const usage = await app.db.one(
      "SELECT kind,input_tokens,output_tokens,reserved FROM usage WHERE workspace_id=$1",
      [w.ws.id],
    );
    assert.deepEqual(usage, {
      kind: "faq",
      input_tokens: 51,
      output_tokens: 29,
      reserved: 0,
    });
    await app.db.pool.query(
      "UPDATE workspaces SET settings=jsonb_set(settings,'{monthlyTokenBudget}','1000'::jsonb) WHERE id=$1",
      [w.ws.id],
    );
    await assert.rejects(live.faqs(input), /budget reached/);
    assert.equal(calls, 1);
  } finally {
    client.mock.restore();
  }
});
test("documentation sites index separate cited pages, refresh versions and remove deleted/revoked pages", async () => {
  const w = await workspace(app),
    f = docsFixture();
  let embedded = 0;
  const knowledge = new Knowledge(app.db, new Connections(app.db, f.fetch), {
    faqs: (input) => model.faqs(input),
    assist: (input) => model.assist(input),
    answer: (input) => model.answer(input),
    embed: (ws, texts) => {
      embedded += texts.length;
      return model.embed(ws, texts);
    },
  });
  const source = await knowledge.add(w.ws.id, {
    kind: "website",
    scope: "site",
    title: "Company docs",
    locator: f.origin + "/guide",
  });
  await knowledge.ingest(w.ws.id, source.id);
  const docs = () =>
    app.db.rows(
      "SELECT * FROM documents WHERE source_id=$1 AND active ORDER BY locator",
      [source.id],
    );
  assert.equal((await docs()).length, 3);
  assert.equal(
    (await knowledge.retrieve(w.ws.id, "workspace")).length,
    0,
    "imports stay staff-only",
  );
  await app.db.pool.query(
    "UPDATE sources SET visibility='customer' WHERE id=$1",
    [source.id],
  );
  await app.db.pool.query(
    "UPDATE documents SET published=true WHERE source_id=$1",
    [source.id],
  );
  let evidence = await knowledge.retrieve(w.ws.id, "workspace");
  assert.equal(evidence.length, 3);
  assert.ok(evidence.every((c) => c.url?.startsWith(f.origin + "/guide")));
  assert.equal(
    (await knowledge.retrieve((await workspace(app)).ws.id, "workspace"))
      .length,
    0,
  );
  const before = embedded;
  await knowledge.ingest(w.ws.id, source.id);
  assert.equal(
    embedded,
    before,
    "unchanged pages do not consume embeddings again",
  );
  assert.ok((await docs()).every((d: any) => d.version === 1 && d.published));
  f.routes.set("/guide/start", [
    "<main><h1>Getting started</h1><p>New installation instructions for your workspace.</p></main>",
  ]);
  f.routes.delete("/guide/unlinked");
  await knowledge.ingest(w.ws.id, source.id);
  const refreshed = await docs();
  assert.equal(refreshed.length, 2);
  assert.equal(
    refreshed.find((d: any) => d.locator.endsWith("/start")).version,
    2,
  );
  assert.equal(
    refreshed.find((d: any) => d.locator.endsWith("/start")).published,
    false,
  );
  assert.equal(
    refreshed.find((d: any) => d.locator.endsWith("/guide")).published,
    true,
  );
  assert.equal(await knowledge.validEvidence(w.ws.id, evidence), false);
  evidence = await knowledge.retrieve(w.ws.id, "workspace");
  assert.equal(evidence.length, 2);
  f.routes.set("/robots.txt", [
    "User-agent: *\nDisallow: /",
    200,
    "text/plain",
  ]);
  await assert.rejects(
    knowledge.ingest(w.ws.id, source.id),
    /disallows crawling/,
  );
  assert.equal((await knowledge.retrieve(w.ws.id, "workspace")).length, 0);
  assert.equal(
    (await app.db.one("SELECT status FROM sources WHERE id=$1", [source.id]))
      .status,
    "failed",
  );
  await knowledge.remove(w.ws.id, source.id);
  assert.equal((await docs()).length, 0);
});
test("a cited answer persists through the real LangGraph graph and a follow-up keeps the conversation", async () => {
  const w = await workspace(app);
  await knowledge(app, w.ws.id);
  const { conv, run } = await runText(w, "What is your return policy?");
  assert.equal(run.status, "completed");
  assert.equal(run.state.draft.intent, "answer");
  const published = await app.db.one(
    "SELECT workspace_id,conversation_id,data FROM events WHERE kind='agent.step' AND data->>'runId'=$1 AND data->>'node'='publish_response'",
    [run.id],
  );
  assert.deepEqual(published, {
    workspace_id: w.ws.id,
    conversation_id: conv.id,
    data: {
      runId: run.id,
      node: "publish_response",
      status: "completed",
      route: "respond",
    },
  });
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
test("rejecting an approval stops legacy and configured workflows without customer messages or provider deliveries", async () => {
  for (const configured of [false, true]) {
    providers.writes = 0;
    const w = await workspace(app);
    const action = await refundAction(w.ws.id);
    if (configured) {
      const current = await app.workflows.get(w.owner);
      const draft = await app.workflows.save(w.owner, {
        revision: current.revision,
        definition: defaultWorkflow([action.id]),
      });
      await app.workflows.publish(w.owner, draft.revision);
    }
    const { conv, run } = await runText(w, "Please refund this charge");
    assert.equal(run.status, "waiting_approval");
    const a = await app.db.one("SELECT * FROM approvals WHERE run_id=$1", [
      run.id,
    ]);
    const revision = (
      await app.db.one("SELECT revision FROM conversations WHERE id=$1", [
        conv.id,
      ])
    ).revision;
    await app.message(
      w.owner,
      conv.id,
      { body: "Checking this proposal privately", requestKey: uid() },
      true,
    );
    assert.equal(
      (await app.db.one("SELECT status FROM approvals WHERE id=$1", [a.id]))
        .status,
      "pending",
    );
    assert.equal(
      (
        await app.db.one("SELECT revision FROM conversations WHERE id=$1", [
          conv.id,
        ])
      ).revision,
      revision,
    );
    // A now-disabled action must still be rejectable.
    await app.db.pool.query(
      "UPDATE actions SET enabled=false,revision=revision+1 WHERE id=$1",
      [action.id],
    );
    await app.decide(w.owner, a.id, a.hash, "reject");
    await app.agent.advance(w.ws.id, run.id);
    await app.agent.advance(w.ws.id, run.id);
    assert.equal(providers.writes, 0);
    assert.deepEqual(
      await app.db.one("SELECT status,mode FROM conversations WHERE id=$1", [
        conv.id,
      ]),
      { status: "needs_staff", mode: "human" },
    );
    assert.equal(
      (await app.db.one("SELECT status FROM runs WHERE id=$1", [run.id]))
        .status,
      "handed_off",
    );
    assert.equal(
      (await app.db.one("SELECT status FROM approvals WHERE id=$1", [a.id]))
        .status,
      "rejected",
    );
    for (const table of ["operations", "deliveries", "ticket_emails"])
      assert.equal(
        (
          await app.db.rows(`SELECT id FROM ${table} WHERE workspace_id=$1`, [
            w.ws.id,
          ])
        ).length,
        0,
      );
    assert.equal(
      (
        await app.db.rows(
          "SELECT id FROM messages WHERE conversation_id=$1 AND role='assistant'",
          [conv.id],
        )
      ).length,
      0,
    );
    await assert.rejects(
      app.decide(w.owner, a.id, a.hash, "approve"),
      /already has a decision/,
    );
    const followup = await app.message(w.customer, conv.id, {
      body: "Any update?",
      requestKey: uid(),
    });
    assert.ok(followup.id);
    assert.equal(
      (
        await app.db.rows("SELECT id FROM runs WHERE conversation_id=$1", [
          conv.id,
        ])
      ).length,
      1,
    );
  }
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

test("an uncertain operation can be reconciled from its immutable contract after policy and identity edits", async () => {
  const w = await workspace(app);
  await refundAction(w.ws.id, true);
  providers.refunds = [];
  providers.writes = 0;
  providers.timeoutAfterCommit = true;
  let run: any;
  try {
    ({ run } = await runText(w, "refund please"));
  } finally {
    providers.timeoutAfterCommit = false;
  }
  const op = await app.db.one("SELECT * FROM operations WHERE run_id=$1", [
    run.id,
  ]);
  assert.equal(op.status, "unknown");
  await app.db.pool.query(
    "UPDATE actions SET enabled=false,revision=revision+1 WHERE workspace_id=$1",
    [w.ws.id],
  );
  await app.db.pool.query(
    "UPDATE contacts SET mappings='{}',revision=revision+1 WHERE id=$1",
    [w.contactId],
  );
  await assert.rejects(
    app.actions.revalidate(w.ws.id, run.state.proposal),
    /changed/,
  );
  const receipt = await app.actions.reconcileOperation(w.ws.id, op);
  assert.equal(receipt.result.amountMinor, 4900);
  assert.equal(providers.writes, 1);
});

test("unpublishing a channel pauses its conversations and revokes existing widget credentials", async () => {
  const w = await workspace(app);
  const channel = await app.db.one(
    "UPDATE channels SET published=true WHERE workspace_id=$1 AND kind='widget' RETURNING *",
    [w.ws.id],
  );
  const conv = await app.newConversation(w.customer, {
    channelId: channel.id,
    body: "Question",
    requestKey: uid(),
  });
  const key = token();
  await app.db.pool.query(
    "INSERT INTO credentials(hash,workspace_id,contact_id,kind,expires_at) VALUES($1,$2,$3,'widget',now()+interval '1 hour')",
    [tokenHash(key), w.ws.id, w.contactId],
  );
  await app.publishChannel(w.owner, channel.id, {
    published: false,
    settings: { origins: [], handoff: "native" },
  });
  const updated = await app.db.one("SELECT * FROM conversations WHERE id=$1", [
    conv.id,
  ]);
  assert.equal(updated.mode, "human");
  assert.equal(updated.revision, conv.revision + 1);
  const response = await fetch(
    `${c.FIELDKIT_URL}/v2/workspaces/${w.ws.id}/conversations/${conv.id}`,
    { headers: { Authorization: `Bearer ${key}` } },
  );
  assert.equal(response.status, 401);
});

test("inbox previews exclude private notes and remain scoped to the authenticated customer and workspace", async () => {
  const user = await app.db.one(
    'SELECT id,email FROM "user" WHERE "emailVerified"=true LIMIT 1',
  );
  const w = await workspace(app, user.id),
    other = await workspace(app, user.id);
  const first = await app.newConversation(w.customer, {
    body: "Public question",
    requestKey: uid(),
    channelId: w.channelId,
  });
  await app.message(w.owner, first.id, {
    body: "A public reply",
    requestKey: uid(),
  });
  await app.message(
    w.owner,
    first.id,
    { body: "PRIVATE-NOTE-EXCLUDED", requestKey: uid() },
    true,
  );
  await app.newConversation(other.customer, {
    body: "OTHER-WORKSPACE-EXCLUDED",
    requestKey: uid(),
  });
  const secondId = uid();
  await app.db.pool.query(
    "INSERT INTO contacts(id,workspace_id,name) VALUES($1,$2,'Another customer')",
    [secondId, w.ws.id],
  );
  await app.newConversation(
    { workspaceId: w.ws.id, role: "customer", contactId: secondId },
    { body: "OTHER-CUSTOMER-EXCLUDED", requestKey: uid() },
  );
  const secret = token();
  await app.db.pool.query(
    "UPDATE channels SET published=true WHERE workspace_id=$1 AND kind='widget'",
    [w.ws.id],
  );
  await app.db.pool.query(
    "INSERT INTO credentials(hash,workspace_id,contact_id,kind,expires_at) VALUES($1,$2,$3,'widget',now()+interval '1 hour')",
    [tokenHash(secret), w.ws.id, w.contactId],
  );
  const response = await fetch(
    `${c.FIELDKIT_URL}/v2/workspaces/${w.ws.id}/conversations`,
    { headers: { Authorization: `Bearer ${secret}` } },
  );
  assert.equal(response.status, 200);
  const result = (await response.json()) as any;
  assert.equal(result.conversations.length, 1);
  assert.equal(result.conversations[0].id, first.id);
  assert.equal(result.conversations[0].last_message, "A public reply");
  assert.equal(result.conversations[0].last_message_role, "staff");
  assert.equal(result.conversations[0].channel_kind, "portal");
  assert.equal(result.conversations[0].approval_expires_at, null);
  assert.ok(!JSON.stringify(result).includes("EXCLUDED"));
  const cross = await fetch(
    `${c.FIELDKIT_URL}/v2/workspaces/${other.ws.id}/conversations`,
    { headers: { Authorization: `Bearer ${secret}` } },
  );
  assert.equal(cross.status, 401);
  await refundAction(w.ws.id);
  const { conv } = await runText(w, "Please refund my purchase");
  const cookie = staffTestCookie;
  assert.ok(cookie);
  const detail = await call(
    `/v2/workspaces/${w.ws.id}/conversations/${conv.id}`,
    undefined,
    cookie,
  );
  assert.equal(detail.response.status, 200);
  assert.equal(detail.json.approvals[0].action_name, "refund_payment");
  const list = await call(
    `/v2/workspaces/${w.ws.id}/conversations`,
    undefined,
    cookie,
  );
  assert.ok(
    list.json.conversations.find((row: any) => row.id === conv.id)
      .approval_expires_at,
  );
  const joined = await call(`/v2/public/${w.ws.slug}/join`, {}, cookie);
  assert.equal(joined.response.status, 200);
  const customerHeaders = { Cookie: cookie, "X-Fieldkit-Audience": "customer" };
  const ownOnly = await fetch(
    `${c.FIELDKIT_URL}/v2/workspaces/${w.ws.id}/conversations`,
    { headers: customerHeaders },
  );
  assert.deepEqual(((await ownOnly.json()) as any).conversations, []);
  const hidden = await fetch(
    `${c.FIELDKIT_URL}/v2/workspaces/${w.ws.id}/conversations/${conv.id}`,
    { headers: customerHeaders },
  );
  assert.equal(hidden.status, 404);
  const reduced = await fetch(
    `${c.FIELDKIT_URL}/v2/workspaces/${w.ws.id}/workflow`,
    { headers: customerHeaders },
  );
  assert.equal(reduced.status, 403);
});

test("public help centers advertise only enabled contact options and reject disabled widget sessions", async () => {
  const w = await workspace(app);
  for (const mode of ["both", "tickets", "chat", "none"] as const) {
    await app.updateSupportOptions(w.owner, { mode });
    const publicInfo = await fetch(`${c.FIELDKIT_URL}/v2/public/${w.ws.slug}`);
    assert.equal(publicInfo.status, 200);
    const info = await publicInfo.json();
    assert.equal(info.ticketsEnabled, mode === "both" || mode === "tickets");
    assert.equal(info.chatEnabled, mode === "both" || mode === "chat");
    const widget = await fetch(
      `${c.FIELDKIT_URL}/v2/public/${w.ws.slug}/widget/config`,
    );
    assert.equal(widget.status, info.chatEnabled ? 200 : 404);
    const session = await fetch(
      `${c.FIELDKIT_URL}/v2/public/${w.ws.slug}/widget/session`,
      {
        method: "POST",
        headers: { Origin: c.FIELDKIT_URL, "Content-Type": "application/json" },
        body: JSON.stringify({ channel: "widget" }),
      },
    );
    assert.equal(session.status, info.chatEnabled ? 200 : 404);
    const articles = await fetch(
      `${c.FIELDKIT_URL}/v2/public/${w.ws.slug}/articles`,
    );
    assert.equal(articles.status, 200);
  }
});

test("malformed request targets cannot crash the server; invalid Authorization cannot borrow a session", async () => {
  const { request } = await import("node:http");
  const malformedStatus = await new Promise<number>((resolve, reject) => {
    const req = request(
      { host: "127.0.0.1", port: c.FIELDKIT_PORT, path: "//[" },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode!));
      },
    );
    req.on("error", reject);
    req.end();
  });
  assert.equal(malformedStatus, 400);
  assert.equal((await call("/v2/health")).response.status, 200);
  const me = await call("/v2/me", undefined, staffTestCookie);
  const id = me.json.workspaces[0].id;
  const denied = await fetch(
    `${c.FIELDKIT_URL}/v2/workspaces/${id}/conversations`,
    { headers: { Cookie: staffTestCookie, Authorization: "Basic bogus" } },
  );
  assert.equal(denied.status, 401);
  assert.equal(
    (
      await fetch(`${c.FIELDKIT_URL}/v2/me`, {
        headers: { Cookie: staffTestCookie, Authorization: "Bearer bogus" },
      })
    ).status,
    401,
  );
  const outsider = await workspace(app);
  await app.db.pool.query(
    "UPDATE contacts SET user_id=$1,verified=false WHERE workspace_id=$2 AND id=$3",
    [me.json.user.id, outsider.ws.id, outsider.contactId],
  );
  assert.equal(
    (
      await call(
        `/v2/workspaces/${outsider.ws.id}/conversations`,
        undefined,
        staffTestCookie,
      )
    ).response.status,
    403,
  );
  const page = await fetch(c.FIELDKIT_URL);
  assert.equal(page.status, 200);
  assert.match(
    page.headers.get("content-security-policy")!,
    /script-src 'self';/,
  );
  assert.equal(page.headers.get("x-content-type-options"), "nosniff");
  assert.equal(
    page.headers.get("permissions-policy"),
    "camera=(), microphone=(), geolocation=()",
  );
});

test("conversation SSE excludes private history, supports explicit replay, and revokes expired widget credentials", async () => {
  const w = await workspace(app);
  const conv = await app.newConversation(w.customer, {
    channelId: w.channelId,
    body: "A synthetic streaming question",
    requestKey: uid(),
  });
  const secret = token();
  await app.db.pool.query(
    "INSERT INTO credentials(hash,workspace_id,contact_id,channel_id,kind,expires_at) VALUES($1,$2,$3,$4,'widget',now()+interval '1 hour')",
    [tokenHash(secret), w.ws.id, w.customer.contactId, w.channelId],
  );
  await app.db.event(
    app.db.pool,
    w.ws.id,
    "test.private",
    { secret: "STAFF-ONLY-SYNTHETIC" },
    conv.id,
    false,
  );
  await app.db.event(
    app.db.pool,
    w.ws.id,
    "test.public",
    { message: "public" },
    conv.id,
    true,
  );
  const last = await app.db.one(
    "SELECT max(id) id FROM events WHERE workspace_id=$1 AND conversation_id=$2 AND public",
    [w.ws.id, conv.id],
  );
  const controller = new AbortController();
  const url = `${c.FIELDKIT_URL}/v2/workspaces/${w.ws.id}/conversations/${conv.id}/events`;
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${secret}` },
      signal: controller.signal,
    });
    assert.equal(res.status, 200);
    const reader = res.body!.getReader(),
      decoder = new TextDecoder();
    const first = decoder.decode((await reader.read()).value);
    assert.match(first, new RegExp(`id: ${last.id}\\n`));
    assert.match(first, /stream.connected/);
    assert.ok(!first.includes("STAFF-ONLY"));
    await app.db.pool.query("DELETE FROM credentials WHERE hash=$1", [
      tokenHash(secret),
    ]);
    const next = await reader.read();
    assert.equal(next.done, true);
    assert.equal(
      (await fetch(url, { headers: { Authorization: `Bearer ${secret}` } }))
        .status,
      401,
    );
  } finally {
    controller.abort();
  }
  await app.db.pool.query(
    "INSERT INTO credentials(hash,workspace_id,contact_id,channel_id,kind,expires_at) VALUES($1,$2,$3,$4,'widget',now()+interval '1 hour')",
    [tokenHash(secret), w.ws.id, w.customer.contactId, w.channelId],
  );
  const replayController = new AbortController();
  try {
    const replay = await fetch(url + "?after=0", {
      headers: { Authorization: `Bearer ${secret}` },
      signal: replayController.signal,
    });
    const reader = replay.body!.getReader(),
      decoder = new TextDecoder();
    let text = "";
    while (!text.includes("test.public")) {
      const chunk = await reader.read();
      if (chunk.done) break;
      text += decoder.decode(chunk.value);
    }
    assert.match(text, /test.public/);
    assert.ok(!text.includes("STAFF-ONLY-SYNTHETIC"));
  } finally {
    replayController.abort();
  }
});
