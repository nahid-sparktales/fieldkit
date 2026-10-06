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
import { defaultSlaPolicy } from "../packages/platform/src/sla-contracts.js";
import { uid } from "../packages/platform/src/db.js";
const config = testConfig(),
  providers = new TestProviders();
let now = new Date(),
  mails = 0;
const app = new Platform(config, {
  model: new TestModel(),
  fetch: providers.fetch,
  clock: () => now,
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
  now = new Date();
  mails = 0;
});
const send = (p: any, id: string, body: string, note = false) =>
  app.message(p, id, { body, requestKey: uid() }, note);
async function setup() {
  const ctx = await workspace(app),
    policy = defaultSlaPolicy();
  policy.enabled = true;
  policy.calendar.shifts = [1, 2, 3, 4, 5, 6, 7].map((day) => ({
    day,
    start: "00:00",
    end: "24:00",
  }));
  policy.rules[0] = {
    ...policy.rules[0],
    firstMinutes: 60,
    nextMinutes: 90,
    handoffMinutes: 30,
    warningMinutes: 10,
    escalateMinutes: 20,
  };
  await app.sla.save(ctx.owner, { revision: 0, policy });
  const c = await app.newConversation(ctx.customer, {
    channelId: ctx.channelId,
    subject: "SLA request",
    body: "I need support",
    requestKey: uid(),
  });
  await app.sla.advance(ctx.ws.id, c.id);
  return { ...ctx, c, policy };
}
test("defaults are disabled; policy access, future-only enrollment, revision and previews", async () => {
  const { owner, customer, ws, channelId } = await workspace(app);
  assert.equal((await app.sla.settings(owner)).policy.enabled, false);
  const conv = await app.newConversation(customer, {
    channelId,
    body: "Before SLA",
    requestKey: uid(),
  });
  assert.equal(
    (
      await app.db.rows(
        "SELECT * FROM sla_observations WHERE workspace_id=$1",
        [ws.id],
      )
    ).length,
    0,
  );
  await assert.rejects(
    () => app.sla.save(customer, { revision: 0, policy: defaultSlaPolicy() }),
    /administrator/,
  );
  const policy = defaultSlaPolicy();
  policy.enabled = true;
  await app.sla.save(owner, { revision: 0, policy });
  await app.sla.reconcile();
  assert.equal(
    (await app.sla.conversation(owner, conv.id)).obligations.length,
    0,
  );
  await assert.rejects(
    () => app.sla.save(owner, { revision: 0, policy }),
    /changed/,
  );
  assert.ok(
    app.sla.preview({ policy, start: "2026-10-02T16:00:00Z", minutes: 60 })
      .dueAt,
  );
  const other = await workspace(app);
  await assert.rejects(() => app.sla.conversation(other.owner, conv.id));
});
test("earliest unanswered anchor survives extra messages, notes and duplicate jobs; delivery satisfies once", async () => {
  const x = await setup(),
    first = (await app.sla.conversation(x.owner, x.c.id)).obligations[0];
  await send(x.customer, x.c.id, "More detail");
  await send(x.owner, x.c.id, "Private note", true);
  await Promise.all([
    app.sla.advance(x.ws.id, x.c.id),
    app.sla.advance(x.ws.id, x.c.id),
  ]);
  let rows = (await app.sla.conversation(x.owner, x.c.id)).obligations;
  assert.equal(rows.length, 1);
  assert.equal(+new Date(rows[0].due_at), +new Date(first.due_at));
  assert.equal(rows[0].state, "running");
  await send(x.owner, x.c.id, "Here is a real reply");
  await app.sla.advance(x.ws.id, x.c.id);
  rows = (await app.sla.conversation(x.owner, x.c.id)).obligations;
  assert.equal(rows[0].state, "satisfied");
  await send(x.customer, x.c.id, "One more question");
  await app.sla.advance(x.ws.id, x.c.id);
  assert.equal(
    (await app.sla.conversation(x.owner, x.c.id)).obligations.filter(
      (o) => o.kind === "next" && o.state === "running",
    ).length,
    1,
  );
});
test("warnings and downtime escalation are bounded; takeover adds human target and retains response", async () => {
  const x = await setup();
  let o = (await app.sla.conversation(x.owner, x.c.id)).obligations[0];
  now = new Date(+new Date(o.warning_at) + 1);
  await Promise.all([
    app.sla.tick(x.ws.id, x.c.id),
    app.sla.tick(x.ws.id, x.c.id),
  ]);
  assert.equal((await app.sla.dashboard(x.owner)).notifications.length, 1);
  now = new Date(+new Date(o.escalate_at) + 1);
  await app.sla.tick(x.ws.id, x.c.id);
  await app.sla.tick(x.ws.id, x.c.id);
  const d = await app.sla.dashboard(x.owner);
  assert.equal(d.notifications.length, 2);
  assert.equal(d.obligations[0].state, "breached");
  assert.equal(mails, 0);
  await app.control(x.owner, x.c.id, { mode: "human" });
  await app.sla.advance(x.ws.id, x.c.id);
  const timers = (await app.sla.conversation(x.owner, x.c.id)).obligations;
  assert.equal(timers.length, 2);
  assert.ok(timers.some((t) => t.kind === "first" && t.breached_at));
  assert.ok(timers.some((t) => t.kind === "handoff"));
  await app.sla.read(x.owner, d.notifications[0].id);
  assert.ok(
    (await app.sla.dashboard(x.owner)).notifications.find(
      (n) => n.id === d.notifications[0].id,
    )?.read_at,
  );
});
test("waiting needs delivered staff reply; follow-up is bounded and never satisfies SLA or becomes AI output", async () => {
  const x = await setup();
  await assert.rejects(
    () => app.sla.waiting(x.owner, x.c.id, { waiting: true }),
    /real staff response/,
  );
  x.policy.followup = {
    enabled: true,
    afterMinutes: 10,
    maxReminders: 1,
    template: "Do you still need help?",
  };
  await app.sla.save(x.owner, { revision: 1, policy: x.policy });
  await send(x.owner, x.c.id, "Here is the answer");
  await app.sla.advance(x.ws.id, x.c.id);
  const wait = await app.sla.waiting(x.owner, x.c.id, {
    waiting: true,
    allowReminder: true,
  });
  now = new Date(+new Date(wait!.due_at) + 1);
  await Promise.all([
    app.sla.tick(x.ws.id, x.c.id),
    app.sla.tick(x.ws.id, x.c.id),
  ]);
  const messages = await app.db.rows(
    "SELECT * FROM messages WHERE conversation_id=$1 AND role='reminder'",
    [x.c.id],
  );
  assert.equal(messages.length, 1);
  assert.equal(messages[0].body, "Do you still need help?");
  const timers = (await app.sla.conversation(x.owner, x.c.id)).obligations;
  assert.equal(timers.length, 1);
  assert.equal(timers[0].state, "satisfied");
  const email = await app.db.one(
    "SELECT * FROM ticket_emails WHERE message_id=$1",
    [messages[0].id],
  );
  assert.equal(email.status, "queued");
  await send(x.customer, x.c.id, "Yes, still broken");
  await app.ticketEmail.deliver(x.ws.id, email.id);
  assert.equal(mails, 0);
  assert.equal(
    (
      await app.db.one("SELECT status FROM ticket_emails WHERE id=$1", [
        email.id,
      ])
    ).status,
    "skipped",
  );
});
test("replies, takeover, disabled channel and policy edits suppress obsolete waiting work", async () => {
  for (const cause of ["reply", "takeover", "channel", "policy"]) {
    const x = await setup();
    x.policy.followup.enabled = true;
    x.policy.followup.afterMinutes = 1;
    await app.sla.save(x.owner, { revision: 1, policy: x.policy });
    await send(x.owner, x.c.id, "Please send more details");
    const w = await app.sla.waiting(x.owner, x.c.id, {
      waiting: true,
      allowReminder: true,
    });
    if (cause === "reply") await send(x.customer, x.c.id, "Here are details");
    if (cause === "takeover")
      await app.control(x.owner, x.c.id, { mode: "human" });
    if (cause === "channel")
      await app.db.pool.query(
        "UPDATE channels SET published=false WHERE id=$1",
        [x.channelId],
      );
    if (cause === "policy")
      await app.sla.save(x.owner, {
        revision: 2,
        policy: {
          ...x.policy,
          followup: { ...x.policy.followup, template: "Changed text" },
        },
      });
    now = new Date(+new Date(w!.due_at) + 1);
    await app.sla.tick(x.ws.id, x.c.id);
    assert.equal(
      (
        await app.db.rows(
          "SELECT * FROM messages WHERE conversation_id=$1 AND role='reminder'",
          [x.c.id],
        )
      ).length,
      0,
      cause,
    );
    assert.equal(
      (await app.sla.conversation(x.owner, x.c.id)).waiting?.status,
      "canceled",
      cause,
    );
  }
});
test("policy changes preserve active deadlines; explicit preview rebase retains breach; closure and reopen preserve cycles", async () => {
  const x = await setup(),
    first = (await app.sla.conversation(x.owner, x.c.id)).obligations[0];
  now = new Date(+new Date(first.due_at) + 1);
  await app.sla.tick(x.ws.id, x.c.id);
  x.policy.rules[0].firstMinutes = 120;
  await app.sla.save(x.owner, { revision: 1, policy: x.policy });
  assert.equal(
    +new Date(
      (await app.sla.conversation(x.owner, x.c.id)).obligations[0].due_at,
    ),
    +new Date(first.due_at),
  );
  const preview = await app.sla.recalculate(x.owner, { commit: false });
  assert.equal(preview.changes.length, 1);
  await assert.rejects(
    () => app.sla.recalculate(x.owner, { commit: true, previewHash: "wrong" }),
    /Preview/,
  );
  await app.sla.recalculate(x.owner, {
    commit: true,
    previewHash: preview.previewHash,
  });
  const changed = (await app.sla.conversation(x.owner, x.c.id)).obligations[0];
  assert.ok(changed.breached_at);
  assert.equal(changed.policy_revision, 2);
  await app.control(x.owner, x.c.id, { status: "resolved" });
  await app.sla.advance(x.ws.id, x.c.id);
  assert.equal(
    (await app.sla.conversation(x.owner, x.c.id)).obligations[0].state,
    "canceled",
  );
  await send(x.customer, x.c.id, "Reopened");
  await app.sla.advance(x.ws.id, x.c.id);
  assert.equal(
    (await app.sla.conversation(x.owner, x.c.id)).obligations.filter(
      (o) => !o.ended_at,
    ).length,
    1,
  );
  await app.deleteConversation(x.ws.id, x.c.id);
  assert.equal(
    (
      await app.db.rows(
        "SELECT * FROM sla_obligations WHERE conversation_id=$1",
        [x.c.id],
      )
    ).length,
    0,
  );
});

test("unauthorized waiting requests cannot process a pending timer or create notifications", async () => {
  const x = await setup();
  now = new Date(now.getTime() + 24 * 60 * 60000);
  const count = Number(
    (await app.db.one(
      "SELECT count(*) n FROM sla_notifications WHERE workspace_id=$1",
      [x.ws.id],
    ))!.n,
  );
  await assert.rejects(
    () => app.sla.waiting(x.customer, x.c.id, { waiting: true }),
    /Staff/,
  );
  assert.equal(
    Number(
      (await app.db.one(
        "SELECT count(*) n FROM sla_notifications WHERE workspace_id=$1",
        [x.ws.id],
      ))!.n,
    ),
    count,
  );
});

test("SLA observes only unseen messages, coalesces jobs, and still captures delayed delivery", async (t) => {
  const x = await setup();
  const prefix = uid();
  await app.db.pool.query(
    `INSERT INTO messages(id,workspace_id,conversation_id,role,body,request_key)
    SELECT $1||n,$2,$3,'customer','Synthetic historical question',$1||n FROM generate_series(1,100) n`,
    [prefix, x.ws.id, x.c.id],
  );
  const enqueue = t.mock.method(app.db, "enqueue");
  const one = t.mock.method(app.db, "one");
  await app.db.event(app.db.pool, x.ws.id, "conversation.synced", {}, x.c.id);
  assert.equal(
    enqueue.mock.callCount(),
    1,
    "one transactional wakeup covers all new observations",
  );
  const before = one.mock.callCount();
  await app.db.event(app.db.pool, x.ws.id, "conversation.synced", {}, x.c.id);
  assert.equal(
    one.mock.callCount() - before,
    5,
    "constant SLA, rollout authority and routing checks; no historical INSERT attempts",
  );
  const count = await app.db.one(
    "SELECT count(*)::int n FROM sla_observations WHERE workspace_id=$1 AND kind='customer'",
    [x.ws.id],
  );
  assert.equal(count!.n, 101);
  const replyId = uid();
  await app.db.pool.query(
    "INSERT INTO messages(id,workspace_id,conversation_id,role,body,request_key) VALUES($1,$2,$3,'staff','Queued reply',$1)",
    [replyId, x.ws.id, x.c.id],
  );
  await app.db.event(app.db.pool, x.ws.id, "conversation.synced", {}, x.c.id);
  assert.equal(
    await app.db.one("SELECT id FROM sla_observations WHERE origin=$1", [
      `response:${replyId}`,
    ]),
    undefined,
  );
  await app.db.pool.query(
    "UPDATE messages SET delivered_at=now() WHERE id=$1",
    [replyId],
  );
  await app.db.event(
    app.db.pool,
    x.ws.id,
    "response.delivered",
    { messageId: replyId },
    x.c.id,
  );
  assert.ok(
    await app.db.one("SELECT id FROM sla_observations WHERE origin=$1", [
      `response:${replyId}`,
    ]),
  );
});
