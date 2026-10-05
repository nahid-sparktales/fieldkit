import { SupportOptionsInput } from "./support-options.js";
import { Readiness } from "./readiness.js";
import { Attachments } from "./attachments.js";
import { Shadow } from "./shadow.js";
import { Sla } from "./sla.js";
import type { AttachmentScanner } from "./attachment-scanner.js";
import { Customers } from "./customers.js";
import { TicketEmail, queueTicketEmail } from "./ticket-email.js";
import { Quality } from "./quality.js";
import { Branding } from "./branding.js";
import { FeedbackSync } from "./feedback-sync.js";
import type { CodeRunner } from "./code-runner.js";
import type { Config } from "./config.js";
import { Database, uid, type Queryable } from "./db.js";
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
import { Assistance } from "./assistance.js";
import { Workflows } from "./workflows.js";
import { HttpError, requireValue, log } from "./config.js";
import {
  Settings,
  WorkspaceInput,
  MessageInput,
  ChannelInput,
} from "./contracts.js";
import { token, tokenHash, equal, type Fetcher } from "./security.js";

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
  assistance: Assistance;
  workflows: Workflows;
  quality: Quality;
  branding: Branding;
  feedbackSync: FeedbackSync;
  ticketEmail: TicketEmail;
  customers: Customers;
  readiness: Readiness;
  attachments: Attachments;
  sla: Sla;
  shadow: Shadow;
  constructor(
    public config: Config,
    options: {
      mailer?: Mailer;
      fetch?: Fetcher;
      model?: ModelPort;
      runner?: CodeRunner;
      scanner?: AttachmentScanner;
      clock?: () => Date;
    } = {},
  ) {
    this.db = new Database(config);
    this.attachments = new Attachments(this.db, options.scanner);
    this.customers = new Customers(this.db);
    this.branding = new Branding(this.db);
    this.auth = createAuth(this.db, options.mailer);
    this.sla = new Sla(this.db, this.auth.send, options.clock);
    this.db.onEvent = (q, event) => this.sla.observe(q, event);
    this.connections = new Connections(this.db, options.fetch);
    this.ticketEmail = new TicketEmail(
      this.db,
      this.connections,
      this.auth.send,
      (p, id, input) => this.message(p, id, input),
      this.attachments,
    );
    this.ticketEmail.beforeSend = (q, ws, id) => this.sla.emailGuard(q, ws, id);
    this.model = options.model ?? new LiveModel(this.db, this.connections);
    this.knowledge = new Knowledge(this.db, this.connections, this.model);
    this.actions = new Actions(this.db, this.connections);
    this.support = new Support(this.db, this.connections);
    this.assistance = new Assistance(
      this.db,
      this.knowledge,
      this.model,
      this.support,
    );
    this.agent = new Agent(
      this.db,
      this.knowledge,
      this.model,
      this.actions,
      this.support,
      options.runner,
    );
    this.workflows = new Workflows(this.db, this.agent);
    this.quality = new Quality(
      this.db,
      this.agent,
      this.workflows,
      this.knowledge,
      this.model,
      this.connections,
    );
    this.feedbackSync = new FeedbackSync(this.db, this.connections);
    this.feedbackSync.onNegative = (ws, id, key) =>
      this.db.tx((q) =>
        this.quality.occurrence(
          ws,
          id,
          "negative_feedback",
          key,
          undefined,
          undefined,
          q,
        ),
      );
    this.agent.onOutcome = (ws, id, q) => this.quality.captureRun(ws, id, q);
    this.support.onSynced = (ws, id) => this.feedbackSync.queue(ws, id);
    this.readiness = new Readiness(
      this,
      options.model ||
      options.fetch ||
      options.mailer ||
      options.scanner ||
      options.clock
        ? "local_test"
        : "live",
    );
    this.shadow = new Shadow(this);
    this.db.onEvent = async (q, event) => {
      await this.sla.observe(q, event);
      await this.shadow.observe(q, event);
    };
    this.db.onTurn = (q, conv, runId) =>
      this.shadow.captureTurn(q, conv, runId);
    this.db.captureRead = (run, read) => this.shadow.captureRead(run, read);
    this.db.selectWorkflow = (q, conv) => this.shadow.selectWorkflow(q, conv);
    this.db.rolloutAuthority = (run, q) => this.shadow.authority(run, q);
    this.ticketEmail.beforeSend = async (q, ws, id) =>
      (await this.sla.emailGuard(q, ws, id)) &&
      (await this.shadow.emailGuard(q, ws, id));
  }
  async migrate() {
    await this.db.migrate();
    await this.auth.migrate();
  }
  async start() {
    await this.db.boss.start();
  }
  async workers() {
    await this.db.boss.work<{ workspaceId: string; resultId: string }>(
      "shadow",
      { batchSize: 1, localConcurrency: 1 },
      async (jobs) => {
        for (const { data } of jobs)
          await this.shadow.advance(data.workspaceId, data.resultId);
      },
    );
    await this.db.boss.work<{ workspaceId?: string; conversationId?: string }>(
      "sla",
      { batchSize: 1, localConcurrency: 2 },
      async (jobs) => {
        for (const { data } of jobs)
          data.workspaceId && data.conversationId
            ? await this.sla.advance(data.workspaceId, data.conversationId)
            : await (async () => {
                await this.sla.reconcile();
                await this.shadow.reconcile();
              })();
      },
    );
    await this.db.boss.work<{ workspaceId: string; notificationId: string }>(
      "sla-email",
      { batchSize: 1, localConcurrency: 1 },
      async (jobs) => {
        for (const { data } of jobs)
          await this.sla.deliverStaffEmail(
            data.workspaceId,
            data.notificationId,
          );
      },
    );
    await this.db.boss.schedule("sla", "* * * * *", {});
    await this.db.boss.work<{ workspaceId: string; attachmentId: string }>(
      "attachment",
      { batchSize: 1, localConcurrency: this.config.FIELDKIT_ATTACHMENT_SCANS },
      async (jobs) => {
        for (const job of jobs)
          await this.attachments.scan(
            job.data.workspaceId,
            job.data.attachmentId,
          );
      },
    );
    await this.db.boss.work<{ workspaceId: string; runId: string }>(
      "diagnostic",
      { batchSize: 1, localConcurrency: 2 },
      async (jobs) => {
        for (const job of jobs)
          await this.readiness.advance(job.data.workspaceId, job.data.runId);
      },
    );
    const heartbeat = () =>
      this.db.pool
        .query(
          "INSERT INTO worker_heartbeats VALUES($1,now()) ON CONFLICT(id) DO UPDATE SET last_seen=now()",
          [this.workerId],
        )
        .catch((e) => log("worker.heartbeat_failed", { message: e.message }));
    await heartbeat();
    this.heartbeat = setInterval(() => void heartbeat(), 15000);
    await this.db.boss.work<{ workspaceId: string; taskId: string }>(
      "assist",
      { batchSize: 1, localConcurrency: 2 },
      async (jobs) => {
        for (const job of jobs)
          await this.assistance.advance(job.data.workspaceId, job.data.taskId);
      },
    );
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
    await this.db.boss.work<{ workspaceId: string; jobId: string }>(
      "quality",
      { batchSize: 1, localConcurrency: 2 },
      async (jobs) => {
        for (const j of jobs)
          await this.quality.advance(j.data.workspaceId, j.data.jobId);
      },
    );
    await this.db.boss.work<{
      workspaceId: string;
      ticketId?: string;
      path?: string;
    }>("feedback-sync", async (jobs) => {
      for (const j of jobs)
        await this.feedbackSync.advance(
          j.data.workspaceId,
          j.data.ticketId,
          j.data.path,
        );
    });
    await this.db.boss.work<{ workspaceId: string; emailId: string }>(
      "ticket-email",
      async (jobs) => {
        for (const job of jobs)
          await this.ticketEmail.deliver(
            job.data.workspaceId,
            job.data.emailId,
          );
      },
    );
    await this.db.boss.schedule("maintenance", "0 * * * *", {});
  }
  async maintenance() {
    await this.attachments.reconcile();
    await this.shadow.reconcile();
    await this.quality.schedule();
    for (const c of await this.db.rows(
      "SELECT workspace_id FROM connections WHERE provider='zendesk' AND status='connected'",
    ))
      await this.feedbackSync.queue(c.workspace_id);
    for (const source of await this.db.rows(
      "SELECT workspace_id,id FROM sources WHERE active AND kind NOT IN ('file','faq','article') AND status<>'processing'",
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
      await this.quality.retain(ws.id, days);
      await this.readiness.retain(ws.id, days);
      await this.attachments.retain(ws.id, days);
      await this.shadow.retain(ws.id, days);
      await this.db.pool.query(
        "DELETE FROM contact_notes WHERE workspace_id=$1 AND created_at<now()-($2::int*interval '1 day')",
        [ws.id, days],
      );
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
      "Join your team on Navigated Support",
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
    if (data.published)
      await this.validateChannelPublication(
        p.workspaceId,
        channel.kind,
        data.settings.handoff,
      );
    return this.db.tx(async (q) => {
      const current = requireValue(
        await this.db.one(
          "SELECT * FROM channels WHERE workspace_id=$1 AND id=$2 FOR UPDATE",
          [p.workspaceId, id],
          q,
        ),
      );
      return this.saveChannel(
        p,
        current,
        data.published,
        {
          ...data.settings,
          ...(current.kind === "portal"
            ? { ticketsEnabled: current.settings.ticketsEnabled !== false }
            : {}),
        },
        q,
      );
    });
  }
  private async validateChannelPublication(
    ws: string,
    kind: string,
    handoff: string,
  ) {
    await this.readiness.assertPublication(ws);
    if (!this.config.SMTP_URL)
      throw new HttpError(
        409,
        "Configure SMTP before publishing customer-facing channels",
      );
    const settings = Settings.parse(
      requireValue(
        await this.db.one("SELECT settings FROM workspaces WHERE id=$1", [ws]),
      ).settings,
    );
    await this.db.connection(ws, settings.responseProvider);
    await this.connections.embeddingConfig(ws);
    if (handoff === "zendesk" || kind === "zendesk") {
      const connection = await this.db.connection(ws, "zendesk");
      requireValue(
        this.connections.secret(connection).webhookSecret,
        409,
        "Configure the Zendesk webhook signing secret before publishing",
      );
    }
  }
  private async saveChannel(
    p: Principal,
    channel: any,
    published: boolean,
    settings: Record<string, unknown>,
    q: Queryable,
  ) {
    const id = channel.id,
      ws = p.workspaceId;
    const saved = requireValue(
      (
        await this.db.rows(
          "UPDATE channels SET published=$1,settings=$2 WHERE workspace_id=$3 AND id=$4 RETURNING *",
          [published, settings, ws, id],
          q,
        )
      )[0],
    );
    if (!published) {
      await q.query(
        "UPDATE conversations SET mode='human',revision=revision+1 WHERE workspace_id=$1 AND channel_id=$2 AND mode='agent'",
        [ws, id],
      );
      await q.query(
        "UPDATE approvals SET status='stale' WHERE status='pending' AND run_id IN (SELECT r.id FROM runs r JOIN conversations c ON c.id=r.conversation_id WHERE c.workspace_id=$1 AND c.channel_id=$2)",
        [ws, id],
      );
      if (channel.kind === "widget")
        await q.query(
          "DELETE FROM credentials WHERE workspace_id=$1 AND kind='widget'",
          [ws],
        );
    }
    await this.db.event(q, ws, "channel.updated", {
      channelId: id,
      published,
      actor: p.userId,
    });
    return saved;
  }
  async updateSupportOptions(p: Principal, input: unknown) {
    requireOwner(p);
    const { mode } = SupportOptionsInput.parse(input);
    const ticketsEnabled = mode === "both" || mode === "tickets";
    const chatEnabled = mode === "both" || mode === "chat";
    return this.db.tx(async (q) => {
      const channels = await this.db.rows(
        "SELECT * FROM channels WHERE workspace_id=$1 AND kind IN ('portal','widget') ORDER BY kind FOR UPDATE",
        [p.workspaceId],
        q,
      );
      const portal = requireValue(channels.find((c) => c.kind === "portal"));
      const widget = requireValue(channels.find((c) => c.kind === "widget"));
      if (chatEnabled && !widget.published)
        await this.validateChannelPublication(
          p.workspaceId,
          "widget",
          widget.settings.handoff,
        );
      await q.query(
        "UPDATE channels SET settings=jsonb_set(settings,'{ticketsEnabled}',$1::jsonb) WHERE id=$2",
        [JSON.stringify(ticketsEnabled), portal.id],
      );
      if (widget.published !== chatEnabled)
        await this.saveChannel(p, widget, chatEnabled, widget.settings, q);
      await this.db.event(q, p.workspaceId, "support_options.updated", {
        mode,
        actor: p.userId,
      });
      return { mode };
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
      attachments?: string[];
    },
  ) {
    const message = MessageInput.parse({
      body: input.body,
      requestKey: input.requestKey,
      attachments: input.attachments,
    });
    const contactId = staff(p) ? input.contactId : p.contactId;
    if (!contactId) throw new HttpError(400, "A customer identity is required");
    requireValue(
      await this.db.one(
        "SELECT id FROM contacts WHERE workspace_id=$1 AND id=$2",
        [p.workspaceId, contactId],
      ),
    );
    return this.db.tx(async (q) => {
      const channel = input.channelId
        ? await this.db.one(
            "SELECT * FROM channels WHERE workspace_id=$1 AND id=$2 FOR SHARE",
            [p.workspaceId, input.channelId],
            q,
          )
        : await this.db.one(
            "SELECT * FROM channels WHERE workspace_id=$1 AND kind='portal' FOR SHARE",
            [p.workspaceId],
            q,
          );
      if (!channel || (!staff(p) && !channel.published))
        throw new HttpError(403, "This support channel is not published");
      if (
        !staff(p) &&
        ((p.channelId && p.channelId !== channel.id) ||
          (channel.kind === "portal" && p.role !== "customer"))
      )
        throw new HttpError(
          403,
          "Sign in with a verified account to submit a ticket",
        );
      if (
        !staff(p) &&
        channel.kind === "portal" &&
        channel.settings.ticketsEnabled === false
      )
        throw new HttpError(
          403,
          "New support tickets are not available. You can still reply to an existing request.",
        );
      await q.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        `${p.workspaceId}:${contactId}:${message.requestKey}`,
      ]);
      const previous = await this.db.one(
        "SELECT c.*,m.body first_body,m.id first_message_id FROM conversations c JOIN messages m ON m.conversation_id=c.id WHERE c.workspace_id=$1 AND c.contact_id=$2 AND m.request_key=$3",
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
        await this.attachments.verifyBinding(
          p.workspaceId,
          previous.first_message_id,
          message.attachments,
          q,
        );
        delete previous.first_message_id;
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
            input.subject?.slice(0, 160) ??
              (message.body.slice(0, 100) || "Files for the support team"),
          ],
          q,
        )
      )[0];
      const firstMessageId = uid();
      await q.query(
        "INSERT INTO messages(id,workspace_id,conversation_id,role,body,request_key,author_id) VALUES($1,$2,$3,'customer',$4,$5,$6)",
        [
          firstMessageId,
          p.workspaceId,
          conv.id,
          message.body,
          message.requestKey,
          p.userId ?? contactId,
        ],
      );
      await this.attachments.bind(
        p,
        conv,
        firstMessageId,
        message.attachments,
        false,
        q,
      );
      if (message.body) await enqueueTurn(this.db, q, conv);
      else {
        await q.query("UPDATE conversations SET mode='human' WHERE id=$1", [
          conv.id,
        ]);
        conv.mode = "human";
        await this.db.event(
          q,
          p.workspaceId,
          "attachment.staff_review_required",
          {},
          conv.id,
          true,
        );
      }
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
        await this.attachments.verifyBinding(
          p.workspaceId,
          old.id,
          data.attachments,
          q,
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
      await this.attachments.bind(p, conv, msg.id, data.attachments, note, q);
      if (note) {
        if (conv.external_id)
          await this.support.queue(q, p.workspaceId, id, {
            body: data.body,
            messageId: msg.id,
            public: false,
            customer: false,
          });
        await this.db.event(
          q,
          p.workspaceId,
          "message.created",
          { messageId: msg.id, actorType: "note" },
          id,
          false,
        );
        return msg;
      }
      if (!conv.external_id && role === "staff")
        await q.query("UPDATE messages SET delivered_at=now() WHERE id=$1", [
          msg.id,
        ]);
      if (!conv.external_id && role === "staff")
        await queueTicketEmail(this.db, q, p.workspaceId, msg.id);
      const next = (
        await this.db.rows(
          "UPDATE conversations SET revision=revision+1,status='open',mode=$1,updated_at=now() WHERE id=$2 RETURNING *",
          [role === "staff" || !data.body ? "human" : conv.mode, id],
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
          messageId: msg.id,
          public: !note,
          customer: role === "customer",
        });
      await this.db.event(
        q,
        p.workspaceId,
        "message.created",
        {
          messageId: msg.id,
          previousStatus: conv.status,
          status: "open",
          actorType: role,
        },
        id,
        !note,
      );
      return msg;
    });
  }
  async customerStatus(p: Principal, id: string, status: "open" | "resolved") {
    if (!["customer", "visitor"].includes(p.role))
      throw new HttpError(403, "Customer access required");
    return this.db.tx(async (q) => {
      const conv = await conversation(this.db, p, id, q);
      if (conv.external_id)
        throw new HttpError(
          409,
          "This ticket is managed by the support team in Zendesk",
        );
      const next = requireValue(
        await this.db.one(
          "UPDATE conversations SET status=$3,revision=revision+1,updated_at=now() WHERE workspace_id=$1 AND id=$2 RETURNING *",
          [p.workspaceId, id, status],
          q,
        ),
      );
      await q.query(
        "UPDATE approvals SET status='stale' WHERE status='pending' AND run_id IN (SELECT id FROM runs WHERE conversation_id=$1)",
        [id],
      );
      await this.db.event(
        q,
        p.workspaceId,
        "conversation.updated",
        { previousStatus: conv.status, status, actorType: "customer" },
        id,
        true,
      );
      return next;
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
        {
          mode: result.mode,
          status: result.status,
          previousStatus: conv.status,
          previousMode: conv.mode,
          actorType: "staff",
          ...(input.mode === "human"
            ? { handoffCategory: "staff_takeover" }
            : {}),
        },
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
      if (decision === "approve")
        await this.actions.revalidate(p.workspaceId, a.proposal, q);
      await q.query(
        "UPDATE approvals SET status=$1,decision_by=$2,decision_at=now() WHERE id=$3",
        [decision === "approve" ? "approved" : "rejected", p.userId, id],
      );
      if (decision === "approve") {
        await this.db.enqueue(q, "turn", {
          workspaceId: p.workspaceId,
          runId: a.run_id,
        });
      } else {
        // A staff rejection is an internal decision, never a customer reply.
        const changed = await q.query(
          "UPDATE conversations SET mode='human',status='needs_staff',revision=revision+1,updated_at=now() WHERE workspace_id=$1 AND id=$2 AND mode='agent' AND revision=$3 RETURNING id",
          [p.workspaceId, conv.id, run.revision],
        );
        if (!changed.rowCount)
          throw new HttpError(
            409,
            "Conversation changed; this approval is stale",
          );
        await q.query(
          "UPDATE runs SET status='handed_off',state=$2,updated_at=now() WHERE id=$1",
          [
            run.id,
            {
              ...run.state,
              route: "handoff",
              response: "",
              error: "Action proposal rejected by staff",
              rejectionId: id,
            },
          ],
        );
        await this.db.event(
          q,
          p.workspaceId,
          "conversation.updated",
          {
            previousStatus: conv.status,
            status: "needs_staff",
            previousMode: conv.mode,
            mode: "human",
            actorType: "staff",
            runId: run.id,
            workflowVersion: run.workflow_version ?? null,
            handoffCategory: "staff_review",
            handoffReason: "Action proposal rejected by staff",
          },
          conv.id,
          true,
        );
      }
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
      await this.quality.forgetConversation(ws, id, q);
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
