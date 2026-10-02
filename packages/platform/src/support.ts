import { Actions } from "./actions.js";
import type { Database } from "./db.js";
import { uid } from "./db.js";
import type { Connections } from "./connections.js";
import { HttpError, requireValue } from "./config.js";
import { digest, equal, verifySignature } from "./security.js";

export class Support {
  constructor(
    public db: Database,
    public connections: Connections,
  ) {}
  async queue(
    q: import("pg").PoolClient,
    ws: string,
    conversationId: string,
    payload: object,
    id = uid(),
  ) {
    await q.query(
      "INSERT INTO deliveries(id,workspace_id,conversation_id,payload) VALUES($1,$2,$3,$4) ON CONFLICT(id) DO NOTHING",
      [id, ws, conversationId, payload],
    );
    await this.db.enqueue(q, "delivery", { workspaceId: ws, deliveryId: id });
    return id;
  }
  async webhook(
    ws: string,
    body: Buffer,
    signature: string,
    timestamp: string,
    eventId: string,
  ) {
    const connection = await this.db.connection(ws, "zendesk"),
      secret = this.connections.secret(connection).webhookSecret;
    if (
      !secret ||
      !Number.isFinite(Date.parse(timestamp)) ||
      Math.abs(Date.now() - Date.parse(timestamp)) > 5 * 60 * 1000 ||
      !verifySignature(secret, timestamp + body.toString(), signature, "base64")
    )
      throw new HttpError(401, "Invalid webhook signature or timestamp");
    let payload: any;
    try {
      payload = JSON.parse(body.toString());
    } catch {
      throw new HttpError(400, "Invalid webhook JSON");
    }
    const ticketId = String(payload.ticket_id ?? payload.detail?.id ?? "");
    if (!/^\d+$/.test(ticketId) || !eventId || eventId.length > 200)
      throw new HttpError(400, "Webhook requires a ticket ID and event ID");
    await this.db.tx(async (q) => {
      const existing = await this.db.one(
        "SELECT hash FROM inbound_events WHERE workspace_id=$1 AND provider='zendesk' AND event_id=$2",
        [ws, eventId],
        q,
      );
      if (existing) {
        if (!equal(existing.hash, digest(payload)))
          throw new HttpError(
            409,
            "Webhook ID reused with a different payload",
          );
        return;
      }
      const r = await q.query(
        "INSERT INTO inbound_events(workspace_id,provider,event_id,hash) VALUES($1,'zendesk',$2,$3) ON CONFLICT DO NOTHING RETURNING event_id",
        [ws, eventId, digest(payload)],
      );
      if (r.rowCount)
        await this.db.enqueue(q, "sync", { workspaceId: ws, ticketId });
    });
  }
  async sync(ws: string, ticketId: string, forceTurn = false) {
    const channel = await this.db.one(
      "SELECT * FROM channels WHERE workspace_id=$1 AND kind='zendesk'",
      [ws],
    );
    if (
      !channel ||
      (!channel.published &&
        !(await this.db.one(
          "SELECT id FROM conversations WHERE workspace_id=$1 AND external_id=$2",
          [ws, ticketId],
        )))
    )
      return;
    const { ticket } = await this.connections.json(
      ws,
      "zendesk",
      `/api/v2/tickets/${encodeURIComponent(ticketId)}.json`,
    );
    const { user } = await this.connections.json(
      ws,
      "zendesk",
      `/api/v2/users/${ticket.requester_id}.json`,
    );
    let path = `/api/v2/tickets/${encodeURIComponent(ticketId)}/comments.json?page[size]=100`,
      comments: any[] = [];
    for (let page = 0; path && page < 100; page++) {
      const response = await this.connections.json(ws, "zendesk", path);
      comments.push(...response.comments);
      const next = response.links?.next ?? response.next_page;
      if (next) {
        const expected = new URL(
          `https://${(await this.db.connection(ws, "zendesk")).metadata.subdomain}.zendesk.com`,
        );
        const url = new URL(next, expected);
        if (url.origin !== expected.origin)
          throw new Error("Unexpected pagination destination");
        path = url.pathname + url.search;
      } else path = "";
    }
    if (path) throw new Error("Ticket history exceeds supported import size");
    const ownComments = new Set<string>();
    path = `/api/v2/tickets/${encodeURIComponent(ticketId)}/audits.json?page[size]=100`;
    for (let page = 0; path && page < 100; page++) {
      const result = await this.connections.json(ws, "zendesk", path);
      for (const audit of result.audits) {
        const deliveryId = audit.metadata?.custom?.fieldkit_delivery;
        if (
          deliveryId &&
          (await this.db.one(
            "SELECT id FROM deliveries WHERE workspace_id=$1 AND id=$2",
            [ws, deliveryId],
          ))
        )
          for (const event of audit.events ?? [])
            if (event.type === "Comment") ownComments.add(String(event.id));
      }
      const next = result.links?.next ?? result.next_page;
      path = next ? new URL(next).pathname + new URL(next).search : "";
    }
    if (path)
      throw new Error("Ticket audit history exceeds supported import size");
    await this.db.tx(async (q) => {
      await q.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        `${ws}:zendesk:${ticketId}`,
      ]);
      const contact = (
        await this.db.rows(
          `INSERT INTO contacts(id,workspace_id,external_id,name,email,verified) VALUES($1,$2,$3,$4,$5,$6)
        ON CONFLICT(workspace_id,external_id) DO UPDATE SET name=excluded.name,email=excluded.email,verified=excluded.verified RETURNING *`,
          [
            uid(),
            ws,
            `zendesk:${user.id}`,
            user.name ?? "",
            user.email ?? null,
            Boolean(user.verified),
          ],
          q,
        )
      )[0];
      let conv = await this.db.one(
        "SELECT * FROM conversations WHERE workspace_id=$1 AND external_id=$2 FOR UPDATE",
        [ws, ticketId],
        q,
      );
      if (!conv)
        conv = (
          await this.db.rows(
            "INSERT INTO conversations(id,workspace_id,contact_id,channel_id,subject,external_id,external_version) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *",
            [
              uid(),
              ws,
              contact.id,
              channel.id,
              ticket.subject ?? "Support request",
              ticketId,
              ticket.updated_at,
            ],
            q,
          )
        )[0];
      if (
        conv.contact_id !== contact.id &&
        conv.external_requester_id !== String(ticket.requester_id)
      )
        throw new HttpError(
          409,
          "Zendesk requester changed; review the identity mapping before processing",
        );
      let changed = false,
        lastRole = "";
      if (["low", "normal", "high", "urgent"].includes(ticket.priority))
        await q.query("UPDATE conversations SET priority=$2 WHERE id=$1", [
          conv.id,
          ticket.priority,
        ]);
      for (const comment of comments) {
        if (ownComments.has(String(comment.id))) continue;
        const role =
          comment.author_id === ticket.requester_id
            ? "customer"
            : comment.public
              ? "staff"
              : "note";
        const r = await q.query(
          "INSERT INTO messages(id,workspace_id,conversation_id,role,body,request_key,author_id,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(workspace_id,conversation_id,request_key) DO NOTHING RETURNING id",
          [
            uid(),
            ws,
            conv.id,
            role,
            comment.plain_body ?? comment.body ?? "",
            `zendesk:${comment.id}`,
            String(comment.author_id),
            comment.created_at,
          ],
        );
        if (r.rowCount) {
          changed = true;
          if (role !== "note") lastRole = role;
        }
      }
      if (changed) {
        const mode = lastRole === "staff" ? "human" : conv.mode,
          status = ["solved", "closed"].includes(ticket.status)
            ? "resolved"
            : "open";
        const updated = (
          await this.db.rows(
            "UPDATE conversations SET revision=revision+1,mode=$1,status=$2,external_version=$3,updated_at=now() WHERE id=$4 RETURNING *",
            [mode, status, ticket.updated_at, conv.id],
            q,
          )
        )[0];
        if (
          lastRole === "customer" &&
          mode === "agent" &&
          status !== "resolved"
        )
          await enqueueTurn(this.db, q, updated);
        await this.db.event(q, ws, "conversation.synced", {}, conv.id, true);
      } else {
        const resolved = ["solved", "closed"].includes(ticket.status);
        const statusChanged = resolved !== (conv.status === "resolved");
        await q.query(
          "UPDATE conversations SET external_version=$1,external_requester_id=$4,status=CASE WHEN $3 THEN 'resolved' WHEN status='resolved' THEN 'open' ELSE status END,revision=revision+$5 WHERE id=$2",
          [
            ticket.updated_at,
            conv.id,
            resolved,
            String(ticket.requester_id),
            statusChanged ? 1 : 0,
          ],
        );
        if (statusChanged)
          await this.db.event(q, ws, "conversation.synced", {}, conv.id, true);
      }
      if (forceTurn) {
        const current = await this.db.one(
          "SELECT * FROM conversations WHERE id=$1",
          [conv.id],
          q,
        );
        if (current?.mode === "agent" && current.status !== "resolved")
          await enqueueTurn(this.db, q, current);
      }
    });
  }
  private async resumeCustomer(
    q: import("pg").PoolClient,
    ws: string,
    delivery: any,
    conv: any,
  ) {
    if (delivery.payload.customer && conv.external_id && conv.mode === "agent")
      await this.db.enqueue(q, "sync", {
        workspaceId: ws,
        ticketId: conv.external_id,
        forceTurn: true,
      });
  }
  async deliver(ws: string, id: string) {
    const link = await this.db.one(
      "SELECT conversation_id FROM deliveries WHERE workspace_id=$1 AND id=$2",
      [ws, id],
    );
    if (!link) return;
    return this.db.tx(async (q) => {
      // The same row lock is used by takeover, new messages, and agent execution.
      await q.query(
        "SELECT id FROM conversations WHERE workspace_id=$1 AND id=$2 FOR UPDATE",
        [ws, link.conversation_id],
      );
      return this.deliverLocked(ws, id, q);
    });
  }
  private async deliverLocked(
    ws: string,
    id: string,
    q: import("pg").PoolClient,
  ) {
    const delivery = await this.db.one(
      "SELECT * FROM deliveries WHERE workspace_id=$1 AND id=$2",
      [ws, id],
    );
    if (!delivery || delivery.status === "cancelled") return;
    const conv = requireValue(
      await this.db.one(
        "SELECT * FROM conversations WHERE workspace_id=$1 AND id=$2",
        [ws, delivery.conversation_id],
        q,
      ),
    );
    if (delivery.status === "delivered") {
      await this.resumeCustomer(q, ws, delivery, conv);
      return;
    }
    if (
      delivery.payload.guardRevision &&
      (conv.revision !== delivery.payload.guardRevision ||
        conv.mode !== "agent")
    ) {
      await this.db.pool.query(
        "UPDATE deliveries SET status='cancelled',error='Conversation changed before publication' WHERE id=$1",
        [id],
      );
      return;
    }
    if (delivery.payload.workflowRunId) {
      try {
        const run = requireValue(
          await this.db.one(
            "SELECT state,workflow_version FROM runs WHERE workspace_id=$1 AND id=$2",
            [ws, delivery.payload.workflowRunId],
            q,
          ),
        );
        const workflow = await this.db.one(
          "SELECT published_version FROM workflows WHERE workspace_id=$1",
          [ws],
          q,
        );
        if (workflow?.published_version !== run.workflow_version)
          throw new Error("Workflow changed before publication");
        if (run.state.accountContactRevision !== undefined) {
          const contact = await this.db.one(
            "SELECT id,verified,revision FROM contacts WHERE workspace_id=$1 AND id=$2",
            [ws, conv.contact_id],
            q,
          );
          if (
            !contact?.verified ||
            contact.id !== run.state.accountContactId ||
            contact.revision !== run.state.accountContactRevision
          )
            throw new Error("Customer identity changed before publication");
        }
        const actions = new Actions(this.db, this.connections);
        for (const proof of run.state.readProofs ?? [])
          await actions.revalidate(ws, proof, q);
      } catch (error) {
        await this.db.pool.query(
          "UPDATE deliveries SET status='cancelled',error=$2 WHERE id=$1",
          [id, (error as Error).message],
        );
        return;
      }
    }
    if (delivery.payload.evidenceIds?.length) {
      const evidence = await this.db.rows(
        "SELECT c.id FROM chunks c JOIN documents d ON d.id=c.document_id JOIN sources s ON s.id=d.source_id WHERE c.workspace_id=$1 AND c.id=ANY($2::text[]) AND d.active AND s.active AND s.status='ready' AND s.visibility='customer' FOR SHARE OF d,s",
        [ws, delivery.payload.evidenceIds],
        q,
      );
      if (evidence.length !== delivery.payload.evidenceIds.length) {
        await this.db.pool.query(
          "UPDATE deliveries SET status='cancelled',error='Knowledge changed before publication' WHERE id=$1",
          [id],
        );
        return;
      }
    }
    if (!conv.external_id) {
      // An interrupted create cannot safely be replayed until its external_id is reconciled.
      if (delivery.status === "sending" || delivery.status === "unknown") {
        const found = await this.connections.json(
          ws,
          "zendesk",
          "/api/v2/search.json?query=" +
            encodeURIComponent(`type:ticket external_id:fieldkit-${conv.id}`),
        );
        const candidates = found.results.filter(
          (t: any) => t.external_id === `fieldkit-${conv.id}`,
        );
        if (candidates.length === 1) {
          await q.query(
            "UPDATE conversations SET external_id=$1,external_version=$2,external_requester_id=$4 WHERE id=$3",
            [
              String(candidates[0].id),
              candidates[0].updated_at,
              conv.id,
              String(candidates[0].requester_id),
            ],
          );
          await this.db.pool.query(
            "UPDATE deliveries SET status='delivered',receipt=$1 WHERE id=$2",
            [{ ticketId: candidates[0].id }, id],
          );
          return;
        }
        await this.db.pool.query(
          "UPDATE deliveries SET status='unknown',error='Ticket creation needs reconciliation' WHERE id=$1",
          [id],
        );
        throw new Error("Zendesk create outcome remains unknown");
      }
      const contact = requireValue(
        await this.db.one(
          "SELECT * FROM contacts WHERE workspace_id=$1 AND id=$2",
          [ws, conv.contact_id],
        ),
      );
      if (!contact.verified || !contact.email)
        throw new Error(
          "A verified customer email is required for Zendesk handoff",
        );
      await this.db.pool.query(
        "UPDATE deliveries SET status='sending',attempts=attempts+1 WHERE id=$1",
        [id],
      );
      try {
        const { ticket } = await this.connections.json(
          ws,
          "zendesk",
          "/api/v2/tickets.json",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              ticket: {
                external_id: `fieldkit-${conv.id}`,
                subject: conv.subject,
                requester: {
                  name: contact.name || contact.email,
                  email: contact.email,
                },
                comment: {
                  body:
                    delivery.payload.body ??
                    "Customer requested human assistance.",
                  public: false,
                },
                metadata: { fieldkit_delivery: id },
              },
            }),
          },
        );
        await q.query(
          "UPDATE conversations SET external_id=$1,external_version=$2,external_requester_id=$4 WHERE id=$3",
          [
            String(ticket.id),
            ticket.updated_at,
            conv.id,
            String(ticket.requester_id),
          ],
        );
        await this.db.pool.query(
          "UPDATE deliveries SET status='delivered',receipt=$1 WHERE id=$2",
          [{ ticketId: ticket.id }, id],
        );
        return;
      } catch (e) {
        await this.db.pool.query(
          "UPDATE deliveries SET status='unknown',error=$1 WHERE id=$2",
          [String(e), id],
        );
        throw e;
      }
    }
    const ticketId = encodeURIComponent(conv.external_id);
    if (delivery.status === "sending" || delivery.status === "unknown") {
      let path = `/api/v2/tickets/${ticketId}/audits.json?page[size]=100`;
      for (let n = 0; path && n < 100; n++) {
        const data = await this.connections.json(ws, "zendesk", path);
        if (
          data.audits.some(
            (a: any) => a.metadata?.custom?.fieldkit_delivery === id,
          )
        ) {
          await this.db.pool.query(
            "UPDATE deliveries SET status='delivered',error=null,receipt=$1 WHERE id=$2",
            [{ reconciled: true }, id],
          );
          await this.resumeCustomer(q, ws, delivery, conv);
          return;
        }
        const next = data.links?.next ?? data.next_page;
        path = next ? new URL(next).pathname + new URL(next).search : "";
      }
      await this.db.pool.query(
        "UPDATE deliveries SET status='unknown',error='Update outcome needs manual reconciliation' WHERE id=$1",
        [id],
      );
      throw new Error(
        "Zendesk update outcome remains unknown; no duplicate comment sent",
      );
    }
    const { ticket: latest } = await this.connections.json(
      ws,
      "zendesk",
      `/api/v2/tickets/${ticketId}.json`,
    );
    if (
      delivery.payload.guardRevision &&
      conv.external_version &&
      latest.updated_at !== conv.external_version
    ) {
      await this.db.pool.query(
        "UPDATE deliveries SET status='cancelled',error='Zendesk ticket changed before publication' WHERE id=$1",
        [id],
      );
      await this.db.enqueue(q, "sync", {
        workspaceId: ws,
        ticketId: conv.external_id,
      });
      return;
    }
    const payload = delivery.payload;
    const ticket: any = {
      safe_update: true,
      updated_stamp: latest.updated_at,
      metadata: { fieldkit_delivery: id },
    };
    if (payload.body) {
      ticket.comment = { body: payload.body, public: payload.public === true };
      if (payload.customer) {
        if (
          conv.external_requester_id &&
          conv.external_requester_id !== String(latest.requester_id)
        )
          throw new HttpError(
            409,
            "Zendesk requester changed; review this conversation before forwarding",
          );
        ticket.comment.author_id = latest.requester_id;
      }
    }
    if (payload.status) ticket.status = payload.status;
    if (payload.priority) ticket.priority = payload.priority;
    if (payload.tags) ticket.additional_tags = payload.tags;
    if (payload.assigneeId) ticket.assignee_id = Number(payload.assigneeId);
    await this.db.pool.query(
      "UPDATE deliveries SET status='sending',attempts=attempts+1 WHERE id=$1",
      [id],
    );
    try {
      const result = await this.connections.json(
        ws,
        "zendesk",
        `/api/v2/tickets/${ticketId}.json`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ticket }),
        },
      );
      await q.query(
        "UPDATE conversations SET external_version=$1 WHERE id=$2",
        [result.ticket.updated_at, conv.id],
      );
      await this.db.pool.query(
        "UPDATE deliveries SET status='delivered',receipt=$1,error=null WHERE id=$2",
        [{ ticketId: result.ticket.id, auditId: result.audit?.id }, id],
      );
      await this.resumeCustomer(q, ws, delivery, conv);
    } catch (e) {
      if (e instanceof HttpError && e.status === 409) {
        const status = delivery.payload.guardRevision
          ? "cancelled"
          : delivery.attempts < 4
            ? "queued"
            : "failed";
        await this.db.pool.query(
          "UPDATE deliveries SET status=$1,error='Zendesk update conflict' WHERE id=$2",
          [status, id],
        );
        await this.db.enqueue(q, "sync", {
          workspaceId: ws,
          ticketId: conv.external_id,
        });
        if (status === "queued")
          await this.db.enqueue(q, "delivery", {
            workspaceId: ws,
            deliveryId: id,
          });
        return;
      }
      await this.db.pool.query(
        "UPDATE deliveries SET status='unknown',error=$1 WHERE id=$2",
        [String(e), id],
      );
      throw e;
    }
  }
}
export async function enqueueTurn(
  db: Database,
  q: import("pg").PoolClient,
  conv: any,
) {
  const id = uid();
  const workflow = await db.one(
    "SELECT v.version,COALESCE(v.compiled_definition,v.definition) definition FROM workflows w JOIN workflow_versions v ON v.workspace_id=w.workspace_id AND v.version=w.published_version WHERE w.workspace_id=$1",
    [conv.workspace_id],
    q,
  );
  const r = await q.query(
    "INSERT INTO runs(id,workspace_id,conversation_id,revision,graph_version,workflow_definition,workflow_version) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(conversation_id,revision) DO NOTHING RETURNING id",
    [
      id,
      conv.workspace_id,
      conv.id,
      conv.revision,
      workflow ? "support-v3" : "support-v2",
      workflow?.definition ?? null,
      workflow?.version ?? null,
    ],
  );
  if (r.rowCount)
    await db.enqueue(q, "turn", { workspaceId: conv.workspace_id, runId: id });
}
