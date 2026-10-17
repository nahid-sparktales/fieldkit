import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../apps/api/server.js";
import { uid } from "../packages/platform/src/db.js";
import { unseal } from "../packages/platform/src/security.js";
import type { Principal } from "../packages/platform/src/auth.js";
import {
  resetDatabase,
  testConfig,
  workspace,
  TestModel,
  TestProviders,
} from "./helpers.js";
const config = testConfig(4388);
let server: Awaited<ReturnType<typeof createApp>>,
  base: string,
  ownerAccount: { id: string; email: string; cookie: string };
const password = "isolated-access-test-password";
async function request(
  path: string,
  account?: { cookie: string },
  data?: unknown,
  method?: string,
) {
  return fetch(base + path, {
    method: method ?? (data === undefined ? "GET" : "POST"),
    headers: {
      Origin: config.FIELDKIT_URL,
      "Content-Type": "application/json",
      ...(account
        ? { Cookie: account.cookie, "X-Fieldkit-Audience": "customer" }
        : {}),
    },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
}
async function account() {
  await server.app.db.pool.query('DELETE FROM "rateLimit"');
  const email = `access-${uid()}@example.test`,
    sign = await request("/api/auth/sign-up/email", undefined, {
      email,
      password,
      name: "Access fixture",
    });
  assert.equal(sign.status, 200, await sign.clone().text());
  const user = ((await sign.json()) as any).user;
  await server.app.db.pool.query(
    'UPDATE "user" SET "emailVerified"=true WHERE id=$1',
    [user.id],
  );
  const login = await request("/api/auth/sign-in/email", undefined, {
    email,
    password,
  });
  assert.equal(login.status, 200, await login.clone().text());
  return {
    id: user.id as string,
    email,
    cookie: login.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; "),
  };
}
before(async () => {
  await resetDatabase(config.DATABASE_URL);
  server = await createApp(config, {
    migrate: true,
    workers: false,
    model: new TestModel(),
    fetch: new TestProviders().fetch,
    mailer: async () => {},
  });
  await new Promise<void>((r) => server.server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.server.address() as any).port}`;
  ownerAccount = await account();
});
after(async () => {
  await new Promise<void>((r) => server.server.close(() => r()));
  await server.app.close();
});
async function fixture() {
  const w = await workspace(server.app, ownerAccount.id);
  return { ...w, path: `/v2/workspaces/${w.ws.id}` };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function person(w: Fixture) {
  const a = await account(),
    contactId = uid();
  await server.app.db.pool.query(
    "INSERT INTO contacts(id,workspace_id,user_id,name,email,verified) VALUES($1,$2,$3,'Customer collaborator',$4,true)",
    [contactId, w.ws.id, a.id, a.email],
  );
  return {
    ...a,
    p: {
      workspaceId: w.ws.id,
      userId: a.id,
      contactId,
      role: "customer",
    } as Principal,
  };
}
async function ticket(w: Fixture, body: string) {
  return server.app.newConversation(w.customer, {
    channelId: w.channelId,
    subject: body,
    body,
    requestKey: uid(),
  });
}
async function reply(w: Fixture, id: string, body: string, note = false) {
  return server.app.message(w.owner, id, { body, requestKey: uid() }, note);
}
async function join(
  w: Fixture,
  id: string,
  p: Awaited<ReturnType<typeof person>>,
) {
  const added = await server.app.collaboration.addParticipant(w.owner, id, {
    email: p.email,
    confirmFutureOnly: true,
  });
  const invitation = (await server.app.db.one(
    "SELECT * FROM collaboration_invitations WHERE id=$1",
    [added.invitation.id],
  ))!;
  const secret = unseal<string>(
    config.FIELDKIT_ENCRYPTION_KEY,
    `collaboration:${w.ws.id}:${invitation.id}`,
    invitation.token_ciphertext,
  );
  await server.app.collaboration.invitation(p.p, secret, true);
  return added.participant;
}
async function json(path: string, p: { cookie: string }) {
  const r = await request(path, p);
  assert.equal(r.status, 200, await r.clone().text());
  return r.json() as Promise<any>;
}
async function events(path: string, p: { cookie: string }, untilId: string) {
  const abort = new AbortController(),
    timer = setTimeout(() => abort.abort(), 5000);
  let text = "";
  try {
    const r = await fetch(base + path + "?after=0", {
      headers: { Cookie: p.cookie, "X-Fieldkit-Audience": "customer" },
      signal: abort.signal,
    });
    if (r.status !== 200) assert.fail(await r.text());
    const reader = r.body!.getReader();
    while (!text.includes(`id: ${untilId}\n`)) {
      const part = await reader.read();
      if (part.done) break;
      text += new TextDecoder().decode(part.value);
    }
    await reader.cancel();
    return text
      .split("\n")
      .filter((l) => l.startsWith("data: "))
      .map((l) => JSON.parse(l.slice(6)));
  } finally {
    clearTimeout(timer);
    abort.abort();
  }
}

test("participant HTTP list, detail, and event replay reveal only future public correspondence", async () => {
  const w = await fixture(),
    c = await ticket(w, "Hidden before invitation"),
    p = await person(w);
  const oldMessage = (await server.app.db.one(
    "SELECT id FROM messages WHERE conversation_id=$1",
    [c.id],
  ))!.id;
  const oldEvent = (await server.app.db.one(
    "SELECT id FROM events WHERE conversation_id=$1 AND public ORDER BY id DESC LIMIT 1",
    [c.id],
  ))!.id;
  assert.equal(
    (await request(`${w.path}/conversations/${c.id}`, p)).status,
    404,
  );
  const participant = await join(w, c.id, p);
  let list = (await json(`${w.path}/conversations?scope=mine`, p))
    .conversations;
  assert.equal(list.length, 1);
  assert.equal(list[0].last_message, null, "No pre-invitation list preview");
  const fresh = await reply(w, c.id, "Visible future reply"),
    note = await reply(w, c.id, "Private staff note", true);
  await server.app.db.tx((q) =>
    server.app.db.event(
      q,
      w.ws.id,
      "conversation.updated",
      { internalSecret: "must never reach customer event payload" },
      c.id,
      true,
    ),
  );
  const detail = await json(`${w.path}/conversations/${c.id}`, p);
  assert.ok(detail.messages.some((m: any) => m.id === fresh.id));
  assert.ok(
    !detail.messages.some((m: any) => [oldMessage, note.id].includes(m.id)),
  );
  assert.equal(detail.access.requester, false);
  assert.equal(detail.access.changeStatus, false);
  // Customer-facing rows carry no staff triage or message bookkeeping columns.
  assert.equal(detail.conversation.id, c.id);
  for (const key of [
    "tags",
    "priority",
    "assigned_to",
    "team_id",
    "edit_version",
  ])
    assert.ok(!(key in detail.conversation), `conversation.${key}`);
  for (const m of detail.messages)
    for (const key of [
      "author_id",
      "request_key",
      "sla_wait_id",
      "automation_execution_id",
    ])
      assert.ok(!(key in m), `message.${key}`);
  const staffDetail = await (
    await fetch(base + `${w.path}/conversations/${c.id}`, {
      headers: { Origin: config.FIELDKIT_URL, Cookie: ownerAccount.cookie },
    })
  ).json();
  assert.ok("priority" in staffDetail.conversation);
  assert.ok(staffDetail.messages.every((m: any) => "request_key" in m));
  list = (await json(`${w.path}/conversations?scope=mine`, p)).conversations;
  assert.equal(list[0].last_message, "Visible future reply");
  assert.equal(list[0].id, c.id);
  assert.ok(!("priority" in list[0]) && !("tags" in list[0]));
  const replay = await events(
    `${w.path}/conversations/${c.id}/events`,
    p,
    String(
      (await server.app.db.one(
        "SELECT max(id) id FROM events WHERE conversation_id=$1",
        [c.id],
      ))!.id,
    ),
  );
  assert.ok(!replay.some((e) => String(e.id) === String(oldEvent)));
  assert.ok(replay.length > 0);
  assert.ok(replay.every((e) => JSON.stringify(e.data) === "{}"));
  await server.app.collaboration.removeParticipant(
    w.owner,
    c.id,
    participant.id,
  );
  assert.equal(
    (await request(`${w.path}/conversations/${c.id}`, p)).status,
    404,
  );
  assert.equal(
    (await json(`${w.path}/conversations`, p)).conversations.length,
    0,
  );
  const denied = await request(`${w.path}/conversations/${c.id}/events`, p);
  assert.equal(denied.status, 404);
});

test("company scope HTTP counts include only explicit company sharing for current managers", async () => {
  const w = await fixture(),
    manager = await person(w),
    member = await person(w),
    org = (await server.app.collaboration.saveOrganization(w.owner, {
      name: "Company fixture",
    }))!;
  for (const [p, role] of [
    [manager, "manager"],
    [member, "member"],
  ] as const)
    await server.app.db.pool.query(
      "INSERT INTO customer_organization_memberships(workspace_id,organization_id,contact_id,role) VALUES($1,$2,$3,$4)",
      [w.ws.id, org.id, p.p.contactId, role],
    );
  const shared = await ticket(w, "Company shared"),
    privateTicket = await ticket(w, "Private company request");
  await server.app.collaboration.share(w.owner, shared.id, {
    organizationId: org.id,
    sharing: "company",
    confirmHistory: true,
  });
  await server.app.collaboration.share(w.owner, privateTicket.id, {
    organizationId: org.id,
    sharing: "private",
  });
  const own = await server.app.newConversation(manager.p, {
    channelId: w.channelId,
    subject: "My own request",
    body: "Own request",
    requestKey: uid(),
  });
  assert.deepEqual(
    (
      await json(`${w.path}/conversations?scope=company`, manager)
    ).conversations.map((c: any) => c.id),
    [shared.id],
  );
  assert.deepEqual(
    (
      await json(`${w.path}/conversations?scope=mine`, manager)
    ).conversations.map((c: any) => c.id),
    [own.id],
  );
  assert.equal(
    (await json(`${w.path}/conversations`, manager)).conversations.length,
    2,
  );
  assert.equal(
    (await json(`${w.path}/conversations?scope=company`, member)).conversations
      .length,
    0,
  );
  assert.equal(
    (await request(`${w.path}/conversations/${privateTicket.id}`, manager))
      .status,
    404,
  );
  const full = await json(`${w.path}/conversations/${shared.id}`, manager);
  assert.ok(full.messages.some((m: any) => m.body === "Company shared"));
  assert.equal(full.access.changeStatus, false);
  await server.app.collaboration.removeMember(
    w.owner,
    org.id,
    manager.p.contactId!,
  );
  assert.equal(
    (await json(`${w.path}/conversations?scope=company`, manager)).conversations
      .length,
    0,
  );
  assert.equal(
    (await request(`${w.path}/conversations/${shared.id}`, manager)).status,
    404,
  );
});

test("merged HTTP old URLs use canonical ACL and preserve source-specific participant cutoffs and provenance", async () => {
  const w = await fixture(),
    p = await person(w),
    target = await ticket(w, "Target pre-invitation"),
    targetParticipant = await join(w, target.id, p);
  const targetPublic = await reply(w, target.id, "Target visible reply");
  const source = await ticket(w, "Source private before source invitation"),
    oldSource = (await server.app.db.one(
      "SELECT id FROM messages WHERE conversation_id=$1",
      [source.id],
    ))!;
  const sourceParticipant = await join(w, source.id, p),
    sourcePublic = await reply(w, source.id, "Source future reply"),
    privateNote = await reply(w, source.id, "Source private note", true);
  for (const email of await server.app.db.rows(
    "SELECT id FROM ticket_emails WHERE workspace_id=$1",
    [w.ws.id],
  ))
    await server.app.ticketEmail.deliver(w.ws.id, email.id);
  const preview = await server.app.ticketOperations.preview(
    w.owner,
    source.id,
    target.id,
  );
  await server.app.ticketOperations.merge(w.owner, source.id, {
    targetId: target.id,
    sourceVersion: preview.source.editVersion,
    targetVersion: preview.target.editVersion,
    requestKey: uid(),
  });
  for (const id of [source.id, target.id]) {
    const detail = await json(`${w.path}/conversations/${id}`, p);
    assert.equal(detail.conversation.id, target.id);
    assert.equal(detail.mergedFrom, id === source.id ? source.id : null);
    assert.ok(detail.messages.some((m: any) => m.id === targetPublic.id));
    const imported = detail.messages.find((m: any) => m.id === sourcePublic.id);
    assert.equal(imported.source_ticket_id, source.id);
    assert.ok(
      !detail.messages.some((m: any) =>
        [oldSource.id, privateNote.id].includes(m.id),
      ),
    );
  }
  assert.deepEqual(
    (await json(`${w.path}/conversations`, p)).conversations.map(
      (c: any) => c.id,
    ),
    [target.id],
  );
  await server.app.db.pool.query(
    "UPDATE ticket_participants SET active=false WHERE workspace_id=$1 AND id=$2",
    [w.ws.id, sourceParticipant.id],
  );
  assert.ok(
    !(await json(`${w.path}/conversations/${target.id}`, p)).messages.some(
      (m: any) => m.id === sourcePublic.id,
    ),
  );
  await server.app.collaboration.removeParticipant(
    w.owner,
    target.id,
    targetParticipant.id,
  );
  assert.equal(
    (await request(`${w.path}/conversations/${source.id}`, p)).status,
    404,
  );
  assert.equal(
    (await request(`${w.path}/conversations/${target.id}`, p)).status,
    404,
  );
});

test("company access to a merged target never imports a source that has since become private", async () => {
  const w = await fixture(),
    manager = await person(w),
    org = (await server.app.collaboration.saveOrganization(w.owner, {
      name: "Merge company",
    }))!;
  await server.app.db.pool.query(
    "INSERT INTO customer_organization_memberships(workspace_id,organization_id,contact_id,role) VALUES($1,$2,$3,'manager')",
    [w.ws.id, org.id, manager.p.contactId],
  );
  const source = await ticket(w, "Source company record"),
    target = await ticket(w, "Target company record");
  for (const c of [source, target])
    await server.app.collaboration.share(w.owner, c.id, {
      organizationId: org.id,
      sharing: "company",
      confirmHistory: true,
    });
  const preview = await server.app.ticketOperations.preview(
    w.owner,
    source.id,
    target.id,
  );
  await server.app.ticketOperations.merge(w.owner, source.id, {
    targetId: target.id,
    sourceVersion: preview.source.editVersion,
    targetVersion: preview.target.editVersion,
    requestKey: uid(),
  });
  assert.ok(
    (await json(`${w.path}/conversations/${target.id}`, manager)).messages.some(
      (m: any) => m.body === "Source company record",
    ),
  );
  await server.app.db.pool.query(
    "UPDATE conversations SET sharing='private' WHERE id=$1",
    [source.id],
  );
  assert.ok(
    !(
      await json(`${w.path}/conversations/${source.id}`, manager)
    ).messages.some((m: any) => m.body === "Source company record"),
  );
});

test("accepting a pre-merge source participant invitation grants canonical access with original cutoffs", async () => {
  const w = await fixture(),
    p = await person(w),
    source = await ticket(w, "Pending source history"),
    target = await ticket(w, "Pending target history");
  const sourceInvite = await server.app.collaboration.addParticipant(
    w.owner,
    source.id,
    { email: p.email, confirmFutureOnly: true },
  );
  await server.app.collaboration.addParticipant(w.owner, target.id, {
    email: p.email,
    confirmFutureOnly: true,
  });
  const invitation = (await server.app.db.one(
    "SELECT * FROM collaboration_invitations WHERE id=$1",
    [sourceInvite.invitation.id],
  ))!;
  const secret = unseal<string>(
    config.FIELDKIT_ENCRYPTION_KEY,
    `collaboration:${w.ws.id}:${invitation.id}`,
    invitation.token_ciphertext,
  );
  const preview = await server.app.ticketOperations.preview(
    w.owner,
    source.id,
    target.id,
  );
  await server.app.ticketOperations.merge(w.owner, source.id, {
    targetId: target.id,
    sourceVersion: preview.source.editVersion,
    targetVersion: preview.target.editVersion,
    requestKey: uid(),
  });
  const accepted = await server.app.collaboration.invitation(p.p, secret, true);
  const response = await request(`${w.path}/conversations/${source.id}`, p);
  assert.equal(
    response.status,
    200,
    "An accepted source invitation must authorize its canonical ticket",
  );
  assert.equal(accepted.conversationId, target.id);
  const detail = (await response.json()) as any;
  assert.equal(detail.conversation.id, target.id);
  assert.equal(
    detail.messages.length,
    0,
    "Acceptance never grants older history",
  );
});

test("a queued HTTP delete rechecks staff authority after a preceding revocation commits", async (t) => {
  const w = await fixture(),
    admin = await account(),
    source = await ticket(w, "Retain merged source evidence"),
    target = await ticket(w, "Retain canonical evidence");
  await server.app.db.pool.query(
    "INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,'admin')",
    [w.ws.id, admin.id],
  );
  const preview = await server.app.ticketOperations.preview(w.owner, source.id, target.id);
  const mergeRequest = {
    targetId: target.id,
    sourceVersion: preview.source.editVersion,
    targetVersion: preview.target.editVersion,
    requestKey: uid(),
  };
  for (let attempt = 0; attempt < 2; attempt++) {
    const merged = await fetch(base + `${w.path}/conversations/${source.id}/merge`, {
      method: "POST",
      headers: { Origin: config.FIELDKIT_URL, Cookie: ownerAccount.cookie, "Content-Type": "application/json" },
      body: JSON.stringify(mergeRequest),
    });
    assert.equal(merged.status, 200, await merged.clone().text());
    assert.equal(((await merged.json()) as any).id, target.id);
  }
  const sourceMutation = await fetch(base + `${w.path}/conversations/${source.id}/control`, {
    method: "POST",
    headers: { Origin: config.FIELDKIT_URL, Cookie: ownerAccount.cookie, "Content-Type": "application/json" },
    body: JSON.stringify({ priority: "urgent" }),
  });
  assert.equal(sourceMutation.status, 409, "Idempotent merge retry must not reopen other source mutations");
  let locked!: () => void, routeReached!: () => void;
  const acquired = new Promise<void>((r) => { locked = r; }),
    reached = new Promise<void>((r) => { routeReached = r; }),
    original = server.app.deleteConversation.bind(server.app);
  t.mock.method(server.app, "deleteConversation", (...args: Parameters<typeof original>) => {
    routeReached();
    return original(...args);
  });
  const revoke = server.app.db.tx(async (q) => {
    await server.app.routing.lockWorkspace(q, w.ws.id);
    locked();
    await reached;
    await q.query("UPDATE memberships SET disabled=true,auth_revision=auth_revision+1 WHERE workspace_id=$1 AND user_id=$2", [w.ws.id, admin.id]);
  });
  await acquired;
  const deletion = fetch(base + `${w.path}/conversations/${target.id}`, {
    method: "DELETE",
    headers: { Origin: config.FIELDKIT_URL, Cookie: admin.cookie },
  });
  const response = await deletion;
  await revoke;
  assert.equal(response.status, 403, await response.clone().text());
  assert.equal((await server.app.db.one("SELECT count(*)::int AS count FROM conversations WHERE workspace_id=$1 AND id=ANY($2::text[])", [w.ws.id, [source.id, target.id]]))!.count, 2);
});
