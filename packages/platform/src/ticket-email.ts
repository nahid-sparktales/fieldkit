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
    SELECT $1,$2,c.id,m.id FROM messages m JOIN conversations c ON c.id=m.conversation_id
    JOIN channels ch ON ch.id=c.channel_id JOIN contacts ct ON ct.id=c.contact_id
    WHERE m.id=$3 AND m.workspace_id=$2 AND m.role IN ('staff','assistant','reminder') AND m.delivered_at IS NOT NULL
    AND ch.kind='portal' AND c.external_id IS NULL AND (ct.verified OR c.origin='email') AND ct.email IS NOT NULL
    ON CONFLICT(message_id) DO NOTHING RETURNING id`,
    [uid(), ws, messageId],
    q,
  );
  if (row)
    await db.enqueue(q, "ticket-email", { workspaceId: ws, emailId: row.id });
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
    attachments: Attachments,
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
  async deliver(ws: string, id: string) {
    // A worker retry after an interrupted SMTP attempt must not duplicate an uncertain send.
    const item = await this.db.tx(async (q) => {
      const email = await this.db.one(
        "SELECT * FROM ticket_emails WHERE workspace_id=$1 AND id=$2 FOR UPDATE",
        [ws, id],
        q,
      );
      if (
        !email ||
        ["sent", "failed", "unknown", "skipped"].includes(email.status)
      )
        return null;
      if (email.status === "sending") {
        if (
          email.attempted_at &&
          Date.now() - new Date(email.attempted_at).getTime() < 60000
        )
          return null;
        await q.query(
          "UPDATE ticket_emails SET status='unknown',error='Worker stopped during SMTP delivery. Check the mail provider before retrying.' WHERE id=$1",
          [id],
        );
        return null;
      }
      const data = await this.db.one(
        `SELECT c.id,c.subject,c.contact_id,w.slug,w.name,m.body,ct.email,ct.verified,ch.published,c.origin,c.support_address_id
        FROM conversations c JOIN messages m ON m.conversation_id=c.id JOIN workspaces w ON w.id=c.workspace_id
        JOIN contacts ct ON ct.id=c.contact_id JOIN channels ch ON ch.id=c.channel_id
        WHERE c.workspace_id=$1 AND m.id=$2 AND c.external_id IS NULL AND ch.kind='portal' AND (m.delivered_at IS NOT NULL OR $3='acknowledgement')`,
        [ws, email.message_id, email.kind],
        q,
      );
      if (
        (!data?.verified && data?.origin !== "email") ||
        !data?.email ||
        (!data.published && data.origin !== "email") ||
        (this.beforeSend && !(await this.beforeSend(q, ws, email.message_id)))
      ) {
        await q.query(
          "UPDATE ticket_emails SET status='skipped',error='Customer or channel is no longer eligible for email' WHERE id=$1",
          [id],
        );
        return null;
      }
      const connection = await this.db.one(
        "SELECT * FROM connections WHERE workspace_id=$1 AND provider='ticket_email' AND status='connected'",
        [ws],
        q,
      );
      const address = data.support_address_id
        ? await this.db.one(
            "SELECT * FROM support_email_addresses WHERE workspace_id=$1 AND id=$2",
            [ws, data.support_address_id],
            q,
          )
        : null;
      let replyTo: string | undefined;
      if (connection) {
        let route = await this.db.one(
          "SELECT * FROM ticket_email_routes WHERE conversation_id=$1",
          [data.id],
          q,
        );
        if (!route) {
          const secret = token();
          route = await this.db.one(
            `INSERT INTO ticket_email_routes(workspace_id,conversation_id,contact_id,token_hash,token_ciphertext)
            VALUES($1,$2,$3,$4,$5) ON CONFLICT(conversation_id) DO UPDATE SET conversation_id=excluded.conversation_id RETURNING *`,
            [
              ws,
              data.id,
              data.contact_id,
              tokenHash(secret),
              seal(
                this.db.config.FIELDKIT_ENCRYPTION_KEY,
                `ticket:${ws}:${data.id}`,
                secret,
              ),
            ],
            q,
          );
        }
        const secret = unseal<string>(
          this.db.config.FIELDKIT_ENCRYPTION_KEY,
          `ticket:${ws}:${data.id}`,
          route!.token_ciphertext,
        );
        const [local, domain] = (
          address?.address ?? connection.metadata.address
        ).split("@");
        replyTo = `${local}+${secret}@${domain}`;
      }
      const ref = `<fieldkit-${email.message_id}@${new URL(this.db.config.FIELDKIT_URL).hostname}>`;
      const previous = await this.db.one(
        "SELECT message_ref FROM ticket_emails WHERE conversation_id=$1 AND status='sent' ORDER BY sent_at DESC LIMIT 1",
        [data.id],
        q,
      );
      await q.query(
        "UPDATE ticket_emails SET status='sending',attempted_at=now(),attempts=attempts+1,recipient=$2,message_ref=$3,error=NULL WHERE id=$1",
        [id, data.email, ref],
      );
      const inbound = await this.db.one(
        "SELECT message_ref FROM email_intake_events WHERE workspace_id=$1 AND conversation_id=$2 AND message_ref IS NOT NULL ORDER BY created_at DESC LIMIT 1",
        [ws, data.id],
        q,
      );
      await q.query(
        "INSERT INTO ticket_email_attempts(workspace_id,email_id,attempt,status) VALUES($1,$2,$3,'sending')",
        [ws, id, email.attempts + 1],
      );
      return {
        ...data,
        body:
          email.kind === "acknowledgement"
            ? "We received your request. Our support team will review it. Reply to this email to add more information."
            : data.body,
        replyTo,
        ref,
        previous: inbound?.message_ref ?? previous?.message_ref,
        from: address
          ? `${address.display_name ? `${address.display_name.replace(/[\r\n<>\"]/g, " ")} ` : ""}<${address.reply_address}>`
          : undefined,
        attempt: email.attempts + 1,
      };
    });
    if (!item) return;
    try {
      const link = `${this.db.config.FIELDKIT_URL}/support/${encodeURIComponent(item.slug)}?ticket=${encodeURIComponent(item.id)}`;
      const continuation =
        item.origin === "email" && !item.verified
          ? `${item.replyTo ? "Reply to this email to continue." : "Incoming email is disconnected. Contact the support team through its published support address."}\nFiles remain available to the support team after scanning. This email does not grant portal account access.`
          : `${item.replyTo ? "Reply to this email or view your ticket:" : "To reply, open your ticket:"}\n${link}\nFiles are available through the authenticated portal.`;
      await this.send(
        item.email,
        `Re: ${item.subject.replace(/[\r\n]/g, " ")}`,
        `${item.body || "The support team added files to your ticket. Reply to discuss how to access them securely."}\n\n— ${item.name} support\n${continuation}\n\nTicket ${item.id.slice(0, 8)}. Incoming files, when enabled, are scanned before access. Please do not forward this email; its reply address is private.`,
        {
          from: item.from,
          messageId: item.ref,
          replyTo: item.replyTo,
          inReplyTo: item.previous,
          references: item.previous ? [item.previous] : undefined,
        },
      );
      await this.db.tx(async (q) => {
        await q.query(
          "UPDATE ticket_emails SET status='sent',sent_at=now() WHERE workspace_id=$1 AND id=$2",
          [ws, id],
        );
        await q.query(
          "INSERT INTO ticket_email_attempts(workspace_id,email_id,attempt,status) VALUES($1,$2,$3,'provider_accepted')",
          [ws, id, item.attempt],
        );
      });
    } catch (error) {
      const knownFailure = [
        "ECONNREFUSED",
        "ENOTFOUND",
        "EAUTH",
        "EENVELOPE",
      ].includes((error as { code?: string }).code ?? "");
      const status = knownFailure ? "failed" : "unknown";
      const reason = knownFailure
        ? "SMTP rejected the connection, authentication or recipient before accepting the message. Check the transport configuration before retrying."
        : "SMTP did not confirm completion. Check delivery before retrying to avoid a duplicate.";
      await this.db.pool.query(
        "INSERT INTO ticket_email_attempts(workspace_id,email_id,attempt,status,error) VALUES($1,$2,$3,$4,$5)",
        [ws, id, item.attempt, status, reason],
      );
      await this.db.pool.query(
        "UPDATE ticket_emails SET status=$2,error=$3,last_error_at=now() WHERE id=$1",
        [id, status, reason],
      );
      await this.db.event(
        this.db.pool,
        ws,
        `ticket_email.delivery_${status}`,
        { emailId: id },
        item.id,
      );
    }
  }
  async retry(p: Principal, id: string) {
    requireCapability(p, "email:retry");
    await this.db.tx(async (q) => {
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
