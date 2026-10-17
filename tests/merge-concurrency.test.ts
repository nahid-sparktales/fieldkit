import { before, after, test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { Platform } from "../packages/platform/src/platform.js";
import { uid, type Queryable } from "../packages/platform/src/db.js";
import {
  resetDatabase,
  testConfig,
  workspace,
  TestModel,
  TestProviders,
} from "./helpers.js";
const config = testConfig(4389);
let mailHook: () => Promise<void> = async () => {};
const app = new Platform(config, {
  model: new TestModel(),
  fetch: new TestProviders().fetch,
  mailer: () => mailHook(),
});
before(async () => {
  await resetDatabase(config.DATABASE_URL);
  await app.migrate();
});
after(() => app.close());
function signal() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
async function fixture() {
  const w = await workspace(app);
  const source = await app.newConversation(w.customer, {
      channelId: w.channelId,
      body: "Source history",
      requestKey: uid(),
    }),
    target = await app.newConversation(w.customer, {
      channelId: w.channelId,
      body: "Target history",
      requestKey: uid(),
    });
  return { ...w, source, target };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function row(id: string) {
  return (await app.db.one("SELECT * FROM conversations WHERE id=$1", [id]))!;
}
async function input(w: Fixture) {
  const s = await row(w.source.id),
    t = await row(w.target.id);
  return {
    targetId: t.id,
    sourceVersion: s.edit_version,
    targetVersion: t.edit_version,
    requestKey: uid(),
  };
}
/** Hold the first real workspace lock; observe the second caller attempting it before releasing. */
function lockBarrier(t: TestContext) {
  const acquired = signal(),
    release = signal(),
    secondAttempted = signal(),
    original = app.routing.lockWorkspace.bind(app.routing);
  let calls = 0;
  const mock = t.mock.method(
    app.routing,
    "lockWorkspace",
    async (q: Queryable, ws: string) => {
      const order = ++calls;
      if (order === 2) secondAttempted.resolve();
      await original(q, ws);
      if (order === 1) {
        acquired.resolve();
        await release.promise;
      }
    },
  );
  return {
    acquired: acquired.promise,
    secondAttempted: secondAttempted.promise,
    release: release.resolve,
    restore: () => mock.mock.restore(),
  };
}

test("merge wins the shared lock: concurrent customer reply follows the canonical alias without changing source evidence", async (t) => {
  const w = await fixture(),
    request = await input(w),
    before = await app.db.rows(
      "SELECT id,body FROM messages WHERE conversation_id=$1 ORDER BY id",
      [w.source.id],
    ),
    barrier = lockBarrier(t);
  const merge = app.ticketOperations.merge(w.owner, w.source.id, request);
  await barrier.acquired;
  const reply = app.message(w.customer, w.source.id, {
    body: "Reply arrived during merge",
    requestKey: uid(),
  });
  await barrier.secondAttempted;
  barrier.release();
  const [merged, message] = await Promise.all([merge, reply]);
  barrier.restore();
  assert.equal(merged.id, w.target.id);
  assert.equal(message.conversation_id, w.target.id);
  assert.equal((await row(w.source.id)).merged_into_id, w.target.id);
  assert.deepEqual(
    await app.db.rows(
      "SELECT id,body FROM messages WHERE conversation_id=$1 ORDER BY id",
      [w.source.id],
    ),
    before,
  );
  assert.equal(message.actor_contact_id, w.contactId);
});

test("customer reply wins the shared lock: stale merge preview is rejected and the source remains active", async (t) => {
  const w = await fixture(),
    request = await input(w),
    barrier = lockBarrier(t);
  const reply = app.message(w.customer, w.source.id, {
    body: "New source activity",
    requestKey: uid(),
  });
  await barrier.acquired;
  const merge = app.ticketOperations.merge(w.owner, w.source.id, request);
  const rejected = assert.rejects(merge, /changed|fresh merge preview/i);
  await barrier.secondAttempted;
  barrier.release();
  const message = await reply;
  await rejected;
  barrier.restore();
  assert.equal(message.conversation_id, w.source.id);
  assert.equal((await row(w.source.id)).merged_into_id, null);
  assert.equal((await row(w.source.id)).status, "open");
  assert.equal(
    await app.db.one("SELECT * FROM ticket_merges WHERE source_id=$1", [
      w.source.id,
    ]),
    undefined,
  );
});

for (const uncertain of [false, true])
  test(`claimed email ${uncertain ? "with unknown outcome remains fenced" : "blocks merge until provider acceptance"}`, async () => {
    const w = await fixture();
    await app.ticketEmail.configure(w.owner, {
      address: `support@${w.ws.id}.example.test`,
    });
    const message = await app.message(w.owner, w.source.id, {
        body: "Response being emailed",
        requestKey: uid(),
      }),
      email = (await app.db.one(
        "SELECT * FROM ticket_emails WHERE message_id=$1",
        [message.id],
      ))!,
      entered = signal(),
      release = signal();
    let attempts = 0;
    mailHook = async () => {
      attempts++;
      entered.resolve();
      await release.promise;
      if (uncertain) throw new Error("Synthetic SMTP outcome unknown");
    };
    const send = app.ticketEmail.deliver(w.ws.id, email.id);
    await entered.promise;
    assert.equal(
      (await app.db.one("SELECT status FROM ticket_emails WHERE id=$1", [
        email.id,
      ]))!.status,
      "sending",
    );
    await assert.rejects(
      app.ticketOperations.merge(w.owner, w.source.id, await input(w)),
      /queued, failed, or uncertain email/,
    );
    assert.equal((await row(w.source.id)).merged_into_id, null);
    release.resolve();
    await send;
    mailHook = async () => {};
    const state = (await app.db.one(
      "SELECT status FROM ticket_emails WHERE id=$1",
      [email.id],
    ))!.status;
    assert.equal(state, uncertain ? "unknown" : "sent");
    if (uncertain) {
      await assert.rejects(
        app.ticketOperations.merge(w.owner, w.source.id, await input(w)),
        /queued, failed, or uncertain email/,
      );
      await app.ticketEmail.deliver(w.ws.id, email.id);
      assert.equal(
        attempts,
        1,
        "Unknown delivery is not retried by merge or recovery",
      );
    } else {
      await app.ticketOperations.merge(w.owner, w.source.id, await input(w));
      assert.equal((await row(w.source.id)).merged_into_id, w.target.id);
      assert.equal(attempts, 1);
    }
    assert.equal(
      (await app.db.one("SELECT conversation_id FROM messages WHERE id=$1", [
        message.id,
      ]))!.conversation_id,
      w.source.id,
    );
  });

test("merge stales pending approvals, retains run checkpoints and merged source history through retention, then deletes the canonical group together", async () => {
  const w = await fixture(),
    actionId = uid();
  await app.db.pool.query(
    "INSERT INTO actions(id,workspace_id,name,description,kind) VALUES($1,$2,'fixture_refund','Fixture only','stripe_refund')",
    [actionId, w.ws.id],
  );
  const threads: string[] = [];
  for (const ticket of [w.source, w.target]) {
    const run = (await app.db.one(
      "SELECT id FROM runs WHERE conversation_id=$1 ORDER BY created_at LIMIT 1",
      [ticket.id],
    ))!;
    assert.ok(run);
    const thread = `${w.ws.id}:${run.id}`;
    threads.push(thread);
    await app.db.pool.query(
      "INSERT INTO approvals(id,workspace_id,run_id,action_id,proposal,hash) VALUES($1,$2,$3,$4,'{}','fixture-hash')",
      [uid(), w.ws.id, run.id, actionId],
    );
    await app.db.pool.query(
      "INSERT INTO checkpoints.checkpoints(thread_id,checkpoint_id,checkpoint,metadata) VALUES($1,$2,$3,$4)",
      [
        thread,
        uid(),
        { fixture: "Retained review evidence", runId: run.id },
        { source: "test" },
      ],
    );
  }
  const before = await app.db.rows(
    "SELECT * FROM checkpoints.checkpoints WHERE thread_id=ANY($1::text[]) ORDER BY thread_id",
    [threads],
  );
  await app.ticketOperations.merge(w.owner, w.source.id, await input(w));
  assert.deepEqual(
    (
      await app.db.rows(
        "SELECT status FROM approvals WHERE workspace_id=$1 ORDER BY id",
        [w.ws.id],
      )
    ).map((a) => a.status),
    ["stale", "stale"],
  );
  assert.deepEqual(
    await app.db.rows(
      "SELECT * FROM checkpoints.checkpoints WHERE thread_id=ANY($1::text[]) ORDER BY thread_id",
      [threads],
    ),
    before,
  );
  await app.db.pool.query(
    "UPDATE conversations SET updated_at=now()-interval '100 days' WHERE id=$1",
    [w.source.id],
  );
  await app.maintenance();
  assert.ok(await row(w.source.id));
  assert.equal((await row(w.target.id)).status, "open");
  await app.db.pool.query(
    "UPDATE conversations SET status='resolved',updated_at=now()-interval '100 days' WHERE id=$1",
    [w.target.id],
  );
  await app.maintenance();
  assert.equal(
    await app.db.one("SELECT id FROM conversations WHERE id=ANY($1::text[])", [
      [w.source.id, w.target.id],
    ]),
    undefined,
  );
  for (const thread of threads)
    assert.ok(
      await app.db.one(
        "SELECT id FROM jobs.job WHERE name='maintenance' AND data->'deleteThreads' ? $1",
        [thread],
      ),
    );
  assert.deepEqual(
    await app.db.rows(
      "SELECT * FROM checkpoints.checkpoints WHERE thread_id=ANY($1::text[]) ORDER BY thread_id",
      [threads],
    ),
    before,
    "Checkpoint deletion remains a durable post-commit job",
  );
});
