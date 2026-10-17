import type { PoolClient } from "pg";
import { z } from "zod";
import { Database, uid, type Queryable } from "./db.js";
import type { Mailer, Principal } from "./auth.js";
import { HttpError, requireValue } from "./config.js";
import {
  refreshPrincipal,
  requireCapability,
  resolveStaffPrincipal,
  canReadConversation,
  hasCapability,
} from "./permissions.js";
import { HumanRouting } from "./human-routing.js";
import {
  AutomationActivation,
  AutomationDefinition,
  AutomationSave,
  type AutomationDefinitionValue,
  type AutomationConditionValue,
} from "./ticket-automation-contracts.js";
import { businessDeadline } from "./sla-calendar.js";
import { queueTicketEmail } from "./ticket-email.js";

type Row = Record<string, any>;
type Patch = {
  mode?: "agent" | "human";
  status?: "open" | "resolved";
  priority?: "low" | "normal" | "high" | "urgent";
  tags?: string[];
  addTags?: string[];
  removeTags?: string[];
  teamId?: string | null;
  assignedTo?: string | null;
  requeue?: boolean;
  reason?: string;
};
export type AutomationHooks = {
  applyTicketChanges: (
    q: PoolClient,
    p: Principal,
    conv: Row,
    patch: Patch,
    meta: {
      actorType: "automation";
      origin: "automation";
      ruleId: string;
      executionId: string;
    },
  ) => Promise<unknown>;
  send: Mailer;
};
const native = (c: Row) =>
  !c.external_id && (c.published || c.origin === "email");
const sourceEvents = new Set([
  "conversation.created",
  "conversation.updated",
  "conversation.synced",
  "message.created",
  "response.delivered",
  "ticket_fields.updated",
  "ticket.sharing_changed",
  "macro.applied",
  "sla.wait_started",
  "sla.wait_ended",
  "sla.transition",
  "sla.warning",
]);
const closed = (c: Row) =>
  ["resolved", "closed", "solved"].includes(c.status) || !!c.merged_into_id;
const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);
export function automationMatches(
  c: AutomationConditionValue,
  values: Row,
): boolean {
  const v = values[c.field];
  if (c.op === "is_set")
    return (
      v !== null &&
      v !== undefined &&
      v !== "" &&
      (!Array.isArray(v) || v.length > 0)
    );
  if (c.op === "eq") return same(v, c.value);
  if (c.op === "neq") return !same(v, c.value);
  if (c.op === "in")
    return (
      Array.isArray(c.value) &&
      (Array.isArray(v)
        ? v.some((x) => (c.value as string[]).includes(x))
        : c.value.includes(String(v)))
    );
  if (c.op === "contains")
    return Array.isArray(v)
      ? v.includes(c.value)
      : typeof v === "string" &&
          typeof c.value === "string" &&
          v.includes(c.value);
  return (
    typeof v === "number" &&
    typeof c.value === "number" &&
    (c.op === "gte" ? v >= c.value : v <= c.value)
  );
}

/** Only writes scheduled work from event observers. Workers lock workspace before ticket. */
export class TicketAutomation {
  private executing = new WeakSet<PoolClient>();
  constructor(
    private db: Database,
    private routing: HumanRouting,
    private hooks: AutomationHooks,
    private clock: () => Date = () => new Date(),
  ) {}
  private async authority(p: Principal, q: Queryable = this.db.pool) {
    p = await refreshPrincipal(this.db, p, q);
    requireCapability(p, "automations:manage");
    requireCapability(p, "tickets:read");
    if (p.ticketScope !== "all")
      throw new HttpError(
        403,
        "Automation administration requires all-workspace ticket visibility",
      );
    return p;
  }
  private async ticket(ws: string, id: string, q: Queryable = this.db.pool) {
    return this.db.one(
      "SELECT c.*,ch.published,ch.kind channel_kind FROM conversations c LEFT JOIN channels ch ON ch.id=c.channel_id AND ch.workspace_id=c.workspace_id WHERE c.workspace_id=$1 AND c.id=$2",
      [ws, id],
      q,
    );
  }
  private async snapshot(c: Row, q: Queryable = this.db.pool) {
    const publicMessages = await this.db.rows(
      "SELECT * FROM (SELECT DISTINCT ON (role) id,role,created_at,delivered_at FROM messages WHERE workspace_id=$1 AND conversation_id=$2 AND role IN ('customer','staff','assistant') ORDER BY role,created_at DESC,id DESC) recent ORDER BY created_at DESC,id DESC",
      [c.workspace_id, c.id],
      q,
    );
    const wait = await this.db.one(
      "SELECT * FROM sla_waits WHERE workspace_id=$1 AND conversation_id=$2 AND status IN ('waiting','complete') ORDER BY created_at DESC,id DESC LIMIT 1",
      [c.workspace_id, c.id],
      q,
    );
    const fields = await this.db.rows(
      "SELECT field_id,value FROM ticket_field_values WHERE workspace_id=$1 AND conversation_id=$2",
      [c.workspace_id, c.id],
      q,
    );
    const obligations = await this.db.rows(
      "SELECT state,due_at,warning_at FROM sla_obligations WHERE workspace_id=$1 AND conversation_id=$2 AND ended_at IS NULL",
      [c.workspace_id, c.id],
      q,
    );
    const latest = publicMessages[0],
      customer = publicMessages.find((m) => m.role === "customer"),
      staff = publicMessages.find((m) => m.role === "staff" && m.delivered_at);
    const waiting =
      wait && latest?.id === wait.source_message_id && !closed(c) ? wait : null;
    const sla = obligations.some(
      (o) => o.state !== "paused" && new Date(o.due_at) <= this.clock(),
    )
      ? "overdue"
      : obligations.some(
            (o) =>
              o.state !== "paused" && new Date(o.warning_at) <= this.clock(),
          )
        ? "at_risk"
        : obligations.length
          ? "on_track"
          : "none";
    return {
      revision: c.revision,
      editVersion: c.edit_version ?? c.revision,
      fieldValues: fields
        .map((f) => [f.field_id, f.value])
        .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
      latestId: latest?.id ?? null,
      customerId: customer?.id ?? null,
      staffId: staff?.id ?? null,
      customerAt: customer?.created_at ?? null,
      staffAt: staff?.delivered_at ?? null,
      createdAt: c.created_at,
      changedAt: c.updated_at,
      waitId: waiting?.id ?? null,
      waitAt: waiting?.created_at ?? null,
      waitSource: waiting?.source_message_id ?? null,
      values: {
        status: c.status,
        channel:
          c.origin === "email" || c.intake_source === "email"
            ? "email"
            : c.channel_kind,
        priority: c.priority,
        team: c.team_id ?? null,
        assignee: c.assigned_to ?? null,
        tags: c.tags ?? [],
        form: c.form_id ?? null,
        organization: c.organization_id ?? null,
        waiting: !!waiting,
        sla,
        ...Object.fromEntries(
          fields.map((f) => [`field.${f.field_id}`, f.value]),
        ),
      },
    };
  }
  private matches(d: AutomationDefinitionValue, s: Row) {
    return (
      d.all.every((c) => automationMatches(c, s.values)) &&
      (!d.any.length || d.any.some((c) => automationMatches(c, s.values)))
    );
  }
  private async validate(
    p: Principal,
    d: AutomationDefinitionValue,
    q: Queryable = this.db.pool,
  ) {
    const fields = await this.db.rows(
      "SELECT id,definition FROM ticket_fields WHERE workspace_id=$1",
      [p.workspaceId],
      q,
    );
    const enums: Record<string, unknown[]> = {
      status: ["open", "needs_staff", "waiting_approval", "resolved"],
      channel: ["portal", "widget", "email", "zendesk"],
      priority: ["low", "normal", "high", "urgent"],
      waiting: [true, false],
      sla: ["none", "on_track", "at_risk", "overdue"],
    };
    for (const c of [...d.all, ...d.any]) {
      if (c.op === "in" && !Array.isArray(c.value))
        throw new HttpError(400, "In comparisons require a list");
      if (c.op !== "is_set" && c.value === undefined)
        throw new HttpError(400, "A condition needs a comparison value");
      if (c.field.startsWith("field.")) {
        const f = fields.find((f) => f.id === c.field.slice(6));
        if (!f || f.definition.archived)
          throw new HttpError(400, "Choose an active custom field");
        if (!f.definition.customerVisible)
          requireCapability(p, "fields:internal:read");
        const type = f.definition.type;
        if (["text", "multiline"].includes(type))
          throw new HttpError(
            400,
            "Automation conditions support typed fields, not free text",
          );
        const allowedOps =
          type === "multiselect"
            ? ["contains", "in", "is_set"]
            : type === "number"
              ? ["eq", "neq", "gte", "lte", "is_set"]
              : type === "select"
                ? ["eq", "neq", "in", "is_set"]
                : ["eq", "neq", "is_set"];
        if (!allowedOps.includes(c.op))
          throw new HttpError(
            400,
            "Comparison is not supported for this field type",
          );
        if (c.op === "is_set") continue;
        if (type === "number" && typeof c.value !== "number")
          throw new HttpError(400, "Number fields require a number");
        if (type === "boolean" && typeof c.value !== "boolean")
          throw new HttpError(400, "Boolean fields require true or false");
        if (
          type === "date" &&
          (typeof c.value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(c.value))
        )
          throw new HttpError(400, "Date fields require YYYY-MM-DD");
        if (["select", "multiselect"].includes(type)) {
          const allowed = f.definition.options
              .filter((o: Row) => !o.archived)
              .map((o: Row) => o.id),
            values = Array.isArray(c.value) ? c.value : [c.value];
          if (values.some((v) => !allowed.includes(v)))
            throw new HttpError(400, "Choose active field options");
        }
        if (["gte", "lte"].includes(c.op) && type !== "number")
          throw new HttpError(400, "Range comparisons require a number field");
      } else if (enums[c.field]) {
        const values =
          c.op === "in" && Array.isArray(c.value) ? c.value : [c.value];
        if (
          c.op !== "is_set" &&
          values.some((v) => !enums[c.field].includes(v))
        )
          throw new HttpError(400, "Invalid condition value");
        if (!["eq", "neq", "in", "is_set"].includes(c.op))
          throw new HttpError(400, "Choose equals, not equals or in");
      } else if (
        ["team", "assignee", "form", "organization"].includes(c.field)
      ) {
        if (!["eq", "neq", "in", "is_set"].includes(c.op))
          throw new HttpError(400, "Invalid reference comparison");
        const values =
          c.op === "is_set" ? [] : Array.isArray(c.value) ? c.value : [c.value];
        for (const value of values)
          if (value !== null) {
            const query = (
              {
                team: "SELECT 1 FROM teams WHERE workspace_id=$1 AND id=$2 AND active",
                assignee:
                  "SELECT 1 FROM memberships WHERE workspace_id=$1 AND user_id=$2 AND NOT disabled",
                form: "SELECT 1 FROM ticket_forms WHERE workspace_id=$1 AND id=$2 AND NOT (definition->>'archived')::boolean",
                organization:
                  "SELECT 1 FROM customer_organizations WHERE workspace_id=$1 AND id=$2 AND active",
              } as Row
            )[c.field];
            if (
              typeof value !== "string" ||
              !(await this.db.one(query, [p.workspaceId, value], q))
            )
              throw new HttpError(
                400,
                "Condition references an unavailable workspace record",
              );
          }
      } else if (c.field === "tags") {
        if (!["contains", "in", "is_set"].includes(c.op))
          throw new HttpError(400, "Tags support contains or in");
        if (
          (c.op === "contains" && typeof c.value !== "string") ||
          (c.op === "in" && !Array.isArray(c.value))
        )
          throw new HttpError(400, "Choose a tag or a list of tags");
      } else throw new HttpError(400, "Unknown automation condition");
    }
    for (const a of d.actions) {
      requireCapability(
        p,
        a.type === "reply"
          ? "tickets:reply"
          : a.type === "note"
            ? "tickets:note"
            : a.type === "notify"
              ? "tickets:read"
              : a.type === "route"
                ? "tickets:assign"
                : "tickets:update",
      );
      if (a.type === "route") requireCapability(p, "tickets:update");
      if (
        a.type === "route" &&
        !(await this.db.one(
          "SELECT 1 FROM teams WHERE workspace_id=$1 AND id=$2 AND active",
          [p.workspaceId, a.teamId],
          q,
        ))
      )
        throw new HttpError(400, "Choose an active workspace team");
      if (a.type === "notify")
        for (const id of a.userIds)
          await resolveStaffPrincipal(this.db, p.workspaceId, id, q);
      if ("body" in a && /\{\{|\}\}/.test(a.body))
        throw new HttpError(
          400,
          "Use reviewed literal text; dynamic template variables are not supported",
        );
    }
  }
  private async definitionVisible(p: Principal, q: Queryable = this.db.pool) {
    if (hasCapability(p, "fields:internal:read")) return (_d: Row) => true;
    const fields = await this.db.rows(
      "SELECT id FROM ticket_fields WHERE workspace_id=$1 AND (definition->>'customerVisible')::boolean",
      [p.workspaceId],
      q,
    );
    const visible = new Set(fields.map((f) => `field.${f.id}`));
    return (d: Row) =>
      [...(d.all ?? []), ...(d.any ?? [])].every(
        (c) => !c.field.startsWith("field.") || visible.has(c.field),
      );
  }
  async list(p: Principal) {
    p = await this.authority(p);
    const visible = await this.definitionVisible(p);
    return {
      rules: (
        await this.db.rows(
          "SELECT * FROM ticket_automation_rules WHERE workspace_id=$1 ORDER BY position,created_at,id",
          [p.workspaceId],
        )
      ).filter((r) => visible(r.definition)),
      teams: await this.db.rows(
        "SELECT id,name FROM teams WHERE workspace_id=$1 AND active ORDER BY name",
        [p.workspaceId],
      ),
      members: await this.db.rows(
        'SELECT m.user_id,u.name,u.email FROM memberships m LEFT JOIN "user" u ON u.id=m.user_id WHERE m.workspace_id=$1 AND NOT m.disabled ORDER BY u.name',
        [p.workspaceId],
      ),
      fields: (
        await this.db.rows(
          "SELECT id,definition FROM ticket_fields WHERE workspace_id=$1 AND NOT (definition->>'archived')::boolean",
          [p.workspaceId],
        )
      ).filter(
        (f) =>
          f.definition.customerVisible ||
          hasCapability(p, "fields:internal:read"),
      ),
      forms: await this.db.rows(
        "SELECT id,definition->>'name' name FROM ticket_forms WHERE workspace_id=$1 AND NOT (definition->>'archived')::boolean",
        [p.workspaceId],
      ),
      organizations: await this.db.rows(
        "SELECT id,name FROM customer_organizations WHERE workspace_id=$1 AND active ORDER BY name",
        [p.workspaceId],
      ),
    };
  }
  async save(p: Principal, raw: unknown) {
    const d = AutomationSave.parse(raw);
    return this.db.tx(async (q) => {
      await this.routing.lockWorkspace(q, p.workspaceId);
      p = await this.authority(p, q);
      await this.validate(p, d.definition, q);
      const old = d.id
        ? requireValue(
            await this.db.one(
              "SELECT * FROM ticket_automation_rules WHERE workspace_id=$1 AND id=$2 FOR UPDATE",
              [p.workspaceId, d.id],
              q,
            ),
          )
        : null;
      if (old && !(await this.definitionVisible(p, q))(old.definition))
        throw new HttpError(
          403,
          "Internal field permission is required for this rule",
        );
      if (old?.legacy_sla)
        throw new HttpError(
          409,
          "Edit the migrated reminder through SLA policy settings",
        );
      if (old && old.revision !== d.revision)
        throw new HttpError(409, "Rule changed; reload before saving");
      if (
        !old &&
        (await this.db.one(
          "SELECT count(*)::int n FROM ticket_automation_rules WHERE workspace_id=$1",
          [p.workspaceId],
          q,
        ))!.n >= 50
      )
        throw new HttpError(409, "At most 50 automation rules are allowed");
      const id = d.id ?? uid(),
        revision = (old?.revision ?? 0) + 1;
      const row = await this.db.one(
        "INSERT INTO ticket_automation_rules(workspace_id,id,revision,position,definition,configured_by) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(workspace_id,id) DO UPDATE SET revision=$3,position=$4,definition=$5,configured_by=$6,updated_at=now() RETURNING *",
        [p.workspaceId, id, revision, d.position, d.definition, p.userId],
        q,
      );
      await q.query(
        "INSERT INTO ticket_automation_versions(workspace_id,rule_id,revision,definition,configured_by) VALUES($1,$2,$3,$4,$5)",
        [p.workspaceId, id, revision, d.definition, p.userId],
      );
      await this.db.event(q, p.workspaceId, "automation.rule_saved", {
        ruleId: id,
        revision,
        actorId: p.userId,
        origin: "automation",
      });
      return row;
    });
  }
  async activate(p: Principal, id: string, raw: unknown) {
    const d = AutomationActivation.parse(raw);
    return this.db.tx(async (q) => {
      await this.routing.lockWorkspace(q, p.workspaceId);
      p = await this.authority(p, q);
      const r = requireValue(
        await this.db.one(
          "SELECT * FROM ticket_automation_rules WHERE workspace_id=$1 AND id=$2 FOR UPDATE",
          [p.workspaceId, id],
          q,
        ),
      );
      if (r.legacy_sla)
        throw new HttpError(
          409,
          "Change migrated reminder enablement in SLA policy settings",
        );
      if (r.revision !== d.revision)
        throw new HttpError(409, "Rule changed; preview its current revision");
      if (d.enabled && !d.confirm)
        throw new HttpError(400, "Confirm activation of the reviewed rule");
      await this.validate(p, AutomationDefinition.parse(r.definition), q);
      await q.query(
        "UPDATE ticket_automation_rules SET enabled=$3,active_revision=CASE WHEN $3 THEN revision ELSE active_revision END,activated_by=$4,updated_at=now() WHERE workspace_id=$1 AND id=$2",
        [p.workspaceId, id, d.enabled, p.userId],
      );
      await q.query(
        "UPDATE ticket_automation_executions SET status='suppressed',reason='Rule activation changed',finished_at=$3 WHERE workspace_id=$1 AND rule_id=$2 AND status='pending'",
        [p.workspaceId, id, this.clock()],
      );
      await this.db.event(q, p.workspaceId, "automation.rule_activated", {
        ruleId: id,
        revision: d.revision,
        enabled: d.enabled,
        actorId: p.userId,
        origin: "automation",
      });
      return { enabled: d.enabled, revision: d.revision };
    });
  }
  async preview(p: Principal, raw: unknown) {
    p = await this.authority(p);
    const d = AutomationDefinition.parse(raw);
    await this.validate(p, d);
    const rows = await this.db.rows(
      "SELECT c.*,ch.published,ch.kind channel_kind FROM conversations c LEFT JOIN channels ch ON ch.id=c.channel_id AND ch.workspace_id=c.workspace_id WHERE c.workspace_id=$1 ORDER BY c.created_at DESC,c.id DESC LIMIT 501",
      [p.workspaceId],
    );
    const matches = [];
    for (const c of rows.slice(0, 500)) {
      const snapshot = await this.snapshot(c);
      if (this.matches(d, snapshot))
        matches.push({
          id: c.id,
          subject: c.subject,
          status: c.status,
          eligible: !closed(c) && native(c),
          reason: closed(c)
            ? "Ticket is closed"
            : !c.published && c.origin !== "email"
              ? "Channel is unpublished"
              : c.external_id
                ? "External ticket is authoritative"
                : "Conditions match",
          dueAt: this.anchor(d, snapshot)?.dueAt ?? null,
        });
    }
    return {
      matched: matches.length,
      scanned: Math.min(rows.length, 500),
      truncated: rows.length > 500,
      tickets: matches.slice(0, 30),
      actions: d.actions,
      semantics:
        "Read-only sample of current conditions. Future triggers and live permission checks decide execution; no actions have run.",
    };
  }
  private anchor(d: AutomationDefinitionValue, s: Row) {
    if (d.trigger.type !== "inactivity") return null;
    const source = (
      {
        created: [s.createdAt, "created"],
        last_customer: [s.customerAt, s.customerId],
        last_staff: [s.staffAt, s.staffId],
        ticket_changed: [s.changedAt, `edit:${s.editVersion ?? s.revision}`],
        waiting: [s.waitAt, s.waitId],
      } as Row
    )[d.trigger.anchor];
    if (!source?.[0] || !source[1]) return null;
    const dueAt =
      d.trigger.clock === "business"
        ? businessDeadline(source[0], d.trigger.minutes, d.trigger.calendar!)
        : new Date(
            new Date(source[0]).getTime() + d.trigger.minutes * 60000,
          ).toISOString();
    return { key: `${d.trigger.anchor}:${source[1]}`, dueAt };
  }
  private async eventKind(e: Row, q: Queryable) {
    if (e.kind === "conversation.created") return "created";
    if (e.kind === "sla.warning") return "sla_warning";
    if (e.kind === "sla.transition" && e.data.state === "breached")
      return "sla_breach";
    if (
      ["message.created", "response.delivered"].includes(e.kind) &&
      e.data.messageId
    ) {
      const m = await this.db.one(
        "SELECT role,delivered_at,automation_execution_id FROM messages WHERE workspace_id=$1 AND id=$2",
        [e.workspace_id, e.data.messageId],
        q,
      );
      if (m?.automation_execution_id) return null;
      if (m?.role === "customer") return "customer_message";
      if (m?.role === "staff" && m.delivered_at) return "staff_reply";
      return null;
    }
    return [
      "conversation.updated",
      "ticket_fields.updated",
      "ticket.sharing_changed",
      "macro.applied",
    ].includes(e.kind)
      ? "ticket_changed"
      : null;
  }
  async observe(q: PoolClient, e: Row) {
    if (
      this.executing.has(q) ||
      !e.conversation_id ||
      e.data?.origin === "automation" ||
      !sourceEvents.has(e.kind)
    )
      return;
    const rules = await this.db.rows(
      "SELECT r.*,v.definition active_definition,r.activated_by active_actor FROM ticket_automation_rules r JOIN ticket_automation_versions v ON v.workspace_id=r.workspace_id AND v.rule_id=r.id AND v.revision=r.active_revision WHERE r.workspace_id=$1 AND r.enabled AND NOT r.legacy_sla ORDER BY r.position,r.created_at,r.id",
      [e.workspace_id],
      q,
    );
    if (!rules.length && e.kind !== "sla.wait_started") return;
    const c = await this.ticket(e.workspace_id, e.conversation_id, q);
    if (!c || c.merged_into_id) return;
    if (e.kind === "sla.wait_started")
      await this.adoptLegacy(q, c, e.data.waitId);
    if (!rules.length) return;
    const s = await this.snapshot(c, q),
      kind = await this.eventKind(e, q);
    for (const r of rules) {
      const d = AutomationDefinition.parse(r.active_definition);
      if (!this.matches(d, s)) continue;
      if (
        d.trigger.type === "inactivity" &&
        d.trigger.anchor === "ticket_changed" &&
        !["created", "ticket_changed"].includes(kind ?? "")
      )
        continue;
      if (kind === "ticket_changed") s.changedAt = e.created_at;
      const anchor = this.anchor(d, s);
      if (d.trigger.type === "event" && d.trigger.event !== kind) continue;
      if (d.trigger.type === "inactivity" && !anchor) continue;
      // Repeated delivery observations share a source message identity.
      const sourceKey =
        anchor?.key ??
        `${kind}:${e.data.messageId ?? (e.data.obligationId ? `${e.data.obligationId}:${e.data.generation}` : e.id)}`;
      await this.enqueue(
        q,
        c,
        r,
        d,
        s,
        sourceKey,
        anchor?.dueAt ?? this.clock().toISOString(),
        e.id,
      );
    }
  }
  private async enqueue(
    q: PoolClient,
    c: Row,
    r: Row,
    d: AutomationDefinitionValue,
    s: Row,
    sourceKey: string,
    dueAt: string,
    eventId?: number,
    legacy?: Row,
  ) {
    const row = await this.db.one(
      "INSERT INTO ticket_automation_executions(id,workspace_id,conversation_id,rule_id,rule_revision,source_key,source_event_id,source_snapshot,definition,configured_by,due_at,legacy_wait_id,legacy_generation) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT DO NOTHING RETURNING id",
      [
        uid(),
        c.workspace_id,
        c.id,
        r.id,
        r.active_revision,
        sourceKey,
        eventId ?? null,
        s,
        d,
        r.active_actor ?? r.configured_by,
        dueAt,
        legacy?.id ?? null,
        legacy ? legacy.sent_count + 1 : null,
      ],
      q,
    );
    if (row)
      await this.db.enqueue(q, "ticket-automation", {
        workspaceId: c.workspace_id,
        executionId: row.id,
      });
    return row;
  }
  private async legacyEligible(q: Queryable, c: Row, e: Row) {
    const w = await this.db.one(
      "SELECT * FROM sla_waits WHERE workspace_id=$1 AND id=$2",
      [e.workspace_id, e.legacy_wait_id],
      q,
    );
    const policy = await this.db.one(
      "SELECT revision,policy FROM sla_policies WHERE workspace_id=$1",
      [e.workspace_id],
      q,
    );
    if (!w || !["waiting", "complete"].includes(w.status) || !w.allowed)
      return "Waiting cycle ended or reminders were not allowed";
    if (
      !policy?.policy.enabled ||
      !policy.policy.followup.enabled ||
      policy.revision !== w.policy_revision
    )
      return "Legacy reminder policy changed or disabled";
    if (c.revision !== w.conversation_revision)
      return "Ticket changed after waiting began";
    try {
      const actor = await resolveStaffPrincipal(
        this.db,
        e.workspace_id,
        w.actor_id,
        q,
      );
      requireCapability(actor, "tickets:reply");
      if (!canReadConversation(actor, c))
        return "Initiating staff access changed";
    } catch {
      return "Initiating staff access revoked";
    }
    return null;
  }
  private async guard(q: Queryable, c: Row, e: Row, delivery = false) {
    const rule = await this.db.one(
      "SELECT enabled,active_revision FROM ticket_automation_rules WHERE workspace_id=$1 AND id=$2",
      [e.workspace_id, e.rule_id],
      q,
    );
    if (!rule?.enabled || rule.active_revision !== e.rule_revision)
      return "Rule was disabled or replaced";
    if (c.merged_into_id) return "Ticket was merged";
    if (
      closed(c) &&
      !(
        delivery &&
        e.definition.actions.some((a: Row) => a.type === "resolve") &&
        c.status === "resolved"
      )
    )
      return "Ticket is closed";
    if (!native(c)) return "Only published native tickets can run automations";
    if (e.legacy_wait_id) {
      const reason = await this.legacyEligible(q, c, e);
      if (reason) return reason;
    }
    const s = await this.snapshot(c, q),
      old = e.source_snapshot;
    if (s.latestId !== old.latestId || s.customerId !== old.customerId)
      return "A public message changed the source generation";
    if (
      !e.legacy_wait_id &&
      old.fieldValues &&
      !same(s.fieldValues, old.fieldValues)
    )
      return "Custom ticket fields changed after the source event";
    if (
      !e.legacy_wait_id &&
      c.revision !==
        (delivery ? (old.deliveryRevision ?? old.revision) : old.revision)
    )
      return "Ticket changed after the source event";
    if (delivery && old.deliveryValues) {
      for (const condition of [...e.definition.all, ...e.definition.any])
        if (
          !same(
            (s.values as Row)[condition.field],
            old.deliveryValues[condition.field],
          )
        )
          return "A condition changed after automation execution";
    } else if (!this.matches(AutomationDefinition.parse(e.definition), s))
      return "Rule conditions no longer match";
    return null;
  }
  async run(ws: string, id: string) {
    const target = await this.db.one(
      "SELECT conversation_id FROM ticket_automation_executions WHERE workspace_id=$1 AND id=$2",
      [ws, id],
    );
    if (!target) return;
    // All due rules for this ticket run in configured order, independent of job delivery order.
    const due = await this.db.rows(
      "SELECT e.id FROM ticket_automation_executions e JOIN ticket_automation_rules r ON r.workspace_id=e.workspace_id AND r.id=e.rule_id WHERE e.workspace_id=$1 AND e.conversation_id=$2 AND e.status='pending' AND e.due_at<=$3 ORDER BY e.due_at,r.position,r.created_at,r.id,e.id LIMIT 100",
      [ws, target.conversation_id, this.clock()],
    );
    for (const row of due) await this.execute(ws, row.id);
  }
  private async execute(ws: string, id: string) {
    try {
      await this.db.tx(async (q) => {
        this.executing.add(q);
        try {
          await this.routing.lockWorkspace(q, ws);
          const hint = await this.db.one(
            "SELECT conversation_id FROM ticket_automation_executions WHERE workspace_id=$1 AND id=$2",
            [ws, id],
            q,
          );
          if (!hint) return;
          await q.query(
            "SELECT id FROM conversations WHERE workspace_id=$1 AND id=$2 FOR UPDATE",
            [ws, hint.conversation_id],
          );
          let c = await this.ticket(ws, hint.conversation_id, q);
          if (!c) return;
          const e = await this.db.one(
            "SELECT * FROM ticket_automation_executions WHERE workspace_id=$1 AND id=$2 FOR UPDATE",
            [ws, id],
            q,
          );
          if (!e || e.status !== "pending" || new Date(e.due_at) > this.clock())
            return;
          let reason = await this.guard(q, c, e);
          let p: Principal | undefined;
          const d = AutomationDefinition.parse(e.definition);
          if (!reason)
            try {
              p = await this.authority(
                await resolveStaffPrincipal(this.db, ws, e.configured_by, q),
                q,
              );
              await this.validate(p, d, q);
            } catch (error) {
              reason = (error as Error).message;
            }
          if (!reason && d.actions.some((a) => a.type === "resolve")) {
            const s = await this.snapshot(c, q);
            if (
              !s.waitAt ||
              this.clock().getTime() - new Date(s.waitAt).getTime() < 86400000
            )
              reason =
                "Automatic resolution requires 24 elapsed hours waiting for the customer";
            else if (
              c.status === "waiting_approval" ||
              (await this.db.one(
                "SELECT 1 FROM approvals a JOIN runs r ON r.id=a.run_id AND r.workspace_id=a.workspace_id WHERE r.workspace_id=$1 AND r.conversation_id=$2 AND a.status='pending' UNION ALL SELECT 1 FROM operations o JOIN runs r ON r.id=o.run_id AND r.workspace_id=o.workspace_id WHERE r.workspace_id=$1 AND r.conversation_id=$2 AND o.status IN ('prepared','sent','unknown') LIMIT 1",
                [ws, c.id],
                q,
              ))
            )
              reason =
                "Approval or uncertain business operation prevents automatic resolution";
          }
          if (
            !reason &&
            d.actions.some((a) => a.type === "route") &&
            c.assignment_source === "manual" &&
            c.assigned_to
          )
            reason = "Manual ownership prevents automatic reassignment";
          if (reason) {
            await this.finish(q, e, "suppressed", reason);
            return;
          }
          const meta = {
            actorType: "automation" as const,
            origin: "automation" as const,
            ruleId: e.rule_id,
            executionId: e.id,
          };
          const patch: Patch = {};
          for (const a of d.actions) {
            if (a.type === "priority") patch.priority = a.value;
            if (a.type === "tags") {
              patch.addTags = [
                ...new Set([...(patch.addTags ?? []), ...a.add]),
              ];
              patch.removeTags = [
                ...new Set([...(patch.removeTags ?? []), ...a.remove]),
              ];
            }
            if (a.type === "route") {
              patch.teamId = a.teamId;
              patch.requeue = a.requeue;
              if (a.requeue) patch.mode = "human";
              patch.reason = `Automation: ${d.name}`;
            }
            if (a.type === "resolve") patch.status = "resolved";
          }
          // Reserve customer contact before any action; another rule/legacy reminder wins atomically.
          if (d.actions.some((a) => a.type === "reply")) {
            const source =
              e.source_snapshot.waitSource ??
              e.source_snapshot.latestId ??
              `created:${c.id}`;
            const legacySent = await this.db.one(
              "SELECT 1 FROM messages m JOIN sla_waits w ON w.id=m.sla_wait_id WHERE m.workspace_id=$1 AND m.conversation_id=$2 AND w.source_message_id=$3 AND m.sla_wait_generation=$4",
              [ws, c.id, source, e.legacy_generation ?? 1],
              q,
            );
            if (legacySent) {
              await this.finish(
                q,
                e,
                "suppressed",
                "A reminder already used this source message",
              );
              return;
            }
            const claim = await this.db.one(
              "INSERT INTO ticket_automation_followups(workspace_id,conversation_id,source_message_id,generation,execution_id,message_id) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING RETURNING message_id",
              [ws, c.id, source, e.legacy_generation ?? 1, e.id, uid()],
              q,
            );
            if (!claim) {
              await this.finish(
                q,
                e,
                "suppressed",
                "Another rule already followed up on this source message",
              );
              return;
            }
          }
          if (Object.keys(patch).length) {
            await this.hooks.applyTicketChanges(q, p!, c, patch, meta);
            c = requireValue(await this.ticket(ws, c.id, q));
          }
          for (const [index, a] of d.actions.entries()) {
            let result: Row = { applied: true };
            if (a.type === "reply" || a.type === "note") {
              const claim =
                a.type === "reply"
                  ? await this.db.one(
                      "SELECT message_id FROM ticket_automation_followups WHERE workspace_id=$1 AND execution_id=$2",
                      [ws, e.id],
                      q,
                    )
                  : null;
              const messageId = claim?.message_id ?? uid();
              await q.query(
                "INSERT INTO messages(id,workspace_id,conversation_id,role,body,request_key,author_id,delivered_at,automation_execution_id,sla_wait_id,sla_wait_generation,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)",
                [
                  messageId,
                  ws,
                  c.id,
                  a.type === "reply" ? "reminder" : "note",
                  a.body,
                  `automation:${e.id}:${index}`,
                  p!.userId,
                  a.type === "reply" ? this.clock() : null,
                  e.id,
                  e.legacy_wait_id,
                  e.legacy_generation,
                  this.clock(),
                ],
              );
              if (a.type === "reply")
                await queueTicketEmail(this.db, q, ws, messageId);
              await this.db.event(
                q,
                ws,
                "message.created",
                { ...meta, messageId },
                c.id,
                a.type === "reply",
              );
              result = {
                messageId,
                semantics:
                  a.type === "reply"
                    ? "Published to native ticket; email acceptance is tracked separately"
                    : "Private internal note",
              };
            } else if (a.type === "notify") {
              const recipients =
                a.recipient === "assignee"
                  ? [c.assigned_to].filter(Boolean)
                  : a.userIds;
              const accepted = [];
              for (const recipient of [...new Set<string>(recipients)]) {
                let rp: Principal;
                try {
                  rp = await resolveStaffPrincipal(this.db, ws, recipient, q);
                } catch {
                  continue;
                }
                if (!canReadConversation(rp, c)) continue;
                const n = await this.db.one(
                  "INSERT INTO ticket_automation_notifications(id,workspace_id,execution_id,action_index,recipient_id,body,email_status) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING RETURNING id",
                  [
                    uid(),
                    ws,
                    e.id,
                    index,
                    recipient,
                    a.body,
                    a.email ? "queued" : "disabled",
                  ],
                  q,
                );
                if (n && a.email)
                  await this.db.enqueue(q, "ticket-automation-notify", {
                    workspaceId: ws,
                    notificationId: n.id,
                  });
                accepted.push(recipient);
              }
              result = { recipients: accepted };
            }
            await q.query(
              "INSERT INTO ticket_automation_results(workspace_id,execution_id,action_index,kind,result) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING",
              [ws, e.id, index, a.type, result],
            );
          }
          await q.query(
            "UPDATE ticket_automation_executions SET source_snapshot=source_snapshot||$3::jsonb WHERE workspace_id=$1 AND id=$2",
            [
              ws,
              e.id,
              JSON.stringify({
                deliveryRevision: c.revision,
                deliveryValues: (await this.snapshot(c, q)).values,
              }),
            ],
          );
          // An earlier ordered rule may update properties; carry that revision only to rules from the identical observed event.
          if (e.source_event_id && c.revision !== e.source_snapshot.revision)
            await q.query(
              "UPDATE ticket_automation_executions SET source_snapshot=jsonb_set(source_snapshot,'{revision}',$4::jsonb) WHERE workspace_id=$1 AND conversation_id=$2 AND source_event_id=$3 AND status='pending' AND (source_snapshot->>'revision')::int=$5",
              [
                ws,
                c.id,
                e.source_event_id,
                JSON.stringify(c.revision),
                e.source_snapshot.revision,
              ],
            );
          await this.finish(q, e, "completed", null);
          if (e.legacy_wait_id) {
            const w = requireValue(
              await this.db.one(
                "SELECT * FROM sla_waits WHERE workspace_id=$1 AND id=$2 FOR UPDATE",
                [ws, e.legacy_wait_id],
                q,
              ),
            );
            const count = e.legacy_generation,
              complete = count >= w.policy.followup.maxReminders;
            const dueAt = businessDeadline(
              this.clock(),
              w.policy.followup.afterMinutes,
              w.policy.calendar,
            );
            await q.query(
              "UPDATE sla_waits SET sent_count=$3,status=$4,due_at=$5 WHERE workspace_id=$1 AND id=$2",
              [ws, w.id, count, complete ? "complete" : "waiting", dueAt],
            );
            if (!complete) await this.adoptLegacy(q, c, w.id);
          }
        } finally {
          this.executing.delete(q);
        }
      });
    } catch (error) {
      // Transaction rollback leaves no partial ticket change, message, or outbox effect.
      if (!(error instanceof HttpError || error instanceof z.ZodError))
        throw error;
      await this.db.tx(async (q) => {
        await this.routing.lockWorkspace(q, ws);
        const hint = await this.db.one(
          "SELECT conversation_id FROM ticket_automation_executions WHERE workspace_id=$1 AND id=$2",
          [ws, id],
          q,
        );
        if (!hint) return;
        await q.query(
          "SELECT id FROM conversations WHERE workspace_id=$1 AND id=$2 FOR UPDATE",
          [ws, hint.conversation_id],
        );
        const e = await this.db.one(
          "SELECT * FROM ticket_automation_executions WHERE workspace_id=$1 AND id=$2 AND status='pending' FOR UPDATE",
          [ws, id],
          q,
        );
        if (e) await this.finish(q, e, "failed", (error as Error).message);
      });
    }
  }
  private async finish(
    q: PoolClient,
    e: Row,
    status: string,
    reason: string | null,
  ) {
    await q.query(
      "UPDATE ticket_automation_executions SET status=$3,reason=$4,finished_at=$5 WHERE workspace_id=$1 AND id=$2",
      [e.workspace_id, e.id, status, reason, this.clock()],
    );
    if (e.legacy_wait_id && status !== "completed")
      await q.query(
        "UPDATE sla_waits SET status='canceled',reason=$3 WHERE workspace_id=$1 AND id=$2 AND status='waiting'",
        [e.workspace_id, e.legacy_wait_id, reason],
      );
    await this.db.event(
      q,
      e.workspace_id,
      `automation.${status}`,
      {
        origin: "automation",
        actorType: "automation",
        ruleId: e.rule_id,
        executionId: e.id,
        reason,
      },
      e.conversation_id,
    );
  }
  async emailGuard(q: Queryable, ws: string, messageId: string) {
    const e = await this.db.one(
      "SELECT e.* FROM messages m JOIN ticket_automation_executions e ON e.workspace_id=m.workspace_id AND e.id=m.automation_execution_id WHERE m.workspace_id=$1 AND m.id=$2",
      [ws, messageId],
      q,
    );
    if (!e) return true;
    if (e.status !== "completed") return false;
    const c = await this.ticket(ws, e.conversation_id, q);
    if (!c || (await this.guard(q, c, e, true))) return false;
    try {
      const p = await this.authority(
        await resolveStaffPrincipal(this.db, ws, e.configured_by, q),
        q,
      );
      await this.validate(p, AutomationDefinition.parse(e.definition), q);
    } catch {
      return false;
    }
    return true;
  }
  async sweep() {
    await this.migrateLegacy();
    const rows = await this.db.rows(
      "SELECT workspace_id,id FROM ticket_automation_executions WHERE status='pending' AND due_at<=$1 ORDER BY due_at,id LIMIT 200",
      [this.clock()],
    );
    for (const e of rows) await this.run(e.workspace_id, e.id);
    await this.db.pool.query(
      "UPDATE ticket_automation_notifications SET email_status='uncertain',error='Worker interrupted during email send; inspect provider records before retrying' WHERE email_status='sending' AND email_attempted_at<$1",
      [new Date(this.clock().getTime() - 300000)],
    );
  }
  async migrateLegacy() {
    const rows = await this.db.rows(
      "SELECT workspace_id,conversation_id,id FROM sla_waits WHERE status='waiting' AND allowed AND NOT automation_managed ORDER BY due_at,id",
    );
    for (const row of rows)
      await this.db.tx(async (q) => {
        await this.routing.lockWorkspace(q, row.workspace_id);
        await q.query(
          "SELECT id FROM conversations WHERE workspace_id=$1 AND id=$2 FOR UPDATE",
          [row.workspace_id, row.conversation_id],
        );
        const c = await this.ticket(row.workspace_id, row.conversation_id, q);
        if (c) await this.adoptLegacy(q, c, row.id);
      });
  }
  private async adoptLegacy(q: PoolClient, c: Row, waitId: string) {
    const w = await this.db.one(
      "SELECT * FROM sla_waits WHERE workspace_id=$1 AND id=$2 AND status='waiting' AND allowed FOR UPDATE",
      [c.workspace_id, waitId],
      q,
    );
    if (!w) return;
    const policy = await this.db.one(
      "SELECT revision,policy,updated_by FROM sla_policies WHERE workspace_id=$1",
      [c.workspace_id],
      q,
    );
    if (
      !policy?.policy.enabled ||
      !policy.policy.followup.enabled ||
      policy.revision !== w.policy_revision
    )
      return;
    const definition = AutomationDefinition.parse({
      name: "Migrated SLA follow-up",
      description:
        "Managed by the existing SLA policy. Waiting deadlines and reminder counts are preserved.",
      trigger: {
        type: "inactivity",
        anchor: "waiting",
        minutes: w.policy.followup.afterMinutes,
        clock: "business",
        calendar: w.policy.calendar,
      },
      actions: [{ type: "reply", body: w.policy.followup.template }],
    });
    let rule = await this.db.one(
      "SELECT * FROM ticket_automation_rules WHERE workspace_id=$1 AND legacy_sla FOR UPDATE",
      [c.workspace_id],
      q,
    );
    if (!rule) {
      rule = await this.db.one(
        "INSERT INTO ticket_automation_rules(workspace_id,id,revision,active_revision,enabled,position,definition,configured_by,legacy_sla) VALUES($1,$2,1,1,true,0,$3,$4,true) ON CONFLICT (workspace_id) WHERE legacy_sla DO NOTHING RETURNING *",
        [c.workspace_id, uid(), definition, policy.updated_by],
        q,
      );
      if (rule)
        await q.query(
          "INSERT INTO ticket_automation_versions(workspace_id,rule_id,revision,definition,configured_by) VALUES($1,$2,1,$3,$4)",
          [c.workspace_id, rule.id, definition, policy.updated_by],
        );
      else
        rule = await this.db.one(
          "SELECT * FROM ticket_automation_rules WHERE workspace_id=$1 AND legacy_sla FOR UPDATE",
          [c.workspace_id],
          q,
        );
    } else if (
      !same(rule.definition, definition) ||
      rule.configured_by !== policy.updated_by
    ) {
      const revision = rule.revision + 1;
      rule = await this.db.one(
        "UPDATE ticket_automation_rules SET revision=$3,active_revision=$3,enabled=true,definition=$4,configured_by=$5,updated_at=now() WHERE workspace_id=$1 AND id=$2 RETURNING *",
        [c.workspace_id, rule.id, revision, definition, policy.updated_by],
        q,
      );
      await q.query(
        "INSERT INTO ticket_automation_versions(workspace_id,rule_id,revision,definition,configured_by) VALUES($1,$2,$3,$4,$5)",
        [c.workspace_id, rule!.id, revision, definition, policy.updated_by],
      );
    }
    const s = await this.snapshot(c, q);
    await this.enqueue(
      q,
      c,
      rule!,
      definition,
      s,
      `legacy:${w.id}:${w.sent_count + 1}`,
      new Date(w.due_at).toISOString(),
      undefined,
      w,
    );
    await q.query(
      "UPDATE sla_waits SET automation_managed=true WHERE workspace_id=$1 AND id=$2",
      [c.workspace_id, w.id],
    );
  }
  async history(p: Principal, id?: string) {
    p = await this.authority(p);
    const visible = await this.definitionVisible(p);
    return {
      executions: (
        await this.db.rows(
          "SELECT e.definition,e.id,e.rule_id,e.rule_revision,e.conversation_id,e.source_key,e.status,e.reason,e.due_at,e.created_at,e.finished_at,c.subject,e.definition->>'name' rule_name,(SELECT coalesce(jsonb_agg(jsonb_build_object('index',a.action_index,'kind',a.kind,'result',a.result) ORDER BY a.action_index),'[]') FROM ticket_automation_results a WHERE a.workspace_id=e.workspace_id AND a.execution_id=e.id) actions FROM ticket_automation_executions e JOIN conversations c ON c.workspace_id=e.workspace_id AND c.id=e.conversation_id JOIN ticket_automation_rules r ON r.workspace_id=e.workspace_id AND r.id=e.rule_id WHERE e.workspace_id=$1 AND ($2::text IS NULL OR e.rule_id=$2) ORDER BY e.created_at DESC,e.id DESC LIMIT 100",
          [p.workspaceId, id ?? null],
        )
      )
        .filter((e) => visible(e.definition))
        .map(({ definition, ...e }) => e),
      versions: id
        ? (
            await this.db.rows(
              "SELECT revision,definition,created_at FROM ticket_automation_versions WHERE workspace_id=$1 AND rule_id=$2 ORDER BY revision DESC LIMIT 30",
              [p.workspaceId, id],
            )
          ).filter((v) => visible(v.definition))
        : [],
    };
  }
  async notifications(p: Principal) {
    p = await refreshPrincipal(this.db, p);
    requireCapability(p, "tickets:read");
    const rows = await this.db.rows(
      "SELECT n.*,e.conversation_id,c.subject,c.assigned_to,c.team_id FROM ticket_automation_notifications n JOIN ticket_automation_executions e ON e.workspace_id=n.workspace_id AND e.id=n.execution_id JOIN conversations c ON c.workspace_id=e.workspace_id AND c.id=e.conversation_id WHERE n.workspace_id=$1 AND n.recipient_id=$2 ORDER BY n.created_at DESC LIMIT 100",
      [p.workspaceId, p.userId],
    );
    return { notifications: rows.filter((n) => canReadConversation(p, n)) };
  }
  async readNotification(p: Principal, id: string) {
    const { notifications } = await this.notifications(p);
    if (!notifications.some((n) => n.id === id))
      throw new HttpError(404, "Notification not found");
    await this.db.pool.query(
      "UPDATE ticket_automation_notifications SET read_at=coalesce(read_at,now()) WHERE workspace_id=$1 AND id=$2 AND recipient_id=$3",
      [p.workspaceId, id, p.userId],
    );
    return { read: true };
  }
  async deliverNotification(ws: string, id: string) {
    const item = await this.db.tx(async (q) => {
      await this.routing.lockWorkspace(q, ws);
      const hint = await this.db.one(
        "SELECT e.conversation_id FROM ticket_automation_notifications n JOIN ticket_automation_executions e ON e.workspace_id=n.workspace_id AND e.id=n.execution_id WHERE n.workspace_id=$1 AND n.id=$2",
        [ws, id],
        q,
      );
      if (!hint) return null;
      await q.query(
        "SELECT id FROM conversations WHERE workspace_id=$1 AND id=$2 FOR UPDATE",
        [ws, hint.conversation_id],
      );
      const n = await this.db.one(
        "SELECT n.*,e.conversation_id FROM ticket_automation_notifications n JOIN ticket_automation_executions e ON e.workspace_id=n.workspace_id AND e.id=n.execution_id WHERE n.workspace_id=$1 AND n.id=$2 FOR UPDATE OF n",
        [ws, id],
        q,
      );
      if (!n || n.email_status !== "queued") return null;
      const e = await this.db.one(
        "SELECT * FROM ticket_automation_executions WHERE workspace_id=$1 AND id=$2",
        [ws, n.execution_id],
        q,
      );
      const c = await this.ticket(ws, n.conversation_id, q);
      let recipient: Principal | undefined;
      try {
        recipient = await resolveStaffPrincipal(this.db, ws, n.recipient_id, q);
      } catch {
        /* revoked */
      }
      const user = recipient
        ? await this.db.one(
            'SELECT email FROM "user" WHERE id=$1',
            [recipient.userId],
            q,
          )
        : null;
      let eligible =
        !!c &&
        !!e &&
        e.status === "completed" &&
        !(await this.guard(q, c, e, true));
      if (eligible)
        try {
          const actor = await this.authority(
            await resolveStaffPrincipal(this.db, ws, e!.configured_by, q),
            q,
          );
          await this.validate(
            actor,
            AutomationDefinition.parse(e!.definition),
            q,
          );
        } catch {
          eligible = false;
        }
      const action = e?.definition.actions[n.action_index];
      if (action?.recipient === "assignee" && c?.assigned_to !== n.recipient_id)
        eligible = false;
      if (
        !eligible ||
        !c ||
        !recipient ||
        !canReadConversation(recipient, c) ||
        !user?.email
      ) {
        await q.query(
          "UPDATE ticket_automation_notifications SET email_status='suppressed',error='Recipient access changed' WHERE id=$1",
          [id],
        );
        return null;
      }
      await q.query(
        "UPDATE ticket_automation_notifications SET email_status='sending',email_attempted_at=$2 WHERE id=$1",
        [id, this.clock()],
      );
      return { ...n, email: user.email };
    });
    if (!item) return;
    try {
      await this.hooks.send(
        item.email,
        "Support automation needs attention",
        `${item.body}\n${this.db.config.FIELDKIT_URL}/?workspace=${encodeURIComponent(ws)}&view=inbox&conversation=${encodeURIComponent(item.conversation_id)}`,
        {
          messageId: `<automation-${id}@${new URL(this.db.config.FIELDKIT_URL).hostname}>`,
        },
      );
      await this.db.pool.query(
        "UPDATE ticket_automation_notifications SET email_status='accepted' WHERE id=$1",
        [id],
      );
    } catch {
      await this.db.pool.query(
        "UPDATE ticket_automation_notifications SET email_status='uncertain',error='SMTP outcome unknown; automatic resend disabled' WHERE id=$1",
        [id],
      );
    }
  }
}
