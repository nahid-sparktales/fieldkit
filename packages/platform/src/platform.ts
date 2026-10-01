import type { Config } from "./config.js";
import { Database, uid } from "./db.js";
import {
  createAuth,
  type Mailer,
  type Principal,
  requireAdmin,
  requireOwner,
  requireStaff,
  staff,
  conversation,
} from "./auth.js";
import { Connections } from "./connections.js";
import { LiveModel, type ModelPort } from "./model.js";
import { Knowledge } from "./knowledge.js";
import { Actions } from "./actions.js";
import { Support, enqueueTurn } from "./support.js";
import { Agent } from "./agent.js";
import { HttpError, requireValue, log } from "./config.js";
import {
  Settings,
  WorkspaceInput,
  MessageInput,
  ChannelInput,
} from "./contracts.js";
import { token, tokenHash, equal, digest, type Fetcher } from "./security.js";

export class Platform {
  private heartbeat?: ReturnType<typeof setInterval>;
  private workerId = uid();
  db: Database;
  auth;
  connections: Connections;
  model: ModelPort;
  knowledge: Knowledge;
  actions: Actions;
  support: Support;
  agent: Agent;
  constructor(
    public config: Config,
    options: { mailer?: Mailer; fetch?: Fetcher; model?: ModelPort } = {},
  ) {
    this.db = new Database(config);
    this.auth = createAuth(this.db, options.mailer);
    this.connections = new Connections(this.db, options.fetch);
    this.model = options.model ?? new LiveModel(this.db, this.connections);
    this.knowledge = new Knowledge(this.db, this.connections, this.model);
    this.actions = new Actions(this.db, this.connections);
    this.support = new Support(this.db, this.connections);
    this.agent = new Agent(
      this.db,
      this.knowledge,
      this.model,
      this.actions,
      this.support,
    );
  }
  async migrate() {
    await this.db.migrate();
    await this.auth.migrate();
  }
  async start() {
    await this.db.boss.start();
  }
  async workers() {
    const heartbeat = () =>
      this.db.pool
        .query(
          "INSERT INTO worker_heartbeats VALUES($1,now()) ON CONFLICT(id) DO UPDATE SET last_seen=now()",
          [this.workerId],
        )
        .catch((e) => log("worker.heartbeat_failed", { message: e.message }));
    await heartbeat();
    this.heartbeat = setInterval(() => void heartbeat(), 15000);
    await this.db.boss.work<{ workspaceId: string; runId: string }>(
      "turn",
      { batchSize: 1, localConcurrency: 3 },
      async (jobs) => {
        for (const job of jobs)
          await this.agent.advance(job.data.workspaceId, job.data.runId);
      },
    );
    await this.db.boss.work<{ workspaceId: string; sourceId: string }>(
      "ingest",
      { batchSize: 1, localConcurrency: 2 },
      async (jobs) => {
        for (const job of jobs)
          await this.knowledge.ingest(job.data.workspaceId, job.data.sourceId);
      },
    );
    await this.db.boss.work<{
      workspaceId: string;
      ticketId: string;
      forceTurn?: boolean;
    }>("sync", async (jobs) => {
      for (const job of jobs)
        await this.support.sync(
          job.data.workspaceId,
          job.data.ticketId,
          job.data.forceTurn,
        );
    });
    await this.db.boss.work<{ workspaceId: string; deliveryId: string }>(
      "delivery",
      async (jobs) => {
        for (const job of jobs)
          await this.support.deliver(job.data.workspaceId, job.data.deliveryId);
      },
    );
    await this.db.boss.work<{ deleteThreads?: string[] }>(
      "maintenance",
      async (jobs) => {
        for (const job of jobs) {
          if (job.data?.deleteThreads) {
            for (const id of job.data.deleteThreads)
              await this.db.saver.deleteThread(id);
          } else await this.maintenance();
        }
      },
    );
    await this.db.boss.schedule("maintenance", "0 * * * *", {});
  }
  async maintenance() {
    for (const source of await this.db.rows(
      "SELECT workspace_id,id FROM sources WHERE active AND kind NOT IN ('file','faq') AND status<>'processing'",
    ))
      await this.db.tx((q) =>
        this.db.enqueue(q, "ingest", {
          workspaceId: source.workspace_id,
          sourceId: source.id,
        }),
      );
    await this.db.pool.query("DELETE FROM oauth_states WHERE expires_at<now()");
    await this.db.pool.query("DELETE FROM credentials WHERE expires_at<now()");
    await this.db.pool.query("DELETE FROM rate_limits WHERE expires_at<now()");
    for (const a of await this.db.rows(
      "UPDATE approvals SET status='expired' WHERE status='pending' AND expires_at<now() RETURNING workspace_id,run_id",
    ))
      await this.db.tx((q) =>
        this.db.enqueue(q, "turn", {
          workspaceId: a.workspace_id,
          runId: a.run_id,
        }),
      );
    for (const ws of await this.db.rows("SELECT id,settings FROM workspaces")) {
      const days = Settings.parse(ws.settings).retentionDays;
      const old = await this.db.rows(
        "SELECT c.id FROM conversations c WHERE c.workspace_id=$1 AND c.status='resolved' AND c.updated_at<now()-($2::int*interval '1 day') AND NOT EXISTS(SELECT 1 FROM operations o JOIN runs r ON r.id=o.run_id WHERE r.conversation_id=c.id AND o.status IN ('prepared','sent','unknown'))",
        [ws.id, days],
      );
      for (const c of old) await this.deleteConversation(ws.id, c.id);
    }
  }
  async rate(key: string, max = 60) {
    const row = await this.db.one(
      `INSERT INTO rate_limits(key,count,expires_at) VALUES($1,1,now()+interval '1 minute') ON CONFLICT(key) DO UPDATE SET count=CASE WHEN rate_limits.expires_at<now() THEN 1 ELSE rate_limits.count+1 END, expires_at=CASE WHEN rate_limits.expires_at<now() THEN now()+interval '1 minute' ELSE rate_limits.expires_at END RETURNING count`,
      [key],
    );
    if (row!.count > max)
      throw new HttpError(429, "Too many requests. Try again in a minute.");
  }
  async createWorkspace(userId: string, input: unknown, setupToken?: string) {
    const data = WorkspaceInput.parse(input);
    return this.db.tx(async (q) => {
      await q.query(
        "SELECT pg_advisory_xact_lock(hashtextextended('installation-bootstrap',0))",
      );
      const existing = await this.db.one(
        "SELECT id FROM workspaces LIMIT 1",
        [],
        q,
      );
      if (!existing) {
        if (!setupToken || !equal(setupToken, this.config.FIELDKIT_SETUP_TOKEN))
          throw new HttpError(
            403,
            "Enter the installation setup token from your server configuration",
          );
      } else if (
        !(await this.db.one(
          "SELECT 1 FROM memberships WHERE user_id=$1 AND role='owner'",
          [userId],
          q,
        ))
      )
        throw new HttpError(
          403,
          "Only an existing owner can create workspaces",
        );
      const id = uid();
      await q.query(
        "INSERT INTO workspaces(id,slug,name,settings) VALUES($1,$2,$3,$4)",
        [id, data.slug, data.name, Settings.parse({})],
      );
      await q.query("INSERT INTO memberships VALUES($1,$2,'owner')", [
        id,
        userId,
      ]);
      for (const kind of ["portal", "widget", "zendesk"])
        await q.query(
          "INSERT INTO channels(id,workspace_id,kind,settings) VALUES($1,$2,$3,$4)",
          [uid(), id, kind, { origins: [], handoff: "native" }],
        );
      await this.db.event(q, id, "workspace.created", { userId });
      return { id, ...data };
    });
  }
  async invite(p: Principal, email: string, role: "admin" | "agent") {
    requireAdmin(p);
    const value = token(),
      id = uid();
    await this.db.pool.query(
      "INSERT INTO invitations(id,workspace_id,email,role,token_hash,expires_at) VALUES($1,$2,$3,$4,$5,now()+interval '7 days')",
      [id, p.workspaceId, email.toLowerCase(), role, tokenHash(value)],
    );
    await this.auth.send(
      email,
      "Join your team on FieldKit",
      `Sign in or create an account, then accept your invitation: ${this.config.FIELDKIT_URL}/?invite=${encodeURIComponent(value)}`,
    );
    return { id, email, role };
  }
  async acceptInvite(user: { id: string; email: string }, value: string) {
    return this.db.tx(async (q) => {
      const row = requireValue(
        await this.db.one(
          "SELECT * FROM invitations WHERE token_hash=$1 AND expires_at>now() AND accepted_at IS NULL FOR UPDATE",
          [tokenHash(value)],
          q,
        ),
        400,
        "Invitation is invalid or expired",
      );
      if (row.email !== user.email.toLowerCase())
        throw new HttpError(403, "Sign in using the invited email address");
      await q.query(
        "INSERT INTO memberships VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
        [row.workspace_id, user.id, row.role],
      );
      await q.query("UPDATE invitations SET accepted_at=now() WHERE id=$1", [
        row.id,
      ]);
      return { workspaceId: row.workspace_id };
    });
  }
  async publishChannel(p: Principal, id: string, input: unknown) {
    requireAdmin(p);
    const data = ChannelInput.parse(input);
    const channel = requireValue(
      await this.db.one(
        "SELECT * FROM channels WHERE workspace_id=$1 AND id=$2",
        [p.workspaceId, id],
      ),
    );
    for (const origin of data.settings.origins) {
      const u = new URL(origin);
      if (
        u.origin !== origin ||
        !(
          u.protocol === "https:" ||
          (u.protocol === "http:" &&
            ["localhost", "127.0.0.1"].includes(u.hostname))
        )
      )
        throw new HttpError(
          400,
          "Origins must be exact HTTPS origins without a path; local HTTP development origins are supported",
        );
    }
    if (data.published) {
      if (!this.config.SMTP_URL)
        throw new HttpError(
          409,
          "Configure SMTP before publishing customer-facing channels",
        );
      await this.db.connection(p.workspaceId, "openai");
      if (data.settings.handoff === "zendesk" || channel.kind === "zendesk") {
        const connection = await this.db.connection(p.workspaceId, "zendesk");
        requireValue(
          this.connections.secret(connection).webhookSecret,
          409,
          "Configure the Zendesk webhook signing secret before publishing",
        );
      }
    }
    return this.db.tx(async (q) => {
      const saved = requireValue(
        (
          await this.db.rows(
            "UPDATE channels SET published=$1,settings=$2 WHERE workspace_id=$3 AND id=$4 RETURNING *",
            [data.published, data.settings, p.workspaceId, id],
            q,
          )
        )[0],
      );
      if (!data.published) {
        await q.query(
          "UPDATE conversations SET mode='human',revision=revision+1 WHERE workspace_id=$1 AND channel_id=$2 AND mode='agent'",
          [p.workspaceId, id],
        );
        await q.query(
          "UPDATE approvals SET status='stale' WHERE status='pending' AND run_id IN (SELECT r.id FROM runs r JOIN conversations c ON c.id=r.conversation_id WHERE c.workspace_id=$1 AND c.channel_id=$2)",
          [p.workspaceId, id],
        );
        if (channel.kind === "widget")
          await q.query(
            "DELETE FROM credentials WHERE workspace_id=$1 AND kind='widget'",
            [p.workspaceId],
          );
      }
      await this.db.event(q, p.workspaceId, "channel.updated", {
        channelId: id,
        published: data.published,
        actor: p.userId,
      });
      return saved;
    });
  }
  async newConversation(
    p: Principal,
    input: {
      body: string;
      requestKey: string;
      subject?: string;
      channelId?: string;
      contactId?: string;
    },
  ) {
    const message = MessageInput.parse({
      body: input.body,
      requestKey: input.requestKey,
    });
    const contactId = staff(p) ? input.contactId : p.contactId;
    if (!contactId) throw new HttpError(400, "A customer identity is required");
    requireValue(
      await this.db.one(
        "SELECT id FROM contacts WHERE workspace_id=$1 AND id=$2",
        [p.workspaceId, contactId],
      ),
    );
    const channel = input.channelId
      ? await this.db.one(
          "SELECT * FROM channels WHERE workspace_id=$1 AND id=$2",
          [p.workspaceId, input.channelId],
        )
      : await this.db.one(
          "SELECT * FROM channels WHERE workspace_id=$1 AND kind='portal'",
          [p.workspaceId],
        );
    if (!channel || (!staff(p) && !channel.published))
      throw new HttpError(403, "This support channel is not published");
    return this.db.tx(async (q) => {
      await q.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        `${p.workspaceId}:${contactId}:${message.requestKey}`,
      ]);
      const previous = await this.db.one(
        "SELECT c.*,m.body first_body FROM conversations c JOIN messages m ON m.conversation_id=c.id WHERE c.workspace_id=$1 AND c.contact_id=$2 AND m.request_key=$3",
        [p.workspaceId, contactId, message.requestKey],
        q,
      );
      if (previous) {
        if (previous.first_body !== message.body)
          throw new HttpError(
            409,
            "Request key already belongs to a different message",
          );
        delete previous.first_body;
        return previous;
      }
      const conv = (
        await this.db.rows(
          "INSERT INTO conversations(id,workspace_id,contact_id,channel_id,subject) VALUES($1,$2,$3,$4,$5) RETURNING *",
          [
            uid(),
            p.workspaceId,
            contactId,
            channel.id,
            input.subject?.slice(0, 160) ?? message.body.slice(0, 100),
          ],
          q,
        )
      )[0];
      await q.query(
        "INSERT INTO messages(id,workspace_id,conversation_id,role,body,request_key,author_id) VALUES($1,$2,$3,'customer',$4,$5,$6)",
        [
          uid(),
          p.workspaceId,
          conv.id,
          message.body,
          message.requestKey,
          p.userId ?? contactId,
        ],
      );
      await enqueueTurn(this.db, q, conv);
      await this.db.event(
        q,
        p.workspaceId,
        "conversation.created",
        {},
        conv.id,
        true,
      );
      return conv;
    });
  }
  async message(p: Principal, id: string, input: unknown, note = false) {
    if (note) requireStaff(p);
    const data = MessageInput.parse(input);
    return this.db.tx(async (q) => {
      await conversation(this.db, p, id, q);
      const conv = requireValue(
        await this.db.one(
          "SELECT * FROM conversations WHERE workspace_id=$1 AND id=$2 FOR UPDATE",
          [p.workspaceId, id],
          q,
        ),
      );
      const old = await this.db.one(
        "SELECT * FROM messages WHERE workspace_id=$1 AND conversation_id=$2 AND request_key=$3",
        [p.workspaceId, id, data.requestKey],
        q,
      );
      if (old) {
        if (old.body !== data.body)
          throw new HttpError(
            409,
            "Request key already belongs to another message",
          );
        return old;
      }
      const role = note ? "note" : staff(p) ? "staff" : "customer";
      const msg = (
        await this.db.rows(
          "INSERT INTO messages(id,workspace_id,conversation_id,role,body,request_key,author_id) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *",
          [
            uid(),
            p.workspaceId,
            id,
            role,
            data.body,
            data.requestKey,
            p.userId ?? p.contactId,
          ],
          q,
        )
      )[0];
      const next = (
        await this.db.rows(
          "UPDATE conversations SET revision=revision+1,status='open',mode=$1,updated_at=now() WHERE id=$2 RETURNING *",
          [role === "staff" ? "human" : conv.mode, id],
          q,
        )
      )[0];
      await q.query(
        "UPDATE approvals SET status='stale' WHERE run_id IN (SELECT id FROM runs WHERE conversation_id=$1) AND status='pending'",
        [id],
      );
      if (role === "customer" && next.mode === "agent" && !conv.external_id)
        await enqueueTurn(this.db, q, next);
      if (conv.external_id)
        await this.support.queue(q, p.workspaceId, id, {
          body: data.body,
          public: !note,
          customer: role === "customer",
        });
      await this.db.event(
        q,
        p.workspaceId,
        "message.created",
        { messageId: msg.id },
        id,
        !note,
      );
      return msg;
    });
  }
  async control(
    p: Principal,
    id: string,
    input: {
      mode?: "agent" | "human";
      status?: "open" | "resolved";
      assignedTo?: string | null;
      tags?: string[];
      externalAssigneeId?: string;
    },
  ) {
    requireStaff(p);
    return this.db.tx(async (q) => {
      const conv = requireValue(
        await this.db.one(
          "SELECT * FROM conversations WHERE workspace_id=$1 AND id=$2 FOR UPDATE",
          [p.workspaceId, id],
          q,
        ),
      );
      if (
        input.assignedTo &&
        !(await this.db.one(
          "SELECT 1 FROM memberships WHERE workspace_id=$1 AND user_id=$2",
          [p.workspaceId, input.assignedTo],
          q,
        ))
      )
        throw new HttpError(400, "Assignee is not a workspace staff member");
      const result = (
        await this.db.rows(
          "UPDATE conversations SET mode=$1,status=$2,assigned_to=$3,revision=revision+1,updated_at=now() WHERE id=$4 RETURNING *",
          [
            input.mode ?? conv.mode,
            input.status ?? conv.status,
            input.assignedTo === undefined
              ? conv.assigned_to
              : input.assignedTo,
            id,
          ],
          q,
        )
      )[0];
      await q.query(
        "UPDATE approvals SET status='stale' WHERE run_id IN (SELECT id FROM runs WHERE conversation_id=$1) AND status='pending'",
        [id],
      );
      if (input.mode === "agent") await enqueueTurn(this.db, q, result);
      if (
        conv.external_id &&
        (input.status || input.tags || input.externalAssigneeId)
      )
        await this.support.queue(q, p.workspaceId, id, {
          status: input.status === "resolved" ? "solved" : input.status,
          tags: input.tags,
          assigneeId: input.externalAssigneeId,
        });
      await this.db.event(
        q,
        p.workspaceId,
        "conversation.updated",
        { mode: result.mode, status: result.status },
        id,
        true,
      );
      return result;
    });
  }
  async decide(
    p: Principal,
    id: string,
    hash: string,
    decision: "approve" | "reject",
  ) {
    requireAdmin(p);
    return this.db.tx(async (q) => {
      const a = requireValue(
        await this.db.one(
          "SELECT * FROM approvals WHERE workspace_id=$1 AND id=$2 FOR UPDATE",
          [p.workspaceId, id],
          q,
        ),
      );
      if (
        a.status !== "pending" ||
        new Date(a.expires_at).getTime() < Date.now() ||
        a.hash !== hash
      )
        throw new HttpError(
          409,
          "Approval expired, changed, or already has a decision",
        );
      const run = requireValue(
        await this.db.one(
          "SELECT * FROM runs WHERE workspace_id=$1 AND id=$2",
          [p.workspaceId, a.run_id],
          q,
        ),
      );
      const conv = requireValue(
        await this.db.one(
          "SELECT * FROM conversations WHERE workspace_id=$1 AND id=$2",
          [p.workspaceId, run.conversation_id],
          q,
        ),
      );
      if (conv.mode !== "agent" || conv.revision !== run.revision)
        throw new HttpError(
          409,
          "Conversation changed; this approval is stale",
        );
      await this.actions.revalidate(p.workspaceId, a.proposal, q);
      await q.query(
        "UPDATE approvals SET status=$1,decision_by=$2,decision_at=now() WHERE id=$3",
        [decision === "approve" ? "approved" : "rejected", p.userId, id],
      );
      await this.db.enqueue(q, "turn", {
        workspaceId: p.workspaceId,
        runId: a.run_id,
      });
      await this.db.event(
        q,
        p.workspaceId,
        "approval.decided",
        { approvalId: id, decision, actor: p.userId },
        run.conversation_id,
      );
      return { status: decision === "approve" ? "approved" : "rejected" };
    });
  }
  async deleteConversation(ws: string, id: string) {
    await this.db.tx(async (q) => {
      const unknown = await this.db.one(
        "SELECT 1 FROM operations o JOIN runs r ON r.id=o.run_id WHERE r.workspace_id=$1 AND r.conversation_id=$2 AND o.status IN ('prepared','sent','unknown')",
        [ws, id],
        q,
      );
      if (unknown)
        throw new HttpError(
          409,
          "Reconcile unresolved actions before deleting this conversation",
        );
      const runs = await this.db.rows(
        "SELECT id FROM runs WHERE workspace_id=$1 AND conversation_id=$2",
        [ws, id],
        q,
      );
      await q.query(
        "DELETE FROM conversations WHERE workspace_id=$1 AND id=$2",
        [ws, id],
      );
      await q.query(
        "DELETE FROM events WHERE workspace_id=$1 AND conversation_id=$2",
        [ws, id],
      );
      await this.db.enqueue(q, "maintenance", {
        deleteThreads: runs.map((r) => `${ws}:${r.id}`),
      });
    });
  }
  async close() {
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      await this.db.pool.query("DELETE FROM worker_heartbeats WHERE id=$1", [
        this.workerId,
      ]);
    }
    await this.db.close();
  }
}
