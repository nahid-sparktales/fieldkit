import { z } from "zod";
import type { PoolClient } from "pg";
import { Database, uid } from "./db.js";
import { type Mailer, type Principal, requireAdmin } from "./auth.js";
import { Connections } from "./connections.js";
import { HttpError, requireValue } from "./config.js";
import { token, tokenHash, equal, seal, unseal, digest } from "./security.js";
import type { Attachments } from "./attachments.js";

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
const Incoming = z.object({
  MessageID: z.string().min(1).max(200),
  OriginalRecipient: z.email(),
  FromFull: z.object({ Email: z.email() }),
  TextBody: z.string().max(100000).default(""),
  StrippedTextReply: z.string().max(12000).optional(),
  Headers: z
    .array(z.object({ Name: z.string(), Value: z.string() }))
    .max(200)
    .default([]),
  Attachments: z.array(z.unknown()).max(100).default([]),
});

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
    AND ch.kind='portal' AND c.external_id IS NULL AND ct.verified AND ct.email IS NOT NULL
    ON CONFLICT(message_id) DO NOTHING RETURNING id`,
    [uid(), ws, messageId],
    q,
  );
  if (row)
    await db.enqueue(q, "ticket-email", { workspaceId: ws, emailId: row.id });
}
export class TicketEmail {
  beforeSend?: (
    q: PoolClient,
    ws: string,
    messageId: string,
  ) => Promise<boolean>;
  constructor(
    public db: Database,
    private connections: Connections,
    private send: Mailer,
    private append: (
      p: Principal,
      id: string,
      input: unknown,
    ) => Promise<unknown>,
    private attachments: Attachments,
  ) {}
  async settings(p: Principal) {
    requireAdmin(p);
    const connection = await this.db.one(
      "SELECT metadata,status FROM connections WHERE workspace_id=$1 AND provider='ticket_email'",
      [p.workspaceId],
    );
    return {
      configured: connection?.status === "connected",
      address: connection?.metadata.address ?? "",
      smtpConfigured: !!this.db.config.SMTP_URL,
      webhookUrl: `${this.db.config.FIELDKIT_URL}/v2/webhooks/email/${p.workspaceId}`,
      outbound: await this.db.rows(
        "SELECT id,conversation_id,status,error,created_at,sent_at FROM ticket_emails WHERE workspace_id=$1 ORDER BY created_at DESC LIMIT 30",
        [p.workspaceId],
      ),
      inbound: await this.db.rows(
        "SELECT provider_id,conversation_id,status,error,created_at FROM inbound_ticket_emails WHERE workspace_id=$1 ORDER BY created_at DESC LIMIT 30",
        [p.workspaceId],
      ),
    };
  }
  async configure(p: Principal, raw: unknown) {
    requireAdmin(p);
    const { address } = EmailSetup.parse(raw),
      secret = token();
    await this.db.tx(async (q) => {
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
      await this.db.event(q, p.workspaceId, "ticket_email.configured");
    });
    return {
      ...(await this.settings(p)),
      username: "fieldkit",
      password: secret,
    };
  }
  async disconnect(p: Principal) {
    requireAdmin(p);
    await this.connections.disconnect(p.workspaceId, "ticket_email");
    await this.db.pool.query(
      "DELETE FROM ticket_email_routes WHERE workspace_id=$1",
      [p.workspaceId],
    );
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
        `SELECT c.id,c.subject,c.contact_id,w.slug,w.name,m.body,ct.email,ct.verified,ch.published
        FROM conversations c JOIN messages m ON m.conversation_id=c.id JOIN workspaces w ON w.id=c.workspace_id
        JOIN contacts ct ON ct.id=c.contact_id JOIN channels ch ON ch.id=c.channel_id
        WHERE c.workspace_id=$1 AND m.id=$2 AND c.external_id IS NULL AND ch.kind='portal' AND m.delivered_at IS NOT NULL`,
        [ws, email.message_id],
        q,
      );
      if (
        !data?.verified ||
        !data.email ||
        !data.published ||
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
        const [local, domain] = connection.metadata.address.split("@");
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
      return { ...data, replyTo, ref, previous: previous?.message_ref };
    });
    if (!item) return;
    try {
      const link = `${this.db.config.FIELDKIT_URL}/support/${encodeURIComponent(item.slug)}?ticket=${encodeURIComponent(item.id)}`;
      await this.send(
        item.email,
        `Re: ${item.subject.replace(/[\r\n]/g, " ")}`,
        `${item.body || "The support team sent files. Open your ticket to view their status and download them after scanning."}\n\n— ${item.name} support\n${item.replyTo ? "Reply to this email or view your ticket:" : "To reply, open your ticket:"}\n${link}\n\nTicket ${item.id.slice(0, 8)}. Files are available through the authenticated portal. Incoming files, when enabled, are scanned before access. Please do not forward this email; its reply address is private.`,
        {
          messageId: item.ref,
          replyTo: item.replyTo,
          inReplyTo: item.previous,
          references: item.previous ? [item.previous] : undefined,
        },
      );
      await this.db.pool.query(
        "UPDATE ticket_emails SET status='sent',sent_at=now() WHERE id=$1",
        [id],
      );
    } catch {
      await this.db.pool.query(
        "UPDATE ticket_emails SET status='unknown',error='SMTP did not confirm completion. Check delivery before retrying to avoid a duplicate.' WHERE id=$1",
        [id],
      );
      await this.db.event(
        this.db.pool,
        ws,
        "ticket_email.delivery_unknown",
        { emailId: id },
        item.id,
      );
    }
  }
  async retry(p: Principal, id: string) {
    requireAdmin(p);
    await this.db.tx(async (q) => {
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
    const connection = await this.authenticate(ws, authorization),
      data = Incoming.parse(raw);
    const [recipientLocal, recipientDomain] = data.OriginalRecipient.split("@"),
      [base, domain] = connection.metadata.address.split("@");
    const secret = recipientLocal.startsWith(`${base}+`)
      ? recipientLocal.slice(base.length + 1)
      : "";
    if (recipientDomain.toLowerCase() !== domain || !secret)
      throw new HttpError(403, "Unknown reply address");
    const route = requireValue(
      await this.db.one(
        `SELECT r.*,ct.email,ct.verified,ch.published,c.external_id FROM ticket_email_routes r
      JOIN conversations c ON c.id=r.conversation_id JOIN contacts ct ON ct.id=c.contact_id JOIN channels ch ON ch.id=c.channel_id
      WHERE r.workspace_id=$1 AND r.token_hash=$2 AND r.contact_id=c.contact_id`,
        [ws, tokenHash(secret)],
      ),
      403,
      "Reply address expired. Reply through the portal.",
    );
    const prior = await this.db.one(
      "SELECT status,payload_hash FROM inbound_ticket_emails WHERE workspace_id=$1 AND provider_id=$2",
      [ws, data.MessageID],
    );
    if (prior) {
      if (prior.payload_hash && prior.payload_hash !== digest(data))
        throw new HttpError(
          409,
          "Inbound message identity reused with changed content",
        );
      return { status: prior.status };
    }
    const header = (name: string) =>
      data.Headers.filter((h) => h.Name.toLowerCase() === name)
        .map((h) => h.Value)
        .join(" ");
    const body = (data.StrippedTextReply || data.TextBody).trim();
    const reason =
      !route.verified || !route.published || route.external_id
        ? "Customer or channel no longer eligible"
        : route.email?.toLowerCase() !== data.FromFull.Email.toLowerCase()
          ? "Sender does not match the verified customer"
          : /yes/i.test(header("x-spam-status").split(",")[0])
            ? "Inbound provider marked this message as spam"
            : (header("auto-submitted") &&
                  header("auto-submitted").toLowerCase() !== "no") ||
                /bulk|list|junk/i.test(header("precedence"))
              ? "Automatic email ignored to prevent reply loops"
              : (!body && !data.Attachments.length) || body.length > 12000
                ? "Reply is empty or too long; use the portal"
                : "";
    if (!reason) {
      // The unguessable address is an email-delivered capability, additionally bound to the verified sender.
      // A deterministic request key also covers a crash after message commit but before receipt commit.
      const customer: Principal = {
        workspaceId: ws,
        contactId: route.contact_id,
        role: "customer",
      };
      const attachments = await this.attachments.stageEmail(
        customer,
        route.conversation_id,
        data.MessageID,
        data.Attachments,
      );
      const current = await this.db.one(
        "SELECT ct.verified,ct.email,ch.published,c.external_id FROM conversations c JOIN contacts ct ON ct.id=c.contact_id JOIN channels ch ON ch.id=c.channel_id WHERE c.workspace_id=$1 AND c.id=$2 AND c.contact_id=$3",
        [ws, route.conversation_id, route.contact_id],
      );
      if (
        !current?.verified ||
        !current.published ||
        current.external_id ||
        current.email?.toLowerCase() !== data.FromFull.Email.toLowerCase()
      )
        throw new HttpError(
          403,
          "Reply authority changed while attachments were staged",
        );
      await this.append(customer, route.conversation_id, {
        body,
        requestKey: `email:${digest(data.MessageID)}`,
        attachments,
      });
    }
    const status = reason ? "rejected" : "received";
    await this.db.pool.query(
      "INSERT INTO inbound_ticket_emails(workspace_id,provider_id,conversation_id,status,error,payload_hash) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING",
      [
        ws,
        data.MessageID,
        route.conversation_id,
        status,
        reason || null,
        digest(data),
      ],
    );
    await this.db.event(
      this.db.pool,
      ws,
      `ticket_email.inbound_${status}`,
      { reason: reason || undefined },
      route.conversation_id,
    );
    return { status };
  }
}
