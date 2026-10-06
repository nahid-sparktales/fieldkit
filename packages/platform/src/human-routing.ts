import type { PoolClient } from "pg";
import { Database, uid, type Queryable } from "./db.js";
import { HttpError, requireValue } from "./config.js";
import { conversation, requireStaff, type Principal } from "./auth.js";
import {
  hasCapability,
  requireCapability,
  refreshPrincipal,
  type Capability,
  resolveStaffPrincipal,
  conversationVisibility,
} from "./permissions.js";
import {
  AgentAvailability,
  AgentCapacity,
  ManualAssignment,
  RoutingSettings,
  TeamInput,
  type ManualAssignmentInput,
} from "./human-routing-contracts.js";

type Row = Record<string, any>;
const consumes = (c: Row) =>
  c.status !== "resolved" && (c.mode === "human" || c.status === "needs_staff");
const capacitySQL =
  "status<>'resolved' AND (mode='human' OR status='needs_staff')";

/** Assignment transactions always lock workspace, then conversation. Event hooks only enqueue. */
export class HumanRouting {
  constructor(
    private db: Database,
    private now: () => Date = () => new Date(),
  ) {}
  async lockWorkspace(q: Queryable, ws: string) {
    await q.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      `human-routing:${ws}`,
    ]);
  }
  async settings(ws: string, q: Queryable = this.db.pool) {
    return (
      (await this.db.one(
        "SELECT * FROM human_routing_settings WHERE workspace_id=$1",
        [ws],
        q,
      )) ?? {
        workspace_id: ws,
        enabled: false,
        default_team_id: null,
        availability_ttl_seconds: 300,
      }
    );
  }
  async wake(q: PoolClient, ws: string) {
    await this.db.enqueue(q, "human-routing", { workspaceId: ws });
  }
  private async authority(
    q: PoolClient,
    p: Principal,
    capability: Capability,
    administration = false,
  ) {
    p = await refreshPrincipal(this.db, p, q);
    requireCapability(p, capability);
    if (administration && p.ticketScope !== "all")
      throw new HttpError(
        403,
        "Team and routing administration requires all-workspace ticket visibility",
      );
    return p;
  }
  async saveSettings(p: Principal, raw: unknown) {
    requireCapability(p, "routing:manage");
    const d = RoutingSettings.parse(raw);
    return this.db.tx(async (q) => {
      await this.lockWorkspace(q, p.workspaceId);
      p = await this.authority(q, p, "routing:manage", true);
      if (d.defaultTeamId) await this.team(p.workspaceId, d.defaultTeamId, q);
      await q.query(
        "INSERT INTO human_routing_settings(workspace_id,enabled,default_team_id,availability_ttl_seconds) VALUES($1,$2,$3,$4) ON CONFLICT(workspace_id) DO UPDATE SET enabled=$2,default_team_id=$3,availability_ttl_seconds=$4",
        [p.workspaceId, d.enabled, d.defaultTeamId, d.availabilityTtlSeconds],
      );
      await this.db.event(q, p.workspaceId, "routing.settings_updated", {
        actorId: p.userId,
        ...d,
      });
      // Enabling never enrolls historical tickets. Existing explicit queue entries may resume.
      await this.wake(q, p.workspaceId);
      return this.settings(p.workspaceId, q);
    });
  }
  private async team(ws: string, id: string, q: Queryable) {
    const team = requireValue(
      await this.db.one(
        "SELECT * FROM teams WHERE workspace_id=$1 AND id=$2",
        [ws, id],
        q,
      ),
      400,
      "Choose a team in this workspace",
    );
    if (!team.active) throw new HttpError(400, "Choose an active team");
    return team;
  }
  async saveTeam(p: Principal, raw: unknown) {
    requireCapability(p, "teams:manage");
    const d = TeamInput.parse(raw),
      id = d.id ?? uid();
    return this.db.tx(async (q) => {
      await this.lockWorkspace(q, p.workspaceId);
      p = await this.authority(q, p, "teams:manage", true);
      const old = d.id
        ? requireValue(
            await this.db.one(
              "SELECT * FROM teams WHERE workspace_id=$1 AND id=$2",
              [p.workspaceId, id],
              q,
            ),
          )
        : null;
      if (
        d.routingEnabled !== (old?.routing_enabled ?? false) ||
        d.overflowTeamId !== (old?.overflow_team_id ?? null) ||
        d.overflowAfterMinutes !== (old?.overflow_after_minutes ?? 30)
      )
        requireCapability(p, "routing:manage");
      if (d.overflowTeamId) {
        await this.team(p.workspaceId, d.overflowTeamId, q);
        const graph = await this.db.rows(
          "SELECT id,overflow_team_id FROM teams WHERE workspace_id=$1",
          [p.workspaceId],
          q,
        );
        const next = new Map(graph.map((t) => [t.id, t.overflow_team_id]));
        next.set(id, d.overflowTeamId);
        const seen = new Set<string>();
        for (
          let cursor: string | null = id;
          cursor;
          cursor = next.get(cursor) ?? null
        ) {
          if (seen.has(cursor))
            throw new HttpError(400, "Overflow teams cannot form a cycle");
          seen.add(cursor);
        }
      }
      for (const userId of new Set(d.memberIds))
        requireValue(
          await this.db.one(
            "SELECT user_id FROM memberships WHERE workspace_id=$1 AND user_id=$2 FOR SHARE",
            [p.workspaceId, userId],
            q,
          ),
          400,
          "Every team member must belong to this workspace",
        );
      await q.query(
        "INSERT INTO teams(workspace_id,id,name,description,active,routing_enabled,overflow_team_id,overflow_after_minutes) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(workspace_id,id) DO UPDATE SET name=$3,description=$4,active=$5,routing_enabled=$6,overflow_team_id=$7,overflow_after_minutes=$8",
        [
          p.workspaceId,
          id,
          d.name,
          d.description,
          d.active,
          d.routingEnabled,
          d.overflowTeamId,
          d.overflowAfterMinutes,
        ],
      );
      await q.query(
        "DELETE FROM team_members WHERE workspace_id=$1 AND team_id=$2 AND NOT(user_id=ANY($3::text[]))",
        [p.workspaceId, id, d.memberIds],
      );
      for (const userId of new Set(d.memberIds)) {
        await q.query(
          "INSERT INTO team_members(workspace_id,team_id,user_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
          [p.workspaceId, id, userId],
        );
        await q.query(
          "INSERT INTO agent_availability(workspace_id,user_id) VALUES($1,$2) ON CONFLICT DO NOTHING",
          [p.workspaceId, userId],
        );
      }
      await this.db.event(q, p.workspaceId, "routing.team_updated", {
        actorId: p.userId,
        teamId: id,
        active: d.active,
        memberIds: d.memberIds,
      });
      await this.wake(q, p.workspaceId);
      return this.db.one(
        "SELECT * FROM teams WHERE workspace_id=$1 AND id=$2",
        [p.workspaceId, id],
        q,
      );
    });
  }
  async availability(p: Principal, raw: unknown) {
    requireCapability(p, "tickets:read");
    const d = AgentAvailability.parse(raw);
    return this.db.tx(async (q) => {
      await this.lockWorkspace(q, p.workspaceId);
      p = await this.authority(q, p, "tickets:read");
      await q.query(
        "INSERT INTO agent_availability(workspace_id,user_id,state,heartbeat_at) VALUES($1,$2,$3,$4) ON CONFLICT(workspace_id,user_id) DO UPDATE SET state=$3,heartbeat_at=$4,updated_at=$4",
        [p.workspaceId, p.userId, d.state, this.now()],
      );
      await this.db.event(q, p.workspaceId, "routing.availability_updated", {
        actorId: p.userId,
        state: d.state,
      });
      await this.wake(q, p.workspaceId);
      return this.db.one(
        "SELECT * FROM agent_availability WHERE workspace_id=$1 AND user_id=$2",
        [p.workspaceId, p.userId],
        q,
      );
    });
  }
  async heartbeat(p: Principal) {
    requireCapability(p, "tickets:read");
    return this.db.tx(async (q) => {
      await this.lockWorkspace(q, p.workspaceId);
      p = await this.authority(q, p, "tickets:read");
      // A heartbeat refreshes connectivity only. It cannot change Away/Offline intent.
      const result = await this.db.one(
        "UPDATE agent_availability SET heartbeat_at=$3 WHERE workspace_id=$1 AND user_id=$2 RETURNING *",
        [p.workspaceId, p.userId, this.now()],
        q,
      );
      if (result?.state === "available") await this.wake(q, p.workspaceId);
      return result ?? { state: "offline" };
    });
  }
  async setCapacity(p: Principal, userId: string, raw: unknown) {
    requireCapability(p, "routing:manage");
    const d = AgentCapacity.parse(raw);
    return this.db.tx(async (q) => {
      await this.lockWorkspace(q, p.workspaceId);
      p = await this.authority(q, p, "routing:manage", true);
      requireValue(
        await this.db.one(
          "SELECT user_id FROM memberships WHERE workspace_id=$1 AND user_id=$2 FOR SHARE",
          [p.workspaceId, userId],
          q,
        ),
        404,
        "Staff member not found",
      );
      await q.query(
        "INSERT INTO agent_availability(workspace_id,user_id,capacity) VALUES($1,$2,$3) ON CONFLICT(workspace_id,user_id) DO UPDATE SET capacity=$3,updated_at=$4",
        [p.workspaceId, userId, d.capacity, this.now()],
      );
      await this.db.event(q, p.workspaceId, "routing.capacity_updated", {
        actorId: p.userId,
        userId,
        capacity: d.capacity,
      });
      await this.wake(q, p.workspaceId);
      return { capacity: d.capacity };
    });
  }
  private async recipient(
    ws: string,
    userId: string,
    teamId: string | null,
    q: Queryable,
  ): Promise<Principal | null> {
    if (
      !(await this.db.one(
        "SELECT user_id FROM memberships WHERE workspace_id=$1 AND user_id=$2 FOR SHARE",
        [ws, userId],
        q,
      ))
    )
      return null;
    let p: Principal;
    try {
      p = await resolveStaffPrincipal(this.db, ws, userId, q);
    } catch {
      return null;
    }
    if (!hasCapability(p, "tickets:read")) return null;
    if (
      teamId &&
      !(await this.db.one(
        "SELECT 1 FROM team_members WHERE workspace_id=$1 AND team_id=$2 AND user_id=$3",
        [ws, teamId, userId],
        q,
      ))
    )
      return null;
    if (p.ticketScope === "team" && (!teamId || !p.teamIds?.includes(teamId)))
      return null;
    return p;
  }
  private async workload(
    ws: string,
    userId: string,
    q: Queryable,
    except?: string,
  ) {
    return (await this.db.one(
      `SELECT count(*)::int count FROM conversations WHERE workspace_id=$1 AND assigned_to=$2 AND ${capacitySQL} AND ($3::text IS NULL OR id<>$3)`,
      [ws, userId, except ?? null],
      q,
    ))!.count as number;
  }
  /** Caller must acquire lockWorkspace BEFORE locking the conversation. Same path for macros. */
  async applyManual(
    q: PoolClient,
    p: Principal,
    conv: Row,
    raw: ManualAssignmentInput,
  ) {
    p = await this.authority(q, p, "tickets:assign");
    await conversation(this.db, p, conv.id, q);
    const d = ManualAssignment.parse(raw),
      teamId = d.teamId === undefined ? conv.team_id : d.teamId;
    const userId = d.assignedTo === undefined ? conv.assigned_to : d.assignedTo;
    if (teamId) await this.team(p.workspaceId, teamId, q);
    if (userId) {
      if (!(await this.recipient(p.workspaceId, userId, teamId, q)))
        throw new HttpError(
          403,
          "Assignee must be an authorized member of the selected team",
        );
      const limit =
        (
          await this.db.one(
            "SELECT capacity FROM agent_availability WHERE workspace_id=$1 AND user_id=$2",
            [p.workspaceId, userId],
            q,
          )
        )?.capacity ?? 5;
      if (
        consumes(conv) &&
        (await this.workload(p.workspaceId, userId, q, conv.id)) >= limit
      ) {
        if (!d.overrideCapacity)
          throw new HttpError(
            409,
            "Agent is at capacity. Choose another agent or explicitly override capacity with a reason.",
          );
        requireCapability(p, "tickets:assign_override");
        if (!d.reason)
          throw new HttpError(400, "A capacity override requires a reason");
      }
    }
    if (d.overrideCapacity) {
      requireCapability(p, "tickets:assign_override");
      if (!d.reason)
        throw new HttpError(400, "A capacity override requires a reason");
    }
    const result = (await this.db.one(
      "UPDATE conversations SET team_id=$3,assigned_to=$4,assignment_source='manual',updated_at=$5 WHERE workspace_id=$1 AND id=$2 RETURNING *",
      [p.workspaceId, conv.id, teamId ?? null, userId ?? null, this.now()],
      q,
    ))!;
    await q.query(
      "UPDATE human_queue SET state='cancelled',reason=$3,selected_user_id=$4,updated_at=$5 WHERE workspace_id=$1 AND conversation_id=$2",
      [
        p.workspaceId,
        conv.id,
        userId ? "manual" : "manual_unassigned",
        userId ?? null,
        this.now(),
      ],
    );
    await this.db.event(
      q,
      p.workspaceId,
      "routing.assigned",
      {
        source: "manual",
        actorId: p.userId,
        teamId: teamId ?? null,
        selectedAgent: userId ?? null,
        overrideCapacity: d.overrideCapacity,
        reason: d.reason || (userId ? "manual" : "manual_unassigned"),
      },
      conv.id,
    );
    await this.wake(q, p.workspaceId);
    return result;
  }
  async assign(p: Principal, id: string, raw: ManualAssignmentInput) {
    return this.db.tx(async (q) => {
      await this.lockWorkspace(q, p.workspaceId);
      p = await this.authority(q, p, "tickets:assign");
      await conversation(this.db, p, id, q);
      const conv = requireValue(
        await this.db.one(
          "SELECT * FROM conversations WHERE workspace_id=$1 AND id=$2 FOR UPDATE",
          [p.workspaceId, id],
          q,
        ),
      );
      const result = await this.applyManual(q, p, conv, raw);
      await q.query(
        "UPDATE conversations SET revision=revision+1 WHERE workspace_id=$1 AND id=$2",
        [p.workspaceId, id],
      );
      return result;
    });
  }
  /** Existing configured handoffs become a queue hint when workforce routing is enabled. */
  async workflowHandoff(q: PoolClient, conv: Row, requestedAgent: string) {
    if (conv.assignment_source === "manual") {
      await this.db.event(
        q,
        conv.workspace_id,
        "routing.workflow_hint",
        { requestedAgent, reason: "manual_ownership_preserved" },
        conv.id,
      );
      return;
    }
    if ((await this.settings(conv.workspace_id, q)).enabled) {
      await this.db.event(
        q,
        conv.workspace_id,
        "routing.workflow_hint",
        { requestedAgent, reason: "team_queue_policy" },
        conv.id,
      );
      return;
    }
    if (
      !(await this.recipient(
        conv.workspace_id,
        requestedAgent,
        conv.team_id,
        q,
      ))
    )
      throw new HttpError(
        409,
        "Workflow assignee is no longer authorized for this ticket",
      );
    await q.query(
      "UPDATE conversations SET assigned_to=$3,assignment_source='automatic' WHERE workspace_id=$1 AND id=$2",
      [conv.workspace_id, conv.id, requestedAgent],
    );
    await this.db.event(
      q,
      conv.workspace_id,
      "routing.assigned",
      {
        source: "workflow",
        selectedAgent: requestedAgent,
        teamId: conv.team_id,
        reason: "configured_workflow_routing_off",
      },
      conv.id,
    );
  }
  async requeue(p: Principal, id: string) {
    requireCapability(p, "tickets:assign");
    return this.db.tx(async (q) => {
      await this.lockWorkspace(q, p.workspaceId);
      p = await this.authority(q, p, "tickets:assign");
      await conversation(this.db, p, id, q);
      const conv = requireValue(
        await this.db.one(
          "SELECT * FROM conversations WHERE workspace_id=$1 AND id=$2 FOR UPDATE",
          [p.workspaceId, id],
          q,
        ),
      );
      if (!consumes(conv))
        throw new HttpError(
          409,
          "Only unresolved tickets needing a person can enter the human queue",
        );
      await q.query(
        "UPDATE conversations SET assigned_to=NULL,assignment_source=NULL,revision=revision+1 WHERE workspace_id=$1 AND id=$2",
        [p.workspaceId, id],
      );
      await q.query(
        "DELETE FROM human_queue WHERE workspace_id=$1 AND conversation_id=$2",
        [p.workspaceId, id],
      );
      await this.enqueue(
        q,
        { ...conv, assigned_to: null, assignment_source: null },
        null,
        true,
      );
      await this.db.event(
        q,
        p.workspaceId,
        "routing.requeued",
        {
          actorId: p.userId,
          previousAgent: conv.assigned_to,
          teamId: conv.team_id,
        },
        id,
      );
      await this.wake(q, p.workspaceId);
      return { queued: true };
    });
  }
  private async enqueue(
    q: PoolClient,
    conv: Row,
    eventId: number | null,
    explicit = false,
  ) {
    const settings = await this.settings(conv.workspace_id, q);
    if (!explicit && !settings.enabled) return;
    const teamId = conv.team_id ?? settings.default_team_id;
    if (!conv.team_id && teamId)
      await q.query(
        "UPDATE conversations SET team_id=$3 WHERE workspace_id=$1 AND id=$2",
        [conv.workspace_id, conv.id, teamId],
      );
    await q.query(
      "INSERT INTO human_queue(workspace_id,conversation_id,team_id,origin_team_id,reason,entered_at,updated_at,last_event_id) VALUES($1,$2,$3,$3,$4,$5,$5,$6) ON CONFLICT(workspace_id,conversation_id) DO UPDATE SET state='queued',team_id=EXCLUDED.team_id,reason=CASE WHEN human_queue.state='queued' THEN human_queue.reason ELSE EXCLUDED.reason END,entered_at=CASE WHEN human_queue.state='queued' THEN human_queue.entered_at ELSE EXCLUDED.entered_at END,updated_at=EXCLUDED.updated_at,last_event_id=EXCLUDED.last_event_id WHERE human_queue.last_event_id IS NULL OR EXCLUDED.last_event_id IS NULL OR human_queue.last_event_id<EXCLUDED.last_event_id",
      [
        conv.workspace_id,
        conv.id,
        teamId,
        settings.enabled ? (teamId ? "ready" : "missing_team") : "disabled",
        this.now(),
        eventId,
      ],
    );
  }
  async onEvent(q: PoolClient, event: Row) {
    if (!event.conversation_id || event.kind.startsWith("routing.")) return;
    if (
      !/^(conversation\.|message\.created|agent\.|support\.|feedback\.)/.test(
        event.kind,
      )
    )
      return;
    const conv = await this.db.one(
      "SELECT * FROM conversations WHERE workspace_id=$1 AND id=$2",
      [event.workspace_id, event.conversation_id],
      q,
    );
    if (!conv) return;
    if (
      consumes(conv) &&
      !conv.assigned_to &&
      conv.assignment_source !== "manual"
    )
      await this.enqueue(q, conv, event.id);
    else
      await q.query(
        "UPDATE human_queue SET state=CASE WHEN $3::text IS NULL THEN 'cancelled' ELSE 'assigned' END,reason=CASE WHEN $3::text IS NULL THEN 'no_longer_eligible' ELSE reason END,updated_at=$4 WHERE workspace_id=$1 AND conversation_id=$2 AND state='queued'",
        [event.workspace_id, conv.id, conv.assigned_to, this.now()],
      );
    if ((await this.settings(event.workspace_id, q)).enabled)
      await this.wake(q, event.workspace_id);
  }
  private async explain(q: PoolClient, ws: string, id: string, reason: string) {
    const changed = await this.db.one(
      "UPDATE human_queue SET reason=$3,updated_at=$4 WHERE workspace_id=$1 AND conversation_id=$2 AND reason IS DISTINCT FROM $3 RETURNING team_id",
      [ws, id, reason, this.now()],
      q,
    );
    if (changed)
      await this.db.event(
        q,
        ws,
        "routing.waiting",
        { reason, teamId: changed.team_id },
        id,
      );
  }
  /** Durable queue is authoritative; workload is counted from tickets, never a drifting counter. */
  async drain(ws: string) {
    return this.db.tx(async (q) => {
      await this.lockWorkspace(q, ws);
      const settings = await this.settings(ws, q),
        now = this.now();
      if (!settings.enabled) return { assigned: 0 };
      // Reopened/manual ownership is retained unless the owner lost membership or ticket authority.
      let cursor = "";
      while (true) {
        const owned = await this.db.rows(
          `SELECT * FROM conversations WHERE workspace_id=$1 AND assigned_to IS NOT NULL AND ${capacitySQL} AND id>$2 ORDER BY id LIMIT 200 FOR UPDATE`,
          [ws, cursor],
          q,
        );
        for (const conv of owned)
          if (!(await this.recipient(ws, conv.assigned_to, conv.team_id, q))) {
            await q.query(
              "UPDATE conversations SET assigned_to=NULL,assignment_source=NULL,revision=revision+1 WHERE workspace_id=$1 AND id=$2",
              [ws, conv.id],
            );
            await this.enqueue(
              q,
              { ...conv, assigned_to: null, assignment_source: null },
              null,
            );
            await this.db.event(
              q,
              ws,
              "routing.owner_removed",
              { previousAgent: conv.assigned_to, reason: "owner_unavailable" },
              conv.id,
            );
          }
        if (owned.length < 200) break;
        cursor = owned.at(-1)!.id;
      }
      // Six-hour aging outranks priority; SLA urgency breaks non-aged priority ties.
      // Scan all queued IDs so unavailable teams cannot hide another team behind a page boundary.
      const pending = await this.db.rows(
        `SELECT h.conversation_id FROM human_queue h JOIN conversations c ON c.workspace_id=h.workspace_id AND c.id=h.conversation_id WHERE h.workspace_id=$1 AND h.state='queued' ORDER BY CASE WHEN h.entered_at<=$2::timestamptz-interval '6 hours' THEN 0 ELSE 1 END,CASE WHEN h.entered_at<=$2::timestamptz-interval '6 hours' THEN h.entered_at END,CASE c.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,coalesce((SELECT min(o.due_at) FROM sla_obligations o WHERE o.workspace_id=c.workspace_id AND o.conversation_id=c.id AND o.ended_at IS NULL AND o.state<>'paused'), 'infinity'::timestamptz),h.entered_at,h.conversation_id`,
        [ws, now],
        q,
      );
      let assigned = 0;
      for (const row of pending) {
        const conv = await this.db.one(
          "SELECT * FROM conversations WHERE workspace_id=$1 AND id=$2 FOR UPDATE",
          [ws, row.conversation_id],
          q,
        );
        const entry = await this.db.one(
          "SELECT * FROM human_queue WHERE workspace_id=$1 AND conversation_id=$2 FOR UPDATE",
          [ws, row.conversation_id],
          q,
        );
        if (!conv || !entry || entry.state !== "queued") continue;
        if (
          !consumes(conv) ||
          conv.assigned_to ||
          conv.assignment_source === "manual"
        ) {
          await q.query(
            "UPDATE human_queue SET state='cancelled',reason='no_longer_eligible',updated_at=$3 WHERE workspace_id=$1 AND conversation_id=$2",
            [ws, conv.id, now],
          );
          continue;
        }
        let team =
          entry.team_id &&
          (await this.db.one(
            "SELECT * FROM teams WHERE workspace_id=$1 AND id=$2",
            [ws, entry.team_id],
            q,
          ));
        if (
          team?.overflow_team_id &&
          !entry.overflowed_at &&
          now.getTime() - Date.parse(entry.entered_at) >=
            team.overflow_after_minutes * 60000
        ) {
          const overflow = await this.db.one(
            "SELECT * FROM teams WHERE workspace_id=$1 AND id=$2 AND active AND routing_enabled",
            [ws, team.overflow_team_id],
            q,
          );
          if (overflow) {
            await q.query(
              "UPDATE human_queue SET team_id=$3,overflowed_at=$4 WHERE workspace_id=$1 AND conversation_id=$2",
              [ws, conv.id, overflow.id, now],
            );
            await q.query(
              "UPDATE conversations SET team_id=$3 WHERE workspace_id=$1 AND id=$2",
              [ws, conv.id, overflow.id],
            );
            await this.db.event(
              q,
              ws,
              "routing.overflowed",
              { fromTeam: team.id, teamId: overflow.id },
              conv.id,
            );
            team = overflow;
          }
        }
        if (!team || !team.active || !team.routing_enabled) {
          await this.explain(
            q,
            ws,
            conv.id,
            !team
              ? "missing_team"
              : !team.active
                ? "inactive_team"
                : "team_disabled",
          );
          continue;
        }
        const members = await this.db.rows(
          "SELECT tm.user_id,a.state,a.heartbeat_at,coalesce(a.capacity,5) capacity FROM team_members tm LEFT JOIN agent_availability a ON a.workspace_id=tm.workspace_id AND a.user_id=tm.user_id WHERE tm.workspace_id=$1 AND tm.team_id=$2 ORDER BY tm.user_id",
          [ws, team.id],
          q,
        );
        const ordered = [
          ...members.filter(
            (m) => m.user_id > (team.last_assigned_user_id ?? ""),
          ),
          ...members.filter(
            (m) => m.user_id <= (team.last_assigned_user_id ?? ""),
          ),
        ];
        let authorized = 0,
          available = 0,
          selected: Row | undefined;
        for (const member of ordered) {
          if (!(await this.recipient(ws, member.user_id, team.id, q))) continue;
          authorized++;
          if (
            member.state !== "available" ||
            !member.heartbeat_at ||
            now.getTime() - Date.parse(member.heartbeat_at) >
              settings.availability_ttl_seconds * 1000
          )
            continue;
          available++;
          if ((await this.workload(ws, member.user_id, q)) >= member.capacity)
            continue;
          selected = member;
          break;
        }
        if (!selected) {
          await this.explain(
            q,
            ws,
            conv.id,
            !members.length
              ? "no_members"
              : !authorized
                ? "no_authorized_members"
                : !available
                  ? "no_available_members"
                  : "at_capacity",
          );
          continue;
        }
        await q.query(
          "UPDATE conversations SET assigned_to=$3,team_id=$4,assignment_source='automatic',revision=revision+1,updated_at=$5 WHERE workspace_id=$1 AND id=$2",
          [ws, conv.id, selected.user_id, team.id, now],
        );
        await q.query(
          "UPDATE teams SET last_assigned_user_id=$3 WHERE workspace_id=$1 AND id=$2",
          [ws, team.id, selected.user_id],
        );
        await q.query(
          "UPDATE human_queue SET state='assigned',reason='assigned',selected_user_id=$3,updated_at=$4 WHERE workspace_id=$1 AND conversation_id=$2",
          [ws, conv.id, selected.user_id, now],
        );
        await this.db.event(
          q,
          ws,
          "routing.assigned",
          {
            source: "automatic",
            teamId: team.id,
            selectedAgent: selected.user_id,
            reason: "round_robin",
            capacity: selected.capacity,
            workload: await this.workload(ws, selected.user_id, q),
          },
          conv.id,
        );
        assigned++;
      }
      return { assigned };
    });
  }
  async sweep() {
    for (const row of await this.db.rows(
      "SELECT workspace_id FROM human_routing_settings WHERE enabled ORDER BY workspace_id",
    ))
      await this.drain(row.workspace_id);
  }
  async snapshot(p: Principal) {
    p = await refreshPrincipal(this.db, p);
    requireStaff(p);
    if (
      !hasCapability(p, "tickets:read") &&
      !hasCapability(p, "teams:manage") &&
      !hasCapability(p, "routing:manage")
    )
      throw new HttpError(403, "Team access required");
    const administer = p.ticketScope === "all";
    const manage =
      administer &&
      (hasCapability(p, "teams:manage") || hasCapability(p, "routing:manage"));
    const teams = await this.db.rows(
      "SELECT t.*,coalesce((SELECT jsonb_agg(user_id ORDER BY user_id) FROM team_members tm WHERE tm.workspace_id=t.workspace_id AND tm.team_id=t.id),'[]') member_ids FROM teams t WHERE workspace_id=$1 ORDER BY name,id",
      [p.workspaceId],
    );
    const members = await this.db.rows(
      `SELECT m.user_id,u.name,u.email,coalesce(a.state,'offline') state,coalesce(a.capacity,5) capacity,a.heartbeat_at,(SELECT count(*)::int FROM conversations c WHERE c.workspace_id=m.workspace_id AND c.assigned_to=m.user_id AND ${capacitySQL}) workload FROM memberships m LEFT JOIN "user" u ON u.id=m.user_id LEFT JOIN agent_availability a ON a.workspace_id=m.workspace_id AND a.user_id=m.user_id WHERE m.workspace_id=$1 ORDER BY coalesce(u.name,m.user_id)`,
      [p.workspaceId],
    );
    const params: unknown[] = [p.workspaceId],
      scope = conversationVisibility(p, "c", params);
    const queue = await this.db.rows(
      `SELECT h.*,c.subject,c.priority,c.status,c.assigned_to,t.name team_name FROM human_queue h JOIN conversations c ON c.workspace_id=h.workspace_id AND c.id=h.conversation_id LEFT JOIN teams t ON t.workspace_id=h.workspace_id AND t.id=h.team_id WHERE h.workspace_id=$1 AND h.state='queued' AND (${scope}) ORDER BY h.entered_at,h.conversation_id LIMIT 200`,
      params,
    );
    const settings = await this.settings(p.workspaceId);
    const assign = hasCapability(p, "tickets:assign");
    return {
      settings,
      teams:
        manage || !p.ticketScope || p.ticketScope === "all"
          ? teams
          : teams.filter((t) => t.member_ids.includes(p.userId)),
      members:
        manage || assign
          ? members
          : members.filter((m) => m.user_id === p.userId),
      queue,
      self: members.find((m) => m.user_id === p.userId),
      now: this.now().toISOString(),
      permissions: {
        teams: administer && hasCapability(p, "teams:manage"),
        routing: administer && hasCapability(p, "routing:manage"),
        assign,
        override: hasCapability(p, "tickets:assign_override"),
      },
    };
  }
  async explanation(p: Principal, id: string) {
    requireCapability(p, "tickets:read");
    await conversation(this.db, p, id);
    return {
      queue: await this.db.one(
        "SELECT * FROM human_queue WHERE workspace_id=$1 AND conversation_id=$2",
        [p.workspaceId, id],
      ),
      history: await this.db.rows(
        "SELECT id,kind,data,created_at FROM events WHERE workspace_id=$1 AND conversation_id=$2 AND kind LIKE 'routing.%' ORDER BY id DESC LIMIT 30",
        [p.workspaceId, id],
      ),
    };
  }
}
