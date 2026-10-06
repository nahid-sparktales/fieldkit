import { z } from "zod";
import { Database, uid, type Queryable } from "./db.js";
import { HttpError, requireValue } from "./config.js";
import { conversation, requireStaff, type Principal } from "./auth.js";
import {
  refreshPrincipal,
  resolveStaffPrincipal,
  requireCapability,
} from "./permissions.js";
import {
  AssistanceInput,
  FaqSuggestions,
  Settings,
  SupportSuggestion,
  type Citation,
} from "./contracts.js";
import type { ModelPort, SupportModelInput } from "./model.js";
import type { Knowledge } from "./knowledge.js";
import type { Support } from "./support.js";

const citation = (r: any): Citation => ({
  id: r.id,
  documentId: r.document_id,
  sourceId: r.source_id,
  title: r.title,
  version: r.version,
  excerpt: r.body,
  ...(r.locator ? { url: r.locator } : {}),
});
const adminTask = (kind: string) => ["faq_review", "article"].includes(kind);
export const AssistanceApply = z
  .object({
    title: z.string().trim().min(1).max(200),
    body: z.string().trim().min(1).max(12000),
    priority: z.enum(["low", "normal", "high", "urgent"]),
    category: z.string().trim().max(80),
  })
  .strict();

export class Assistance {
  constructor(
    public db: Database,
    public knowledge: Knowledge,
    public model: ModelPort,
    public support: Support,
  ) {}

  private permissions(p: Principal, kind: string, readOnly = false) {
    requireStaff(p);
    requireCapability(p, "assistance:use");
    requireCapability(p, "knowledge:read");
    if (adminTask(kind) && !readOnly) requireCapability(p, "knowledge:manage");
    if (kind === "faq_review") {
      if (p.ticketScope && p.ticketScope !== "all")
        throw new HttpError(
          403,
          "Workspace assistance requires access to all tickets",
        );
    } else {
      requireCapability(p, "tickets:read");
      if (kind === "response") {
        if (!readOnly) requireCapability(p, "tickets:reply");
      } else {
        // These existing workflows include private notes and system history.
        // Do not expose an older full-context result to a narrower reader.
        requireCapability(p, "tickets:note");
        requireCapability(p, "audit:read");
      }
      if (kind === "triage" && !readOnly)
        requireCapability(p, "tickets:update");
    }
  }

  private async actor(
    p: Principal,
    kind: string,
    conversationId?: string | null,
    q?: Queryable,
  ) {
    requireStaff(p);
    p = await refreshPrincipal(this.db, p, q);
    this.permissions(p, kind);
    if (conversationId) await conversation(this.db, p, conversationId, q);
    return p;
  }

  async list(p: Principal, conversationId: string | null = null) {
    requireStaff(p);
    p = await refreshPrincipal(this.db, p);
    requireCapability(p, "assistance:use");
    requireCapability(p, "knowledge:read");
    if (conversationId) await conversation(this.db, p, conversationId);
    else this.permissions(p, "faq_review", true);
    const rows = await this.db.rows(
      "SELECT * FROM assistance_tasks WHERE workspace_id=$1 AND conversation_id IS NOT DISTINCT FROM $2 ORDER BY created_at DESC LIMIT 30",
      [p.workspaceId, conversationId],
    );
    return rows.filter((task) => {
      try {
        this.permissions(p, task.kind, true);
        return true;
      } catch (error) {
        if (error instanceof HttpError && error.status === 403) return false;
        throw error;
      }
    });
  }

  async start(p: Principal, raw: unknown) {
    requireStaff(p);
    const input = AssistanceInput.parse(raw),
      ws = p.workspaceId;
    p = await this.actor(p, input.kind, input.conversationId);
    if ((input.kind === "faq_review") === Boolean(input.conversationId))
      throw new HttpError(
        400,
        "Choose a conversation for a support workflow, or no conversation for a document review.",
      );
    const settings = Settings.parse(
      requireValue(
        await this.db.one("SELECT settings FROM workspaces WHERE id=$1", [ws]),
      ).settings,
    );
    await this.db.connection(ws, settings.responseProvider);
    return this.db.tx(async (q) => {
      p = await this.actor(p, input.kind, input.conversationId, q);
      await q.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        `assist-start:${ws}`,
      ]);
      if (
        await this.db.one(
          "SELECT id FROM assistance_tasks WHERE workspace_id=$1 AND kind=$2 AND conversation_id IS NOT DISTINCT FROM $3 AND status IN ('queued','running')",
          [ws, input.kind, input.conversationId ?? null],
          q,
        )
      )
        throw new HttpError(
          409,
          "This workflow is already running. Follow its progress below.",
        );
      const conv = input.conversationId
        ? requireValue(
            await this.db.one(
              "SELECT * FROM conversations WHERE workspace_id=$1 AND id=$2 FOR SHARE",
              [ws, input.conversationId],
              q,
            ),
          )
        : null;
      if (input.kind === "article" && conv?.status !== "resolved")
        throw new HttpError(
          409,
          "Resolve the ticket before turning it into an article.",
        );
      const id = uid();
      await q.query(
        "INSERT INTO assistance_tasks(id,workspace_id,conversation_id,conversation_revision,created_by,kind,instructions) VALUES($1,$2,$3,$4,$5,$6,$7)",
        [
          id,
          ws,
          conv?.id ?? null,
          conv?.revision ?? null,
          p.userId,
          input.kind,
          input.instructions,
        ],
      );
      if (input.kind === "faq_review") {
        // Snapshot every indexed passage; each worker job reads at most eight passages.
        await q.query(
          `INSERT INTO assistance_batches(task_id,position,document_id,source_revision,chunk_ids)
          SELECT $2,(row_number() OVER (ORDER BY d.id,floor(c.position/8)))::int,d.id,s.revision,array_agg(c.id ORDER BY c.position)
          FROM chunks c JOIN documents d ON d.id=c.document_id JOIN sources s ON s.id=d.source_id
          WHERE c.workspace_id=$1 AND d.active AND s.active AND s.status='ready' AND s.visibility='customer' AND s.kind<>'faq'
          GROUP BY d.id,s.revision,floor(c.position/8)`,
          [ws, id],
        );
        const totals = (await this.db.one(
          "SELECT count(*)::int total,count(DISTINCT document_id)::int docs FROM assistance_batches WHERE task_id=$1",
          [id],
          q,
        ))!;
        if (!totals.total)
          throw new HttpError(
            409,
            "Add and approve documents for customer answers before starting a full review.",
          );
        await q.query(
          "UPDATE assistance_tasks SET total=$2,document_count=$3,output=$4 WHERE id=$1",
          [id, totals.total, totals.docs, { generated: 0 }],
        );
      }
      await this.db.enqueue(q, "assist", { workspaceId: ws, taskId: id });
      await this.db.event(
        q,
        ws,
        "assistance.started",
        { taskId: id, kind: input.kind, actor: p.userId },
        conv?.id,
      );
      return this.db.one("SELECT * FROM assistance_tasks WHERE id=$1", [id], q);
    });
  }

  async authorize(task: any, q?: Queryable) {
    try {
      const p = await resolveStaffPrincipal(
        this.db,
        task.workspace_id,
        task.created_by,
        q,
      );
      return await this.actor(p, task.kind, task.conversation_id, q);
    } catch (error) {
      if (!(error instanceof HttpError) || ![403, 404].includes(error.status))
        throw error;
      throw new HttpError(
        403,
        "The person who started this workflow no longer has the required access.",
      );
    }
  }

  async control(p: Principal, id: string, action: "cancel" | "retry") {
    requireStaff(p);
    return this.db.tx(async (q) => {
      if (action === "retry")
        await q.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
          `assist-start:${p.workspaceId}`,
        ]);
      const task = requireValue(
        await this.db.one(
          "SELECT * FROM assistance_tasks WHERE workspace_id=$1 AND id=$2 FOR UPDATE",
          [p.workspaceId, id],
          q,
        ),
      );
      p = await this.actor(p, task.kind, task.conversation_id, q);
      if (action === "retry") {
        if (task.status !== "failed")
          throw new HttpError(409, "Only failed workflows can be retried.");
        if (
          await this.db.one(
            "SELECT id FROM assistance_tasks WHERE workspace_id=$1 AND kind=$2 AND conversation_id IS NOT DISTINCT FROM $3 AND status IN ('queued','running')",
            [p.workspaceId, task.kind, task.conversation_id],
            q,
          )
        )
          throw new HttpError(409, "A newer workflow is already running.");
        await q.query(
          "UPDATE assistance_tasks SET status='queued',error=null,created_by=$2,updated_at=now() WHERE id=$1",
          [id, p.userId],
        );
        await this.db.enqueue(q, "assist", {
          workspaceId: p.workspaceId,
          taskId: id,
        });
      } else {
        if (!["queued", "running", "failed"].includes(task.status))
          throw new HttpError(409, "This workflow has already finished.");
        await q.query(
          "UPDATE assistance_tasks SET status='cancelled',updated_at=now() WHERE id=$1",
          [id],
        );
      }
      await this.db.event(
        q,
        p.workspaceId,
        `assistance.${action}`,
        { taskId: id, actor: p.userId },
        task.conversation_id,
      );
      return { status: action === "retry" ? "queued" : "cancelled" };
    });
  }

  async advance(ws: string, id: string) {
    const lock = await this.db.pool.connect();
    const key = `assist:${id}`;
    let acquired = false;
    try {
      acquired = (
        await lock.query(
          "SELECT pg_try_advisory_lock(hashtextextended($1,0)) ok",
          [key],
        )
      ).rows[0].ok;
      // Acknowledge only after processing: the next batch can be delivered before
      // the previous worker releases its lock, so let pg-boss retry that job.
      if (!acquired) throw new Error("Workflow is busy; retry this job");
      const task = await this.db.one(
        "SELECT * FROM assistance_tasks WHERE workspace_id=$1 AND id=$2",
        [ws, id],
      );
      if (!task || !["queued", "running"].includes(task.status)) return;
      try {
        await this.authorize(task);
        await this.db.pool.query(
          "UPDATE assistance_tasks SET status='running',updated_at=now() WHERE id=$1 AND status IN ('queued','running')",
          [id],
        );
        if (task.kind === "faq_review") await this.reviewBatch(task);
        else await this.draftSupport(task);
      } catch (error) {
        await this.db.pool.query(
          "UPDATE assistance_tasks SET status='failed',error=$2,updated_at=now() WHERE id=$1 AND status IN ('queued','running')",
          [
            id,
            error instanceof Error
              ? error.message.slice(0, 1000)
              : "Workflow failed",
          ],
        );
      }
    } finally {
      if (acquired)
        await lock.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [
          key,
        ]);
      lock.release();
    }
  }

  async reviewBatch(task: any) {
    await this.authorize(task);
    const ws = task.workspace_id;
    const batch = requireValue(
      await this.db.one(
        "SELECT * FROM assistance_batches WHERE task_id=$1 AND NOT done ORDER BY position LIMIT 1",
        [task.id],
      ),
    );
    const rows = await this.db.rows(
      `SELECT c.*,d.source_id,d.title,d.version,d.locator FROM chunks c JOIN documents d ON d.id=c.document_id JOIN sources s ON s.id=d.source_id
      WHERE c.workspace_id=$1 AND c.id=ANY($2::text[]) AND d.active AND s.active AND s.status='ready' AND s.visibility='customer' AND s.revision=$3 ORDER BY c.position`,
      [ws, batch.chunk_ids, batch.source_revision],
    );
    if (rows.length !== batch.chunk_ids.length)
      throw new HttpError(
        409,
        "A document changed or lost approval during review. Cancel this run and start a fresh review.",
      );
    const evidence = rows.map(citation);
    const existing = await this.db.rows(
      "SELECT title FROM sources WHERE workspace_id=$1 AND kind='faq' ORDER BY id DESC LIMIT 200",
      [ws],
    );
    const settings = Settings.parse(
      requireValue(
        await this.db.one("SELECT settings FROM workspaces WHERE id=$1", [ws]),
      ).settings,
    );
    const drafts = FaqSuggestions.parse({
      faqs: await this.model.faqs({
        workspaceId: ws,
        model: settings.model,
        count: 3,
        instructions: `Review every supplied passage for useful FAQs. Omit topics already covered by existing questions. ${task.instructions}`,
        question: "",
        answer: "",
        evidence,
        existingQuestions: existing.map((r) => r.title),
      }),
    }).faqs;
    if (
      drafts.length > 3 ||
      drafts.some(
        (d) =>
          !d.citationIds.length ||
          d.citationIds.some((id) => !evidence.some((e) => e.id === id)),
      )
    )
      throw new HttpError(
        502,
        "AI returned unsupported FAQ drafts. This batch was not saved.",
      );
    await this.db.tx(async (q) => {
      const current = await this.db.one(
        "SELECT * FROM assistance_tasks WHERE id=$1 FOR UPDATE",
        [task.id],
        q,
      );
      if (!current || current.status !== "running") return;
      await this.authorize(current, q);
      if (!(await this.knowledge.validEvidence(ws, evidence, q)))
        throw new HttpError(
          409,
          "Document access changed during review. Start a fresh review.",
        );
      if (
        !(await this.db.one(
          "SELECT s.id FROM sources s JOIN documents d ON d.source_id=s.id WHERE d.id=$1 AND s.revision=$2",
          [batch.document_id, batch.source_revision],
          q,
        ))
      )
        throw new HttpError(
          409,
          "A source changed during review. Start a fresh review.",
        );
      const seen = new Set(
        (
          await this.db.rows(
            "SELECT lower(trim(title)) title FROM sources WHERE workspace_id=$1 AND kind='faq'",
            [ws],
            q,
          )
        ).map((r) => r.title),
      );
      const unique = drafts.filter((d) => {
        const key = d.question.trim().toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      const faqs = await this.knowledge.createFaqs(
        ws,
        unique,
        true,
        evidence,
        q,
      );
      for (const faq of faqs)
        await q.query(
          "UPDATE sources SET metadata=metadata||$2::jsonb WHERE id=$1",
          [faq!.id, JSON.stringify({ reviewTaskId: task.id })],
        );
      await q.query(
        "UPDATE assistance_batches SET done=true WHERE task_id=$1 AND position=$2",
        [task.id, batch.position],
      );
      const done = current.completed + 1;
      await q.query(
        "UPDATE assistance_tasks SET completed=$2,status=$3,output=$4,updated_at=now() WHERE id=$1",
        [
          task.id,
          done,
          done === current.total ? "completed" : "queued",
          { generated: (current.output.generated ?? 0) + faqs.length },
        ],
      );
      if (done < current.total)
        await this.db.enqueue(q, "assist", {
          workspaceId: ws,
          taskId: task.id,
        });
      await this.db.event(q, ws, "assistance.progress", {
        taskId: task.id,
        completed: done,
        total: current.total,
      });
    });
  }

  async draftSupport(task: any) {
    const principal = await this.authorize(task);
    const ws = task.workspace_id,
      customerSafe = task.kind === "response";
    const conv = await conversation(this.db, principal, task.conversation_id);
    if (conv.revision !== task.conversation_revision)
      throw new HttpError(
        409,
        "The conversation changed. Start a new workflow with its latest messages.",
      );
    const messages = await this.db.rows(
      "SELECT id,role,body FROM messages WHERE workspace_id=$1 AND conversation_id=$2 AND ($3::boolean=false OR role IN ('customer','staff','assistant')) ORDER BY created_at,id",
      [ws, conv.id, customerSafe],
    );
    // Be explicit about limits: never silently omit ticket history.
    if (
      messages.reduce((sum, m) => sum + Buffer.byteLength(m.body), 0) > 100000
    )
      throw new HttpError(
        413,
        "This conversation is too long for one workflow. Use a shorter follow-up ticket with a reviewed summary.",
      );
    const query = `${conv.subject} ${messages
      .filter((m) => m.role === "customer")
      .slice(-3)
      .map((m) => m.body)
      .join(" ")} ${task.instructions}`.slice(0, 6000);
    const embeddingConfig =
      await this.knowledge.connections.embeddingConfig(ws);
    const [embedding] = await this.model.embed(ws, [query], embeddingConfig);
    const rows = await this.db.rows(
      `WITH ranked AS (
      SELECT c.*,d.source_id,d.title,d.version,d.locator,s.visibility,
      (1-(c.embedding<=>$3::vector))+ts_rank_cd(c.search,websearch_to_tsquery('english',$2)) score,
      row_number() OVER (PARTITION BY s.id ORDER BY (1-(c.embedding<=>$3::vector))+ts_rank_cd(c.search,websearch_to_tsquery('english',$2)) DESC) source_rank
      FROM chunks c JOIN documents d ON d.id=c.document_id JOIN sources s ON s.id=d.source_id
      WHERE c.workspace_id=$1 AND d.active AND s.active AND s.status='ready' AND ($4::boolean=false OR s.visibility='customer') AND c.embedding_model=$5
    ) SELECT * FROM ranked ORDER BY source_rank,score DESC,id LIMIT 24`,
      [ws, query, JSON.stringify(embedding), customerSafe, embeddingConfig.key],
    );
    const evidence = rows.map(citation);
    const coverage = await this.db.rows(
      "SELECT s.kind,count(DISTINCT s.id)::int sources FROM sources s JOIN documents d ON d.source_id=s.id WHERE s.workspace_id=$1 AND s.active AND d.active AND s.status='ready' AND ($2::boolean=false OR s.visibility='customer') GROUP BY s.kind",
      [ws, customerSafe],
    );
    const settings = Settings.parse(
      requireValue(
        await this.db.one("SELECT settings FROM workspaces WHERE id=$1", [ws]),
      ).settings,
    );
    await this.authorize(task);
    const draft = SupportSuggestion.parse(
      await this.model.assist({
        workspaceId: ws,
        model: settings.model,
        kind: task.kind as SupportModelInput["kind"],
        subject: conv.subject,
        messages,
        evidence,
        instructions: task.instructions,
      }),
    );
    const allowed = new Set([
      ...evidence.map((e) => e.id),
      ...messages.map((m) => m.id),
    ]);
    if (
      !draft.citationIds.length ||
      draft.citationIds.some((id) => !allowed.has(id))
    )
      throw new HttpError(
        502,
        "The draft did not cite valid evidence. Nothing was applied.",
      );
    await this.db.tx(async (q) => {
      const current = await this.db.one(
        "SELECT * FROM assistance_tasks WHERE id=$1 FOR UPDATE",
        [task.id],
        q,
      );
      if (!current || current.status !== "running") return;
      await this.authorize(current, q);
      const latest = requireValue(
        await this.db.one(
          "SELECT revision FROM conversations WHERE id=$1 FOR SHARE",
          [conv.id],
          q,
        ),
      );
      if (latest.revision !== task.conversation_revision)
        throw new HttpError(
          409,
          "The conversation changed while AI was working. Generate a fresh draft.",
        );
      if (!(await this.knowledge.validEvidence(ws, evidence, q, !customerSafe)))
        throw new HttpError(
          409,
          "Knowledge changed while AI was working. Generate a fresh draft.",
        );
      const citations = [
        ...evidence
          .filter((e) => draft.citationIds.includes(e.id))
          .map((e) => ({
            ...e,
            visibility: rows.find((r) => r.id === e.id)?.visibility,
          })),
        ...messages
          .filter((m) => draft.citationIds.includes(m.id))
          .map((m) => ({
            id: m.id,
            title: `Conversation · ${m.role}`,
            excerpt: m.body,
          })),
      ];
      await q.query(
        "UPDATE assistance_tasks SET status='completed',completed=1,output=$2,updated_at=now() WHERE id=$1",
        [task.id, { draft, citations, evidence, coverage, applied: false }],
      );
      await this.db.event(
        q,
        ws,
        "assistance.completed",
        { taskId: task.id, kind: task.kind },
        conv.id,
      );
    });
  }

  async apply(p: Principal, id: string, raw: unknown) {
    requireStaff(p);
    const input = AssistanceApply.parse(raw),
      ws = p.workspaceId;
    return this.db.tx(async (q) => {
      const task = requireValue(
        await this.db.one(
          "SELECT * FROM assistance_tasks WHERE workspace_id=$1 AND id=$2 FOR UPDATE",
          [ws, id],
          q,
        ),
      );
      if (!["triage", "article"].includes(task.kind))
        throw new HttpError(
          400,
          "Review this result in the reply or internal-note composer.",
        );
      p = await this.actor(p, task.kind, task.conversation_id, q);
      if (task.output.applied) return task.output;
      if (task.status !== "completed")
        throw new HttpError(409, "Wait for the workflow to complete.");
      const conv = requireValue(
        await this.db.one(
          "SELECT * FROM conversations WHERE workspace_id=$1 AND id=$2 FOR UPDATE",
          [ws, task.conversation_id],
          q,
        ),
      );
      if (conv.revision !== task.conversation_revision)
        throw new HttpError(
          409,
          "The conversation changed. Generate a fresh draft before applying it.",
        );
      if (
        !(await this.knowledge.validEvidence(ws, task.output.evidence, q, true))
      )
        throw new HttpError(
          409,
          "Knowledge changed. Generate a fresh draft before applying it.",
        );
      let sourceId: string | undefined;
      if (task.kind === "triage") {
        await q.query(
          "UPDATE conversations SET priority=$2,category=$3,revision=revision+1,updated_at=now() WHERE id=$1",
          [conv.id, input.priority, input.category],
        );
        await q.query(
          "UPDATE approvals SET status='stale' WHERE status='pending' AND run_id IN (SELECT id FROM runs WHERE conversation_id=$1)",
          [conv.id],
        );
        if (conv.external_id)
          await this.support.queue(q, ws, conv.id, {
            priority: input.priority,
          });
      } else {
        if (conv.status !== "resolved")
          throw new HttpError(
            409,
            "Resolve this ticket before saving an article.",
          );
        sourceId = uid();
        await q.query(
          "INSERT INTO sources(id,workspace_id,kind,title,locator,metadata) VALUES($1,$2,'article',$3,$1,$4)",
          [
            sourceId,
            ws,
            input.title,
            { answer: input.body, fromTask: task.id },
          ],
        );
        await this.db.enqueue(q, "ingest", { workspaceId: ws, sourceId });
      }
      const output = {
        ...task.output,
        applied: true,
        appliedBy: p.userId,
        ...(sourceId ? { sourceId } : {}),
      };
      await q.query(
        "UPDATE assistance_tasks SET output=$2,updated_at=now() WHERE id=$1",
        [id, output],
      );
      await this.db.event(
        q,
        ws,
        "assistance.applied",
        { taskId: id, kind: task.kind, actor: p.userId, sourceId },
        conv.id,
      );
      return output;
    });
  }

  async compose(p: Principal, id: string, raw: unknown) {
    requireStaff(p);
    const { body } = z
      .object({ body: z.string().trim().min(1).max(12000) })
      .strict()
      .parse(raw);
    return this.db.tx(async (q) => {
      const task = requireValue(
        await this.db.one(
          "SELECT * FROM assistance_tasks WHERE workspace_id=$1 AND id=$2 FOR SHARE",
          [p.workspaceId, id],
          q,
        ),
      );
      p = await this.actor(p, task.kind, task.conversation_id, q);
      if (
        task.status !== "completed" ||
        !["research", "response", "escalation"].includes(task.kind)
      )
        throw new HttpError(
          409,
          "Choose a completed reply, research or escalation workflow.",
        );
      const conv = requireValue(
        await this.db.one(
          "SELECT revision FROM conversations WHERE workspace_id=$1 AND id=$2 FOR SHARE",
          [p.workspaceId, task.conversation_id],
          q,
        ),
      );
      if (conv.revision !== task.conversation_revision)
        throw new HttpError(
          409,
          "The conversation changed. Generate a fresh draft.",
        );
      if (
        !(await this.knowledge.validEvidence(
          p.workspaceId,
          task.output.evidence,
          q,
          task.kind !== "response",
        ))
      )
        throw new HttpError(
          409,
          "Knowledge access changed. Generate a fresh draft.",
        );
      return { body, internal: task.kind !== "response" };
    });
  }
}
