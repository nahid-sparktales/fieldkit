import { z } from "zod";
import type { PoolClient } from "pg";
import { Database, uid, type Queryable } from "./db.js";
import { conversation, requireStaff, type Principal } from "./auth.js";
import { HttpError, requireValue } from "./config.js";
import { refreshPrincipal, requireCapability } from "./permissions.js";
import { HumanRouting } from "./human-routing.js";
import { tokenHash } from "./security.js";

const id = z.string().min(1).max(200);
const tags = z.array(z.string().trim().min(1).max(80)).max(50);
export const TicketPatch = z
  .object({
    mode: z.enum(["agent", "human"]).optional(),
    status: z.enum(["open", "resolved"]).optional(),
    priority: z.enum(["low", "normal", "high", "urgent"]).optional(),
    tags: tags.optional(),
    addTags: tags.optional(),
    removeTags: tags.optional(),
    teamId: id.nullable().optional(),
    assignedTo: id.nullable().optional(),
    requeue: z.boolean().optional(),
    reason: z.string().max(500).optional(),
    overrideCapacity: z.boolean().optional(),
  })
  .strict();
export type TicketPatchInput = z.infer<typeof TicketPatch>;
export type MutationMeta = {
  actorType?: "staff" | "automation";
  origin?: "automation";
  ruleId?: string;
  executionId?: string;
};
const BulkAction = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("assign"), assignedTo: id.nullable() }).strict(),
  z.object({ kind: z.literal("team"), teamId: id.nullable() }).strict(),
  z
    .object({
      kind: z.literal("priority"),
      priority: z.enum(["low", "normal", "high", "urgent"]),
    })
    .strict(),
  z
    .object({
      kind: z.literal("tags"),
      add: tags.default([]),
      remove: tags.default([]),
    })
    .strict(),
  z
    .object({ kind: z.literal("status"), status: z.enum(["open", "resolved"]) })
    .strict(),
]);
const BatchInput = z
  .object({
    requestKey: z.string().min(8).max(120),
    action: BulkAction,
    tickets: z
      .array(
        z
          .object({ id, expectedEditVersion: z.number().int().positive() })
          .strict(),
      )
      .min(1)
      .max(40),
  })
  .strict();
const MergeInput = z
  .object({
    targetId: id,
    sourceVersion: z.number().int().positive(),
    targetVersion: z.number().int().positive(),
    requestKey: z.string().min(8).max(120),
  })
  .strict();
export class TicketOperations {
  constructor(
    private db: Database,
    private routing: HumanRouting,
    private now: () => Date = () => new Date(),
  ) {}
  async locked(q: PoolClient, p: Principal, id: string) {
    await this.routing.lockWorkspace(q, p.workspaceId);
    p = await refreshPrincipal(this.db, p, q);
    const visible = await conversation(this.db, p, id, q);
    if (visible.id !== id)
      throw new HttpError(
        409,
        "This ticket was merged. Open its current conversation.",
      );
    return requireValue(
      await this.db.one(
        "SELECT * FROM conversations WHERE workspace_id=$1 AND id=$2 FOR UPDATE",
        [p.workspaceId, id],
        q,
      ),
    );
  }
  /** Caller holds the routing workspace lock followed by the ticket row lock. */
  async apply(
    q: PoolClient,
    p: Principal,
    conv: any,
    raw: TicketPatchInput,
    meta: MutationMeta = {},
  ) {
    p = await refreshPrincipal(this.db, p, q);
    requireStaff(p);
    requireCapability(p, "tickets:update");
    await conversation(this.db, p, conv.id, q);
    if (conv.merged_into_id) throw new HttpError(409, "This ticket was merged");
    const d = TicketPatch.parse(raw),
      previous = { ...conv };
    if (d.assignedTo !== undefined || d.teamId !== undefined)
      conv = await this.routing.applyManual(
        q,
        p,
        { ...conv, status: d.status ?? conv.status, mode: d.mode ?? conv.mode },
        {
          assignedTo: d.assignedTo,
          teamId: d.teamId,
          overrideCapacity: d.overrideCapacity,
          reason: d.reason,
        },
        meta,
      );
    if (d.assignedTo === undefined && d.teamId === undefined)
      await this.routing.validateConsumption(q, previous, {
        ...conv,
        status: d.status ?? conv.status,
        mode: d.mode ?? conv.mode,
      });
    const nextTags = [
      ...new Set([...(d.tags ?? conv.tags ?? []), ...(d.addTags ?? [])]),
    ].filter((t) => !d.removeTags?.includes(t));
    if (nextTags.length > 50)
      throw new HttpError(400, "A ticket can have at most 50 tags");
    const result = requireValue(
      await this.db.one(
        "UPDATE conversations SET mode=$3,status=$4,priority=$5,tags=$6,revision=revision+1,updated_at=$7 WHERE workspace_id=$1 AND id=$2 RETURNING *",
        [
          p.workspaceId,
          conv.id,
          d.mode ?? conv.mode,
          d.status ?? conv.status,
          d.priority ?? conv.priority,
          nextTags,
          this.now(),
        ],
        q,
      ),
    );
    await q.query(
      "UPDATE approvals SET status='stale' WHERE run_id IN (SELECT id FROM runs WHERE conversation_id=$1) AND status='pending'",
      [conv.id],
    );
    if (d.requeue) await this.routing.requeueInTransaction(q, p, result, meta);
    await this.db.event(
      q,
      p.workspaceId,
      "conversation.updated",
      {
        ...meta,
        actorType: meta.actorType ?? "staff",
        actor: p.userId,
        previousStatus: previous.status,
        previousMode: previous.mode,
        status: result.status,
        mode: result.mode,
        priority: result.priority,
        teamId: result.team_id,
        assignedTo: result.assigned_to,
        ...(d.mode === "human" && meta.actorType !== "automation"
          ? { handoffCategory: "staff_takeover" }
          : {}),
      },
      conv.id,
      true,
    );
    return d.requeue
      ? requireValue(
          await this.db.one(
            "SELECT * FROM conversations WHERE workspace_id=$1 AND id=$2",
            [p.workspaceId, conv.id],
            q,
          ),
        )
      : result;
  }
  async native(q: Queryable, p: Principal, conv: any) {
    const channel = await this.db.one(
      "SELECT kind FROM channels WHERE workspace_id=$1 AND id=$2",
      [p.workspaceId, conv.channel_id],
      q,
    );
    if (conv.external_id || channel?.kind !== "portal" || conv.merged_into_id)
      throw new HttpError(
        409,
        "Choose an active native email or portal ticket",
      );
  }
  async bulk(p: Principal, raw: unknown) {
    requireStaff(p);
    const d = BatchInput.parse(raw);
    if (new Set(d.tickets.map((t) => t.id)).size !== d.tickets.length)
      throw new HttpError(400, "Select each ticket once");
    p = await refreshPrincipal(this.db, p);
    requireCapability(p, "tickets:update");
    const hash = tokenHash(
      JSON.stringify({
        action: d.action,
        tickets: [...d.tickets].sort((a, b) => a.id.localeCompare(b.id)),
      }),
    );
    const batch = await this.db.tx(async (q) => {
      await q.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        `batch:${p.workspaceId}:${p.userId}:${d.requestKey}`,
      ]);
      const old = await this.db.one(
        "SELECT * FROM ticket_batches WHERE workspace_id=$1 AND actor_id=$2 AND request_key=$3",
        [p.workspaceId, p.userId, d.requestKey],
        q,
      );
      if (old) {
        if (old.payload_hash !== hash)
          throw new HttpError(409, "Request key belongs to a different batch");
        return old;
      }
      const b = requireValue(
        await this.db.one(
          "INSERT INTO ticket_batches(id,workspace_id,actor_id,request_key,payload_hash,action) VALUES($1,$2,$3,$4,$5,$6) RETURNING *",
          [uid(), p.workspaceId, p.userId, d.requestKey, hash, d.action],
          q,
        ),
      );
      for (const t of d.tickets)
        await q.query(
          "INSERT INTO ticket_batch_items(batch_id,conversation_id,expected_version) VALUES($1,$2,$3)",
          [b.id, t.id, t.expectedEditVersion],
        );
      await this.db.enqueue(q, "ticket-batch", {
        workspaceId: p.workspaceId,
        batchId: b.id,
      });
      return b;
    });
    await this.advance(p.workspaceId, batch.id);
    return this.batch(p, batch.id);
  }
  async advance(ws: string, batchId: string) {
    const b = await this.db.one(
      "SELECT * FROM ticket_batches WHERE workspace_id=$1 AND id=$2",
      [ws, batchId],
    );
    if (!b) return;
    const items = await this.db.rows(
      "SELECT * FROM ticket_batch_items WHERE batch_id=$1 AND status='pending' ORDER BY conversation_id",
      [batchId],
    );
    for (const item of items)
      await this.db.tx(async (q) => {
        await this.routing.lockWorkspace(q, ws);
        const current = await this.db.one(
          "SELECT * FROM ticket_batch_items WHERE batch_id=$1 AND conversation_id=$2",
          [batchId, item.conversation_id],
          q,
        );
        if (current?.status !== "pending") return;
        await q.query("SAVEPOINT ticket_change");
        let status = "updated",
          result: unknown = {};
        try {
          const p = await refreshPrincipal(
            this.db,
            { workspaceId: ws, userId: b.actor_id, role: "agent" },
            q,
          );
          const conv = await this.locked(q, p, item.conversation_id);
          await this.native(q, p, conv);
          if (conv.edit_version !== item.expected_version)
            throw new HttpError(
              409,
              "Ticket changed. Refresh and review it before retrying.",
            );
          const a = BulkAction.parse(b.action),
            patch: TicketPatchInput =
              a.kind === "assign"
                ? { assignedTo: a.assignedTo }
                : a.kind === "team"
                  ? { teamId: a.teamId, assignedTo: null }
                  : a.kind === "priority"
                    ? { priority: a.priority }
                    : a.kind === "status"
                      ? { status: a.status }
                      : { addTags: a.add, removeTags: a.remove };
          const changed = await this.apply(q, p, conv, patch);
          result = { editVersion: changed.edit_version };
        } catch (e) {
          await q.query("ROLLBACK TO SAVEPOINT ticket_change");
          const error = e as Error & { status?: number; statusCode?: number };
          const code = error.status ?? error.statusCode;
          status =
            code === 403 || code === 404
              ? "unavailable"
              : /capacity/i.test(error.message)
                ? "capacity_conflict"
                : code === 409
                  ? "conflict"
                  : "failed";
          result = {
            error:
              status === "unavailable" ? "Ticket unavailable" : error.message,
          };
        }
        await q.query(
          "UPDATE ticket_batch_items SET status=$3,result=$4 WHERE batch_id=$1 AND conversation_id=$2",
          [batchId, item.conversation_id, status, result],
        );
      });
  }
  async batch(p: Principal, id: string) {
    requireStaff(p);
    p = await refreshPrincipal(this.db, p);
    requireCapability(p, "tickets:read");
    const b = requireValue(
      await this.db.one(
        "SELECT id,created_at,action FROM ticket_batches WHERE workspace_id=$1 AND id=$2 AND actor_id=$3",
        [p.workspaceId, id, p.userId],
      ),
    );
    const items = await this.db.rows(
      "SELECT conversation_id,status,result FROM ticket_batch_items WHERE batch_id=$1 ORDER BY conversation_id",
      [id],
    );
    for (const i of items)
      try {
        await conversation(this.db, p, i.conversation_id);
      } catch {
        i.status = "unavailable";
        i.result = { error: "Ticket unavailable" };
      }
    return {
      ...b,
      items,
      complete: items.every((i) => i.status !== "pending"),
    };
  }
  async mergeAuthority(p: Principal, q: Queryable = this.db.pool) {
    p = await refreshPrincipal(this.db, p, q);
    requireCapability(p, "tickets:merge");
    requireCapability(p, "tickets:note");
    requireCapability(p, "fields:internal:read");
    if (p.ticketScope && p.ticketScope !== "all")
      throw new HttpError(403, "Merging requires access to all tickets");
    return p;
  }
  async candidates(p: Principal, sourceId: string, query = "") {
    p = await this.mergeAuthority(p);
    const c = await conversation(this.db, p, sourceId);
    return this.db.rows(
      "SELECT id,subject,status,edit_version FROM conversations WHERE workspace_id=$1 AND contact_id=$2 AND channel_id=$3 AND origin=$4 AND support_address_id IS NOT DISTINCT FROM $5 AND id<>$6 AND merged_into_id IS NULL AND external_id IS NULL AND strpos(lower(subject),lower($7))>0 ORDER BY updated_at DESC LIMIT 30",
      [
        p.workspaceId,
        c.contact_id,
        c.channel_id,
        c.origin,
        c.support_address_id,
        c.id,
        query.slice(0, 160),
      ],
    );
  }
  async mergeChecks(p: Principal, source: any, target: any, q: Queryable) {
    await this.native(q, p, source);
    await this.native(q, p, target);
    if (
      source.id === target.id ||
      source.contact_id !== target.contact_id ||
      source.channel_id !== target.channel_id ||
      source.origin !== target.origin ||
      source.support_address_id !== target.support_address_id
    )
      throw new HttpError(
        409,
        "Merge requires the same requester and intake channel/address",
      );
    if (
      source.organization_id !== target.organization_id ||
      source.sharing !== target.sharing
    )
      throw new HttpError(
        409,
        "Organization and sharing must match before merging",
      );
    const members = await this.db.rows(
      "SELECT conversation_id,lower(email) email,portal_contact_id,contact_id FROM ticket_participants WHERE workspace_id=$1 AND conversation_id=ANY($2::text[]) AND active ORDER BY email",
      [p.workspaceId, [source.id, target.id]],
      q,
    );
    const audience = (cid: string) =>
      JSON.stringify(
        members
          .filter((m) => m.conversation_id === cid)
          .map((m) => [m.email, m.portal_contact_id ?? null]),
      );
    if (audience(source.id) !== audience(target.id))
      throw new HttpError(
        409,
        "Both tickets must have the same approved participants before merging",
      );
    const children = await this.db.rows(
      "SELECT merged_into_id FROM conversations WHERE workspace_id=$1 AND merged_into_id=ANY($2::text[])",
      [p.workspaceId, [source.id, target.id]],
      q,
    );
    if (
      children.some((c) => c.merged_into_id === source.id) ||
      children.length >= 10
    )
      throw new HttpError(
        409,
        "Choose an unmerged source and a target with fewer than ten merged tickets",
      );
    if (
      await this.db.one(
        "SELECT 1 FROM ticket_emails WHERE workspace_id=$1 AND conversation_id=ANY($2::text[]) AND status NOT IN ('sent','skipped') LIMIT 1",
        [p.workspaceId, [source.id, target.id]],
        q,
      )
    )
      throw new HttpError(
        409,
        "Finish or reconcile queued, failed, or uncertain email before merging",
      );
    if (
      await this.db.one(
        "SELECT 1 FROM operations o JOIN runs r ON r.id=o.run_id WHERE r.workspace_id=$1 AND r.conversation_id=ANY($2::text[]) AND o.status IN ('prepared','sent','unknown') LIMIT 1",
        [p.workspaceId, [source.id, target.id]],
        q,
      )
    )
      throw new HttpError(409, "Reconcile business operations before merging");
  }
  async preview(p: Principal, sourceId: string, targetId: string) {
    p = await this.mergeAuthority(p);
    const s = await conversation(this.db, p, sourceId),
      t = await conversation(this.db, p, targetId);
    await this.mergeChecks(p, s, t, this.db.pool);
    return {
      source: { id: s.id, subject: s.subject, editVersion: s.edit_version },
      target: {
        id: t.id,
        subject: t.subject,
        editVersion: t.edit_version,
        status: t.status,
        assignedTo: t.assigned_to,
        teamId: t.team_id,
      },
      messageCount: Number(
        (await this.db.one(
          "SELECT count(*) n FROM messages WHERE workspace_id=$1 AND conversation_id=$2",
          [p.workspaceId, s.id],
        ))!.n,
      ),
      notice:
        "The source becomes read-only. Original messages and files stay intact; the target keeps its status, fields and ownership. Both tickets switch to human handling.",
    };
  }
  async merge(p: Principal, sourceId: string, raw: unknown) {
    const d = MergeInput.parse(raw),
      hash = tokenHash(JSON.stringify({ sourceId, ...d }));
    return this.db.tx(async (q) => {
      await this.routing.lockWorkspace(q, p.workspaceId);
      p = await this.mergeAuthority(p, q);
      const old = await this.db.one(
        "SELECT * FROM ticket_merges WHERE workspace_id=$1 AND actor_id=$2 AND request_key=$3",
        [p.workspaceId, p.userId, d.requestKey],
        q,
      );
      if (old) {
        if (old.payload_hash !== hash)
          throw new HttpError(409, "Merge request key was reused");
        await conversation(this.db, p, old.target_id, q);
        return { id: old.target_id, merged: true };
      }
      const rows = await this.db.rows(
        "SELECT * FROM conversations WHERE workspace_id=$1 AND id=ANY($2::text[]) ORDER BY id FOR UPDATE",
        [p.workspaceId, [sourceId, d.targetId]],
        q,
      );
      const s = requireValue(rows.find((r) => r.id === sourceId)),
        t = requireValue(rows.find((r) => r.id === d.targetId));
      await conversation(this.db, p, s.id, q);
      await conversation(this.db, p, t.id, q);
      if (
        s.edit_version !== d.sourceVersion ||
        t.edit_version !== d.targetVersion
      )
        throw new HttpError(
          409,
          "A ticket changed. Review a fresh merge preview.",
        );
      await this.mergeChecks(p, s, t, q);
      if (t.assigned_to && t.mode !== "human" && t.status !== "resolved")
        await this.routing.applyManual(
          q,
          p,
          { ...t, mode: "human" },
          {
            assignedTo: t.assigned_to,
            reason: "Merge into human conversation",
          },
        );
      await q.query(
        "UPDATE conversations SET status='resolved',mode='human',merged_into_id=$3,merged_at=now(),merged_by=$4,revision=revision+1,updated_at=now() WHERE workspace_id=$1 AND id=$2",
        [p.workspaceId, s.id, t.id, p.userId],
      );
      await q.query(
        "UPDATE conversations SET mode='human',revision=revision+1,updated_at=now() WHERE workspace_id=$1 AND id=$2",
        [p.workspaceId, t.id],
      );
      await q.query(
        "UPDATE approvals SET status='stale' WHERE status='pending' AND run_id IN (SELECT id FROM runs WHERE workspace_id=$1 AND conversation_id=ANY($2::text[]))",
        [p.workspaceId, [s.id, t.id]],
      );
      await q.query(
        "UPDATE sla_waits SET status='canceled',reason='merged' WHERE workspace_id=$1 AND conversation_id=$2 AND status='waiting'",
        [p.workspaceId, s.id],
      );
      await q.query(
        "UPDATE sla_obligations SET state='canceled',ended_at=now(),cause='merged' WHERE workspace_id=$1 AND conversation_id=$2 AND ended_at IS NULL",
        [p.workspaceId, s.id],
      );
      await q.query(
        "UPDATE human_queue SET state='cancelled',reason='merged' WHERE workspace_id=$1 AND conversation_id=$2",
        [p.workspaceId, s.id],
      );
      await q.query(
        "INSERT INTO ticket_merges(workspace_id,source_id,target_id,actor_id,request_key,payload_hash) VALUES($1,$2,$3,$4,$5,$6)",
        [p.workspaceId, s.id, t.id, p.userId, d.requestKey, hash],
      );
      await this.db.event(
        q,
        p.workspaceId,
        "conversation.merged",
        { targetId: t.id, actor: p.userId },
        s.id,
        true,
      );
      await this.db.event(
        q,
        p.workspaceId,
        "conversation.history_merged",
        { sourceId: s.id, actor: p.userId },
        t.id,
        true,
      );
      return { id: t.id, merged: true };
    });
  }
  async presence(p: Principal, id: string, raw?: unknown) {
    requireStaff(p);
    p = await refreshPrincipal(this.db, p);
    requireCapability(p, "tickets:read");
    const conv = await conversation(this.db, p, id);
    id = conv.id;
    if (raw !== undefined) {
      const d = z
        .object({
          tabId: z.string().min(8).max(100),
          typing: z.boolean(),
          leave: z.boolean().optional(),
        })
        .strict()
        .parse(raw);
      if (
        !p.sessionId ||
        !(await this.db.one(
          'SELECT 1 FROM session WHERE id=$1 AND "userId"=$2 AND "expiresAt">now()',
          [p.sessionId, p.userId],
        ))
      )
        throw new HttpError(403, "An active staff session is required");
      if (d.leave)
        await this.db.pool.query(
          "DELETE FROM ticket_presence WHERE workspace_id=$1 AND conversation_id=$2 AND session_id=$3 AND tab_id=$4",
          [p.workspaceId, id, p.sessionId, d.tabId],
        );
      else
        await this.db.pool.query(
          "INSERT INTO ticket_presence(workspace_id,conversation_id,user_id,session_id,tab_id,expires_at,typing_until) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(workspace_id,conversation_id,session_id,tab_id) DO UPDATE SET expires_at=EXCLUDED.expires_at,typing_until=EXCLUDED.typing_until",
          [
            p.workspaceId,
            id,
            p.userId,
            p.sessionId,
            d.tabId,
            new Date(+this.now() + 45000),
            new Date(+this.now() + (d.typing ? 8000 : 0)),
          ],
        );
    }
    const rows = await this.db.rows(
      'SELECT p.user_id,u.name,bool_or(p.typing_until>$3) typing FROM ticket_presence p JOIN session s ON s.id=p.session_id AND s."expiresAt">$3 JOIN "user" u ON u.id=p.user_id WHERE p.workspace_id=$1 AND p.conversation_id=$2 AND p.expires_at>$3 AND p.user_id<>$4 GROUP BY p.user_id,u.name',
      [p.workspaceId, id, this.now(), p.userId],
    );
    const visible = [];
    for (const row of rows)
      try {
        await conversation(
          this.db,
          { workspaceId: p.workspaceId, userId: row.user_id, role: "agent" },
          id,
        );
        visible.push(row);
      } catch {
        /* Expired authority is not visible presence. */
      }
    return { people: visible };
  }
  async recover() {
    await this.db.pool.query(
      "DELETE FROM ticket_presence WHERE expires_at<now()",
    );
    for (const b of await this.db.rows(
      "SELECT DISTINCT b.workspace_id,b.id FROM ticket_batches b JOIN ticket_batch_items i ON i.batch_id=b.id WHERE i.status='pending' ORDER BY b.id LIMIT 100",
    ))
      await this.advance(b.workspace_id, b.id);
  }
}
