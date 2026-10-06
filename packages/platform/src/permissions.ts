import type { Principal } from "./auth.js";
import type { Database, Queryable } from "./db.js";
import { HttpError } from "./config.js";

export const CAPABILITIES = [
  "tickets:read",
  "tickets:reply",
  "tickets:note",
  "tickets:update",
  "tickets:assign",
  "tickets:assign_override",
  "tickets:delete",
  "customers:read",
  "customers:manage",
  "fields:manage",
  "fields:internal:read",
  "fields:internal:write",
  "macros:personal",
  "macros:shared",
  "views:personal",
  "views:shared",
  "teams:manage",
  "routing:manage",
  "email:manage",
  "email:retry",
  "members:manage",
  "roles:manage",
  "identity:manage",
  "audit:read",
  "knowledge:read",
  "knowledge:manage",
  "workflow:read",
  "workflow:manage",
  "actions:read",
  "actions:manage",
  "actions:approve",
  "settings:manage",
  "credentials:manage",
  "analytics:read",
  "operations:manage",
  "assistance:use",
  "attachments:read",
  "attachments:upload",
] as const;
export type Capability = (typeof CAPABILITIES)[number];
export type TicketScope = "all" | "team" | "assigned";
const agent: Capability[] = [
  "tickets:read",
  "tickets:reply",
  "tickets:note",
  "tickets:update",
  "tickets:assign",
  "customers:read",
  "fields:internal:read",
  "fields:internal:write",
  "macros:personal",
  "views:personal",
  "knowledge:read",
  "workflow:read",
  "actions:read",
  "audit:read",
  "analytics:read",
  "assistance:use",
  "attachments:read",
  "attachments:upload",
];
const ownerOnly: Capability[] = [
  "actions:manage",
  "credentials:manage",
  "identity:manage",
  "roles:manage",
];
export const BUILTIN_CAPABILITIES: Record<string, readonly Capability[]> = {
  owner: CAPABILITIES,
  admin: CAPABILITIES.filter((cap) => !ownerOnly.includes(cap)),
  agent,
};
export function hasCapability(p: Principal, capability: string): boolean {
  return (
    CAPABILITIES.includes(capability as Capability) &&
    (p.capabilities ?? BUILTIN_CAPABILITIES[p.role] ?? []).includes(
      capability as Capability,
    )
  );
}
export function requireCapability(p: Principal, capability: Capability) {
  if (!hasCapability(p, capability))
    throw new HttpError(403, `Permission required: ${capability}`);
}
export async function resolveStaffPrincipal(
  db: Database,
  workspaceId: string,
  userId: string,
  q: Queryable = db.pool,
): Promise<Principal> {
  const member = await db.one(
    `SELECT m.*,r.capabilities,r.ticket_scope FROM memberships m LEFT JOIN staff_roles r ON r.workspace_id=m.workspace_id AND r.id=m.custom_role_id WHERE m.workspace_id=$1 AND m.user_id=$2`,
    [workspaceId, userId],
    q,
  );
  if (!member || member.disabled)
    throw new HttpError(403, "Your staff access is no longer available");
  const teams = await db.rows(
    `SELECT tm.team_id FROM team_members tm JOIN teams t ON t.workspace_id=tm.workspace_id AND t.id=tm.team_id WHERE tm.workspace_id=$1 AND tm.user_id=$2 AND t.active`,
    [workspaceId, userId],
    q,
  );
  return {
    workspaceId,
    userId,
    role: member.role,
    capabilities: member.custom_role_id
      ? (member.capabilities ?? [])
      : [...(BUILTIN_CAPABILITIES[member.role] ?? [])],
    ticketScope: member.custom_role_id
      ? (member.ticket_scope ?? "assigned")
      : "all",
    teamIds: teams.map((row) => row.team_id),
    customRoleId: member.custom_role_id ?? undefined,
    authRevision: member.auth_revision,
  };
}
export async function refreshPrincipal(
  db: Database,
  p: Principal,
  q: Queryable = db.pool,
): Promise<Principal> {
  if (!["owner", "admin", "agent"].includes(p.role)) return p;
  if (!p.userId) throw new HttpError(403, "Staff identity required");
  return {
    ...p,
    ...(await resolveStaffPrincipal(db, p.workspaceId, p.userId, q)),
  };
}
// Appends only bound values. Alias is a source-code identifier, never user input.
export function conversationVisibility(
  p: Principal,
  alias = "c",
  params: unknown[] = [],
): string {
  if (!/^[a-z][a-z0-9_]*$/i.test(alias)) throw new Error("Invalid SQL alias");
  if (!hasCapability(p, "tickets:read")) return "FALSE";
  if (!p.ticketScope || p.ticketScope === "all") return "TRUE";
  if (p.ticketScope === "assigned") {
    params.push(p.userId ?? "");
    return `${alias}.assigned_to=$${params.length}`;
  }
  params.push(p.teamIds ?? []);
  return `${alias}.team_id=ANY($${params.length}::text[])`;
}
export function canReadConversation(
  p: Principal,
  row: { assigned_to?: string; team_id?: string },
): boolean {
  return (
    hasCapability(p, "tickets:read") &&
    (!p.ticketScope ||
      p.ticketScope === "all" ||
      (p.ticketScope === "assigned"
        ? !!p.userId && row.assigned_to === p.userId
        : !!row.team_id && !!p.teamIds?.includes(row.team_id)))
  );
}
