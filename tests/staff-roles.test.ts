import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { Database, uid } from "../packages/platform/src/db.js";
import { createAuth, type Principal } from "../packages/platform/src/auth.js";
import { HumanRouting } from "../packages/platform/src/human-routing.js";
import { StaffRoles } from "../packages/platform/src/staff-roles.js";
import { resolveStaffPrincipal } from "../packages/platform/src/permissions.js";
import { resetDatabase, testConfig } from "./helpers.js";

const config = testConfig(),
  db = new Database(config),
  routing = new HumanRouting(db),
  roles = new StaffRoles(db, routing);
before(async () => {
  await resetDatabase(config.DATABASE_URL);
  await db.migrate();
  await createAuth(db, async () => {}).migrate();
});
after(() => db.close());
async function login(userId: string, fresh = true) {
  const id = uid();
  await db.pool.query(
    'INSERT INTO session(id,"userId",token,"expiresAt","createdAt","updatedAt") VALUES($1,$2,$3,now()+interval \'1 hour\',now(),now())',
    [id, userId, uid()],
  );
  await db.pool.query(
    "INSERT INTO staff_session_security(session_id,user_id,step_up_at) VALUES($1,$2,now()-($3::int*interval '1 minute'))",
    [id, userId, fresh ? 0 : 10],
  );
  return id;
}
async function fixture() {
  const ws = uid(),
    owner = uid(),
    member = uid();
  await db.pool.query(
    "INSERT INTO workspaces(id,slug,name) VALUES($1,$1,'Roles fixture')",
    [ws],
  );
  for (const id of [owner, member]) {
    await db.pool.query(
      'INSERT INTO "user"(id,name,email,"emailVerified","createdAt","updatedAt") VALUES($1,\'Role fixture\',$2,true,now(),now())',
      [id, `${id}@example.test`],
    );
    await db.pool.query(
      "INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,$3)",
      [ws, id, id === owner ? "owner" : "agent"],
    );
  }
  const p: Principal = {
    ...(await resolveStaffPrincipal(db, ws, owner)),
    sessionId: await login(owner),
  };
  return { ws, owner, member, p };
}
const narrow = {
  name: "Assigned support",
  description: "Reply only to assigned tickets",
  capabilities: ["tickets:read", "tickets:reply"],
  ticketScope: "assigned",
};

test("custom roles persist and assignment revokes sessions while applying exact current capabilities", async () => {
  const w = await fixture(),
    memberSession = await login(w.member),
    role = (await roles.save(w.p, narrow))!;
  await roles.assignMember(w.p, w.member, {
    role: "agent",
    customRoleId: role.id,
  });
  const p = await resolveStaffPrincipal(db, w.ws, w.member);
  assert.deepEqual(p.capabilities, narrow.capabilities);
  assert.equal(p.ticketScope, "assigned");
  assert.equal(
    await db.one("SELECT id FROM session WHERE id=$1", [memberSession]),
    undefined,
  );
  assert.equal(
    await db.one(
      "SELECT session_id FROM staff_session_security WHERE session_id=$1",
      [memberSession],
    ),
    undefined,
  );
  assert.equal(
    (await db.one(
      "SELECT auth_revision FROM memberships WHERE workspace_id=$1 AND user_id=$2",
      [w.ws, w.member],
    ))!.auth_revision,
    2,
  );
  assert.equal(
    (await roles.list(w.p)).roles.find((r) => r.id === role.id)!.member_count,
    1,
  );
  const relogged = await login(w.member);
  await roles.save(w.p, {
    ...narrow,
    id: role.id,
    revision: role.revision,
    capabilities: ["tickets:read"],
  });
  assert.equal(
    await db.one("SELECT id FROM session WHERE id=$1", [relogged]),
    undefined,
  );
  assert.deepEqual(
    (await resolveStaffPrincipal(db, w.ws, w.member)).capabilities,
    ["tickets:read"],
  );
});
test("stale or absent step-up and expired or revoked sessions cannot modify roles", async () => {
  const w = await fixture();
  await assert.rejects(
    () => roles.save({ ...w.p, sessionId: undefined }, narrow),
    /Verify your identity/,
  );
  const stale = await login(w.owner, false);
  await assert.rejects(
    () => roles.save({ ...w.p, sessionId: stale }, narrow),
    /Verify|verification|Security|password/,
  );
  const expired = await login(w.owner);
  await db.pool.query(
    `UPDATE session SET "expiresAt"=now()-interval '1 second' WHERE id=$1`,
    [expired],
  );
  await assert.rejects(
    () => roles.save({ ...w.p, sessionId: expired }, narrow),
    /session is no longer active/,
  );
  const mfaPending = await login(w.owner);
  await db.pool.query('UPDATE "user" SET "twoFactorEnabled"=true WHERE id=$1', [
    w.owner,
  ]);
  await assert.rejects(
    () => roles.save({ ...w.p, sessionId: mfaPending }, narrow),
    /authenticator/,
  );
  await db.pool.query(
    'UPDATE "user" SET "twoFactorEnabled"=false WHERE id=$1',
    [w.owner],
  );
  await db.pool.query("DELETE FROM session WHERE id=$1", [w.p.sessionId]);
  await assert.rejects(
    () => roles.save(w.p, narrow),
    /session is no longer active/,
  );
  assert.equal(
    (await db.one(
      "SELECT count(*)::int n FROM staff_roles WHERE workspace_id=$1",
      [w.ws],
    ))!.n,
    0,
  );
});
test("self edits, owner conversion/demotion/disable, and deletion of assigned roles are rejected", async () => {
  const w = await fixture(),
    role = (await roles.save(w.p, narrow))!;
  await assert.rejects(
    () => roles.assignMember(w.p, w.owner, { role: "agent" }),
    /own role/,
  );
  await assert.rejects(
    () => roles.assignMember(w.p, w.member, { role: "owner" }),
    /Invalid|option/,
  );
  await roles.assignMember(w.p, w.member, {
    role: "agent",
    customRoleId: role.id,
  });
  await assert.rejects(
    () => roles.remove(w.p, role.id),
    /every member another role/,
  );
  const second = uid();
  await db.pool.query(
    'INSERT INTO "user"(id,name,email,"emailVerified","createdAt","updatedAt") VALUES($1,\'Second owner\',$2,true,now(),now())',
    [second, `${second}@example.test`],
  );
  await db.pool.query(
    "INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,'owner')",
    [w.ws, second],
  );
  const p = {
    ...(await resolveStaffPrincipal(db, w.ws, second)),
    sessionId: await login(second),
  };
  await assert.rejects(
    () => roles.assignMember(p, w.owner, { role: "agent", disabled: true }),
    /Owner access/,
  );
  assert.equal(
    (await db.one(
      "SELECT count(*)::int n FROM memberships WHERE workspace_id=$1 AND role='owner' AND NOT disabled",
      [w.ws],
    ))!.n,
    2,
  );
});
test("delegation cannot widen capabilities or ticket scope, including by editing one's assigned role", async () => {
  const w = await fixture();
  const delegated = (await roles.save(w.p, {
    name: "Delegated manager",
    capabilities: ["roles:manage", "members:manage", "tickets:read"],
    ticketScope: "team",
  }))!;
  await roles.assignMember(w.p, w.member, {
    role: "agent",
    customRoleId: delegated.id,
  });
  const p = {
    ...(await resolveStaffPrincipal(db, w.ws, w.member)),
    sessionId: await login(w.member),
  };
  await assert.rejects(
    () =>
      roles.save(p, {
        name: "Escalation",
        capabilities: ["identity:manage"],
        ticketScope: "team",
      }),
    /capabilities you do not hold/,
  );
  await assert.rejects(
    () =>
      roles.save(p, {
        name: "Scope escalation",
        capabilities: ["tickets:read"],
        ticketScope: "all",
      }),
    /broader ticket visibility/,
  );
  await assert.rejects(
    () =>
      roles.save(p, {
        id: delegated.id,
        revision: delegated.revision,
        name: "Self edit",
        capabilities: delegated.capabilities,
        ticketScope: "team",
      }),
    /assigned to yourself/,
  );
  await assert.rejects(
    () => roles.assignMember(p, w.owner, { role: "admin" }),
    /Owner access/,
  );
  const subordinate = uid();
  await db.pool.query(
    "INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,'agent')",
    [w.ws, subordinate],
  );
  await assert.rejects(
    () => roles.assignMember(p, subordinate, { role: "admin" }),
    /capabilities you do not hold/,
  );
  const allowed = await roles.save(p, {
    name: "Narrow subset",
    capabilities: ["tickets:read"],
    ticketScope: "assigned",
  });
  assert.ok(allowed?.id);
});
test("tenant boundaries, unknown capabilities, freshness after revocation, and optimistic revisions fail closed", async () => {
  const w = await fixture(),
    foreign = await fixture(),
    role = (await roles.save(w.p, narrow))!;
  await assert.rejects(
    () =>
      roles.assignMember(foreign.p, foreign.member, {
        role: "agent",
        customRoleId: role.id,
      }),
    /role in this workspace/,
  );
  await assert.rejects(() => roles.remove(foreign.p, role.id), /not found/i);
  await assert.rejects(
    () =>
      roles.save(w.p, {
        ...narrow,
        name: "Unknown",
        capabilities: ["superuser"],
      }),
    /Invalid option/,
  );
  await assert.rejects(
    () => roles.save(w.p, { ...narrow, id: role.id, revision: 999 }),
    /changed/,
  );
  await db.pool.query(
    "UPDATE memberships SET role='agent' WHERE workspace_id=$1 AND user_id=$2",
    [w.ws, w.owner],
  );
  await assert.rejects(
    () => roles.save(w.p, { ...narrow, name: "Stale owner principal" }),
    /roles:manage/,
  );
  await assert.rejects(() => roles.list(w.p), /administration required/);
});
test("parallel member changes and role edits serialize with routing and never leave old sessions usable", async () => {
  const w = await fixture(),
    role = (await roles.save(w.p, narrow))!,
    old = await login(w.member);
  await Promise.all([
    roles.assignMember(w.p, w.member, { role: "agent", customRoleId: role.id }),
    roles.save(w.p, {
      ...narrow,
      id: role.id,
      revision: role.revision,
      capabilities: ["tickets:read"],
    }),
  ]);
  assert.deepEqual(
    (await resolveStaffPrincipal(db, w.ws, w.member)).capabilities,
    ["tickets:read"],
  );
  assert.equal(
    await db.one("SELECT id FROM session WHERE id=$1", [old]),
    undefined,
  );
  await roles.assignMember(w.p, w.member, {
    role: "agent",
    customRoleId: null,
    disabled: true,
  });
  await assert.rejects(
    () => resolveStaffPrincipal(db, w.ws, w.member),
    /no longer available/,
  );
  await roles.remove(w.p, role.id);
  assert.equal(
    await db.one("SELECT id FROM staff_roles WHERE workspace_id=$1 AND id=$2", [
      w.ws,
      role.id,
    ]),
    undefined,
  );
});
