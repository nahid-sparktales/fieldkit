import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../apps/api/server.js";
import { authorizeWorkspaceRoute } from "../apps/api/route-permissions.js";
import { resolveStaffPrincipal } from "../packages/platform/src/permissions.js";
import { conversation } from "../packages/platform/src/auth.js";
import { uid } from "../packages/platform/src/db.js";
import {
  testConfig,
  resetDatabase,
  workspace,
  TestModel,
  TestProviders,
} from "./helpers.js";

const config = testConfig(4366);
let server: Awaited<ReturnType<typeof createApp>>, base: string;
before(async () => {
  await resetDatabase(config.DATABASE_URL);
  const providers = new TestProviders();
  server = await createApp(config, {
    migrate: true,
    workers: false,
    model: new TestModel(),
    fetch: providers.fetch,
    mailer: async () => {},
  });
  await new Promise<void>((resolve) =>
    server.server.listen(0, "127.0.0.1", resolve),
  );
  base = `http://127.0.0.1:${(server.server.address() as { port: number }).port}`;
});
after(async () => {
  await new Promise<void>((resolve) => server.server.close(() => resolve()));
  await server.app.close();
});
async function fixture() {
  await server.app.db.pool.query('DELETE FROM "rateLimit"');
  const app = server.app,
    w = await workspace(app),
    email = `scope-${uid()}@example.test`,
    password = "local-permission-test-password";
  const call = (path: string, data?: unknown, cookie = "", method?: string) =>
    fetch(base + path, {
      method: method ?? (data === undefined ? "GET" : "POST"),
      headers: {
        Origin: config.FIELDKIT_URL,
        "Content-Type": "application/json",
        Cookie: cookie,
      },
      body: data === undefined ? undefined : JSON.stringify(data),
    });
  const signup = await call("/api/auth/sign-up/email", {
    email,
    password,
    name: "Scoped staff",
  });
  assert.equal(signup.status, 200, await signup.clone().text());
  const { user } = (await signup.json()) as any;
  await app.db.pool.query(
    'UPDATE "user" SET "emailVerified"=true WHERE id=$1',
    [user.id],
  );
  const login = await call("/api/auth/sign-in/email", { email, password });
  assert.equal(login.status, 200, await login.clone().text());
  const cookie = login.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  const roleId = uid(),
    caps = [
      "tickets:read",
      "customers:read",
      "attachments:read",
      "analytics:read",
      "workflow:read",
      "actions:read",
      "audit:read",
      "assistance:use",
    ];
  await app.db.pool.query(
    "INSERT INTO staff_roles(workspace_id,id,name,capabilities,ticket_scope,created_by) VALUES($1,$2,'Read assigned',$3,'assigned',$4)",
    [w.ws.id, roleId, JSON.stringify(caps), w.owner.userId],
  );
  await app.db.pool.query(
    "INSERT INTO memberships(workspace_id,user_id,role,custom_role_id) VALUES($1,$2,'agent',$3)",
    [w.ws.id, user.id, roleId],
  );
  const visible = await app.newConversation(w.customer, {
    body: "Visible customer question",
    requestKey: uid(),
  });
  const hidden = await app.newConversation(w.customer, {
    body: "Hidden customer question",
    requestKey: uid(),
  });
  await app.db.pool.query(
    "UPDATE conversations SET assigned_to=$1 WHERE id=$2",
    [user.id, visible.id],
  );
  await app.message(
    w.owner,
    visible.id,
    { body: "Private staff note", requestKey: uid() },
    true,
  );
  await app.message(
    w.owner,
    hidden.id,
    { body: "Hidden private note", requestKey: uid() },
    true,
  );
  const p = await resolveStaffPrincipal(app.db, w.ws.id, user.id),
    prefix = `/v2/workspaces/${w.ws.id}`;
  return {
    ...w,
    user,
    p,
    visible,
    hidden,
    roleId,
    globalCall: (path: string, data?: unknown, method?: string) =>
      call(path, data, cookie, method),
    password,
    call: (path: string, data?: unknown, method?: string) =>
      call(prefix + path, data, cookie, method),
    self: () => call("/v2/me", undefined, cookie),
  };
}

test("assigned scope applies to inbox totals, customer history, direct lists and direct ticket reads", async () => {
  const w = await fixture(),
    app = server.app;
  const inbox = await app.customers.inbox(w.p, {});
  assert.equal(inbox.total, 1);
  assert.equal(inbox.conversation_total, 1);
  assert.equal(inbox.conversations[0].id, w.visible.id);
  const customers = await app.customers.list(w.p, {});
  assert.equal(customers!.customers[0].conversations, 1);
  const detail = await app.customers.detail(w.p, w.contactId);
  assert.equal(detail.summary.total, 1);
  assert.equal(detail.summary.notes, 0);
  await assert.rejects(
    app.customers.notes(w.p, w.contactId, {}),
    /tickets:note/,
  );
  const list = await w.call("/conversations");
  assert.equal(list.status, 200);
  assert.deepEqual(
    ((await list.json()) as any).conversations.map((x: any) => x.id),
    [w.visible.id],
  );
  const shown = await w.call(`/conversations/${w.visible.id}`);
  assert.equal(shown.status, 200);
  assert.ok(
    !((await shown.json()) as any).messages.some((m: any) => m.role === "note"),
  );
  for (const suffix of ["", "/events", "/sla", "/fields", "/feedback"])
    assert.equal(
      (await w.call(`/conversations/${w.hidden.id}${suffix}`)).status,
      404,
      suffix,
    );
});

test("capability gates deny mutations and workspace-wide evidence even when URL is entered directly", async () => {
  const w = await fixture();
  for (const path of [
    "/analytics",
    "/quality/settings",
    "/audit",
    "/operations",
    "/readiness",
    "/knowledge/gaps",
    "/workflow/step-results",
    "/sla",
    "/shadow",
  ])
    assert.equal((await w.call(path)).status, 403, path);
  for (const [path, data] of [
    [
      `/conversations/${w.visible.id}/messages`,
      { body: "No permission", requestKey: uid() },
    ],
    [
      `/conversations/${w.visible.id}/notes`,
      { body: "No permission", requestKey: uid() },
    ],
    ["/ticket-email/addresses", { address: "unexpected@example.test" }],
    ["/settings", {}],
    ["/identity/policy", {}],
  ] as const)
    assert.equal(
      (
        await w.call(
          path,
          data,
          path === "/settings" || path === "/identity/policy" ? "PUT" : "POST",
        )
      ).status,
      403,
      path,
    );
  const me = await w.self();
  assert.equal(me.status, 200);
  const workspace = ((await me.json()) as any).workspaces.find(
    (x: any) => x.id === w.ws.id,
  );
  assert.equal(workspace.ticketScope, "assigned");
  assert.ok(!workspace.capabilities.includes("tickets:reply"));
});

test("live membership revocation denies stale service principals and existing HTTP sessions", async () => {
  const w = await fixture(),
    app = server.app;
  await app.db.pool.query(
    "UPDATE memberships SET disabled=true WHERE workspace_id=$1 AND user_id=$2",
    [w.ws.id, w.user.id],
  );
  await assert.rejects(app.customers.inbox(w.p, {}), /no longer/);
  await assert.rejects(
    app.message(w.p, w.visible.id, { body: "Revoked", requestKey: uid() }),
    /no longer/,
  );
  await assert.rejects(conversation(app.db, w.p, w.visible.id), /no longer/);
  assert.equal((await w.call(`/conversations/${w.visible.id}`)).status, 403);
  const me = await w.self();
  assert.equal(me.status, 200);
  assert.ok(
    !((await me.json()) as any).workspaces.some((x: any) => x.id === w.ws.id),
  );
});

test("request-key reuse cannot cross customer/staff authors or public/private visibility", async () => {
  const w = await fixture(),
    app = server.app,
    key = uid();
  await app.message(
    w.owner,
    w.visible.id,
    { body: "Same bytes", requestKey: key },
    true,
  );
  await assert.rejects(
    app.message(w.customer, w.visible.id, {
      body: "Same bytes",
      requestKey: key,
    }),
    /author or visibility/,
  );
  await assert.rejects(
    app.message(w.owner, w.visible.id, { body: "Same bytes", requestKey: key }),
    /author or visibility/,
  );
});

test("route permissions deny undeclared custom endpoints and reevaluate scope before workspace event streams", () => {
  const p = {
    workspaceId: "test",
    role: "agent" as const,
    customRoleId: "role",
    userId: "staff",
    capabilities: ["analytics:read" as const],
    ticketScope: "assigned" as const,
  };
  assert.throws(
    () => authorizeWorkspaceRoute(p, "/quality/events", "GET"),
    /all tickets/,
  );
  assert.throws(
    () => authorizeWorkspaceRoute(p, "/future-admin-surface", "GET"),
    /unavailable/,
  );
  assert.throws(
    () =>
      authorizeWorkspaceRoute(
        { ...p, ticketScope: "all", capabilities: [] },
        "/quality/events",
        "GET",
      ),
    /tickets:note/,
  );
});

test("staff invitations require recent verification and cannot delegate broader builtin access", async () => {
  const w = await fixture(),
    db = server.app.db;
  await db.pool.query(
    "UPDATE memberships SET role='admin',custom_role_id=NULL WHERE workspace_id=$1 AND user_id=$2",
    [w.ws.id, w.user.id],
  );
  const input = { email: `invited-${uid()}@example.test`, role: "admin" };
  assert.equal((await w.call("/invitations", input)).status, 403);
  assert.equal(
    (await w.globalCall("/v2/identity/step-up", { password: w.password }))
      .status,
    200,
  );
  const accepted = await w.call("/invitations", input);
  assert.equal(accepted.status, 200, await accepted.clone().text());
  assert.equal(
    (await db.one(
      "SELECT count(*)::int n FROM events WHERE workspace_id=$1 AND kind='permissions.member_invited'",
      [w.ws.id],
    ))!.n,
    1,
  );
  await db.pool.query(
    "UPDATE staff_session_security SET step_up_at=now()-interval '6 minutes' WHERE user_id=$1",
    [w.user.id],
  );
  assert.equal(
    (
      await w.call("/invitations", {
        ...input,
        email: `stale-${uid()}@example.test`,
      })
    ).status,
    403,
  );
  assert.equal(
    (await w.globalCall("/v2/identity/step-up", { password: w.password }))
      .status,
    200,
  );
  await db.pool.query(
    "UPDATE staff_roles SET capabilities=$3,ticket_scope='all' WHERE workspace_id=$1 AND id=$2",
    [w.ws.id, w.roleId, JSON.stringify(["members:manage"])],
  );
  await db.pool.query(
    "UPDATE memberships SET custom_role_id=$3 WHERE workspace_id=$1 AND user_id=$2",
    [w.ws.id, w.user.id, w.roleId],
  );
  assert.equal(
    (await w.call("/invitations", { ...input, role: "agent" })).status,
    403,
  );
  await db.pool.query(
    "UPDATE staff_roles SET capabilities=(SELECT to_jsonb(ARRAY['members:manage','tickets:read']::text[])),ticket_scope='assigned' WHERE workspace_id=$1 AND id=$2",
    [w.ws.id, w.roleId],
  );
  assert.equal((await w.call("/invitations", input)).status, 403);
  assert.equal(
    (await db.one(
      "SELECT count(*)::int n FROM invitations WHERE workspace_id=$1",
      [w.ws.id],
    ))!.n,
    1,
  );
});

test("member removal protects owners, requires fresh verification, revokes sessions and wakes routing", async () => {
  const w = await fixture(),
    target = await fixture(),
    db = server.app.db;
  await db.pool.query(
    "UPDATE memberships SET role='owner',custom_role_id=NULL WHERE workspace_id=$1 AND user_id=$2",
    [w.ws.id, w.user.id],
  );
  await db.pool.query(
    "INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,'agent')",
    [w.ws.id, target.user.id],
  );
  assert.equal(
    (await w.call(`/members/${target.user.id}`, undefined, "DELETE")).status,
    403,
  );
  assert.equal(
    (await w.globalCall("/v2/identity/step-up", { password: w.password }))
      .status,
    200,
  );
  assert.equal(
    (await w.call(`/members/${w.user.id}`, undefined, "DELETE")).status,
    403,
  );
  assert.equal(
    (await w.call(`/members/${w.owner.userId}`, undefined, "DELETE")).status,
    403,
  );
  const removed = await w.call(
    `/members/${target.user.id}`,
    undefined,
    "DELETE",
  );
  assert.equal(removed.status, 200, await removed.clone().text());
  assert.equal((await target.self()).status, 401);
  assert.equal(
    await db.one(
      "SELECT 1 FROM memberships WHERE workspace_id=$1 AND user_id=$2",
      [w.ws.id, target.user.id],
    ),
    undefined,
  );
  assert.equal(
    (await db.one(
      "SELECT count(*)::int n FROM memberships WHERE workspace_id=$1 AND role='owner'",
      [w.ws.id],
    ))!.n,
    2,
  );
  assert.equal(
    (await db.one(
      "SELECT count(*)::int n FROM events WHERE workspace_id=$1 AND kind='permissions.member_removed'",
      [w.ws.id],
    ))!.n,
    1,
  );
  assert.ok(
    await db.one(
      "SELECT 1 FROM jobs.job WHERE name='human-routing' AND data->>'workspaceId'=$1",
      [w.ws.id],
    ),
  );
});

test("builtin agents retain read-only readiness access without administrative capabilities", async () => {
  const w = await fixture();
  await server.app.db.pool.query(
    "UPDATE memberships SET custom_role_id=NULL WHERE workspace_id=$1 AND user_id=$2",
    [w.ws.id, w.user.id],
  );
  for (const path of ["/readiness", "/readiness/summary"]) {
    const response = await w.call(path);
    assert.equal(response.status, 200, `${path}: ${await response.text()}`);
  }
  assert.equal(
    (await w.call("/readiness/runs", { checkIds: ["runtime"] })).status,
    403,
  );
  assert.equal((await w.call("/readiness/settings", {}, "PUT")).status, 403);
});

test("inbound email recheck returns JSON only after authorized durable queueing", async () => {
  const w = await fixture(),
    app = server.app,
    providerId = uid();
  const configured = await app.ticketEmail.configure(w.owner, {
    address: `support@${w.ws.id}.example.test`,
  });
  await app.ticketEmail.receive(
    w.ws.id,
    `Basic ${Buffer.from(`fieldkit:${configured.password}`).toString("base64")}`,
    {
      MessageID: providerId,
      OriginalRecipient: "unknown@example.test",
      FromFull: { Email: "customer@example.test" },
      TextBody: "Review recipient setup",
    },
  );
  const receipt = (await app.db.one(
    "SELECT id,status FROM email_intake_events WHERE workspace_id=$1 AND provider_id=$2",
    [w.ws.id, providerId],
  ))!;
  assert.equal(receipt.status, "quarantined");
  const path = `/ticket-email/inbound/${receipt.id}/retry`;
  assert.equal((await w.call(path, {})).status, 403);
  await app.db.pool.query(
    "UPDATE memberships SET role='admin',custom_role_id=NULL WHERE workspace_id=$1 AND user_id=$2",
    [w.ws.id, w.user.id],
  );
  const result = await w.call(path, {});
  assert.equal(result.status, 200);
  assert.deepEqual(await result.json(), { queued: true });
  assert.equal(
    (await app.db.one("SELECT status FROM email_intake_events WHERE id=$1", [
      receipt.id,
    ]))!.status,
    "queued",
  );
  assert.ok(
    await app.db.one(
      "SELECT 1 FROM jobs.job WHERE name='email-intake' AND data->>'eventId'=$1",
      [receipt.id],
    ),
  );
  await app.ticketEmail.intake.process(w.ws.id, receipt.id);
  assert.equal(
    (await app.db.one("SELECT status FROM email_intake_events WHERE id=$1", [
      receipt.id,
    ]))!.status,
    "quarantined",
  );
});
