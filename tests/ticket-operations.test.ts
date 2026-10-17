import { setInboxRead } from "../packages/platform/src/inbox-read.js";
import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { Platform } from "../packages/platform/src/platform.js";
import { conversation, type Principal } from "../packages/platform/src/auth.js";
import { uid } from "../packages/platform/src/db.js";
import {
  resetDatabase,
  testConfig,
  workspace,
  TestModel,
  TestProviders,
} from "./helpers.js";
const c = testConfig();
let now = new Date();
const app = new Platform(c, {
  clock: () => now,
  model: new TestModel(),
  fetch: new TestProviders().fetch,
  mailer: async () => {},
});
before(async () => {
  await resetDatabase(c.DATABASE_URL);
  await app.migrate();
});
after(() => app.close());
async function fixture() {
  const w = await workspace(app);
  const ticket = async (body = "Help with my order") =>
    app.newConversation(w.customer, { body, requestKey: uid() });
  return { ...w, ticket };
}
async function row(id: string) {
  return (await app.db.one("SELECT * FROM conversations WHERE id=$1", [id]))!;
}
test("edit and reply versions stay separate from AI revisions; duplicate retries survive later edits", async () => {
  const w = await fixture(),
    t = await w.ticket(),
    initial = await row(t.id);
  assert.equal(t.edit_version, initial.edit_version);
  await app.message(
    w.owner,
    t.id,
    { body: "Internal", requestKey: uid() },
    true,
  );
  const noted = await row(t.id);
  assert(noted.edit_version > initial.edit_version);
  assert.equal(noted.reply_version, initial.reply_version);
  const request = {
    body: "A public response",
    requestKey: uid(),
    expectedReplyRevision: noted.reply_version,
  };
  const message = await app.message(w.owner, t.id, request);
  await app.control(w.owner, t.id, { priority: "high" });
  assert.equal((await app.message(w.owner, t.id, request)).id, message.id);
  await assert.rejects(
    app.message(w.owner, t.id, { ...request, requestKey: uid() }),
    /new public|changed|review/i,
  );
});
test("simultaneous staff sends preserve one draft through reply-state conflict", async () => {
  const w = await fixture(),
    t = await w.ticket();
  const replies = await Promise.allSettled(
    [1, 2].map((n) =>
      app.message(w.owner, t.id, {
        body: `reply ${n}`,
        requestKey: uid(),
        expectedReplyRevision: t.reply_version,
      }),
    ),
  );
  assert.equal(replies.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(replies.filter((r) => r.status === "rejected").length, 1);
});
test("bulk actions retain per-ticket outcomes, reject stale edits, and replay original results", async () => {
  const w = await fixture(),
    a = await w.ticket(),
    b = await w.ticket();
  await app.control(w.owner, b.id, { priority: "urgent" });
  const request = {
    requestKey: uid(),
    action: { kind: "priority", priority: "high" },
    tickets: [
      { id: a.id, expectedEditVersion: a.edit_version },
      { id: b.id, expectedEditVersion: b.edit_version },
      { id: uid(), expectedEditVersion: 1 },
    ],
  };
  const result = await app.ticketOperations.bulk(w.owner, request);
  assert.deepEqual(result.items.map((i) => i.status).sort(), [
    "conflict",
    "unavailable",
    "updated",
  ]);
  await app.control(w.owner, a.id, { priority: "low" });
  assert.deepEqual(await app.ticketOperations.bulk(w.owner, request), result);
  assert.equal((await row(a.id)).priority, "low");
  await assert.rejects(
    app.ticketOperations.bulk(w.owner, {
      ...request,
      action: { kind: "status", status: "resolved" },
    }),
    /different batch/,
  );
  await assert.rejects(
    app.ticketOperations.bulk(w.owner, {
      ...request,
      requestKey: uid(),
      tickets: Array.from({ length: 41 }, () => ({
        id: uid(),
        expectedEditVersion: 1,
      })),
    }),
  );
});
test("bulk work rechecks authority between tickets and never touches a revoked actor's ticket", async () => {
  const w = await fixture(),
    t = await w.ticket(),
    batch = uid();
  await app.db.pool.query(
    "INSERT INTO ticket_batches(id,workspace_id,actor_id,request_key,payload_hash,action) VALUES($1,$2,$3,$4,'fixture',$5)",
    [
      batch,
      w.ws.id,
      w.owner.userId,
      uid(),
      { kind: "status", status: "resolved" },
    ],
  );
  await app.db.pool.query(
    "INSERT INTO ticket_batch_items(batch_id,conversation_id,expected_version) VALUES($1,$2,$3)",
    [batch, t.id, t.edit_version],
  );
  await app.db.pool.query(
    "DELETE FROM memberships WHERE workspace_id=$1 AND user_id=$2",
    [w.ws.id, w.owner.userId],
  );
  await Promise.all([
    app.ticketOperations.advance(w.ws.id, batch),
    app.ticketOperations.advance(w.ws.id, batch),
  ]);
  assert.equal((await row(t.id)).status, "open");
  assert.equal(
    (
      await app.db.one(
        "SELECT status FROM ticket_batch_items WHERE batch_id=$1",
        [batch],
      )
    )?.status,
    "unavailable",
  );
});
test("merge retains source history and receipts, uses canonical authorization, and preserves target properties", async () => {
  const w = await fixture(),
    s = await w.ticket("duplicate"),
    t = await w.ticket("keep this");
  const originalMessage = (await app.db.one(
    "SELECT * FROM messages WHERE conversation_id=$1",
    [s.id],
  ))!;
  await app.control(w.owner, t.id, { priority: "urgent", tags: ["keep"] });
  const preview = await app.ticketOperations.preview(w.owner, s.id, t.id);
  const request = {
    targetId: t.id,
    sourceVersion: preview.source.editVersion,
    targetVersion: preview.target.editVersion,
    requestKey: uid(),
  };
  await app.ticketOperations.merge(w.owner, s.id, request);
  assert.equal((await row(s.id)).merged_into_id, t.id);
  assert.equal((await row(t.id)).priority, "urgent");
  assert.equal((await row(t.id)).mode, "human");
  assert.equal((await conversation(app.db, w.customer, s.id)).id, t.id);
  assert.equal(
    (
      await app.message(w.customer, s.id, {
        body: originalMessage.body,
        requestKey: originalMessage.request_key,
      })
    ).id,
    originalMessage.id,
  );
  const reply = await app.message(w.customer, s.id, {
    body: "continuing from old link",
    requestKey: uid(),
  });
  assert.equal(reply.conversation_id, t.id);
  assert.equal(
    (
      await app.db.one("SELECT conversation_id FROM messages WHERE id=$1", [
        originalMessage.id,
      ])
    )?.conversation_id,
    s.id,
  );
  assert.deepEqual(await app.ticketOperations.merge(w.owner, s.id, request), {
    id: t.id,
    merged: true,
  });
  const inbox = await app.customers.inbox(w.owner, {});
  assert(!inbox.conversations.some((r: any) => r.id === s.id));
  await app.deleteConversation(w.ws.id, t.id);
  assert.equal(
    await app.db.one("SELECT id FROM conversations WHERE id=ANY($1::text[])", [
      [s.id, t.id],
    ]),
    undefined,
  );
});
test("merge rejects different requesters, changed previews, audiences, and uncertain delivery", async () => {
  const w = await fixture(),
    s = await w.ticket(),
    t = await w.ticket();
  const p = await app.ticketOperations.preview(w.owner, s.id, t.id);
  await app.control(w.owner, s.id, { priority: "high" });
  await assert.rejects(
    app.ticketOperations.merge(w.owner, s.id, {
      targetId: t.id,
      sourceVersion: p.source.editVersion,
      targetVersion: p.target.editVersion,
      requestKey: uid(),
    }),
    /changed/,
  );
  await app.db.pool.query(
    "INSERT INTO ticket_participants(id,workspace_id,conversation_id,email,added_by,contact_id) VALUES($1,$2,$3,'approved@example.test',$4,$5)",
    [uid(), w.ws.id, s.id, w.owner.userId, w.contactId],
  );
  await assert.rejects(
    app.ticketOperations.preview(w.owner, s.id, t.id),
    /same approved participants/,
  );
  await app.db.pool.query(
    "DELETE FROM ticket_participants WHERE conversation_id=$1",
    [s.id],
  );
  const message = (await app.db.one(
    "SELECT id FROM messages WHERE conversation_id=$1",
    [s.id],
  ))!;
  await app.db.pool.query(
    "INSERT INTO ticket_emails(id,workspace_id,conversation_id,message_id,status) VALUES($1,$2,$3,$4,'unknown')",
    [uid(), w.ws.id, s.id, message.id],
  );
  await assert.rejects(
    app.ticketOperations.preview(w.owner, s.id, t.id),
    /uncertain email/,
  );
  await app.db.pool.query(
    "DELETE FROM ticket_emails WHERE conversation_id=$1",
    [s.id],
  );
  const other = uid();
  await app.db.pool.query(
    "INSERT INTO contacts(id,workspace_id,name) VALUES($1,$2,'Other customer')",
    [other, w.ws.id],
  );
  await app.db.pool.query(
    "UPDATE conversations SET contact_id=$2 WHERE id=$1",
    [t.id, other],
  );
  await assert.rejects(
    app.ticketOperations.preview(w.owner, s.id, t.id),
    /same requester/,
  );
});
test("presence leases are per tab, expire, and never expose draft text or grant access", async () => {
  const w = await fixture(),
    t = await w.ticket();
  const user = uid(),
    session = uid();
  await app.db.pool.query(
    'INSERT INTO "user"(id,name,email,"emailVerified","createdAt","updatedAt") VALUES($1,\'Viewing agent\',$2,true,now(),now())',
    [user, `${user}@example.test`],
  );
  await app.db.pool.query(
    'INSERT INTO session(id,"userId",token,"expiresAt","createdAt","updatedAt") VALUES($1,$2,$3,now()+interval \'1 hour\',now(),now())',
    [session, user, uid()],
  );
  await app.db.pool.query(
    "INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,'agent')",
    [w.ws.id, user],
  );
  const agent: Principal = {
    workspaceId: w.ws.id,
    userId: user,
    sessionId: session,
    role: "agent",
  };
  await app.ticketOperations.presence(agent, t.id, {
    tabId: "tab-one-1",
    typing: true,
  });
  await app.ticketOperations.presence(agent, t.id, {
    tabId: "tab-two-2",
    typing: false,
  });
  assert.equal(
    (await app.ticketOperations.presence(w.owner, t.id)).people.length,
    1,
  );
  await app.ticketOperations.presence(agent, t.id, {
    tabId: "tab-one-1",
    typing: false,
    leave: true,
  });
  assert.equal(
    (await app.ticketOperations.presence(w.owner, t.id)).people[0].typing,
    false,
  );
  now = new Date(+now + 46000);
  assert.equal(
    (await app.ticketOperations.presence(w.owner, t.id)).people.length,
    0,
  );
  now = new Date();
  await assert.rejects(
    app.ticketOperations.presence(agent, t.id, {
      tabId: "tab-one-1",
      typing: true,
      draft: "secret",
    }),
  );
});

test("bulk reopen cannot bypass assignee capacity and concurrent batches do not double-apply", async () => {
  const w = await fixture(),
    agent = uid();
  await app.db.pool.query(
    "INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,'agent')",
    [w.ws.id, agent],
  );
  await app.db.pool.query(
    "INSERT INTO agent_availability(workspace_id,user_id,capacity,state) VALUES($1,$2,1,'available')",
    [w.ws.id, agent],
  );
  const active = await w.ticket(),
    closed = await w.ticket();
  await app.control(w.owner, active.id, { mode: "human", assignedTo: agent });
  await app.control(w.owner, closed.id, {
    status: "resolved",
    assignedTo: agent,
    mode: "human",
  });
  const version = (await row(closed.id)).edit_version;
  const request = {
    requestKey: uid(),
    tickets: [{ id: closed.id, expectedEditVersion: version }],
    action: { kind: "status", status: "open" },
  };
  const results = await Promise.all([
    app.ticketOperations.bulk(w.owner, request),
    app.ticketOperations.bulk(w.owner, request),
  ]);
  assert.deepEqual(results[0], results[1]);
  assert.equal(results[0].items[0].status, "capacity_conflict");
  assert.equal((await row(closed.id)).status, "resolved");
});

test("merged inbox unread state and read cursors include retained source messages", async () => {
  const w = await fixture(),
    target = await w.ticket("Target"),
    source = await w.ticket("Later source");
  const cursor = (await app.db.one(
    "SELECT inbox_sequence FROM messages WHERE conversation_id=$1",
    [target.id],
  ))!.inbox_sequence;
  await setInboxRead(app.db, w.owner, target.id, { read: true, cursor });
  const preview = await app.ticketOperations.preview(
    w.owner,
    source.id,
    target.id,
  );
  await app.ticketOperations.merge(w.owner, source.id, {
    targetId: target.id,
    sourceVersion: preview.source.editVersion,
    targetVersion: preview.target.editVersion,
    requestKey: uid(),
  });
  assert.equal(
    (await app.customers.inbox(w.owner, {})).conversations.find(
      (c: any) => c.id === target.id,
    ).unread,
    true,
  );
  const latest = (await app.db.one(
    "SELECT inbox_sequence FROM messages WHERE conversation_id=$1",
    [source.id],
  ))!.inbox_sequence;
  await setInboxRead(app.db, w.owner, source.id, {
    read: true,
    cursor: latest,
  });
  assert.equal(
    (await app.customers.inbox(w.owner, {})).conversations.find(
      (c: any) => c.id === target.id,
    ).unread,
    false,
  );
});

test("feedback through a merged URL applies only to the canonical requester ticket", async () => {
  const w = await fixture(),
    target = await w.ticket("Canonical closed ticket"),
    source = await w.ticket("Duplicate answer");
  const reply = await app.message(w.owner, source.id, {
    body: "Delivered support answer",
    requestKey: uid(),
  });
  await app.control(w.owner, target.id, { status: "resolved" });
  for (const e of await app.db.rows(
    "SELECT id FROM ticket_emails WHERE conversation_id=$1",
    [source.id],
  ))
    await app.ticketEmail.deliver(w.ws.id, e.id);
  const preview = await app.ticketOperations.preview(
    w.owner,
    source.id,
    target.id,
  );
  await app.ticketOperations.merge(w.owner, source.id, {
    targetId: target.id,
    sourceVersion: preview.source.editVersion,
    targetVersion: preview.target.editVersion,
    requestKey: uid(),
  });
  await app.quality.feedback(w.customer, source.id, {
    messageId: reply.id,
    resolved: false,
    rating: "bad",
    comment: "Still need assistance",
  });
  assert.equal((await row(source.id)).status, "resolved");
  assert.equal((await row(target.id)).status, "open");
  assert.equal(
    (
      await app.db.one(
        "SELECT conversation_id FROM customer_feedback WHERE message_id=$1",
        [reply.id],
      )
    )?.conversation_id,
    target.id,
  );
});
