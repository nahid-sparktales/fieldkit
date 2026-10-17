import { uid, type Database, type Queryable } from "./db.js";
import type { PoolClient } from "pg";
import {
  canReadConversation,
  hasCapability,
  resolveStaffPrincipal,
} from "./permissions.js";
import { HttpError } from "./config.js";
/** Persist the audience once, alongside the message. Later additions never receive old mail. */
export async function snapshotEmailRecipients(
  db: Database,
  q: PoolClient,
  email: any,
  legacy = false,
) {
  if (email.recipients_snapshotted) return;
  const c = await db.one(
    `SELECT c.*,m.body,m.role,m.author_id,m.actor_contact_id,m.created_at message_created_at,m.delivered_at,ct.email,ct.verified,ct.user_id requester_user FROM conversations c JOIN messages m ON m.workspace_id=c.workspace_id AND m.conversation_id=c.id JOIN contacts ct ON ct.workspace_id=c.workspace_id AND ct.id=c.contact_id WHERE c.workspace_id=$1 AND m.id=$2`,
    [email.workspace_id, email.message_id],
    q,
  );
  if (!c) return;
  const candidates: any[] = [];
  if (
    c.role !== "note" &&
    c.email &&
    (c.verified || c.origin === "email") &&
    (email.kind === "acknowledgement" ||
      (!(
        c.author_id && [c.contact_id, c.requester_user].includes(c.author_id)
      ) &&
        c.actor_contact_id !== c.contact_id))
  )
    candidates.push({
      key: "requester",
      kind: "requester",
      recipient: c.email,
      contactId: c.contact_id,
    });
  if (!legacy && email.kind !== "acknowledgement") {
    if (c.role !== "note")
      for (const p of await db.rows(
        "SELECT * FROM ticket_participants WHERE workspace_id=$1 AND conversation_id=$2 AND active AND joined_at<=$3",
        [email.workspace_id, c.id, c.message_created_at],
        q,
      )) {
        if (
          (c.actor_contact_id &&
            [p.contact_id, p.portal_contact_id].includes(c.actor_contact_id)) ||
          (c.author_id &&
            [p.contact_id, p.portal_contact_id].includes(c.author_id))
        )
          continue;
        const portal = p.portal_contact_id
          ? await db.one(
              "SELECT user_id FROM contacts WHERE workspace_id=$1 AND id=$2",
              [email.workspace_id, p.portal_contact_id],
              q,
            )
          : null;
        if (portal?.user_id && portal.user_id === c.author_id) continue;
        candidates.push({
          key: `participant:${p.id}`,
          kind: "participant",
          recipient: p.email,
          contactId: p.contact_id,
          participantId: p.id,
        });
      }
    for (const f of await db.rows(
      'SELECT f.*,u.email,u."emailVerified" verified FROM ticket_followers f JOIN "user" u ON u.id=f.user_id WHERE f.workspace_id=$1 AND f.conversation_id=$2 AND f.created_at<=$3',
      [email.workspace_id, c.id, c.message_created_at],
      q,
    )) {
      if (
        f.user_id === c.author_id ||
        !f.verified ||
        !f.email ||
        (c.role === "note" && !f.include_notes)
      )
        continue;
      try {
        const p = await resolveStaffPrincipal(
          db,
          email.workspace_id,
          f.user_id,
          q,
        );
        if (
          !canReadConversation(p, c) ||
          (c.role === "note" && !hasCapability(p, "tickets:note"))
        )
          continue;
      } catch (e) {
        if (e instanceof HttpError) continue;
        throw e;
      }
      candidates.push({
        key: `follower:${f.user_id}`,
        kind: "follower",
        recipient: f.email,
        userId: f.user_id,
      });
    }
  }
  const files = await db.rows(
    "SELECT id,hash,bytes FROM attachments WHERE workspace_id=$1 AND message_id=$2 AND visibility=$3 ORDER BY id",
    [
      email.workspace_id,
      email.message_id,
      c.role === "note" ? "staff" : "customer",
    ],
    q,
  );
  const seen = new Set<string>();
  for (const r of candidates) {
    const normalized = r.recipient.toLowerCase();
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    const id = uid(),
      ref =
        r.kind === "requester"
          ? `<fieldkit-${email.message_id}@${new URL(db.config.FIELDKIT_URL).hostname}>`
          : `<fieldkit-${email.message_id}-${id}@${new URL(db.config.FIELDKIT_URL).hostname}>`;
    await q.query(
      "INSERT INTO ticket_email_deliveries(id,workspace_id,email_id,recipient_key,recipient,kind,contact_id,participant_id,user_id,message_ref,files) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT(email_id,recipient_key) DO NOTHING",
      [
        id,
        email.workspace_id,
        email.id,
        r.key,
        normalized,
        r.kind,
        r.contactId ?? null,
        r.participantId ?? null,
        r.userId ?? null,
        ref,
        JSON.stringify(files),
      ],
    );
  }
  await q.query(
    "UPDATE ticket_emails SET recipients_snapshotted=true WHERE id=$1",
    [email.id],
  );
}
export async function emailRecipientEligible(
  db: Database,
  q: Queryable,
  d: any,
  c: any,
) {
  if (d.kind === "requester")
    return (
      c.role !== "note" &&
      c.contact_id === d.contact_id &&
      (c.verified || c.origin === "email") &&
      c.email?.toLowerCase() === d.recipient
    );
  if (d.kind === "participant")
    return (
      c.role !== "note" &&
      !!(await db.one(
        "SELECT 1 FROM ticket_participants WHERE workspace_id=$1 AND id=$2 AND conversation_id=$3 AND active AND email=$4 AND joined_at<=$5",
        [
          d.workspace_id,
          d.participant_id,
          c.id,
          d.recipient,
          c.message_created_at,
        ],
        q,
      ))
    );
  const f = await db.one(
    'SELECT f.*,u.email,u."emailVerified" verified FROM ticket_followers f JOIN "user" u ON u.id=f.user_id WHERE f.workspace_id=$1 AND f.conversation_id=$2 AND f.user_id=$3',
    [d.workspace_id, c.id, d.user_id],
    q,
  );
  if (
    !f?.verified ||
    f.email?.toLowerCase() !== d.recipient ||
    new Date(f.created_at) > new Date(c.message_created_at) ||
    (c.role === "note" && !f.include_notes)
  )
    return false;
  try {
    const p = await resolveStaffPrincipal(db, d.workspace_id, d.user_id, q);
    return (
      canReadConversation(p, c) &&
      (c.role !== "note" || hasCapability(p, "tickets:note")) &&
      (!d.files?.length || hasCapability(p, "attachments:read"))
    );
  } catch (e) {
    if (e instanceof HttpError) return false;
    throw e;
  }
}
