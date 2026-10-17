import {
  snapshotEmailRecipients,
  emailRecipientEligible,
} from "./email-recipients.js";
import { z } from "zod";
import type { PoolClient } from "pg";
import { Database, uid } from "./db.js";
import { type Mailer, type Principal, conversation } from "./auth.js";
import { Connections } from "./connections.js";
import { HttpError, requireValue } from "./config.js";
import { token, tokenHash, equal, seal, unseal } from "./security.js";
import type { Attachments } from "./attachments.js";
import {
  requireCapability,
  hasCapability,
  conversationVisibility,
} from "./permissions.js";
import { EmailIntake, emailAuthority } from "./email-intake.js";

const EmailSetup = z
  .object({
    address: z
      .email()
      .max(254)
      .refine(
        (v) => /^[a-zA-Z0-9._-]{1,20}@/.test(v),
        "Use a mailbox without a plus sign and with at most 20 characters before @",
      ),
  })
  .strict();
// Both staff and AI delivery call this inside the transaction publishing the reply.
export async function queueTicketEmail(
  db: Database,
  q: PoolClient,
  ws: string,
  messageId: string,
) {
  const row = await db.one(
    `INSERT INTO ticket_emails(id,workspace_id,conversation_id,message_id)
    SELECT $1,$2,c.id,m.id FROM messages m JOIN conversations c ON c.id=m.conversation_id JOIN channels ch ON ch.id=c.channel_id
    WHERE m.id=$3 AND m.workspace_id=$2 AND m.role IN ('staff','assistant','reminder','customer','note') AND (m.delivered_at IS NOT NULL OR m.role IN ('customer','note')) AND ch.kind='portal' AND c.external_id IS NULL
    ON CONFLICT(message_id) DO NOTHING RETURNING *`,
    [uid(), ws, messageId],
    q,
  );
  if (row) {
    await snapshotEmailRecipients(db, q, row);
    const audience = await db.one(
      "SELECT 1 FROM ticket_email_deliveries WHERE email_id=$1",
      [row.id],
      q,
    );
    if (audience)
      await db.enqueue(q, "ticket-email", { workspaceId: ws, emailId: row.id });
    else await q.query("DELETE FROM ticket_emails WHERE id=$1", [row.id]);
  }
}
export class TicketEmail {
  intake: EmailIntake;
  beforeSend?: (
    q: PoolClient,
    ws: string,
    messageId: string,
  ) => Promise<boolean>;
  constructor(
    public db: Database,
    private connections: Connections,
    private send: Mailer,
    append: (p: Principal, id: string, input: unknown) => Promise<unknown>,
    private attachments: Attachments,
  ) {
    this.intake = new EmailIntake(db, append, attachments);
  }
  async settings(p: Principal) {
    p = await emailAuthority(this.db, p, "email:manage");
    const connection = await this.db.one(
      "SELECT metadata,status FROM connections WHERE workspace_id=$1 AND provider='ticket_email'",
      [p.workspaceId],
    );
    const params: unknown[] = [p.workspaceId];
    const visible = conversationVisibility(p, "c", params);
    const outbound = await this.db.rows(
      `SELECT e.id,e.conversation_id,e.status,e.error,e.attempts,e.kind,e.created_at,e.sent_at FROM ticket_emails e JOIN conversations c ON c.workspace_id=e.workspace_id AND c.id=e.conversation_id WHERE e.workspace_id=$1 AND (${visible}) ORDER BY e.created_at DESC LIMIT 30`,
      params,
    );
    const inbound = await this.db.rows(
      `SELECT e.id,e.provider_id,e.conversation_id,e.status,e.error,e.attempts,e.created_at,(e.payload_ciphertext IS NOT NULL) replayable FROM email_intake_events e LEFT JOIN conversations c ON c.workspace_id=e.workspace_id AND c.id=e.conversation_id WHERE e.workspace_id=$1 AND ((${visible}) OR (c.id IS NULL AND ${!p.ticketScope || p.ticketScope === "all" ? "TRUE" : "FALSE"})) ORDER BY e.created_at DESC LIMIT 30`,
      params,
    );
    return {
      ...(await this.intake.addresses(p)),
      canRetry: hasCapability(p, "email:retry"),
      configured: connection?.status === "connected",
      address: connection?.metadata.address ?? "",
      smtpConfigured: !!this.db.config.SMTP_URL,
      webhookUrl: `${this.db.config.FIELDKIT_URL}/v2/webhooks/email/${p.workspaceId}`,
      outbound,
      deliveries: await this.db.rows(
        "SELECT id,email_id,recipient,kind,status,attempts,error,sent_at FROM ticket_email_deliveries WHERE workspace_id=$1 AND email_id=ANY($2::text[]) ORDER BY created_at,id",
        [p.workspaceId, outbound.map((r) => r.id)],
      ),
      inbound,
      outboundAttempts: await this.db.rows(
        "SELECT id,email_id,status,error,created_at FROM ticket_email_attempts WHERE workspace_id=$1 AND email_id=ANY($2::text[]) ORDER BY created_at DESC LIMIT 200",
        [p.workspaceId, outbound.map((row) => row.id)],
      ),
      inboundAttempts: await this.db.rows(
        "SELECT id,event_id,status,error,created_at FROM email_intake_attempts WHERE workspace_id=$1 AND event_id=ANY($2::text[]) ORDER BY created_at DESC LIMIT 200",
        [p.workspaceId, inbound.map((row) => row.id)],
      ),
    };
  }

  async configure(p: Principal, raw: unknown) {
    requireCapability(p, "email:manage");
    const { address } = EmailSetup.parse(raw),
      secret = token();
    await this.db.tx(async (q) => {
      p = await emailAuthority(this.db, p, "email:manage", q);
      const used = await this.db.one(
        "SELECT workspace_id FROM support_email_addresses WHERE lower(address)=$1",
        [address.toLowerCase()],
        q,
      );
      if (used && used.workspace_id !== p.workspaceId)
        throw new HttpError(
          409,
          "This support address already has an inbound mapping",
        );
      await this.connections.save(
        p.workspaceId,
        "ticket_email",
        { webhookSecret: secret },
        { address: address.toLowerCase() },
        q,
      );
      // Changing receiver credentials also revokes all previously issued reply capabilities.
      await q.query("DELETE FROM ticket_email_routes WHERE workspace_id=$1", [
        p.workspaceId,
      ]);
      const connection = await this.db.one(
        "SELECT id FROM connections WHERE workspace_id=$1 AND provider='ticket_email'",
        [p.workspaceId],
        q,
      );
      await q.query(
        `INSERT INTO support_email_addresses(id,workspace_id,integration_id,address,reply_address,enabled)
        VALUES($1,$2,$3,$4,$4,true) ON CONFLICT(lower(address)) DO UPDATE SET enabled=true WHERE support_email_addresses.workspace_id=EXCLUDED.workspace_id`,
        [uid(), p.workspaceId, connection!.id, address.toLowerCase()],
      );
      await this.db.event(q, p.workspaceId, "ticket_email.configured");
    });
    return {
      ...(await this.settings(p)),
      username: "fieldkit",
      password: secret,
    };
  }
  async disconnect(p: Principal) {
    requireCapability(p, "email:manage");
    await this.db.tx(async (q) => {
      p = await emailAuthority(this.db, p, "email:manage", q);
      await q.query(
        "UPDATE connections SET status='disconnected',secret='',revision=revision+1 WHERE workspace_id=$1 AND provider='ticket_email'",
        [p.workspaceId],
      );
      await q.query(
        "UPDATE support_email_addresses SET enabled=false WHERE workspace_id=$1",
        [p.workspaceId],
      );
      await q.query("DELETE FROM ticket_email_routes WHERE workspace_id=$1", [
        p.workspaceId,
      ]);
      await this.db.event(q, p.workspaceId, "connection.disconnected", {
        provider: "ticket_email",
      });
    });
  }
  async authenticate(ws: string, authorization: string) {
    const c = await this.db.one(
      "SELECT * FROM connections WHERE workspace_id=$1 AND provider='ticket_email' AND status='connected'",
      [ws],
    );
    const expected = c
      ? `Basic ${Buffer.from(`fieldkit:${this.connections.secret(c).webhookSecret}`).toString("base64")}`
      : "";
    if (!expected || !equal(expected, authorization))
      throw new HttpError(403, "Invalid inbound email credentials");
    return c;
  }
  private async aggregate(q: PoolClient, ws: string, id: string) {
    await q.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      `human-routing:${ws}`,
    ]);
    const rows = await this.db.rows(
      "SELECT status,error,attempts,sent_at,recipient,message_ref FROM ticket_email_deliveries WHERE workspace_id=$1 AND email_id=$2",
      [ws, id],
      q,
    );
    if (!rows.length) {
      const old = await this.db.one(
        "SELECT status,recipients_snapshotted FROM ticket_emails WHERE workspace_id=$1 AND id=$2",
        [ws, id],
        q,
      );
      if (!old?.recipients_snapshotted) return;
    }
    const pending = rows.some((r) =>
      ["queued", "sending", "waiting_files"].includes(r.status),
    );
    const state = rows.some((r) => r.status === "sending")
      ? "sending"
      : pending
        ? rows.some((r) => r.status === "queued")
          ? "queued"
          : "waiting_files"
        : rows.some((r) => r.status === "unknown")
          ? "unknown"
          : rows.some((r) => r.status === "failed")
            ? "failed"
            : rows.some((r) => r.status === "sent")
              ? "sent"
              : "skipped";
    await q.query(
      "UPDATE ticket_emails SET status=$3,error=$4,attempts=$5,sent_at=$6,recipient=$7,message_ref=$8 WHERE workspace_id=$1 AND id=$2",
      [
        ws,
        id,
        state,
        rows.find((r) => r.error)?.error ?? null,
        rows.reduce((n, r) => n + r.attempts, 0),
        state === "sent" ? new Date() : null,
        rows[0]?.recipient ?? null,
        rows[0]?.message_ref ?? null,
      ],
    );
  }
  async deliver(ws: string, id: string) {
    // Lock order shared with merge: routing workspace -> ticket -> envelope -> recipients.
    const ids = await this.db.tx(async (q) => {
      await q.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        `human-routing:${ws}`,
      ]);
      const seed = await this.db.one(
        "SELECT conversation_id FROM ticket_emails WHERE workspace_id=$1 AND id=$2",
        [ws, id],
        q,
      );
      if (!seed) return [];
      await q.query(
        "SELECT id FROM conversations WHERE workspace_id=$1 AND id=$2 FOR UPDATE",
        [ws, seed.conversation_id],
      );
      const e = await this.db.one(
        "SELECT * FROM ticket_emails WHERE workspace_id=$1 AND id=$2 FOR UPDATE",
        [ws, id],
        q,
      );
      if (!e || ["sent", "skipped", "failed", "unknown"].includes(e.status))
        return [];
      if (!e.recipients_snapshotted && e.status === "sending") {
        if (
          e.attempted_at &&
          Date.now() - new Date(e.attempted_at).getTime() < 60000
        )
          return [];
        await q.query(
          "UPDATE ticket_emails SET status='unknown',error='Legacy SMTP attempt interrupted; check provider before retrying' WHERE id=$1",
          [id],
        );
        return [];
      }
      if (!e.recipients_snapshotted)
        await snapshotEmailRecipients(this.db, q, e, true);
      return (
        await this.db.rows(
          "SELECT id FROM ticket_email_deliveries WHERE workspace_id=$1 AND email_id=$2 AND status IN ('queued','sending','waiting_files') ORDER BY id",
          [ws, id],
          q,
        )
      ).map((r) => r.id);
    });
    for (const deliveryId of ids)
      await this.deliverRecipient(ws, id, deliveryId);
    await this.db.tx((q) => this.aggregate(q, ws, id));
  }
  private async deliverRecipient(ws: string, id: string, deliveryId: string) {
    const item = await this.db.tx(async (q) => {
      await q.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        `human-routing:${ws}`,
      ]);
      const seed = await this.db.one(
        "SELECT conversation_id FROM ticket_emails WHERE workspace_id=$1 AND id=$2",
        [ws, id],
        q,
      );
      if (!seed) return null;
      await q.query(
        "SELECT id FROM conversations WHERE workspace_id=$1 AND id=$2 FOR UPDATE",
        [ws, seed.conversation_id],
      );
      const e = await this.db.one(
        "SELECT * FROM ticket_emails WHERE workspace_id=$1 AND id=$2 FOR UPDATE",
        [ws, id],
        q,
      );
      const d = await this.db.one(
        "SELECT * FROM ticket_email_deliveries WHERE workspace_id=$1 AND id=$2 FOR UPDATE",
        [ws, deliveryId],
        q,
      );
      if (
        !e ||
        !d ||
        !["queued", "sending", "waiting_files"].includes(d.status)
      )
        return null;
      if (d.status === "sending") {
        if (Date.now() - new Date(d.attempted_at).getTime() > 60000)
          await q.query(
            "UPDATE ticket_email_deliveries SET status='unknown',error='Worker interrupted during SMTP delivery; check provider before retrying' WHERE id=$1",
            [deliveryId],
          );
        return null;
      }
      const c = await this.db.one(
        `SELECT c.*,m.body,m.role,m.created_at message_created_at,m.delivered_at,ct.email,ct.verified,ch.published,w.slug,w.name workspace_name FROM conversations c JOIN messages m ON m.workspace_id=c.workspace_id AND m.conversation_id=c.id JOIN contacts ct ON ct.workspace_id=c.workspace_id AND ct.id=c.contact_id JOIN channels ch ON ch.id=c.channel_id JOIN workspaces w ON w.id=c.workspace_id WHERE c.workspace_id=$1 AND m.id=$2`,
        [ws, e.message_id],
        q,
      );
      if (
        !c ||
        c.external_id ||
        c.merged_into_id ||
        (!c.published && c.origin !== "email") ||
        (!c.delivered_at &&
          !["customer", "note"].includes(c.role) &&
          e.kind !== "acknowledgement") ||
        !(await emailRecipientEligible(this.db, q, d, c)) ||
        (this.beforeSend &&
          ["staff", "assistant", "reminder"].includes(c.role) &&
          !(await this.beforeSend(q, ws, e.message_id)))
      ) {
        await q.query(
          "UPDATE ticket_email_deliveries SET status='skipped',error='Recipient, channel or message is no longer eligible' WHERE id=$1",
          [deliveryId],
        );
        return null;
      }
      let files;
      try {
        files = await this.attachments.emailFiles(
          ws,
          e.message_id,
          d.files,
          c.role === "note",
          q,
        );
      } catch (err) {
        const waiting =
          err instanceof HttpError &&
          err.status === 425 &&
          Date.now() - new Date(d.created_at).getTime() < 86400000;
        await q.query(
          "UPDATE ticket_email_deliveries SET status=$2,error=$3,attempted_at=now() WHERE id=$1",
          [
            deliveryId,
            waiting ? "waiting_files" : "failed",
            waiting
              ? "Waiting for attachment scanning"
              : "Attachment delivery requires review; no email was sent",
          ],
        );
        await q.query(
          "UPDATE ticket_emails SET attempted_at=now() WHERE id=$1",
          [id],
        );
        return null;
      }
      const k = await this.db.one(
        "SELECT * FROM connections WHERE workspace_id=$1 AND provider='ticket_email' AND status='connected'",
        [ws],
        q,
      );
      const a = c.support_address_id
        ? await this.db.one(
            "SELECT * FROM support_email_addresses WHERE workspace_id=$1 AND id=$2",
            [ws, c.support_address_id],
            q,
          )
        : null;
      let replyTo: string | undefined;
      if (k && d.kind !== "follower") {
        let route = await this.db.one(
          "SELECT * FROM ticket_email_routes WHERE workspace_id=$1 AND conversation_id=$2 AND participant_id IS NOT DISTINCT FROM $3",
          [ws, c.id, d.participant_id],
          q,
        );
        if (!route) {
          const secret = token();
          route = await this.db.one(
            "INSERT INTO ticket_email_routes(id,workspace_id,conversation_id,contact_id,participant_id,token_hash,token_ciphertext) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *",
            [
              uid(),
              ws,
              c.id,
              d.contact_id,
              d.participant_id,
              tokenHash(secret),
              seal(
                this.db.config.FIELDKIT_ENCRYPTION_KEY,
                `ticket:${ws}:${c.id}`,
                secret,
              ),
            ],
            q,
          );
        }
        const secret = unseal<string>(
            this.db.config.FIELDKIT_ENCRYPTION_KEY,
            `ticket:${ws}:${c.id}`,
            route!.token_ciphertext,
          ),
          [local, domain] = (a?.address ?? k.metadata.address).split("@");
        replyTo = `${local}+${secret}@${domain}`;
      }
      const prior = await this.db.one(
        "SELECT message_ref FROM ticket_email_deliveries WHERE workspace_id=$1 AND recipient_key=$2 AND email_id IN (SELECT id FROM ticket_emails WHERE workspace_id=$1 AND conversation_id=$3) AND status='sent' ORDER BY sent_at DESC LIMIT 1",
        [ws, d.recipient_key, c.id],
        q,
      );
      const inbound = await this.db.one(
        "SELECT message_ref FROM email_intake_events WHERE workspace_id=$1 AND conversation_id=$2 AND sender=$3 AND message_ref IS NOT NULL ORDER BY created_at DESC LIMIT 1",
        [ws, c.id, d.recipient],
        q,
      );
      await q.query(
        "UPDATE ticket_email_deliveries SET status='sending',attempted_at=now(),attempts=attempts+1,error=NULL WHERE id=$1",
        [deliveryId],
      );
      await q.query(
        "UPDATE ticket_emails SET status='sending',attempted_at=now() WHERE id=$1",
        [id],
      );
      await q.query(
        "INSERT INTO ticket_email_delivery_attempts(workspace_id,delivery_id,attempt,status) VALUES($1,$2,$3,'sending')",
        [ws, deliveryId, d.attempts + 1],
      );
      await q.query(
        "INSERT INTO ticket_email_attempts(workspace_id,email_id,attempt,status) VALUES($1,$2,$3,'sending')",
        [ws, id, d.attempts + 1],
      );
      return {
        c,
        d,
        files,
        replyTo,
        prior: inbound?.message_ref ?? prior?.message_ref,
        body:
          e.kind === "acknowledgement"
            ? "We received your request. Our support team will review it. Reply to this email to add more information."
            : c.body,
        from: a
          ? `${a.display_name ? a.display_name.replace(/[\r\n<>"]/g, " ") + " " : ""}<${a.reply_address}>`
          : undefined,
      };
    });
    if (!item) return;
    try {
      const { c, d } = item;
      let continuation =
        d.kind === "follower"
          ? `Open the staff inbox to reply: ${this.db.config.FIELDKIT_URL}/?workspace=${encodeURIComponent(ws)}&view=inbox&conversation=${encodeURIComponent(c.id)}`
          : item.replyTo
            ? "Reply to this email to continue. This private reply address belongs only to you."
            : `Incoming email is disconnected; contact the support team through its published address.`;
      if (d.kind === "requester" && c.verified)
        continuation += `\nView your ticket: ${this.db.config.FIELDKIT_URL}/support/${encodeURIComponent(c.slug)}?ticket=${encodeURIComponent(c.id)}`;
      await this.send(
        d.recipient,
        `${c.role === "note" ? "Internal note: " : "Re: "}${c.subject.replace(/[\r\n]/g, " ")}`,
        `${item.body || "Files have been added to your ticket."}\n\n— ${c.workspace_name} support\n${continuation}\nThis is an individual notification. Do not forward its private reply address.`,
        {
          from: item.from,
          messageId: d.message_ref,
          replyTo: item.replyTo,
          inReplyTo: item.prior,
          references: item.prior ? [item.prior] : undefined,
          attachments: item.files,
        },
      );
      await this.db.tx(async (q) => {
        await q.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
          `human-routing:${ws}`,
        ]);
        await q.query(
          "UPDATE ticket_email_deliveries SET status='sent',sent_at=now() WHERE id=$1",
          [d.id],
        );
        await q.query(
          "INSERT INTO ticket_email_delivery_attempts(workspace_id,delivery_id,attempt,status) VALUES($1,$2,$3,'provider_accepted')",
          [ws, d.id, d.attempts + 1],
        );
        await q.query(
          "INSERT INTO ticket_email_attempts(workspace_id,email_id,attempt,status) VALUES($1,$2,$3,'provider_accepted')",
          [ws, id, d.attempts + 1],
        );
      });
    } catch (err) {
      const known = [
          "ECONNREFUSED",
          "ENOTFOUND",
          "EAUTH",
          "EENVELOPE",
        ].includes((err as any).code),
        status = known ? "failed" : "unknown",
        reason = known
          ? "SMTP rejected delivery before accepting it"
          : "SMTP completion uncertain; check provider before retrying";
      await this.db.tx(async (q) => {
        await q.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
          `human-routing:${ws}`,
        ]);
        await q.query(
          "UPDATE ticket_email_deliveries SET status=$2,error=$3 WHERE id=$1",
          [deliveryId, status, reason],
        );
        await q.query(
          "INSERT INTO ticket_email_delivery_attempts(workspace_id,delivery_id,attempt,status,error) VALUES($1,$2,$3,$4,$5)",
          [ws, deliveryId, item.d.attempts + 1, status, reason],
        );
        await q.query(
          "INSERT INTO ticket_email_attempts(workspace_id,email_id,attempt,status,error) VALUES($1,$2,$3,$4,$5)",
          [ws, id, item.d.attempts + 1, status, reason],
        );
        await this.db.event(
          q,
          ws,
          `ticket_email.delivery_${status}`,
          { emailId: id, deliveryId },
          item.c.id,
        );
      });
    }
  }
  async recover() {
    for (const e of await this.db.rows(
      "SELECT id,workspace_id FROM ticket_emails WHERE status IN ('queued','sending','waiting_files') ORDER BY coalesce(attempted_at,created_at),id LIMIT 100",
    ))
      await this.deliver(e.workspace_id, e.id);
  }
  async retry(p: Principal, id: string) {
    requireCapability(p, "email:retry");
    await this.db.tx(async (q) => {
      await q.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        `human-routing:${p.workspaceId}`,
      ]);
      p = await emailAuthority(this.db, p, "email:retry", q);
      const current = requireValue(
        await this.db.one(
          "SELECT conversation_id FROM ticket_emails WHERE workspace_id=$1 AND id=$2",
          [p.workspaceId, id],
          q,
        ),
      );
      await conversation(this.db, p, current.conversation_id, q);
      requireValue(
        await this.db.one(
          "UPDATE ticket_emails SET status='queued',error=NULL WHERE workspace_id=$1 AND id=$2 AND status IN ('unknown','failed') RETURNING id",
          [p.workspaceId, id],
          q,
        ),
        409,
        "This email is not awaiting recovery",
      );
      await q.query(
        "UPDATE ticket_email_deliveries SET status='queued',error=NULL WHERE workspace_id=$1 AND email_id=$2 AND status IN ('failed','unknown')",
        [p.workspaceId, id],
      );
      await this.db.enqueue(q, "ticket-email", {
        workspaceId: p.workspaceId,
        emailId: id,
      });
      await this.db.event(q, p.workspaceId, "ticket_email.retry", {
        emailId: id,
      });
    });
  }
  async receive(ws: string, authorization: string, raw: unknown) {
    const connection = await this.authenticate(ws, authorization);
    return this.intake.accept(ws, connection, raw);
  }
}
