import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { Platform } from "../packages/platform/src/platform.js";
import { uid } from "../packages/platform/src/db.js";
import {
  csvCell,
  nextReportAt,
  reportCSV,
} from "../packages/platform/src/reporting.js";
import {
  defaultReportFilters,
  REPORT_METRICS,
  widgetQuery,
  Widget,
} from "../packages/platform/src/reporting-contracts.js";
import {
  testConfig,
  resetDatabase,
  workspace,
  TestModel,
  TestProviders,
} from "./helpers.js";
const config = testConfig(),
  sent: { to: string; text: string }[] = [],
  clock = { at: new Date(Date.now() + 1000) },
  providers = new TestProviders();
const app = new Platform(config, {
  model: new TestModel(),
  fetch: providers.fetch,
  clock: () => clock.at,
  mailer: async (to, _subject, text) => {
    sent.push({ to, text });
  },
});
before(async () => {
  await resetDatabase(config.DATABASE_URL);
  await app.migrate();
});
after(() => app.close());
const query = (metric = "conversations", patch: any = {}) => ({
  metric,
  groupBy: "none",
  filters: { ...defaultReportFilters, comparison: false },
  ...patch,
});
async function ticket(w: any, subject = "Report ticket", extra: any = {}) {
  const id = uid();
  await app.db.pool.query(
    "INSERT INTO conversations(id,workspace_id,contact_id,channel_id,subject,mode,status,priority,created_at,updated_at) VALUES($1,$2,$3,$4,$5,'human',$6,$7,$8,$8)",
    [
      id,
      w.ws.id,
      w.contactId,
      w.channelId,
      subject,
      extra.status ?? "open",
      extra.priority ?? "normal",
      new Date(clock.at.getTime() - 60000),
    ],
  );
  return id;
}
const definition = () => ({
  filters: { ...defaultReportFilters, comparison: false },
  widgets: [
    {
      id: "count",
      title: "Volume",
      type: "kpi",
      metric: "conversations",
      groupBy: "none",
      overrides: {},
      restrictions: {},
      layout: { x: 0, y: 0, w: 4, h: 4 },
    },
  ],
});
async function account(ws: string, role = "agent") {
  const user = await app.auth.auth.api.signUpEmail({
    body: {
      email: `report-${uid()}@example.test`,
      password: "Fixture-report-password-123!",
      name: "Report teammate",
    },
  });
  await app.db.pool.query(
    "INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,$3)",
    [ws, user.user.id, role],
  );
  return {
    workspaceId: ws,
    userId: user.user.id,
    role: role as "agent" | "owner" | "admin",
  };
}
test("metric catalog queries, paginated drilldown and selection use the full tenant cohort", async () => {
  const w = await workspace(app),
    other = await workspace(app);
  await ticket(other, "Other tenant");
  await app.db.pool.query(
    "INSERT INTO conversations(id,workspace_id,contact_id,channel_id,subject,mode,created_at,updated_at) SELECT $1||n,$2,$3,$4,'Ticket '||n,'human',$5,$5 FROM generate_series(1,245) n",
    [
      uid(),
      w.ws.id,
      w.contactId,
      w.channelId,
      new Date(clock.at.getTime() - 60000),
    ],
  );
  const total = await app.reporting.query(w.owner, query());
  assert.equal(total.total!.value, 245);
  const page = await app.reporting.drilldown(w.owner, {
    query: query(),
    offset: 200,
    limit: 50,
  });
  assert.equal(page.rows.length, 45);
  assert.equal(page.total, 245);
  assert.equal(page.hasMore, false);
  const legacyPage = await app.quality.analytics(w.owner, {
    page: 11,
    limit: 20,
  });
  assert.equal(legacyPage.conversationTotal, 245);
  assert.equal(legacyPage.conversations.length, 20);
  const exportJob = await app.reporting.export(w.owner, {
    requestKey: uid(),
    query: query(),
    rowLimit: 201,
  });
  await app.reporting.advance(w.ws.id, exportJob.id);
  const exported = await app.reporting.job(w.owner, exportJob.id, true);
  assert.equal(exported.row_count, 201);
  assert.equal(exported.truncated, true);
  const group = await app.reporting.query(
    w.owner,
    query("conversations", { groupBy: "channel" }),
  );
  assert.equal(group.groups[0].key, "portal");
  assert.equal(group.groups[0].value, 245);
  const selected = await app.reporting.drilldown(w.owner, {
    query: query("conversations", { groupBy: "channel" }),
    selection: { group: "email" },
  });
  assert.equal(selected.total, 0);
  for (const metric of REPORT_METRICS) {
    const result = await app.reporting.query(w.owner, query(metric.id));
    assert.equal(result.metric.id, metric.id);
    assert.ok(result.total);
  }
  const current = await app.reporting.query(
    w.owner,
    query("current_backlog", {
      filters: {
        ...defaultReportFilters,
        period: "custom",
        from: "2020-01-01T00:00:00.000Z",
        to: "2020-01-02T00:00:00.000Z",
      },
    }),
  );
  assert.equal(current.total!.value, 245);
  assert.equal(current.comparison, null);
});
test("widget restrictions intersect dashboard filters while overrides are explicit", async () => {
  const w = await workspace(app);
  await ticket(w, "High priority", { priority: "high" });
  await ticket(w, "Low priority", { priority: "low" });
  const widget = Widget.parse({
      ...definition().widgets[0],
      restrictions: { priorities: ["high"] },
    }),
    filters = {
      ...defaultReportFilters,
      comparison: false,
      priorities: ["low" as const],
    };
  assert.equal(
    (await app.reporting.query(w.owner, widgetQuery(widget, filters))).total!
      .value,
    0,
  );
  widget.overrides = { priorities: ["high"] };
  assert.equal(
    (await app.reporting.query(w.owner, widgetQuery(widget, filters))).total!
      .value,
    1,
  );
  await assert.rejects(
    () =>
      app.reporting.query(
        w.owner,
        query("current_backlog", { groupBy: "day" }),
      ),
    /cannot be grouped/,
  );
  await assert.rejects(
    () =>
      app.reporting.query(
        w.owner,
        query("conversations", {
          filters: {
            ...defaultReportFilters,
            period: "custom",
            from: "2026-01-01T00:00:00.000Z",
            to: "2025-01-01T00:00:00.000Z",
          },
        }),
      ),
    /date range/,
  );
});
test("delivered responses, automation, unknown history and CSAT have separate denominators", async () => {
  const w = await workspace(app),
    answered = await ticket(w),
    waiting = await ticket(w),
    automated = await ticket(w);
  const started = new Date(clock.at.getTime() - 60000),
    reply = new Date(clock.at.getTime() - 57000);
  for (const id of [answered, waiting, automated])
    await app.db.pool.query(
      "INSERT INTO messages(id,workspace_id,conversation_id,role,body,request_key,created_at) VALUES($1,$2,$3,'customer','Question',$1,$4)",
      [uid(), w.ws.id, id, started],
    );
  const answerId = uid();
  await app.db.pool.query(
    "INSERT INTO messages(id,workspace_id,conversation_id,role,body,request_key,created_at,delivered_at) VALUES($1,$2,$3,'assistant','Answer',$1,$4,$4)",
    [answerId, w.ws.id, answered, reply],
  );
  await app.db.pool.query(
    "INSERT INTO messages(id,workspace_id,conversation_id,role,body,request_key,created_at,delivered_at) VALUES($1,$2,$3,'reminder','Reminder',$1,$4,$4)",
    [uid(), w.ws.id, automated, reply],
  );
  await app.db.pool.query(
    'INSERT INTO events(workspace_id,conversation_id,kind,data) VALUES($1,$2,\'conversation.updated\',\'{"actorType":"automation","status":"resolved"}\'),($1,$3,\'conversation.updated\',\'{"actorType":"staff","status":"resolved"}\')',
    [w.ws.id, automated, answered],
  );
  await app.db.pool.query(
    "INSERT INTO customer_feedback(id,workspace_id,conversation_id,message_id,source,external_id,resolved,rating,answered_at) VALUES($1,$2,$3,$4,'native',$4,true,'good',$5)",
    [uid(), w.ws.id, answered, answerId, reply],
  );
  const response = await app.reporting.query(
    w.owner,
    query("first_response_ms"),
  );
  assert.equal(response.total!.value, 3000);
  assert.equal(response.total!.eligible, 1);
  assert.equal(response.total!.unknown, 2);
  assert.equal(
    (await app.reporting.query(w.owner, query("staff_resolutions"))).total!
      .value,
    1,
  );
  assert.equal(
    (await app.reporting.query(w.owner, query("automation_resolutions"))).total!
      .value,
    1,
  );
  assert.equal(
    (await app.reporting.query(w.owner, query("followups_sent"))).total!.value,
    1,
  );
  const csat = await app.reporting.query(w.owner, query("csat_good_rate"));
  assert.equal(csat.total!.value, 100);
  assert.equal(csat.total!.denominator, 1);
  const legacy = await app.quality.analytics(w.owner, {});
  assert.equal(legacy.totals!.staff_resolved, 1);
  assert.equal(legacy.totals!.response_time_denominator, 1);
});
test("dashboard ownership, shared permissions and optimistic save reject stale writes", async () => {
  const w = await workspace(app),
    agent = await account(w.ws.id),
    other = await account(w.ws.id),
    payload = { name: "Team overview", definition: definition() };
  const personal = await app.reporting.saveDashboard(agent, payload);
  await assert.rejects(
    () => app.reporting.getDashboard(other, personal.id),
    /not found/,
  );
  await assert.rejects(
    () =>
      app.reporting.saveDashboard(agent, {
        ...payload,
        visibility: "workspace",
      }),
    /reports:manage/,
  );
  const shared = await app.reporting.saveDashboard(w.owner, {
    ...payload,
    visibility: "workspace",
  });
  assert.equal(
    (await app.reporting.getDashboard(agent, shared.id)).id,
    shared.id,
  );
  await assert.rejects(
    () =>
      app.reporting.saveDashboard(
        agent,
        { ...payload, revision: shared.revision, visibility: "workspace" },
        shared.id,
      ),
    /reports:manage/,
  );
  const saved = await app.reporting.saveDashboard(
    w.owner,
    { ...payload, revision: shared.revision, visibility: "workspace" },
    shared.id,
  );
  assert.equal(saved.revision, shared.revision + 1);
  await assert.rejects(
    () =>
      app.reporting.saveDashboard(
        w.owner,
        { ...payload, revision: shared.revision, visibility: "workspace" },
        shared.id,
      ),
    /changed/,
  );
  const copy = await app.reporting.duplicateDashboard(agent, shared.id);
  assert.equal(copy.visibility, "personal");
  assert.equal(copy.created_by, agent.userId);
});
test("fresh all-ticket authority applies to catalog, queries, drilldown and retained artifacts", async () => {
  const w = await workspace(app),
    member = await account(w.ws.id, "admin"),
    id = uid();
  const job = await app.reporting.export(member, {
    requestKey: uid(),
    query: query(),
    rowLimit: 10,
  });
  await app.reporting.advance(w.ws.id, job.id);
  await app.db.pool.query(
    "INSERT INTO staff_roles(workspace_id,id,name,capabilities,ticket_scope,created_by) VALUES($1,$2,'Scoped reporter',$3,'assigned',$4)",
    [
      w.ws.id,
      id,
      JSON.stringify(["analytics:read", "tickets:read", "reports:export"]),
      w.owner.userId,
    ],
  );
  await app.db.pool.query(
    "UPDATE memberships SET custom_role_id=$3 WHERE workspace_id=$1 AND user_id=$2",
    [w.ws.id, member.userId, id],
  );
  for (const action of [
    () => app.reporting.catalog(member),
    () => app.reporting.query(member, query()),
    () => app.reporting.drilldown(member, { query: query() }),
    () => app.reporting.job(member, job.id, true),
  ])
    await assert.rejects(action, /all tickets/);
  await assert.rejects(() => app.reporting.query(w.customer, query()), /Staff/);
});
test("CSV exports are asynchronous, tenant-bound, formula-safe, idempotent and expire", async () => {
  const w = await workspace(app);
  await ticket(w, ' =HYPERLINK("https://example.test")');
  const input = { requestKey: uid(), query: query(), rowLimit: 1 };
  const job = await app.reporting.export(w.owner, input);
  assert.equal(job.status, "queued");
  assert.equal((await app.reporting.export(w.owner, input)).id, job.id);
  await assert.rejects(
    () => app.reporting.export(w.owner, { ...input, rowLimit: 2 }),
    /different report/,
  );
  await app.reporting.advance(w.ws.id, job.id);
  const result = await app.reporting.job(w.owner, job.id, true);
  assert.equal(result.status, "completed");
  assert.match(result.artifact.csv, /' =HYPERLINK/);
  assert.equal(result.row_count, 1);
  const stored = await app.db.one(
    "SELECT artifact_ciphertext FROM report_jobs WHERE id=$1",
    [job.id],
  );
  assert.ok(!stored!.artifact_ciphertext.includes("HYPERLINK"));
  const other = await workspace(app);
  await assert.rejects(
    () => app.reporting.job(other.owner, job.id, true),
    /Not found/,
  );
  await app.db.pool.query("UPDATE report_jobs SET expires_at=$2 WHERE id=$1", [
    job.id,
    new Date(clock.at.getTime() - 1),
  ]);
  await assert.rejects(
    () => app.reporting.job(w.owner, job.id, true),
    /expired/,
  );
  await app.reporting.retain(w.ws.id);
  assert.equal(
    (await app.db.one(
      "SELECT artifact_ciphertext FROM report_jobs WHERE id=$1",
      [job.id],
    ))!.artifact_ciphertext,
    null,
  );
  assert.equal(csvCell("\t=1+1"), '"\'\t=1+1"');
  assert.ok(reportCSV([{ a: 'a,"b"\nc' }], ["a"]).includes('"a,""b""\nc"'));
});
test("queued exports reauthorize the creator and cannot produce artifacts after revocation", async () => {
  const w = await workspace(app),
    member = await account(w.ws.id, "admin"),
    job = await app.reporting.export(member, {
      requestKey: uid(),
      query: query(),
      rowLimit: 10,
    });
  await app.db.pool.query(
    "UPDATE memberships SET disabled=true WHERE workspace_id=$1 AND user_id=$2",
    [w.ws.id, member.userId],
  );
  await app.reporting.advance(w.ws.id, job.id);
  const row = await app.db.one(
    "SELECT status,artifact_ciphertext FROM report_jobs WHERE id=$1",
    [job.id],
  );
  assert.equal(row!.status, "revoked");
  assert.equal(row!.artifact_ciphertext, null);
});
test("ticket deletion revokes completed and in-flight artifacts before committing", async () => {
  const w = await workspace(app),
    other = await workspace(app),
    id = await ticket(w, "Deleted reporting source"),
    create = (owner: typeof w.owner) =>
      app.reporting.export(owner, {
        requestKey: uid(),
        query: query(),
        rowLimit: 10,
      }),
    completed = await create(w.owner),
    unrelated = await create(other.owner);
  await app.reporting.advance(w.ws.id, completed.id);
  await app.reporting.advance(other.ws.id, unrelated.id);
  const dashboard = await app.reporting.saveDashboard(w.owner, {
      name: "Keep this definition",
      visibility: "personal",
      definition: definition(),
    }),
    inFlight = await create(w.owner);
  let release!: () => void,
    reached!: () => void,
    deletingStarted!: () => void,
    deletePid = 0;
  const generationHeld = new Promise<void>((resolve) => (release = resolve)),
    generationReached = new Promise<void>((resolve) => (reached = resolve)),
    deletionStarted = new Promise<void>(
      (resolve) => (deletingStarted = resolve),
    ),
    originalEvent = app.db.event.bind(app.db);
  app.db.event = async (...args: Parameters<typeof app.db.event>) => {
    if (args[1] === w.ws.id && args[2] === "report.completed") {
      reached();
      await generationHeld;
    }
    return originalEvent(...args);
  };
  let generating: Promise<void> | undefined,
    deleting: Promise<void> | undefined;
  try {
    generating = app.reporting.advance(w.ws.id, inFlight.id);
    await generationReached;
    deleting = app.db.tx(async (q) => {
      deletePid = (await q.query("SELECT pg_backend_pid() pid")).rows[0].pid;
      deletingStarted();
      await app.reporting.forgetConversation(w.ws.id, id, q);
      await q.query(
        "DELETE FROM conversations WHERE workspace_id=$1 AND id=$2",
        [w.ws.id, id],
      );
    });
    await deletionStarted;
    let blocked = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      blocked = !!(await app.db.one(
        "SELECT 1 FROM pg_locks WHERE pid=$1 AND locktype='advisory' AND NOT granted",
        [deletePid],
      ));
      if (blocked) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(blocked, "deletion waits for the in-flight artifact transaction");
  } finally {
    release();
    await Promise.all([generating, deleting]);
    app.db.event = originalEvent;
  }
  for (const job of [completed, inFlight]) {
    const stored = await app.db.one(
      "SELECT status,artifact_ciphertext FROM report_jobs WHERE id=$1",
      [job.id],
    );
    assert.equal(stored!.status, "revoked");
    assert.equal(stored!.artifact_ciphertext, null);
    await assert.rejects(
      () => app.reporting.job(w.owner, job.id, true),
      /Source data was removed.*new report/,
    );
  }
  assert.equal(
    (await app.reporting.getDashboard(w.owner, dashboard.id)).name,
    "Keep this definition",
  );
  assert.equal(
    (await app.reporting.job(other.owner, unrelated.id, true)).status,
    "completed",
  );
  const fresh = await create(w.owner);
  await app.reporting.advance(w.ws.id, fresh.id);
  assert.ok(
    !(await app.reporting.job(w.owner, fresh.id, true)).artifact.csv.includes(
      "Deleted reporting source",
    ),
  );
});
test("schedules run once per due slot, reauthorize recipients and email only sign-in links", async () => {
  const w = await workspace(app),
    owner = await account(w.ws.id, "admin"),
    recipient = await account(w.ws.id),
    removed = await account(w.ws.id),
    dashboard = await app.reporting.saveDashboard(owner, {
      name: "Scheduled report",
      visibility: "workspace",
      definition: definition(),
    });
  const schedule = await app.reporting.saveSchedule(owner, {
    dashboardId: dashboard.id,
    definition: {
      frequency: "daily",
      time: "09:00",
      timeZone: "America/Toronto",
      recipientIds: [recipient.userId, removed.userId],
    },
  });
  await app.db.pool.query(
    "UPDATE memberships SET disabled=true WHERE workspace_id=$1 AND user_id=$2",
    [w.ws.id, removed.userId],
  );
  await app.db.pool.query(
    "UPDATE report_schedules SET next_run_at=$2 WHERE id=$1",
    [schedule.id, new Date(clock.at.getTime() - 1000)],
  );
  await app.reporting.tick();
  await app.reporting.tick();
  const jobs = await app.db.rows(
    "SELECT * FROM report_jobs WHERE schedule_id=$1",
    [schedule.id],
  );
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].created_by, recipient.userId);
  const before = sent.length;
  await app.reporting.advance(w.ws.id, jobs[0].id);
  await app.reporting.advance(w.ws.id, jobs[0].id);
  assert.equal(sent.length, before + 1);
  assert.match(sent.at(-1)!.text, /view=dashboards&report=/);
  assert.ok(!sent.at(-1)!.text.includes("Conversation volume"));
  const snapshot = await app.reporting.job(recipient, jobs[0].id, true);
  assert.equal(snapshot.artifact.name, "Scheduled report");
  await app.db.pool.query(
    "UPDATE memberships SET disabled=true WHERE workspace_id=$1 AND user_id=$2",
    [w.ws.id, owner.userId],
  );
  await assert.rejects(
    () => app.reporting.job(recipient, jobs[0].id, true),
    /no longer available/,
  );
});
test("daily and weekly delivery respect DST and do not repeat a delivery slot", () => {
  const daily = {
    frequency: "daily",
    time: "09:00",
    timeZone: "America/Toronto",
    recipientIds: ["staff"],
  };
  assert.equal(
    nextReportAt(daily, new Date("2026-03-07T15:00:00Z")).toISOString(),
    "2026-03-08T13:00:00.000Z",
  );
  assert.equal(
    nextReportAt(
      { ...daily, frequency: "weekly", weekday: 1 },
      new Date("2026-03-08T15:00:00Z"),
    ).toISOString(),
    "2026-03-09T13:00:00.000Z",
  );
});

test("SLA and usage retain eligible denominators and exclude unattributed usage when ticket-filtered", async () => {
  const w = await workspace(app),
    id = await ticket(w),
    at = new Date(clock.at.getTime() - 60000);
  for (const [state, breached] of [
    ["satisfied", false],
    ["satisfied", true],
    ["running", false],
  ] as const)
    await app.db.pool.query(
      "INSERT INTO sla_obligations(id,workspace_id,conversation_id,kind,state,origin,policy_revision,policy,rule_id,started_at,due_at,warning_at,escalate_at,cause,satisfied_at,breached_at,ended_at) VALUES($1,$2,$3,'first',$4,$1,1,'{}','rule',$5,$5,$5,$5,'fixture',$6,$7,$8)",
      [
        uid(),
        w.ws.id,
        id,
        state,
        at,
        state === "satisfied" ? at : null,
        breached ? at : null,
        state === "satisfied" ? at : null,
      ],
    );
  const sla = await app.reporting.query(
    w.owner,
    query("sla_met_rate", { groupBy: "sla_kind" }),
  );
  assert.equal(sla.total!.value, 50);
  assert.equal(sla.total!.denominator, 2);
  assert.equal(sla.total!.unknown, 1);
  await app.db.pool.query(
    "INSERT INTO usage(id,workspace_id,kind,model,provider,input_tokens,output_tokens,reserved,purpose,created_at) VALUES($1,$2,'response','test-model','openai',100,20,30,'evaluation',$3)",
    [uid(), w.ws.id, at],
  );
  const usage = await app.reporting.query(
    w.owner,
    query("input_tokens", { groupBy: "purpose" }),
  );
  assert.equal(usage.total!.value, 100);
  assert.equal(usage.groups[0].key, "evaluation");
  assert.equal(
    (
      await app.reporting.query(
        w.owner,
        query("input_tokens", {
          filters: {
            ...defaultReportFilters,
            channels: ["portal"],
            comparison: false,
          },
        }),
      )
    ).total!.value,
    0,
  );
});

test("organization-bearing export cannot be opened after customer-read permission is removed", async () => {
  const w = await workspace(app),
    member = await account(w.ws.id, "admin"),
    id = await ticket(w);
  await app.db.pool.query(
    "INSERT INTO messages(id,workspace_id,conversation_id,role,body,request_key) VALUES($1,$2,$3,'note','PRIVATE-NOTE-NOT-EXPORTED',$1)",
    [uid(), w.ws.id, id],
  );
  const job = await app.reporting.export(member, {
    requestKey: uid(),
    query: query(),
    rowLimit: 10,
  });
  await app.reporting.advance(w.ws.id, job.id);
  const before = await app.reporting.job(member, job.id, true);
  assert.ok(!before.artifact.csv.includes("PRIVATE-NOTE-NOT-EXPORTED"));
  const role = uid();
  await app.db.pool.query(
    "INSERT INTO staff_roles(workspace_id,id,name,capabilities,ticket_scope,created_by) VALUES($1,$2,'No customer metadata',$3,'all',$4)",
    [
      w.ws.id,
      role,
      JSON.stringify(["analytics:read", "tickets:read", "reports:export"]),
      w.owner.userId,
    ],
  );
  await app.db.pool.query(
    "UPDATE memberships SET custom_role_id=$3 WHERE workspace_id=$1 AND user_id=$2",
    [w.ws.id, member.userId, role],
  );
  await assert.rejects(
    () => app.reporting.job(member, job.id, true),
    /no longer access/,
  );
  const drill = await app.reporting.drilldown(member, { query: query() });
  assert.equal(Object.hasOwn(drill.rows[0], "organization"), false);
});
