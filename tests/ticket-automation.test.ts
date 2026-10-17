import { before, after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { Database, uid } from "../packages/platform/src/db.js";
import { createAuth, type Principal } from "../packages/platform/src/auth.js";
import { HumanRouting } from "../packages/platform/src/human-routing.js";
import { TicketOperations } from "../packages/platform/src/ticket-operations.js";
import {
  TicketAutomation,
  automationMatches,
} from "../packages/platform/src/ticket-automation-service.js";
import { AutomationDefinition } from "../packages/platform/src/ticket-automation-contracts.js";
import { Sla } from "../packages/platform/src/sla.js";
import { Collaboration } from "../packages/platform/src/collaboration.js";
import { defaultSlaPolicy } from "../packages/platform/src/sla-contracts.js";
import { resetDatabase, testConfig } from "./helpers.js";
const config = testConfig(),
  db = new Database(config);
let now = new Date("2026-10-07T12:00:00Z"),
  mails = 0,
  failApply = false,
  failMail = false;
const routing = new HumanRouting(db, () => now),
  ops = new TicketOperations(db, routing, () => now),
  sla = new Sla(
    db,
    async () => {},
    () => now,
  );
const automation = new TicketAutomation(
  db,
  routing,
  {
    applyTicketChanges: async (...args) => {
      const r = await ops.apply(...args);
      if (failApply) throw new Error("injected transaction failure");
      return r;
    },
    send: async () => {
      mails++;
      if (failMail) throw new Error("unknown SMTP result");
    },
  },
  () => now,
);
before(async () => {
  await resetDatabase(config.DATABASE_URL);
  await db.migrate();
  await createAuth(db, async () => {}).migrate();
  db.onEvent = (q, e) => automation.observe(q, e);
});
after(() => db.close());
beforeEach(() => {
  now = new Date("2026-10-07T12:00:00Z");
  mails = 0;
  failApply = false;
  failMail = false;
});
async function fixture() {
  const ws = uid(),
    userId = uid(),
    contact = uid(),
    channel = uid();
  await db.pool.query(
    "INSERT INTO workspaces(id,slug,name) VALUES($1,$1,'Automation fixture')",
    [ws],
  );
  await db.pool.query(
    'INSERT INTO "user"(id,name,email,"emailVerified","createdAt","updatedAt") VALUES($1,\'Owner\',$2,true,now(),now())',
    [userId, `${userId}@example.test`],
  );
  await db.pool.query(
    "INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,'owner')",
    [ws, userId],
  );
  await db.pool.query(
    "INSERT INTO contacts(id,workspace_id,name,email) VALUES($1,$2,'Customer',$3)",
    [contact, ws, `${contact}@example.test`],
  );
  await db.pool.query(
    "INSERT INTO channels(id,workspace_id,kind,published) VALUES($1,$2,'portal',true)",
    [channel, ws],
  );
  return {
    ws,
    userId,
    contact,
    channel,
    p: { workspaceId: ws, userId, role: "owner" } as Principal,
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function ticket(f: Fixture) {
  const id = uid();
  await db.tx(async (q) => {
    await q.query(
      "INSERT INTO conversations(id,workspace_id,contact_id,channel_id,subject,mode,created_at,updated_at) VALUES($1,$2,$3,$4,'Automation ticket','human',$5,$5)",
      [id, f.ws, f.contact, f.channel, now],
    );
    await db.event(q, f.ws, "conversation.created", {}, id);
  });
  return id;
}
async function message(
  f: Fixture,
  id: string,
  role = "customer",
  delivered = true,
) {
  const mid = uid();
  now = new Date(now.getTime() + 1000);
  await db.tx(async (q) => {
    await q.query(
      "INSERT INTO messages(id,workspace_id,conversation_id,role,body,author_id,delivered_at,created_at,request_key) VALUES($1,$2,$3,$4,'Fixture message',$5,$6,$7,$1)",
      [
        mid,
        f.ws,
        id,
        role,
        role === "staff" ? f.userId : null,
        delivered && role === "staff" ? now : null,
        now,
      ],
    );
    await db.event(
      q,
      f.ws,
      "message.created",
      { messageId: mid },
      id,
      role !== "note",
    );
  });
  return mid;
}
const definition = (patch: any = {}) =>
  AutomationDefinition.parse({
    name: "Fixture rule",
    trigger: { type: "event", event: "created" },
    actions: [{ type: "note", body: "Private automation note" }],
    ...patch,
  });
async function rule(f: Fixture, patch: any = {}, position = 0) {
  const r = (await automation.save(f.p, {
    definition: definition(patch),
    position,
  }))!;
  await automation.activate(f.p, r.id, {
    revision: r.revision,
    enabled: true,
    confirm: true,
  });
  return r;
}
async function execution(f: Fixture, id: string, ruleId?: string) {
  return db.one(
    "SELECT * FROM ticket_automation_executions WHERE workspace_id=$1 AND conversation_id=$2 AND ($3::text IS NULL OR rule_id=$3) ORDER BY created_at DESC,id DESC LIMIT 1",
    [f.ws, id, ruleId ?? null],
  );
}
async function run(f: Fixture, id: string) {
  const e = await execution(f, id);
  assert.ok(e);
  await automation.run(f.ws, e.id);
  return execution(f, id);
}
const conv = (f: Fixture, id: string) =>
  db.one("SELECT * FROM conversations WHERE workspace_id=$1 AND id=$2", [
    f.ws,
    id,
  ]);
async function wait(f: Fixture, id: string, allow = false) {
  const policy = defaultSlaPolicy();
  policy.enabled = true;
  policy.calendar.shifts = [1, 2, 3, 4, 5, 6, 7].map((day) => ({
    day,
    start: "00:00",
    end: "24:00",
  }));
  policy.followup.enabled = true;
  policy.followup.afterMinutes = 60;
  policy.followup.maxReminders = 2;
  await sla.save(f.p, { revision: 0, policy });
  await message(f, id, "staff");
  await sla.waiting(f.p, id, { waiting: true, allowReminder: allow });
  return db.one(
    "SELECT * FROM sla_waits WHERE workspace_id=$1 AND conversation_id=$2",
    [f.ws, id],
  );
}

test("drafts are inactive; previews do not mutate; activation and save use exact revisions", async () => {
  const f = await fixture(),
    id = await ticket(f),
    r = (await automation.save(f.p, { definition: definition() }))!;
  assert.equal(r.enabled, false);
  assert.equal((await automation.preview(f.p, definition())).matched, 1);
  assert.equal(await execution(f, id), undefined);
  await assert.rejects(
    automation.activate(f.p, r.id, { revision: 1, enabled: true }),
    /Confirm/,
  );
  await automation.activate(f.p, r.id, {
    revision: 1,
    enabled: true,
    confirm: true,
  });
  await automation.save(f.p, {
    id: r.id,
    revision: 1,
    definition: definition({ name: "Draft two" }),
  });
  await assert.rejects(
    automation.save(f.p, { id: r.id, revision: 1, definition: definition() }),
    /changed/,
  );
  const row = (await automation.list(f.p)).rules[0];
  assert.equal(row.active_revision, 1);
  assert.equal(row.revision, 2);
});
test("duplicate events and concurrent workers create exactly one atomic action result", async () => {
  const f = await fixture();
  await rule(f, {
    trigger: { type: "event", event: "customer_message" },
    actions: [{ type: "reply", body: "We received your message." }],
  });
  const id = await ticket(f),
    mid = await message(f, id);
  await db.tx((q) =>
    db.event(q, f.ws, "response.delivered", { messageId: mid }, id),
  );
  const e = (await execution(f, id))!;
  await Promise.all([automation.run(f.ws, e.id), automation.run(f.ws, e.id)]);
  assert.equal((await execution(f, id))!.status, "completed");
  assert.equal(
    (await db.one(
      "SELECT count(*)::int n FROM messages WHERE conversation_id=$1 AND role='reminder'",
      [id],
    ))!.n,
    1,
  );
  assert.equal(
    (await db.one(
      "SELECT count(*)::int n FROM ticket_automation_results WHERE execution_id=$1",
      [e.id],
    ))!.n,
    1,
  );
  assert.equal(
    (await db.one(
      "SELECT count(*)::int n FROM ticket_automation_executions WHERE conversation_id=$1",
      [id],
    ))!.n,
    1,
  );
});
test("only delivered staff replies trigger; private notes and automation events never chain", async () => {
  const f = await fixture();
  await rule(f, { trigger: { type: "event", event: "staff_reply" } });
  const id = await ticket(f),
    mid = await message(f, id, "staff", false);
  assert.equal(await execution(f, id), undefined);
  await message(f, id, "note");
  assert.equal(await execution(f, id), undefined);
  await db.tx(async (q) => {
    await q.query("UPDATE messages SET delivered_at=$2 WHERE id=$1", [
      mid,
      now,
    ]);
    await db.event(q, f.ws, "response.delivered", { messageId: mid }, id);
  });
  await run(f, id);
  assert.equal(
    (await db.one(
      "SELECT count(*)::int n FROM ticket_automation_executions WHERE conversation_id=$1",
      [id],
    ))!.n,
    1,
  );
  await db.tx((q) =>
    db.event(q, f.ws, "conversation.updated", { origin: "automation" }, id),
  );
  assert.equal(
    (await db.one(
      "SELECT count(*)::int n FROM ticket_automation_executions WHERE conversation_id=$1",
      [id],
    ))!.n,
    1,
  );
});
test("new customer activity suppresses old timers and creates a new source generation", async () => {
  const f = await fixture();
  await rule(f, {
    trigger: {
      type: "inactivity",
      anchor: "last_customer",
      minutes: 60,
      clock: "elapsed",
    },
  });
  const id = await ticket(f);
  await message(f, id);
  const old = (await execution(f, id))!;
  now = new Date(now.getTime() + 1800000);
  await message(f, id);
  now = new Date(now.getTime() + 3700000);
  await automation.run(f.ws, old.id);
  const rows = await db.rows(
    "SELECT status FROM ticket_automation_executions WHERE conversation_id=$1 ORDER BY due_at",
    [id],
  );
  assert.deepEqual(
    rows.map((r) => r.status),
    ["suppressed", "completed"],
  );
});
test("business clock skips closed hours; disabled rule suppresses pending work", async () => {
  const f = await fixture();
  now = new Date("2026-10-09T20:30:00Z");
  const r = await rule(f, {
    trigger: {
      type: "inactivity",
      anchor: "created",
      minutes: 60,
      clock: "business",
      calendar: {
        timezone: "America/Toronto",
        shifts: [1, 2, 3, 4, 5].map((day) => ({
          day,
          start: "09:00",
          end: "17:00",
        })),
        holidays: [],
      },
    },
  });
  const id = await ticket(f),
    e = (await execution(f, id))!;
  assert.equal(new Date(e.due_at).toISOString(), "2026-10-12T13:30:00.000Z");
  await automation.activate(f.p, r.id, { revision: 1, enabled: false });
  assert.equal((await execution(f, id))!.status, "suppressed");
});
test("matching conditions support all/any typed values and cross-workspace references fail closed", async () => {
  assert.equal(
    automationMatches(
      { field: "tags", op: "in", value: ["vip", "billing"] },
      { tags: ["billing"] },
    ),
    true,
  );
  const f = await fixture(),
    other = await fixture();
  const team = (await routing.saveTeam(other.p, {
    name: "Other team",
    routingEnabled: false,
    memberIds: [],
  }))!;
  await assert.rejects(
    automation.save(f.p, {
      definition: definition({
        all: [{ field: "team", op: "eq", value: team.id }],
      }),
    }),
    /unavailable/,
  );
  await rule(f, {
    all: [{ field: "status", op: "eq", value: "open" }],
    any: [
      { field: "priority", op: "eq", value: "urgent" },
      { field: "priority", op: "eq", value: "normal" },
    ],
  });
  const id = await ticket(f);
  assert.equal((await run(f, id))!.status, "completed");
});
test("authority is refreshed at execution and scoped administrators cannot configure workspace automation", async () => {
  const f = await fixture();
  await rule(f);
  const id = await ticket(f);
  await db.pool.query(
    "UPDATE memberships SET disabled=true WHERE workspace_id=$1 AND user_id=$2",
    [f.ws, f.userId],
  );
  assert.equal((await run(f, id))!.status, "suppressed");
  await assert.rejects(automation.list(f.p), /access|member|disabled/i);
});
test("ordered rules recheck live conditions while retaining the same source event", async () => {
  const f = await fixture();
  await rule(f, { actions: [{ type: "priority", value: "high" }] }, 1);
  const second = await rule(
    f,
    { actions: [{ type: "tags", add: ["review"], remove: [] }] },
    2,
  );
  const id = await ticket(f);
  await run(f, id);
  assert.equal((await execution(f, id, second.id))!.status, "completed");
  assert.equal((await conv(f, id))!.priority, "high");
  assert.deepEqual((await conv(f, id))!.tags, ["review"]);
});
test("rollback removes partial ticket mutations and outbox effects, then retry succeeds", async () => {
  const f = await fixture();
  await rule(f, {
    actions: [
      { type: "priority", value: "urgent" },
      { type: "reply", body: "Checking in." },
    ],
  });
  const id = await ticket(f);
  failApply = true;
  await assert.rejects(run(f, id), /injected/);
  assert.equal((await conv(f, id))!.priority, "normal");
  assert.equal(
    (await db.one(
      "SELECT count(*)::int n FROM ticket_automation_followups WHERE conversation_id=$1",
      [id],
    ))!.n,
    0,
  );
  assert.equal((await execution(f, id))!.status, "pending");
  failApply = false;
  assert.equal((await run(f, id))!.status, "completed");
});
test("public delivery rechecks disablement and fresh customer activity without suppressing its own property changes", async () => {
  const f = await fixture(),
    r = await rule(f, {
      all: [{ field: "priority", op: "eq", value: "normal" }],
      actions: [
        { type: "priority", value: "high" },
        { type: "reply", body: "Checking in." },
      ],
    });
  const id = await ticket(f);
  await run(f, id);
  const m = (await db.one(
    "SELECT id FROM messages WHERE conversation_id=$1 AND role='reminder'",
    [id],
  ))!;
  assert.equal(await automation.emailGuard(db.pool, f.ws, m.id), true);
  await message(f, id);
  assert.equal(await automation.emailGuard(db.pool, f.ws, m.id), false);
  await automation.activate(f.p, r.id, { revision: 1, enabled: false });
  assert.equal(await automation.emailGuard(db.pool, f.ws, m.id), false);
});
test("two public rules share one contact generation and cannot duplicate a follow-up", async () => {
  const f = await fixture();
  await rule(f, { actions: [{ type: "reply", body: "First" }] }, 1);
  await rule(f, { actions: [{ type: "reply", body: "Second" }] }, 2);
  const id = await ticket(f);
  await run(f, id);
  assert.equal(
    (await db.one(
      "SELECT count(*)::int n FROM messages WHERE conversation_id=$1 AND role='reminder'",
      [id],
    ))!.n,
    1,
  );
  const rows = await db.rows(
    "SELECT status FROM ticket_automation_executions WHERE conversation_id=$1",
    [id],
  );
  assert.deepEqual(rows.map((r) => r.status).sort(), [
    "completed",
    "suppressed",
  ]);
});
test("automatic closure requires 24 hours of waiting and refuses uncertain account operations", async () => {
  assert.throws(
    () => definition({ actions: [{ type: "resolve" }] }),
    /24 hours/,
  );
  const f = await fixture();
  await rule(f, {
    trigger: {
      type: "inactivity",
      anchor: "waiting",
      minutes: 1440,
      clock: "elapsed",
    },
    actions: [{ type: "resolve" }],
  });
  const id = await ticket(f);
  await wait(f, id);
  let e = (await execution(f, id))!;
  assert.ok(e);
  await automation.run(f.ws, e.id);
  assert.equal((await conv(f, id))!.status, "open");
  const rid = uid();
  await db.pool.query(
    "INSERT INTO runs(id,workspace_id,conversation_id,revision) VALUES($1,$2,$3,1)",
    [rid, f.ws, id],
  );
  await db.pool.query(
    "INSERT INTO operations(id,workspace_id,run_id,action_id,proposal_hash,resource,status) VALUES($1,$2,$3,'fixture','hash','fixture','unknown')",
    [uid(), f.ws, rid],
  );
  now = new Date(now.getTime() + 86400001);
  await automation.run(f.ws, e.id);
  assert.equal((await execution(f, id))!.status, "suppressed");
  assert.equal((await conv(f, id))!.status, "open");
});
test("safe waiting closure emits automation actor and clears no pending approvals", async () => {
  const f = await fixture();
  await rule(f, {
    trigger: {
      type: "inactivity",
      anchor: "waiting",
      minutes: 1440,
      clock: "elapsed",
    },
    actions: [
      { type: "resolve" },
      {
        type: "notify",
        recipient: "staff",
        userIds: [f.userId],
        body: "Waiting ticket resolved",
        email: true,
      },
    ],
  });
  const id = await ticket(f);
  await wait(f, id);
  now = new Date(now.getTime() + 86400001);
  await run(f, id);
  assert.equal((await conv(f, id))!.status, "resolved");
  const event = await db.one(
    "SELECT data FROM events WHERE conversation_id=$1 AND kind='conversation.updated' ORDER BY id DESC LIMIT 1",
    [id],
  );
  assert.equal(event!.data.actorType, "automation");
  const notification = (await automation.notifications(f.p)).notifications[0];
  await automation.deliverNotification(f.ws, notification.id);
  assert.equal(
    mails,
    1,
    "A resolution can notify staff about its own completed change",
  );
});
test("legacy waits retain due time and reminder count; original SLA worker does not double-send", async () => {
  const f = await fixture(),
    id = await ticket(f),
    w = (await wait(f, id, true))!,
    e = (await execution(f, id))!;
  assert.equal(
    new Date(e.due_at).toISOString(),
    new Date(w.due_at).toISOString(),
  );
  assert.equal(e.legacy_generation, 1);
  assert.equal(w.automation_managed, true);
  now = new Date(new Date(w.due_at).getTime() + 1);
  await Promise.all([automation.run(f.ws, e.id), sla.tick(f.ws, id)]);
  assert.equal(
    (await db.one(
      "SELECT count(*)::int n FROM messages WHERE conversation_id=$1 AND role='reminder'",
      [id],
    ))!.n,
    1,
  );
  const next = await db.one(
    "SELECT * FROM ticket_automation_executions WHERE conversation_id=$1 AND status='pending'",
    [id],
  );
  assert.equal(next!.legacy_generation, 2);
  assert.equal(
    (await db.one("SELECT sent_count FROM sla_waits WHERE id=$1", [w.id]))!
      .sent_count,
    1,
  );
});
test("staff notifications enforce recipient access and ambiguous email is never retried", async () => {
  const f = await fixture();
  await rule(f, {
    actions: [
      {
        type: "notify",
        recipient: "staff",
        userIds: [f.userId],
        body: "Review this ticket",
        email: true,
      },
    ],
  });
  const id = await ticket(f);
  await run(f, id);
  const n = (await automation.notifications(f.p)).notifications[0];
  assert.ok(n);
  failMail = true;
  await automation.deliverNotification(f.ws, n.id);
  await automation.deliverNotification(f.ws, n.id);
  assert.equal(mails, 1);
  assert.equal(
    (await db.one(
      "SELECT email_status FROM ticket_automation_notifications WHERE id=$1",
      [n.id],
    ))!.email_status,
    "uncertain",
  );
  await automation.readNotification(f.p, n.id);
  assert.ok((await automation.notifications(f.p)).notifications[0].read_at);
});

test("private field predicates and history stay hidden without field permission; scoped admins fail closed", async () => {
  const f = await fixture(),
    field = uid(),
    role = uid();
  await db.pool.query(
    "INSERT INTO ticket_fields(workspace_id,id,definition,created_by) VALUES($1,$2,$3,$4)",
    [
      f.ws,
      field,
      {
        name: "Private score",
        type: "number",
        customerVisible: false,
        archived: false,
      },
      f.userId,
    ],
  );
  const def = definition({
    all: [{ field: `field.${field}`, op: "gte", value: 10 }],
  });
  const r = await rule(f, def);
  const caps = ["automations:manage", "tickets:read", "tickets:note"];
  await db.pool.query(
    "INSERT INTO staff_roles(workspace_id,id,name,capabilities,ticket_scope,created_by) VALUES($1,$2,'Restricted',$3,'all',$4)",
    [f.ws, role, JSON.stringify(caps), f.userId],
  );
  await db.pool.query(
    "UPDATE memberships SET custom_role_id=$3 WHERE workspace_id=$1 AND user_id=$2",
    [f.ws, f.userId, role],
  );
  assert.equal((await automation.list(f.p)).rules.length, 0);
  assert.equal((await automation.list(f.p)).fields.length, 0);
  assert.equal((await automation.history(f.p, r.id)).versions.length, 0);
  await assert.rejects(automation.preview(f.p, def), /fields:internal:read/);
  await assert.rejects(
    automation.save(f.p, { id: r.id, revision: 1, definition: definition() }),
    /Internal field/,
  );
  await db.pool.query(
    "UPDATE staff_roles SET ticket_scope='team' WHERE workspace_id=$1 AND id=$2",
    [f.ws, role],
  );
  await assert.rejects(automation.list(f.p), /all-workspace/);
});

test("routing uses human queue and preserves a manual assignee without nested or delayed rule loops", async () => {
  const f = await fixture(),
    team = (await routing.saveTeam(f.p, {
      name: "Support",
      routingEnabled: true,
      memberIds: [f.userId],
    }))!;
  await routing.saveSettings(f.p, { enabled: true, defaultTeamId: team.id });
  await routing.availability(f.p, { state: "available" });
  await rule(f, {
    actions: [{ type: "route", teamId: team.id, requeue: true }],
  });
  await rule(f, {
    trigger: { type: "event", event: "ticket_changed" },
    actions: [{ type: "route", teamId: team.id, requeue: true }],
  });
  const id = await ticket(f);
  assert.equal((await run(f, id))!.status, "completed");
  assert.equal((await conv(f, id))!.team_id, team.id);
  await routing.drain(f.ws);
  assert.equal((await conv(f, id))!.assigned_to, f.userId);
  assert.equal(
    (await db.one(
      "SELECT count(*)::int n FROM ticket_automation_executions WHERE conversation_id=$1",
      [id],
    ))!.n,
    1,
  );
  const other = await ticket(f);
  await db.pool.query(
    "UPDATE conversations SET assigned_to=$2,assignment_source='manual' WHERE id=$1",
    [other, f.userId],
  );
  assert.equal((await run(f, other))!.status, "suppressed");
  assert.equal((await conv(f, other))!.assigned_to, f.userId);
});

test("staff routing assignment and requeue trigger property rules once after the final revision", async () => {
  const f = await fixture(),
    team = (await routing.saveTeam(f.p, {
      name: "Routing triggers",
      memberIds: [f.userId],
    }))!,
    id = await ticket(f),
    r = await rule(f, {
      trigger: { type: "event", event: "ticket_changed" },
      all: [{ field: "team", op: "eq", value: team.id }],
      actions: [
        { type: "priority", value: "high" },
        { type: "note", body: "Staff routing changed" },
      ],
    });
  const assigned = await routing.assign(f.p, id, {
    teamId: team.id,
    assignedTo: f.userId,
  });
  const first = (await execution(f, id, r.id))!;
  assert.ok(first, "The real assignment entry point enrolls the matching rule");
  assert.equal(first.source_snapshot.revision, assigned.revision);
  assert.equal(first.source_snapshot.revision, (await conv(f, id))!.revision);
  await run(f, id);
  assert.equal((await execution(f, id, r.id))!.status, "completed");
  assert.equal((await conv(f, id))!.priority, "high");
  await routing.requeue(f.p, id);
  const second = (await execution(f, id, r.id))!;
  assert.notEqual(second.id, first.id);
  assert.equal(second.source_snapshot.revision, (await conv(f, id))!.revision);
  await run(f, id);
  assert.equal((await execution(f, id, r.id))!.status, "completed");
  assert.equal(
    (await db.one(
      "SELECT count(*)::int n FROM ticket_automation_executions WHERE conversation_id=$1",
      [id],
    ))!.n,
    2,
    "Only the two staff operations trigger rules; generated changes do not chain",
  );
});

test("organization and sharing changes trigger matching property rules through the collaboration service", async () => {
  const f = await fixture(),
    collaboration = new Collaboration(db, async () => {}),
    organization = uid(),
    id = await ticket(f);
  await db.pool.query(
    "INSERT INTO customer_organizations(workspace_id,id,name) VALUES($1,$2,'Trigger organization')",
    [f.ws, organization],
  );
  const r = await rule(f, {
    trigger: { type: "event", event: "ticket_changed" },
    all: [{ field: "organization", op: "eq", value: organization }],
    actions: [{ type: "tags", add: ["organization-routed"], remove: [] }],
  });
  await collaboration.share(f.p, id, {
    organizationId: organization,
    sharing: "company",
    confirmHistory: true,
  });
  assert.ok(await execution(f, id, r.id));
  await run(f, id);
  assert.equal((await execution(f, id, r.id))!.status, "completed");
  assert.deepEqual((await conv(f, id))!.tags, ["organization-routed"]);
  assert.equal(
    (await db.one(
      "SELECT count(*)::int n FROM ticket_automation_executions WHERE conversation_id=$1",
      [id],
    ))!.n,
    1,
  );
});

test("notification delivery suppresses revoked recipients and rule disablement", async () => {
  const f = await fixture(),
    r = await rule(f, {
      actions: [
        {
          type: "notify",
          recipient: "staff",
          userIds: [f.userId],
          body: "Review needed",
          email: true,
        },
      ],
    });
  const id = await ticket(f);
  await run(f, id);
  const n = (await automation.notifications(f.p)).notifications[0];
  await automation.activate(f.p, r.id, { revision: 1, enabled: false });
  await automation.deliverNotification(f.ws, n.id);
  assert.equal(mails, 0);
  assert.equal(
    (await db.one(
      "SELECT email_status FROM ticket_automation_notifications WHERE id=$1",
      [n.id],
    ))!.email_status,
    "suppressed",
  );
});

test("SLA warning observations deduplicate per obligation generation", async () => {
  const f = await fixture();
  await rule(f, { trigger: { type: "event", event: "sla_warning" } });
  const id = await ticket(f);
  await db.tx((q) =>
    db.event(
      q,
      f.ws,
      "sla.warning",
      { obligationId: "fixture", generation: 1 },
      id,
    ),
  );
  await db.tx((q) =>
    db.event(
      q,
      f.ws,
      "sla.warning",
      { obligationId: "fixture", generation: 1 },
      id,
    ),
  );
  await run(f, id);
  assert.equal(
    (await db.one(
      "SELECT count(*)::int n FROM ticket_automation_executions WHERE conversation_id=$1",
      [id],
    ))!.n,
    1,
  );
});

test("custom-field edits invalidate old timers and anchor a distinct ticket-change generation", async () => {
  const f = await fixture(),
    field = uid(),
    fd = {
      name: "Quantity",
      type: "number",
      customerVisible: true,
      archived: false,
    };
  await db.pool.query(
    "INSERT INTO ticket_fields(workspace_id,id,definition,created_by) VALUES($1,$2,$3,$4)",
    [f.ws, field, fd, f.userId],
  );
  await rule(f, {
    trigger: {
      type: "inactivity",
      anchor: "ticket_changed",
      minutes: 60,
      clock: "elapsed",
    },
  });
  const id = await ticket(f),
    old = (await execution(f, id))!,
    initialRevision = (await conv(f, id))!.revision;
  await db.tx(async (q) => {
    await q.query(
      "INSERT INTO ticket_field_values(workspace_id,conversation_id,field_id,value,field_revision,definition) VALUES($1,$2,$3,'42',1,$4)",
      [f.ws, id, field, fd],
    );
    await db.event(q, f.ws, "ticket_fields.updated", { actorId: f.userId }, id);
  });
  assert.equal(
    (await conv(f, id))!.revision,
    initialRevision,
    "Fixture exercises edit_version without agent revision change",
  );
  const all = await db.rows(
    "SELECT * FROM ticket_automation_executions WHERE conversation_id=$1 ORDER BY due_at",
    [id],
  );
  assert.equal(all.length, 2);
  assert.notEqual(all[0].source_key, all[1].source_key);
  const changedEvent = (await db.one(
    "SELECT created_at FROM events WHERE conversation_id=$1 AND kind='ticket_fields.updated'",
    [id],
  ))!;
  assert.equal(
    new Date(all[1].due_at).getTime() -
      new Date(changedEvent.created_at).getTime(),
    3600000,
  );
  now = new Date(new Date(all[1].due_at).getTime() + 1);
  await automation.run(f.ws, old.id);
  assert.deepEqual(
    (
      await db.rows(
        "SELECT status FROM ticket_automation_executions WHERE conversation_id=$1 ORDER BY due_at",
        [id],
      )
    ).map((e) => e.status),
    ["suppressed", "completed"],
  );
});
