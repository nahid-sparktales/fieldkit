import { z } from "zod";
import type { PoolClient } from "pg";
import { Database, uid, type Queryable } from "./db.js";
import {
  type Mailer,
  type Principal,
  requireAdmin,
  requireStaff,
} from "./auth.js";
import { HttpError, requireValue } from "./config.js";
import { digest } from "./security.js";
import {
  SlaPolicy,
  SlaPolicySave,
  SlaWait,
  defaultSlaPolicy,
  type SlaPolicyValue,
} from "./sla-contracts.js";
import { businessDeadline, businessMinutesBetween } from "./sla-calendar.js";
import { queueTicketEmail } from "./ticket-email.js";

type Row = Record<string, any>;
const closed = (status: string) =>
  ["resolved", "closed", "solved"].includes(status);
const events = new Set([
  "conversation.created",
  "message.created",
  "conversation.updated",
  "conversation.synced",
  "response.delivered",
  "assistance.applied",
]);
export class Sla {
  constructor(
    private db: Database,
    private send: Mailer,
    private clock: () => Date = () => new Date(),
  ) {}
  private async access(
    p: Principal,
    admin = false,
    q: Queryable = this.db.pool,
  ) {
    admin ? requireAdmin(p) : requireStaff(p);
    const member = await this.db.one(
      "SELECT role FROM memberships WHERE workspace_id=$1 AND user_id=$2",
      [p.workspaceId, p.userId],
      q,
    );
    if (!member || (admin && !["owner", "admin"].includes(member.role)))
      throw new HttpError(403, "Your staff access changed");
  }
  async settings(p: Principal) {
    await this.access(p);
    const saved = await this.db.one(
      "SELECT revision,policy,enabled_since FROM sla_policies WHERE workspace_id=$1",
      [p.workspaceId],
    );
    return (
      saved ?? { revision: 0, policy: defaultSlaPolicy(), enabled_since: null }
    );
  }
  async save(p: Principal, raw: unknown) {
    const data = SlaPolicySave.parse(raw);
    await this.db.tx(async (q) => {
      await this.access(p, true, q);
      await q.query("SELECT id FROM workspaces WHERE id=$1 FOR UPDATE", [
        p.workspaceId,
      ]);
      const old = await this.db.one(
        "SELECT * FROM sla_policies WHERE workspace_id=$1",
        [p.workspaceId],
        q,
      );
      if ((old?.revision ?? 0) !== data.revision)
        throw new HttpError(409, "SLA policy changed. Reload before saving.");
      for (const rule of data.policy.rules)
        if (
          rule.escalationUserId &&
          !(await this.db.one(
            "SELECT 1 FROM memberships WHERE workspace_id=$1 AND user_id=$2",
            [p.workspaceId, rule.escalationUserId],
            q,
          ))
        )
          throw new HttpError(
            400,
            "Escalation recipient must be a current staff member",
          );
      const revision = data.revision + 1,
        now = this.clock();
      const enabledSince = data.policy.enabled
        ? old?.policy.enabled
          ? old.enabled_since
          : now
        : null;
      await q.query(
        "INSERT INTO sla_policies(workspace_id,revision,policy,enabled_since,updated_by) VALUES($1,$2,$3,$4,$5) ON CONFLICT(workspace_id) DO UPDATE SET revision=$2,policy=$3,enabled_since=$4,updated_by=$5,updated_at=now()",
        [p.workspaceId, revision, data.policy, enabledSince, p.userId],
      );
      await q.query(
        "INSERT INTO sla_policy_versions(workspace_id,revision,policy,created_by) VALUES($1,$2,$3,$4)",
        [p.workspaceId, revision, data.policy, p.userId],
      );
      // Policy edits apply to new obligations. Disabling revokes future automation.
      if (!data.policy.enabled) {
        await q.query(
          "UPDATE sla_waits SET status='canceled',reason='SLA policy disabled' WHERE workspace_id=$1 AND status='waiting'",
          [p.workspaceId],
        );
        await q.query(
          "UPDATE sla_obligations SET state='canceled',ended_at=$2,cause='SLA policy disabled' WHERE workspace_id=$1 AND ended_at IS NULL",
          [p.workspaceId, now],
        );
      }
      await this.db.event(q, p.workspaceId, "sla.policy_saved", {
        revision,
        enabled: data.policy.enabled,
        actor: p.userId,
      });
    });
    return this.settings(p);
  }
  preview(raw: unknown) {
    const input = z
      .object({
        policy: SlaPolicy,
        start: z.iso.datetime({ offset: true }),
        minutes: z.number().int().min(1).max(43200),
      })
      .strict()
      .parse(raw);
    return {
      dueAt: businessDeadline(
        input.start,
        input.minutes,
        input.policy.calendar,
      ),
      timezone: input.policy.calendar.timezone,
      semantics:
        "Elapsed minutes inside business hours; UTC deadline; no proof of inbox receipt",
    };
  }
  // Called by Database.event within its transaction. The outbox contains bounded
  // metadata, never message/file bodies. No enrollment on migration or policy save.
  async observe(q: PoolClient, event: Row) {
    if (!event.conversation_id || !events.has(event.kind)) return;
    const policy = await this.db.one(
      "SELECT * FROM sla_policies WHERE workspace_id=$1 AND (policy->>'enabled')::boolean",
      [event.workspace_id],
      q,
    );
    if (!policy) return;
    const conv = await this.db.one(
      "SELECT c.*,ch.kind channel_kind,ch.published FROM conversations c JOIN channels ch ON ch.id=c.channel_id WHERE c.workspace_id=$1 AND c.id=$2",
      [event.workspace_id, event.conversation_id],
      q,
    );
    if (!conv) return;
    const snapshot = {
      priority: conv.priority,
      mode: conv.mode,
      status: conv.status,
      assignedTo: conv.assigned_to,
      channel: conv.channel_kind,
      policy: policy.policy,
      policyRevision: policy.revision,
      external: !!conv.external_id,
    };
    let observationAdded = false;
    const add = async (
      origin: string,
      kind: string,
      at: Date,
      extra: Row = {},
    ) => {
      if (new Date(at) < new Date(policy.enabled_since)) return;
      const row = await this.db.one(
        "INSERT INTO sla_observations(workspace_id,conversation_id,origin,kind,at,snapshot) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING RETURNING id",
        [
          conv.workspace_id,
          conv.id,
          origin,
          kind,
          at,
          { ...snapshot, ...extra },
        ],
        q,
      );
      if (row) observationAdded = true;
    };
    const data = event.data as Row;
    const messages = await this.db.rows(
      `SELECT m.id,m.role,m.created_at,m.delivered_at
       FROM messages m LEFT JOIN runs r ON r.id=m.run_id AND r.workspace_id=m.workspace_id
       WHERE m.workspace_id=$1 AND m.conversation_id=$2
         AND m.role IN ('customer','staff','assistant') AND m.created_at >= $3
         AND ($4::text IS NULL OR m.id=$4)
         AND (m.role='customer' OR (m.delivered_at IS NOT NULL AND (r.state->>'route') IS DISTINCT FROM 'handoff'))
         AND NOT EXISTS (SELECT 1 FROM sla_observations o WHERE o.workspace_id=m.workspace_id
           AND o.conversation_id=m.conversation_id
           AND o.origin=(CASE WHEN m.role='customer' THEN 'message:' ELSE 'response:' END)||m.id)
       ORDER BY m.created_at,m.id`,
      [
        conv.workspace_id,
        conv.id,
        policy.enabled_since,
        data.messageId ?? null,
      ],
      q,
    );
    // Idempotent message observations also cover agent completion and Zendesk sync.
    for (const m of messages) {
      if (m.role === "customer")
        await add(`message:${m.id}`, "customer", m.created_at, {
          messageId: m.id,
        });
      else if (m.delivered_at) {
        await add(`response:${m.id}`, "response", m.delivered_at, {
          messageId: m.id,
          role: m.role,
        });
      }
    }
    if (
      data.handoffCategory ||
      (data.previousMode === "agent" && data.mode === "human")
    )
      await add(`handoff:${event.id}`, "handoff", event.created_at);
    if (closed(conv.status))
      await add(`close:${event.id}`, "close", event.created_at);
    else if (closed(data.previousStatus ?? ""))
      await add(`reopen:${event.id}`, "reopen", event.created_at);
    if (event.kind === "assistance.applied")
      await add(`priority:${event.id}`, "priority", event.created_at);
    await add(`authority:${event.id}`, "authority", event.created_at, {
      revision: conv.revision,
    });
    if (observationAdded)
      await this.db.enqueue(q, "sla", {
        workspaceId: conv.workspace_id,
        conversationId: conv.id,
      });
  }
  private rule(policy: SlaPolicyValue, snapshot: Row) {
    return policy.rules.find(
      (r) =>
        r.channels.includes(snapshot.channel) &&
        r.priorities.includes(snapshot.priority),
    );
  }
  private async transition(
    q: PoolClient,
    o: Row,
    state: string,
    at: Date,
    cause: string,
    extra: Row = {},
  ) {
    await q.query(
      "UPDATE sla_obligations SET state=$2,cause=$3,ended_at=CASE WHEN $2 IN ('satisfied','canceled') THEN $4 ELSE ended_at END,satisfied_at=CASE WHEN $2='satisfied' THEN $4 ELSE satisfied_at END,breached_at=CASE WHEN $2='breached' OR (state IN ('running','breached') AND due_at<$4) THEN coalesce(breached_at,due_at) ELSE breached_at END WHERE id=$1",
      [o.id, state, cause, at],
    );
    await this.db.event(
      q,
      o.workspace_id,
      "sla.transition",
      {
        obligationId: o.id,
        kind: o.kind,
        state,
        cause,
        policyRevision: o.policy_revision,
        dueAt: o.due_at,
        ...extra,
      },
      o.conversation_id,
    );
  }
  private async create(
    q: PoolClient,
    e: Row,
    kind: string,
    policy: SlaPolicyValue,
    revision: number,
  ) {
    const rule = this.rule(policy, e.snapshot);
    if (!rule) return;
    const minutes =
      kind === "first"
        ? rule.firstMinutes
        : kind === "next"
          ? rule.nextMinutes
          : rule.handoffMinutes;
    const due = businessDeadline(e.at, minutes, policy.calendar),
      warning = businessDeadline(
        e.at,
        Math.max(0, minutes - rule.warningMinutes),
        policy.calendar,
      ),
      escalate = businessDeadline(due, rule.escalateMinutes, policy.calendar),
      id = uid();
    await q.query(
      "INSERT INTO sla_obligations(id,workspace_id,conversation_id,kind,state,origin,policy_revision,policy,rule_id,started_at,due_at,warning_at,escalate_at,cause) VALUES($1,$2,$3,$4,'running',$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT DO NOTHING",
      [
        id,
        e.workspace_id,
        e.conversation_id,
        kind,
        e.origin,
        revision,
        policy,
        rule.id,
        e.at,
        due,
        warning,
        escalate,
        `Observed ${e.kind}`,
      ],
    );
    await this.db.event(
      q,
      e.workspace_id,
      "sla.started",
      {
        obligationId: id,
        kind,
        dueAt: due,
        policyRevision: revision,
        origin: e.origin,
      },
      e.conversation_id,
    );
  }
  async advance(ws: string, id: string) {
    await this.db.tx(async (q) => {
      const conv = await this.db.one(
        "SELECT * FROM conversations WHERE workspace_id=$1 AND id=$2 FOR UPDATE",
        [ws, id],
        q,
      );
      if (!conv) return;
      for (const e of await this.db.rows(
        "SELECT * FROM sla_observations WHERE workspace_id=$1 AND conversation_id=$2 AND processed_at IS NULL ORDER BY id LIMIT 500",
        [ws, id],
        q,
      )) {
        const policy = SlaPolicy.parse(e.snapshot.policy);
        const active = () =>
          this.db.rows(
            "SELECT * FROM sla_obligations WHERE workspace_id=$1 AND conversation_id=$2 AND ended_at IS NULL ORDER BY started_at,id",
            [ws, id],
            q,
          );
        if (e.kind === "customer" || e.kind === "reopen") {
          await q.query(
            "UPDATE sla_waits SET status='canceled',reason='Customer continued the conversation' WHERE workspace_id=$1 AND conversation_id=$2 AND status='waiting'",
            [ws, id],
          );
          const running = await active();
          for (const o of running.filter((o) => o.state === "paused")) {
            await this.resume(q, o, e.at, "Customer reply resumed timer");
          }
          if (!running.some((o) => o.kind !== "handoff")) {
            const previous = await this.db.one(
              "SELECT 1 FROM sla_obligations WHERE workspace_id=$1 AND conversation_id=$2 LIMIT 1",
              [ws, id],
              q,
            );
            await this.create(
              q,
              e,
              previous ? "next" : "first",
              policy,
              e.snapshot.policyRevision,
            );
          }
        } else if (e.kind === "handoff") {
          if (!(await active()).some((o) => o.kind === "handoff"))
            await this.create(
              q,
              e,
              "handoff",
              policy,
              e.snapshot.policyRevision,
            );
          await q.query(
            "UPDATE sla_waits SET status='canceled',reason='Human takeover prohibits automated follow-up' WHERE workspace_id=$1 AND conversation_id=$2 AND status='waiting'",
            [ws, id],
          );
        } else if (e.kind === "response") {
          for (const o of await active()) {
            const rule = o.policy.rules.find((r: Row) => r.id === o.rule_id);
            if (
              new Date(e.at) < new Date(o.started_at) ||
              (e.snapshot.role !== "staff" &&
                (o.kind === "handoff" || rule.replies === "staff_only"))
            )
              continue;
            if (new Date(e.at) > new Date(o.due_at) && !o.breached_at)
              await this.transition(
                q,
                o,
                "breached",
                e.at,
                "Reply arrived after deadline",
              );
            await this.transition(
              q,
              o,
              "satisfied",
              e.at,
              `Delivered ${e.snapshot.role} response`,
              { messageId: e.snapshot.messageId },
            );
          }
        } else if (e.kind === "close") {
          for (const o of await active())
            await this.transition(
              q,
              o,
              "canceled",
              e.at,
              "Conversation closed",
            );
          await q.query(
            "UPDATE sla_waits SET status='canceled',reason='Conversation closed' WHERE workspace_id=$1 AND conversation_id=$2 AND status='waiting'",
            [ws, id],
          );
        } else if (e.kind === "priority") {
          for (const o of await active())
            await this.recalculateRow(
              q,
              o,
              e.snapshot,
              o.policy,
              o.policy_revision,
              "Priority changed; original elapsed time retained",
            );
        }
        await q.query(
          "UPDATE sla_observations SET processed_at=$2 WHERE id=$1",
          [e.id, this.clock()],
        );
      }
    });
    await this.tick(ws, id);
  }
  private async recalculateRow(
    q: PoolClient,
    o: Row,
    snapshot: Row,
    policy: SlaPolicyValue,
    revision: number,
    cause: string,
  ) {
    const rule = this.rule(policy, snapshot);
    if (!rule) return;
    const minutes =
      o.kind === "first"
        ? rule.firstMinutes
        : o.kind === "next"
          ? rule.nextMinutes
          : rule.handoffMinutes;
    const due = businessDeadline(o.started_at, minutes, policy.calendar),
      warning = businessDeadline(
        o.started_at,
        Math.max(0, minutes - rule.warningMinutes),
        policy.calendar,
      ),
      escalate = businessDeadline(due, rule.escalateMinutes, policy.calendar);
    await q.query(
      "UPDATE sla_obligations SET policy=$2,policy_revision=$3,rule_id=$4,due_at=$5,warning_at=$6,escalate_at=$7,generation=generation+1,cause=$8 WHERE id=$1",
      [o.id, policy, revision, rule.id, due, warning, escalate, cause],
    );
    await this.db.event(
      q,
      o.workspace_id,
      "sla.recalculated",
      {
        obligationId: o.id,
        previousDue: o.due_at,
        dueAt: due,
        policyRevision: revision,
        cause,
      },
      o.conversation_id,
    );
  }
  async recalculate(p: Principal, raw: unknown) {
    const input = z
      .object({
        commit: z.boolean().default(false),
        previewHash: z.string().optional(),
      })
      .strict()
      .parse(raw);
    return this.db.tx(async (q) => {
      await this.access(p, true, q);
      await q.query("SELECT id FROM workspaces WHERE id=$1 FOR UPDATE", [
        p.workspaceId,
      ]);
      const settings = requireValue(
        await this.db.one(
          "SELECT * FROM sla_policies WHERE workspace_id=$1",
          [p.workspaceId],
          q,
        ),
      );
      const rows = await this.db.rows(
        "SELECT o.*,c.priority,ch.kind channel FROM sla_obligations o JOIN conversations c ON c.id=o.conversation_id JOIN channels ch ON ch.id=c.channel_id WHERE o.workspace_id=$1 AND o.ended_at IS NULL ORDER BY o.id FOR UPDATE OF o LIMIT 201",
        [p.workspaceId],
        q,
      );
      if (rows.length > 200)
        throw new HttpError(
          409,
          "Recalculation is limited to 200 active obligations per review",
        );
      const changes = rows.map((o) => {
        const r = this.rule(settings.policy, o);
        return {
          id: o.id,
          conversationId: o.conversation_id,
          previousDue: o.due_at,
          dueAt: r
            ? businessDeadline(
                o.started_at,
                o.kind === "first"
                  ? r.firstMinutes
                  : o.kind === "next"
                    ? r.nextMinutes
                    : r.handoffMinutes,
                settings.policy.calendar,
              )
            : o.due_at,
          breached: !!o.breached_at,
        };
      });
      const hash = digest(
        JSON.stringify({
          revision: settings.revision,
          rows: rows.map((o) => [o.id, o.generation, o.state]),
          changes,
        }),
      );
      if (input.commit) {
        if (input.previewHash !== hash)
          throw new HttpError(
            409,
            "Active timers changed. Preview recalculation again.",
          );
        if (!settings.policy.enabled)
          throw new HttpError(409, "Enable SLA policy first");
        for (const o of rows)
          await this.recalculateRow(
            q,
            o,
            o,
            settings.policy,
            settings.revision,
            `Explicitly recalculated by ${p.userId}`,
          );
      }
      return { previewHash: hash, changes, applied: input.commit };
    });
  }
  private async resume(q: PoolClient, o: Row, at: Date, cause: string) {
    const rule = o.policy.rules.find((r: Row) => r.id === o.rule_id),
      remaining = o.remaining_minutes ?? 0;
    const due = businessDeadline(at, remaining, o.policy.calendar);
    const warning = businessDeadline(
      at,
      Math.max(0, remaining - rule.warningMinutes),
      o.policy.calendar,
    );
    const escalate = businessDeadline(
      due,
      rule.escalateMinutes,
      o.policy.calendar,
    );
    await q.query(
      "UPDATE sla_obligations SET state=CASE WHEN breached_at IS NULL THEN 'running' ELSE 'breached' END,due_at=$2,warning_at=$3,escalate_at=$4,generation=generation+1,cause=$5 WHERE id=$1",
      [o.id, due, warning, escalate, cause],
    );
    await this.db.event(
      q,
      o.workspace_id,
      "sla.resumed",
      { obligationId: o.id, dueAt: due, cause },
      o.conversation_id,
    );
  }
  async waiting(p: Principal, id: string, raw: unknown) {
    const input = SlaWait.parse(raw);
    await this.access(p);
    await this.advance(p.workspaceId, id);
    return this.db.tx(async (q) => {
      await this.access(p, false, q);
      const c = requireValue(
        await this.db.one(
          "SELECT c.*,ch.published,ch.kind FROM conversations c JOIN channels ch ON ch.id=c.channel_id WHERE c.workspace_id=$1 AND c.id=$2 FOR UPDATE OF c",
          [p.workspaceId, id],
          q,
        ),
      );
      if (!input.waiting) {
        await q.query(
          "UPDATE sla_waits SET status='canceled',reason='Staff ended waiting cycle' WHERE workspace_id=$1 AND conversation_id=$2 AND status='waiting'",
          [p.workspaceId, id],
        );
        for (const o of await this.db.rows(
          "SELECT * FROM sla_obligations WHERE workspace_id=$1 AND conversation_id=$2 AND state='paused' AND ended_at IS NULL",
          [p.workspaceId, id],
          q,
        )) {
          await this.resume(q, o, this.clock(), "Staff resumed timer");
        }
        await this.db.event(
          q,
          p.workspaceId,
          "sla.wait_ended",
          { actor: p.userId },
          id,
        );
        return { waiting: false };
      }
      const saved = requireValue(
        await this.db.one(
          "SELECT * FROM sla_policies WHERE workspace_id=$1 AND (policy->>'enabled')::boolean",
          [p.workspaceId],
          q,
        ),
        409,
        "Enable an SLA policy first",
      );
      if (closed(c.status) || !c.published || c.external_id)
        throw new HttpError(
          409,
          "Waiting automation requires an open, published native conversation. Zendesk remains authoritative.",
        );
      const source = await this.db.one(
        "SELECT * FROM messages WHERE workspace_id=$1 AND conversation_id=$2 AND role IN ('staff','customer','assistant') ORDER BY created_at DESC,id DESC LIMIT 1",
        [p.workspaceId, id],
        q,
      );
      if (source?.role !== "staff" || !source.delivered_at)
        throw new HttpError(
          409,
          "Send a real staff response before marking this ticket waiting on the customer",
        );
      const now = this.clock(),
        policy = SlaPolicy.parse(saved.policy);
      if (input.allowReminder && !policy.followup.enabled)
        throw new HttpError(
          409,
          "An administrator must review and enable a reminder template first",
        );
      const old = await this.db.one(
        "SELECT * FROM sla_waits WHERE workspace_id=$1 AND conversation_id=$2 AND source_message_id=$3",
        [p.workspaceId, id, source.id],
        q,
      );
      if (old) {
        if (old.status !== "waiting")
          throw new HttpError(
            409,
            "This waiting cycle has ended. Send a new staff response to start another.",
          );
        return old;
      }
      await q.query(
        "UPDATE sla_waits SET status='canceled',reason='New waiting cycle' WHERE workspace_id=$1 AND conversation_id=$2 AND status='waiting'",
        [p.workspaceId, id],
      );
      const wait = await this.db.one(
        "INSERT INTO sla_waits(id,workspace_id,conversation_id,source_message_id,policy_revision,policy,conversation_revision,allowed,actor_id,created_at,due_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *",
        [
          uid(),
          p.workspaceId,
          id,
          source.id,
          saved.revision,
          policy,
          c.revision,
          input.allowReminder,
          p.userId,
          now,
          businessDeadline(now, policy.followup.afterMinutes, policy.calendar),
        ],
        q,
      );
      for (const o of await this.db.rows(
        "SELECT * FROM sla_obligations WHERE workspace_id=$1 AND conversation_id=$2 AND ended_at IS NULL AND state IN ('running','breached')",
        [p.workspaceId, id],
        q,
      )) {
        const remaining = businessMinutesBetween(
          now,
          o.due_at,
          o.policy.calendar,
        );
        await q.query(
          "UPDATE sla_obligations SET remaining_minutes=$2 WHERE id=$1",
          [o.id, remaining],
        );
        await this.transition(
          q,
          o,
          "paused",
          now,
          "Staff marked waiting after delivered response",
        );
      }
      await this.db.event(
        q,
        p.workspaceId,
        "sla.wait_started",
        {
          waitId: wait!.id,
          sourceMessageId: source.id,
          allowReminder: input.allowReminder,
          actor: p.userId,
        },
        id,
      );
      return wait;
    });
  }
  async conversation(p: Principal, id: string) {
    await this.access(p);
    requireValue(
      await this.db.one(
        "SELECT id FROM conversations WHERE workspace_id=$1 AND id=$2",
        [p.workspaceId, id],
      ),
    );
    return {
      obligations: await this.db.rows(
        "SELECT * FROM sla_obligations WHERE workspace_id=$1 AND conversation_id=$2 ORDER BY created_at DESC LIMIT 50",
        [p.workspaceId, id],
      ),
      waiting:
        (await this.db.one(
          "SELECT * FROM sla_waits WHERE workspace_id=$1 AND conversation_id=$2 ORDER BY created_at DESC LIMIT 1",
          [p.workspaceId, id],
        )) ?? null,
    };
  }
  async dashboard(p: Principal) {
    await this.access(p);
    const now = this.clock();
    return {
      now,
      settings: await this.settings(p),
      obligations: await this.db.rows(
        `SELECT o.*,c.subject,c.assigned_to,c.priority,ch.kind channel,ct.name customer_name,ct.email customer_email,CASE WHEN o.breached_at IS NOT NULL OR o.due_at<=$2 THEN 'overdue' WHEN o.warning_at<=$2 THEN 'at_risk' ELSE 'on_track' END urgency FROM sla_obligations o JOIN conversations c ON c.id=o.conversation_id JOIN channels ch ON ch.id=c.channel_id JOIN contacts ct ON ct.id=c.contact_id WHERE o.workspace_id=$1 AND o.ended_at IS NULL ORDER BY CASE WHEN o.state='paused' THEN 1 ELSE 0 END,o.due_at,o.id LIMIT 200`,
        [p.workspaceId, now],
      ),
      notifications: await this.db.rows(
        "SELECT n.*,c.subject FROM sla_notifications n JOIN conversations c ON c.id=n.conversation_id WHERE n.workspace_id=$1 AND n.recipient_id=$2 ORDER BY n.created_at DESC LIMIT 100",
        [p.workspaceId, p.userId],
      ),
    };
  }
  async read(p: Principal, id: string) {
    await this.access(p);
    return requireValue(
      await this.db.one(
        "UPDATE sla_notifications SET read_at=coalesce(read_at,now()) WHERE workspace_id=$1 AND id=$2 AND recipient_id=$3 RETURNING id,read_at",
        [p.workspaceId, id, p.userId],
      ),
    );
  }
  async tick(ws: string, id: string) {
    await this.db.tx(async (q) => {
      const c = await this.db.one(
        "SELECT c.*,ch.published FROM conversations c JOIN channels ch ON ch.id=c.channel_id WHERE c.workspace_id=$1 AND c.id=$2 FOR UPDATE OF c",
        [ws, id],
        q,
      );
      if (!c) return;
      await q.query(
        "UPDATE conversations SET sla_checked_at=$3 WHERE workspace_id=$1 AND id=$2",
        [ws, id, this.clock()],
      );
      const now = this.clock(),
        policy = await this.db.one(
          "SELECT policy FROM sla_policies WHERE workspace_id=$1",
          [ws],
          q,
        );
      const rows = await this.db.rows(
        "SELECT * FROM sla_obligations WHERE workspace_id=$1 AND conversation_id=$2 AND ended_at IS NULL AND state IN ('running','breached','paused')",
        [ws, id],
        q,
      );
      for (const o of rows) {
        if (!c.published || closed(c.status) || !policy?.policy.enabled) {
          await this.transition(
            q,
            o,
            "canceled",
            now,
            "Conversation, channel or policy is no longer eligible",
          );
          continue;
        }
        if (o.state === "paused" || now < new Date(o.warning_at)) continue;
        if (now >= new Date(o.due_at) && !o.breached_at)
          await this.transition(
            q,
            o,
            "breached",
            now,
            "Business response deadline passed",
          );
        const threshold =
            now >= new Date(o.escalate_at)
              ? "escalation"
              : now >= new Date(o.due_at)
                ? "overdue"
                : "warning",
          rule = o.policy.rules.find((r: Row) => r.id === o.rule_id);
        const preferred =
          threshold === "escalation" ? rule.escalationUserId : c.assigned_to;
        const recipients = await this.db.rows(
          "SELECT user_id FROM memberships WHERE workspace_id=$1 AND (user_id=$2 OR ($2::text IS NULL AND role IN ('owner','admin'))) ORDER BY user_id LIMIT 20",
          [ws, preferred ?? null],
          q,
        );
        // One notification per threshold/generation; reassignment changes routing
        // of later thresholds; pending mail also rechecks the current recipient.
        const sent = await this.db.one(
          "SELECT 1 FROM sla_notifications WHERE obligation_id=$1 AND generation=$2 AND threshold=$3",
          [o.id, o.generation, threshold],
          q,
        );
        if (!sent)
          for (const recipient of recipients) {
            const n = await this.db.one(
              "INSERT INTO sla_notifications(id,workspace_id,conversation_id,obligation_id,generation,threshold,recipient_id,email_status) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING RETURNING id",
              [
                uid(),
                ws,
                id,
                o.id,
                o.generation,
                threshold,
                recipient.user_id,
                o.policy.staffEmail ? "queued" : "disabled",
              ],
              q,
            );
            if (n && o.policy.staffEmail)
              await this.db.enqueue(q, "sla-email", {
                workspaceId: ws,
                notificationId: n.id,
              });
          }
      }
      const waits = await this.db.rows(
        "SELECT * FROM sla_waits WHERE workspace_id=$1 AND conversation_id=$2 AND status='waiting'",
        [ws, id],
        q,
      );
      for (const wait of waits) {
        const reason = await this.waitIneligible(q, c, wait);
        if (reason) {
          await q.query(
            "UPDATE sla_waits SET status='canceled',reason=$2 WHERE id=$1",
            [wait.id, reason],
          );
          await this.db.event(
            q,
            ws,
            "sla.followup_suppressed",
            { waitId: wait.id, reason },
            id,
          );
          continue;
        }
        if (!wait.allowed || now < new Date(wait.due_at)) continue;
        const messageId = uid(),
          generation = wait.sent_count + 1;
        await q.query(
          "INSERT INTO messages(id,workspace_id,conversation_id,role,body,request_key,delivered_at,sla_wait_id,sla_wait_generation) VALUES($1,$2,$3,'reminder',$4,$5,$6,$7,$8)",
          [
            messageId,
            ws,
            id,
            wait.policy.followup.template,
            `sla:${wait.id}:${generation}`,
            now,
            wait.id,
            generation,
          ],
        );
        await queueTicketEmail(this.db, q, ws, messageId);
        await q.query(
          "UPDATE sla_waits SET sent_count=$2,due_at=$3,status=$4 WHERE id=$1",
          [
            wait.id,
            generation,
            businessDeadline(
              now,
              wait.policy.followup.afterMinutes,
              wait.policy.calendar,
            ),
            generation >= wait.policy.followup.maxReminders
              ? "complete"
              : "waiting",
          ],
        );
        await this.db.event(
          q,
          ws,
          "message.created",
          { messageId, actorType: "reminder" },
          id,
          true,
        );
        await this.db.event(
          q,
          ws,
          "sla.followup_delivered",
          {
            waitId: wait.id,
            generation,
            messageId,
            semantics:
              "Published to native conversation; email acceptance is tracked separately",
          },
          id,
        );
      }
    });
  }
  private async waitIneligible(q: Queryable, c: Row, w: Row) {
    const saved = await this.db.one(
      "SELECT revision,policy FROM sla_policies WHERE workspace_id=$1",
      [w.workspace_id],
      q,
    );
    if (
      !saved?.policy.enabled ||
      !saved.policy.followup.enabled ||
      saved.revision !== w.policy_revision
    )
      return "Reminder policy changed or disabled";
    if (!c.published || closed(c.status) || c.external_id)
      return "Conversation or channel is no longer eligible";
    if (c.revision !== w.conversation_revision)
      return "Conversation changed after waiting began";
    if (
      !(await this.db.one(
        "SELECT 1 FROM memberships WHERE workspace_id=$1 AND user_id=$2",
        [w.workspace_id, w.actor_id],
        q,
      ))
    )
      return "Initiating staff access revoked";
    const latest = await this.db.one(
      "SELECT id,role,delivered_at FROM messages WHERE workspace_id=$1 AND conversation_id=$2 AND role IN ('customer','staff','assistant') ORDER BY created_at DESC,id DESC LIMIT 1",
      [w.workspace_id, w.conversation_id],
      q,
    );
    if (
      latest?.id !== w.source_message_id ||
      latest.role !== "staff" ||
      !latest.delivered_at
    )
      return "Customer replied or source response changed";
    return null;
  }
  async emailGuard(q: Queryable, ws: string, messageId: string) {
    const w = await this.db.one(
      "SELECT w.*,c.revision,c.status conversation_status,c.external_id,ch.published FROM messages m JOIN sla_waits w ON w.id=m.sla_wait_id JOIN conversations c ON c.id=w.conversation_id JOIN channels ch ON ch.id=c.channel_id WHERE m.workspace_id=$1 AND m.id=$2",
      [ws, messageId],
      q,
    );
    if (!w) return true;
    if (!["waiting", "complete"].includes(w.status)) return false;
    return !(await this.waitIneligible(
      q,
      { ...w, status: w.conversation_status },
      w,
    ));
  }
  async deliverStaffEmail(ws: string, id: string) {
    const item = await this.db.tx(async (q) => {
      const n = await this.db.one(
        "SELECT * FROM sla_notifications WHERE workspace_id=$1 AND id=$2 FOR UPDATE",
        [ws, id],
        q,
      );
      if (!n) return null;
      if (
        n.email_status === "sending" &&
        new Date(n.email_attempted_at).getTime() <
          this.clock().getTime() - 300000
      ) {
        await q.query(
          "UPDATE sla_notifications SET email_status='uncertain',error='Worker interrupted during SMTP send. Check provider records before any manual retry.' WHERE id=$1",
          [id],
        );
        return null;
      }
      if (n.email_status !== "queued") return null;
      const row = await this.db.one(
        `SELECT u.email,c.subject,w.name,c.assigned_to,o.policy,o.rule_id,m.role FROM sla_obligations o JOIN conversations c ON c.id=o.conversation_id JOIN workspaces w ON w.id=c.workspace_id JOIN channels ch ON ch.id=c.channel_id JOIN memberships m ON m.workspace_id=o.workspace_id AND m.user_id=$2 JOIN "user" u ON u.id=m.user_id JOIN sla_policies p ON p.workspace_id=o.workspace_id WHERE o.id=$1 AND o.ended_at IS NULL AND o.state!='paused' AND o.generation=$3 AND c.status NOT IN ('resolved','closed','solved') AND ch.published AND (p.policy->>'enabled')::boolean AND (p.policy->>'staffEmail')::boolean`,
        [n.obligation_id, n.recipient_id, n.generation],
        q,
      );
      const recipient =
        row &&
        (n.threshold === "escalation"
          ? row.policy.rules.find((r: Row) => r.id === row.rule_id)
              ?.escalationUserId
          : row.assigned_to);
      if (
        !row?.email ||
        (recipient
          ? recipient !== n.recipient_id
          : !["owner", "admin"].includes(row.role))
      ) {
        await q.query(
          "UPDATE sla_notifications SET email_status='suppressed',error='Recipient, timer or policy changed' WHERE id=$1",
          [id],
        );
        return null;
      }
      await q.query(
        "UPDATE sla_notifications SET email_status='sending',email_attempted_at=$2 WHERE id=$1",
        [id, this.clock()],
      );
      return { ...row, ...n };
    });
    if (!item) return;
    try {
      await this.send(
        item.email,
        `Support ${item.threshold}: ${item.subject.replace(/[\r\n]/g, " ").slice(0, 150)}`,
        `A support response needs attention in ${item.name}.\n${this.db.config.FIELDKIT_URL}/?workspace=${encodeURIComponent(ws)}&view=inbox&conversation=${encodeURIComponent(item.conversation_id)}`,
        {
          messageId: `<sla-${id}@${new URL(this.db.config.FIELDKIT_URL).hostname}>`,
        },
      );
      await this.db.pool.query(
        "UPDATE sla_notifications SET email_status='accepted',email_accepted_at=$2 WHERE id=$1",
        [id, this.clock()],
      );
    } catch {
      await this.db.pool.query(
        "UPDATE sla_notifications SET email_status='uncertain',error='SMTP outcome unknown. Inspect mail-provider records; automatic resend is disabled.' WHERE id=$1",
        [id],
      );
    }
  }
  async reconcile() {
    const rows = await this.db.rows(
      `SELECT pending.workspace_id,pending.conversation_id FROM (SELECT workspace_id,conversation_id,min(at) due FROM sla_observations WHERE processed_at IS NULL GROUP BY workspace_id,conversation_id UNION ALL SELECT workspace_id,conversation_id,min(due_at) FROM sla_obligations WHERE ended_at IS NULL GROUP BY workspace_id,conversation_id UNION ALL SELECT workspace_id,conversation_id,min(due_at) FROM sla_waits WHERE status='waiting' GROUP BY workspace_id,conversation_id) pending JOIN conversations c ON c.workspace_id=pending.workspace_id AND c.id=pending.conversation_id GROUP BY pending.workspace_id,pending.conversation_id,c.sla_checked_at ORDER BY c.sla_checked_at NULLS FIRST,min(due) LIMIT 200`,
    );
    for (const row of rows)
      await this.advance(row.workspace_id, row.conversation_id);
    await this.db.pool.query(
      "UPDATE sla_notifications SET email_status='uncertain',error='Worker interrupted; check SMTP provider before retrying' WHERE email_status='sending' AND email_attempted_at < $1",
      [new Date(this.clock().getTime() - 300000)],
    );
  }
}
