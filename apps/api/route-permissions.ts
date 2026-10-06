import { staff, type Principal } from "../../packages/platform/src/auth.js";
import { HttpError } from "../../packages/platform/src/config.js";
import {
  hasCapability,
  requireCapability,
  type Capability,
} from "../../packages/platform/src/permissions.js";

// All staff HTTP entry points (including subrouters and SSE reauthorization) pass
// this gate. Row-scoped services still enforce conversation ownership themselves.
export function authorizeWorkspaceRoute(
  p: Principal,
  path: string,
  method: string,
) {
  if (!staff(p)) return;
  const read = method === "GET";
  let capability: Capability | undefined;
  if (
    /^\/(analytics|quality|evaluation|readiness|shadow|rollouts|audit|operations|jobs|knowledge)(\/|$)/.test(
      path,
    ) ||
    path === "/workflow/step-results" ||
    /^\/sla(\/|$)/.test(path)
  ) {
    if (p.ticketScope && p.ticketScope !== "all")
      throw new HttpError(
        403,
        "This workspace-wide view requires access to all tickets",
      );
  }
  if (
    /^\/(quality|evaluation|readiness|shadow|rollouts|audit|operations|jobs|knowledge)(\/|$)/.test(
      path,
    ) ||
    path === "/workflow/step-results"
  )
    requireCapability(p, "tickets:note");
  if (/^\/(analytics|quality|evaluation|shadow|rollouts)(\/|$)/.test(path))
    capability = read ? "analytics:read" : "workflow:manage";
  else if (/^\/knowledge(\/|$)/.test(path))
    capability = read ? "knowledge:read" : "knowledge:manage";
  else if (/^\/readiness(\/|$)/.test(path))
    capability = read ? "tickets:read" : "operations:manage";
  else if (/^\/sla(\/|$)/.test(path))
    capability = read ? "analytics:read" : "settings:manage";
  else if (/^\/(operations|jobs)(\/|$)/.test(path))
    capability = "operations:manage";
  else if (path === "/audit") capability = "audit:read";
  else if (/^\/staff-roles(\/|$)/.test(path)) {
    if (read && path === "/staff-roles" && hasCapability(p, "members:manage"))
      return;
    capability = path.startsWith("/staff-roles/members/")
      ? "members:manage"
      : "roles:manage";
  } else if (/^\/identity(\/|$)/.test(path)) capability = "identity:manage";
  else if (/^\/ticket-email(\/|$)/.test(path))
    capability = path.endsWith("/retry") ? "email:retry" : "email:manage";
  else if (
    /^\/(settings|appearance|profile|support-options|channels)(\/|$)/.test(path)
  )
    capability = "settings:manage";
  else if (/^\/connections(\/|$)/.test(path))
    capability = read ? "settings:manage" : "credentials:manage";
  else if (/^\/(credentials|identity-key)(\/|$)/.test(path))
    capability = "credentials:manage";
  else if (/^\/(invitations|members)(\/|$)/.test(path))
    capability = read ? "tickets:read" : "members:manage";
  else if (/^\/(contacts|customers)(\/|$)/.test(path))
    capability = read ? "customers:read" : "customers:manage";
  else if (/^\/(workflow|agent)(\/|$)/.test(path))
    capability = read ? "workflow:read" : "workflow:manage";
  else if (/^\/(faqs|sources|documents)(\/|$)/.test(path))
    capability = read ? "knowledge:read" : "knowledge:manage";
  else if (/^\/actions(\/|$)/.test(path))
    capability = read ? "actions:read" : "actions:manage";
  else if (/^\/approvals(\/|$)/.test(path))
    capability = read ? "actions:read" : "actions:approve";
  else if (/^\/assistance(\/|$)/.test(path)) capability = "assistance:use";
  else if (/^\/attachments(\/|$)/.test(path))
    capability =
      path === "/attachments/settings" && !read
        ? "settings:manage"
        : read
          ? "attachments:read"
          : "attachments:upload";
  else if (/^\/conversations\/[^/]+/.test(path)) {
    capability = read
      ? "tickets:read"
      : path.endsWith("/notes")
        ? "tickets:note"
        : path.endsWith("/messages")
          ? "tickets:reply"
          : method === "DELETE"
            ? "tickets:delete"
            : "tickets:update";
    if (path.endsWith("/read") || /\/macros\/[^/]+\/preview$/.test(path))
      capability = "tickets:read";
    if (path.endsWith("/test-case")) requireCapability(p, "workflow:read");
    if (path.endsWith("/gap")) requireCapability(p, "knowledge:manage");
  } else if (path === "/inbox" || path === "/conversations")
    capability = read ? "tickets:read" : "tickets:reply";
  // These services check granular permissions (personal/shared, team/self, and
  // field visibility) against the specific payload and fresh membership.
  else if (
    /^\/(routing|productivity|ticket-fields|ticket-forms|macros|saved-views)(\/|$)/.test(
      path,
    )
  )
    return;
  else if (!path) return;
  else if (p.customRoleId)
    throw new HttpError(403, "This endpoint is unavailable to this role");
  if (capability) requireCapability(p, capability);
}
