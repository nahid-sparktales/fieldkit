import { test, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import { Platform } from "../packages/platform/src/platform.js";
import { uid } from "../packages/platform/src/db.js";
import { conversation, type Principal } from "../packages/platform/src/auth.js";
import {
  customerTicketAccess,
  customerConversationVisibility,
  customerMessageVisibility,
} from "../packages/platform/src/customer-access.js";
import { unseal } from "../packages/platform/src/security.js";
import {
  testConfig,
  resetDatabase,
  workspace,
  TestModel,
  TestProviders,
} from "./helpers.js";
const config = testConfig(4383);
config.FIELDKIT_DATA = ".fieldkit/collaboration-tests";
config.FIELDKIT_CLAM_HOST = "test-scanner";
const sent: any[][] = [];
let rejectAddress = "",
  uncertain = false;
const app = new Platform(config, {
  model: new TestModel(),
  fetch: new TestProviders().fetch,
  scanner: {
    health: async () => ({
      engine: "Test scanner",
      signaturesAt: new Date().toISOString(),
    }),
    scan: async (bytes) => ({
      engine: "Test scanner",
      signaturesAt: new Date().toISOString(),
      scannedAt: new Date().toISOString(),
      clean: !bytes.includes(Buffer.from("malware")),
    }),
  },
  mailer: async (...args) => {
    if (args[0] === rejectAddress) {
      if (uncertain) {
        sent.push(args);
        throw new Error("Synthetic uncertain delivery");
      }
      throw Object.assign(new Error("Synthetic rejection"), {
        code: "EENVELOPE",
      });
    }
    sent.push(args);
  },
});
before(async () => {
  await resetDatabase(config.DATABASE_URL);
  await app.migrate();
});
after(() => app.close());
async function setup() {
  const w = await workspace(app);
  const c = await app.newConversation(w.customer, {
    channelId: w.channelId,
    body: "Original private history",
    subject: "Customer support",
    requestKey: uid(),
  });
  const emailSetup = await app.ticketEmail.configure(w.owner, {
    address: `support@${w.ws.id}.example.test`,
  });
  return { ...w, c, emailSetup };
}
async function person(w: any, email: string): Promise<Principal> {
  const userId = uid(),
    contactId = uid();
  await app.db.pool.query(
    'INSERT INTO "user"(id,name,email,"emailVerified","createdAt","updatedAt") VALUES($1,$2,$3,true,now(),now())',
    [userId, "Synthetic customer", email],
  );
  await app.db.pool.query(
    "INSERT INTO contacts(id,workspace_id,user_id,email,verified) VALUES($1,$2,$3,$4,true)",
    [contactId, w.ws.id, userId, email],
  );
  return { workspaceId: w.ws.id, role: "customer", userId, contactId };
}
async function inviteSecret(w: any, id: string) {
  const i = (await app.db.one(
    "SELECT token_ciphertext FROM collaboration_invitations WHERE id=$1",
    [id],
  ))!;
  return unseal<string>(
    config.FIELDKIT_ENCRYPTION_KEY,
    `collaboration:${w.ws.id}:${id}`,
    i.token_ciphertext,
  );
}
async function participant(w: any, address = `cc-${uid()}@example.test`) {
  const row = await app.collaboration.addParticipant(w.owner, w.c.id, {
    email: address,
    confirmFutureOnly: true,
  });
  return { row, address };
}
async function publicReply(
  w: any,
  body = "Public reply",
  attachments: string[] = [],
) {
  const m = await app.message(w.owner, w.c.id, {
    body,
    attachments,
    requestKey: uid(),
  });
  const e = (await app.db.one(
    "SELECT * FROM ticket_emails WHERE message_id=$1",
    [m.id],
  ))!;
  return { m, e };
}
async function copies(id: string) {
  return sent.filter((s) => s[3]?.messageId?.includes(id));
}
async function upload(w: any, body = "Log file", privateNote = false) {
  const bytes = Buffer.from(body),
    f = await app.attachments.reserve(w.owner, {
      conversationId: w.c.id,
      name: "log.txt",
      size: bytes.length,
      private: privateNote,
      requestKey: uid(),
    });
  await app.attachments.upload(
    w.owner,
    f.id,
    (async function* () {
      yield bytes;
    })(),
  );
  return f;
}

test("existing tickets stay private; organization managers gain only explicitly shared company history and lose it on revocation", async () => {
  const w = await setup(),
    org = await app.collaboration.saveOrganization(w.owner, { name: "Acme" }),
    manager = await person(w, `manager-${uid()}@example.test`);
  const invitation = await app.collaboration.inviteOrganization(
    w.owner,
    org!.id,
    {
      email: (await app.db.one("SELECT email FROM contacts WHERE id=$1", [
        manager.contactId,
      ]))!.email,
      role: "manager",
    },
  );
  await assert.rejects(conversation(app.db, manager, w.c.id), /not found/);
  await app.collaboration.invitation(
    manager,
    await inviteSecret(w, invitation.id),
    true,
  );
  await assert.rejects(conversation(app.db, manager, w.c.id), /not found/);
  await app.collaboration.share(w.owner, w.c.id, {
    organizationId: org!.id,
    sharing: "company",
    confirmHistory: true,
  });
  const c = await conversation(app.db, manager, w.c.id),
    access = await customerTicketAccess(app.db, manager, c);
  assert.equal(access.read, true);
  assert.equal(access.reply, true);
  assert.equal(access.visibleSince, null);
  assert.equal(access.requester, false);
  assert.equal(access.changeStatus, false);
  await assert.rejects(
    app.customerStatus(manager, w.c.id, "resolved"),
    /not found/,
  );
  await assert.rejects(
    app.productivity.updateFields(manager, w.c.id, { values: {} }),
    /not found/,
  );
  await app.message(manager, w.c.id, {
    body: "Company manager reply",
    requestKey: uid(),
  });
  assert.equal(
    (await app.db.one("SELECT mode FROM conversations WHERE id=$1", [w.c.id]))!
      .mode,
    "human",
  );
  await app.collaboration.removeMember(w.owner, org!.id, manager.contactId!);
  await assert.rejects(conversation(app.db, manager, w.c.id), /not found/);
});
test("organization members do not inherit manager scope, domain membership or another workspace invitation", async () => {
  const w = await setup(),
    other = await setup(),
    org = await app.collaboration.saveOrganization(w.owner, {
      name: "Members",
    }),
    member = await person(w, `member-${uid()}@example.test`);
  const address = (await app.db.one("SELECT email FROM contacts WHERE id=$1", [
      member.contactId,
    ]))!.email,
    i = await app.collaboration.inviteOrganization(w.owner, org!.id, {
      email: address,
      role: "member",
    }),
    secret = await inviteSecret(w, i.id);
  await assert.rejects(
    app.collaboration.invitation(
      { ...member, workspaceId: other.ws.id },
      secret,
      true,
    ),
    /unavailable/,
  );
  await app.collaboration.invitation(member, secret, true);
  await app.collaboration.share(w.owner, w.c.id, {
    organizationId: org!.id,
    sharing: "company",
    confirmHistory: true,
  });
  await assert.rejects(conversation(app.db, member, w.c.id), /not found/);
  await assert.rejects(
    app.collaboration.share(w.owner, w.c.id, {
      organizationId: other.ws.id,
      sharing: "company",
      confirmHistory: true,
    }),
  );
});
test("participant invitation requires matching verified portal identity and grants future-only messages without merging contact mappings", async () => {
  const w = await setup(),
    p = await participant(w),
    account = await person(w, p.address),
    wrong = await person(w, `wrong-${uid()}@example.test`),
    secret = await inviteSecret(w, p.row.invitation.id);
  await assert.rejects(
    app.collaboration.invitation(wrong, secret, true),
    /invited email/,
  );
  await assert.rejects(conversation(app.db, account, w.c.id), /not found/);
  await app.db.pool.query("UPDATE contacts SET verified=false WHERE id=$1", [
    account.contactId,
  ]);
  await assert.rejects(
    app.collaboration.invitation(account, secret, true),
    /verified/,
  );
  await app.db.pool.query("UPDATE contacts SET verified=true WHERE id=$1", [
    account.contactId,
  ]);
  await app.collaboration.invitation(account, secret, true);
  const next = await publicReply(w);
  const c = await conversation(app.db, account, w.c.id),
    access = await customerTicketAccess(app.db, account, c);
  assert.ok(access.visibleSince);
  assert.equal(access.updateFields, false);
  const params: unknown[] = [w.ws.id, w.c.id],
    visible = customerMessageVisibility(account, "c", "m", params);
  const messages = await app.db.rows(
    `SELECT m.id FROM messages m JOIN conversations c ON c.id=m.conversation_id WHERE c.workspace_id=$1 AND c.id=$2 AND (${visible})`,
    params,
  );
  assert.deepEqual(
    messages.map((m) => m.id),
    [next.m.id],
  );
  const fields = await app.productivity.ticketFields(account, w.c.id);
  assert.deepEqual(fields.values, {});
  assert.equal(fields.editable, false);
  assert.notEqual(account.contactId, p.row.participant.contact_id);
  assert.equal(
    (await app.db.one("SELECT verified FROM contacts WHERE id=$1", [
      p.row.participant.contact_id,
    ]))!.verified,
    false,
  );
  const queryParams: unknown[] = [w.ws.id],
    scope = customerConversationVisibility(account, "c", queryParams);
  assert.equal(
    (
      await app.db.rows(
        `SELECT c.id FROM conversations c WHERE c.workspace_id=$1 AND (${scope})`,
        queryParams,
      )
    ).length,
    1,
  );
  await app.collaboration.removeParticipant(
    w.owner,
    w.c.id,
    p.row.participant.id,
  );
  await assert.rejects(conversation(app.db, account, w.c.id), /not found/);
});
test("public email audience is snapshotted at commit and each participant gets a different reply token", async () => {
  const w = await setup(),
    first = await participant(w),
    reply = await publicReply(w),
    later = await participant(w);
  await Promise.all([
    app.ticketEmail.deliver(w.ws.id, reply.e.id),
    app.ticketEmail.deliver(w.ws.id, reply.e.id),
  ]);
  const delivered = await copies(reply.m.id);
  assert.equal(delivered.length, 2);
  assert.ok(delivered.some((s) => s[0] === first.address));
  assert.ok(!delivered.some((s) => s[0] === later.address));
  assert.equal(new Set(delivered.map((s) => s[3].replyTo)).size, 2);
  assert.ok(delivered.every((s) => !s[3].cc && !s[3].bcc));
});
test("only failed recipients retry; successful copies are not resent and uncertain delivery is never automatically retried", async () => {
  const w = await setup(),
    p = await participant(w),
    reply = await publicReply(w);
  rejectAddress = p.address;
  uncertain = false;
  await app.ticketEmail.deliver(w.ws.id, reply.e.id);
  assert.equal(
    (await app.db.one("SELECT status FROM ticket_emails WHERE id=$1", [
      reply.e.id,
    ]))!.status,
    "failed",
  );
  rejectAddress = "";
  await app.ticketEmail.retry(w.owner, reply.e.id);
  await app.ticketEmail.deliver(w.ws.id, reply.e.id);
  let out = await copies(reply.m.id);
  assert.equal(out.length, 2);
  assert.equal(out.filter((s) => s[0] === "customer@example.test").length, 1);
  const second = await publicReply(w);
  rejectAddress = p.address;
  uncertain = true;
  await app.ticketEmail.deliver(w.ws.id, second.e.id);
  await app.ticketEmail.deliver(w.ws.id, second.e.id);
  out = await copies(second.m.id);
  assert.equal(out.filter((s) => s[0] === p.address).length, 1);
  assert.equal(
    (await app.db.one("SELECT status FROM ticket_emails WHERE id=$1", [
      second.e.id,
    ]))!.status,
    "unknown",
  );
  rejectAddress = "";
  uncertain = false;
});
test("revoked participants receive no pending notification and old reply tokens fail closed", async () => {
  const w = await setup(),
    p = await participant(w),
    first = await publicReply(w);
  await app.ticketEmail.deliver(w.ws.id, first.e.id);
  const tokenCopy = (await copies(first.m.id)).find((s) => s[0] === p.address)!;
  const pending = await publicReply(w);
  await app.collaboration.removeParticipant(
    w.owner,
    w.c.id,
    p.row.participant.id,
  );
  await app.ticketEmail.deliver(w.ws.id, pending.e.id);
  assert.ok(!(await copies(pending.m.id)).some((s) => s[0] === p.address));
  const auth = `Basic ${Buffer.from(`fieldkit:${w.emailSetup.password}`).toString("base64")}`,
    received = await app.ticketEmail.receive(w.ws.id, auth, {
      MessageID: uid(),
      OriginalRecipient: tokenCopy[3].replyTo,
      FromFull: { Email: p.address },
      TextBody: "Revoked reply",
    });
  assert.equal(received.status, "rejected");
});
test("participant inbound reply is attributed to that contact, stops AI, and cannot use another participant token", async () => {
  const w = await setup(),
    p = await participant(w),
    reply = await publicReply(w);
  await app.ticketEmail.deliver(w.ws.id, reply.e.id);
  const out = (await copies(reply.m.id)).find((s) => s[0] === p.address)!,
    auth = `Basic ${Buffer.from(`fieldkit:${w.emailSetup.password}`).toString("base64")}`;
  await app.db.pool.query("UPDATE conversations SET mode='agent' WHERE id=$1", [
    w.c.id,
  ]);
  const result = await app.ticketEmail.receive(w.ws.id, auth, {
    MessageID: uid(),
    OriginalRecipient: out[3].replyTo,
    FromFull: { Email: p.address },
    TextBody: "I am a collaborator",
  });
  assert.equal(result.status, "received");
  const m = (await app.db.one(
    "SELECT * FROM messages WHERE conversation_id=$1 AND body='I am a collaborator'",
    [w.c.id],
  ))!;
  assert.equal(m.actor_contact_id, p.row.participant.contact_id);
  assert.notEqual(m.actor_contact_id, w.contactId);
  assert.equal(
    (await app.db.one("SELECT mode FROM conversations WHERE id=$1", [w.c.id]))!
      .mode,
    "human",
  );
  const reactivated = (await app.db.one(
    "UPDATE conversations SET mode='agent',revision=revision+1 WHERE id=$1 RETURNING *",
    [w.c.id],
  ))!;
  const run = {
    workspace_id: w.ws.id,
    conversation_id: w.c.id,
    revision: reactivated.revision,
    state: {},
    status: "queued",
  };
  assert.equal(await app.agent.current(run), null);
  assert.equal(
    (await app.db.one("SELECT mode FROM conversations WHERE id=$1", [w.c.id]))!
      .mode,
    "human",
  );
  const bad = await app.ticketEmail.receive(w.ws.id, auth, {
    MessageID: uid(),
    OriginalRecipient: out[3].replyTo,
    FromFull: { Email: "different@example.test" },
    TextBody: "Wrong sender",
  });
  assert.equal(bad.status, "rejected");
});
test("outbound attachments wait for scanning and ship only the exact scanned bytes; private or blocked files never leak", async () => {
  const w = await setup();
  await app.attachments.settings(w.owner, { enabled: true });
  const f = await upload(w, "Safe outbound file"),
    reply = await publicReply(w, "Files attached", [f.id]);
  await app.ticketEmail.deliver(w.ws.id, reply.e.id);
  assert.equal(
    (await app.db.one("SELECT status FROM ticket_emails WHERE id=$1", [
      reply.e.id,
    ]))!.status,
    "waiting_files",
  );
  assert.equal((await copies(reply.m.id)).length, 0);
  await app.attachments.scan(w.ws.id, f.id);
  await app.ticketEmail.deliver(w.ws.id, reply.e.id);
  const out = (await copies(reply.m.id))[0];
  assert.equal(out[3].attachments.length, 1);
  assert.equal(out[3].attachments[0].content.toString(), "Safe outbound file");
  const privateFile = await upload(w, "Private note file", true);
  await assert.rejects(
    publicReply(w, "Wrong visibility", [privateFile.id]),
    /associated/,
  );
  const blocked = await upload(w, "malware"),
    bad = await publicReply(w, "File", [blocked.id]);
  await app.attachments.scan(w.ws.id, blocked.id);
  await app.ticketEmail.deliver(w.ws.id, bad.e.id);
  assert.equal((await copies(bad.m.id)).length, 0);
  assert.equal(
    (await app.db.one("SELECT status FROM ticket_emails WHERE id=$1", [
      bad.e.id,
    ]))!.status,
    "failed",
  );
});
test("future-only participant cannot download old files, can upload a new file, and loses file access after removal", async () => {
  const w = await setup();
  await app.attachments.settings(w.owner, { enabled: true });
  const old = await upload(w, "Earlier file");
  await app.attachments.scan(w.ws.id, old.id);
  await publicReply(w, "Earlier file", [old.id]);
  const p = await participant(w),
    account = await person(w, p.address);
  await app.collaboration.invitation(
    account,
    await inviteSecret(w, p.row.invitation.id),
    true,
  );
  await assert.rejects(app.attachments.download(account, old.id), /not found/);
  const bytes = Buffer.from("Participant log"),
    f = await app.attachments.reserve(account, {
      conversationId: w.c.id,
      name: "participant.txt",
      size: bytes.length,
      requestKey: uid(),
    });
  await app.attachments.upload(
    account,
    f.id,
    (async function* () {
      yield bytes;
    })(),
  );
  await app.message(account, w.c.id, {
    body: "My log",
    attachments: [f.id],
    requestKey: uid(),
  });
  await app.attachments.scan(w.ws.id, f.id);
  assert.equal(
    (await app.attachments.download(account, f.id)).bytes.toString(),
    "Participant log",
  );
  await app.collaboration.removeParticipant(
    w.owner,
    w.c.id,
    p.row.participant.id,
  );
  await assert.rejects(app.attachments.download(account, f.id), /not found/);
});
test("followers are current staff only and private notes never go to external participants", async () => {
  const w = await setup(),
    p = await participant(w),
    staffAccount = await person(w, `agent-${uid()}@example.test`);
  await app.db.pool.query(
    "INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,'agent')",
    [w.ws.id, staffAccount.userId],
  );
  const agent = { ...staffAccount, role: "agent" as const };
  await app.collaboration.follow(agent, w.c.id, {
    following: true,
    includeNotes: true,
  });
  const note = await app.message(
      w.owner,
      w.c.id,
      { body: "Internal secret", requestKey: uid() },
      true,
    ),
    mail = (await app.db.one(
      "SELECT id FROM ticket_emails WHERE message_id=$1",
      [note.id],
    ))!;
  await app.ticketEmail.deliver(w.ws.id, mail.id);
  const out = await copies(note.id);
  assert.equal(out.length, 1);
  assert.match(out[0][1], /Internal note/);
  assert.notEqual(out[0][0], p.address);
  const reply = await publicReply(w);
  await app.db.pool.query(
    "UPDATE memberships SET disabled=true WHERE workspace_id=$1 AND user_id=$2",
    [w.ws.id, agent.userId],
  );
  await app.ticketEmail.deliver(w.ws.id, reply.e.id);
  assert.ok(!(await copies(reply.m.id)).some((s) => s[0] === out[0][0]));
});
test("inbound copied addresses are review suggestions, never automatic participants", async () => {
  const w = await setup(),
    auth = `Basic ${Buffer.from(`fieldkit:${w.emailSetup.password}`).toString("base64")}`,
    payload = {
      MessageID: uid(),
      OriginalRecipient: `support@${w.ws.id}.example.test`,
      FromFull: { Email: "new-requester@example.test" },
      CcFull: [{ Email: "untrusted-copy@example.test" }],
      TextBody: "A new issue",
    };
  const result = await app.ticketEmail.receive(w.ws.id, auth, payload);
  assert.equal(result.status, "received");
  const e = (await app.db.one(
    "SELECT conversation_id FROM email_intake_events WHERE provider_id=$1",
    [payload.MessageID],
  ))!;
  assert.equal(
    (await app.db.one(
      "SELECT count(*)::int n FROM ticket_participants WHERE conversation_id=$1",
      [e.conversation_id],
    ))!.n,
    0,
  );
  assert.equal(
    (await app.db.one(
      "SELECT email FROM email_cc_suggestions WHERE conversation_id=$1",
      [e.conversation_id],
    ))!.email,
    "untrusted-copy@example.test",
  );
});
test("invitation outbox is durable and idempotent and revoked invitation cannot be accepted", async () => {
  const w = await setup(),
    p = await participant(w),
    account = await person(w, p.address),
    secret = await inviteSecret(w, p.row.invitation.id);
  await Promise.all([
    app.collaboration.deliverInvitation(w.ws.id, p.row.invitation.id),
    app.collaboration.deliverInvitation(w.ws.id, p.row.invitation.id),
  ]);
  assert.equal(
    sent.filter((s) => s[3]?.messageId?.includes(p.row.invitation.id)).length,
    1,
  );
  await app.collaboration.removeParticipant(
    w.owner,
    w.c.id,
    p.row.participant.id,
  );
  await assert.rejects(
    app.collaboration.invitation(account, secret, true),
    /unavailable/,
  );
});

test("a reply waiting behind participant approval includes its recipient and public event after the grant cutoff", async () => {
  const w = await setup();
  let release!: () => void, holding!: () => void;
  const barrier = new Promise<void>((resolve) => {
      release = resolve;
    }),
    ready = new Promise<void>((resolve) => {
      holding = resolve;
    });
  const original = app.collaboration.lock.bind(app.collaboration);
  const instrument = mock.method(
    app.collaboration,
    "lock",
    async (
      q: import("../packages/platform/src/db.js").Queryable,
      ws: string,
    ) => {
      await original(q, ws);
      holding();
      await barrier;
    },
  );
  let granting: ReturnType<typeof participant> | undefined,
    replying: ReturnType<typeof publicReply> | undefined;
  try {
    granting = participant(w);
    await ready;
    replying = publicReply(w, "Reply committed after approval");
    let waiting = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      waiting = !!(await app.db.one(
        "SELECT 1 FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid WHERE a.datname=current_database() AND l.locktype='advisory' AND NOT l.granted LIMIT 1",
      ));
      if (waiting) break;
      await new Promise((r) => setTimeout(r, 5));
    }
    assert.equal(
      waiting,
      true,
      "Reply must actually wait behind the grant transaction",
    );
    release();
    const [p, reply] = await Promise.all([granting, replying]);
    assert.ok(
      new Date(reply.m.created_at) >= new Date(p.row.participant.joined_at),
    );
    const event = (await app.db.one(
      "SELECT created_at FROM events WHERE workspace_id=$1 AND conversation_id=$2 AND kind='message.created' AND data->>'messageId'=$3",
      [w.ws.id, w.c.id, reply.m.id],
    ))!;
    assert.ok(
      new Date(event.created_at) >= new Date(p.row.participant.joined_at),
    );
    await app.ticketEmail.deliver(w.ws.id, reply.e.id);
    assert.ok((await copies(reply.m.id)).some((s) => s[0] === p.address));
  } finally {
    release();
    instrument.mock.restore();
    await Promise.allSettled([granting, replying].filter(Boolean));
  }
});

test("reissuing an invitation revokes its earlier acceptance token and expiry never grants access", async () => {
  const w = await setup(),
    p = await participant(w),
    account = await person(w, p.address),
    old = await inviteSecret(w, p.row.invitation.id);
  await app.db.pool.query(
    "UPDATE collaboration_invitations SET expires_at=now()-interval '1 minute' WHERE id=$1",
    [p.row.invitation.id],
  );
  await assert.rejects(
    app.collaboration.invitation(account, old, true),
    /unavailable/,
  );
  const fresh = await app.collaboration.resendInvitation(
    w.owner,
    p.row.invitation.id,
  );
  await assert.rejects(
    app.collaboration.invitation(account, old, true),
    /unavailable/,
  );
  await app.collaboration.invitation(
    account,
    await inviteSecret(w, fresh.id),
    true,
  );
  assert.equal(
    (
      await customerTicketAccess(
        app.db,
        account,
        await conversation(app.db, account, w.c.id),
      )
    ).reply,
    true,
  );
});

test("merged source intake fields resolve canonical reads and reject source writes", async () => {
  const w = await setup(),
    target = await app.newConversation(w.customer, {
      channelId: w.channelId,
      body: "Target",
      requestKey: uid(),
    });
  await app.db.pool.query(
    "UPDATE conversations SET merged_into_id=$2,status='resolved',mode='human' WHERE id=$1",
    [w.c.id, target.id],
  );
  assert.deepEqual(
    await app.productivity.ticketFields(w.owner, w.c.id),
    await app.productivity.ticketFields(w.owner, target.id),
  );
  await assert.rejects(
    app.productivity.updateFields(w.owner, w.c.id, { values: {} }),
    /merged/,
  );
});

test("merged attachments require both canonical authority and their source-specific history grant", async () => {
  const w = await setup();
  await app.attachments.settings(w.owner, { enabled: true });
  const target = await app.newConversation(w.customer, {
    channelId: w.channelId,
    body: "Target history",
    requestKey: uid(),
  });
  const address = `merged-files-${uid()}@example.test`,
    targetParticipant = await app.collaboration.addParticipant(
      w.owner,
      target.id,
      { email: address, confirmFutureOnly: true },
    );
  const old = await upload(w, "Source file before source invitation");
  await app.attachments.scan(w.ws.id, old.id);
  await publicReply(w, "Source file", [old.id]);
  const sourceParticipant = await app.collaboration.addParticipant(
      w.owner,
      w.c.id,
      { email: address, confirmFutureOnly: true },
    ),
    account = await person(w, address);
  await app.collaboration.invitation(
    account,
    await inviteSecret(w, targetParticipant.invitation.id),
    true,
  );
  await app.collaboration.invitation(
    account,
    await inviteSecret(w, sourceParticipant.invitation.id),
    true,
  );
  await app.db.pool.query(
    "UPDATE conversations SET merged_into_id=$2,status='resolved',mode='human' WHERE id=$1",
    [w.c.id, target.id],
  );
  assert.equal((await app.attachments.list(account, target.id)).length, 0);
  await assert.rejects(app.attachments.download(account, old.id), /not found/);
  const after = await upload({ ...w, c: target }, "Canonical shared file");
  await app.attachments.scan(w.ws.id, after.id);
  await publicReply({ ...w, c: target }, "New file", [after.id]);
  assert.equal(
    (await app.attachments.download(account, after.id)).bytes.toString(),
    "Canonical shared file",
  );
});

test("old private email routes survive merge and recovery after a pre-merge message commit does not duplicate correspondence", async () => {
  const w = await setup(),
    reply = await publicReply(w, "Source mail before merge");
  await app.ticketEmail.deliver(w.ws.id, reply.e.id);
  const copy = (await copies(reply.m.id)).find(
      (s) => s[0] === "customer@example.test",
    )!,
    auth = `Basic ${Buffer.from(`fieldkit:${w.emailSetup.password}`).toString("base64")}`;
  const payload = {
    MessageID: uid(),
    OriginalRecipient: copy[3].replyTo,
    FromFull: { Email: "customer@example.test" },
    TextBody: "Committed inbound before merge",
    Headers: [{ Name: "In-Reply-To", Value: copy[3].messageId }],
  };
  const intake = app.ticketEmail.intake as any,
    append = intake.append.bind(intake),
    interrupted = mock.method(intake, "append", async (...args: any[]) => {
      await append(...args);
      throw new Error("Synthetic crash after message commit");
    });
  try {
    await app.ticketEmail.receive(w.ws.id, auth, payload);
  } finally {
    interrupted.mock.restore();
  }
  const receipt = (await app.db.one(
      "SELECT * FROM email_intake_events WHERE workspace_id=$1 AND provider_id=$2",
      [w.ws.id, payload.MessageID],
    ))!,
    message = (await app.db.one(
      "SELECT id FROM messages WHERE conversation_id=$1 AND body='Committed inbound before merge'",
      [w.c.id],
    ))!;
  const target = await app.newConversation(w.customer, {
    channelId: w.channelId,
    body: "Canonical ticket",
    requestKey: uid(),
  });
  await app.control(w.owner, target.id, { mode: "human" });
  const preview = await app.ticketOperations.preview(
    w.owner,
    w.c.id,
    target.id,
  );
  await app.ticketOperations.merge(w.owner, w.c.id, {
    targetId: target.id,
    sourceVersion: preview.source.editVersion,
    targetVersion: preview.target.editVersion,
    requestKey: uid(),
  });
  await app.ticketEmail.intake.retry(w.owner, receipt.id);
  await app.ticketEmail.intake.process(w.ws.id, receipt.id);
  const replayed = (await app.db.one(
    "SELECT * FROM email_intake_events WHERE id=$1",
    [receipt.id],
  ))!;
  assert.equal(replayed.status, "received");
  assert.equal(replayed.message_id, message.id);
  assert.equal(replayed.conversation_id, w.c.id);
  assert.equal(
    (await app.db.one(
      "SELECT count(*)::int n FROM messages WHERE workspace_id=$1 AND body='Committed inbound before merge'",
      [w.ws.id],
    ))!.n,
    1,
  );
  const newReply = await app.ticketEmail.receive(w.ws.id, auth, {
    ...payload,
    MessageID: uid(),
    TextBody: "New reply through old private address",
  });
  assert.equal(newReply.status, "received");
  assert.equal(
    (await app.db.one(
      "SELECT conversation_id FROM messages WHERE workspace_id=$1 AND body='New reply through old private address'",
      [w.ws.id],
    ))!.conversation_id,
    target.id,
  );
});
