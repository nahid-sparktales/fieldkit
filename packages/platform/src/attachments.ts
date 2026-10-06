import { refreshPrincipal, resolveStaffPrincipal, requireCapability, hasCapability, canReadConversation } from "./permissions.js";
import { createHash } from "node:crypto";
import { mkdir, open, readFile, unlink, readdir, stat } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import sharp from "sharp";
import type { PoolClient } from "pg";
import { type Database, uid, type Queryable } from "./db.js";
import {
  type Principal,
  conversation,
  requireAdmin,
  requireOwner,
  staff,
} from "./auth.js";
import { HttpError, requireValue } from "./config.js";
import { digest } from "./security.js";
import { AttachmentInput, AttachmentSettings } from "./attachment-contracts.js";
import { ClamScanner, type AttachmentScanner } from "./attachment-scanner.js";

const terminal = ["blocked", "canceled", "deleted"];
export const attachmentName = (name: string) =>
  basename(name.replaceAll("\\", "/"))
    .normalize("NFC")
    .replace(/[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/g, "")
    .slice(-160) || "attachment";
const allowed = new Map([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".pdf", "application/pdf"],
  [".txt", "text/plain"],
  [".log", "text/plain"],
]);
const identity = (p: Principal) => {
  const id = staff(p) ? p.userId : p.contactId;
  if (
    !id ||
    !["owner", "admin", "agent", "customer", "visitor"].includes(p.role)
  )
    throw new HttpError(403, "Conversation access is required for attachments");
  return `${staff(p) ? "staff" : "contact"}:${id}`;
};
export class Attachments {
  scanner: AttachmentScanner;
  readonly directory: string;
  constructor(
    private db: Database,
    scanner?: AttachmentScanner,
  ) {
    this.scanner = scanner ?? new ClamScanner(db.config);
    this.directory = join(db.config.FIELDKIT_DATA, "attachments");
  }
  limits(p?: Principal) {
    const c = this.db.config,
      anonymous = p?.role === "visitor";
    return {
      fileBytes: anonymous
        ? Math.min(2 * 1024 * 1024, c.FIELDKIT_ATTACHMENT_BYTES)
        : c.FIELDKIT_ATTACHMENT_BYTES,
      messageBytes: anonymous
        ? Math.min(4 * 1024 * 1024, c.FIELDKIT_ATTACHMENT_MESSAGE_BYTES)
        : c.FIELDKIT_ATTACHMENT_MESSAGE_BYTES,
      count: anonymous
        ? Math.min(2, c.FIELDKIT_ATTACHMENT_COUNT)
        : c.FIELDKIT_ATTACHMENT_COUNT,
      storageBytes: c.FIELDKIT_ATTACHMENT_STORAGE_BYTES,
      orphanHours: 24,
      previewBytes: 65536,
    };
  }
  async settings(p: Principal, raw?: unknown) {
    identity(p);
    if (raw !== undefined) requireOwner(p);
    if (staff(p)) p = await refreshPrincipal(this.db,p);
    if (raw !== undefined) {
      requireCapability(p,"settings:manage");
      requireOwner(p);
      const d = AttachmentSettings.parse(raw);
      if (d.enabled) await this.scanner.health();
      await this.db.tx(async (q) => {
        await q.query("SELECT id FROM workspaces WHERE id=$1 FOR UPDATE", [
          p.workspaceId,
        ]);
        await q.query(
          "INSERT INTO attachment_settings(workspace_id,enabled,anonymous,updated_by) VALUES($1,$2,$3,$4) ON CONFLICT(workspace_id) DO UPDATE SET enabled=$2,anonymous=$3,revision=attachment_settings.revision+1,updated_by=$4",
          [p.workspaceId, d.enabled, d.anonymous, p.userId],
        );
        await this.db.event(q, p.workspaceId, "attachments.settings_updated", {
          ...d,
          actor: p.userId,
        });
      });
    }
    const settings = (await this.db.one(
      "SELECT enabled,anonymous,revision FROM attachment_settings WHERE workspace_id=$1",
      [p.workspaceId],
    )) ?? { enabled: false, anonymous: false, revision: 0 };
    return {
      ...settings,
      allowed: settings.enabled && (p.role !== "visitor" || settings.anonymous) && (!staff(p) || hasCapability(p,"attachments:upload")),
      limits: this.limits(p),
      aiEligible: false,
    };
  }
  private path(key: string, preview = false) {
    if (!/^[0-9a-f-]{36}$/.test(key))
      throw new Error("Invalid generated storage key");
    return join(this.directory, key + (preview ? ".preview" : ".bin"));
  }
  private async access(p: Principal, row: any, q?: Queryable) {
    identity(p);
    if (staff(p)) {
      p = await refreshPrincipal(this.db,p,q);
      if (row.visibility === "staff" && !hasCapability(p,"tickets:note")) throw new HttpError(404,"Attachment not found");
    }
    const emailStaging =
      p.emailIntake &&
      p.role === "customer" &&
      row.uploader_role === "email" &&
      row.contact_id === p.contactId &&
      !!(await this.db.one(
        "SELECT c.id FROM conversations c JOIN support_email_addresses a ON a.workspace_id=c.workspace_id AND a.id=c.support_address_id JOIN connections k ON k.id=a.integration_id AND k.workspace_id=c.workspace_id AND k.status='connected' WHERE c.workspace_id=$1 AND c.id=$2 AND c.contact_id=$3 AND c.channel_id=$4 AND c.origin='email'",
        [p.workspaceId, row.conversation_id, p.contactId, row.channel_id],
        q,
      ));
    if (
      staff(p) &&
      !(await this.db.one(
        "SELECT 1 FROM memberships WHERE workspace_id=$1 AND user_id=$2",
        [p.workspaceId, p.userId],
        q,
      ))
    )
      throw new HttpError(403, "Staff access was revoked");
    if (
      !staff(p) &&
      !emailStaging &&
      !(await this.db.one(
        "SELECT 1 FROM contacts WHERE workspace_id=$1 AND id=$2 AND ($3 OR verified)",
        [p.workspaceId, p.contactId, p.role === "visitor"],
        q,
      ))
    )
      throw new HttpError(403, "Customer access was revoked");
    if (
      p.channelId &&
      !(await this.db.one(
        "SELECT 1 FROM channels WHERE workspace_id=$1 AND id=$2 AND published",
        [p.workspaceId, p.channelId],
        q,
      ))
    )
      throw new HttpError(403, "Channel access was revoked");
    if (row.workspace_id !== p.workspaceId || row.status === "deleted")
      throw new HttpError(404, "Attachment not found");
    if (row.message_id) {
      const conv = await conversation(this.db, p, row.conversation_id, q);
      if (!staff(p)) {
        if (row.visibility !== "customer")
          throw new HttpError(404, "Attachment not found");
        const message = await this.db.one(
          "SELECT role,delivered_at FROM messages WHERE workspace_id=$1 AND id=$2",
          [p.workspaceId, row.message_id],
          q,
        );
        if (
          !message ||
          !["customer", "staff", "assistant"].includes(message.role) ||
          (message.role !== "customer" && !message.delivered_at)
        )
          throw new HttpError(404, "Attachment not found");
        if (conv.contact_id !== p.contactId)
          throw new HttpError(404, "Attachment not found");
      }
    } else {
      if (row.uploader !== identity(p))
        throw new HttpError(404, "Attachment not found");
      if (row.conversation_id)
        await conversation(this.db, p, row.conversation_id, q);
      else await this.channel(p, row.channel_id, q);
    }
  }
  private async channel(
    p: Principal,
    id: string,
    q?: Queryable,
    conversationId?: string,
  ) {
    const channel = requireValue(
      await this.db.one(
        "SELECT * FROM channels WHERE workspace_id=$1 AND id=$2",
        [p.workspaceId, id],
        q,
      ),
    );
    const emailAdmission =
      p.emailIntake &&
      p.role === "customer" &&
      conversationId &&
      !!(await this.db.one(
        "SELECT c.id FROM conversations c JOIN support_email_addresses a ON a.workspace_id=c.workspace_id AND a.id=c.support_address_id JOIN connections k ON k.id=a.integration_id AND k.workspace_id=c.workspace_id AND k.status='connected' WHERE c.workspace_id=$1 AND c.id=$2 AND c.contact_id=$3 AND c.channel_id=$4 AND c.origin='email'",
        [p.workspaceId, conversationId, p.contactId, id],
        q,
      ));
    if (
      !staff(p) &&
      !emailAdmission &&
      (!channel.published ||
        (p.channelId && p.channelId !== id) ||
        (channel.kind === "portal" &&
          (p.role !== "customer" || channel.settings.ticketsEnabled === false)))
    )
      throw new HttpError(
        403,
        "This support channel does not allow this upload",
      );
    if (channel.kind === "zendesk" || channel.settings.handoff === "zendesk")
      throw new HttpError(
        409,
        "File forwarding to Zendesk is not supported. Submit files through your Zendesk support channel.",
      );
    return channel;
  }
  private publicRow(row: any) {
    return {
      id: row.id,
      conversationId: row.conversation_id,
      messageId: row.message_id,
      name: row.display_name,
      mime: row.mime,
      bytes: Number(row.bytes),
      status: row.status,
      visibility: row.visibility,
      aiEligible: false,
      error: row.error,
      scan: row.scan,
      createdAt: row.created_at,
    };
  }
  async get(p: Principal, id: string) {
    if (staff(p)) { p = await refreshPrincipal(this.db,p); requireCapability(p,"attachments:read"); }
    const row = requireValue(
      await this.db.one(
        "SELECT * FROM attachments WHERE workspace_id=$1 AND id=$2",
        [p.workspaceId, id],
      ),
    );
    await this.access(p, row);
    return this.publicRow(row);
  }
  async list(p: Principal, id: string, q?: Queryable) {
    if (staff(p)) { p = await refreshPrincipal(this.db,p); requireCapability(p,"attachments:read"); }
    await conversation(this.db, p, id, q);
    return (
      await this.db.rows(
        "SELECT a.* FROM attachments a JOIN messages m ON m.id=a.message_id WHERE a.workspace_id=$1 AND a.conversation_id=$2 AND a.status<>'deleted' AND ($3 OR (a.visibility='customer' AND m.role IN ('customer','staff','assistant') AND (m.role='customer' OR m.delivered_at IS NOT NULL))) AND (a.visibility<>'staff' OR $4) ORDER BY a.created_at,a.id",
        [p.workspaceId, id, staff(p),hasCapability(p,"tickets:note")],
        q,
      )
    ).map((r) => this.publicRow(r));
  }
  async reserve(p: Principal, raw: unknown) {
    if (staff(p)) { p = await refreshPrincipal(this.db,p); requireCapability(p,"attachments:upload"); }
    const d = AttachmentInput.parse(raw),
      who = identity(p),
      limits = this.limits(p),
      name = attachmentName(d.name);
    if (d.private && staff(p)) requireCapability(p,"tickets:note");
    if (d.private && !staff(p))
      throw new HttpError(403, "Private files are restricted to staff");
    if (p.role === "visitor" && !d.conversationId)
      throw new HttpError(403, "Start a conversation before uploading a file");
    if (!allowed.has(extname(name).toLowerCase()))
      throw new HttpError(415, "Use PNG, JPEG, PDF, TXT or LOG files");
    if (d.size > limits.fileBytes)
      throw new HttpError(
        413,
        `File exceeds the ${limits.fileBytes} byte limit`,
      );
    return this.db.tx(async (q) => {
      await q.query("SELECT id FROM workspaces WHERE id=$1 FOR UPDATE", [
        p.workspaceId,
      ]);
      const settings = await this.db.one(
        "SELECT * FROM attachment_settings WHERE workspace_id=$1",
        [p.workspaceId],
        q,
      );
      if (!settings?.enabled || (p.role === "visitor" && !settings.anonymous))
        throw new HttpError(
          403,
          "Attachments are not enabled for this conversation",
        );
      const conv = d.conversationId
        ? await conversation(this.db, p, d.conversationId, q)
        : null;
      if (conv?.external_id)
        throw new HttpError(
          409,
          "Zendesk binary attachment forwarding is not supported",
        );
      const channel = await this.channel(
        p,
        conv?.channel_id ?? d.channelId!,
        q,
        conv?.id,
      );
      const prior = await this.db.one(
        "SELECT * FROM attachments WHERE workspace_id=$1 AND uploader=$2 AND request_key=$3",
        [p.workspaceId, who, d.requestKey],
        q,
      );
      if (prior) {
        if (prior.request_hash !== digest(d))
          throw new HttpError(
            409,
            "Upload request identity belongs to another file",
          );
        await this.access(p, prior, q);
        return this.publicRow(prior);
      }
      const totals = await this.db.one(
        "SELECT coalesce(sum(bytes) FILTER(WHERE status NOT IN ('deleted','canceled','blocked')),0) stored,count(*) FILTER(WHERE uploader=$2 AND message_id IS NULL AND status NOT IN ('deleted','canceled','blocked')) pending,coalesce(sum(bytes) FILTER(WHERE uploader=$2 AND message_id IS NULL AND status NOT IN ('deleted','canceled','blocked')),0) pending_bytes FROM attachments WHERE workspace_id=$1",
        [p.workspaceId, who],
        q,
      );
      if (Number(totals!.stored) + d.size > limits.storageBytes)
        throw new HttpError(413, "Workspace attachment storage quota reached");
      if (
        Number(totals!.pending) >= limits.count ||
        Number(totals!.pending_bytes) + d.size > limits.messageBytes
      )
        throw new HttpError(
          413,
          "Pending uploads exceed the per-message count or byte limit; send or remove existing uploads",
        );
      const row = await this.db.one(
        "INSERT INTO attachments(id,workspace_id,conversation_id,channel_id,uploader,contact_id,visibility,storage_key,display_name,client_mime,bytes,settings_revision,request_key,request_hash,uploader_role) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *",
        [
          uid(),
          p.workspaceId,
          conv?.id ?? null,
          channel.id,
          who,
          staff(p) ? null : p.contactId,
          d.private ? "staff" : "customer",
          uid(),
          name,
          d.mime,
          d.size,
          settings.revision,
          d.requestKey,
          digest(d),
          p.emailIntake ? "email" : p.role,
        ],
        q,
      );
      return this.publicRow(row);
    });
  }
  private sniff(bytes: Buffer, name: string, hint: string) {
    const expected = allowed.get(extname(name).toLowerCase());
    let mime = "";
    if (
      bytes
        .subarray(0, 8)
        .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    )
      mime = "image/png";
    else if (
      bytes.length > 3 &&
      bytes[0] === 255 &&
      bytes[1] === 216 &&
      bytes[2] === 255
    )
      mime = "image/jpeg";
    else if (
      bytes.subarray(0, 5).toString() === "%PDF-" &&
      bytes.subarray(-1024).includes(Buffer.from("%%EOF"))
    )
      mime = "application/pdf";
    else if (expected === "text/plain") {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      if (!/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text)) mime = "text/plain";
    }
    if (
      !mime ||
      mime !== expected ||
      (hint &&
        ![
          mime,
          "application/octet-stream",
          mime === "text/plain" ? "text/x-log" : mime,
        ].includes(hint.split(";")[0]))
    )
      throw new HttpError(
        415,
        "File content does not match its permitted extension and type",
      );
    return mime;
  }
  async upload(p: Principal, id: string, input: AsyncIterable<Uint8Array>) {
    if (staff(p)) { p = await refreshPrincipal(this.db,p); requireCapability(p,"attachments:upload"); }
    const row = requireValue(
      await this.db.one(
        "SELECT * FROM attachments WHERE workspace_id=$1 AND id=$2",
        [p.workspaceId, id],
      ),
    );
    await this.access(p, row);
    if (row.uploader !== identity(p) || row.message_id)
      throw new HttpError(
        403,
        "Only the original uploader can complete an unsent upload",
      );
    if (row.status !== "uploading")
      throw new HttpError(
        409,
        "This upload is no longer accepting bytes; inspect its status before retrying",
      );
    const chunks: Buffer[] = [],
      limit = Math.min(this.limits(p).fileBytes, Number(row.bytes));
    let total = 0;
    for await (const chunk of input) {
      total += chunk.byteLength;
      if (total > limit) {
        await this.reject(
          p,
          id,
          "Actual upload exceeds its reserved byte limit",
        );
        throw new HttpError(413, "Upload exceeds its reserved byte limit");
      }
      chunks.push(Buffer.from(chunk));
    }
    const bytes = Buffer.concat(chunks);
    if (total !== Number(row.bytes)) {
      await this.reject(
        p,
        id,
        "Actual file size does not match the reserved size",
      );
      throw new HttpError(
        400,
        "File size does not match the upload reservation",
      );
    }
    let mime: string;
    try {
      mime = this.sniff(bytes, row.display_name, row.client_mime);
    } catch {
      await this.reject(
        p,
        id,
        "File content does not match its permitted extension and type",
      );
      throw new HttpError(415, "File type does not match its contents");
    }
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    // Unique generated name and exclusive creation close concurrent upload races.
    try {
      const file = await open(this.path(row.storage_key), "wx", 0o600);
      try {
        await file.writeFile(bytes);
        await file.sync();
      } finally {
        await file.close();
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      const existing = await readFile(this.path(row.storage_key));
      if (!existing.equals(bytes))
        throw new HttpError(
          409,
          "The reserved upload already contains different bytes",
        );
      // A crashed upload can leave fsynced bytes before metadata commit. Recover
      // only this reservation's exact bytes; never overwrite another attempt.
    }
    const dir = await open(this.directory, "r");
    try {
      await dir.sync();
    } finally {
      await dir.close();
    }
    try {
      await this.db.tx(async (q) => {
        const current = requireValue(
          await this.db.one(
            "SELECT * FROM attachments WHERE workspace_id=$1 AND id=$2 FOR UPDATE",
            [p.workspaceId, id],
            q,
          ),
        );
        await this.access(p, current, q);
        if (
          ["quarantined", "scanning", "available"].includes(current.status) &&
          current.hash === createHash("sha256").update(bytes).digest("hex")
        )
          return;
        const settings = await this.db.one(
          "SELECT * FROM attachment_settings WHERE workspace_id=$1",
          [p.workspaceId],
          q,
        );
        if (
          current.status !== "uploading" ||
          current.generation !== row.generation ||
          !settings?.enabled ||
          (p.role === "visitor" && !settings.anonymous)
        )
          throw new HttpError(409, "Upload was canceled or permission changed");
        await q.query(
          "UPDATE attachments SET status='quarantined',mime=$3,hash=$4,updated_at=now() WHERE workspace_id=$1 AND id=$2",
          [
            p.workspaceId,
            id,
            mime,
            createHash("sha256").update(bytes).digest("hex"),
          ],
        );
        await this.db.enqueue(q, "attachment", {
          workspaceId: p.workspaceId,
          attachmentId: id,
        });
      });
    } catch (e) {
      await this.cleanupFiles(id);
      throw e;
    }
    return this.get(p, id);
  }
  private async reject(p: Principal, id: string, reason: string) {
    await this.db.pool.query(
      "UPDATE attachments SET status='blocked',error=$3,generation=generation+1,updated_at=now() WHERE workspace_id=$1 AND id=$2 AND status='uploading'",
      [p.workspaceId, id, reason],
    );
  }
  async bind(
    p: Principal,
    conv: any,
    messageId: string,
    ids: string[],
    note: boolean,
    q: PoolClient,
  ) {
    if (!ids.length) return;
    if (staff(p)) { p=await refreshPrincipal(this.db,p,q); requireCapability(p,"attachments:upload"); if (note) requireCapability(p,"tickets:note"); }
    if (new Set(ids).size !== ids.length || ids.length > this.limits(p).count)
      throw new HttpError(400, "Too many or repeated attachment IDs");
    const rows = await this.db.rows(
      "SELECT * FROM attachments WHERE workspace_id=$1 AND id=ANY($2::text[]) ORDER BY id FOR UPDATE",
      [p.workspaceId, ids],
      q,
    );
    if (rows.length !== ids.length)
      throw new HttpError(404, "Attachment not found");
    if (
      rows.reduce((n, r) => n + Number(r.bytes), 0) >
      this.limits(p).messageBytes
    )
      throw new HttpError(413, "Attachments exceed the per-message byte limit");
    for (const row of rows) {
      if (
        row.uploader !== identity(p) ||
        (row.conversation_id && row.conversation_id !== conv.id) ||
        row.channel_id !== conv.channel_id ||
        (row.message_id && row.message_id !== messageId) ||
        row.visibility !== (note ? "staff" : "customer") ||
        ["uploading", "canceled", "deleted"].includes(row.status)
      )
        throw new HttpError(
          409,
          "Attachment cannot be associated with this message",
        );
      if (row.contact_id && row.contact_id !== conv.contact_id)
        throw new HttpError(403, "Attachment belongs to a different customer");
      await q.query(
        "UPDATE attachments SET conversation_id=$3,message_id=$4,updated_at=now() WHERE workspace_id=$1 AND id=$2",
        [p.workspaceId, row.id, conv.id, messageId],
      );
    }
  }
  async stageEmail(
    p: Principal,
    conversationId: string,
    providerId: string,
    rawFiles: unknown[],
  ) {
    const ids: string[] = [],
      limits = this.limits(p);
    let total = 0;
    const files = rawFiles.slice(0, limits.count);
    const conv = await conversation(this.db, p, conversationId);
    for (let index = 0; index < files.length; index++) {
      const raw = files[index] as Record<string, unknown> | null;
      const name = attachmentName(
          typeof raw?.Name === "string" ? raw.Name : "rejected-file.txt",
        ),
        key = `email:${digest(providerId)}:${index}`;
      let reason = "",
        bytes: Buffer | undefined;
      if (rawFiles.length > limits.count && index === limits.count - 1)
        reason =
          "Additional files exceed the per-message count limit; use the portal to submit them separately";
      else if (
        typeof raw?.Content !== "string" ||
        raw.Content.length > Math.ceil(limits.fileBytes / 3) * 4 ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
          raw.Content,
        )
      )
        reason = "Attachment encoding is malformed or exceeds the file limit";
      else {
        bytes = Buffer.from(raw.Content, "base64");
        if (
          !bytes.length ||
          bytes.length > limits.fileBytes ||
          raw.ContentLength !== bytes.length
        )
          reason =
            "Attachment byte count is invalid or does not match provider metadata";
        else if (total + bytes.length > limits.messageBytes)
          reason = "Decoded attachments exceed the per-message byte limit";
      }
      if (!reason) {
        try {
          const row = await this.reserve(p, {
            conversationId,
            name,
            size: bytes!.length,
            mime:
              typeof raw?.ContentType === "string"
                ? raw.ContentType
                : "application/octet-stream",
            requestKey: key,
          });
          if (row.status === "uploading")
            await this.upload(
              p,
              row.id,
              (async function* () {
                yield bytes!;
              })(),
            );
          ids.push(row.id);
          total += bytes!.length;
          continue;
        } catch (e) {
          if (
            !(e instanceof HttpError) ||
            ![400, 403, 413, 415].includes(e.status)
          )
            throw e;
          reason = e.message;
        }
      }
      const row = await this.db.one(
        "INSERT INTO attachments(id,workspace_id,conversation_id,channel_id,uploader,contact_id,visibility,storage_key,display_name,client_mime,bytes,settings_revision,request_key,request_hash,status,error) VALUES($1,$2,$3,$4,$5,$6,'customer',$7,$8,'application/octet-stream',0,0,$9,$10,'blocked',$11) ON CONFLICT(workspace_id,uploader,request_key) DO UPDATE SET error=EXCLUDED.error WHERE attachments.message_id IS NULL RETURNING id",
        [
          uid(),
          p.workspaceId,
          conversationId,
          conv.channel_id,
          identity(p),
          p.contactId,
          uid(),
          name,
          key,
          digest({ name, reason }),
          reason,
        ],
      );
      // An earlier retry may already have attached the file to the durable message.
      const previous =
        row ??
        requireValue(
          await this.db.one(
            "SELECT id FROM attachments WHERE workspace_id=$1 AND uploader=$2 AND request_key=$3",
            [p.workspaceId, identity(p), key],
          ),
        );
      ids.push(previous.id);
    }
    return ids;
  }
  async verifyBinding(
    ws: string,
    messageId: string,
    ids: string[],
    q: Queryable,
  ) {
    const actual = (
      await this.db.rows(
        "SELECT id FROM attachments WHERE workspace_id=$1 AND message_id=$2 ORDER BY id",
        [ws, messageId],
        q,
      )
    ).map((r) => r.id);
    if (digest(actual) !== digest([...ids].sort()))
      throw new HttpError(
        409,
        "Request key belongs to a message with different attachments",
      );
  }
  async control(
    p: Principal,
    id: string,
    action: "cancel" | "delete" | "retry",
  ) {
    if (staff(p)) { p=await refreshPrincipal(this.db,p); requireCapability(p,"attachments:upload"); }
    await this.db.tx(async (q) => {
      const row = requireValue(
        await this.db.one(
          "SELECT * FROM attachments WHERE workspace_id=$1 AND id=$2 FOR UPDATE",
          [p.workspaceId, id],
          q,
        ),
      );
      await this.access(p, row, q);
      if (action === "retry") {
        if (row.uploader !== identity(p)) requireAdmin(p);
        if (row.status !== "scan_failed")
          throw new HttpError(409, "Only failed scans can be retried");
        await q.query(
          "UPDATE attachments SET status='quarantined',generation=generation+1,error=NULL,updated_at=now() WHERE workspace_id=$1 AND id=$2",
          [p.workspaceId, id],
        );
        await this.db.enqueue(q, "attachment", {
          workspaceId: p.workspaceId,
          attachmentId: id,
        });
      } else {
        if (row.message_id) { requireCapability(p,"tickets:delete"); requireAdmin(p); }
        else if (row.uploader !== identity(p))
          throw new HttpError(403, "Only the uploader can remove a draft file");
        await q.query(
          "UPDATE attachments SET status=$3,generation=generation+1,scan=NULL,updated_at=now() WHERE workspace_id=$1 AND id=$2",
          [p.workspaceId, id, action === "delete" ? "deleted" : "canceled"],
        );
        await this.db.event(
          q,
          p.workspaceId,
          "attachment.removed",
          { attachmentId: id },
          row.conversation_id ?? undefined,
          false,
        );
      }
    });
    await this.cleanupFiles(id);
    return { ok: true };
  }
  private async cleanupFiles(id: string) {
    const row = await this.db.one("SELECT * FROM attachments WHERE id=$1", [
      id,
    ]);
    if (row && terminal.includes(row.status))
      for (const preview of [false, true])
        await unlink(this.path(row.storage_key, preview)).catch(() => {});
  }
  async scan(ws: string, id: string) {
    const client = await this.db.pool.connect();
    let slot = -1,
      locked = false;
    try {
      locked = (
        await client.query(
          "SELECT pg_try_advisory_lock(hashtextextended($1,0)) ok",
          [`attachment:${id}`],
        )
      ).rows[0].ok;
      if (!locked) return;
      for (let i = 0; i < this.db.config.FIELDKIT_ATTACHMENT_SCANS; i++) {
        if (
          (
            await client.query(
              "SELECT pg_try_advisory_lock(hashtextextended($1,0)) ok",
              [`attachment-slot:${i}`],
            )
          ).rows[0].ok
        ) {
          slot = i;
          break;
        }
      }
      if (slot < 0)
        throw new HttpError(
          503,
          "Scanner capacity is busy; durable job will retry",
        );
      await this.scanLocked(ws, id);
    } finally {
      if (slot >= 0)
        await client.query(
          "SELECT pg_advisory_unlock(hashtextextended($1,0))",
          [`attachment-slot:${slot}`],
        );
      if (locked)
        await client.query(
          "SELECT pg_advisory_unlock(hashtextextended($1,0))",
          [`attachment:${id}`],
        );
      client.release();
    }
  }
  private async scanAuthorized(row: any, q: Queryable) {
    const settings = await this.db.one(
      "SELECT enabled,anonymous FROM attachment_settings WHERE workspace_id=$1",
      [row.workspace_id],
      q,
    );
    if (!settings?.enabled) return false;
    if (row.uploader_role === "email")
      return !!(await this.db.one(
        "SELECT c.id FROM conversations c JOIN support_email_addresses a ON a.workspace_id=c.workspace_id AND a.id=c.support_address_id JOIN connections k ON k.id=a.integration_id AND k.workspace_id=c.workspace_id AND k.status='connected' WHERE c.workspace_id=$1 AND c.id=$2 AND c.contact_id=$3 AND c.channel_id=$4 AND c.origin='email'",
        [row.workspace_id, row.conversation_id, row.contact_id, row.channel_id],
        q,
      ));
    if (row.uploader.startsWith("staff:")) {
      try {
        const p=await resolveStaffPrincipal(this.db,row.workspace_id,row.uploader.slice(6),q);
        if (!hasCapability(p,"attachments:upload") || (row.visibility==="staff" && !hasCapability(p,"tickets:note"))) return false;
        if (!row.conversation_id) return true;
        const conv=await this.db.one("SELECT assigned_to,team_id FROM conversations WHERE workspace_id=$1 AND id=$2",[row.workspace_id,row.conversation_id],q);
        return !!conv && canReadConversation(p,conv);
      } catch (error) { if (error instanceof HttpError) return false; throw error; }
    }
    const contact = await this.db.one(
      "SELECT verified FROM contacts WHERE workspace_id=$1 AND id=$2",
      [row.workspace_id, row.contact_id],
      q,
    );
    return (
      !!contact &&
      (contact.verified ||
        (row.uploader_role === "visitor" && settings.anonymous)) &&
      !!(await this.db.one(
        "SELECT 1 FROM channels WHERE workspace_id=$1 AND id=$2 AND published",
        [row.workspace_id, row.channel_id],
        q,
      ))
    );
  }
  private async scanLocked(ws: string, id: string) {
    const row = await this.db.tx(async (q) => {
      const row = await this.db.one(
        "SELECT * FROM attachments WHERE workspace_id=$1 AND id=$2 FOR UPDATE",
        [ws, id],
        q,
      );
      if (!row || !["quarantined", "scanning"].includes(row.status)) return;
      if (!(await this.scanAuthorized(row, q))) {
        await q.query(
          "UPDATE attachments SET status='scan_failed',error='Attachment admission or uploader authority changed',updated_at=now() WHERE id=$1",
          [id],
        );
        return;
      }
      await q.query(
        "UPDATE attachments SET status='scanning',updated_at=now() WHERE id=$1",
        [id],
      );
      return row;
    });
    if (!row) return;
    let status = "available",
      error: string | null = null,
      scan: unknown = null;
    try {
      const bytes = await readFile(this.path(row.storage_key));
      if (
        bytes.length !== Number(row.bytes) ||
        createHash("sha256").update(bytes).digest("hex") !== row.hash
      )
        throw new Error("Stored file integrity check failed");
      scan = await this.scanner.scan(bytes);
      if (!(scan as any).clean) {
        status = "blocked";
        error = "The scanner detected a threat. This file cannot be opened.";
      } else if (row.mime.startsWith("image/")) {
        const preview = await sharp(bytes, {
          limitInputPixels: 20000000,
          failOn: "warning",
          animated: false,
        })
          .timeout({ seconds: 5 })
          .rotate()
          .resize(640, 640, { fit: "inside", withoutEnlargement: true })
          .png()
          .toBuffer();
        if (preview.length > 2 * 1024 * 1024)
          throw new Error("Preview exceeds limit");
        const file = await open(this.path(row.storage_key, true), "w", 0o600);
        try {
          await file.writeFile(preview);
          await file.sync();
        } finally {
          await file.close();
        }
      }
    } catch {
      status = "scan_failed";
      error =
        "Scanning or bounded preview processing failed. The file remains unavailable; check Readiness before retrying.";
    }
    const saved = await this.db.tx(async (q) => {
      const authorized = await this.scanAuthorized(row, q);
      const saved = await this.db.one(
        "UPDATE attachments SET status=$4,error=$5,scan=$6,updated_at=now() WHERE workspace_id=$1 AND id=$2 AND generation=$3 AND status='scanning' RETURNING *",
        [
          ws,
          id,
          row.generation,
          authorized ? status : "scan_failed",
          authorized
            ? error
            : "Attachment admission or uploader authority changed",
          scan,
        ],
        q,
      );
      if (saved?.conversation_id && saved.message_id)
        await this.db.event(
          q,
          ws,
          "attachment.updated",
          {
            attachmentId: id,
            messageId: saved.message_id,
            status: saved.status,
          },
          saved.conversation_id,
          saved.visibility === "customer",
        );
      return saved;
    });
    if (!saved || terminal.includes(saved.status))
      for (const preview of [false, true])
        await unlink(this.path(row.storage_key, preview)).catch(() => {});
  }
  async download(p: Principal, id: string, preview = false) {
    if (staff(p)) { p = await refreshPrincipal(this.db,p); requireCapability(p,"attachments:read"); }
    const row = requireValue(
      await this.db.one(
        "SELECT * FROM attachments WHERE workspace_id=$1 AND id=$2",
        [p.workspaceId, id],
      ),
    );
    await this.access(p, row);
    if (row.status !== "available" || !row.scan?.clean)
      throw new HttpError(
        409,
        "This file is not available until scanning succeeds",
      );
    if (preview && !staff(p))
      throw new HttpError(403, "Inline previews are available to staff only");
    if (preview && row.mime === "application/pdf")
      throw new HttpError(415, "PDF files are download-only");
    const image = preview && row.mime.startsWith("image/");
    let bytes = await readFile(this.path(row.storage_key, image));
    if (preview && !image)
      bytes = bytes.subarray(0, this.limits(p).previewBytes);
    // Recheck after I/O so deletion or conversation access revocation cannot use a stale read.
    const fresh = requireValue(
      await this.db.one(
        "SELECT * FROM attachments WHERE workspace_id=$1 AND id=$2 AND status='available' AND generation=$3",
        [p.workspaceId, id, row.generation],
      ),
    );
    await this.access(p, fresh);
    return {
      bytes,
      mime: image ? "image/png" : row.mime,
      name: row.display_name,
      inline: preview,
    };
  }
  async retain(ws: string, days: number) {
    // Even a conversation retained for an uncertain business operation must not
    // keep unrestricted customer file bytes beyond the workspace retention period.
    const rows = await this.db.rows(
      "UPDATE attachments SET status='deleted',generation=generation+1,error='File removed by retention',updated_at=now() WHERE workspace_id=$1 AND created_at<now()-($2::int*interval '1 day') AND status<>'deleted' RETURNING storage_key",
      [ws, days],
    );
    for (const row of rows)
      for (const preview of [false, true])
        await unlink(this.path(row.storage_key, preview)).catch(() => {});
  }
  async reconcile() {
    await this.db.pool.query(
      "UPDATE attachments SET status='deleted',generation=generation+1,updated_at=now() WHERE message_id IS NULL AND created_at<now()-interval '24 hours' AND status<>'deleted'",
    );
    const pending = await this.db.rows(
      "SELECT workspace_id,id FROM attachments WHERE status IN ('quarantined','scanning') AND updated_at<now()-interval '5 minutes' LIMIT 100",
    );
    for (const row of pending)
      await this.db.tx((q) =>
        this.db.enqueue(q, "attachment", {
          workspaceId: row.workspace_id,
          attachmentId: row.id,
        }),
      );
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const cursor =
      (
        await this.db.one(
          "SELECT last_key FROM attachment_cleanup_cursor WHERE id=1",
        )
      )?.last_key ?? "";
    const entries = (await readdir(this.directory))
      .filter((n) => /^[0-9a-f-]{36}\.(bin|preview)$/.test(n))
      .sort();
    const batch = entries.filter((n) => n > cursor).slice(0, 10000);
    for (const name of batch) {
      if (!/^[0-9a-f-]{36}\.(bin|preview)$/.test(name)) continue;
      const key = name.slice(0, 36),
        row = await this.db.one(
          "SELECT status FROM attachments WHERE storage_key=$1",
          [key],
        );
      if (!row || terminal.includes(row.status)) {
        const path = join(this.directory, name),
          info = await stat(path).catch(() => null);
        if (info && Date.now() - info.mtimeMs > 3600000)
          await unlink(path).catch(() => {});
      }
    }
    await this.db.pool.query(
      "INSERT INTO attachment_cleanup_cursor VALUES(1,$1) ON CONFLICT(id) DO UPDATE SET last_key=$1",
      [batch.length === 10000 ? batch.at(-1) : ""],
    );
  }
}
