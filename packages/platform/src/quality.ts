import { z } from "zod";
import { Database, uid, type Queryable } from "./db.js";
import {
  requireAdmin,
  requireOwner,
  requireStaff,
  conversation,
  type Principal,
} from "./auth.js";
import { HttpError, requireValue } from "./config.js";
import { digest } from "./security.js";
import { Settings, type Citation } from "./contracts.js";
import {
  SuiteInput,
  EvaluationInput,
  TestCase,
  JudgeResult,
  GapSuggestion,
  FeedbackInput,
  GapUpdate,
  AnalysisInput,
  QualitySettings,
} from "./quality-contracts.js";
import { usageContext } from "./usage-context.js";
import type { Agent } from "./agent.js";
import type { Workflows } from "./workflows.js";
import type { Knowledge } from "./knowledge.js";
import type { ModelPort } from "./model.js";
import type { Connections } from "./connections.js";

type Row = Record<string, any>;
export class Quality {
  constructor(
    public db: Database,
    public agent: Agent,
    public workflows: Workflows,
    public knowledge: Knowledge,
    public model: ModelPort,
    public connections: Connections,
  ) {}
  async catalog(ws: string) {
    return digest(
      await this.db.rows(
        "SELECT s.id,s.revision,s.visibility,s.status,d.id document,d.version FROM sources s LEFT JOIN documents d ON d.source_id=s.id AND d.active WHERE s.workspace_id=$1 AND s.active AND s.status='ready' AND s.visibility='customer' ORDER BY s.id,d.id",
        [ws],
      ),
    );
  }
  async settings(p: Principal, raw?: unknown) {
    requireStaff(p);
    if (raw !== undefined) {
      requireOwner(p);
      const d = QualitySettings.parse(raw);
      await this.db.pool.query(
        "INSERT INTO quality_settings(workspace_id,nightly,daily_token_cap,configured_by) VALUES($1,$2,$3,$4) ON CONFLICT(workspace_id) DO UPDATE SET nightly=$2,daily_token_cap=$3,configured_by=$4",
        [p.workspaceId, d.nightly, d.dailyTokenCap, p.userId],
      );
    }
    return (
      (await this.db.one(
        "SELECT * FROM quality_settings WHERE workspace_id=$1",
        [p.workspaceId],
      )) ?? { nightly: false, daily_token_cap: 0, sync_error: null }
    );
  }
  async suites(p: Principal) {
    requireStaff(p);
    return this.db.rows(
      "SELECT * FROM evaluation_suites WHERE workspace_id=$1 ORDER BY updated_at DESC",
      [p.workspaceId],
    );
  }
  async saveSuite(p: Principal, raw: unknown, id?: string) {
    requireAdmin(p);
    const d = SuiteInput.parse(raw);
    if (new Set(d.cases.map((c) => c.id)).size !== d.cases.length)
      throw new HttpError(400, "Case IDs must be unique");
    for (const c of d.cases) {
      if (c.sourceConversationId) {
        await conversation(this.db, p, c.sourceConversationId);
        if (!c.personalDataReviewed)
          throw new HttpError(
            400,
            "Review copied personal information before saving an imported case",
          );
      }
      if (c.gapId)
        requireValue(
          await this.db.one(
            "SELECT id FROM knowledge_gaps WHERE workspace_id=$1 AND id=$2",
            [p.workspaceId, c.gapId],
          ),
        );
    }
    const row = id
      ? await this.db.one(
          "UPDATE evaluation_suites SET name=$3,cases=$4,revision=revision+1,updated_at=now() WHERE workspace_id=$1 AND id=$2 AND revision=$5 RETURNING *",
          [p.workspaceId, id, d.name, JSON.stringify(d.cases), d.revision],
        )
      : await this.db.one(
          "INSERT INTO evaluation_suites(id,workspace_id,name,cases,created_by) VALUES($1,$2,$3,$4,$5) RETURNING *",
          [uid(), p.workspaceId, d.name, JSON.stringify(d.cases), p.userId],
        );
    return requireValue(row, 409, "Suite changed; reload before saving");
  }
  async importCase(p: Principal, id: string) {
    requireStaff(p);
    const c = await conversation(this.db, p, id);
    const messages = await this.db.rows(
      "SELECT role,body FROM messages WHERE workspace_id=$1 AND conversation_id=$2 AND role IN ('customer','assistant','staff') ORDER BY created_at,id",
      [p.workspaceId, id],
    );
    const turns: Row[] = [];
    for (const m of messages) {
      if (m.role === "customer")
        turns.push({ question: m.body, expected: { reference: "" } });
      else if (turns.length) turns.at(-1)!.expected.reference = m.body;
    }
    return {
      id: uid(),
      name: c.subject,
      turns: turns.slice(-10),
      fixtures: {},
      channel: "portal",
      sourceConversationId: id,
      personalDataReviewed: false,
    };
  }
  async startEvaluation(p: Principal, raw: unknown) {
    requireAdmin(p);
    const d = EvaluationInput.parse(raw),
      ws = p.workspaceId;
    const suite = requireValue(
      await this.db.one(
        "SELECT * FROM evaluation_suites WHERE workspace_id=$1 AND id=$2",
        [ws, d.suiteId],
      ),
    );
    const selected = suite.cases.filter(
      (c: Row) => !d.caseIds || d.caseIds.includes(c.id),
    );
    if (
      !selected.length ||
      selected.length > 50 ||
      selected.some((c: Row) => c.unavailable)
    )
      throw new HttpError(400, "Choose 1–50 available cases");
    const cases = selected.map((c: Row) => TestCase.parse(c));
    for (const c of cases)
      if (c.sourceConversationId)
        await conversation(this.db, p, c.sourceConversationId);
    const settings = Settings.parse(
      requireValue(
        await this.db.one("SELECT settings FROM workspaces WHERE id=$1", [ws]),
      ).settings,
    );
    const current = await this.workflows.get(p),
      variants = [];
    for (const v of d.variants) {
      const definition = v.definition ?? current.draft;
      const problems = await this.workflows.problems(ws, definition);
      if (problems.length) throw new HttpError(400, problems.join("\n"));
      const expanded = await this.workflows.components.expand(ws, definition);
      if (v.provider && !v.model)
        throw new HttpError(400, "Select a model with the provider override");
      if (v.model)
        for (const n of expanded.nodes)
          if (n.type === "agent") {
            n.data.model = v.model;
            n.data.provider = v.provider ?? settings.responseProvider;
          }
      variants.push({ name: v.name, definition: expanded });
    }
    if (d.judge.provider && !d.judge.model)
      throw new HttpError(400, "Select a judge model with the provider");
    const snapshot = {
      suiteId: suite.id,
      suiteRevision: suite.revision,
      cases,
      variants,
      settings,
      embeddingKey: await this.connections
        .embeddingConfig(ws)
        .then((c) => c.key)
        .catch(() => null),
      catalog: await this.catalog(ws),
      knowledgeVersions: await this.db.rows(
        "SELECT s.id source_id,s.revision,s.visibility,s.status,d.id document_id,d.version FROM sources s LEFT JOIN documents d ON d.source_id=s.id AND d.active WHERE s.workspace_id=$1 AND s.active AND s.status='ready' AND s.visibility='customer' ORDER BY s.id,d.id",
        [ws],
      ),
      actions: await this.db.rows(
        "SELECT * FROM actions WHERE workspace_id=$1 AND enabled",
        [ws],
      ),
      judge: {
        enabled: d.judge.enabled,
        provider: d.judge.provider ?? settings.responseProvider,
        model: d.judge.model ?? settings.model,
      },
    };
    return this.db.tx(async (q) => {
      const job = await this.createJob(
        p,
        "evaluation",
        d.tokenCap,
        snapshot,
        q,
      );
      for (let variant = 0; variant < variants.length; variant++)
        for (const c of cases)
          for (let turn = 0; turn < c.turns.length; turn++)
            await q.query(
              "INSERT INTO evaluation_results(id,workspace_id,job_id,case_id,variant,turn) VALUES($1,$2,$3,$4,$5,$6)",
              [uid(), ws, job.id, c.id, variant, turn],
            );
      return job;
    });
  }
  private async createJob(
    p: Principal,
    kind: string,
    cap: number,
    snapshot: Row,
    q: Queryable,
    key?: string,
  ) {
    const job = requireValue(
      await this.db.one(
        "INSERT INTO quality_jobs(id,workspace_id,kind,created_by,token_cap,snapshot,request_key) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *",
        [uid(), p.workspaceId, kind, p.userId, cap, snapshot, key ?? null],
        q,
      ),
    );
    await this.db.enqueue(q as any, "quality", {
      workspaceId: p.workspaceId,
      jobId: job.id,
    });
    await this.db.event(q, p.workspaceId, "quality.started", {
      jobId: job.id,
      kind,
    });
    return job;
  }
  async jobs(p: Principal, kind?: string) {
    requireStaff(p);
    return this.db.rows(
      "SELECT id,kind,status,token_cap,output,error,created_at,updated_at FROM quality_jobs WHERE workspace_id=$1 AND ($2::text IS NULL OR kind=$2) ORDER BY created_at DESC LIMIT 100",
      [p.workspaceId, kind ?? null],
    );
  }
  async job(p: Principal, id: string): Promise<Row> {
    requireStaff(p);
    const job = requireValue(
      await this.db.one(
        "SELECT * FROM quality_jobs WHERE workspace_id=$1 AND id=$2",
        [p.workspaceId, id],
      ),
    );
    const results = await this.db.rows(
      "SELECT * FROM evaluation_results WHERE workspace_id=$1 AND job_id=$2 ORDER BY case_id,variant,turn",
      [p.workspaceId, id],
    );
    const changed =
      job.snapshot.catalog &&
      job.snapshot.catalog !== (await this.catalog(p.workspaceId));
    if (changed)
      for (const r of results) {
        r.output = null;
        r.judge = null;
        r.error =
          "Source catalog changed; retest before relying on this result";
      }
    return {
      ...job,
      results,
      knowledgeChanged: !!changed,
      usage: await this.db.rows(
        "SELECT purpose,provider,model,sum(input_tokens)::bigint input_tokens,sum(output_tokens)::bigint output_tokens,sum(reserved)::bigint reserved,sum(duration_ms)::bigint duration_ms FROM usage WHERE workspace_id=$1 AND context_id=$2 GROUP BY purpose,provider,model",
        [p.workspaceId, id],
      ),
    };
  }
  async control(p: Principal, id: string, raw: unknown) {
    requireAdmin(p);
    const d = z
      .object({
        action: z.enum(["cancel", "retry"]),
        acknowledgeRetry: z.boolean().default(false),
        tokenCap: z.number().int().min(1000).max(10000000).optional(),
      })
      .strict()
      .parse(raw);
    return this.db.tx(async (q) => {
      const job = requireValue(
        await this.db.one(
          "SELECT * FROM quality_jobs WHERE workspace_id=$1 AND id=$2 FOR UPDATE",
          [p.workspaceId, id],
          q,
        ),
      );
      if (d.action === "retry") {
        if (
          !["failed", "uncertain", "budget_exhausted"].includes(job.status) ||
          !d.acknowledgeRetry
        )
          throw new HttpError(
            409,
            "Retry requires an unfinished job and acknowledgement that another model call may be charged",
          );
        await q.query(
          "UPDATE evaluation_results SET status=CASE WHEN output IS NULL THEN 'pending' ELSE 'generated' END,error=null WHERE job_id=$1 AND status IN ('running','judging','failed')",
          [id],
        );
        await q.query(
          "UPDATE quality_jobs SET status='queued',created_by=$3,token_cap=$4,error=null,output=output-'inflight',updated_at=now() WHERE workspace_id=$1 AND id=$2",
          [p.workspaceId, id, p.userId, d.tokenCap ?? job.token_cap],
        );
        await this.db.enqueue(q, "quality", {
          workspaceId: p.workspaceId,
          jobId: id,
        });
      } else
        await q.query(
          "UPDATE quality_jobs SET status='cancelled',updated_at=now() WHERE id=$1 AND status<>'completed'",
          [id],
        );
      await this.db.event(q, p.workspaceId, "quality.updated", {
        jobId: id,
        action: d.action,
      });
    });
  }
  async review(p: Principal, jobId: string, resultId: string, raw: unknown) {
    requireStaff(p);
    const d = z
      .object({
        verdict: z.enum(["pass", "fail", "needs_review"]),
        note: z.string().trim().min(1).max(2000),
      })
      .strict()
      .parse(raw);
    requireValue(
      await this.db.one(
        "UPDATE evaluation_results SET reviews=reviews || $4::jsonb WHERE workspace_id=$1 AND job_id=$2 AND id=$3 RETURNING id",
        [
          p.workspaceId,
          jobId,
          resultId,
          JSON.stringify([
            { ...d, actor: p.userId, at: new Date().toISOString() },
          ]),
        ],
      ),
    );
  }
  private async authorize(job: Row) {
    requireValue(
      await this.db.one(
        "SELECT id FROM quality_jobs WHERE workspace_id=$1 AND id=$2 AND status IN ('queued','running')",
        [job.workspace_id, job.id],
      ),
      409,
      "Job cancelled or unavailable",
    );
    if (
      job.snapshot.embeddingKey &&
      (await this.connections.embeddingConfig(job.workspace_id)).key !==
        job.snapshot.embeddingKey
    )
      throw new HttpError(
        409,
        "Embedding connection changed; create a new run",
      );
    requireValue(
      await this.db.one(
        "SELECT role FROM memberships WHERE workspace_id=$1 AND user_id=$2 AND role IN ('owner','admin')",
        [job.workspace_id, job.created_by],
      ),
      403,
      "The person who started this job no longer has administrator access",
    );
    if (job.request_key?.startsWith("nightly:"))
      requireValue(
        await this.db.one(
          "SELECT q.workspace_id FROM quality_settings q JOIN memberships m ON m.workspace_id=q.workspace_id AND m.user_id=q.configured_by WHERE q.workspace_id=$1 AND q.nightly AND q.configured_by=$2 AND m.role='owner'",
          [job.workspace_id, job.created_by],
        ),
        409,
        "Scheduled analysis is disabled or its owner no longer has access",
      );
    if (job.snapshot.catalog !== (await this.catalog(job.workspace_id)))
      throw new HttpError(409, "Knowledge changed; create a new run");
    if (job.snapshot.settings) {
      const settings = Settings.parse(
        requireValue(
          await this.db.one("SELECT settings FROM workspaces WHERE id=$1", [
            job.workspace_id,
          ]),
        ).settings,
      );
      if (
        digest([
          settings.embeddingModel,
          settings.embeddingProvider,
          settings.embeddingDimensions,
        ]) !==
        digest([
          job.snapshot.settings.embeddingModel,
          job.snapshot.settings.embeddingProvider,
          job.snapshot.settings.embeddingDimensions,
        ])
      )
        throw new HttpError(
          409,
          "Embedding configuration changed; create a new run",
        );
    }
  }
  async advance(ws: string, id: string) {
    const lock = await this.db.pool.connect();
    try {
      await lock.query("SELECT pg_advisory_lock(hashtextextended($1,0))", [
        `quality:${ws}:${id}`,
      ]);
      let job = requireValue(
        await this.db.one(
          "SELECT * FROM quality_jobs WHERE workspace_id=$1 AND id=$2",
          [ws, id],
        ),
      );
      if (!["queued", "running"].includes(job.status)) return;
      if (
        (await this.db.one(
          "SELECT id FROM evaluation_results WHERE job_id=$1 AND status IN ('running','judging') LIMIT 1",
          [id],
        )) ||
        job.output.inflight
      ) {
        await this.db.pool.query(
          "UPDATE quality_jobs SET status='uncertain',error='A model attempt was interrupted. Review usage and explicitly retry.',updated_at=now() WHERE id=$1",
          [id],
        );
        await this.db.event(this.db.pool, ws, "quality.updated", { jobId: id });
        return;
      }
      try {
        await this.authorize(job);
        await this.db.pool.query(
          "UPDATE quality_jobs SET status='running',updated_at=now() WHERE id=$1 AND status IN ('queued','running')",
          [id],
        );
        const more = await usageContext.run(
          {
            purpose: job.kind === "evaluation" ? "evaluation" : "gap_analysis",
            jobId: id,
            settings: job.snapshot.settings,
          },
          () =>
            job.kind === "evaluation" ? this.evaluate(job) : this.analyze(job),
        );
        await this.db.tx(async (q) => {
          if (job.kind === "evaluation")
            await q.query(
              "UPDATE quality_jobs SET output=(SELECT jsonb_build_object('completed',count(*) FILTER(WHERE status='completed'),'blocked',count(*) FILTER(WHERE status='blocked'),'total',count(*)) FROM evaluation_results WHERE job_id=$1) WHERE id=$1",
              [id],
            );
          await q.query(
            "UPDATE quality_jobs SET status=$2,updated_at=now() WHERE id=$1 AND status='running'",
            [id, more ? "queued" : "completed"],
          );
          if (more)
            await this.db.enqueue(q, "quality", { workspaceId: ws, jobId: id });
          await this.db.event(q, ws, "quality.updated", { jobId: id });
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await this.db.pool.query(
          "UPDATE quality_jobs SET status=$2,error=$3,updated_at=now() WHERE id=$1 AND status IN ('running','queued')",
          [
            id,
            /budget|token cap/i.test(message)
              ? "budget_exhausted"
              : /timeout|timed out|connection|fetch failed/i.test(message)
                ? "uncertain"
                : "failed",
            message,
          ],
        );
        await this.db.pool.query(
          "UPDATE evaluation_results SET status='failed',error=$2 WHERE job_id=$1 AND status IN ('running','judging')",
          [id, message],
        );
        await this.db.event(this.db.pool, ws, "quality.updated", { jobId: id });
      }
    } finally {
      await lock.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [
        `quality:${ws}:${id}`,
      ]);
      lock.release();
    }
  }
  private async evaluate(job: Row) {
    const ws = job.workspace_id,
      s = job.snapshot;
    const result = await this.db.one(
      "SELECT * FROM evaluation_results WHERE job_id=$1 AND status IN ('pending','generated') ORDER BY case_id,variant,turn LIMIT 1",
      [job.id],
    );
    if (!result) return false;
    const c = s.cases.find((c: Row) => c.id === result.case_id),
      turn = c.turns[result.turn];
    if (c.sourceConversationId)
      requireValue(
        await this.db.one(
          "SELECT id FROM conversations WHERE workspace_id=$1 AND id=$2",
          [ws, c.sourceConversationId],
        ),
        409,
        "Imported conversation is no longer available",
      );
    const earlier = await this.db.rows(
      "SELECT * FROM evaluation_results WHERE job_id=$1 AND case_id=$2 AND variant=$3 AND turn<$4 ORDER BY turn",
      [job.id, c.id, result.variant, result.turn],
    );
    if (earlier.some((r) => r.status === "blocked")) {
      await this.db.pool.query(
        "UPDATE evaluation_results SET status='blocked',error='Previous turn was blocked' WHERE id=$1",
        [result.id],
      );
      return true;
    }
    let output = result.output;
    if (!output) {
      await this.db.pool.query(
        "UPDATE evaluation_results SET status='running',updated_at=now() WHERE id=$1",
        [result.id],
      );
      const messages: { role: string; body: string }[] = [];
      for (const prev of earlier)
        messages.push(
          { role: "customer", body: c.turns[prev.turn].question },
          { role: "assistant", body: prev.output.answer },
        );
      messages.push({ role: "customer", body: turn.question });
      const started = Date.now();
      output = await this.agent.previewWorkflow(
        ws,
        s.variants[result.variant].definition,
        turn.question,
        { id: "evaluation-customer", revision: 0, ...c.fixtures.customer },
        c.channel,
        {},
        {
          evaluation: {
            fixtures: c.fixtures,
            actions: s.actions,
            settings: s.settings,
            beforeStep: () => this.authorize(job),
          },
          messages,
          runId: `evaluation-${result.id}`,
        },
      );
      await this.authorize(job);
      if (output.blocked && /budget|token cap/i.test(output.blocked))
        throw new HttpError(429, output.blocked);
      await this.db.pool.query(
        "UPDATE evaluation_results SET status=$2,output=$3,duration_ms=$4,error=$5,updated_at=now() WHERE id=$1",
        [
          result.id,
          output.blocked ? "blocked" : "generated",
          output,
          Date.now() - started,
          output.blocked,
        ],
      );
      if (output.blocked) return true;
    }
    const expected = turn.expected,
      rules: Row[] = [];
    const check = (name: string, passed: boolean) =>
      rules.push({ name, passed });
    if (expected.intent)
      check("Expected outcome", expected.intent === output.decision);
    for (const node of expected.nodes)
      check(
        `Visited ${node}`,
        output.trace.some((t: Row) => t.nodeId === node),
      );
    for (const source of expected.sources)
      check(
        `Cited source ${source}`,
        output.citations.some((c: Citation) => c.sourceId === source),
      );
    if (expected.actionName)
      check("Selected action", output.action?.name === expected.actionName);
    if (expected.parameters)
      check(
        "Exact action parameters",
        digest(output.action?.parameters ?? null) ===
          digest(expected.parameters),
      );
    if (expected.requiresApproval !== undefined)
      check(
        "Approval requirement",
        output.action?.requiresApproval === expected.requiresApproval,
      );
    check("No actions executed", output.actionsExecuted === false);
    let judge = null;
    if (s.judge.enabled) {
      if (!this.model.judge)
        throw new Error("Model adapter does not support quality assessment");
      await this.db.pool.query(
        "UPDATE evaluation_results SET status='judging' WHERE id=$1",
        [result.id],
      );
      judge = JudgeResult.parse(
        await usageContext.run(
          { ...usageContext.getStore()!, purpose: "judging" },
          () =>
            this.model.judge!({
              workspaceId: ws,
              model: s.judge.model,
              provider: s.judge.provider,
              payload: {
                question: turn.question,
                answer: output.answer,
                reference: expected.reference,
                evidence: output.citations,
                action: output.action,
              },
            }),
        ),
      );
      if (
        judge.citationIds.some(
          (id) => !output.citations.some((c: Citation) => c.id === id),
        )
      )
        throw new Error("Judge cited evidence outside the evaluation");
    }
    await this.authorize(job);
    await this.db.pool.query(
      "UPDATE evaluation_results SET status='completed',rules=$2,judge=$3,updated_at=now() WHERE id=$1 AND EXISTS(SELECT 1 FROM quality_jobs WHERE id=$4 AND status='running')",
      [result.id, JSON.stringify(rules), judge, job.id],
    );
    await this.db.pool.query(
      "UPDATE quality_jobs SET output=(SELECT jsonb_build_object('completed',count(*) FILTER(WHERE status='completed'),'blocked',count(*) FILTER(WHERE status='blocked'),'total',count(*)) FROM evaluation_results WHERE job_id=$1) WHERE id=$1",
      [job.id],
    );
    return !!(await this.db.one(
      "SELECT id FROM evaluation_results WHERE job_id=$1 AND status IN ('pending','generated') LIMIT 1",
      [job.id],
    ));
  }
  async feedback(p: Principal, id: string, raw?: unknown) {
    const conv = await conversation(this.db, p, id);
    if (raw === undefined)
      return this.db.rows(
        "SELECT * FROM customer_feedback WHERE workspace_id=$1 AND conversation_id=$2 ORDER BY updated_at DESC",
        [p.workspaceId, id],
      );
    if (
      !["customer", "visitor"].includes(p.role) ||
      p.contactId !== conv.contact_id
    )
      throw new HttpError(403, "Only the customer can submit feedback");
    const d = FeedbackInput.parse(raw);
    return this.db.tx(async (q) => {
      const current = await this.db.one(
        "SELECT status,external_id FROM conversations WHERE workspace_id=$1 AND id=$2 FOR UPDATE",
        [p.workspaceId, id],
        q,
      );
      const prior = await this.db.one(
        "SELECT * FROM customer_feedback WHERE workspace_id=$1 AND conversation_id=$2 AND source='native' ORDER BY updated_at DESC LIMIT 1",
        [p.workspaceId, id],
        q,
      );
      if (prior) {
        if (
          prior.message_id === d.messageId &&
          prior.resolved === d.resolved &&
          prior.rating === d.rating &&
          prior.comment === d.comment
        )
          return prior;
        throw new HttpError(
          409,
          "Feedback has already been sent for this conversation",
        );
      }
      if (current?.status !== "resolved")
        throw new HttpError(
          409,
          "Feedback is available after the conversation is closed",
        );
      requireValue(
        await this.db.one(
          "SELECT id FROM messages WHERE workspace_id=$1 AND conversation_id=$2 AND id=$3 AND role IN ('assistant','staff') AND delivered_at IS NOT NULL AND id=(SELECT id FROM messages WHERE workspace_id=$1 AND conversation_id=$2 AND role IN ('customer','assistant','staff') ORDER BY created_at DESC,id DESC LIMIT 1)",
          [p.workspaceId, id, d.messageId],
          q,
        ),
        400,
        "Choose the latest delivered support answer in your closed conversation",
      );
      const history = [
        {
          resolved: d.resolved,
          rating: d.rating,
          comment: d.comment,
          at: new Date().toISOString(),
        },
      ];
      const saved = await this.db.one(
        "INSERT INTO customer_feedback(id,workspace_id,conversation_id,message_id,contact_id,source,external_id,resolved,rating,comment,raw) VALUES($1,$2,$3,$4,$5,'native',$4,$6,$7,$8,$9) RETURNING *",
        [
          uid(),
          p.workspaceId,
          id,
          d.messageId,
          p.contactId,
          d.resolved,
          d.rating,
          d.comment,
          { history },
        ],
        q,
      );
      if (!d.resolved || d.rating === "bad")
        await this.occurrence(
          p.workspaceId,
          id,
          "negative_feedback",
          `feedback:${d.messageId}`,
          undefined,
          d.messageId,
          q,
        );
      if (!d.resolved && !current.external_id) {
        await q.query(
          "UPDATE conversations SET status='open',revision=revision+1,updated_at=now() WHERE workspace_id=$1 AND id=$2",
          [p.workspaceId, id],
        );
        await q.query(
          "UPDATE approvals SET status='stale' WHERE status='pending' AND run_id IN(SELECT id FROM runs WHERE workspace_id=$1 AND conversation_id=$2)",
          [p.workspaceId, id],
        );
        await this.db.event(
          q,
          p.workspaceId,
          "conversation.updated",
          {
            previousStatus: "resolved",
            status: "open",
            actorType: "customer",
            reason: "unresolved_feedback",
          },
          id,
          true,
        );
      }
      await this.db.event(
        q,
        p.workspaceId,
        "feedback.submitted",
        { messageId: d.messageId, resolved: d.resolved, rating: d.rating },
        id,
        true,
      );
      return saved;
    });
  }
  async occurrence(
    ws: string,
    convId: string,
    reason: string,
    key: string,
    runId?: string,
    messageId?: string,
    q: Queryable = this.db.pool,
  ) {
    const question = await this.db.one(
      "SELECT id,body FROM messages WHERE workspace_id=$1 AND conversation_id=$2 AND role='customer' AND created_at<=coalesce((SELECT created_at FROM runs WHERE id=$3),(SELECT created_at FROM messages WHERE id=$4),now()) ORDER BY created_at DESC,id DESC LIMIT 1",
      [ws, convId, runId ?? null, messageId ?? null],
      q,
    );
    if (!question) return;
    if (key.startsWith("flag:")) key += `:${question.id}`;
    const existing = await this.db.one(
      "SELECT gap_id FROM gap_occurrences WHERE workspace_id=$1 AND event_key=$2",
      [ws, key],
      q,
    );
    if (existing) return existing.gap_id;
    const title = question.body.slice(0, 200),
      fingerprint = digest(
        question.body.toLowerCase().replace(/\s+/g, " ").trim(),
      );
    const alias = await this.db.one(
      "SELECT g.* FROM knowledge_gaps g JOIN gap_aliases a ON a.workspace_id=g.workspace_id AND a.gap_id=g.id WHERE a.workspace_id=$1 AND a.fingerprint=$2",
      [ws, fingerprint],
      q,
    );
    const group =
      alias ??
      requireValue(
        await this.db.one(
          "INSERT INTO knowledge_gaps(id,workspace_id,title,fingerprint,category) VALUES($1,$2,$3,$4,$5) ON CONFLICT(workspace_id,fingerprint) DO UPDATE SET fingerprint=excluded.fingerprint RETURNING *",
          [uid(), ws, title, fingerprint, reason],
          q,
        ),
      );
    const added = await q.query(
      "INSERT INTO gap_occurrences(id,workspace_id,gap_id,conversation_id,message_id,run_id,reason,event_key) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(workspace_id,event_key) DO NOTHING RETURNING id",
      [uid(), ws, group.id, convId, question.id, runId ?? null, reason, key],
    );
    if (added.rowCount) {
      await q.query(
        "UPDATE knowledge_gaps SET revision=revision+1,updated_at=now(),status=CASE WHEN status='resolved' THEN 'open' ELSE status END WHERE id=$1",
        [group.id],
      );
      await this.db.event(q, ws, "gap.updated", { gapId: group.id }, convId);
    }
    return group.id;
  }
  async captureRun(ws: string, id: string, q?: Queryable) {
    const run = await this.db.one(
      "SELECT * FROM runs WHERE workspace_id=$1 AND id=$2",
      [ws, id],
      q,
    );
    if (!run || run.state?.route !== "handoff") return;
    const reason = classifyHandoff(run.state?.error ?? "");
    const capture = (tx: Queryable) =>
      this.occurrence(
        ws,
        run.conversation_id,
        reason,
        `run:${id}`,
        id,
        undefined,
        tx,
      );
    if (q) await capture(q);
    else await this.db.tx(capture);
  }
  async gaps(p: Principal) {
    requireStaff(p);
    return this.db.rows(
      "SELECT g.*,count(o.id)::int occurrences,max(o.created_at) last_occurrence FROM knowledge_gaps g LEFT JOIN gap_occurrences o ON o.workspace_id=g.workspace_id AND o.gap_id=g.id WHERE g.workspace_id=$1 GROUP BY g.id ORDER BY g.updated_at DESC LIMIT 200",
      [p.workspaceId],
    );
  }
  async gap(p: Principal, id: string): Promise<Row> {
    requireStaff(p);
    const gap = requireValue(
      await this.db.one(
        "SELECT * FROM knowledge_gaps WHERE workspace_id=$1 AND id=$2",
        [p.workspaceId, id],
      ),
    );
    if (
      gap.recommendation &&
      !(await this.knowledge.validEvidence(
        p.workspaceId,
        gap.recommendation.evidence ?? [],
      ))
    )
      gap.recommendation = {
        unavailable: true,
        explanation: "Source access or knowledge changed. Analyze again.",
      };
    return {
      ...gap,
      regressionSuites: await this.db.rows(
        "SELECT id,name FROM evaluation_suites WHERE workspace_id=$1 AND cases @> $2::jsonb",
        [p.workspaceId, JSON.stringify([{ gapId: id }])],
      ),
      occurrences: await this.db.rows(
        "SELECT o.*,c.subject,m.body question,r.state->'evidence' citations,(SELECT jsonb_agg(jsonb_build_object('source',f.source,'rating',f.rating,'comment',f.comment)) FROM customer_feedback f WHERE f.workspace_id=o.workspace_id AND f.conversation_id=o.conversation_id) feedback FROM gap_occurrences o JOIN conversations c ON c.id=o.conversation_id LEFT JOIN runs r ON r.id=o.run_id LEFT JOIN messages m ON m.id=o.message_id AND m.workspace_id=o.workspace_id WHERE o.workspace_id=$1 AND o.gap_id=$2 ORDER BY o.created_at DESC LIMIT 100",
        [p.workspaceId, id],
      ),
    };
  }
  async flag(p: Principal, id: string) {
    requireStaff(p);
    await conversation(this.db, p, id);
    return this.db.tx((q) =>
      this.occurrence(
        p.workspaceId,
        id,
        "staff_flag",
        `flag:${id}`,
        undefined,
        undefined,
        q,
      ),
    );
  }
  async updateGap(p: Principal, id: string, raw: unknown) {
    requireStaff(p);
    const d = GapUpdate.parse(raw);
    if (["dismissed", "resolved"].includes(d.status) && !d.reason)
      throw new HttpError(
        400,
        "Record the evidence or reason for closing this gap",
      );
    return requireValue(
      await this.db.one(
        "UPDATE knowledge_gaps SET status=$3,reason=$4,updated_at=now() WHERE workspace_id=$1 AND id=$2 RETURNING *",
        [p.workspaceId, id, d.status, d.reason],
      ),
    );
  }
  async merge(p: Principal, id: string, target: string) {
    requireStaff(p);
    if (id === target) throw new HttpError(400, "Choose a different group");
    await this.db.tx(async (q) => {
      const groups = await this.db.rows(
        "SELECT id FROM knowledge_gaps WHERE workspace_id=$1 AND id=ANY($2) ORDER BY id FOR UPDATE",
        [p.workspaceId, [id, target]],
        q,
      );
      if (groups.length !== 2) throw new HttpError(404, "Gap not found");
      await q.query(
        "INSERT INTO gap_aliases(workspace_id,fingerprint,gap_id) SELECT workspace_id,fingerprint,$3 FROM knowledge_gaps WHERE workspace_id=$1 AND id=$2 ON CONFLICT(workspace_id,fingerprint) DO UPDATE SET gap_id=$3",
        [p.workspaceId, id, target],
      );
      await q.query(
        "UPDATE gap_aliases SET gap_id=$3 WHERE workspace_id=$1 AND gap_id=$2",
        [p.workspaceId, id, target],
      );
      await q.query(
        "UPDATE gap_occurrences SET gap_id=$3 WHERE workspace_id=$1 AND gap_id=$2",
        [p.workspaceId, id, target],
      );
      await q.query(
        "UPDATE knowledge_gaps SET status='dismissed',reason=$3,recommendation=null WHERE workspace_id=$1 AND id=$2",
        [p.workspaceId, id, `Merged into ${target}`],
      );
      await q.query(
        "UPDATE knowledge_gaps SET revision=revision+1,updated_at=now() WHERE id=$1",
        [target],
      );
    });
  }
  async gapCase(p: Principal, id: string) {
    const gap = await this.gap(p, id),
      first = gap.occurrences[0];
    if (!first)
      throw new HttpError(409, "No retained conversation supports this gap");
    return {
      ...(await this.importCase(p, first.conversation_id)),
      name: gap.title,
      gapId: id,
    };
  }
  async startAnalysis(p: Principal, raw: unknown, key?: string) {
    requireAdmin(p);
    const d = AnalysisInput.parse(raw),
      ws = p.workspaceId;
    const catalog = await this.catalog(ws);
    const gaps = await this.db.rows(
      "SELECT id,revision FROM knowledge_gaps WHERE workspace_id=$1 AND status IN ('open','in_progress') AND (revision>analyzed_revision OR recommendation->>'catalog' IS DISTINCT FROM $3) AND ($2::text[] IS NULL OR id=ANY($2)) ORDER BY updated_at LIMIT 20",
      [ws, d.gapIds ?? null, catalog],
    );
    if (!gaps.length)
      throw new HttpError(409, "No new or changed candidates to analyze");
    const settings = Settings.parse(
      requireValue(
        await this.db.one("SELECT settings FROM workspaces WHERE id=$1", [ws]),
      ).settings,
    );
    return this.db.tx((q) =>
      this.createJob(
        p,
        "analysis",
        d.tokenCap,
        { gaps, settings, catalog: catalog },
        q,
        key,
      ),
    );
  }
  private async analyze(job: Row) {
    const done: string[] = job.output.done ?? [],
      item = job.snapshot.gaps.find((g: Row) => !done.includes(g.id));
    if (!item) return false;
    const p: Principal = {
        workspaceId: job.workspace_id,
        role: "admin",
        userId: job.created_by,
      },
      gap = await this.gap(p, item.id);
    if (gap.revision !== item.revision || !gap.occurrences.length)
      throw new HttpError(409, "Gap evidence changed; start a fresh analysis");
    if (!this.model.analyzeGap)
      throw new Error("Model adapter does not support gap analysis");
    await this.db.pool.query(
      "UPDATE quality_jobs SET output=output || '{\"inflight\":true}'::jsonb WHERE id=$1",
      [job.id],
    );
    const evidence = await this.knowledge.retrieve(job.workspace_id, gap.title);
    const candidates = await this.db.rows(
      "SELECT id,title FROM knowledge_gaps WHERE workspace_id=$1 AND id<>$2 AND status IN ('open','in_progress') ORDER BY updated_at DESC LIMIT 30",
      [job.workspace_id, item.id],
    );
    const suggestion = GapSuggestion.parse(
      await this.model.analyzeGap({
        workspaceId: job.workspace_id,
        model: job.snapshot.settings.model,
        provider: job.snapshot.settings.responseProvider,
        payload: {
          question: gap.title,
          occurrences: gap.occurrences.map((o: Row) => ({
            conversationId: o.conversation_id,
            question: o.question,
            reason: o.reason,
            feedback: o.feedback,
          })),
          evidence,
          groups: candidates,
        },
      }),
    );
    if (suggestion.citationIds.some((id) => !evidence.some((e) => e.id === id)))
      throw new Error(
        "Analysis cited evidence outside the retrieved knowledge",
      );
    if (
      suggestion.mergeWith &&
      !candidates.some((c) => c.id === suggestion.mergeWith)
    )
      throw new Error("Analysis selected an unknown gap group");
    await this.authorize(job);
    const recommendation = {
      ...suggestion,
      catalog: job.snapshot.catalog,
      evidence: evidence.filter((e) => suggestion.citationIds.includes(e.id)),
      conversationIds: gap.occurrences.map((o: Row) => o.conversation_id),
      needsStaffInput: !suggestion.citationIds.length || !suggestion.answer,
    };
    await this.db.tx(async (q) => {
      const active = await this.db.one(
        "SELECT id FROM quality_jobs WHERE id=$1 AND status='running' FOR UPDATE",
        [job.id],
        q,
      );
      if (!active) return;
      requireValue(
        await this.db.one(
          "UPDATE knowledge_gaps SET recommendation=$3,analyzed_revision=$4,category=$5 WHERE workspace_id=$1 AND id=$2 AND revision=$4 RETURNING id",
          [
            job.workspace_id,
            item.id,
            recommendation,
            item.revision,
            suggestion.category,
          ],
          q,
        ),
        409,
        "Gap changed during analysis",
      );
      await q.query("UPDATE quality_jobs SET output=$2 WHERE id=$1", [
        job.id,
        { done: [...done, item.id] },
      ]);
      await this.db.event(q, job.workspace_id, "gap.updated", {
        gapId: item.id,
      });
    });
    return done.length + 1 < job.snapshot.gaps.length;
  }
  async draft(p: Principal, id: string) {
    requireAdmin(p);
    const gap = await this.gap(p, id),
      r = gap.recommendation;
    if (!r || r.needsStaffInput || r.unavailable || !r.evidence?.length)
      throw new HttpError(
        409,
        "Authoritative support is required. Add approved knowledge and analyze again, or write a staff-reviewed draft.",
      );
    return this.db.tx(async (q) => {
      const locked = requireValue(
        await this.db.one(
          "SELECT * FROM knowledge_gaps WHERE workspace_id=$1 AND id=$2 FOR UPDATE",
          [p.workspaceId, id],
          q,
        ),
      );
      if (locked.draft_source_id)
        return this.db.one(
          "SELECT * FROM sources WHERE workspace_id=$1 AND id=$2",
          [p.workspaceId, locked.draft_source_id],
          q,
        );
      if (locked.revision !== gap.analyzed_revision)
        throw new HttpError(409, "Analyze the latest evidence first");
      const [source] = await this.knowledge.createFaqs(
        p.workspaceId,
        [
          {
            question: r.question,
            answer: r.answer,
            citationIds: r.citationIds,
          },
        ],
        true,
        r.evidence,
        q,
      );
      await q.query(
        "UPDATE knowledge_gaps SET draft_source_id=$2,status='in_progress' WHERE id=$1",
        [id, source.id],
      );
      return source;
    });
  }
  async historicalScan(p: Principal, raw: unknown) {
    requireAdmin(p);
    const d = z
      .object({
        days: z.number().int().min(1).max(365),
        limit: z.number().int().min(1).max(500),
      })
      .strict()
      .parse(raw);
    const rows = await this.db.rows(
      "SELECT id FROM runs WHERE workspace_id=$1 AND created_at>now()-($2::int*interval '1 day') AND state->>'route'='handoff' ORDER BY created_at DESC LIMIT $3",
      [p.workspaceId, d.days, d.limit],
    );
    for (const row of rows) await this.captureRun(p.workspaceId, row.id);
    return { scanned: rows.length };
  }
  async schedule(now = new Date()) {
    if (now.getUTCHours() !== 2) return;
    for (const s of await this.db.rows(
      "SELECT q.* FROM quality_settings q JOIN memberships m ON m.workspace_id=q.workspace_id AND m.user_id=q.configured_by AND m.role='owner' WHERE q.nightly AND q.daily_token_cap>=1000",
    )) {
      const key = `nightly:${now.toISOString().slice(0, 10)}`;
      if (
        await this.db.one(
          "SELECT id FROM quality_jobs WHERE workspace_id=$1 AND request_key=$2",
          [s.workspace_id, key],
        )
      )
        continue;
      try {
        await this.startAnalysis(
          {
            workspaceId: s.workspace_id,
            role: "owner",
            userId: s.configured_by,
          },
          { tokenCap: s.daily_token_cap },
          key,
        );
      } catch (e) {
        if (!(e instanceof HttpError && e.status === 409)) throw e;
      }
    }
  }
  async forgetConversation(ws: string, id: string, q: Queryable) {
    await q.query(
      "UPDATE evaluation_suites SET cases=(SELECT coalesce(jsonb_agg(CASE WHEN c->>'sourceConversationId'=$2 THEN jsonb_build_object('id',c->>'id','name','Deleted source conversation','unavailable',true) ELSE c END),'[]') FROM jsonb_array_elements(cases)c),revision=revision+1 WHERE workspace_id=$1 AND cases @> $3::jsonb",
      [ws, id, JSON.stringify([{ sourceConversationId: id }])],
    );
    await q.query(
      "DELETE FROM quality_jobs WHERE workspace_id=$1 AND snapshot->'cases' @> $2::jsonb",
      [ws, JSON.stringify([{ sourceConversationId: id }])],
    );
    // Remove derived recommendations and analysis transcripts which may contain the deleted conversation.
    await q.query(
      "DELETE FROM quality_jobs WHERE workspace_id=$1 AND kind='analysis' AND EXISTS(SELECT 1 FROM jsonb_array_elements(snapshot->'gaps') g JOIN gap_occurrences o ON o.gap_id=g->>'id' WHERE o.conversation_id=$2)",
      [ws, id],
    );
    await q.query(
      "UPDATE sources SET metadata='{}',title='Removed gap draft',active=false WHERE workspace_id=$1 AND status='draft' AND id IN(SELECT draft_source_id FROM knowledge_gaps WHERE workspace_id=$1 AND id IN(SELECT gap_id FROM gap_occurrences WHERE conversation_id=$2))",
      [ws, id],
    );
    await q.query(
      "UPDATE knowledge_gaps SET title='Evidence removed; review remaining conversations',recommendation=null,analyzed_revision=0,revision=revision+1 WHERE workspace_id=$1 AND id IN(SELECT gap_id FROM gap_occurrences WHERE conversation_id=$2)",
      [ws, id],
    );
  }
  async retain(ws: string, days: number) {
    await this.db.pool.query(
      "DELETE FROM quality_jobs WHERE workspace_id=$1 AND created_at<now()-($2::int*interval '1 day')",
      [ws, days],
    );
    await this.db.pool.query(
      "DELETE FROM customer_feedback WHERE workspace_id=$1 AND updated_at<now()-($2::int*interval '1 day')",
      [ws, days],
    );
    await this.db.pool.query(
      "DELETE FROM knowledge_gaps WHERE workspace_id=$1 AND NOT EXISTS(SELECT 1 FROM gap_occurrences WHERE gap_id=knowledge_gaps.id)",
      [ws],
    );
  }
  async analytics(p: Principal, raw: unknown) {
    requireStaff(p);
    const d = z
      .object({
        from: z.iso.datetime().optional(),
        to: z.iso.datetime().optional(),
        channel: z.string().max(200).optional(),
      })
      .strict()
      .parse(raw);
    const to = d.to ?? new Date().toISOString(),
      from = d.from ?? new Date(Date.now() - 30 * 86400000).toISOString();
    if (from >= to || Date.parse(to) - Date.parse(from) > 366 * 86400000)
      throw new HttpError(400, "Choose a date range of at most one year");
    const args = [p.workspaceId, from, to, d.channel ?? null];
    const base = `WITH cohort AS(SELECT c.* FROM conversations c LEFT JOIN channels ch ON ch.id=c.channel_id WHERE c.workspace_id=$1 AND c.created_at>=$2 AND c.created_at<$3 AND ($4::text IS NULL OR ch.kind=$4 OR ch.id=$4)), metrics AS(SELECT c.*,
      EXISTS(SELECT 1 FROM messages m WHERE m.conversation_id=c.id AND m.role='assistant' AND m.delivered_at IS NOT NULL) ai,
      EXISTS(SELECT 1 FROM messages m WHERE m.conversation_id=c.id AND m.role='staff' AND m.delivered_at IS NOT NULL) staff,
      EXISTS(SELECT 1 FROM events e WHERE e.conversation_id=c.id AND e.data->>'handoffCategory' IS NOT NULL) handoff,
      EXISTS(SELECT 1 FROM events e WHERE e.conversation_id=c.id AND e.data->>'previousStatus'='resolved' AND e.data->>'status'='open') reopened,
      EXISTS(SELECT 1 FROM events e WHERE e.conversation_id=c.id AND e.data->>'actorType'='staff' AND e.data->>'status'='resolved') staff_resolved,
      coalesce((SELECT f.resolved AND f.rating IS DISTINCT FROM 'bad' AND NOT EXISTS(SELECT 1 FROM messages later WHERE later.conversation_id=c.id AND later.role='customer' AND later.created_at>(SELECT created_at FROM messages WHERE id=f.message_id)) FROM customer_feedback f WHERE f.conversation_id=c.id AND f.source='native' ORDER BY f.updated_at DESC LIMIT 1),false) confirmed,
      (SELECT min(m.created_at) FROM messages m WHERE m.conversation_id=c.id AND m.role='customer') first_customer,
      (SELECT min(m.delivered_at) FROM messages m WHERE m.conversation_id=c.id AND m.role IN ('assistant','staff') AND m.delivered_at>=(SELECT min(created_at) FROM messages WHERE conversation_id=c.id AND role='customer')) first_reply,
      EXISTS(SELECT 1 FROM messages m WHERE m.conversation_id=c.id AND m.role IN ('assistant','staff') AND m.delivered_at IS NULL) unknown_delivery,
      (c.created_at<(SELECT applied_at FROM app_migrations WHERE version=9) OR (c.external_id IS NOT NULL AND (SELECT min(created_at) FROM messages WHERE conversation_id=c.id)<(SELECT applied_at FROM app_migrations WHERE version=9))) unknown_history
      FROM cohort c)`;
    const totalsSQL = ` SELECT count(*)::int conversations,count(*) FILTER(WHERE ai)::int ai_conversations,count(*) FILTER(WHERE ai AND confirmed)::int confirmed_resolution,count(*) FILTER(WHERE ai AND NOT staff AND NOT handoff AND NOT unknown_delivery AND NOT unknown_history)::int ai_only_conversations,count(*) FILTER(WHERE ai AND confirmed AND NOT staff AND NOT handoff AND NOT unknown_delivery AND NOT unknown_history)::int ai_only_confirmed,count(*) FILTER(WHERE staff_resolved)::int staff_resolved,count(*) FILTER(WHERE handoff)::int handoffs,count(*) FILTER(WHERE reopened)::int reopened,count(*) FILTER(WHERE unknown_delivery)::int unknown_delivery,count(*) FILTER(WHERE unknown_history)::int unknown_history,count(first_reply)::int response_time_denominator,avg(extract(epoch FROM first_reply-first_customer)*1000)::float average_first_response_ms FROM metrics`;
    const comparisonFrom = new Date(
      Date.parse(from) - (Date.parse(to) - Date.parse(from)),
    ).toISOString();
    const [totals, previousTotals, trend] = await Promise.all([
      this.db.one(base + totalsSQL, args),
      this.db.one(base + totalsSQL, [
        p.workspaceId,
        comparisonFrom,
        from,
        d.channel ?? null,
      ]),
      this.db.rows(
        base +
          ` SELECT to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD') AS "day",count(*)::int conversations FROM cohort GROUP BY 1 ORDER BY 1`,
        args,
      ),
    ]);
    const satisfaction = await this.db.rows(
      base +
        ` SELECT f.source,count(*)::int rated,count(*) FILTER(WHERE f.rating='good')::int good,count(*) FILTER(WHERE f.rating='bad')::int bad,count(*) FILTER(WHERE f.rating='neutral')::int neutral FROM(SELECT DISTINCT ON(f.conversation_id,f.source) f.* FROM customer_feedback f JOIN cohort c ON c.id=f.conversation_id WHERE f.rating IS NOT NULL ORDER BY f.conversation_id,f.source,CASE WHEN f.source='native' THEN f.updated_at ELSE f.answered_at END DESC,f.external_id)f GROUP BY f.source`,
      args,
    );
    const details = await this.db.rows(
      base +
        " SELECT id,subject,status,ai,confirmed,staff_resolved,handoff,reopened,first_reply,created_at,(ai AND NOT staff AND NOT handoff AND NOT unknown_delivery AND NOT unknown_history) ai_only FROM metrics ORDER BY created_at DESC,id DESC LIMIT 200",
      args,
    );
    const handoffs = await this.db.rows(
      base +
        ` SELECT coalesce(e.data->>'handoffCategory','unknown') reason,count(DISTINCT c.id)::int conversations FROM cohort c JOIN events e ON e.conversation_id=c.id WHERE e.data->>'handoffCategory' IS NOT NULL GROUP BY reason`,
      args,
    );
    const usage = await this.db.rows(
      "SELECT coalesce(u.purpose,'unknown') purpose,u.model,u.provider,sum(u.input_tokens)::bigint input_tokens,sum(u.output_tokens)::bigint output_tokens,sum(u.reserved)::bigint reserved,sum(u.duration_ms)::bigint duration_ms FROM usage u LEFT JOIN runs r ON r.id=u.run_id LEFT JOIN conversations c ON c.id=r.conversation_id LEFT JOIN channels ch ON ch.id=c.channel_id WHERE u.workspace_id=$1 AND u.created_at>=$2 AND u.created_at<$3 AND ($4::text IS NULL OR ch.kind=$4 OR ch.id=$4) GROUP BY u.purpose,u.model,u.provider",
      args,
    );
    const topics = await this.db.rows(
      "SELECT g.id,g.title,count(o.id)::int occurrences FROM knowledge_gaps g JOIN gap_occurrences o ON o.gap_id=g.id JOIN conversations c ON c.id=o.conversation_id LEFT JOIN channels ch ON ch.id=c.channel_id WHERE g.workspace_id=$1 AND o.created_at>=$2 AND o.created_at<$3 AND ($4::text IS NULL OR ch.kind=$4 OR ch.id=$4) GROUP BY g.id ORDER BY occurrences DESC LIMIT 20",
      args,
    );
    return {
      from,
      to,
      totals,
      comparison: { from: comparisonFrom, to: from, totals: previousTotals },
      trend,
      satisfaction: satisfaction.map((s) => ({
        ...s,
        unrated: totals!.conversations - s.rated,
      })),
      handoffs,
      usage,
      topics,
      conversations: details,
      feedbackSync: await this.settings(p),
      definitions: {
        cohort:
          "Conversations created in the selected window. Outcomes reflect retained history through now.",
        resolution:
          "Current customer confirmation among conversations with a delivered AI answer. A later customer message or negative feedback invalidates confirmation.",
        satisfaction:
          "Latest submitted rating per conversation and source. Unrated conversations are excluded from rating percentages.",
        history:
          "Missing historical timestamps and transitions remain unknown. Response time uses delivered replies only.",
        usage:
          "Actual usage in the selected window. Channel filters exclude unattributed calls.",
      },
    };
  }
}
export function classifyHandoff(reason: string) {
  if (/identity|verified|mapping|ownership/i.test(reason)) return "identity";
  if (
    /budget|provider|model|timeout|unavailable|connection|429|error/i.test(
      reason,
    )
  )
    return "operational";
  if (/evidence|knowledge|citation|ground|policy conflict/i.test(reason))
    return "missing_knowledge";
  return "intentional";
}
