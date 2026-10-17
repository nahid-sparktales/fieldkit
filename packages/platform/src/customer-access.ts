import type { Principal } from "./auth.js";
import type { Database, Queryable } from "./db.js";
import { HttpError } from "./config.js";

const noAccess = {
  read: false,
  reply: false,
  upload: false,
  updateFields: false,
  changeStatus: false,
  manageParticipants: false,
  submitFeedback: false,
  requester: false,
  visibleSince: null as string | null,
};
/** Only provider-constructed principals may use email correspondence grants. */
export async function customerTicketAccess(
  db: Database,
  p: Principal,
  c: any,
  q: Queryable = db.pool,
) {
  if (
    c.workspace_id !== p.workspaceId ||
    !p.contactId ||
    (p.channelId && p.channelId !== c.channel_id)
  )
    return { ...noAccess };
  if (c.contact_id === p.contactId)
    return {
      ...noAccess,
      read: true,
      reply: true,
      upload: true,
      updateFields: true,
      changeStatus: true,
      submitFeedback: true,
      requester: true,
    };
  if (p.role !== "customer" || p.channelId || c.external_id)
    return { ...noAccess };
  const contact = await db.one(
    "SELECT verified,user_id FROM contacts WHERE workspace_id=$1 AND id=$2",
    [p.workspaceId, p.contactId],
    q,
  );
  if (
    !p.emailIntake &&
    (!contact?.verified || !contact.user_id || contact.user_id !== p.userId)
  )
    return { ...noAccess };
  if (
    !p.emailIntake &&
    c.sharing === "company" &&
    c.organization_id &&
    (await db.one(
      `SELECT 1 FROM customer_organization_memberships m JOIN customer_organizations o ON o.workspace_id=m.workspace_id AND o.id=m.organization_id WHERE m.workspace_id=$1 AND m.organization_id=$2 AND m.contact_id=$3 AND m.active AND m.role='manager' AND o.active`,
      [p.workspaceId, c.organization_id, p.contactId],
      q,
    ))
  )
    return { ...noAccess, read: true, reply: true, upload: true };
  const participant = await db.one(
    `SELECT joined_at FROM ticket_participants WHERE workspace_id=$1 AND conversation_id=$2 AND active AND (${p.emailIntake ? "contact_id" : "portal_contact_id"}=$3) ORDER BY joined_at LIMIT 1`,
    [p.workspaceId, c.id, p.contactId],
    q,
  );
  return participant
    ? {
        ...noAccess,
        read: true,
        reply: true,
        upload: true,
        visibleSince: new Date(participant.joined_at).toISOString(),
      }
    : { ...noAccess };
}
export type CustomerTicketAction =
  | "read"
  | "reply"
  | "upload"
  | "updateFields"
  | "changeStatus"
  | "manageParticipants"
  | "submitFeedback";
export async function requireCustomerTicketAction(
  db: Database,
  p: Principal,
  c: any,
  action: CustomerTicketAction,
  q: Queryable = db.pool,
) {
  const access = await customerTicketAccess(db, p, c, q);
  if (!access[action]) throw new HttpError(404, "Conversation not found");
  return access;
}
const alias = (value: string) => {
  if (!/^[a-z][a-z0-9_]*$/i.test(value)) throw new Error("Invalid SQL alias");
  return value;
};
/** Bound SQL counterpart used by lists; widget/service credentials cannot inherit sharing. */
export function customerConversationVisibility(
  p: Principal,
  c = "c",
  params: unknown[] = [],
): string {
  alias(c);
  params.push(p.contactId ?? "");
  const ct = `$${params.length}`;
  const own = `${c}.contact_id=${ct}`;
  if (p.channelId) {
    params.push(p.channelId);
    return `(${own} AND ${c}.channel_id=$${params.length})`;
  }
  if (p.role !== "customer" || !p.userId) return own;
  params.push(p.userId);
  const user = `$${params.length}`;
  return `(${own} OR (${c}.external_id IS NULL AND EXISTS(SELECT 1 FROM contacts access_ct WHERE access_ct.workspace_id=${c}.workspace_id AND access_ct.id=${ct} AND access_ct.user_id=${user} AND access_ct.verified) AND (EXISTS(SELECT 1 FROM ticket_participants access_tp WHERE access_tp.workspace_id=${c}.workspace_id AND access_tp.conversation_id=${c}.id AND access_tp.portal_contact_id=${ct} AND access_tp.active) OR (${c}.sharing='company' AND EXISTS(SELECT 1 FROM customer_organization_memberships access_om JOIN customer_organizations access_o ON access_o.workspace_id=access_om.workspace_id AND access_o.id=access_om.organization_id WHERE access_om.workspace_id=${c}.workspace_id AND access_om.organization_id=${c}.organization_id AND access_om.contact_id=${ct} AND access_om.role='manager' AND access_om.active AND access_o.active)))))`;
}
export function customerMessageVisibility(
  p: Principal,
  c = "c",
  m = "m",
  params: unknown[] = [],
): string {
  alias(c);
  alias(m);
  params.push(p.contactId ?? "");
  const ct = `$${params.length}`;
  const company = `(${c}.sharing='company' AND EXISTS(SELECT 1 FROM customer_organization_memberships access_om JOIN customer_organizations access_o ON access_o.workspace_id=access_om.workspace_id AND access_o.id=access_om.organization_id WHERE access_om.workspace_id=${c}.workspace_id AND access_om.organization_id=${c}.organization_id AND access_om.contact_id=${ct} AND access_om.role='manager' AND access_om.active AND access_o.active))`;
  return `(${c}.contact_id=${ct} OR ${!p.channelId && p.role === "customer" && p.userId ? `${company} OR EXISTS(SELECT 1 FROM ticket_participants access_tp WHERE access_tp.workspace_id=${c}.workspace_id AND access_tp.conversation_id=${c}.id AND access_tp.portal_contact_id=${ct} AND access_tp.active AND ${m}.created_at>=access_tp.joined_at)` : "FALSE"})`;
}

export async function emailCorrespondenceAllowed(
  db: Database,
  ws: string,
  conversationId: string,
  contactId: string,
  channelId: string,
  q: Queryable = db.pool,
) {
  return !!(await db.one(
    `SELECT c.id FROM conversations c JOIN channels ch ON ch.workspace_id=c.workspace_id AND ch.id=c.channel_id JOIN contacts ct ON ct.workspace_id=c.workspace_id AND ct.id=$3 JOIN connections k ON k.workspace_id=c.workspace_id AND k.provider='ticket_email' AND k.status='connected' LEFT JOIN support_email_addresses a ON a.workspace_id=c.workspace_id AND a.id=c.support_address_id AND a.integration_id=k.id WHERE c.workspace_id=$1 AND c.id=$2 AND c.channel_id=$4 AND c.external_id IS NULL AND ch.kind='portal' AND (c.support_address_id IS NULL OR a.id IS NOT NULL) AND ((c.contact_id=$3 AND (c.origin='email' OR (ct.verified AND ch.published))) OR EXISTS(SELECT 1 FROM ticket_participants tp WHERE tp.workspace_id=c.workspace_id AND tp.conversation_id=c.id AND tp.contact_id=$3 AND tp.active))`,
    [ws, conversationId, contactId, channelId],
    q,
  ));
}
