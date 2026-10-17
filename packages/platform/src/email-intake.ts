import { canonicalTicket } from "./ticket-canonical.js";
import { customerTicketAccess } from "./customer-access.js";
import { z } from "zod";
import { load } from "cheerio";
import type { PoolClient } from "pg";
import { Database, uid } from "./db.js";
import { type Principal, conversation } from "./auth.js";
import {
  requireCapability,
  refreshPrincipal,
  type Capability,
} from "./permissions.js";
import { decodeEmailAttachment, type Attachments } from "./attachments.js";
import { HttpError, requireValue } from "./config.js";
import { digest, seal, unseal, tokenHash } from "./security.js";

// Hold the actor membership while changing email configuration/recovery. Role
// updates also update this row, so a revocation cannot commit midway through it.
export async function emailAuthority(
  db: Database,
  p: Principal,
  capability: Capability,
  q?: PoolClient,
) {
  requireCapability(p, capability);
  if (q)
    await q.query(
      "SELECT user_id FROM memberships WHERE workspace_id=$1 AND user_id=$2 FOR SHARE",
      [p.workspaceId, p.userId],
    );
  const current = await refreshPrincipal(db, p, q);
  requireCapability(current, capability);
  return current;
}

const mailbox = z
  .email()
  .max(254)
  .transform((v) => v.toLowerCase());
const headerText = z
  .string()
  .max(200)
  .refine(
    (v) => !/[\r\n\x00-\x1f]/.test(v),
    "Use a single line without control characters",
  );
export const SupportAddressInput = z
  .object({
    address: mailbox.refine(
      (v) => /^[a-z0-9._-]{1,20}@/.test(v),
      "Use 1–20 mailbox characters without a plus sign",
    ),
    displayName: headerText.default(""),
    replyAddress: mailbox,
    defaultTeamId: z.string().max(100).nullable().default(null),
    acknowledge: z.boolean().default(false),
    workflowEnabled: z.boolean().default(false),
    enabled: z.boolean().default(true),
  })
  .strict();
const IncomingEmail = z.object({
  MessageID: z.string().min(1).max(200).optional(),
  OriginalRecipient: z.email().max(254),
  FromFull: z.object({ Email: mailbox, Name: z.string().max(200).optional() }),
  ToFull: z
    .array(z.object({ Email: mailbox }))
    .max(100)
    .default([]),
  CcFull: z
    .array(z.object({ Email: mailbox }))
    .max(100)
    .default([]),
  Subject: z.string().max(1000).default(""),
  TextBody: z.string().max(100000).default(""),
  HtmlBody: z.string().max(100000).default(""),
  StrippedTextReply: z.string().max(12000).optional(),
  Headers: z
    .array(z.object({ Name: z.string().max(100), Value: z.string().max(8000) }))
    .max(200)
    .default([]),
  Attachments: z.array(z.unknown()).max(100).default([]),
});
type Envelope = z.infer<typeof IncomingEmail>;
const header = (d: Envelope, name: string) =>
  d.Headers.filter((h) => h.Name.toLowerCase() === name)
    .map((h) => h.Value)
    .join(" ");
const refs = (value: string) =>
  (value.match(/<[^<>\s\x00-\x1f]{1,240}>/g) ?? []).slice(-50);
/** Inbound intake controls from the 2026-10-17 audit (S1, S9); the per-workspace minute limit predates it. */
export const INTAKE_LIMITS = {
  workspacePerMinute: 120,
  senderPerMinute: 20,
  recipientPerMinute: 60,
  quarantineRetentionDays: 7,
  acknowledgementsPerSenderPerDay: 5,
} as const;
/** Retained encrypted source per workspace shares the operator's storage budget, so quarantined floods are bounded like files. */
export const retainedSourceLimit = (config: {
  FIELDKIT_ATTACHMENT_STORAGE_BYTES: number;
}) => config.FIELDKIT_ATTACHMENT_STORAGE_BYTES;
const firstHeader = (d: Pick<Envelope, "Headers">, name: string) =>
  d.Headers.find((h) => h.Name.toLowerCase() === name)?.Value ?? "";
const domainOf = (identity: string) =>
  identity
    .trim()
    .replace(/^<|>$/g, "")
    .split("@")
    .pop()!
    .toLowerCase()
    .replace(/[;,)\]>]+$/, "");
const aligned = (domain: string, from: string) =>
  !!domain &&
  !!from &&
  (domain === from ||
    from.endsWith(`.${domain}`) ||
    domain.endsWith(`.${from}`));
/**
 * Did the receiving MTA authenticate the message under the From domain? Only the
 * first occurrence of each header counts: Postmark writes its own results ahead of
 * the message's headers, so a sender cannot override them with a forged copy.
 * This gates acknowledgements and reply tokens (audit S9); it never grants identity.
 */
export function senderAuthentication(
  d: Pick<Envelope, "Headers" | "FromFull">,
) {
  const from = d.FromFull.Email.split("@")[1]?.toLowerCase() ?? "";
  let spf = false,
    dkim = false;
  const received = firstHeader(d, "received-spf");
  if (/^\s*pass\b/i.test(received)) {
    const envelope = /envelope-from=([^;\s]+)/i.exec(received)?.[1];
    spf = !envelope || aligned(domainOf(envelope), from);
  }
  for (const clause of firstHeader(d, "authentication-results").split(";")) {
    if (/\bspf=pass\b/i.test(clause)) {
      const mailfrom = /smtp\.mailfrom=([^\s;]+)/i.exec(clause)?.[1];
      spf ||= !mailfrom || aligned(domainOf(mailfrom), from);
    }
    if (/\bdkim=pass\b/i.test(clause)) {
      const signer =
        /header\.d=([^\s;]+)/i.exec(clause)?.[1] ??
        /header\.i=([^\s;]+)/i.exec(clause)?.[1];
      dkim ||= !!signer && aligned(domainOf(signer), from);
    }
  }
  // Postmark's SpamAssassin summary: a valid signature from the author's domain.
  if (/\bDKIM_VALID_AU\b/.test(firstHeader(d, "x-spam-tests"))) dkim = true;
  return { spf, dkim, authenticated: spf || dkim };
}
export function emailText(
  d: Pick<Envelope, "TextBody" | "HtmlBody" | "StrippedTextReply">,
) {
  if (d.StrippedTextReply?.trim()) return d.StrippedTextReply.trim();
  if (d.TextBody.trim()) return d.TextBody.trim();
  const $ = load(d.HtmlBody);
  $("script,style,iframe,object,svg,head").remove();
  $("br").replaceWith("\n");
  $("p,div,li,tr,h1,h2,h3").append("\n");
  return $.root()
    .text()
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
const publicAddress = (row: any) => ({
  id: row.id,
  address: row.address,
  displayName: row.display_name,
  replyAddress: row.reply_address,
  defaultTeamId: row.default_team_id,
  acknowledge: row.acknowledge,
  workflowEnabled: row.workflow_enabled,
  enabled: row.enabled,
  integrationId: row.integration_id,
});
export class EmailIntake {
  onCreate?: (
    q: PoolClient,
    conversation: any,
    customer: Principal,
  ) => Promise<void>;
  constructor(
    public db: Database,
    private append: (p: Principal, id: string, input: unknown) => Promise<any>,
    private attachments: Attachments,
  ) {}
  async addresses(p: Principal) {
    p = await emailAuthority(this.db, p, "email:manage");
    return {
      addresses: (
        await this.db.rows(
          "SELECT * FROM support_email_addresses WHERE workspace_id=$1 ORDER BY created_at,id",
          [p.workspaceId],
        )
      ).map(publicAddress),
      teams: await this.db.rows(
        "SELECT id,name FROM teams WHERE workspace_id=$1 AND active ORDER BY name",
        [p.workspaceId],
      ),
    };
  }
  async saveAddress(p: Principal, raw: unknown, id?: string) {
    requireCapability(p, "email:manage");
    const d = SupportAddressInput.parse(raw);
    return this.db.tx(async (q) => {
      p = await emailAuthority(this.db, p, "email:manage", q);
      const connection = requireValue(
        await this.db.one(
          "SELECT id FROM connections WHERE workspace_id=$1 AND provider='ticket_email' AND status='connected'",
          [p.workspaceId],
          q,
        ),
        409,
        "Connect the Postmark webhook first",
      );
      if (d.defaultTeamId)
        requireValue(
          await this.db.one(
            "SELECT id FROM teams WHERE workspace_id=$1 AND id=$2 AND active",
            [p.workspaceId, d.defaultTeamId],
            q,
          ),
          400,
          "Choose an active team in this workspace",
        );
      const duplicate = await this.db.one(
        "SELECT id,workspace_id FROM support_email_addresses WHERE lower(address)=$1",
        [d.address],
        q,
      );
      if (
        duplicate &&
        (duplicate.workspace_id !== p.workspaceId || duplicate.id !== id)
      )
        throw new HttpError(
          409,
          "This support address already has an inbound mapping",
        );
      if (id) {
        const previous = requireValue(
          await this.db.one(
            "SELECT address FROM support_email_addresses WHERE workspace_id=$1 AND id=$2 FOR UPDATE",
            [p.workspaceId, id],
            q,
          ),
          404,
          "Support address not found",
        );
        if (
          previous.address !== d.address &&
          (await this.db.one(
            "SELECT 1 FROM conversations WHERE workspace_id=$1 AND support_address_id=$2 LIMIT 1",
            [p.workspaceId, id],
            q,
          ))
        )
          throw new HttpError(
            409,
            "This address has ticket history. Add a new address and disable new intake on the old one to preserve existing reply links",
          );
      }
      const row = await this.db.one(
        `INSERT INTO support_email_addresses(id,workspace_id,integration_id,address,display_name,reply_address,default_team_id,acknowledge,workflow_enabled,enabled)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(id) DO UPDATE SET address=$4,display_name=$5,reply_address=$6,default_team_id=$7,acknowledge=$8,workflow_enabled=$9,enabled=$10,updated_at=now() RETURNING *`,
        [
          id ?? uid(),
          p.workspaceId,
          connection.id,
          d.address,
          d.displayName,
          d.replyAddress,
          d.defaultTeamId,
          d.acknowledge,
          d.workflowEnabled,
          d.enabled,
        ],
        q,
      );
      await this.db.event(q, p.workspaceId, "email.address_updated", {
        addressId: row!.id,
        enabled: d.enabled,
        actorId: p.userId,
      });
      return publicAddress(row);
    });
  }
  async accept(ws: string, connection: any, raw: unknown) {
    const d = IncomingEmail.parse(raw);
    if (
      Buffer.byteLength(JSON.stringify(d)) >
      Math.ceil((this.db.config.FIELDKIT_ATTACHMENT_MESSAGE_BYTES * 4) / 3) +
        256 * 1024
    )
      throw new HttpError(413, "Email envelope is too large");
    const messageRef = refs(header(d, "message-id"))[0] ?? null;
    const providerId =
      d.MessageID ??
      (messageRef
        ? `rfc:${digest([messageRef, d.OriginalRecipient, d.FromFull.Email])}`
        : null);
    if (!providerId)
      throw new HttpError(
        400,
        "A stable provider or Message-ID identifier is required",
      );
    const id = uid(),
      hash = digest(d);
    // Attachment bodies never reach the database (audit S1): decode once, hand the
    // bytes to the inline attempt below and seal only name, type, length and digest.
    const files = d.Attachments.map((file) =>
      decodeEmailAttachment(file, this.db.config.FIELDKIT_ATTACHMENT_BYTES),
    );
    const sealed = seal(
      this.db.config.FIELDKIT_ENCRYPTION_KEY,
      `email-intake:${ws}:${id}`,
      { ...d, Attachments: files.map((f) => f.meta) },
    );
    const payloadBytes = Buffer.byteLength(sealed),
      retainedLimit = retainedSourceLimit(this.db.config);
    const [recipientLocal, recipientDomain] =
        d.OriginalRecipient.toLowerCase().split("@"),
      recipient = `${recipientLocal.split("+")[0]}@${recipientDomain}`;
    const event = await this.db.tx(async (q) => {
      await q.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        `email-rate:${ws}`,
      ]);
      const existing = await this.db.one(
        "SELECT * FROM email_intake_events WHERE workspace_id=$1 AND integration_id=$2 AND provider_id=$3",
        [ws, connection.id, providerId],
        q,
      );
      if (existing) {
        // Schema 20–23 did not parse CcFull. Match that exact historical shape
        // without changing the stored receipt/source: a retry must never add
        // newly supplied CC suggestions to an envelope accepted before upgrade.
        const { CcFull: _cc, ...beforeCollaboration } = d;
        if (
          existing.payload_hash !== hash &&
          existing.payload_hash !== digest(beforeCollaboration)
        )
          throw new HttpError(
            409,
            "Inbound message identity reused with changed content",
          );
        return existing;
      }
      // Preserve receipts from the pre-intake implementation across upgrades.
      const legacy = await this.db.one(
        "SELECT status,payload_hash FROM inbound_ticket_emails WHERE workspace_id=$1 AND provider_id=$2",
        [ws, providerId],
        q,
      );
      if (legacy) {
        const oldPayload = {
          MessageID: d.MessageID,
          OriginalRecipient: d.OriginalRecipient,
          FromFull: { Email: d.FromFull.Email },
          TextBody: d.TextBody,
          ...(d.StrippedTextReply === undefined
            ? {}
            : { StrippedTextReply: d.StrippedTextReply }),
          Headers: d.Headers,
          Attachments: d.Attachments,
        };
        if (legacy.payload_hash && legacy.payload_hash !== digest(oldPayload))
          throw new HttpError(
            409,
            "Inbound message identity reused with changed content",
          );
        return { id: null, status: legacy.status };
      }
      const rate = await this.db.one(
        "SELECT count(*)::int n FROM email_intake_events WHERE workspace_id=$1 AND created_at>now()-interval '1 minute'",
        [ws],
        q,
      );
      if (rate!.n >= INTAKE_LIMITS.workspacePerMinute)
        throw new HttpError(429, "Inbound email rate limit reached");
      const retained = Number(
        (await this.db.one(
          "SELECT coalesce(sum(payload_bytes),0) n FROM email_intake_events WHERE workspace_id=$1 AND payload_ciphertext IS NOT NULL",
          [ws],
          q,
        ))!.n,
      );
      if (retained + payloadBytes > retainedLimit)
        return { id: null, capacity: retained };
      await this.throttle(
        q,
        `email-sender:${ws}:${d.FromFull.Email}`,
        INTAKE_LIMITS.senderPerMinute,
        "Inbound email rate limit reached for this sender",
      );
      await this.throttle(
        q,
        `email-recipient:${ws}:${recipient}`,
        INTAKE_LIMITS.recipientPerMinute,
        "Inbound email rate limit reached for this support address",
      );
      // Availability is deferred so neither the worker nor a duplicate webhook
      // delivery can claim the envelope before the inline attempt that holds the
      // decoded attachment bytes; the minute sweep requeues it if this process dies.
      const row = await this.db.one(
        `INSERT INTO email_intake_events(id,workspace_id,integration_id,provider_id,payload_hash,payload_ciphertext,payload_bytes,sender,subject,message_ref,reply_ref,references_list,available_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,now()+interval '2 minutes') RETURNING *`,
        [
          id,
          ws,
          connection.id,
          providerId,
          hash,
          sealed,
          payloadBytes,
          d.FromFull.Email,
          d.Subject.replace(/[\r\n\x00-\x1f]/g, " ").slice(0, 160),
          messageRef,
          refs(header(d, "in-reply-to"))[0] ?? null,
          JSON.stringify(refs(header(d, "references"))),
        ],
        q,
      );
      return row!;
    });
    if (event.capacity !== undefined) {
      await this.capacityNotice(
        ws,
        event.capacity,
        payloadBytes,
        retainedLimit,
      );
      throw new HttpError(
        429,
        "Retained inbound email source has reached the workspace limit; the provider will retry later",
      );
    }
    if (!event.id) return { accepted: true, status: event.status };
    if (event.status === "queued")
      await this.process(ws, event.id, { bodies: files.map((f) => f.bytes) });
    const current = await this.db.one(
      "SELECT status FROM email_intake_events WHERE workspace_id=$1 AND id=$2",
      [ws, event.id],
    );
    return {
      accepted: true,
      status:
        current?.status === "received"
          ? "received"
          : current?.status === "quarantined"
            ? "rejected"
            : "queued",
    };
  }
  private async resolve(ws: string, event: any, d: Envelope) {
    const [local, domain] = d.OriginalRecipient.split("@");
    const plus = local.indexOf("+");
    const base =
      `${plus < 0 ? local : local.slice(0, plus)}@${domain}`.toLowerCase();
    const address = await this.db.one(
      "SELECT * FROM support_email_addresses WHERE workspace_id=$1 AND integration_id=$2 AND address=$3",
      [ws, event.integration_id, base],
    );
    const connection = await this.db.one(
      "SELECT * FROM connections WHERE workspace_id=$1 AND id=$2 AND provider='ticket_email' AND status='connected'",
      [ws, event.integration_id],
    );
    if (!connection)
      return { reason: "The inbound integration has been disconnected" };
    const legacy = connection.metadata.address?.toLowerCase() === base;
    if (!address && !legacy)
      return { reason: "No configured recipient mapping" };
    // Envelope recipient is authoritative. Header aliases only detect ambiguity, never choose a workspace or participants.
    const aliases = await this.db.rows(
      "SELECT DISTINCT workspace_id FROM support_email_addresses WHERE address=ANY($1::text[])",
      [
        [...d.ToFull, ...d.CcFull].map((r) =>
          r.Email.split("+")[0] === r.Email
            ? r.Email
            : r.Email.replace(/\+[^@]+/, ""),
        ),
      ],
    );
    if (aliases.some((a) => a.workspace_id !== ws))
      return { reason: "Ambiguous cross-workspace recipients" };
    if (
      /^(mailer-daemon|postmaster)@/i.test(d.FromFull.Email) ||
      d.FromFull.Email === base ||
      d.FromFull.Email === address?.reply_address ||
      (header(d, "auto-submitted") &&
        header(d, "auto-submitted").toLowerCase() !== "no") ||
      /bulk|list|junk/i.test(header(d, "precedence")) ||
      header(d, "list-id") ||
      /multipart\/report|delivery-status/i.test(header(d, "content-type"))
    )
      return {
        reason:
          "Automatic, mailing-list, delivery-report or self-generated email quarantined to prevent loops",
      };
    if (/\byes\b/i.test(header(d, "x-spam-status").split(",")[0]))
      return { reason: "Inbound provider spam marker requires review" };
    const body = emailText(d);
    if ((!body && !d.Attachments.length) || body.length > 12000)
      return {
        reason:
          "Message is empty or exceeds 12,000 characters; source retained for review",
      };
    if (plus >= 0) {
      const secret = local.slice(plus + 1);
      const route = await this.db.one(
        `SELECT r.*,ct.email,ct.verified,c.support_address_id,c.origin,ch.published,c.external_id FROM ticket_email_routes r JOIN conversations c ON c.workspace_id=r.workspace_id AND c.id=r.conversation_id JOIN contacts ct ON ct.workspace_id=r.workspace_id AND ct.id=r.contact_id JOIN channels ch ON ch.id=c.channel_id LEFT JOIN ticket_participants tp ON tp.workspace_id=r.workspace_id AND tp.id=r.participant_id WHERE r.workspace_id=$1 AND r.token_hash=$2 AND ((r.participant_id IS NULL AND r.contact_id=c.contact_id) OR (tp.active AND tp.contact_id=r.contact_id AND tp.conversation_id=r.conversation_id AND tp.email=ct.email))`,
        [ws, tokenHash(secret)],
      );
      if (!route)
        return {
          reason:
            "Reply address expired or invalid; use the support address for a new request",
        };
      if (route.email?.toLowerCase() !== d.FromFull.Email)
        return { reason: "Sender does not match the conversation participant" };
      if (
        route.external_id ||
        (!route.participant_id &&
          !route.verified &&
          route.origin !== "email") ||
        (!route.participant_id && !route.published && route.origin !== "email")
      )
        return { reason: "Customer or channel no longer eligible" };
      if (route.support_address_id && route.support_address_id !== address?.id)
        return {
          reason: "Reply token does not belong to this support address",
        };
      const canonical = await canonicalTicket(
        this.db,
        ws,
        route.conversation_id,
      );
      if (
        !(
          await customerTicketAccess(
            this.db,
            {
              workspaceId: ws,
              role: "customer",
              contactId: route.contact_id,
              emailIntake: true,
            },
            canonical,
          )
        ).reply
      )
        return { reason: "Participant access was revoked" };
      const references = [event.reply_ref, ...event.references_list].filter(
        Boolean,
      );
      if (references.length) {
        const other = await this.db.rows(
          `SELECT conversation_id FROM email_intake_events WHERE workspace_id=$1 AND message_ref=ANY($2::text[]) AND conversation_id IS NOT NULL AND conversation_id<>$3 UNION ALL SELECT conversation_id FROM ticket_emails WHERE workspace_id=$1 AND message_ref=ANY($2::text[]) AND conversation_id<>$3 UNION ALL SELECT e.conversation_id FROM ticket_email_deliveries d JOIN ticket_emails e ON e.id=d.email_id WHERE d.workspace_id=$1 AND d.message_ref=ANY($2::text[]) AND e.conversation_id<>$3`,
          [ws, references, route.conversation_id],
        );
        for (const reference of other)
          if (
            (await canonicalTicket(this.db, ws, reference.conversation_id))
              .id !== canonical.id
          )
            return { reason: "References conflict with the reply address" };
      }
      return {
        address,
        route: {
          ...route,
          source_conversation_id: route.conversation_id,
          conversation_id: canonical.id,
        },
        body,
      };
    }
    if (event.reply_ref || event.references_list.length)
      return {
        reason:
          "Reply has no private reply address; reference headers alone do not authorize ticket access",
      };
    if (!address?.enabled)
      return { reason: "New email tickets are disabled for this recipient" };
    return { address, body };
  }
  /**
   * `inline` is the accept() attempt that still holds the decoded attachment
   * bytes; it may claim the envelope before its deferred availability. Any later
   * attempt stages only files already stored under their deterministic keys.
   */
  async process(
    ws: string,
    id: string,
    inline?: { bodies: (Buffer | undefined)[] },
  ) {
    const lease = uid();
    const event = await this.db.one(
      `UPDATE email_intake_events SET status='processing',attempts=attempts+1,lease_token=$3,lease_until=now()+interval '5 minutes',updated_at=now()
      WHERE workspace_id=$1 AND id=$2 AND attempts<5 AND ((status IN ('queued','retrying') AND (available_at<=now() OR $4::boolean)) OR (status='processing' AND lease_until<now())) RETURNING *`,
      [ws, id, lease, !!inline],
    );
    if (!event) return;
    try {
      const d = IncomingEmail.parse(
        unseal<unknown>(
          this.db.config.FIELDKIT_ENCRYPTION_KEY,
          `email-intake:${ws}:${id}`,
          event.payload_ciphertext,
        ),
      );
      const auth = senderAuthentication(d);
      const decision = await this.resolve(ws, event, d);
      if (decision.reason) {
        await this.finish(event, lease, "quarantined", decision.reason);
        return;
      }
      let conv: any;
      if (decision.route)
        conv = await this.db.one(
          "SELECT * FROM conversations WHERE workspace_id=$1 AND id=$2",
          [ws, decision.route.conversation_id],
        );
      else
        conv = await this.db.tx(async (q) => {
          const current = requireValue(
            await this.db.one(
              "SELECT * FROM email_intake_events WHERE workspace_id=$1 AND id=$2 FOR UPDATE",
              [ws, id],
              q,
            ),
          );
          if (current.conversation_id)
            return requireValue(
              await this.db.one(
                "SELECT * FROM conversations WHERE workspace_id=$1 AND id=$2",
                [ws, current.conversation_id],
                q,
              ),
            );
          const address = requireValue(
            await this.db.one(
              "SELECT * FROM support_email_addresses WHERE workspace_id=$1 AND id=$2 AND enabled FOR SHARE",
              [ws, decision.address.id],
              q,
            ),
            409,
            "Recipient was disabled during intake",
          );
          const contact = await this.db.one(
            `INSERT INTO contacts(id,workspace_id,external_id,name,email,verified) VALUES($1,$2,$3,$4,$5,false)
          ON CONFLICT(workspace_id,external_id) DO UPDATE SET external_id=excluded.external_id RETURNING *`,
            [
              uid(),
              ws,
              `email:${d.FromFull.Email}`,
              d.FromFull.Name?.replace(/[\x00-\x1f]/g, " ").slice(0, 200) ??
                d.FromFull.Email,
              d.FromFull.Email,
            ],
            q,
          );
          const channel = requireValue(
            await this.db.one(
              "SELECT id FROM channels WHERE workspace_id=$1 AND kind='portal'",
              [ws],
              q,
            ),
            409,
            "Support ticket channel is unavailable",
          );
          const created = await this.db.one(
            `INSERT INTO conversations(id,workspace_id,contact_id,channel_id,subject,mode,origin,support_address_id,team_id) VALUES($1,$2,$3,$4,$5,$6,'email',$7,$8) RETURNING *`,
            [
              uid(),
              ws,
              contact!.id,
              channel.id,
              event.subject.trim() || "Email support request",
              address.workflow_enabled ? "agent" : "human",
              address.id,
              address.default_team_id,
            ],
            q,
          );
          await this.onCreate?.(q, created, {
            workspaceId: ws,
            role: "customer",
            contactId: contact!.id,
          });
          await q.query(
            "UPDATE email_intake_events SET conversation_id=$3,address_id=$4 WHERE workspace_id=$1 AND id=$2",
            [ws, id, created!.id, address.id],
          );
          return created;
        });
      const customer: Principal = {
        workspaceId: ws,
        role: "customer",
        contactId: decision.route?.contact_id ?? conv.contact_id,
        emailIntake: true,
      };
      const participant = await this.db.one(
        "SELECT email FROM contacts WHERE workspace_id=$1 AND id=$2",
        [ws, customer.contactId],
      );
      if (participant?.email?.toLowerCase() !== d.FromFull.Email) {
        await this.finish(
          event,
          lease,
          "quarantined",
          "Participant contact information changed; review the customer identity",
        );
        return;
      }
      if (decision.route)
        await this.db.pool.query(
          "UPDATE email_intake_events SET conversation_id=$3,address_id=$4 WHERE workspace_id=$1 AND id=$2 AND lease_token=$5",
          [ws, id, conv.id, decision.address?.id ?? null, lease],
        );
      const attachmentIds = await this.attachments.stageEmail(
        customer,
        conv.id,
        `${event.integration_id}:${event.provider_id}`,
        d.Attachments,
        inline?.bodies,
      );
      // Revalidate the recipient/token and sender after file staging; a disable/rotation cannot race into an append.
      const recheck = await this.resolve(ws, event, d);
      if (recheck.reason) {
        await this.finish(event, lease, "quarantined", recheck.reason);
        return;
      }
      const message = await this.append(
        customer,
        decision.route?.source_conversation_id ?? conv.id,
        {
          body: decision.body,
          requestKey: `email:${digest([event.integration_id, event.provider_id])}`,
          attachments: attachmentIds,
        },
      );
      await this.db.tx(async (q) => {
        const stripped = seal(
          this.db.config.FIELDKIT_ENCRYPTION_KEY,
          `email-intake:${ws}:${id}`,
          { ...d, Attachments: [], Headers: [], ToFull: [], CcFull: [] },
        );
        const current = await this.db.one(
          "UPDATE email_intake_events SET status='received',error=NULL,conversation_id=$3,message_id=$4,address_id=$5,lease_until=NULL,lease_token=NULL,updated_at=now(),payload_ciphertext=$7,payload_bytes=$8,sender_authenticated=$9 WHERE workspace_id=$1 AND id=$2 AND lease_token=$6 RETURNING id",
          [
            ws,
            id,
            message.conversation_id ?? conv.id,
            message.id,
            decision.address?.id ?? null,
            lease,
            stripped,
            Buffer.byteLength(stripped),
            auth.authenticated,
          ],
          q,
        );
        if (!current) return;
        for (const cc of d.CcFull.slice(0, 20)) {
          if (
            cc.Email === d.FromFull.Email ||
            cc.Email === decision.address?.address ||
            cc.Email === decision.address?.reply_address
          )
            continue;
          await q.query(
            `INSERT INTO email_cc_suggestions(workspace_id,conversation_id,email) SELECT $1,$2,$3 WHERE NOT EXISTS(SELECT 1 FROM support_email_addresses WHERE address=$3 OR reply_address=$3) AND NOT EXISTS(SELECT 1 FROM ticket_participants WHERE workspace_id=$1 AND conversation_id=$2 AND email=$3 AND active) ON CONFLICT DO NOTHING`,
            [ws, conv.id, cc.Email],
          );
        }
        await q.query(
          "INSERT INTO email_intake_attempts(workspace_id,event_id,attempt,status) VALUES($1,$2,$3,'received')",
          [ws, id, event.attempts],
        );
        await q.query(
          "INSERT INTO inbound_ticket_emails(workspace_id,provider_id,conversation_id,status,payload_hash) VALUES($1,$2,$3,'received',$4) ON CONFLICT DO NOTHING",
          [
            ws,
            event.provider_id,
            message.conversation_id ?? conv.id,
            event.payload_hash,
          ],
        );
        let acknowledgement = "not_configured";
        if (!decision.route) {
          await this.db.event(
            q,
            ws,
            "conversation.created",
            {
              origin: "email",
              senderVerified: false,
              senderAuthenticated: auth.authenticated,
              addressId: decision.address.id,
            },
            conv.id,
            true,
          );
          if (decision.address.acknowledge) {
            // Audit S9: an acknowledgement (and the private reply token it carries)
            // goes only to a sender whose mail authenticated under its From domain,
            // and only a few times per sender and day.
            acknowledgement = !auth.authenticated
              ? "skipped_unauthenticated"
              : (await this.acknowledgementsToday(
                    ws,
                    customer.contactId!,
                    q,
                  )) >= INTAKE_LIMITS.acknowledgementsPerSenderPerDay
                ? "skipped_sender_cap"
                : "queued";
            if (acknowledgement === "queued") {
              const email = await this.db.one(
                "INSERT INTO ticket_emails(id,workspace_id,conversation_id,message_id,kind) VALUES($1,$2,$3,$4,'acknowledgement') ON CONFLICT(message_id) DO NOTHING RETURNING id",
                [uid(), ws, conv.id, message.id],
                q,
              );
              if (email)
                await this.db.enqueue(q, "ticket-email", {
                  workspaceId: ws,
                  emailId: email.id,
                });
              else acknowledgement = "duplicate";
            }
          }
        }
        await this.db.event(
          q,
          ws,
          "ticket_email.inbound_received",
          {
            intakeId: id,
            origin: "email",
            senderVerified: false,
            senderAuthenticated: auth.authenticated,
            spf: auth.spf,
            dkim: auth.dkim,
            acknowledgement,
          },
          conv.id,
        );
      });
    } catch (e) {
      const error =
        e instanceof HttpError
          ? e.message
          : "Email processing failed; retry after checking attachment storage and worker health";
      await this.finish(
        event,
        lease,
        event.attempts >= 5 ? "failed" : "retrying",
        error,
      );
    }
  }
  private async finish(
    event: any,
    lease: string,
    status: string,
    error: string,
  ) {
    await this.db.tx(async (q) => {
      const row = await this.db.one(
        "UPDATE email_intake_events SET status=$4,error=$5,lease_token=NULL,lease_until=NULL,available_at=now()+($6::int*interval '1 second'),updated_at=now() WHERE workspace_id=$1 AND id=$2 AND lease_token=$3 RETURNING id",
        [
          event.workspace_id,
          event.id,
          lease,
          status,
          error,
          Math.min(300, 5 * 2 ** (event.attempts - 1)),
        ],
        q,
      );
      if (!row) return;
      await q.query(
        "INSERT INTO email_intake_attempts(workspace_id,event_id,attempt,status,error) VALUES($1,$2,$3,$4,$5)",
        [event.workspace_id, event.id, event.attempts, status, error],
      );
      await this.db.event(
        q,
        event.workspace_id,
        `ticket_email.inbound_${status}`,
        { intakeId: event.id, reason: error },
        event.conversation_id ?? undefined,
      );
    });
  }
  /** Fixed-window counter shared with the API's `rate_limits` table; rolled back with a rejected envelope. */
  private async throttle(
    q: PoolClient,
    key: string,
    max: number,
    message: string,
  ) {
    const row = await this.db.one(
      `INSERT INTO rate_limits(key,count,expires_at) VALUES($1,1,now()+interval '1 minute') ON CONFLICT(key) DO UPDATE SET count=CASE WHEN rate_limits.expires_at<now() THEN 1 ELSE rate_limits.count+1 END, expires_at=CASE WHEN rate_limits.expires_at<now() THEN now()+interval '1 minute' ELSE rate_limits.expires_at END RETURNING count`,
      [key],
      q,
    );
    if (row!.count > max) throw new HttpError(429, message);
  }
  /** One operator-visible event per workspace and hour while retained source is at capacity. */
  private async capacityNotice(
    ws: string,
    retained: number,
    rejected: number,
    limit: number,
  ) {
    const row = await this.db.one(
      `INSERT INTO rate_limits(key,count,expires_at) VALUES($1,1,now()+interval '1 hour') ON CONFLICT(key) DO UPDATE SET count=CASE WHEN rate_limits.expires_at<now() THEN 1 ELSE rate_limits.count+1 END, expires_at=CASE WHEN rate_limits.expires_at<now() THEN now()+interval '1 hour' ELSE rate_limits.expires_at END RETURNING count`,
      [`email-capacity-notice:${ws}`],
    );
    if (row!.count === 1)
      await this.db.event(this.db.pool, ws, "ticket_email.intake_capacity", {
        retainedBytes: retained,
        rejectedBytes: rejected,
        limitBytes: limit,
      });
  }
  private async acknowledgementsToday(
    ws: string,
    contactId: string,
    q: PoolClient,
  ) {
    return Number(
      (await this.db.one(
        "SELECT count(*)::int n FROM ticket_emails e JOIN conversations c ON c.workspace_id=e.workspace_id AND c.id=e.conversation_id WHERE e.workspace_id=$1 AND e.kind='acknowledgement' AND c.contact_id=$2 AND e.created_at>now()-interval '24 hours'",
        [ws, contactId],
        q,
      ))!.n,
    );
  }
  async retry(p: Principal, id: string) {
    requireCapability(p, "email:retry");
    await this.db.tx(async (q) => {
      p = await emailAuthority(this.db, p, "email:retry", q);
      const event = requireValue(
        await this.db.one(
          "SELECT conversation_id FROM email_intake_events WHERE workspace_id=$1 AND id=$2",
          [p.workspaceId, id],
          q,
        ),
      );
      if (event.conversation_id)
        await conversation(this.db, p, event.conversation_id, q);
      else if (p.ticketScope && p.ticketScope !== "all")
        throw new HttpError(
          403,
          "Workspace-wide intake visibility is required",
        );
      const row = requireValue(
        await this.db.one(
          "UPDATE email_intake_events SET status='queued',attempts=0,error=NULL,available_at=now(),lease_until=NULL,lease_token=NULL WHERE workspace_id=$1 AND id=$2 AND status IN ('failed','retrying','quarantined') AND payload_ciphertext IS NOT NULL RETURNING id",
          [p.workspaceId, id],
          q,
        ),
        409,
        "This email has no retained source available for rechecking",
      );
      await this.db.enqueue(q, "email-intake", {
        workspaceId: p.workspaceId,
        eventId: row.id,
      });
      await this.db.event(q, p.workspaceId, "ticket_email.intake_retry", {
        intakeId: id,
        actorId: p.userId,
      });
    });
  }
  async source(p: Principal, id: string) {
    p = await emailAuthority(this.db, p, "email:manage");
    const row = requireValue(
      await this.db.one(
        "SELECT conversation_id,payload_ciphertext,sender_authenticated FROM email_intake_events WHERE workspace_id=$1 AND id=$2",
        [p.workspaceId, id],
      ),
    );
    if (row.conversation_id)
      await conversation(this.db, p, row.conversation_id);
    else if (p.ticketScope && p.ticketScope !== "all")
      throw new HttpError(403, "Workspace-wide intake visibility is required");
    requireValue(
      row.payload_ciphertext,
      410,
      "Original source has expired under workspace retention",
    );
    const d = unseal<Envelope>(
      this.db.config.FIELDKIT_ENCRYPTION_KEY,
      `email-intake:${p.workspaceId}:${id}`,
      row.payload_ciphertext,
    );
    return {
      text: emailText({ ...d, StrippedTextReply: undefined }),
      strippedReplyUsed: !!d.StrippedTextReply?.trim(),
      senderVerified: false,
      senderAuthenticated: !!row.sender_authenticated,
    };
  }
  async recover() {
    await this.db.tx(async (q) => {
      const rows = await this.db.rows(
        "SELECT workspace_id,id FROM email_intake_events WHERE attempts<5 AND ((status IN ('queued','retrying') AND available_at<=now()) OR (status='processing' AND lease_until<now())) ORDER BY available_at LIMIT 100 FOR UPDATE SKIP LOCKED",
        [],
        q,
      );
      for (const row of rows)
        await this.db.enqueue(q, "email-intake", {
          workspaceId: row.workspace_id,
          eventId: row.id,
        });
    });
    await this.db.pool.query(
      "UPDATE email_intake_events SET status='failed',error='Processing interrupted at the retry limit; manual review required',lease_token=NULL,lease_until=NULL WHERE status='processing' AND attempts>=5 AND lease_until<now()",
    );
    // Quarantined and failed envelopes came from senders nobody admitted: their
    // source expires on a fixed window regardless of workspace retention (audit S1).
    await this.db.pool.query(
      "UPDATE email_intake_events SET payload_ciphertext=NULL,payload_bytes=0 WHERE payload_ciphertext IS NOT NULL AND status IN ('quarantined','failed') AND created_at<now()-($1::int*interval '1 day')",
      [INTAKE_LIMITS.quarantineRetentionDays],
    );
    // Full text retained for quote review follows workspace retention, which also
    // clears sender and subject metadata of envelopes whose source already expired.
    await this.db.pool.query(
      "UPDATE email_intake_events e SET payload_ciphertext=NULL,payload_bytes=0,sender='',subject='' WHERE (payload_ciphertext IS NOT NULL OR sender<>'' OR subject<>'') AND created_at<now()-(coalesce((SELECT (settings->>'retentionDays')::int FROM workspaces w WHERE w.id=e.workspace_id),90)*interval '1 day')",
    );
  }
}
