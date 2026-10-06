import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { Platform } from "../packages/platform/src/platform.js";
import { TicketEmail } from "../packages/platform/src/ticket-email.js";
import { uid } from "../packages/platform/src/db.js";
import {
  EmailIntake,
  emailText,
} from "../packages/platform/src/email-intake.js";
import {
  testConfig,
  resetDatabase,
  workspace,
  TestModel,
  TestProviders,
} from "./helpers.js";
import type { AttachmentScanner } from "../packages/platform/src/attachment-scanner.js";
import { createApp } from "../apps/api/server.js";
const config = testConfig(4364);
config.FIELDKIT_DATA = ".fieldkit/email-intake-tests";
config.FIELDKIT_CLAM_HOST = "scanner-test-double";
const sent: any[] = [];
let scanFailure = false;
const scanner: AttachmentScanner = {
  health: async () => {
    if (scanFailure) throw new Error("Scanner unavailable");
    return {
      engine: "Local test double",
      signaturesAt: new Date().toISOString(),
    };
  },
  scan: async (bytes) => ({
    ...(await scanner.health()),
    clean: !bytes.includes(Buffer.from("malware-fixture")),
    scannedAt: new Date().toISOString(),
  }),
};
const app = new Platform(config, {
  model: new TestModel(),
  fetch: new TestProviders().fetch,
  scanner,
  mailer: async (...args) => {
    sent.push(args);
  },
});
before(async () => {
  await resetDatabase(config.DATABASE_URL);
  await app.migrate();
});
after(() => app.close());
beforeEach(() => {
  scanFailure = false;
});
async function setup() {
  const w = await workspace(app);
  const address = `support@${w.ws.id}.example.test`;
  const setup = await app.ticketEmail.configure(w.owner, { address });
  const authorization = `Basic ${Buffer.from(`fieldkit:${setup.password}`).toString("base64")}`;
  return {
    ...w,
    address,
    authorization,
    addressId: setup.addresses.find((a: any) => a.address === address)!.id,
  };
}
const envelope = (w: any, extra: any = {}) => ({
  MessageID: uid(),
  OriginalRecipient: w.address,
  FromFull: { Email: "new-sender@example.test", Name: "Renée お客様" },
  Subject: "Billing help",
  TextBody: "Please help with my invoice.",
  Headers: [{ Name: "Message-ID", Value: `<${uid()}@sender.example.test>` }],
  ...extra,
});
async function event(w: any, payload: any) {
  return app.db.one(
    "SELECT * FROM email_intake_events WHERE workspace_id=$1 AND provider_id=$2",
    [w.ws.id, payload.MessageID],
  );
}
async function accept(w: any, payload: any) {
  const result = await app.ticketEmail.receive(
    w.ws.id,
    w.authorization,
    payload,
  );
  return { result, event: (await event(w, payload))! };
}
async function addressOptions(w: any, patch: any) {
  const row = (await app.ticketEmail.intake.addresses(w.owner)).addresses.find(
    (a) => a.id === w.addressId,
  )!;
  const { id, integrationId, ...rest } = row;
  return app.ticketEmail.intake.saveAddress(w.owner, { ...rest, ...patch }, id);
}

test("new email creates one native human ticket with isolated unverified contact, no portal identity, missing subject fallback and provenance", async () => {
  const w = await setup(),
    p = envelope(w, {
      Subject: "",
      FromFull: { Email: "customer@example.test", Name: "偽 staff" },
      TextBody: "Need help without a portal account",
    });
  const x = await accept(w, p);
  assert.equal(x.result.status, "received");
  const c = (await app.db.one("SELECT * FROM conversations WHERE id=$1", [
    x.event.conversation_id,
  ]))!;
  const ct = (await app.db.one("SELECT * FROM contacts WHERE id=$1", [
    c.contact_id,
  ]))!;
  assert.equal(c.origin, "email");
  assert.equal(c.mode, "human");
  assert.equal(c.subject, "Email support request");
  assert.equal(ct.verified, false);
  assert.equal(ct.user_id, null);
  assert.notEqual(ct.id, w.contactId);
  assert.deepEqual(ct.mappings, {});
  assert.equal(
    (await app.db.one(
      "SELECT count(*)::int n FROM messages WHERE conversation_id=$1 AND role='customer'",
      [c.id],
    ))!.n,
    1,
  );
  assert.equal(
    (await app.db.one(
      "SELECT count(*)::int n FROM events WHERE conversation_id=$1 AND kind='conversation.created'",
      [c.id],
    ))!.n,
    1,
  );
  assert.equal(
    (await app.db.one(
      "SELECT count(*)::int n FROM runs WHERE conversation_id=$1",
      [c.id],
    ))!.n,
    0,
  );
});
test("actual concurrent duplicate deliveries create one ticket/message/event and reject changed identity payloads", async () => {
  const w = await setup(),
    p = envelope(w);
  await Promise.all(
    Array.from({ length: 12 }, () =>
      app.ticketEmail.receive(w.ws.id, w.authorization, p),
    ),
  );
  const e = (await event(w, p))!;
  assert.equal(e.status, "received");
  assert.equal(
    (await app.db.one(
      "SELECT count(*)::int n FROM conversations WHERE workspace_id=$1",
      [w.ws.id],
    ))!.n,
    1,
  );
  assert.equal(
    (await app.db.one(
      "SELECT count(*)::int n FROM messages WHERE conversation_id=$1",
      [e.conversation_id],
    ))!.n,
    1,
  );
  await assert.rejects(
    app.ticketEmail.receive(w.ws.id, w.authorization, {
      ...p,
      TextBody: "Changed body",
    }),
    /reused/,
  );
});
test("multiple aliases map explicitly, default team is tenant validated, aliases in same workspace use envelope recipient", async () => {
  const w = await setup();
  const team = uid();
  await app.db.pool.query(
    "INSERT INTO teams(workspace_id,id,name) VALUES($1,$2,$3)",
    [w.ws.id, team, "Billing"],
  );
  const second = await app.ticketEmail.intake.saveAddress(w.owner, {
    address: `billing@${w.ws.id}.example.test`,
    replyAddress: `billing@${w.ws.id}.example.test`,
    displayName: "Billing",
    defaultTeamId: team,
  });
  const x = await accept(
    w,
    envelope(w, {
      OriginalRecipient: second.address,
      ToFull: [{ Email: w.address }, { Email: second.address }],
    }),
  );
  assert.equal(x.result.status, "received");
  const c = (await app.db.one("SELECT * FROM conversations WHERE id=$1", [
    x.event.conversation_id,
  ]))!;
  assert.equal(c.support_address_id, second.id);
  assert.equal(c.team_id, team);
  await assert.rejects(
    addressOptions(w, { defaultTeamId: uid() }),
    /active team/,
  );
});
test("unknown recipients and cross-workspace alias ambiguity are quarantined without tickets or disclosure", async () => {
  const w = await setup(),
    other = await setup();
  for (const extra of [
    { OriginalRecipient: "unknown@outside.example.test" },
    { ToFull: [{ Email: w.address }, { Email: other.address }] },
  ]) {
    const x = await accept(w, envelope(w, extra));
    assert.equal(x.result.status, "rejected");
    assert.equal(x.event.status, "quarantined");
    assert.equal(x.event.conversation_id, null);
    assert.ok(x.event.payload_ciphertext);
  }
  assert.equal(
    (await app.db.one(
      "SELECT count(*)::int n FROM conversations WHERE workspace_id=$1",
      [w.ws.id],
    ))!.n,
    0,
  );
  await assert.rejects(
    app.ticketEmail.intake.saveAddress(other.owner, {
      address: w.address,
      replyAddress: other.address,
    }),
    /already has/,
  );
});
test("configured acknowledgement uses normal outbox once, configured From, private token and reply threading preserves human ownership", async () => {
  const w = await setup();
  await addressOptions(w, {
    acknowledge: true,
    displayName: "Billing support",
    replyAddress: `reply@${w.ws.id}.example.test`,
  });
  const first = envelope(w);
  const x = await accept(w, first);
  await app.ticketEmail.receive(w.ws.id, w.authorization, first);
  const emails = await app.db.rows(
    "SELECT * FROM ticket_emails WHERE conversation_id=$1",
    [x.event.conversation_id],
  );
  assert.equal(emails.length, 1);
  assert.equal(emails[0].kind, "acknowledgement");
  await app.ticketEmail.deliver(w.ws.id, emails[0].id);
  await app.ticketEmail.deliver(w.ws.id, emails[0].id);
  const out = sent.find((args) =>
    args[3]?.messageId?.includes(x.event.message_id),
  );
  assert.ok(out);
  assert.match(out[3].from, /Billing support/);
  assert.equal(out[3].inReplyTo, first.Headers[0].Value);
  assert.ok(out[3].replyTo.includes("+"));
  await app.db.pool.query(
    "UPDATE conversations SET status='resolved' WHERE id=$1",
    [x.event.conversation_id],
  );
  const reply = envelope(w, {
    OriginalRecipient: out[3].replyTo,
    StrippedTextReply: "New details",
    TextBody: "New details\nQuoted old text",
    Headers: [
      { Name: "Message-ID", Value: `<${uid()}@sender.example.test>` },
      { Name: "In-Reply-To", Value: out[3].messageId },
    ],
  });
  const r = await accept(w, reply);
  assert.equal(r.result.status, "received");
  assert.equal(r.event.conversation_id, x.event.conversation_id);
  assert.deepEqual(
    await app.db.one("SELECT status,mode FROM conversations WHERE id=$1", [
      x.event.conversation_id,
    ]),
    { status: "open", mode: "human" },
  );
  const staff = await app.message(w.owner, x.event.conversation_id, {
    body: "Here is our answer",
    requestKey: uid(),
  });
  assert.ok(
    await app.db.one("SELECT id FROM ticket_emails WHERE message_id=$1", [
      staff.id,
    ]),
  );
});
test("invalid token, forged staff sender, another participant and header-only references never append to someone else’s ticket", async () => {
  const w = await setup();
  await addressOptions(w, { acknowledge: true });
  const x = await accept(w, envelope(w));
  const mail = (await app.db.one(
    "SELECT * FROM ticket_emails WHERE conversation_id=$1",
    [x.event.conversation_id],
  ))!;
  await app.ticketEmail.deliver(w.ws.id, mail.id);
  const out = sent.find((args) =>
    args[3]?.messageId?.includes(x.event.message_id),
  );
  for (const extra of [
    { OriginalRecipient: w.address.replace("@", "+invalid@") },
    {
      OriginalRecipient: out[3].replyTo,
      FromFull: { Email: "owner@example.test" },
    },
    { Headers: [{ Name: "In-Reply-To", Value: out[3].messageId }] },
  ]) {
    const v = await accept(w, envelope(w, extra));
    assert.equal(v.result.status, "rejected");
  }
  assert.equal(
    (await app.db.one(
      "SELECT count(*)::int n FROM messages WHERE conversation_id=$1",
      [x.event.conversation_id],
    ))!.n,
    1,
  );
});
test("safe HTML extraction keeps meaningful forwarded text and ignores executable elements", () => {
  assert.equal(
    emailText({
      TextBody: "",
      HtmlBody: "<p>Bonjour<br>Forwarded details</p><script>steal()</script>",
      StrippedTextReply: "",
    }),
    "Bonjour\nForwarded details",
  );
  assert.equal(
    emailText({
      TextBody: "Full original\n> prior details",
      HtmlBody: "",
      StrippedTextReply: "",
    }),
    "Full original\n> prior details",
  );
});
test("loop and automated messages are observable quarantine outcomes and never acknowledgements", async () => {
  const w = await setup();
  await addressOptions(w, { acknowledge: true });
  for (const h of [
    { Name: "Auto-Submitted", Value: "auto-replied" },
    { Name: "List-ID", Value: "mailing-list" },
    {
      Name: "Content-Type",
      Value: "multipart/report; report-type=delivery-status",
    },
    { Name: "X-Spam-Status", Value: "Yes, score=10" },
  ]) {
    const x = await accept(w, envelope(w, { Headers: [h] }));
    assert.equal(x.result.status, "rejected");
  }
  assert.equal(
    (await app.db.one(
      "SELECT count(*)::int n FROM ticket_emails WHERE workspace_id=$1",
      [w.ws.id],
    ))!.n,
    0,
  );
});
test("attachments from unverified email remain quarantined until scanning; scanner failure and webhook retries cannot duplicate message", async () => {
  const w = await setup();
  await app.attachments.settings(w.owner, { enabled: true, anonymous: false });
  await app.db.pool.query(
    "UPDATE channels SET published=false WHERE workspace_id=$1",
    [w.ws.id],
  );
  const bytes = Buffer.from("Synthetic support log");
  const p = envelope(w, {
    Attachments: [
      {
        Name: "support.log",
        Content: bytes.toString("base64"),
        ContentLength: bytes.length,
        ContentType: "text/plain",
      },
    ],
  });
  const x = await accept(w, p);
  assert.equal(x.result.status, "received");
  const file = (await app.db.one(
    "SELECT * FROM attachments WHERE conversation_id=$1",
    [x.event.conversation_id],
  ))!;
  assert.equal(file.status, "quarantined");
  assert.equal(file.uploader_role, "email");
  await assert.rejects(
    app.attachments.download(w.owner, file.id),
    /not ready|not available|scann/i,
  );
  scanFailure = true;
  await app.attachments.scan(w.ws.id, file.id);
  assert.equal(
    (await app.db.one("SELECT status FROM attachments WHERE id=$1", [file.id]))!
      .status,
    "scan_failed",
  );
  await app.ticketEmail.receive(w.ws.id, w.authorization, p);
  assert.equal(
    (await app.db.one(
      "SELECT count(*)::int n FROM messages WHERE conversation_id=$1",
      [x.event.conversation_id],
    ))!.n,
    1,
  );
  scanFailure = false;
  await app.attachments.control(w.owner, file.id, "retry");
  await app.attachments.scan(w.ws.id, file.id);
  assert.equal(
    (await app.attachments.download(w.owner, file.id)).bytes.toString(),
    bytes.toString(),
  );
});
test("failure after message commit recovers idempotently with one acknowledgement and one workflow turn", async () => {
  const w = await setup();
  await addressOptions(w, { acknowledge: true, workflowEnabled: true });
  let fail = true;
  const service = new EmailIntake(
    app.db,
    async (p, id, input) => {
      const result = await app.message(p, id, input);
      if (fail) {
        fail = false;
        throw new Error("Interrupted after message commit");
      }
      return result;
    },
    app.attachments,
  );
  const connection = await app.db.one(
    "SELECT * FROM connections WHERE workspace_id=$1 AND provider='ticket_email'",
    [w.ws.id],
  );
  const p = envelope(w);
  await service.accept(w.ws.id, connection, p);
  let e = (await event(w, p))!;
  assert.equal(e.status, "retrying");
  assert.ok(e.conversation_id);
  await service.retry(w.owner, e.id);
  await service.process(w.ws.id, e.id);
  e = (await event(w, p))!;
  assert.equal(e.status, "received");
  assert.equal(
    (await app.db.one(
      "SELECT count(*)::int n FROM messages WHERE conversation_id=$1",
      [e.conversation_id],
    ))!.n,
    1,
  );
  assert.equal(
    (await app.db.one(
      "SELECT count(*)::int n FROM runs WHERE conversation_id=$1",
      [e.conversation_id],
    ))!.n,
    1,
  );
  assert.equal(
    (await app.db.one(
      "SELECT count(*)::int n FROM ticket_emails WHERE conversation_id=$1",
      [e.conversation_id],
    ))!.n,
    1,
  );
});
test("rate/schema limits, permission denial, recipient disable and replay revalidate admission rules", async () => {
  const w = await setup();
  await assert.rejects(
    app.ticketEmail.receive(w.ws.id, "Basic invalid", envelope(w)),
    /credentials/,
  );
  await assert.rejects(
    app.ticketEmail.receive(
      w.ws.id,
      w.authorization,
      envelope(w, { TextBody: "x".repeat(100001) }),
    ),
  );
  await assert.rejects(
    app.ticketEmail.receive(w.ws.id, w.authorization, {
      OriginalRecipient: w.address,
      FromFull: { Email: "x@example.test" },
    }),
    /stable/,
  );
  const agent = { ...w.owner, role: "agent" as const };
  await assert.rejects(app.ticketEmail.settings(agent), /Permission/);
  await assert.rejects(
    app.ticketEmail.intake.saveAddress(agent, {
      address: w.address,
      replyAddress: w.address,
    }),
    /Permission/,
  );
  await addressOptions(w, { enabled: false });
  const p = envelope(w),
    x = await accept(w, p);
  assert.equal(x.result.status, "rejected");
  await app.ticketEmail.intake.retry(w.owner, x.event.id);
  await app.ticketEmail.intake.process(w.ws.id, x.event.id);
  assert.equal((await event(w, p))!.status, "quarantined");
  await addressOptions(w, { enabled: true });
  await app.ticketEmail.intake.retry(w.owner, x.event.id);
  await app.ticketEmail.intake.process(w.ws.id, x.event.id);
  assert.equal((await event(w, p))!.status, "received");
});
test("expired processing leases survive restart and terminal attempt limit requires manual recovery", async () => {
  const w = await setup(),
    p = envelope(w, { OriginalRecipient: "unknown@example.test" });
  const x = await accept(w, p);
  await app.db.pool.query(
    "UPDATE email_intake_events SET status='processing',attempts=5,lease_until=now()-interval '1 minute' WHERE id=$1",
    [x.event.id],
  );
  await app.ticketEmail.intake.recover();
  assert.equal((await event(w, p))!.status, "failed");
});

test("original quoted content is recoverable without returning headers, hidden recipients or attachment bytes", async () => {
  const w = await setup(),
    p = envelope(w, {
      TextBody: "Original meaningful context\n> prior explanation",
      StrippedTextReply: "New details",
      Headers: [{ Name: "Bcc", Value: "hidden@example.test" }],
    });
  const x = await accept(w, p);
  const source = await app.ticketEmail.intake.source(w.owner, x.event.id);
  assert.match(source.text, /meaningful context/);
  assert.equal(source.senderVerified, false);
  assert.equal(JSON.stringify(source).includes("hidden@example.test"), false);
  await assert.rejects(
    app.ticketEmail.intake.source({ ...w.owner, role: "agent" }, x.event.id),
    /Permission/,
  );
});
test("public webhook authentication, malformed envelopes and tenant mapping are enforced on direct HTTP requests", async () => {
  const w = await setup();
  const http = await createApp(config, {
    model: new TestModel(),
    fetch: new TestProviders().fetch,
    mailer: async () => {
      throw new Error("Unexpected send");
    },
  });
  await new Promise<void>((resolve) =>
    http.server.listen(0, "127.0.0.1", resolve),
  );
  const port = (http.server.address() as { port: number }).port;
  const url = `http://127.0.0.1:${port}/v2/webhooks/email/${w.ws.id}`;
  try {
    const invalid = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Basic bad",
      },
      body: JSON.stringify(envelope(w)),
    });
    assert.equal(invalid.status, 403);
    const malformed = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: w.authorization,
      },
      body: JSON.stringify({
        OriginalRecipient: w.address,
        FromFull: { Email: "broken" },
      }),
    });
    assert.equal(malformed.status, 400);
    const unknown = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: w.authorization,
      },
      body: JSON.stringify(
        envelope(w, { OriginalRecipient: "unknown@example.test" }),
      ),
    });
    assert.equal(unknown.status, 200);
    const result = await unknown.json();
    assert.deepEqual(result, { accepted: true, status: "rejected" });
    const forbidden = await fetch(
      `http://127.0.0.1:${port}/v2/workspaces/${w.ws.id}/ticket-email/addresses`,
    );
    assert.ok([401, 403].includes(forbidden.status));
  } finally {
    await http.close();
  }
});
test("RFC fallback identifiers deduplicate only when a stable Message-ID exists and preserve new distinct replies", async () => {
  const w = await setup(),
    p = envelope(w);
  delete p.MessageID;
  await app.ticketEmail.receive(w.ws.id, w.authorization, p);
  await app.ticketEmail.receive(w.ws.id, w.authorization, p);
  assert.equal(
    (await app.db.one(
      "SELECT count(*)::int n FROM email_intake_events WHERE workspace_id=$1",
      [w.ws.id],
    ))!.n,
    1,
  );
  await app.ticketEmail.receive(w.ws.id, w.authorization, {
    ...p,
    Headers: [{ Name: "Message-ID", Value: `<${uid()}@sender.example.test>` }],
  });
  assert.equal(
    (await app.db.one(
      "SELECT count(*)::int n FROM conversations WHERE workspace_id=$1",
      [w.ws.id],
    ))!.n,
    2,
  );
});

test("outgoing definite failure and uncertain sends have controlled recovery without duplicating messages", async () => {
  const w = await setup();
  const x = await accept(w, envelope(w));
  const reply = await app.message(w.owner, x.event.conversation_id, {
    body: "A public response",
    requestKey: uid(),
  });
  const row = (await app.db.one(
    "SELECT * FROM ticket_emails WHERE message_id=$1",
    [reply.id],
  ))!;
  let transportState = "failed",
    sends = 0;
  const service = new TicketEmail(
    app.db,
    app.connections,
    async () => {
      sends++;
      if (transportState === "failed")
        throw Object.assign(new Error("Connection refused"), {
          code: "ECONNREFUSED",
        });
      if (transportState === "unknown")
        throw new Error("Interrupted after DATA");
    },
    (p, id, input) => app.message(p, id, input),
    app.attachments,
  );
  await service.deliver(w.ws.id, row.id);
  assert.equal(
    (await app.db.one("SELECT status FROM ticket_emails WHERE id=$1", [
      row.id,
    ]))!.status,
    "failed",
  );
  await service.deliver(w.ws.id, row.id);
  assert.equal(sends, 1);
  await assert.rejects(
    service.retry({ ...w.owner, role: "agent" }, row.id),
    /Permission/,
  );
  await service.retry(w.owner, row.id);
  transportState = "unknown";
  await service.deliver(w.ws.id, row.id);
  assert.equal(
    (await app.db.one("SELECT status FROM ticket_emails WHERE id=$1", [
      row.id,
    ]))!.status,
    "unknown",
  );
  await service.retry(w.owner, row.id);
  transportState = "ok";
  await service.deliver(w.ws.id, row.id);
  assert.equal(
    (await app.db.one("SELECT status FROM ticket_emails WHERE id=$1", [
      row.id,
    ]))!.status,
    "sent",
  );
  assert.equal(
    (await app.db.one(
      "SELECT count(*)::int n FROM messages WHERE conversation_id=$1",
      [x.event.conversation_id],
    ))!.n,
    2,
  );
  assert.equal(sends, 3);
});

test("retention removes original source and sender metadata while durable receipts still deduplicate", async () => {
  const w = await setup(),
    payload = envelope(w),
    result = await accept(w, payload);
  await app.db.pool.query(
    "UPDATE email_intake_events SET created_at=now()-interval '400 days' WHERE id=$1",
    [result.event.id],
  );
  await app.ticketEmail.intake.recover();
  const expired = (await app.db.one(
    "SELECT * FROM email_intake_events WHERE id=$1",
    [result.event.id],
  ))!;
  assert.equal(expired.payload_ciphertext, null);
  assert.equal(expired.sender, "");
  assert.equal(expired.subject, "");
  await assert.rejects(
    app.ticketEmail.intake.source(w.owner, result.event.id),
    /retained|available|expired/i,
  );
  const duplicate = await accept(w, payload);
  assert.equal(duplicate.event.conversation_id, result.event.conversation_id);
  assert.equal(
    (await app.db.one(
      "SELECT count(*)::int n FROM conversations WHERE workspace_id=$1",
      [w.ws.id],
    ))!.n,
    1,
  );
});

test("email administration rechecks live authority after a concurrent membership revocation", async () => {
  const w = await setup(),
    before = (await app.db.one(
      "SELECT revision FROM connections WHERE workspace_id=$1 AND provider='ticket_email'",
      [w.ws.id],
    ))!;
  const q = await app.db.pool.connect();
  await q.query("BEGIN");
  try {
    await q.query(
      "UPDATE memberships SET disabled=true WHERE workspace_id=$1 AND user_id=$2",
      [w.ws.id, w.owner.userId],
    );
    const pending = app.ticketEmail.configure(w.owner, { address: w.address });
    const denied = assert.rejects(pending, /no longer available/);
    await q.query("COMMIT");
    await denied;
  } finally {
    await q.query("ROLLBACK");
    q.release();
  }
  assert.equal(
    (await app.db.one(
      "SELECT revision FROM connections WHERE workspace_id=$1 AND provider='ticket_email'",
      [w.ws.id],
    ))!.revision,
    before.revision,
  );
  await assert.rejects(
    app.ticketEmail.settings(w.owner),
    /no longer available/,
  );
  await assert.rejects(
    app.ticketEmail.disconnect(w.owner),
    /no longer available/,
  );
});
