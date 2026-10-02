import { before, after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { Platform } from "../packages/platform/src/platform.js";
import { LiveModel, type ModelInput } from "../packages/platform/src/model.js";
import { Connections } from "../packages/platform/src/connections.js";
import {
  MODEL_PROVIDERS,
  type ModelProviderId,
} from "../packages/platform/src/model-providers.js";
import { Settings } from "../packages/platform/src/contracts.js";
import {
  modelBaseURL,
  modelFetch,
  safeFetch,
  type Fetcher,
} from "../packages/platform/src/security.js";
import { uid } from "../packages/platform/src/db.js";
import {
  testConfig,
  resetDatabase,
  TestModel,
  workspace,
  knowledge,
} from "./helpers.js";

const requests: { url: string; body: any; headers: any }[] = [];
let invalid = false,
  invalidShape = false,
  truncated = false,
  missingUsage = false,
  wrongDimensions = false;
const fetcher: Fetcher = async (url, init = {}) => {
  const body = init.body ? JSON.parse(init.body) : null;
  requests.push({ url, body, headers: init.headers });
  if (url.endsWith("/key"))
    return Response.json({ data: { label: "Synthetic test key" } });
  if (url.endsWith("/models"))
    return Response.json({
      data: [{ id: "test-chat" }, { id: "test-embedding" }],
    });
  if (url.endsWith("/embeddings"))
    return Response.json({
      data: body.input.map((_: string, index: number) => ({
        index,
        embedding: Array.from(
          { length: wrongDimensions ? 3 : body.dimensions },
          (_, i) => (i === 0 ? 1 : 0),
        ),
      })),
      usage: { prompt_tokens: 11, total_tokens: 11 },
    });
  const native = url.endsWith("/messages");
  const schema = native
    ? body.output_config.format.schema
    : body.response_format.json_schema?.schema;
  let value: any = {
    intent: "clarify",
    answer: "Which product do you need help with?",
    citationIds: [],
    actionName: null,
    parametersJson: "{}",
    reason: "More context is needed",
  };
  if (schema?.properties.faqs)
    value = {
      faqs: [
        {
          question: "How do I ask for help?",
          answer: "Open a support ticket.",
          citationIds: [],
        },
      ],
    };
  if (schema?.properties.priority)
    value = {
      title: "Support request",
      body: "Ask for the product name.",
      priority: "normal",
      category: "general",
      reason: "More context is needed",
      citationIds: ["message-1"],
      gaps: ["Product name"],
    };
  const content = invalid
    ? "not valid JSON"
    : JSON.stringify(invalidShape ? {} : value);
  return Response.json(
    native
      ? {
          content: [{ type: "text", text: content }],
          stop_reason: truncated ? "max_tokens" : "end_turn",
          ...(!missingUsage
            ? {
                usage: {
                  input_tokens: 11,
                  cache_creation_input_tokens: 2,
                  cache_read_input_tokens: 3,
                  output_tokens: 7,
                },
              }
            : {}),
        }
      : {
          choices: [
            {
              finish_reason: truncated ? "length" : "stop",
              message: { content },
            },
          ],
          ...(!missingUsage
            ? { usage: { prompt_tokens: 11, completion_tokens: 7 } }
            : {}),
        },
  );
};
const c = testConfig(),
  app = new Platform(c, {
    model: new TestModel(),
    fetch: fetcher,
    mailer: async () => {},
  }),
  live = new LiveModel(app.db, app.connections);
before(async () => {
  await resetDatabase(c.DATABASE_URL);
  await app.migrate();
});
after(() => app.close());
beforeEach(() => {
  requests.length = 0;
  invalid = false;
  invalidShape = false;
  truncated = false;
  missingUsage = false;
  wrongDimensions = false;
});
const input = (ws: string): ModelInput => ({
  workspaceId: ws,
  runId: uid(),
  model: "test-chat",
  instructions: "Help with support",
  messages: [{ role: "customer", body: "Help" }],
  evidence: [],
  actions: [],
  account: null,
});
async function connect(ws: string, provider: ModelProviderId) {
  return app.connections.connectKey(ws, provider, "nonfunctional-test-key", {
    model: "test-chat",
    ...(!MODEL_PROVIDERS[provider].baseUrl
      ? { baseUrl: "https://models.example.test/v1" }
      : {}),
  });
}
async function select(ws: string, provider: ModelProviderId) {
  const old = (await app.db.one("SELECT settings FROM workspaces WHERE id=$1", [
    ws,
  ]))!.settings;
  return app.connections.updateSettings(ws, {
    ...old,
    responseProvider: provider,
    model: "test-chat",
  });
}

test("Claude, Kimi, OpenRouter, DeepSeek, vLLM and compatible providers validate connections and generate schema-checked replies", async () => {
  for (const provider of [
    "anthropic",
    "kimi",
    "openrouter",
    "deepseek",
    "vllm",
    "openai_compatible",
  ] as const) {
    const w = await workspace(app);
    const connected = await connect(w.ws.id, provider);
    assert.equal(connected.secret, undefined);
    assert.deepEqual(connected.metadata.models, [
      "test-chat",
      "test-embedding",
    ]);
    await select(w.ws.id, provider);
    const result = await live.answer(input(w.ws.id));
    assert.equal(result.intent, "clarify");
    assert.deepEqual(result.parameters, {});
    assert.equal("parametersJson" in result, false);
    const usage = (await app.db.one(
      "SELECT * FROM usage WHERE workspace_id=$1",
      [w.ws.id],
    ))!;
    assert.equal(usage.provider, provider);
    assert.equal(usage.reserved, 0);
    assert.equal(usage.input_tokens, provider === "anthropic" ? 16 : 11);
    assert.equal(usage.output_tokens, 7);
    const request = requests.at(-1)!;
    if (provider === "anthropic") {
      assert.equal(request.headers["anthropic-version"], "2023-06-01");
      assert.equal(request.body.output_config.format.type, "json_schema");
      assert.equal(request.body.max_tokens, 3000);
    } else {
      assert.equal(
        request.body.response_format.type,
        ["kimi", "deepseek"].includes(provider) ? "json_object" : "json_schema",
      );
      assert.ok(request.body.messages[0].content.includes("untrusted data"));
      if (provider === "kimi") assert.equal(request.body.thinking, undefined);
      if (provider === "openrouter")
        assert.equal(request.body.provider.require_parameters, true);
    }
  }
});

test("provider selection also powers FAQ drafting and staff assistance, and workflow overrides stay explicit", async () => {
  const w = await workspace(app);
  for (const provider of ["anthropic", "openrouter"] as const) {
    await connect(w.ws.id, provider);
    await select(w.ws.id, provider);
    const faqInput = {
      workspaceId: w.ws.id,
      model: "test-chat",
      count: 1,
      instructions: "",
      question: "How do I ask for help?",
      answer: "Open a support ticket.",
      evidence: [],
      existingQuestions: [],
    };
    const faqs = await live.faqs(faqInput);
    assert.equal(faqs.length, 1);
    const assistanceInput = {
      workspaceId: w.ws.id,
      model: "test-chat",
      kind: "escalation" as const,
      subject: "Help",
      messages: [{ id: "message-1", role: "customer", body: "Help" }],
      evidence: [],
      instructions: "",
    };
    const draft = await live.assist(assistanceInput);
    assert.deepEqual(draft.citationIds, ["message-1"]);
    invalidShape = true;
    await assert.rejects(live.faqs(faqInput), { name: "ZodError" });
    await assert.rejects(live.assist(assistanceInput), { name: "ZodError" });
    invalidShape = false;
  }
  const usage = await app.db.rows(
    "SELECT input_tokens,output_tokens FROM usage WHERE workspace_id=$1 AND kind IN ('faq','escalation')",
    [w.ws.id],
  );
  assert.equal(usage.length, 8);
  assert.ok(usage.every((u) => u.input_tokens > 0 && u.output_tokens > 0));
  await live.answer({ ...input(w.ws.id), provider: "anthropic" });
  assert.ok(requests.at(-1)!.url.startsWith("https://api.anthropic.com/"));
  assert.equal(
    (await app.db.one("SELECT settings FROM workspaces WHERE id=$1", [
      w.ws.id,
    ]))!.settings.responseProvider,
    "openrouter",
  );
  await app.connections.disconnect(w.ws.id, "openai");
  const conversation = await app.newConversation(w.customer, {
    body: "I need help with a return.",
    requestKey: uid(),
  });
  const task = await app.assistance.start(w.owner, {
    kind: "triage",
    conversationId: conversation.id,
  });
  assert.equal(task!.status, "queued");
});

test("invalid and truncated output records reported usage; absent usage keeps a budget reservation; no provider fallback occurs", async () => {
  const w = await workspace(app);
  await connect(w.ws.id, "anthropic");
  await select(w.ws.id, "anthropic");
  invalid = true;
  await assert.rejects(live.answer(input(w.ws.id)), /invalid JSON/);
  invalid = false;
  truncated = true;
  await assert.rejects(
    live.answer(input(w.ws.id)),
    /no complete structured result/,
  );
  assert.equal(
    (await app.db.one(
      "SELECT sum(input_tokens+output_tokens)::int n FROM usage WHERE workspace_id=$1",
      [w.ws.id],
    ))!.n,
    46,
  );
  truncated = false;
  missingUsage = true;
  await live.answer(input(w.ws.id));
  assert.ok(
    Number(
      (await app.db.one(
        "SELECT sum(reserved) n FROM usage WHERE workspace_id=$1",
        [w.ws.id],
      ))!.n,
    ) > 0,
  );
  await app.connections.updateSettings(
    w.ws.id,
    Settings.parse({
      responseProvider: "anthropic",
      model: "test-chat",
      monthlyTokenBudget: 1000,
    }),
  );
  const before = requests.length;
  await assert.rejects(live.answer(input(w.ws.id)), /budget/);
  assert.equal(requests.length, before);
  assert.ok(requests.every((r) => !r.url.includes("api.openai.com")));
});

test("embedding providers return exact dimensions and never mix incompatible vectors; settings changes rebuild unchanged documents", async () => {
  const w = await workspace(app),
    source = await knowledge(app, w.ws.id);
  await app.db.pool.query(
    "UPDATE documents SET published=true WHERE source_id=$1",
    [source.id],
  );
  await connect(w.ws.id, "openrouter");
  const old = (await app.db.one("SELECT settings FROM workspaces WHERE id=$1", [
    w.ws.id,
  ]))!.settings;
  await app.connections.updateSettings(w.ws.id, {
    ...old,
    embeddingProvider: "openrouter",
    embeddingModel: "test-embedding",
    embeddingDimensions: 64,
  });
  assert.equal(
    (await app.db.one("SELECT status FROM sources WHERE id=$1", [source.id]))!
      .status,
    "queued",
  );
  const priorModel = app.knowledge.model;
  app.knowledge.model = live;
  try {
    assert.deepEqual(await app.knowledge.retrieve(w.ws.id, "returns"), []);
    await app.knowledge.ingest(w.ws.id, source.id);
    const evidence = await app.knowledge.retrieve(w.ws.id, "returns");
    assert.equal(evidence.length, 1);
    assert.equal(evidence[0].version, 2);
    const doc = (await app.db.one(
      "SELECT * FROM documents WHERE source_id=$1 AND active",
      [source.id],
    ))!;
    assert.equal(doc.published, true);
    const config = await app.connections.embeddingConfig(w.ws.id);
    assert.equal(
      (await app.db.one(
        "SELECT vector_dims(embedding) n FROM chunks WHERE document_id=$1",
        [doc.id],
      ))!.n,
      64,
    );
    await app.connections.updateSettings(w.ws.id, {
      ...old,
      embeddingProvider: "openrouter",
      embeddingModel: "test-embedding",
      embeddingDimensions: 32,
    });
    await assert.rejects(
      live.embed(w.ws.id, ["test"], config),
      /settings changed/,
    );
    wrongDimensions = true;
    await assert.rejects(live.embed(w.ws.id, ["test"]), /dimensions/);
  } finally {
    app.knowledge.model = priorModel;
  }
});

test("bad model IDs and custom URLs cannot bypass credential checks or replace fixed provider destinations", async () => {
  const w = await workspace(app);
  await assert.rejects(
    app.connections.connectKey(w.ws.id, "anthropic", "fake-key-value", {
      model: "unavailable",
    }),
    /not available/,
  );
  await assert.rejects(
    app.connections.connectKey(w.ws.id, "openai", "fake-key-value", {
      baseUrl: "https://other.example/v1",
    }),
    /custom model endpoint/,
  );
  for (const raw of [
    "http://127.0.0.1:8000/v1",
    "https://127.0.0.1/v1",
    "https://example.com/v1?key=secret",
    "https://user:password@example.com/v1",
  ])
    assert.throws(() => modelBaseURL(raw, ""));
  await assert.rejects(
    app.connections.connectKey(w.ws.id, "vllm", "", {
      baseUrl: "http://127.0.0.1:8000/v1",
    }),
  );
  assert.equal(
    (await app.db.one(
      "SELECT count(*)::int n FROM connections WHERE workspace_id=$1 AND provider='vllm'",
      [w.ws.id],
    ))!.n,
    0,
  );
});

test("operator-approved local vLLM transport works without opening private-network access for other features or redirects", async () => {
  const seen: string[] = [];
  const server = createServer((req, res) => {
    seen.push(req.url!);
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/v1/models")
      res.end(JSON.stringify({ data: [{ id: "test-chat" }] }));
    else {
      res.writeHead(302, { Location: "http://127.0.0.1:1/private" });
      res.end("{}");
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as any).port}/v1`;
  const old = c.FIELDKIT_MODEL_ENDPOINTS;
  c.FIELDKIT_MODEL_ENDPOINTS = base;
  try {
    const w = await workspace(app),
      connection = new Connections(app.db);
    await connection.connectKey(w.ws.id, "vllm", "", {
      baseUrl: base,
      model: "test-chat",
    });
    await assert.rejects(
      connection.modelRequest(
        "vllm",
        "",
        { baseUrl: base },
        "/chat/completions",
        { model: "test-chat" },
      ),
      /HTTP 302/,
    );
    await assert.rejects(
      modelFetch(base, "/../private", {}, base),
      /Unsupported/,
    );
    await assert.rejects(safeFetch(base + "/models"), /HTTPS/);
    assert.deepEqual(seen, ["/v1/models", "/v1/chat/completions"]);
  } finally {
    c.FIELDKIT_MODEL_ENDPOINTS = old;
    await new Promise<void>((r) => server.close(() => r()));
  }
});
