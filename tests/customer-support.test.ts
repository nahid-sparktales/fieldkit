import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { Platform } from "../packages/platform/src/platform.js";
import { TicketEmail } from "../packages/platform/src/ticket-email.js";
import { uid } from "../packages/platform/src/db.js";
import {
  testConfig,
  resetDatabase,
  workspace,
  TestModel,
  TestProviders,
  knowledge,
} from "./helpers.js";
import { defaultWorkflow } from "../packages/platform/src/workflow-definition.js";
import { effectiveWorkflow } from "../packages/platform/src/channel-workflows.js";
import { tokenHash } from "../packages/platform/src/security.js";
import type { Mailer } from "../packages/platform/src/auth.js";
const config = testConfig(),
  sent: Parameters<Mailer>[] = [];
const app = new Platform(config, {
  model: new TestModel(),
  fetch: new TestProviders().fetch,
  mailer: async (...args) => {
    sent.push(args);
  },
});
before(async () => {
  await resetDatabase(config.DATABASE_URL);
  await app.migrate();
});
after(() => app.close());
async function ticket(w: Awaited<ReturnType<typeof workspace>>) {
  return app.newConversation(w.customer, {
    body: "Return policy?",
    subject: "A return request",
    requestKey: uid(),
  });
}
async function publish(
  w: Awaited<ReturnType<typeof workspace>>,
  channel: "default" | "portal" | "widget",
  text: string,
) {
  const current = await app.workflows.get(w.owner, channel),
    definition = defaultWorkflow();
  const reply = definition.nodes.find((n) => n.type === "reply")!;
  if (reply.type === "reply")
    reply.data = { mode: "workspace", content: "exact", text };
  const saved = await app.workflows.save(
    w.owner,
    { revision: current.revision, definition },
    channel,
  );
  return app.workflows.publish(w.owner, saved.revision, channel);
}
test("channel workflows inherit the published default and independently select immutable versions", async () => {
  const w = await workspace(app);
  await knowledge(app, w.ws.id);
  const d = await publish(w, "default", "Default response");
  const portal = await app.db.one(
    "SELECT id FROM channels WHERE workspace_id=$1 AND kind='portal'",
    [w.ws.id],
  );
  const widget = await app.db.one(
    "SELECT id FROM channels WHERE workspace_id=$1 AND kind='widget'",
    [w.ws.id],
  );
  assert.equal(
    (await effectiveWorkflow(app.db, w.ws.id, portal!.id))?.version,
    d.publishedVersion,
  );
  const p = await publish(w, "portal", "Ticket-specific response");
  assert.equal(
    (await effectiveWorkflow(app.db, w.ws.id, portal!.id))?.version,
    p.publishedVersion,
  );
  assert.equal(
    (await effectiveWorkflow(app.db, w.ws.id, widget!.id))?.version,
    d.publishedVersion,
  );
  const c = await ticket(w),
    run = await app.db.one("SELECT * FROM runs WHERE conversation_id=$1", [
      c.id,
    ]);
  await publish(w, "widget", "Chat-specific response");
  await app.agent.advance(w.ws.id, run!.id);
  const answer = await app.db.one(
    "SELECT body FROM messages WHERE conversation_id=$1 AND role='assistant'",
    [c.id],
  );
  assert.equal(answer?.body, "Ticket-specific response");
  const pending = await ticket(w);
  const updated = await publish(w, "portal", "Updated ticket workflow");
  assert.deepEqual(
    await app.db.one("SELECT mode,status FROM conversations WHERE id=$1", [
      pending.id,
    ]),
    { mode: "human", status: "needs_staff" },
  );
  await publish(w, "default", "Changed default");
  assert.equal(
    (await effectiveWorkflow(app.db, w.ws.id, portal!.id))?.version,
    updated.publishedVersion,
  );
  assert.equal((await app.workflows.get(w.owner, "widget")).versions.length, 1);
  await assert.rejects(
    app.workflows.save(
      { ...w.owner, role: "agent" },
      { revision: 0, definition: defaultWorkflow() },
      "portal",
    ),
    /administrator/,
  );
});
test("closed-only feedback accepts the latest delivered staff reply, reopening preserves takeover and invalidates feedback submission", async () => {
  const w = await workspace(app),
    c = await ticket(w);
  const m = await app.message(w.owner, c.id, {
    body: "Here is the answer",
    requestKey: uid(),
  });
  await assert.rejects(
    app.quality.feedback(w.customer, c.id, { messageId: m.id, resolved: true }),
    /closed/,
  );
  await app.customerStatus(w.customer, c.id, "resolved");
  await app.quality.feedback(w.customer, c.id, {
    messageId: m.id,
    resolved: true,
  });
  const other = await workspace(app);
  await assert.rejects(
    app.customerStatus(other.customer, c.id, "open"),
    /not found/i,
  );
  await app.message(w.customer, c.id, {
    body: "More details",
    requestKey: uid(),
  });
  const reopened = await app.db.one(
    "SELECT status,mode FROM conversations WHERE id=$1",
    [c.id],
  );
  assert.deepEqual(reopened, { status: "open", mode: "human" });
  await app.customerStatus(w.customer, c.id, "resolved");
  await assert.rejects(
    app.quality.feedback(w.customer, c.id, { messageId: m.id, resolved: true }),
    /latest delivered/,
  );
});
test("outbound public ticket emails are durable, deduplicated, private and support safe threaded inbound replies", async () => {
  const w = await workspace(app),
    c = await ticket(w),
    setup = await app.ticketEmail.configure(w.owner, {
      address: "support@inbound.example.test",
    });
  const m = await app.message(w.owner, c.id, {
    body: "Your return is approved",
    requestKey: uid(),
  });
  const mail = await app.db.one(
    "SELECT * FROM ticket_emails WHERE message_id=$1",
    [m.id],
  );
  assert.ok(mail);
  await app.ticketEmail.deliver(w.ws.id, mail.id);
  await app.ticketEmail.deliver(w.ws.id, mail.id);
  const copies = sent.filter((v) => v[3]?.messageId?.includes(m.id));
  assert.equal(copies.length, 1);
  const outgoing = copies[0];
  assert.equal(outgoing[0], "customer@example.test");
  assert.match(outgoing[2], new RegExp(`ticket=${c.id}`));
  assert.ok(outgoing[3]?.replyTo);
  const authorization = `Basic ${Buffer.from(`fieldkit:${setup.password}`).toString("base64")}`;
  const payload = {
    MessageID: uid(),
    OriginalRecipient: outgoing[3]!.replyTo!,
    FromFull: { Email: outgoing[0] },
    TextBody: "Quoted old text",
    StrippedTextReply: "Thanks, here are my details",
  };
  await assert.rejects(
    app.ticketEmail.receive(w.ws.id, "Basic wrong", payload),
    /credentials/,
  );
  await app.customerStatus(w.customer, c.id, "resolved");
  await Promise.all([
    app.ticketEmail.receive(w.ws.id, authorization, payload),
    app.ticketEmail.receive(w.ws.id, authorization, payload),
  ]);
  assert.equal(
    (
      await app.db.one(
        "SELECT count(*)::int n FROM messages WHERE conversation_id=$1 AND body=$2",
        [c.id, payload.StrippedTextReply],
      )
    )?.n,
    1,
  );
  const state = await app.db.one(
    "SELECT status,mode FROM conversations WHERE id=$1",
    [c.id],
  );
  assert.deepEqual(state, { status: "open", mode: "human" });
  assert.equal(
    (
      await app.ticketEmail.receive(w.ws.id, authorization, {
        ...payload,
        MessageID: uid(),
        FromFull: { Email: "attacker@example.test" },
      })
    ).status,
    "rejected",
  );
  assert.equal(
    (
      await app.ticketEmail.receive(w.ws.id, authorization, {
        ...payload,
        MessageID: uid(),
        Headers: [{ Name: "Auto-Submitted", Value: "auto-replied" }],
      })
    ).status,
    "rejected",
  );
  assert.equal(
    (
      await app.ticketEmail.receive(w.ws.id, authorization, {
        ...payload,
        MessageID: uid(),
        Attachments: [{ Name: "private.pdf" }],
      })
    ).status,
    "rejected",
  );
  await app.message(
    w.owner,
    c.id,
    { body: "Internal secret", requestKey: uid() },
    true,
  );
  assert.equal(
    (
      await app.db.one(
        "SELECT count(*)::int n FROM ticket_emails WHERE conversation_id=$1",
        [c.id],
      )
    )?.n,
    1,
  );
  await app.ticketEmail.configure(w.owner, {
    address: "support@new.example.test",
  });
  await assert.rejects(
    app.ticketEmail.receive(w.ws.id, authorization, payload),
    /credentials/,
  );
  assert.equal(
    (
      await app.db.one(
        "SELECT count(*)::int n FROM ticket_email_routes WHERE workspace_id=$1",
        [w.ws.id],
      )
    )?.n,
    0,
  );
});
test("uncertain SMTP attempts require explicit recovery; revoked contacts skip delivery; chat creates no mail", async () => {
  const w = await workspace(app),
    c = await ticket(w);
  const service = new TicketEmail(
    app.db,
    app.connections,
    async () => {
      throw new Error("timeout after SMTP accept");
    },
    (p, id, input) => app.message(p, id, input),
  );
  const m = await app.message(w.owner, c.id, {
      body: "A reply",
      requestKey: uid(),
    }),
    mail = await app.db.one("SELECT * FROM ticket_emails WHERE message_id=$1", [
      m.id,
    ]);
  await service.deliver(w.ws.id, mail!.id);
  assert.equal(
    (
      await app.db.one("SELECT status FROM ticket_emails WHERE id=$1", [
        mail!.id,
      ])
    )?.status,
    "unknown",
  );
  await service.deliver(w.ws.id, mail!.id);
  assert.equal(
    (
      await app.db.one("SELECT attempts FROM ticket_emails WHERE id=$1", [
        mail!.id,
      ])
    )?.attempts,
    1,
  );
  await assert.rejects(
    service.retry({ ...w.owner, role: "agent" }, mail!.id),
    /administrator/,
  );
  await service.retry(w.owner, mail!.id);
  await app.db.pool.query("UPDATE contacts SET verified=false WHERE id=$1", [
    w.customer.contactId,
  ]);
  await service.deliver(w.ws.id, mail!.id);
  assert.equal(
    (
      await app.db.one("SELECT status FROM ticket_emails WHERE id=$1", [
        mail!.id,
      ])
    )?.status,
    "skipped",
  );
  const ch = await app.db.one(
    "SELECT id FROM channels WHERE workspace_id=$1 AND kind='widget'",
    [w.ws.id],
  );
  await app.db.pool.query("UPDATE channels SET published=true WHERE id=$1", [
    ch!.id,
  ]);
  const chat = await app.newConversation(
    { ...w.customer, role: "visitor", channelId: ch!.id },
    { body: "Hi", channelId: ch!.id, requestKey: uid() },
  );
  const reply = await app.message(w.owner, chat.id, {
    body: "Hello",
    requestKey: uid(),
  });
  assert.equal(
    await app.db.one("SELECT id FROM ticket_emails WHERE message_id=$1", [
      reply.id,
    ]),
    undefined,
  );
  await assert.rejects(
    app.newConversation(
      { ...w.customer, role: "visitor", channelId: ch!.id },
      { body: "Hi", requestKey: uid() },
    ),
    /verified account/,
  );
  const route = await app.db.one(
    "SELECT token_hash FROM ticket_email_routes WHERE conversation_id=$1",
    [c.id],
  );
  assert.notEqual(route?.token_hash, tokenHash("guess"));
});
