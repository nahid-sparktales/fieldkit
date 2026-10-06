# Custom staff roles

Built-in Owner, Administrator, and Agent roles remain available. Custom roles
replace a member's built-in capability list with an explicit allowlist. Legacy
administrator/owner services also retain their base-role ceiling: a custom
capability alone cannot open those tools for a base Agent. For a custom role
that needs legacy administrator features, select Administrator as its base role
as well as the relevant capabilities. Custom permissions still restrict that
Administrator's access. Legacy owner-only operations remain owner-only; a custom
role cannot create or become an owner. New helpdesk services enforce explicit
capabilities. Unknown
capabilities are rejected; a missing/deleted custom-role definition grants
nothing. A custom role cannot create an owner.

The Security page includes the role editor and member assignment matrix.
Create a descriptive role, select its ticket visibility, and enable only the
capabilities that responsibility needs. The built-in matrix is available for
reference. Internal field access, replies, notes, assignment, administration,
identity settings, and role management remain distinct permissions.

Ticket visibility can be all workspace tickets, current active teams' tickets,
or only tickets assigned to the member. `tickets:read` is still required.
Shared views, macros, and team names do not grant access. Team membership and
assignment affect the visibility scope; they do not add capabilities.

Role changes and member assignments require recent identity verification in
Security. When MFA is enabled, the shared identity service requires its proof
as well. A stale, expired, revoked, or missing session cannot authorize a write.
The server refreshes the actor's current membership/capabilities rather than
trusting a previously loaded permission matrix.

Role administrators cannot grant capabilities they lack or a ticket scope
broader than their own. They cannot edit a role assigned to themselves. Member
administrators cannot change their own access, convert anyone into an owner,
or change/disable an existing owner through the role editor. Existing ownership
therefore stays protected, including the last owner. The separate membership
removal service also enforces the product's ownership safeguards.

Saving a role uses an optimistic revision. A stale editor must reload instead
of overwriting newer changes. Deletion is available only when the role has no
assigned members; move its members to another role first. Definitions and
assignment changes are workspace-scoped and audited without identity secrets.

Every affected membership's `auth_revision` advances. Active sessions and
their stored step-up proofs are revoked, so affected staff must sign in again.
That revocation applies to the user's sessions across workspaces. A durable
routing retry rechecks disabled/removed authority before further assignment.
Role and member mutations share the routing workspace lock before membership
row locks, so a concurrent automatic claim cannot bypass the authority update.

Implementation: `packages/platform/src/staff-roles.ts`, the shared
`permissions.ts`/identity helpers, migration 19's role/member columns, and
`apps/web/src/RolesEditor.tsx`. No new external service is required.

Workspace API routes:

- `GET /staff-roles`: readable definitions, built-ins, member assignments, and the
  actor's delegation limits (`roles:manage` or `members:manage`).
- `POST /staff-roles`: create/update a custom role (`roles:manage`, fresh proof).
- `DELETE /staff-roles/:id`: delete an unused role (same authority).
- `PUT /staff-roles/members/:user`: assign a built-in/custom role or disable staff
  access (`members:manage`, fresh proof).

The additive upgrade does not replace existing memberships or enforce SSO/MFA
on its own. To stop using custom roles, explicitly move members to suitable
built-in roles. Do not drop role definitions while memberships reference them.

`tests/staff-roles.test.ts` covers exact capability application, stale/revoked
proofs, self-escalation, owner protection, capability/scope delegation, tenant
boundaries, unknown permissions, optimistic revisions, session revocation,
disabled members, and concurrent role/member updates. It uses a disposable
local PostgreSQL database and synthetic sessions; it does not certify an
external identity provider.
