import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { Platform } from "../packages/platform/src/platform.js";
import { uid } from "../packages/platform/src/db.js";
import {
  MacroDefinition,
  visibleFormFields,
} from "../packages/platform/src/productivity-contracts.js";
import { validateFieldValue } from "../packages/platform/src/productivity.js";
import { PRODUCTIVITY_SCHEMA } from "../packages/platform/src/productivity-schema.js";
import {
  testConfig,
  resetDatabase,
  workspace,
  TestModel,
  TestProviders,
  knowledge,
} from "./helpers.js";
import type { Principal } from "../packages/platform/src/auth.js";
import { tokenHash } from "../packages/platform/src/security.js";
import { createApp } from "../apps/api/server.js";
const config = testConfig(4367),
  model = new TestModel(),
  app = new Platform(config, {
    model,
    fetch: new TestProviders().fetch,
    mailer: async () => {},
  });
before(async () => {
  await resetDatabase(config.DATABASE_URL);
  await app.migrate();
});
after(() => app.close());
type Work = Awaited<ReturnType<typeof workspace>>;
const field = (w: Work, d: any) =>
  app.productivity.saveField(w.owner, null, { definition: d });
const form = (w: Work, d: any) =>
  app.productivity.saveForm(w.owner, null, { definition: d });
const macro = (w: Work, d: any) =>
  app.productivity.saveLibrary(w.owner, "macros", null, { definition: d });
const view = (w: Work, d: any) =>
  app.productivity.saveLibrary(w.owner, "views", null, { definition: d });
const ticket = (w: Work, input: any = {}) =>
  app.newConversation(w.customer, {
    subject: "Synthetic request",
    body: "Please help with the test request",
    requestKey: uid(),
    ...input,
  });
async function restricted(
  w: Work,
  caps: string[],
  scope = "all",
  team?: string,
): Promise<Principal> {
  const id = uid(),
    roleId = uid();
  await app.db.pool.query(
    "INSERT INTO staff_roles(workspace_id,id,name,capabilities,ticket_scope,created_by) VALUES($1,$2,$2,$3,$4,$5)",
    [w.ws.id, roleId, JSON.stringify(caps), scope, w.owner.userId],
  );
  await app.db.pool.query(
    "INSERT INTO memberships(workspace_id,user_id,role,custom_role_id) VALUES($1,$2,'agent',$3)",
    [w.ws.id, id, roleId],
  );
  if (team)
    await app.db.pool.query(
      "INSERT INTO team_members(workspace_id,team_id,user_id) VALUES($1,$2,$3)",
      [w.ws.id, team, id],
    );
  return { workspaceId: w.ws.id, userId: id, role: "agent" };
}
async function team(w: Work, name = "Support") {
  const id = uid();
  await app.db.pool.query(
    "INSERT INTO teams(workspace_id,id,name) VALUES($1,$2,$3)",
    [w.ws.id, id, name],
  );
  return id;
}

test("field types validate values, stable options and real calendar dates", async () => {
  const w = await workspace(app);
  const definitions: any[] = [
    { label: "Single", type: "text" },
    { label: "Detail", type: "multiline" },
    { label: "Count", type: "number", min: 0, max: 5 },
    { label: "Confirmed", type: "boolean" },
    { label: "When", type: "date" },
    { label: "Choice", type: "select", options: [{ id: "one", label: "One" }] },
    {
      label: "Several",
      type: "multiselect",
      options: [
        { id: "one", label: "One" },
        { id: "two", label: "Two" },
      ],
    },
  ];
  const valid: any[] = [
      "text",
      "line\nline",
      3,
      false,
      "2026-02-28",
      "one",
      ["one", "two"],
    ],
    invalid: any[] = [
      "a\nb",
      42,
      6,
      "false",
      "2026-02-30",
      "unknown",
      ["one", "one"],
    ];
  for (let i = 0; i < definitions.length; i++) {
    const f = await field(w, definitions[i]);
    assert.equal(validateFieldValue(f, valid[i]), valid[i]);
    assert.throws(() => validateFieldValue(f, invalid[i]));
  }
  const f = await field(w, {
    label: "Options",
    type: "select",
    options: [{ id: "stable", label: "Original" }],
  });
  await assert.rejects(
    app.productivity.saveField(w.owner, f.id, {
      revision: f.revision,
      definition: { label: "Options", type: "select", options: [] },
    }),
  );
  await assert.rejects(
    app.productivity.saveField(w.owner, f.id, {
      revision: f.revision,
      definition: { ...definitions[0] },
    }),
    /type cannot change/,
  );
  const denied = await restricted(w, ["tickets:read"]);
  await assert.rejects(
    app.productivity.saveField(denied, null, { definition: definitions[0] }),
    /fields:manage/,
  );
});

test("conditional form validation agrees with preview, rejects cycles and hidden values, and preserves version history", async () => {
  const w = await workspace(app);
  const kind = await field(w, {
    label: "Topic",
    type: "select",
    customerVisible: true,
    customerEditable: true,
    options: [
      { id: "billing", label: "Billing" },
      { id: "other", label: "Other" },
    ],
  });
  const invoice = await field(w, {
    label: "Invoice reference",
    type: "text",
    customerVisible: true,
    customerEditable: true,
  });
  const f = await form(w, {
    name: "Billing",
    active: true,
    fields: [
      { fieldId: kind.id, required: true },
      {
        fieldId: invoice.id,
        required: true,
        visibleWhen: [{ fieldId: kind.id, op: "eq", value: "billing" }],
      },
    ],
  });
  assert.equal(visibleFormFields(f.fields, { [kind.id]: "other" }).length, 1);
  await assert.rejects(
    ticket(w, {
      formId: f.id,
      formVersion: f.revision,
      values: { [kind.id]: "billing" },
    }),
    /Invoice reference is required/,
  );
  await assert.rejects(
    ticket(w, {
      formId: f.id,
      formVersion: f.revision,
      values: { [kind.id]: "other", [invoice.id]: "hidden" },
    }),
    /hidden/,
  );
  const input = {
    formId: f.id,
    formVersion: f.revision,
    values: { [kind.id]: "billing", [invoice.id]: "INV-123" },
    requestKey: uid(),
  };
  const t = await ticket(w, input);
  assert.equal((await ticket(w, input)).id, t.id);
  await assert.rejects(
    ticket(w, {
      ...input,
      values: { [kind.id]: "billing", [invoice.id]: "changed" },
    }),
    /different form submission/,
  );
  await assert.rejects(
    form(w, {
      name: "Cycle",
      fields: [
        {
          fieldId: kind.id,
          visibleWhen: [{ fieldId: invoice.id, op: "is_set" }],
        },
        {
          fieldId: invoice.id,
          visibleWhen: [{ fieldId: kind.id, op: "is_set" }],
        },
      ],
    }),
    /cycle/,
  );
  const changed = await app.productivity.saveField(w.owner, kind.id, {
    revision: kind.revision,
    definition: {
      label: "Renamed topic",
      type: "select",
      customerVisible: true,
      customerEditable: true,
      options: [
        { id: "billing", label: "Invoices" },
        { id: "other", label: "Other" },
      ],
    },
  });
  const stored = await app.productivity.ticketFields(w.customer, t.id);
  assert.equal(
    stored.historical.find((v: any) => v.fieldId === kind.id)!.definition.label,
    "Topic",
  );
  assert.equal(
    stored.historical.find((v: any) => v.fieldId === kind.id)!.definition
      .options[0].label,
    "Billing",
  );
  const editedForm = await app.productivity.saveForm(w.owner, f.id, {
    revision: f.revision,
    definition: {
      name: "Billing v2",
      active: true,
      fields: [{ fieldId: kind.id, required: true }],
    },
  });
  assert.equal(editedForm.revision, 2);
  assert.equal((await ticket(w, input)).id, t.id); // Identical retries use the original submission.
  await assert.rejects(
    ticket(w, { ...input, requestKey: uid() }),
    /form changed/,
  );
  await app.db.pool.query(PRODUCTIVITY_SCHEMA);
  assert.equal(
    (await app.productivity.ticketFields(w.customer, t.id)).form!.version,
    1,
  );
  assert.equal(changed.id, kind.id);
});

test("email and legacy intake remain usable without new required portal fields", async () => {
  const w = await workspace(app),
    f = await field(w, {
      label: "Asset serial",
      type: "text",
      customerVisible: true,
      customerEditable: true,
    });
  const formRow = await form(w, {
    name: "Hardware",
    active: true,
    emailDefault: true,
    fields: [{ fieldId: f.id, required: true }],
  });
  const legacy = await ticket(w);
  assert.equal(
    (await app.productivity.ticketFields(w.owner, legacy.id)).form,
    null,
  );
  const id = uid();
  await app.db.tx(async (q) => {
    const c = (await app.db.one(
      "INSERT INTO conversations(id,workspace_id,contact_id,channel_id,subject) VALUES($1,$2,$3,$4,$5) RETURNING *",
      [id, w.ws.id, w.contactId, w.channelId, "Email request"],
      q,
    ))!;
    await app.productivity.applyIntake(w.customer, c, { source: "email" }, q);
  });
  const data = await app.productivity.ticketFields(w.owner, id);
  assert.equal(data.form!.id, formRow.id);
  assert.deepEqual(data.missing, ["Asset serial"]);
  await app.message(w.owner, id, {
    body: "Please send the serial when convenient.",
    requestKey: uid(),
  });
  assert.equal(
    (await app.db.one(
      "SELECT count(*)::int n FROM messages WHERE conversation_id=$1",
      [id],
    ))!.n,
    1,
  );
});

test("internal values never leak to customers, restricted staff, workflows or macro libraries", async () => {
  const w = await workspace(app),
    other = await workspace(app),
    t = await ticket(w),
    secret = await field(w, { label: "Private review", type: "text" });
  await app.productivity.updateFields(w.owner, t.id, {
    values: { [secret.id]: "private-token-marker" },
  });
  const customer = await app.productivity.ticketFields(w.customer, t.id);
  assert.ok(!JSON.stringify(customer).includes("private-token-marker"));
  assert.equal(customer.fields.length, 0);
  await assert.rejects(
    app.productivity.updateFields(w.customer, t.id, {
      values: { [secret.id]: "forged" },
    }),
    /hidden|editable/,
  );
  await assert.rejects(app.productivity.ticketFields(other.owner, t.id));
  const p = await restricted(w, ["tickets:read", "tickets:reply"]);
  const staff = await app.productivity.ticketFields(p, t.id);
  assert.equal(staff.fields.length, 0);
  assert.equal(staff.historical.length, 0);
  assert.deepEqual(await app.productivity.workflowFields(w.ws.id, t.id), []);
  const m = await macro(w, {
    name: "Internal template",
    note: true,
    scope: "workspace",
    body: `Review {{field.${secret.id}}}`,
    changes: { fields: { [secret.id]: "private-token-marker" } },
  });
  assert.equal((await app.productivity.library(p, "macros")).macros.length, 0);
  await assert.rejects(
    app.productivity.previewMacro(p, t.id, m.id),
    /Permission|restricted/,
  );
});

test("macro preview is side-effect free, missing values explicit, templates allowlisted and commit atomic/idempotent", async () => {
  const w = await workspace(app),
    t = await ticket(w);
  await app.db.pool.query("UPDATE contacts SET name='' WHERE id=$1", [
    w.contactId,
  ]);
  const m = await macro(w, {
    name: "Reply and resolve",
    scope: "workspace",
    body: "Hi {{customer.name}} <script>plain text</script> about {{ticket.subject}}",
    changes: { priority: "high", tags: ["reviewed"], status: "resolved" },
  });
  const before = await app.db.one(
    "SELECT count(*)::int n FROM messages WHERE conversation_id=$1",
    [t.id],
  );
  const preview = await app.productivity.previewMacro(w.owner, t.id, m.id);
  assert.deepEqual(preview.missing, ["customer.name"]);
  assert.match(preview.body, /\[Missing: customer.name\]/);
  assert.match(preview.body, /<script>plain text<\/script>/);
  assert.deepEqual(
    await app.db.one(
      "SELECT count(*)::int n FROM messages WHERE conversation_id=$1",
      [t.id],
    ),
    before,
  );
  await assert.rejects(
    macro(w, { name: "Unsafe", body: "{{process.env.SECRET}}" }),
    /restricted placeholder/,
  );
  const key = uid(),
    sent = await app.message(w.owner, t.id, {
      body: "Edited reviewed response",
      requestKey: key,
      macro: preview.macro,
    });
  assert.equal(
    (
      await app.message(w.owner, t.id, {
        body: "Edited reviewed response",
        requestKey: key,
        macro: preview.macro,
      })
    ).id,
    sent.id,
  );
  const changed = await app.db.one(
    "SELECT status,priority,tags FROM conversations WHERE id=$1",
    [t.id],
  );
  assert.deepEqual(changed, {
    status: "resolved",
    priority: "high",
    tags: ["reviewed"],
  });
  assert.equal(
    (await app.db.one(
      "SELECT count(*)::int n FROM macro_applications WHERE conversation_id=$1",
      [t.id],
    ))!.n,
    1,
  );
  await assert.rejects(
    app.message(w.owner, t.id, {
      body: "Edited reviewed response",
      requestKey: key,
      macro: { ...preview.macro, changes: { priority: "urgent" } },
    }),
    /different macro/,
  );
  const limited = await restricted(w, ["tickets:read", "tickets:reply"]);
  const simple = await macro(w, {
    name: "Simple",
    scope: "workspace",
    body: "Hello",
    changes: {},
  });
  const rejectedKey = uid();
  await assert.rejects(
    app.message(limited, t.id, {
      body: "Must not be sent",
      requestKey: rejectedKey,
      macro: {
        id: simple.id,
        revision: simple.revision,
        changes: { priority: "urgent" },
      },
    }),
    /tickets:update/,
  );
  assert.equal(
    (await app.db.one(
      "SELECT count(*)::int n FROM messages WHERE request_key=$1",
      [rejectedKey],
    ))!.n,
    0,
  );
  assert.equal(
    (await app.db.one(
      "SELECT count(*)::int n FROM ticket_emails e JOIN messages m ON m.id=e.message_id WHERE m.request_key=$1",
      [rejectedKey],
    ))!.n,
    0,
  );
});

test("personal and team sharing is tenant-bound and revocation takes effect immediately", async () => {
  const w = await workspace(app),
    teamId = await team(w);
  await app.db.pool.query(
    "INSERT INTO team_members(workspace_id,team_id,user_id) VALUES($1,$2,$3)",
    [w.ws.id, teamId, w.owner.userId],
  );
  const member = await restricted(
      w,
      ["tickets:read", "tickets:reply", "macros:personal"],
      "all",
      teamId,
    ),
    outsider = await restricted(w, [
      "tickets:read",
      "tickets:reply",
      "macros:personal",
    ]);
  const shared = await macro(w, {
      name: "Team reply",
      scope: "team",
      teamId,
      body: "Team response",
    }),
    personal = await macro(w, { name: "Private reply", body: "Only author" }),
    t = await ticket(w);
  assert.ok(
    (await app.productivity.library(member, "macros")).macros.some(
      (m: any) => m.id === shared.id,
    ),
  );
  assert.ok(
    !(await app.productivity.library(outsider, "macros")).macros.some(
      (m: any) => m.id === shared.id,
    ),
  );
  await assert.rejects(
    app.productivity.previewMacro(member, t.id, personal.id),
    /unavailable/,
  );
  await assert.rejects(
    app.productivity.saveLibrary(member, "macros", shared.id, {
      revision: shared.revision,
      definition: MacroDefinition.parse({
        name: "Hijack",
        scope: "team",
        teamId,
        body: "edited",
      }),
    }),
    /macros:shared/,
  );
  await app.db.pool.query(
    "DELETE FROM team_members WHERE workspace_id=$1 AND team_id=$2 AND user_id=$3",
    [w.ws.id, teamId, member.userId],
  );
  await assert.rejects(
    app.productivity.previewMacro(member, t.id, shared.id),
    /unavailable/,
  );
  await app.db.pool.query(
    "UPDATE memberships SET disabled=true WHERE workspace_id=$1 AND user_id=$2",
    [w.ws.id, member.userId],
  );
  await assert.rejects(
    app.productivity.library(member, "macros"),
    /no longer available/,
  );
});

test("saved views restrict rows and counts before pagination and reject archived filters and SQL input", async () => {
  const w = await workspace(app),
    teamId = await team(w),
    otherTeam = await team(w, "Other");
  const member = await restricted(
    w,
    ["tickets:read", "views:personal"],
    "team",
    teamId,
  );
  const ids: string[] = [];
  for (let i = 0; i < 43; i++) {
    const t = await ticket(w);
    ids.push(t.id);
    await app.db.pool.query("UPDATE conversations SET team_id=$2 WHERE id=$1", [
      t.id,
      i < 41 ? teamId : otherTeam,
    ]);
  }
  const saved = await view(w, {
    name: "Shared all",
    scope: "workspace",
    filters: [],
    columns: ["subject", "priority"],
  });
  const first = await app.productivity.viewResults(member, saved.id, {}),
    second = await app.productivity.viewResults(member, saved.id, { page: 2 });
  assert.equal(first.total, 41);
  assert.equal(first.conversations.length, 40);
  assert.equal(second.conversations.length, 1);
  assert.ok(
    !first.conversations.some((v: any) => ids.slice(41).includes(v.id)),
  );
  const defaults = (await app.productivity.library(member, "views")).views;
  assert.equal(defaults.filter((v: any) => v.builtin).length, 4);
  const mine = await app.productivity.viewResults(member, "default-team", {});
  assert.equal(mine.total, 41);
  const f = await field(w, {
    label: "Numeric",
    type: "number",
    customerVisible: true,
  });
  await app.productivity.updateFields(w.owner, ids[0], {
    values: { [f.id]: 3 },
  });
  const custom = await view(w, {
    name: "At least 3",
    scope: "workspace",
    filters: [{ field: `field.${f.id}`, op: "gte", value: 3 }],
    columns: ["subject", `field.${f.id}`],
  });
  assert.equal(
    (await app.productivity.viewResults(member, custom.id, {})).total,
    1,
  );
  await app.productivity.saveField(w.owner, f.id, {
    revision: f.revision,
    definition: {
      label: "Numeric",
      type: "number",
      customerVisible: true,
      archived: true,
    },
  });
  await assert.rejects(
    app.productivity.viewResults(member, custom.id, {}),
    /archived/,
  );
  await assert.rejects(
    view(w, {
      name: "SQL",
      filters: [
        { field: "status;DROP TABLE conversations", op: "eq", value: "open" },
      ],
    }),
    /Unknown/,
  );
  await app.db.pool.query(
    "DELETE FROM team_members WHERE workspace_id=$1 AND team_id=$2 AND user_id=$3",
    [w.ws.id, teamId, member.userId],
  );
  assert.equal(
    (await app.productivity.viewResults(member, saved.id, {})).total,
    0,
  );
});

test("direct customer HTTP requests cannot manage fields, read internal values, preview macros or forge hidden values", async () => {
  const w = await workspace(app),
    f = await field(w, { label: "Staff only", type: "text" }),
    t = await ticket(w);
  await app.productivity.updateFields(w.owner, t.id, {
    values: { [f.id]: "http-private-marker" },
  });
  const token = `test-${uid()}`;
  await app.db.pool.query(
    "INSERT INTO credentials(hash,workspace_id,contact_id,kind,expires_at,channel_id) VALUES($1,$2,$3,'widget',now()+interval '1 hour',$4)",
    [tokenHash(token), w.ws.id, w.contactId, w.channelId],
  );
  const server = await createApp(config, {
    model: new TestModel(),
    fetch: new TestProviders().fetch,
    mailer: async () => {},
  });
  await new Promise<void>((r) => server.server.listen(0, "127.0.0.1", r));
  const port = (server.server.address() as any).port;
  const call = (path: string, method = "GET", body?: any) =>
    fetch(`http://127.0.0.1:${port}/v2/workspaces/${w.ws.id}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  try {
    const response = await call(`/conversations/${t.id}/fields`);
    assert.equal(response.status, 200);
    assert.ok(!(await response.text()).includes("http-private-marker"));
    assert.equal(
      (
        await call("/ticket-fields", "POST", {
          definition: { label: "Forged", type: "text" },
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await call(`/conversations/${t.id}/fields`, "PUT", {
          values: { [f.id]: "forged" },
        })
      ).status,
      400,
    );
    const m = await macro(w, {
      name: "Staff",
      scope: "workspace",
      body: "Staff only",
    });
    assert.equal(
      (await call(`/conversations/${t.id}/macros/${m.id}/preview`, "POST", {}))
        .status,
      403,
    );
  } finally {
    await server.close();
  }
});

test("customer-visible structured values reach existing workflow context as untrusted data while internal fields stay out", async () => {
  const w = await workspace(app);
  await knowledge(app, w.ws.id);
  const publicField = await field(w, {
    label: "Device reference",
    type: "text",
    customerVisible: true,
    customerEditable: true,
  });
  const internal = await field(w, {
    label: "Private assessment",
    type: "text",
  });
  const requestForm = await form(w, {
    name: "Context form",
    active: true,
    fields: [{ fieldId: publicField.id }],
  });
  const t = await ticket(w, {
    formId: requestForm.id,
    formVersion: requestForm.revision,
    values: { [publicField.id]: "public-reference-123" },
  });
  await app.productivity.updateFields(w.owner, t.id, {
    values: { [internal.id]: "secret-workflow-marker" },
  });
  await app.message(w.customer, t.id, {
    body: "Please explain the return policy.",
    requestKey: uid(),
  });
  const run = (await app.db.one(
    "SELECT * FROM runs WHERE conversation_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1",
    [t.id],
  ))!;
  let calls = 0;
  model.hook = async (input) => {
    calls++;
    const context = input.messages.find((m) => m.role === "ticket_fields");
    assert.ok(context);
    assert.match(context.body, /Untrusted structured ticket values/);
    assert.match(context.body, /public-reference-123/);
    assert.ok(!JSON.stringify(input).includes("secret-workflow-marker"));
    assert.ok(!JSON.stringify(input).includes("Private assessment"));
  };
  try {
    await app.agent.advance(w.ws.id, run.id);
  } finally {
    model.hook = undefined;
  }
  assert.equal(calls, 1);
});

test("concurrent macro retries produce one response and revoked permissions invalidate a staged proposal", async () => {
  const w = await workspace(app),
    t = await ticket(w);
  const m = await macro(w, {
    name: "Concurrent response",
    scope: "workspace",
    body: "Reviewed response",
    changes: { priority: "high" },
  });
  const input = {
    body: "Reviewed response",
    requestKey: uid(),
    macro: { id: m.id, revision: m.revision, changes: { priority: "high" } },
  };
  const [a, b] = await Promise.all([
    app.message(w.owner, t.id, input),
    app.message(w.owner, t.id, input),
  ]);
  assert.equal(a.id, b.id);
  assert.equal(
    (await app.db.one(
      "SELECT count(*)::int n FROM messages WHERE conversation_id=$1 AND request_key=$2",
      [t.id, input.requestKey],
    ))!.n,
    1,
  );
  assert.equal(
    (await app.db.one(
      "SELECT count(*)::int n FROM macro_applications WHERE conversation_id=$1 AND request_key=$2",
      [t.id, input.requestKey],
    ))!.n,
    1,
  );
  const actor = await restricted(w, [
    "tickets:read",
    "tickets:reply",
    "tickets:update",
  ]);
  await app.productivity.previewMacro(actor, t.id, m.id);
  await app.db.pool.query(
    "UPDATE staff_roles SET capabilities=$2 WHERE workspace_id=$1 AND id=(SELECT custom_role_id FROM memberships WHERE workspace_id=$1 AND user_id=$3)",
    [w.ws.id, JSON.stringify(["tickets:read", "tickets:reply"]), actor.userId],
  );
  const requestKey = uid();
  await assert.rejects(
    app.message(actor, t.id, { ...input, requestKey }),
    /tickets:update/,
  );
  assert.equal(
    (await app.db.one(
      "SELECT count(*)::int n FROM messages WHERE conversation_id=$1 AND request_key=$2",
      [t.id, requestKey],
    ))!.n,
    0,
  );
});
