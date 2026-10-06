import { z } from "zod";
import type { PoolClient } from "pg";
import { Database, uid } from "./db.js";
import type { Principal } from "./auth.js";
import { HttpError, requireValue } from "./config.js";
import {
  CAPABILITIES,
  BUILTIN_CAPABILITIES,
  hasCapability,
  refreshPrincipal,
  requireCapability,
  type Capability,
  type TicketScope,
} from "./permissions.js";
import { requireFreshSession } from "./identity-auth.js";
import type { HumanRouting } from "./human-routing.js";

const RoleInput = z
  .object({
    id: z.string().min(1).max(200).optional(),
    revision: z.number().int().min(1).optional(),
    name: z.string().trim().min(1).max(80),
    description: z.string().trim().max(1000).default(""),
    capabilities: z.array(z.enum(CAPABILITIES)).max(CAPABILITIES.length),
    ticketScope: z.enum(["all", "team", "assigned"]),
  })
  .strict();
const MemberRole = z
  .object({
    role: z.enum(["admin", "agent"]),
    customRoleId: z.string().min(1).max(200).nullable().default(null),
    disabled: z.boolean().default(false),
  })
  .strict();
const scopeRank: Record<TicketScope, number> = { assigned: 0, team: 1, all: 2 };

export class StaffRoles {
  constructor(
    private db: Database,
    private routing: HumanRouting,
  ) {}
  async list(p: Principal) {
    p = await refreshPrincipal(this.db, p);
    if (
      !hasCapability(p, "roles:manage") &&
      !hasCapability(p, "members:manage")
    )
      throw new HttpError(403, "Role or membership administration required");
    return {
      roles: await this.db.rows(
        "SELECT r.*,(SELECT count(*)::int FROM memberships m WHERE m.workspace_id=r.workspace_id AND m.custom_role_id=r.id) member_count FROM staff_roles r WHERE workspace_id=$1 ORDER BY name,id",
        [p.workspaceId],
      ),
      members: await this.db.rows(
        'SELECT m.user_id,m.role,m.custom_role_id,m.disabled,u.name,u.email FROM memberships m LEFT JOIN "user" u ON u.id=m.user_id WHERE m.workspace_id=$1 ORDER BY coalesce(u.name,m.user_id)',
        [p.workspaceId],
      ),
      capabilities: CAPABILITIES,
      builtins: BUILTIN_CAPABILITIES,
      self: p.userId,
      delegable: p.capabilities ?? BUILTIN_CAPABILITIES[p.role] ?? [],
      ticketScope: p.ticketScope ?? "all",
      permissions: {
        roles: hasCapability(p, "roles:manage"),
        members: hasCapability(p, "members:manage"),
      },
    };
  }
  private async authority(q: PoolClient, p: Principal, capability: Capability) {
    await this.routing.lockWorkspace(q, p.workspaceId);
    p = await refreshPrincipal(this.db, p, q);
    requireCapability(p, capability);
    if (!p.sessionId || !p.userId)
      throw new HttpError(
        403,
        "Verify your identity in Security before changing staff permissions",
      );
    requireValue(
      await this.db.one(
        'SELECT id FROM session WHERE id=$1 AND "userId"=$2 AND "expiresAt">now()',
        [p.sessionId, p.userId],
        q,
      ),
      403,
      "Your session is no longer active",
    );
    await requireFreshSession(this.db, p.sessionId, p.userId, q);
    return p;
  }
  private mayDelegate(
    p: Principal,
    capabilities: readonly string[],
    scope: TicketScope,
  ) {
    if (capabilities.some((c) => !hasCapability(p, c)))
      throw new HttpError(403, "You cannot grant capabilities you do not hold");
    if (scopeRank[scope] > scopeRank[p.ticketScope ?? "all"])
      throw new HttpError(
        403,
        "You cannot grant broader ticket visibility than your own",
      );
  }
  private async invalidate(q: PoolClient, ws: string, users: string[]) {
    if (!users.length) return;
    await q.query(
      "UPDATE memberships SET auth_revision=auth_revision+1 WHERE workspace_id=$1 AND user_id=ANY($2::text[])",
      [ws, users],
    );
    await q.query('DELETE FROM session WHERE "userId"=ANY($1::text[])', [
      users,
    ]);
    await q.query(
      "DELETE FROM staff_session_security WHERE user_id=ANY($1::text[])",
      [users],
    );
    await this.routing.wake(q, ws);
  }
  async removeMember(p: Principal, userId: string) {
    return this.db.tx(async (q) => {
      p = await this.authority(q, p, "members:manage");
      if (p.role !== "owner")
        throw new HttpError(
          403,
          "Workspace owner access required to remove staff",
        );
      if (p.userId === userId)
        throw new HttpError(403, "You cannot remove your own membership");
      const member = requireValue(
        await this.db.one(
          "SELECT role,custom_role_id FROM memberships WHERE workspace_id=$1 AND user_id=$2 FOR UPDATE",
          [p.workspaceId, userId],
          q,
        ),
      );
      if (member.role === "owner")
        throw new HttpError(
          403,
          "Owner access cannot be removed through staff management",
        );
      await this.invalidate(q, p.workspaceId, [userId]);
      await q.query(
        "DELETE FROM memberships WHERE workspace_id=$1 AND user_id=$2",
        [p.workspaceId, userId],
      );
      await this.db.event(q, p.workspaceId, "permissions.member_removed", {
        actorId: p.userId,
        userId,
        role: member.role,
        customRoleId: member.custom_role_id,
      });
      return { removed: true };
    });
  }
  async save(p: Principal, raw: unknown) {
    const d = RoleInput.parse(raw);
    return this.db.tx(async (q) => {
      p = await this.authority(q, p, "roles:manage");
      this.mayDelegate(p, d.capabilities, d.ticketScope);
      const id = d.id ?? uid();
      if (d.id) {
        const role = requireValue(
          await this.db.one(
            "SELECT * FROM staff_roles WHERE workspace_id=$1 AND id=$2 FOR UPDATE",
            [p.workspaceId, id],
            q,
          ),
        );
        if (d.revision !== role.revision)
          throw new HttpError(
            409,
            "This role changed. Reload it before saving",
          );
        if (
          await this.db.one(
            "SELECT 1 FROM memberships WHERE workspace_id=$1 AND custom_role_id=$2 AND user_id=$3",
            [p.workspaceId, id, p.userId],
            q,
          )
        )
          throw new HttpError(
            403,
            "You cannot edit a role assigned to yourself",
          );
      }
      const members = await this.db.rows(
        "SELECT user_id FROM memberships WHERE workspace_id=$1 AND custom_role_id=$2 ORDER BY user_id FOR UPDATE",
        [p.workspaceId, id],
        q,
      );
      const result = await this.db.one(
        "INSERT INTO staff_roles(workspace_id,id,name,description,capabilities,ticket_scope,created_by) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(workspace_id,id) DO UPDATE SET name=$3,description=$4,capabilities=$5,ticket_scope=$6,revision=staff_roles.revision+1,updated_at=now() RETURNING *",
        [
          p.workspaceId,
          id,
          d.name,
          d.description,
          JSON.stringify([...new Set(d.capabilities)]),
          d.ticketScope,
          p.userId,
        ],
        q,
      );
      await this.invalidate(
        q,
        p.workspaceId,
        members.map((m) => m.user_id),
      );
      await this.db.event(q, p.workspaceId, "permissions.role_saved", {
        actorId: p.userId,
        roleId: id,
        capabilities: d.capabilities,
        ticketScope: d.ticketScope,
        affectedMembers: members.length,
      });
      return result;
    });
  }
  async remove(p: Principal, id: string) {
    return this.db.tx(async (q) => {
      p = await this.authority(q, p, "roles:manage");
      requireValue(
        await this.db.one(
          "SELECT id FROM staff_roles WHERE workspace_id=$1 AND id=$2 FOR UPDATE",
          [p.workspaceId, id],
          q,
        ),
      );
      if (
        await this.db.one(
          "SELECT 1 FROM memberships WHERE workspace_id=$1 AND custom_role_id=$2",
          [p.workspaceId, id],
          q,
        )
      )
        throw new HttpError(
          409,
          "Assign every member another role before deleting this role",
        );
      await q.query("DELETE FROM staff_roles WHERE workspace_id=$1 AND id=$2", [
        p.workspaceId,
        id,
      ]);
      await this.db.event(q, p.workspaceId, "permissions.role_removed", {
        actorId: p.userId,
        roleId: id,
      });
      return { deleted: true };
    });
  }
  async assignMember(p: Principal, userId: string, raw: unknown) {
    const d = MemberRole.parse(raw);
    return this.db.tx(async (q) => {
      p = await this.authority(q, p, "members:manage");
      if (userId === p.userId)
        throw new HttpError(403, "You cannot change your own role or access");
      const member = requireValue(
        await this.db.one(
          "SELECT * FROM memberships WHERE workspace_id=$1 AND user_id=$2 FOR UPDATE",
          [p.workspaceId, userId],
          q,
        ),
      );
      if (member.role === "owner")
        throw new HttpError(
          403,
          "Owner access cannot be changed through staff roles",
        );
      let capabilities: readonly string[] = BUILTIN_CAPABILITIES[d.role],
        scope: TicketScope = "all";
      if (d.customRoleId) {
        const role = requireValue(
          await this.db.one(
            "SELECT * FROM staff_roles WHERE workspace_id=$1 AND id=$2",
            [p.workspaceId, d.customRoleId],
            q,
          ),
          400,
          "Choose a role in this workspace",
        );
        capabilities = role.capabilities;
        scope = role.ticket_scope;
      }
      this.mayDelegate(p, capabilities, scope);
      await q.query(
        "UPDATE memberships SET role=$3,custom_role_id=$4,disabled=$5 WHERE workspace_id=$1 AND user_id=$2",
        [p.workspaceId, userId, d.role, d.customRoleId, d.disabled],
      );
      await this.invalidate(q, p.workspaceId, [userId]);
      await this.db.event(q, p.workspaceId, "permissions.member_role_changed", {
        actorId: p.userId,
        userId,
        role: d.role,
        customRoleId: d.customRoleId,
        disabled: d.disabled,
      });
      return {
        userId,
        role: d.role,
        customRoleId: d.customRoleId,
        disabled: d.disabled,
      };
    });
  }
}
