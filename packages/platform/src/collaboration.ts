import { canonicalTicket, ticketGroup } from "./ticket-canonical.js";
import { z } from "zod";
import { Database, uid, type Queryable } from "./db.js";
import { conversation, staff, type Principal, type Mailer } from "./auth.js";
import { HttpError, requireValue } from "./config.js";
import {
  refreshPrincipal,
  requireCapability,
  hasCapability,
} from "./permissions.js";
import { seal, unseal, token, tokenHash } from "./security.js";
import { customerTicketAccess } from "./customer-access.js";
import type { PoolClient } from "pg";
const email = z
  .email()
  .max(254)
  .transform((v) => v.toLowerCase());
const orgInput = z
  .object({
    name: z.string().trim().min(1).max(150),
    description: z.string().max(2000).default(""),
    active: z.boolean().default(true),
    revision: z.number().int().positive().optional(),
  })
  .strict();
export class Collaboration {
  constructor(
    public db: Database,
    private send: Mailer,
  ) {}
  async lock(q: Queryable, ws: string) {
    await q.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      `human-routing:${ws}`,
    ]);
  }
  private async authority(
    p: Principal,
    cap: "organizations:manage" | "tickets:participants",
    q?: PoolClient,
  ) {
    if (q)
      await q.query(
        "SELECT user_id FROM memberships WHERE workspace_id=$1 AND user_id=$2 FOR SHARE",
        [p.workspaceId, p.userId],
      );
    p = await refreshPrincipal(this.db, p, q);
    requireCapability(p, cap);
    if (
      cap === "organizations:manage" &&
      p.ticketScope &&
      p.ticketScope !== "all"
    )
      throw new HttpError(
        403,
        "Organization management requires full ticket scope",
      );
    return p;
  }
  async organizations(p: Principal) {
    if (!staff(p)) {
      const ct = await this.db.one(
        "SELECT verified,user_id FROM contacts WHERE workspace_id=$1 AND id=$2",
        [p.workspaceId, p.contactId],
      );
      if (
        p.role !== "customer" ||
        p.channelId ||
        !ct?.verified ||
        ct.user_id !== p.userId
      )
        throw new HttpError(403, "Verified customer account required");
      return {
        organizations: await this.db.rows(
          `SELECT o.id,o.name,m.role FROM customer_organizations o JOIN customer_organization_memberships m ON m.workspace_id=o.workspace_id AND m.organization_id=o.id WHERE o.workspace_id=$1 AND m.contact_id=$2 AND m.active AND o.active ORDER BY o.name`,
          [p.workspaceId, p.contactId],
        ),
      };
    }
    p = await this.authority(p, "organizations:manage");
    return {
      organizations: await this.db.rows(
        `SELECT o.*,(SELECT count(*)::int FROM customer_organization_memberships m WHERE m.workspace_id=o.workspace_id AND m.organization_id=o.id AND m.active) member_count FROM customer_organizations o WHERE o.workspace_id=$1 ORDER BY o.name`,
        [p.workspaceId],
      ),
    };
  }
  async organization(p: Principal, id: string) {
    p = await this.authority(p, "organizations:manage");
    const organization = requireValue(
      await this.db.one(
        "SELECT * FROM customer_organizations WHERE workspace_id=$1 AND id=$2",
        [p.workspaceId, id],
      ),
    );
    return {
      organization,
      members: await this.db.rows(
        `SELECT m.*,ct.name,ct.email FROM customer_organization_memberships m JOIN contacts ct ON ct.workspace_id=m.workspace_id AND ct.id=m.contact_id WHERE m.workspace_id=$1 AND m.organization_id=$2 AND m.active ORDER BY ct.name`,
        [p.workspaceId, id],
      ),
      invitations: await this.db.rows(
        "SELECT id,email,role,status,error,expires_at,accepted_at,revoked_at FROM collaboration_invitations WHERE workspace_id=$1 AND organization_id=$2 ORDER BY created_at DESC LIMIT 100",
        [p.workspaceId, id],
      ),
    };
  }
  async saveOrganization(p: Principal, raw: unknown, id?: string) {
    const d = orgInput.parse(raw);
    return this.db.tx(async (q) => {
      await this.lock(q, p.workspaceId);
      p = await this.authority(p, "organizations:manage", q);
      let result;
      if (id)
        result = requireValue(
          await this.db.one(
            "UPDATE customer_organizations SET name=$3,description=$4,active=$5,revision=revision+1 WHERE workspace_id=$1 AND id=$2 AND revision=$6 RETURNING *",
            [p.workspaceId, id, d.name, d.description, d.active, d.revision],
            q,
          ),
          409,
          "Organization changed; reload before saving",
        );
      else
        result = await this.db.one(
          "INSERT INTO customer_organizations(id,workspace_id,name,description) VALUES($1,$2,$3,$4) RETURNING *",
          [uid(), p.workspaceId, d.name, d.description],
          q,
        );
      if (!d.active)
        await q.query(
          "UPDATE collaboration_invitations SET revoked_at=now(),token_ciphertext=NULL WHERE workspace_id=$1 AND organization_id=$2 AND accepted_at IS NULL",
          [p.workspaceId, result!.id],
        );
      await this.db.event(q, p.workspaceId, "organization.updated", {
        organizationId: result!.id,
        actorId: p.userId,
        active: d.active,
      });
      return result;
    });
  }
  private async invite(
    q: PoolClient,
    p: Principal,
    kind: "participant" | "organization",
    address: string,
    resource: string,
    role = "member",
  ) {
    const id = uid(),
      secret = token();
    await q.query(
      `INSERT INTO collaboration_invitations(id,workspace_id,kind,email,participant_id,organization_id,role,token_hash,token_ciphertext,expires_at,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,now()+interval '7 days',$10)`,
      [
        id,
        p.workspaceId,
        kind,
        address,
        kind === "participant" ? resource : null,
        kind === "organization" ? resource : null,
        role,
        tokenHash(secret),
        seal(
          this.db.config.FIELDKIT_ENCRYPTION_KEY,
          `collaboration:${p.workspaceId}:${id}`,
          secret,
        ),
        p.userId,
      ],
    );
    await this.db.enqueue(q, "collaboration-email", {
      workspaceId: p.workspaceId,
      invitationId: id,
    });
    return { id, status: "queued" };
  }
  async inviteOrganization(p: Principal, id: string, raw: unknown) {
    const d = z
      .object({ email, role: z.enum(["member", "manager"]).default("member") })
      .strict()
      .parse(raw);
    return this.db.tx(async (q) => {
      await this.lock(q, p.workspaceId);
      p = await this.authority(p, "organizations:manage", q);
      requireValue(
        await this.db.one(
          "SELECT id FROM customer_organizations WHERE workspace_id=$1 AND id=$2 AND active FOR UPDATE",
          [p.workspaceId, id],
          q,
        ),
      );
      await q.query(
        "UPDATE collaboration_invitations SET revoked_at=now(),token_ciphertext=NULL WHERE workspace_id=$1 AND organization_id=$2 AND email=$3 AND accepted_at IS NULL",
        [p.workspaceId, id, d.email],
      );
      const result = await this.invite(
        q,
        p,
        "organization",
        d.email,
        id,
        d.role,
      );
      await this.db.event(q, p.workspaceId, "organization.invited", {
        organizationId: id,
        invitationId: result.id,
        actorId: p.userId,
        role: d.role,
      });
      return result;
    });
  }
  async removeMember(p: Principal, id: string, contactId: string) {
    return this.db.tx(async (q) => {
      await this.lock(q, p.workspaceId);
      p = await this.authority(p, "organizations:manage", q);
      requireValue(
        await this.db.one(
          "UPDATE customer_organization_memberships SET active=false WHERE workspace_id=$1 AND organization_id=$2 AND contact_id=$3 RETURNING contact_id",
          [p.workspaceId, id, contactId],
          q,
        ),
      );
      await q.query(
        "UPDATE collaboration_invitations SET revoked_at=now(),token_ciphertext=NULL WHERE workspace_id=$1 AND organization_id=$2 AND email=(SELECT lower(email) FROM contacts WHERE workspace_id=$1 AND id=$3) AND accepted_at IS NULL",
        [p.workspaceId, id, contactId],
      );
      await this.db.event(q, p.workspaceId, "organization.member_removed", {
        organizationId: id,
        contactId,
        actorId: p.userId,
      });
      return { removed: true };
    });
  }
  async ticket(p: Principal, id: string) {
    const c = await conversation(this.db, p, id);
    if (!staff(p))
      return {
        access: await customerTicketAccess(this.db, p, c),
        organization: c.organization_id
          ? await this.db.one(
              "SELECT id,name FROM customer_organizations WHERE workspace_id=$1 AND id=$2 AND active",
              [p.workspaceId, c.organization_id],
            )
          : null,
        sharing: c.sharing,
      };
    p = await refreshPrincipal(this.db, p);
    return {
      canManage: hasCapability(p, "tickets:participants"),
      sharing: c.sharing,
      organizationId: c.organization_id,
      participants: await this.db.rows(
        "SELECT id,email,joined_at,portal_contact_id,active FROM ticket_participants WHERE workspace_id=$1 AND conversation_id=$2 AND active ORDER BY joined_at",
        [p.workspaceId, c.id],
      ),
      invitations: await this.db.rows(
        "SELECT i.id,i.email,i.status,i.error,i.expires_at,i.accepted_at,i.revoked_at FROM collaboration_invitations i JOIN ticket_participants p ON p.workspace_id=i.workspace_id AND p.id=i.participant_id WHERE i.workspace_id=$1 AND p.conversation_id=$2 ORDER BY i.created_at DESC LIMIT 50",
        [p.workspaceId, c.id],
      ),
      followers: await this.db.rows(
        'SELECT f.user_id,f.include_notes,u.name FROM ticket_followers f JOIN "user" u ON u.id=f.user_id WHERE f.workspace_id=$1 AND f.conversation_id=$2',
        [p.workspaceId, c.id],
      ),
      following: !!(await this.db.one(
        "SELECT 1 FROM ticket_followers WHERE workspace_id=$1 AND conversation_id=$2 AND user_id=$3",
        [p.workspaceId, c.id, p.userId],
      )),
      includeNotes: !!(await this.db.one(
        "SELECT 1 FROM ticket_followers WHERE workspace_id=$1 AND conversation_id=$2 AND user_id=$3 AND include_notes",
        [p.workspaceId, c.id, p.userId],
      )),
      canReadNotes: hasCapability(p, "tickets:note"),
      suggestions: await this.db.rows(
        "SELECT email FROM email_cc_suggestions WHERE workspace_id=$1 AND conversation_id=$2 AND status='pending' ORDER BY created_at LIMIT 20",
        [p.workspaceId, c.id],
      ),
      organizations: hasCapability(p, "organizations:manage")
        ? await this.db.rows(
            "SELECT id,name FROM customer_organizations WHERE workspace_id=$1 AND active ORDER BY name",
            [p.workspaceId],
          )
        : [],
    };
  }
  private async ticketMutation(
    p: Principal,
    id: string,
    fn: (q: PoolClient, p: Principal, c: any) => Promise<any>,
  ) {
    return this.db.tx(async (q) => {
      await this.lock(q, p.workspaceId);
      p = await this.authority(p, "tickets:participants", q);
      const c = await conversation(this.db, p, id, q);
      await q.query(
        "SELECT id FROM conversations WHERE workspace_id=$1 AND id=$2 FOR UPDATE",
        [p.workspaceId, c.id],
      );
      if (c.external_id)
        throw new HttpError(
          409,
          "Manage participants in the external support system",
        );
      return fn(q, p, c);
    });
  }
  private async changed(
    q: PoolClient,
    p: Principal,
    c: any,
    kind: string,
    data: object,
  ) {
    await q.query(
      "UPDATE conversations SET mode='human',revision=revision+1,updated_at=now() WHERE workspace_id=$1 AND id=$2",
      [p.workspaceId, c.id],
    );
    await q.query(
      "UPDATE approvals SET status='stale' WHERE status='pending' AND run_id IN (SELECT id FROM runs WHERE workspace_id=$1 AND conversation_id=$2)",
      [p.workspaceId, c.id],
    );
    await this.db.event(
      q,
      p.workspaceId,
      kind,
      { ...data, actorId: p.userId },
      c.id,
      false,
    );
  }
  async addParticipant(p: Principal, id: string, raw: unknown) {
    const d = z
      .object({ email, confirmFutureOnly: z.literal(true) })
      .strict()
      .parse(raw);
    return this.ticketMutation(p, id, async (q, p, c) => {
      const requester = await this.db.one(
        "SELECT email FROM contacts WHERE workspace_id=$1 AND id=$2",
        [p.workspaceId, c.contact_id],
        q,
      );
      if (requester?.email?.toLowerCase() === d.email)
        throw new HttpError(409, "This address is already the requester");
      const existing = await this.db.one(
        "SELECT id FROM ticket_participants WHERE workspace_id=$1 AND conversation_id=$2 AND lower(email)=$3 AND active",
        [p.workspaceId, c.id, d.email],
        q,
      );
      if (existing)
        throw new HttpError(409, "This participant already has access");
      const count = await this.db.one(
        "SELECT count(*)::int n FROM ticket_participants WHERE workspace_id=$1 AND conversation_id=$2 AND active",
        [p.workspaceId, c.id],
        q,
      );
      if (count!.n >= 20)
        throw new HttpError(
          409,
          "A ticket can have at most 20 external participants",
        );
      const contact = requireValue(
        await this.db.one(
          `INSERT INTO contacts(id,workspace_id,external_id,email) VALUES($1,$2,$3,$4) ON CONFLICT(workspace_id,external_id) DO UPDATE SET external_id=excluded.external_id RETURNING id`,
          [uid(), p.workspaceId, `email:${d.email}`, d.email],
          q,
        ),
      );
      const participant = requireValue(
        await this.db.one(
          "INSERT INTO ticket_participants(id,workspace_id,conversation_id,contact_id,email,added_by) VALUES($1,$2,$3,$4,$5,$6) RETURNING *",
          [uid(), p.workspaceId, c.id, contact.id, d.email, p.userId],
          q,
        ),
      );
      const invitation = await this.invite(
        q,
        p,
        "participant",
        d.email,
        participant.id,
      );
      await q.query(
        "UPDATE email_cc_suggestions SET status='approved' WHERE workspace_id=$1 AND conversation_id=$2 AND email=$3",
        [p.workspaceId, c.id, d.email],
      );
      await this.changed(q, p, c, "ticket.participant_added", {
        participantId: participant.id,
      });
      return { participant, invitation };
    });
  }
  async removeParticipant(p: Principal, id: string, participantId: string) {
    return this.ticketMutation(p, id, async (q, p, c) => {
      const participant = requireValue(
        await this.db.one(
          "SELECT email FROM ticket_participants WHERE workspace_id=$1 AND conversation_id=$2 AND id=$3 AND active",
          [p.workspaceId, c.id, participantId],
          q,
        ),
      );
      const group = await ticketGroup(this.db, p.workspaceId, c.id, q);
      const revoked = await this.db.rows(
        "UPDATE ticket_participants SET active=false,revoked_at=now() WHERE workspace_id=$1 AND conversation_id=ANY($2::text[]) AND email=$3 AND active RETURNING id",
        [p.workspaceId, group, participant.email],
        q,
      );
      const ids = revoked.map((r) => r.id);
      await q.query(
        "DELETE FROM ticket_email_routes WHERE workspace_id=$1 AND participant_id=ANY($2::text[])",
        [p.workspaceId, ids],
      );
      await q.query(
        "UPDATE collaboration_invitations SET revoked_at=now(),token_ciphertext=NULL WHERE workspace_id=$1 AND participant_id=ANY($2::text[])",
        [p.workspaceId, ids],
      );
      await q.query(
        "UPDATE ticket_email_deliveries SET status='skipped',error='Participant access revoked' WHERE workspace_id=$1 AND participant_id=ANY($2::text[]) AND status IN ('queued','waiting_files')",
        [p.workspaceId, ids],
      );
      await this.changed(q, p, c, "ticket.participant_removed", {
        participantId,
      });
      return { removed: true };
    });
  }
  async share(p: Principal, id: string, raw: unknown) {
    const d = z
      .object({
        organizationId: z.string().nullable(),
        sharing: z.enum(["private", "company"]),
        confirmHistory: z.boolean().default(false),
      })
      .strict()
      .parse(raw);
    return this.ticketMutation(p, id, async (q, p, c) => {
      requireCapability(p, "organizations:manage");
      if (d.organizationId)
        requireValue(
          await this.db.one(
            "SELECT id FROM customer_organizations WHERE workspace_id=$1 AND id=$2 AND active",
            [p.workspaceId, d.organizationId],
            q,
          ),
        );
      if (d.sharing === "company" && (!d.organizationId || !d.confirmHistory))
        throw new HttpError(
          400,
          "Confirm that company managers may read all public correspondence and files",
        );
      await q.query(
        "UPDATE conversations SET organization_id=$3,sharing=$4 WHERE workspace_id=$1 AND (id=$2 OR merged_into_id=$2)",
        [p.workspaceId, c.id, d.organizationId, d.sharing],
      );
      await this.changed(q, p, c, "ticket.sharing_changed", {
        organizationId: d.organizationId,
        sharing: d.sharing,
      });
      return { updated: true };
    });
  }
  async follow(p: Principal, id: string, raw: unknown) {
    const d = z
      .object({
        following: z.boolean(),
        includeNotes: z.boolean().default(false),
      })
      .strict()
      .parse(raw);
    return this.db.tx(async (q) => {
      await this.lock(q, p.workspaceId);
      p = await refreshPrincipal(this.db, p, q);
      requireCapability(p, "tickets:read");
      const c = await conversation(this.db, p, id, q);
      if (d.includeNotes) requireCapability(p, "tickets:note");
      if (d.following)
        await q.query(
          "INSERT INTO ticket_followers(workspace_id,conversation_id,user_id,include_notes) VALUES($1,$2,$3,$4) ON CONFLICT(workspace_id,conversation_id,user_id) DO UPDATE SET include_notes=excluded.include_notes",
          [p.workspaceId, c.id, p.userId, d.includeNotes],
        );
      else
        await q.query(
          "DELETE FROM ticket_followers WHERE workspace_id=$1 AND conversation_id=$2 AND user_id=$3",
          [p.workspaceId, c.id, p.userId],
        );
      return { following: d.following };
    });
  }
  async invitation(p: Principal, secret: string, accept = false) {
    return this.db.tx(async (q) => {
      await this.lock(q, p.workspaceId);
      const i = requireValue(
        await this.db.one(
          "SELECT * FROM collaboration_invitations WHERE workspace_id=$1 AND token_hash=$2 AND revoked_at IS NULL AND expires_at>now() FOR UPDATE",
          [p.workspaceId, tokenHash(secret)],
          q,
        ),
        404,
        "Invitation unavailable",
      );
      const ct = await this.db.one(
        "SELECT * FROM contacts WHERE workspace_id=$1 AND id=$2",
        [p.workspaceId, p.contactId],
        q,
      );
      if (
        p.role !== "customer" ||
        p.channelId ||
        !p.userId ||
        !ct?.verified ||
        ct.user_id !== p.userId ||
        ct.email?.toLowerCase() !== i.email
      )
        throw new HttpError(
          403,
          "Sign in to a verified customer account with the invited email address",
        );
      const resource =
        i.kind === "organization"
          ? await this.db.one(
              "SELECT id,name FROM customer_organizations WHERE workspace_id=$1 AND id=$2 AND active",
              [p.workspaceId, i.organization_id],
              q,
            )
          : await this.db.one(
              "SELECT p.id,p.conversation_id,c.subject name FROM ticket_participants p JOIN conversations c ON c.workspace_id=p.workspace_id AND c.id=p.conversation_id WHERE p.workspace_id=$1 AND p.id=$2 AND p.active",
              [p.workspaceId, i.participant_id],
              q,
            );
      requireValue(resource, 404, "Invitation unavailable");
      const canonicalId = resource?.conversation_id
        ? (
            await canonicalTicket(
              this.db,
              p.workspaceId,
              resource.conversation_id,
              q,
            )
          ).id
        : undefined;
      if (accept && !i.accepted_at) {
        if (i.kind === "organization")
          await q.query(
            "INSERT INTO customer_organization_memberships(workspace_id,organization_id,contact_id,role) VALUES($1,$2,$3,$4) ON CONFLICT(workspace_id,organization_id,contact_id) DO UPDATE SET active=true,role=excluded.role",
            [p.workspaceId, i.organization_id, p.contactId, i.role],
          );
        else
          await q.query(
            "UPDATE ticket_participants SET portal_contact_id=$3 WHERE workspace_id=$1 AND conversation_id=ANY($2::text[]) AND email=$4 AND active",
            [
              p.workspaceId,
              await ticketGroup(this.db, p.workspaceId, canonicalId!, q),
              p.contactId,
              i.email,
            ],
          );
        await q.query(
          "UPDATE collaboration_invitations SET accepted_at=now(),token_ciphertext=NULL WHERE id=$1",
          [i.id],
        );
        await this.db.event(
          q,
          p.workspaceId,
          "collaboration.invitation_accepted",
          { invitationId: i.id, kind: i.kind, contactId: p.contactId },
          canonicalId,
          false,
        );
      }
      return {
        id: i.id,
        kind: i.kind,
        name: resource!.name,
        role: i.role,
        accepted: accept || !!i.accepted_at,
        conversationId: canonicalId,
        scope:
          i.kind === "participant"
            ? "Only correspondence sent after you were added"
            : i.role === "manager"
              ? "All public history of tickets explicitly shared with this company"
              : "Your own tickets only",
      };
    });
  }
  async retryInvitation(p: Principal, id: string) {
    return this.db.tx(async (q) => {
      await this.lock(q, p.workspaceId);
      const i = requireValue(
        await this.db.one(
          "SELECT * FROM collaboration_invitations WHERE workspace_id=$1 AND id=$2",
          [p.workspaceId, id],
          q,
        ),
      );
      p = await this.authority(
        p,
        i.kind === "organization"
          ? "organizations:manage"
          : "tickets:participants",
        q,
      );
      if (i.participant_id) {
        const t = requireValue(
          await this.db.one(
            "SELECT conversation_id FROM ticket_participants WHERE workspace_id=$1 AND id=$2",
            [p.workspaceId, i.participant_id],
            q,
          ),
        );
        await conversation(this.db, p, t.conversation_id, q);
      }
      requireValue(
        await this.db.one(
          "UPDATE collaboration_invitations SET status='queued',error=NULL WHERE id=$1 AND status IN ('failed','unknown') AND token_ciphertext IS NOT NULL AND revoked_at IS NULL AND expires_at>now() RETURNING id",
          [id],
          q,
        ),
        409,
        "Invitation is not awaiting recovery",
      );
      await this.db.enqueue(q, "collaboration-email", {
        workspaceId: p.workspaceId,
        invitationId: id,
      });
      return { queued: true };
    });
  }
  async resendInvitation(p: Principal, id: string) {
    return this.db.tx(async (q) => {
      await this.lock(q, p.workspaceId);
      const i = requireValue(
        await this.db.one(
          "SELECT * FROM collaboration_invitations WHERE workspace_id=$1 AND id=$2 FOR UPDATE",
          [p.workspaceId, id],
          q,
        ),
      );
      p = await this.authority(
        p,
        i.kind === "organization"
          ? "organizations:manage"
          : "tickets:participants",
        q,
      );
      if (i.accepted_at || i.revoked_at)
        throw new HttpError(409, "This invitation was accepted or revoked");
      if (i.participant_id) {
        const t = requireValue(
          await this.db.one(
            "SELECT conversation_id FROM ticket_participants WHERE workspace_id=$1 AND id=$2 AND active",
            [p.workspaceId, i.participant_id],
            q,
          ),
        );
        await conversation(this.db, p, t.conversation_id, q);
      } else
        requireValue(
          await this.db.one(
            "SELECT id FROM customer_organizations WHERE workspace_id=$1 AND id=$2 AND active",
            [p.workspaceId, i.organization_id],
            q,
          ),
        );
      const count = await this.db.one(
        "SELECT count(*)::int n FROM collaboration_invitations WHERE workspace_id=$1 AND email=$2 AND created_at>now()-interval '1 hour'",
        [p.workspaceId, i.email],
        q,
      );
      if (count!.n >= 5)
        throw new HttpError(
          429,
          "Wait before sending another invitation to this address",
        );
      await q.query(
        "UPDATE collaboration_invitations SET revoked_at=now(),token_ciphertext=NULL WHERE id=$1",
        [id],
      );
      const next = await this.invite(
        q,
        p,
        i.kind,
        i.email,
        i.participant_id ?? i.organization_id,
        i.role,
      );
      await this.db.event(q, p.workspaceId, "collaboration.invitation_resent", {
        invitationId: next.id,
        previousInvitationId: id,
        actorId: p.userId,
      });
      return next;
    });
  }
  async dismissSuggestion(p: Principal, id: string, raw: unknown) {
    const d = z.object({ email }).strict().parse(raw);
    return this.ticketMutation(p, id, async (q, p, c) => {
      await q.query(
        "UPDATE email_cc_suggestions SET status='dismissed' WHERE workspace_id=$1 AND conversation_id=$2 AND email=$3",
        [p.workspaceId, c.id, d.email],
      );
      return { dismissed: true };
    });
  }
  async deliverInvitation(ws: string, id: string) {
    const row = await this.db.tx(async (q) => {
      await this.lock(q, ws);
      const i = await this.db.one(
        "SELECT i.*,w.slug,w.name workspace_name FROM collaboration_invitations i JOIN workspaces w ON w.id=i.workspace_id WHERE i.workspace_id=$1 AND i.id=$2 FOR UPDATE OF i",
        [ws, id],
        q,
      );
      if (!i || ["sent", "failed", "unknown", "skipped"].includes(i.status))
        return null;
      if (i.status === "sending") {
        if (Date.now() - new Date(i.attempted_at).getTime() > 60000)
          await q.query(
            "UPDATE collaboration_invitations SET status='unknown',error='Delivery interrupted; check provider before retrying' WHERE id=$1",
            [id],
          );
        return null;
      }
      const valid =
        !i.revoked_at &&
        !i.accepted_at &&
        new Date(i.expires_at).getTime() > Date.now() &&
        i.token_ciphertext &&
        (i.organization_id
          ? await this.db.one(
              "SELECT 1 FROM customer_organizations WHERE workspace_id=$1 AND id=$2 AND active",
              [ws, i.organization_id],
              q,
            )
          : await this.db.one(
              "SELECT 1 FROM ticket_participants WHERE workspace_id=$1 AND id=$2 AND active",
              [ws, i.participant_id],
              q,
            ));
      if (!valid) {
        await q.query(
          "UPDATE collaboration_invitations SET status='skipped' WHERE id=$1",
          [id],
        );
        return null;
      }
      await q.query(
        "UPDATE collaboration_invitations SET status='sending',attempted_at=now() WHERE id=$1",
        [id],
      );
      return i;
    });
    if (!row) return;
    try {
      const secret = unseal<string>(
        this.db.config.FIELDKIT_ENCRYPTION_KEY,
        `collaboration:${ws}:${id}`,
        row.token_ciphertext,
      );
      await this.send(
        row.email,
        `${row.workspace_name} support invitation`,
        `You have been invited to ${row.kind === "organization" ? "a customer organization" : "future correspondence on a support ticket"}. Sign in with this email address, verify it, and explicitly accept the invitation:\n${this.db.config.FIELDKIT_URL}/support/${encodeURIComponent(row.slug)}?invitation=${encodeURIComponent(secret)}\n\nThis invitation expires in seven days. It does not merge accounts or authorize account actions.`,
        {
          messageId: `<invitation-${id}@${new URL(this.db.config.FIELDKIT_URL).hostname}>`,
        },
      );
      await this.db.pool.query(
        "UPDATE collaboration_invitations SET status='sent',sent_at=now() WHERE id=$1",
        [id],
      );
    } catch (e) {
      const known = [
        "ECONNREFUSED",
        "ENOTFOUND",
        "EAUTH",
        "EENVELOPE",
      ].includes((e as any).code);
      await this.db.pool.query(
        "UPDATE collaboration_invitations SET status=$2,error=$3 WHERE id=$1",
        [
          id,
          known ? "failed" : "unknown",
          known
            ? "SMTP rejected the invitation before accepting it"
            : "Delivery uncertain; check provider before retrying",
        ],
      );
    }
  }
  async recover() {
    for (const i of await this.db.rows(
      "SELECT id,workspace_id FROM collaboration_invitations WHERE status IN ('queued','sending') ORDER BY created_at LIMIT 100",
    ))
      await this.deliverInvitation(i.workspace_id, i.id);
    await this.db.pool.query(
      "UPDATE collaboration_invitations SET token_ciphertext=NULL WHERE expires_at<now() OR revoked_at IS NOT NULL OR accepted_at IS NOT NULL",
    );
  }
}
