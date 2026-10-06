import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { Database, uid } from "../packages/platform/src/db.js";
import { createAuth, type Principal } from "../packages/platform/src/auth.js";
import { resolveStaffPrincipal } from "../packages/platform/src/permissions.js";
import { HumanRouting } from "../packages/platform/src/human-routing.js";
import { HUMAN_ROUTING_SCHEMA } from "../packages/platform/src/human-routing-schema.js";
import {
  resetDatabase,
  testConfig,
  workspace,
  TestModel,
  TestProviders,
} from "./helpers.js";
import { createApp } from "../apps/api/server.js";
import { Platform } from "../packages/platform/src/platform.js";

const config = testConfig(),
  db = new Database(config);
let now = new Date("2026-10-06T12:00:00.000Z");
const routing = new HumanRouting(db, () => now);
before(async () => {
  await resetDatabase(config.DATABASE_URL);
  await db.migrate();
  await createAuth(db, async () => {}).migrate();
  db.onEvent = (q, event) => routing.onEvent(q, event);
});
after(() => db.close());
beforeEach(() => {
  now = new Date("2026-10-06T12:00:00.000Z");
});
async function fixture(enabled = true) {
  const ws = uid(),
    ownerId = uid(),
    a = "a-" + uid(),
    b = "b-" + uid(),
    contact = uid();
  await db.pool.query(
    "INSERT INTO workspaces(id,slug,name) VALUES($1,$1,'Routing fixture')",
    [ws],
  );
  for (const [userId, role] of [
    [ownerId, "owner"],
    [a, "agent"],
    [b, "agent"],
  ])
    await db.pool.query(
      "INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,$3)",
      [ws, userId, role],
    );
  await db.pool.query(
    "INSERT INTO contacts(id,workspace_id,name) VALUES($1,$2,'Customer')",
    [contact, ws],
  );
  const owner: Principal = { workspaceId: ws, userId: ownerId, role: "owner" };
  const team = (await routing.saveTeam(owner, {
    name: "Support",
    routingEnabled: true,
    memberIds: [a, b],
  }))!;
  if (enabled)
    await routing.saveSettings(owner, {
      enabled: true,
      defaultTeamId: team.id,
    });
  return { ws, owner, a, b, contact, team };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function ticket(w: Fixture, patch: Record<string, any> = {}) {
  const id = uid();
  await db.tx(async (q) => {
    await q.query(
      "INSERT INTO conversations(id,workspace_id,contact_id,subject,mode,status,team_id,priority,created_at) VALUES($1,$2,$3,'Routing test',$4,$5,$6,$7,$8)",
      [
        id,
        w.ws,
        w.contact,
        patch.mode ?? "human",
        patch.status ?? "open",
        patch.teamId === undefined ? w.team.id : patch.teamId,
        patch.priority ?? "normal",
        now,
      ],
    );
    await db.event(q, w.ws, "conversation.created", {}, id);
  });
  return id;
}
const row = (w: Fixture, id: string) =>
  db.one("SELECT * FROM conversations WHERE workspace_id=$1 AND id=$2", [
    w.ws,
    id,
  ]);
const entry = (w: Fixture, id: string) =>
  db.one(
    "SELECT * FROM human_queue WHERE workspace_id=$1 AND conversation_id=$2",
    [w.ws, id],
  );
async function available(w: Fixture, userId = w.a) {
  await routing.availability(await resolveStaffPrincipal(db, w.ws, userId), {
    state: "available",
  });
}

test("routing upgrades are opt-in, idempotent and never enroll AI-only or historical tickets", async () => {
  const w = await fixture(false),
    old = await ticket(w),
    ai = await ticket(w, { mode: "agent" });
  assert.equal(await entry(w, old), undefined);
  assert.equal(await entry(w, ai), undefined);
  assert.equal(
    (await routing.snapshot(w.owner)).members.find((m) => m.user_id === w.a)
      ?.state,
    "offline",
  );
  await routing.saveSettings(w.owner, {
    enabled: true,
    defaultTeamId: w.team.id,
  });
  await available(w);
  await routing.drain(w.ws);
  assert.equal((await row(w, old))!.assigned_to, null);
  await db.pool.query(HUMAN_ROUTING_SCHEMA);
  await db.pool.query(HUMAN_ROUTING_SCHEMA);
  assert.equal((await row(w, old))!.assigned_to, null);
  await routing.requeue(w.owner, old);
  await routing.drain(w.ws);
  assert.equal((await row(w, old))!.assigned_to, w.a);
  await assert.rejects(() => routing.requeue(w.owner, ai), /human queue/);
});
test("round robin persists across service restart; duplicate events and workers do not duplicate assignment", async () => {
  const w = await fixture();
  await available(w, w.a);
  await available(w, w.b);
  const first = await ticket(w);
  await Promise.all([routing.drain(w.ws), routing.drain(w.ws)]);
  assert.equal((await row(w, first))!.assigned_to, w.a);
  const second = await ticket(w);
  await new HumanRouting(db, () => now).drain(w.ws);
  assert.equal((await row(w, second))!.assigned_to, w.b);
  await db.tx(async (q) => {
    await db.event(q, w.ws, "message.created", {}, first);
    await db.event(q, w.ws, "message.created", {}, first);
  });
  await routing.drain(w.ws);
  assert.equal(
    (await db.one(
      "SELECT count(*)::int n FROM events WHERE workspace_id=$1 AND conversation_id=$2 AND kind='routing.assigned'",
      [w.ws, first],
    ))!.n,
    1,
  );
});
test("availability expiry, Away, and Offline prevent assignment and heartbeat never overrides intent", async () => {
  const w = await fixture(),
    id = await ticket(w);
  await routing.drain(w.ws);
  assert.equal((await entry(w, id))!.reason, "no_available_members");
  await available(w);
  now = new Date(now.getTime() + 301000);
  await routing.drain(w.ws);
  assert.equal((await row(w, id))!.assigned_to, null);
  const p = await resolveStaffPrincipal(db, w.ws, w.a);
  await routing.availability(p, { state: "away" });
  await routing.heartbeat(p);
  await routing.drain(w.ws);
  assert.equal(
    (await db.one(
      "SELECT state FROM agent_availability WHERE workspace_id=$1 AND user_id=$2",
      [w.ws, w.a],
    ))!.state,
    "away",
  );
  await routing.availability(p, { state: "offline" });
  await routing.heartbeat(p);
  await routing.drain(w.ws);
  assert.equal((await row(w, id))!.assigned_to, null);
  await available(w);
  await routing.drain(w.ws);
  assert.equal((await row(w, id))!.assigned_to, w.a);
});
test("parallel claims share total capacity across teams and one final slot", async () => {
  const w = await fixture();
  const team2 = (await routing.saveTeam(w.owner, {
    name: "Billing",
    routingEnabled: true,
    memberIds: [w.a],
  }))!;
  await routing.setCapacity(w.owner, w.a, { capacity: 1 });
  await available(w);
  const one = await ticket(w),
    two = await ticket(w, { teamId: team2.id });
  await Promise.all(Array.from({ length: 6 }, () => routing.drain(w.ws)));
  const rows = await Promise.all([row(w, one), row(w, two)]);
  assert.equal(rows.filter((c) => c!.assigned_to === w.a).length, 1);
  const waiting = rows.find((c) => !c!.assigned_to)!;
  assert.equal((await entry(w, waiting.id))!.reason, "at_capacity");
  const assigned = rows.find((c) => c!.assigned_to)!;
  await db.tx(async (q) => {
    await routing.lockWorkspace(q, w.ws);
    await q.query("UPDATE conversations SET status='resolved' WHERE id=$1", [
      assigned.id,
    ]);
    await db.event(
      q,
      w.ws,
      "conversation.updated",
      { status: "resolved" },
      assigned.id,
    );
  });
  await routing.drain(w.ws);
  assert.equal((await row(w, waiting.id))!.assigned_to, w.a);
});
test("manual assignment remains authoritative during auto claim races; overrides are explicit and audited", async () => {
  const w = await fixture();
  await available(w);
  await available(w, w.b);
  await routing.setCapacity(w.owner, w.b, { capacity: 1 });
  const id = await ticket(w);
  await Promise.all([
    routing.drain(w.ws),
    routing.assign(w.owner, id, { teamId: w.team.id, assignedTo: w.b }),
  ]);
  await routing.drain(w.ws);
  assert.equal((await row(w, id))!.assigned_to, w.b);
  assert.equal((await row(w, id))!.assignment_source, "manual");
  const second = await ticket(w);
  await assert.rejects(
    () => routing.assign(w.owner, second, { assignedTo: w.b }),
    /at capacity/,
  );
  const agent = await resolveStaffPrincipal(db, w.ws, w.a);
  await assert.rejects(
    () =>
      routing.assign(agent, second, {
        assignedTo: w.b,
        overrideCapacity: true,
        reason: "Urgent exception",
      }),
    /assign_override/,
  );
  await assert.rejects(
    () =>
      routing.assign(w.owner, second, {
        assignedTo: w.b,
        overrideCapacity: true,
      }),
    /requires a reason/,
  );
  await routing.assign(w.owner, second, {
    assignedTo: w.b,
    overrideCapacity: true,
    reason: "Reviewed urgent exception",
  });
  const history = await routing.explanation(w.owner, second);
  assert.equal(history.history[0].data.overrideCapacity, true);
  await routing.assign(w.owner, id, { assignedTo: null });
  await db.tx((q) => db.event(q, w.ws, "message.created", {}, id));
  await routing.drain(w.ws);
  assert.equal((await row(w, id))!.assigned_to, null);
  assert.equal((await row(w, id))!.assignment_source, "manual");
});
test("reopening preserves valid manual ownership, while removed owners are safely requeued", async () => {
  const w = await fixture();
  await available(w, w.b);
  const id = await ticket(w);
  await routing.assign(w.owner, id, { assignedTo: w.a });
  await db.tx(async (q) => {
    await routing.lockWorkspace(q, w.ws);
    await q.query("UPDATE conversations SET status='resolved' WHERE id=$1", [
      id,
    ]);
    await db.event(q, w.ws, "conversation.updated", { status: "resolved" }, id);
  });
  await db.tx(async (q) => {
    await q.query("UPDATE conversations SET status='open' WHERE id=$1", [id]);
    await db.event(q, w.ws, "message.created", {}, id);
  });
  await routing.drain(w.ws);
  assert.equal((await row(w, id))!.assigned_to, w.a);
  await db.tx(async (q) => {
    await routing.lockWorkspace(q, w.ws);
    await q.query(
      "DELETE FROM memberships WHERE workspace_id=$1 AND user_id=$2",
      [w.ws, w.a],
    );
  });
  await routing.drain(w.ws);
  assert.equal((await row(w, id))!.assigned_to, w.b);
});
test("overflow is explicit, tenant-bound, acyclic and waits before transferring", async () => {
  const w = await fixture(),
    overflow = (await routing.saveTeam(w.owner, {
      name: "Overflow",
      routingEnabled: true,
      memberIds: [w.b],
    }))!;
  await routing.saveTeam(w.owner, {
    id: w.team.id,
    name: "Support",
    routingEnabled: true,
    memberIds: [w.a],
    overflowTeamId: overflow.id,
    overflowAfterMinutes: 1,
  });
  await available(w, w.b);
  const id = await ticket(w);
  await routing.drain(w.ws);
  assert.equal((await row(w, id))!.team_id, w.team.id);
  now = new Date(now.getTime() + 61000);
  await routing.drain(w.ws);
  assert.equal((await row(w, id))!.team_id, overflow.id);
  assert.equal((await row(w, id))!.assigned_to, w.b);
  await assert.rejects(
    () =>
      routing.saveTeam(w.owner, {
        id: overflow.id,
        name: "Overflow",
        overflowTeamId: w.team.id,
      }),
    /cycle/,
  );
  const foreign = await fixture();
  await assert.rejects(
    () =>
      routing.saveTeam(w.owner, {
        name: "Bad overflow",
        overflowTeamId: foreign.team.id,
      }),
    /workspace/,
  );
});
test("queue aging outranks new urgent tickets and existing SLA deadlines break priority ties", async () => {
  const w = await fixture();
  await routing.setCapacity(w.owner, w.a, { capacity: 1 });
  const old = await ticket(w, { priority: "low" });
  now = new Date(now.getTime() + 6 * 3600000 + 1);
  const urgent = await ticket(w, { priority: "urgent" });
  await available(w);
  await routing.drain(w.ws);
  assert.equal((await row(w, old))!.assigned_to, w.a);
  assert.equal((await row(w, urgent))!.assigned_to, null);
  const next = await fixture();
  await routing.setCapacity(next.owner, next.a, { capacity: 1 });
  const noDeadline = await ticket(next),
    due = await ticket(next);
  await db.pool.query(
    "INSERT INTO sla_obligations(id,workspace_id,conversation_id,kind,state,origin,policy_revision,policy,rule_id,started_at,due_at,warning_at,escalate_at,cause) VALUES($1,$2,$3,'first','running','test',1,'{}','test',$4,$4,$4,$4,'test')",
    [uid(), next.ws, due, now],
  );
  await available(next);
  await routing.drain(next.ws);
  assert.equal((await row(next, due))!.assigned_to, next.a);
  assert.equal((await row(next, noDeadline))!.assigned_to, null);
});
test("authorization, membership changes, scope, and tenant boundaries are rechecked before claims", async () => {
  const w = await fixture(),
    foreign = await fixture(),
    id = await ticket(w);
  await available(w);
  await assert.rejects(
    () =>
      routing.saveSettings({ ...w.owner, role: "agent" }, { enabled: true }),
    /routing:manage/,
  );
  await assert.rejects(
    () => routing.assign(w.owner, id, { assignedTo: foreign.a }),
    /authorized member/,
  );
  await assert.rejects(
    () => routing.assign(foreign.owner, id, { assignedTo: foreign.a }),
    /not found/i,
  );
  await assert.rejects(
    () =>
      routing.saveTeam(w.owner, {
        name: "Invalid members",
        memberIds: [foreign.a],
      }),
    /workspace/,
  );
  const release = await db.pool.connect();
  await release.query("BEGIN");
  await routing.lockWorkspace(release, w.ws);
  const attempt = routing.drain(w.ws);
  await release.query(
    "UPDATE memberships SET disabled=true WHERE workspace_id=$1 AND user_id=$2",
    [w.ws, w.a],
  );
  await release.query("COMMIT");
  release.release();
  await attempt;
  assert.equal((await row(w, id))!.assigned_to, null);
  await db.pool.query(
    "INSERT INTO staff_roles(workspace_id,id,name,created_by,capabilities,ticket_scope) VALUES($1,'restricted','Restricted',$2,'[]','assigned')",
    [w.ws, w.owner.userId],
  );
  await db.pool.query(
    "UPDATE memberships SET disabled=false,custom_role_id='restricted' WHERE workspace_id=$1 AND user_id=$2",
    [w.ws, w.a],
  );
  await routing.drain(w.ws);
  assert.equal((await row(w, id))!.assigned_to, null);
  const denied = await resolveStaffPrincipal(db, w.ws, w.a);
  await assert.rejects(() => routing.snapshot(denied), /Team access/);
  await db.pool.query(
    "INSERT INTO staff_roles(workspace_id,id,name,created_by,capabilities,ticket_scope) VALUES($1,'assigned-reader','Assigned reader',$2,'[\"tickets:read\"]','assigned')",
    [w.ws, w.owner.userId],
  );
  await db.pool.query(
    "UPDATE memberships SET custom_role_id='assigned-reader' WHERE workspace_id=$1 AND user_id=$2",
    [w.ws, w.b],
  );
  const scoped = await resolveStaffPrincipal(db, w.ws, w.b);
  assert.deepEqual((await routing.snapshot(scoped)).queue, []);
  await assert.rejects(
    () => routing.explanation(scoped, id),
    /access|not found|permitted/i,
  );
});
test("missing team and no-member reasons remain observable without fabricating an assignee", async () => {
  const w = await fixture();
  await routing.saveSettings(w.owner, { enabled: true, defaultTeamId: null });
  const id = await ticket(w, { teamId: null });
  await routing.drain(w.ws);
  assert.equal((await entry(w, id))!.reason, "missing_team");
  const empty = (await routing.saveTeam(w.owner, {
    name: "Empty",
    routingEnabled: true,
    memberIds: [],
  }))!;
  const id2 = await ticket(w, { teamId: empty.id });
  await routing.drain(w.ws);
  assert.equal((await entry(w, id2))!.reason, "no_members");
});
test("direct HTTP calls cannot bypass routing administration, tenant visibility, or capacity override permissions", async () => {
  const server = await createApp(config, {
    migrate: true,
    mailer: async () => {},
  });
  await new Promise<void>((resolve) =>
    server.server.listen(0, "127.0.0.1", resolve),
  );
  const address = server.server.address() as { port: number },
    base = `http://127.0.0.1:${address.port}`;
  try {
    const call = (path: string, data?: unknown, cookie = "", method?: string) =>
      fetch(base + path, {
        method: method ?? (data === undefined ? "GET" : "POST"),
        headers: {
          Origin: config.FIELDKIT_URL,
          "Content-Type": "application/json",
          ...(cookie ? { Cookie: cookie } : {}),
        },
        body: data === undefined ? undefined : JSON.stringify(data),
      });
    const email = `routing-${uid()}@example.test`,
      password = "dedicated-local-test-password";
    const signUp = await call("/api/auth/sign-up/email", {
      email,
      password,
      name: "Routing agent",
    });
    assert.equal(signUp.status, 200, await signUp.clone().text());
    const { user } = (await signUp.json()) as any;
    await db.pool.query('UPDATE "user" SET "emailVerified"=true WHERE id=$1', [
      user.id,
    ]);
    const login = await call("/api/auth/sign-in/email", { email, password });
    assert.equal(login.status, 200, await login.clone().text());
    const cookie = login.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");
    const w = await fixture(),
      foreign = await fixture(),
      id = await ticket(w);
    await db.pool.query(
      "INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,'agent')",
      [w.ws, user.id],
    );
    const path = `/v2/workspaces/${w.ws}/routing`;
    assert.equal(
      (await call(path + "/settings", { enabled: true }, cookie, "PUT")).status,
      403,
    );
    assert.equal(
      (await call(path + "/teams", { name: "Unauthorized" }, cookie)).status,
      403,
    );
    assert.equal(
      (
        await call(
          path + `/agents/${w.a}/capacity`,
          { capacity: 20 },
          cookie,
          "PUT",
        )
      ).status,
      403,
    );
    assert.equal(
      (await call(`/v2/workspaces/${foreign.ws}/routing`, undefined, cookie))
        .status,
      403,
    );
    assert.equal(
      (
        await call(
          `/v2/workspaces/${w.ws}/conversations/${id}/routing/assign`,
          { assignedTo: w.a, overrideCapacity: true, reason: "Bypass attempt" },
          cookie,
        )
      ).status,
      403,
    );
    assert.equal((await row(w, id))!.assigned_to, null);
    assert.equal(
      (await call(path + "/availability", { state: "away" }, cookie, "PUT"))
        .status,
      200,
    );
    assert.equal((await call(path + "/heartbeat", {}, cookie)).status, 200);
    assert.equal(
      (await db.one(
        "SELECT state FROM agent_availability WHERE workspace_id=$1 AND user_id=$2",
        [w.ws, user.id],
      ))!.state,
      "away",
    );
    await db.pool.query(
      "DELETE FROM memberships WHERE workspace_id=$1 AND user_id=$2",
      [w.ws, user.id],
    );
    assert.equal(
      (
        await call(
          path + "/availability",
          { state: "available" },
          cookie,
          "PUT",
        )
      ).status,
      403,
    );
  } finally {
    await server.close();
  }
});
test("real workflow publication cannot bypass enabled human routing or overwrite manual ownership", async () => {
  const app = new Platform(config, {
    model: new TestModel(),
    fetch: new TestProviders().fetch,
    mailer: async () => {},
    clock: () => now,
  });
  await app.migrate();
  try {
    const existingOwner = (await db.one(
      "SELECT user_id FROM memberships WHERE role='owner' LIMIT 1",
    ))!;
    const w = await workspace(app, existingOwner.user_id),
      a = "a-" + uid(),
      b = "b-" + uid();
    for (const userId of [a, b])
      await app.db.pool.query(
        "INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,'agent')",
        [w.ws.id, userId],
      );
    const team = (await app.routing.saveTeam(w.owner, {
      name: "Workflow support",
      routingEnabled: true,
      memberIds: [a, b],
    }))!;
    await app.routing.saveSettings(w.owner, {
      enabled: true,
      defaultTeamId: team.id,
    });
    await app.routing.availability(
      await resolveStaffPrincipal(app.db, w.ws.id, b),
      { state: "available" },
    );
    const create = () =>
      app.newConversation(w.customer, {
        subject: "Workflow routing",
        body: "Please help",
        requestKey: uid(),
      });
    const publish = async (id: string, requested: string) => {
      const run = (await app.db.one(
        "SELECT * FROM runs WHERE workspace_id=$1 AND conversation_id=$2 ORDER BY revision DESC LIMIT 1",
        [w.ws.id, id],
      ))!;
      run.state = {
        route: "handoff",
        response: "A teammate will review this.",
        evidence: [],
      };
      await app.agent.publish(run, { assignedTo: requested });
    };
    const c = await create();
    await publish(c.id, a);
    assert.equal(
      (await app.db.one("SELECT assigned_to FROM conversations WHERE id=$1", [
        c.id,
      ]))!.assigned_to,
      null,
    );
    await app.routing.drain(w.ws.id);
    assert.equal(
      (await app.db.one("SELECT assigned_to FROM conversations WHERE id=$1", [
        c.id,
      ]))!.assigned_to,
      b,
    );
    const manual = await create();
    await app.control(w.owner, manual.id, { assignedTo: a, mode: "agent" });
    await publish(manual.id, b);
    await app.routing.drain(w.ws.id);
    assert.equal(
      (await app.db.one("SELECT assigned_to FROM conversations WHERE id=$1", [
        manual.id,
      ]))!.assigned_to,
      a,
    );
    const empty = await create();
    await app.control(w.owner, empty.id, { assignedTo: null, mode: "agent" });
    await publish(empty.id, b);
    await app.routing.drain(w.ws.id);
    assert.equal(
      (await app.db.one("SELECT assigned_to FROM conversations WHERE id=$1", [
        empty.id,
      ]))!.assigned_to,
      null,
    );
    await app.routing.setCapacity(w.owner, a, { capacity: 1 });
    const prospective = await create();
    await assert.rejects(
      () =>
        app.control(w.owner, prospective.id, { assignedTo: a, mode: "human" }),
      /at capacity/,
    );
    assert.equal(
      (await app.db.one("SELECT mode FROM conversations WHERE id=$1", [
        prospective.id,
      ]))!.mode,
      "agent",
    );
    await app.routing.saveSettings(w.owner, { enabled: false });
    const legacy = await create();
    await publish(legacy.id, b);
    assert.equal(
      (await app.db.one("SELECT assigned_to FROM conversations WHERE id=$1", [
        legacy.id,
      ]))!.assigned_to,
      b,
    );
    await app.db.pool.query(
      "UPDATE memberships SET disabled=true WHERE workspace_id=$1 AND user_id=$2",
      [w.ws.id, b],
    );
    const denied = await create();
    await assert.rejects(() => publish(denied.id, b), /no longer authorized/);
    assert.equal(
      (await app.db.one(
        "SELECT count(*)::int n FROM messages WHERE conversation_id=$1 AND role='assistant'",
        [denied.id],
      ))!.n,
      0,
    );
  } finally {
    await app.close();
  }
});

test("routing administration rejects scoped authority and queued writes after revocation", async () => {
  const w = await fixture();
  await db.pool.query(
    "INSERT INTO staff_roles(workspace_id,id,name,created_by,capabilities,ticket_scope) VALUES($1,'team-admin','Scoped administrator',$2,$3,'team')",
    [
      w.ws,
      w.owner.userId,
      JSON.stringify([
        "tickets:read",
        "tickets:assign",
        "teams:manage",
        "routing:manage",
      ]),
    ],
  );
  await db.pool.query(
    "UPDATE memberships SET custom_role_id='team-admin' WHERE workspace_id=$1 AND user_id=$2",
    [w.ws, w.a],
  );
  const scoped = await resolveStaffPrincipal(db, w.ws, w.a);
  await assert.rejects(
    () =>
      routing.saveTeam(scoped, { name: "Self expansion", memberIds: [w.a] }),
    /all-workspace/,
  );
  await assert.rejects(
    () => routing.saveSettings(scoped, { enabled: false }),
    /all-workspace/,
  );
  await assert.rejects(
    () => routing.setCapacity(scoped, w.b, { capacity: 10 }),
    /all-workspace/,
  );
  assert.equal((await routing.snapshot(scoped)).permissions.teams, false);
  await db.pool.query(
    "UPDATE memberships SET role='admin',custom_role_id=NULL WHERE workspace_id=$1 AND user_id=$2",
    [w.ws, w.a],
  );
  const stale = await resolveStaffPrincipal(db, w.ws, w.a);
  const blocker = await db.pool.connect();
  try {
    await blocker.query("BEGIN");
    await routing.lockWorkspace(blocker, w.ws);
    const attempt = routing.saveSettings(stale, { enabled: false });
    const rejected = assert.rejects(attempt, /no longer available/);
    await blocker.query(
      "UPDATE memberships SET disabled=true WHERE workspace_id=$1 AND user_id=$2",
      [w.ws, w.a],
    );
    await blocker.query("COMMIT");
    await rejected;
  } finally {
    await blocker.query("ROLLBACK");
    blocker.release();
  }
  assert.equal((await routing.settings(w.ws)).enabled, true);
  await assert.rejects(
    () => routing.saveTeam(stale, { name: "Revoked", memberIds: [] }),
    /no longer available/,
  );
  await assert.rejects(
    () => routing.setCapacity(stale, w.b, { capacity: 10 }),
    /no longer available/,
  );
  await assert.rejects(
    () => routing.availability(stale, { state: "available" }),
    /no longer available/,
  );
  await assert.rejects(() => routing.heartbeat(stale), /no longer available/);
  const id = await ticket(w);
  await assert.rejects(
    () => routing.assign(stale, id, { assignedTo: w.b }),
    /no longer available/,
  );
  await assert.rejects(() => routing.requeue(stale, id), /no longer available/);
});
