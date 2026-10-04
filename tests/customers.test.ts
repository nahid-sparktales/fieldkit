import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { Platform } from "../packages/platform/src/platform.js";
import { uid } from "../packages/platform/src/db.js";
import {
  testConfig,
  resetDatabase,
  workspace,
  TestModel,
  TestProviders,
} from "./helpers.js";
const config = testConfig(),
  app = new Platform(config, {
    model: new TestModel(),
    fetch: new TestProviders().fetch,
    mailer: async () => {},
  });
before(async () => {
  await resetDatabase(config.DATABASE_URL);
  await app.migrate();
});
after(() => app.close());
async function seed(
  w: Awaited<ReturnType<typeof workspace>>,
  count: number,
  contact = w.contactId,
  kind = "portal",
) {
  const channel = (await app.db.one(
    "SELECT id FROM channels WHERE workspace_id=$1 AND kind=$2",
    [w.ws.id, kind],
  ))!;
  return app.db.rows(
    `INSERT INTO conversations(id,workspace_id,contact_id,channel_id,subject,updated_at)
    SELECT gen_random_uuid()::text,$1,$2,$3,'Support request '||i,now()+(i*interval '1 second') FROM generate_series(1,$4::int) i RETURNING *`,
    [w.ws.id, contact, channel.id, count],
  );
}
test("customer grouping happens before pagination, counts all tickets and retains other customers beyond 200 conversations", async () => {
  const w = await workspace(app);
  const second = uid();
  await app.db.pool.query(
    "INSERT INTO contacts(id,workspace_id,name,email,verified) VALUES($1,$2,'Second customer','second@example.test',true)",
    [second, w.ws.id],
  );
  await seed(w, 1, second);
  await seed(w, 205);
  const grouped = (await app.customers.inbox(w.owner, {}))!;
  assert.equal(grouped.total, 2);
  assert.equal(grouped.conversation_total, 206);
  assert.equal(
    grouped.conversations.find((c: any) => c.contact_id === w.contactId)
      .group_count,
    205,
  );
  assert.ok(grouped.conversations.some((c: any) => c.contact_id === second));
  const pages = await Promise.all(
    Array.from({ length: 6 }, (_, i) =>
      app.customers.inbox(w.owner, { group: "conversation", page: i + 1 }),
    ),
  );
  assert.equal(
    new Set(pages.flatMap((p) => p!.conversations.map((c: any) => c.id))).size,
    206,
  );
  const list = (await app.customers.list(w.owner, {}))!;
  assert.equal(list.total, 2);
  assert.equal(
    list.customers.find((c: any) => c.id === w.contactId).conversations,
    205,
  );
  assert.equal(
    (await app.customers.detail(w.owner, w.contactId)).summary.total,
    205,
  );
});
test("type, status, assignment and customer search apply consistently to grouped and individual queues", async () => {
  const w = await workspace(app);
  const [ticket] = await seed(w, 1);
  await seed(w, 2, w.contactId, "widget");
  const [zendesk] = await seed(w, 1, w.contactId, "zendesk");
  await app.db.pool.query(
    "UPDATE conversations SET mode='human',status='needs_staff',assigned_to=$2 WHERE id=$1",
    [ticket.id, w.owner.userId],
  );
  await app.db.pool.query(
    "UPDATE conversations SET status='waiting_approval' WHERE id=$1",
    [zendesk.id],
  );
  const tickets = (await app.customers.inbox(w.owner, { type: "ticket" }))!;
  assert.equal(tickets.conversation_total, 2);
  assert.equal(tickets.counts.human, 2);
  assert.equal(tickets.conversations[0].group_human, 2);
  assert.equal(
    (await app.customers.inbox(w.owner, { type: "chat" }))!.conversation_total,
    2,
  );
  assert.equal(
    (await app.customers.inbox(w.owner, { assignee: w.owner.userId }))!
      .conversation_total,
    1,
  );
  assert.equal(
    (await app.customers.inbox(w.owner, { assignee: "unassigned" }))!
      .conversation_total,
    3,
  );
  assert.equal(
    (await app.customers.inbox(w.owner, {
      q: "customer@example.test",
      state: "human",
    }))!.conversation_total,
    2,
  );
  assert.equal((await app.customers.inbox(w.owner, { q: "%" }))!.total, 0);
  assert.equal(
    (await app.customers.inbox(w.owner, { q: "missing" }))!.total,
    0,
  );
  assert.equal(
    (await app.customers.list(w.owner, {
      q: "customer@example.test",
      kind: "verified",
    }))!.total,
    1,
  );
  assert.equal(
    (await app.customers.list(w.owner, { kind: "visitor" }))!.total,
    0,
  );
});
test("customer notes include ticket context, remain private, deduplicate retries and never create messages, runs or operations", async () => {
  const w = await workspace(app),
    [ticket] = await seed(w, 1);
  await app.message(
    w.owner,
    ticket.id,
    { body: "Internal ticket context", requestKey: uid() },
    true,
  );
  const previous = await app.db.one(
    "SELECT revision,status,mode FROM conversations WHERE id=$1",
    [ticket.id],
  );
  const input = { body: "Account context across tickets", requestKey: uid() };
  const [a, b] = await Promise.all([
    app.customers.addNote(w.owner, w.contactId, input),
    app.customers.addNote(w.owner, w.contactId, input),
  ]);
  assert.equal(a.id, b.id);
  await assert.rejects(
    app.customers.addNote(w.owner, w.contactId, { ...input, body: "Changed" }),
    /already belongs/,
  );
  const notes = (await app.customers.notes(w.owner, w.contactId, {}))!;
  assert.equal(notes.total, 2);
  assert.equal(
    notes.notes.find((n: any) => n.scope === "conversation").conversation_id,
    ticket.id,
  );
  assert.equal(
    (await app.customers.detail(w.owner, w.contactId)).summary.notes,
    2,
  );
  assert.deepEqual(
    await app.db.one(
      "SELECT revision,status,mode FROM conversations WHERE id=$1",
      [ticket.id],
    ),
    previous,
  );
  for (const table of ["runs", "operations", "deliveries", "ticket_emails"])
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
      await app.db.rows("SELECT id FROM messages WHERE conversation_id=$1", [
        ticket.id,
      ])
    ).length,
    1,
  );
  assert.equal(
    (await app.db.one(
      "SELECT public FROM events WHERE workspace_id=$1 AND kind='customer.note_added'",
      [w.ws.id],
    ))!.public,
    false,
  );
  await app.deleteConversation(w.ws.id, ticket.id);
  assert.equal((await app.customers.notes(w.owner, w.contactId, {}))!.total, 1);
  await app.db.pool.query(
    "UPDATE contact_notes SET created_at=now()-interval '4000 days' WHERE id=$1",
    [a.id],
  );
  await app.maintenance();
  assert.equal((await app.customers.notes(w.owner, w.contactId, {}))!.total, 0);
  await app.customers.addNote(w.owner, w.contactId, {
    body: "Private account context",
    requestKey: uid(),
  });
  await app.db.pool.query(
    "DELETE FROM contacts WHERE workspace_id=$1 AND id=$2",
    [w.ws.id, w.contactId],
  );
  assert.equal(
    (
      await app.db.rows(
        "SELECT id FROM contact_notes WHERE workspace_id=$1 AND contact_id=$2",
        [w.ws.id, w.contactId],
      )
    ).length,
    0,
  );
});
test("customer resources enforce staff and workspace boundaries without merging same-name or anonymous identities", async () => {
  const w = await workspace(app),
    other = await workspace(app);
  await seed(w, 1);
  await seed(other, 1);
  for (const role of ["customer", "visitor", "service"] as const) {
    const p = { ...w.customer, role };
    await assert.rejects(app.customers.list(p, {}), /Staff/);
    await assert.rejects(app.customers.inbox(p, {}), /Staff/);
    await assert.rejects(app.customers.detail(p, w.contactId), /Staff/);
    await assert.rejects(app.customers.notes(p, w.contactId, {}), /Staff/);
    await assert.rejects(
      app.customers.addNote(p, w.contactId, {
        body: "Forged",
        requestKey: uid(),
      }),
      /Staff/,
    );
  }
  await assert.rejects(
    app.customers.detail(w.owner, other.contactId),
    /Not found/,
  );
  await assert.rejects(
    app.customers.addNote(w.owner, other.contactId, {
      body: "Cross tenant",
      requestKey: uid(),
    }),
    /Not found/,
  );
  assert.equal(
    (await app.customers.inbox(w.owner, { contactId: other.contactId }))!.total,
    0,
  );
  const ids = [uid(), uid()];
  for (const id of ids) {
    await app.db.pool.query(
      "INSERT INTO contacts(id,workspace_id,name,email) VALUES($1,$2,'Visitor','same@example.test')",
      [id, w.ws.id],
    );
    await seed(w, 1, id);
  }
  assert.equal((await app.customers.inbox(w.owner, {}))!.total, 3);
  assert.equal(
    (await app.customers.list({ ...w.owner, role: "agent" }, {}))!.total,
    3,
  );
  await assert.rejects(
    app.customers.addNote(w.owner, w.contactId, {
      body: " ",
      requestKey: uid(),
    }),
  );
  await assert.rejects(app.customers.inbox(w.owner, { page: 0 }));
});
