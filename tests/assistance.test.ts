import { test, before, after, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import { Platform } from "../packages/platform/src/platform.js";
import { Assistance } from "../packages/platform/src/assistance.js";
import {
  LiveModel,
  type FaqModelInput,
} from "../packages/platform/src/model.js";
import { Settings } from "../packages/platform/src/contracts.js";
import { uid } from "../packages/platform/src/db.js";
import {
  testConfig,
  resetDatabase,
  TestModel,
  TestProviders,
  workspace,
  knowledge,
} from "./helpers.js";

const config = testConfig(),
  model = new TestModel();
const app = new Platform(config, {
  model,
  fetch: new TestProviders().fetch,
  mailer: async () => {},
});
before(async () => {
  await resetDatabase(config.DATABASE_URL);
  await app.migrate();
});
after(() => app.close());
beforeEach(() => {
  model.fail = false;
  model.assistHook = undefined;
  model.faqHook = undefined;
});
const task = (id: string) =>
  app.db.one("SELECT * FROM assistance_tasks WHERE id=$1", [id]);
async function conversationFixture() {
  const w = await workspace(app);
  await knowledge(app, w.ws.id);
  const conv = await app.newConversation(w.customer, {
    body: "How can I return an unused item?",
    requestKey: uid(),
  });
  await app.control(w.owner, conv.id, { mode: "human" });
  return { ...w, conv };
}

test("whole-library FAQ review visits every chunk, checkpoints each batch and resumes without duplicate drafts", async () => {
  const w = await workspace(app),
    other = await workspace(app);
  for (const name of ["setup", "troubleshooting"]) {
    const source = await app.knowledge.upload(
      w.ws.id,
      `${name}.txt`,
      Buffer.from(
        Array.from(
          { length: 400 },
          (_, i) =>
            `${name} step ${i}: Open the help center and follow the documented settings. `,
        ).join("\n"),
      ),
    );
    await app.knowledge.ingest(w.ws.id, source.id);
    await app.db.pool.query(
      "UPDATE sources SET visibility='customer' WHERE id=$1",
      [source.id],
    );
  }
  await knowledge(app, other.ws.id);
  const hidden = await app.knowledge.upload(
    w.ws.id,
    "private.txt",
    Buffer.from("Internal secrets must not be used for customer FAQ drafts."),
  );
  await app.knowledge.ingest(w.ws.id, hidden.id);
  const expected = await app.db.rows(
    "SELECT c.id FROM chunks c JOIN documents d ON d.id=c.document_id JOIN sources s ON s.id=d.source_id WHERE c.workspace_id=$1 AND s.visibility='customer'",
    [w.ws.id],
  );
  assert.ok(expected.length > 16);
  const seen = new Set<string>();
  const replacement = mock.method(
    model,
    "faqs",
    async (input: FaqModelInput) => {
      assert.equal(input.workspaceId, w.ws.id);
      assert.ok(input.evidence.length <= 8);
      for (const e of input.evidence) {
        assert.notEqual(e.sourceId, hidden.id);
        seen.add(e.id);
      }
      return [
        {
          question: `What does passage ${input.evidence[0].id} explain?`,
          answer: input.evidence[0].excerpt.slice(0, 500),
          citationIds: [input.evidence[0].id],
        },
      ];
    },
  );
  try {
    const run = (await app.assistance.start(w.owner, { kind: "faq_review" }))!;
    assert.equal(run.document_count, 2);
    await assert.rejects(
      app.assistance.start(w.owner, { kind: "faq_review" }),
      /already running/,
    );
    const competing = await Promise.allSettled([
      app.assistance.advance(w.ws.id, run.id),
      app.assistance.advance(w.ws.id, run.id),
    ]);
    assert.equal(competing.filter((r) => r.status === "rejected").length, 1);
    assert.equal((await task(run.id))!.completed, 1);
    const resumed = new Assistance(app.db, app.knowledge, model, app.support);
    while ((await task(run.id))!.status === "queued")
      await resumed.advance(w.ws.id, run.id);
    const done = (await task(run.id))!;
    assert.equal(done.status, "completed", done.error);
    assert.equal(done.completed, done.total);
    assert.deepEqual([...seen].sort(), expected.map((e) => e.id).sort());
    const faqs = await app.db.rows(
      "SELECT * FROM sources WHERE workspace_id=$1 AND kind='faq'",
      [w.ws.id],
    );
    assert.equal(faqs.length, run.total);
    assert.ok(
      faqs.every(
        (f) =>
          f.visibility === "staff" &&
          f.status === "draft" &&
          f.metadata.reviewTaskId === run.id,
      ),
    );
    await resumed.advance(w.ws.id, run.id);
    assert.equal(replacement.mock.callCount(), run.total);
  } finally {
    replacement.mock.restore();
  }
});

test("FAQ review cancellation, model failure, retry and revoked approval never publish or save a late batch", async () => {
  const w = await workspace(app),
    source = await knowledge(app, w.ws.id);
  const run = (await app.assistance.start(w.owner, { kind: "faq_review" }))!;
  model.faqHook = async () => {
    await app.assistance.control(w.owner, run.id, "cancel");
  };
  await app.assistance.advance(w.ws.id, run.id);
  assert.equal((await task(run.id))!.status, "cancelled");
  assert.equal(
    (
      await app.db.rows(
        "SELECT id FROM sources WHERE workspace_id=$1 AND kind='faq'",
        [w.ws.id],
      )
    ).length,
    0,
  );
  model.faqHook = undefined;
  const retry = (await app.assistance.start(w.owner, { kind: "faq_review" }))!;
  model.fail = true;
  await app.assistance.advance(w.ws.id, retry.id);
  assert.equal((await task(retry.id))!.status, "failed");
  model.fail = false;
  await app.assistance.control(w.owner, retry.id, "retry");
  await app.assistance.advance(w.ws.id, retry.id);
  assert.equal((await task(retry.id))!.status, "completed");
  const revoked = (await app.assistance.start(w.owner, {
    kind: "faq_review",
  }))!;
  model.faqHook = async () => {
    await app.db.pool.query(
      "UPDATE sources SET visibility='staff',revision=revision+1 WHERE id=$1",
      [source.id],
    );
  };
  await app.assistance.advance(w.ws.id, revoked.id);
  assert.equal((await task(revoked.id))!.status, "failed");
  assert.equal((await task(revoked.id))!.completed, 0);
});

test("support workflows research internal sources, isolate customer replies, and apply triage or a private article only after review", async () => {
  const w = await conversationFixture();
  const internal = await app.knowledge.upload(
    w.ws.id,
    "internal.txt",
    Buffer.from(
      "Internal return troubleshooting: escalation routing is confidential.",
    ),
  );
  await app.knowledge.ingest(w.ws.id, internal.id);
  await app.message(
    w.owner,
    w.conv.id,
    { body: "Private diagnostic note", requestKey: uid() },
    true,
  );
  await assert.rejects(
    app.assistance.start(w.owner, {
      kind: "article",
      conversationId: w.conv.id,
    }),
    /Resolve/,
  );
  const initialMessages = (
    await app.db.rows("SELECT id FROM messages WHERE conversation_id=$1", [
      w.conv.id,
    ])
  ).length;
  for (const kind of [
    "triage",
    "research",
    "response",
    "escalation",
  ] as const) {
    model.assistHook = async (input) => {
      if (kind === "response") {
        assert.ok(!input.evidence.some((e) => e.sourceId === internal.id));
        assert.ok(!input.messages.some((m) => m.role === "note"));
      } else {
        assert.ok(input.evidence.some((e) => e.sourceId === internal.id));
        assert.ok(input.messages.some((m) => m.role === "note"));
      }
    };
    const run = (await app.assistance.start(w.owner, {
      kind,
      conversationId: w.conv.id,
    }))!;
    await app.assistance.advance(w.ws.id, run.id);
    const done = (await task(run.id))!;
    assert.equal(done.status, "completed", done.error);
    assert.ok(done.output.citations.length);
    if (["research", "response", "escalation"].includes(kind)) {
      const composed = await app.assistance.compose(w.owner, run.id, {
        body: done.output.draft.body,
      });
      assert.equal(composed.internal, kind !== "response");
    }
    if (kind === "triage") {
      const { title, body, priority, category } = done.output.draft;
      await app.assistance.apply(w.owner, run.id, {
        title,
        body,
        priority,
        category,
      });
      const conv = (await app.db.one(
        "SELECT * FROM conversations WHERE id=$1",
        [w.conv.id],
      ))!;
      assert.equal(conv.priority, "high");
      assert.equal(conv.category, "returns");
      await app.assistance.apply(w.owner, run.id, {
        title,
        body,
        priority,
        category,
      });
    }
  }
  assert.equal(
    (
      await app.db.rows("SELECT id FROM messages WHERE conversation_id=$1", [
        w.conv.id,
      ])
    ).length,
    initialMessages,
  );
  model.assistHook = undefined;
  await app.control(w.owner, w.conv.id, { status: "resolved" });
  const article = (await app.assistance.start(w.owner, {
    kind: "article",
    conversationId: w.conv.id,
  }))!;
  await app.assistance.advance(w.ws.id, article.id);
  const done = (await task(article.id))!;
  assert.equal(done.status, "completed", done.error);
  const { title, body, priority, category } = done.output.draft;
  const saved = await app.assistance.apply(w.owner, article.id, {
    title,
    body,
    priority,
    category,
  });
  assert.ok(saved.sourceId);
  assert.equal(
    (
      await app.assistance.apply(w.owner, article.id, {
        title,
        body,
        priority,
        category,
      })
    ).sourceId,
    saved.sourceId,
  );
  await app.knowledge.ingest(w.ws.id, saved.sourceId);
  const source = (await app.db.one("SELECT * FROM sources WHERE id=$1", [
    saved.sourceId,
  ]))!;
  assert.equal(source.kind, "article");
  assert.equal(source.visibility, "staff");
  assert.equal(source.status, "ready");
  assert.equal(
    (await app.db.one("SELECT published FROM documents WHERE source_id=$1", [
      saved.sourceId,
    ]))!.published,
    false,
  );
});

test("workflows reject other tenants, lost roles, stale conversations and fabricated evidence", async () => {
  const w = await conversationFixture(),
    other = await workspace(app);
  await assert.rejects(
    app.assistance.start(other.owner, {
      kind: "research",
      conversationId: w.conv.id,
    }),
    /Not found/,
  );
  await assert.rejects(
    app.assistance.start(w.customer, {
      kind: "research",
      conversationId: w.conv.id,
    }),
    /Staff/,
  );
  await assert.rejects(
    app.assistance.start({ ...w.owner, role: "agent" }, { kind: "faq_review" }),
    /administrator/,
  );
  const stale = (await app.assistance.start(w.owner, {
    kind: "response",
    conversationId: w.conv.id,
  }))!;
  model.assistHook = async () => {
    await app.message(
      w.owner,
      w.conv.id,
      { body: "New detail", requestKey: uid() },
      true,
    );
  };
  await app.assistance.advance(w.ws.id, stale.id);
  assert.equal((await task(stale.id))!.status, "failed");
  assert.match((await task(stale.id))!.error, /conversation changed/i);
  model.assistHook = undefined;
  const invalid = (await app.assistance.start(w.owner, {
    kind: "research",
    conversationId: w.conv.id,
  }))!;
  const replace = mock.method(model, "assist", async () => ({
    title: "Invented",
    body: "No source",
    priority: "normal" as const,
    category: "",
    reason: "",
    citationIds: ["forged"],
    gaps: [],
  }));
  try {
    await app.assistance.advance(w.ws.id, invalid.id);
    assert.equal((await task(invalid.id))!.status, "failed");
  } finally {
    replace.mock.restore();
  }
  const lost = (await app.assistance.start(w.owner, { kind: "faq_review" }))!;
  await app.db.pool.query(
    "UPDATE memberships SET role='agent' WHERE workspace_id=$1",
    [w.ws.id],
  );
  await app.assistance.advance(w.ws.id, lost.id);
  assert.equal((await task(lost.id))!.status, "failed");
  assert.match((await task(lost.id))!.error, /required access/);
  await assert.rejects(
    app.assistance.control(other.owner, lost.id, "retry"),
    /Not found/,
  );
});

test("reviewed triage stays tied to conversation and evidence; Zendesk priority is queued without unrelated writes", async () => {
  const w = await conversationFixture();
  let run = (await app.assistance.start(w.owner, {
    kind: "triage",
    conversationId: w.conv.id,
  }))!;
  await app.assistance.advance(w.ws.id, run.id);
  let done = (await task(run.id))!;
  const fields = (d: any) => ({
    title: d.title,
    body: d.body,
    priority: d.priority,
    category: d.category,
  });
  await app.control(w.owner, w.conv.id, { mode: "human" });
  await assert.rejects(
    app.assistance.apply(w.owner, run.id, fields(done.output.draft)),
    /conversation changed/,
  );
  await app.db.pool.query(
    "UPDATE conversations SET external_id='11' WHERE id=$1",
    [w.conv.id],
  );
  run = (await app.assistance.start(w.owner, {
    kind: "triage",
    conversationId: w.conv.id,
  }))!;
  await app.assistance.advance(w.ws.id, run.id);
  done = (await task(run.id))!;
  await app.assistance.apply(w.owner, run.id, fields(done.output.draft));
  const deliveries = await app.db.rows(
    "SELECT payload FROM deliveries WHERE conversation_id=$1",
    [w.conv.id],
  );
  assert.deepEqual(
    deliveries.map((d) => d.payload),
    [{ priority: "high" }],
  );
});

test("using a completed reply rechecks document visibility and does not send a message", async () => {
  const w = await conversationFixture();
  const run = (await app.assistance.start(w.owner, {
    kind: "response",
    conversationId: w.conv.id,
  }))!;
  await app.assistance.advance(w.ws.id, run.id);
  const done = (await task(run.id))!;
  assert.equal(done.status, "completed", done.error);
  await app.db.pool.query(
    "UPDATE sources SET visibility='staff' WHERE workspace_id=$1",
    [w.ws.id],
  );
  await assert.rejects(
    app.assistance.compose(w.owner, run.id, { body: done.output.draft.body }),
    /Knowledge access changed/,
  );
  assert.equal(
    (
      await app.db.rows(
        "SELECT id FROM messages WHERE conversation_id=$1 AND role='staff'",
        [w.conv.id],
      )
    ).length,
    0,
  );
});

test("live support adapter uses structured output, bounded calls and actual token accounting", async () => {
  const w = await workspace(app),
    live = new LiveModel(app.db, app.connections);
  let calls = 0;
  const replacement = mock.method(live as any, "client", async () => ({
    responses: {
      parse: async (input: any) => {
        calls++;
        assert.equal(input.store, false);
        assert.equal(input.max_output_tokens, 4000);
        assert.ok(input.text.format);
        return {
          output_parsed: {
            title: "Triage",
            body: "Need order details.",
            priority: "normal",
            category: "returns",
            reason: "Insufficient impact information.",
            citationIds: ["message-id"],
            gaps: ["Order details"],
          },
          usage: { input_tokens: 123, output_tokens: 45 },
        };
      },
    },
  }));
  const input = {
    workspaceId: w.ws.id,
    model: "gpt-5.4-mini",
    kind: "triage" as const,
    subject: "Return",
    messages: [
      { id: "message-id", role: "customer", body: "Can I return this?" },
    ],
    evidence: [],
    instructions: "",
  };
  try {
    await live.assist(input);
    assert.deepEqual(
      await app.db.one(
        "SELECT input_tokens,output_tokens,reserved FROM usage WHERE workspace_id=$1",
        [w.ws.id],
      ),
      { input_tokens: 123, output_tokens: 45, reserved: 0 },
    );
    await app.db.pool.query("UPDATE workspaces SET settings=$2 WHERE id=$1", [
      w.ws.id,
      Settings.parse({ monthlyTokenBudget: 1000 }),
    ]);
    await assert.rejects(live.assist(input), /budget/);
    assert.equal(calls, 1);
  } finally {
    replacement.mock.restore();
  }
});
