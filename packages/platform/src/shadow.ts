import { createHmac } from "node:crypto";
import type { PoolClient } from "pg";
import type { Platform } from "./platform.js";
import { Agent } from "./agent.js";
import { type Principal, requireAdmin, requireStaff } from "./auth.js";
import { type Queryable, uid } from "./db.js";
import { Settings } from "./contracts.js";
import { HttpError, requireValue } from "./config.js";
import { digest, token } from "./security.js";
import { effectiveWorkflow } from "./channel-workflows.js";
import { WorkflowDefinition } from "./workflow-definition.js";
import { JudgeResult, TestCase } from "./quality-contracts.js";
import {
  ShadowCandidateInput,
  ShadowStart,
  ShadowControl,
  ShadowReview,
  CanaryStart,
  CanaryControl,
} from "./shadow-contracts.js";
import {
  fixtureKey,
  type CapturedRead,
  type FixtureRequest,
} from "./shadow-fixtures.js";
import { usageContext } from "./usage-context.js";

type Row = Record<string, any>;
export function selected(key: string, value: string, percent: number) {
  return (
    (createHmac("sha256", key).update(value).digest().readUInt32BE(0) /
      0x100000000) *
      100 <
    percent
  );
}
export class Shadow {
  private engine: Agent;
  constructor(private app: Platform) {
    // Evaluation never receives callable business adapters. Local parameter/proof
    // validation is permitted; every outbound business method fails closed.
    const denied = () => {
      throw new Error("Shadow isolation prohibits business-system calls");
    };
    const actions = new Proxy(app.actions, {
      get(target, key) {
        return key === "validateParameters" || key === "revalidate"
          ? (target[key] as Function).bind(target)
          : denied;
      },
    });
    const support = new Proxy(app.support, {
      get() {
        return denied;
      },
    });
    this.engine = new Agent(
      app.db,
      app.knowledge,
      app.model,
      actions,
      support,
      app.agent.execution.runner,
    );
  }
  get db() {
    return this.app.db;
  }
  private async access(
    p: Principal,
    admin = false,
    q: Queryable = this.db.pool,
  ) {
    admin ? requireAdmin(p) : requireStaff(p);
    const member = await this.db.one(
      "SELECT role FROM memberships WHERE workspace_id=$1 AND user_id=$2",
      [p.workspaceId, p.userId],
      q,
    );
    if (!member || (admin && !["owner", "admin"].includes(member.role)))
      throw new HttpError(403, "Staff authority was revoked");
  }
  async dependencies(
    ws: string,
    channelId: string,
    q: Queryable = this.db.pool,
  ) {
    const w = requireValue(
      await this.db.one(
        "SELECT settings,revision FROM workspaces WHERE id=$1",
        [ws],
        q,
      ),
    );
    const channel = requireValue(
      await this.db.one(
        "SELECT kind,published,settings FROM channels WHERE workspace_id=$1 AND id=$2",
        [ws, channelId],
        q,
      ),
    );
    const actions = await this.db.rows(
      "SELECT * FROM actions WHERE workspace_id=$1 ORDER BY id",
      [ws],
      q,
    );
    const connections = await this.db.rows(
      "SELECT provider,revision,status,metadata FROM connections WHERE workspace_id=$1 ORDER BY provider",
      [ws],
      q,
    );
    const catalog = await this.db.rows(
      "SELECT s.id,s.revision,s.visibility,s.status,d.id document,d.version FROM sources s LEFT JOIN documents d ON d.source_id=s.id AND d.active WHERE s.workspace_id=$1 AND s.active AND s.status='ready' AND s.visibility='customer' ORDER BY s.id,d.id",
      [ws],
      q,
    );
    const baseline = await effectiveWorkflow(this.db, ws, channelId, q);
    // Credential revisions change on replacement/disconnect, not routine OAuth refresh.
    return {
      fingerprint: digest({
        workspace: w,
        channel,
        actions,
        connections,
        catalog,
        baseline: baseline?.version ?? null,
      }),
      settings: Settings.parse(w.settings),
      channel,
      actions,
      catalog,
      baseline,
    };
  }
  async createCandidate(p: Principal, raw: unknown) {
    const input = ShadowCandidateInput.parse(raw);
    return this.db.tx(async (q) => {
      await this.access(p, true, q);
      await q.query("SELECT id FROM workspaces WHERE id=$1 FOR UPDATE", [
        p.workspaceId,
      ]);
      const draft =
        input.draftChannel === "default"
          ? await this.db.one(
              "SELECT * FROM workflows WHERE workspace_id=$1",
              [p.workspaceId],
              q,
            )
          : await this.db.one(
              "SELECT * FROM channel_workflows WHERE workspace_id=$1 AND channel=$2",
              [p.workspaceId, input.draftChannel],
              q,
            );
      if (!draft || draft.revision !== input.revision)
        throw new HttpError(
          409,
          "Save and review the current workflow draft before creating a candidate",
        );
      const def = WorkflowDefinition.parse(draft.draft),
        problems = await this.app.workflows.problems(p.workspaceId, def, q);
      if (problems.length) throw new HttpError(400, problems.join("\n"));
      const compiled = await this.app.workflows.components.expand(
        p.workspaceId,
        def,
        q,
      );
      const ch = requireValue(
        await this.db.one(
          "SELECT id FROM channels WHERE workspace_id=$1 AND kind=$2",
          [p.workspaceId, input.channel],
          q,
        ),
      );
      const deps = await this.dependencies(p.workspaceId, ch.id, q);
      if (!deps.baseline)
        throw new HttpError(
          409,
          "Publish a baseline workflow before creating a shadow candidate",
        );
      const settings = {
        ...deps.settings,
        ...(input.model ? { model: input.model } : {}),
        ...(input.provider ? { responseProvider: input.provider } : {}),
      };
      if (input.model || input.provider)
        for (const n of compiled.nodes)
          if (n.type === "agent") {
            if (input.model) n.data.model = input.model;
            if (input.provider) n.data.provider = input.provider;
          }
      const version = Number(
        (await this.db.one(
          "SELECT COALESCE(max(version),0)+1 v FROM workflow_versions WHERE workspace_id=$1",
          [p.workspaceId],
          q,
        ))!.v,
      );
      await q.query(
        "INSERT INTO workflow_versions(workspace_id,version,title,definition,created_by,compiled_definition,channel) VALUES($1,$2,$3,$4,$5,$6,'candidate')",
        [p.workspaceId, version, input.name, def, p.userId, compiled],
      );
      const snapshot = {
        definition: compiled,
        draftDefinition: def,
        settings,
        actions: deps.actions,
        catalog: deps.catalog,
        baselineVersion: deps.baseline.version,
        baselineDefinition: deps.baseline.definition,
        channel: input.channel,
        modelOverride: input.model ?? null,
        providerOverride: input.provider ?? null,
      };
      const row = await this.db.one(
        "INSERT INTO shadow_candidates(id,workspace_id,name,channel_id,draft_channel,draft_revision,workflow_version,snapshot,fingerprint,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *",
        [
          uid(),
          p.workspaceId,
          input.name,
          ch.id,
          input.draftChannel,
          input.revision,
          version,
          snapshot,
          deps.fingerprint,
          p.userId,
        ],
        q,
      );
      await this.db.event(q, p.workspaceId, "shadow.candidate_created", {
        candidateId: row!.id,
        actor: p.userId,
      });
      return row;
    });
  }
  async start(p: Principal, raw: unknown) {
    const input = ShadowStart.parse(raw),
      hash = digest(input);
    return this.db.tx(async (q) => {
      await this.access(p, true, q);
      await q.query("SELECT id FROM workspaces WHERE id=$1 FOR UPDATE", [
        p.workspaceId,
      ]);
      const prior = await this.db.one(
        "SELECT * FROM shadow_experiments WHERE workspace_id=$1 AND request_key=$2",
        [p.workspaceId, input.requestKey],
        q,
      );
      if (prior) {
        if (prior.request_hash !== hash)
          throw new HttpError(
            409,
            "Request key belongs to a different experiment",
          );
        return this.publicExperiment(prior);
      }
      const candidate = requireValue(
        await this.db.one(
          "SELECT * FROM shadow_candidates WHERE workspace_id=$1 AND id=$2",
          [p.workspaceId, input.candidateId],
          q,
        ),
      );
      if (
        (await this.dependencies(p.workspaceId, candidate.channel_id, q))
          .fingerprint !== candidate.fingerprint
      )
        throw new HttpError(
          409,
          "Candidate dependencies changed. Snapshot a fresh candidate.",
        );
      if (
        await this.db.one(
          "SELECT id FROM shadow_experiments WHERE workspace_id=$1 AND channel_id=$2 AND status='active'",
          [p.workspaceId, candidate.channel_id],
          q,
        )
      )
        throw new HttpError(
          409,
          "Stop the active experiment on this channel first",
        );
      const row = await this.db.one(
        "INSERT INTO shadow_experiments(id,workspace_id,candidate_id,channel_id,config,sampling_key,created_by,request_key,request_hash,ends_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,now()+($10::int*interval '1 hour')) RETURNING *",
        [
          uid(),
          p.workspaceId,
          candidate.id,
          candidate.channel_id,
          input,
          token(),
          p.userId,
          input.requestKey,
          hash,
          input.hours,
        ],
        q,
      );
      await this.db.event(q, p.workspaceId, "shadow.started", {
        experimentId: row!.id,
        actor: p.userId,
      });
      return this.publicExperiment(row!);
    });
  }
  private publicExperiment(row: Row) {
    const { sampling_key, request_hash, ...safe } = row;
    return safe;
  }
  async dashboard(p: Principal) {
    await this.access(p);
    const candidates = await this.db.rows(
      "SELECT * FROM shadow_candidates WHERE workspace_id=$1 ORDER BY created_at DESC LIMIT 100",
      [p.workspaceId],
    );
    for (const c of candidates)
      c.stale =
        (await this.dependencies(p.workspaceId, c.channel_id)).fingerprint !==
        c.fingerprint;
    const experiments = await this.db.rows(
      `SELECT e.*,c.name,(SELECT jsonb_object_agg(s.status,s.n) FROM (SELECT status,count(*) n FROM shadow_results WHERE experiment_id=e.id GROUP BY status) s) counts,(SELECT coalesce(sum(input_tokens+output_tokens),0) FROM usage WHERE workspace_id=e.workspace_id AND experiment_id=e.id) tokens,(SELECT coalesce(sum(reserved),0) FROM usage WHERE workspace_id=e.workspace_id AND experiment_id=e.id) reserved FROM shadow_experiments e JOIN shadow_candidates c ON c.id=e.candidate_id WHERE e.workspace_id=$1 ORDER BY started_at DESC LIMIT 100`,
      [p.workspaceId],
    );
    const rollouts = await this.db.rows(
      `SELECT r.*,c.name,(SELECT count(*) FROM canary_assignments a WHERE a.rollout_id=r.id AND a.variant='candidate') assigned,(SELECT coalesce(sum(input_tokens+output_tokens+reserved),0) FROM usage WHERE workspace_id=r.workspace_id AND rollout_id=r.id) tokens FROM canary_rollouts r JOIN shadow_candidates c ON c.id=r.candidate_id WHERE r.workspace_id=$1 ORDER BY started_at DESC LIMIT 100`,
      [p.workspaceId],
    );
    return {
      candidates,
      experiments: experiments.map((r) => this.publicExperiment(r)),
      rollouts: rollouts.map((r) => this.publicExperiment(r)),
    };
  }
  async results(p: Principal, id: string) {
    await this.access(p);
    const exp = requireValue(
      await this.db.one(
        "SELECT e.*,c.snapshot,c.fingerprint FROM shadow_experiments e JOIN shadow_candidates c ON c.id=e.candidate_id WHERE e.workspace_id=$1 AND e.id=$2",
        [p.workspaceId, id],
      ),
    );
    const stale =
      exp.fingerprint !==
      (await this.dependencies(p.workspaceId, exp.channel_id)).fingerprint;
    const rows = await this.db.rows(
      `SELECT r.*,(SELECT jsonb_agg(u) FROM (SELECT purpose,provider,model,sum(input_tokens) input_tokens,sum(output_tokens) output_tokens,sum(reserved) reserved FROM usage WHERE workspace_id=r.workspace_id AND context_id=r.id GROUP BY purpose,provider,model) u) usage FROM shadow_results r WHERE workspace_id=$1 AND experiment_id=$2 ORDER BY created_at DESC LIMIT 200`,
      [p.workspaceId, id],
    );
    for (const r of rows) {
      const contact = await this.db.one(
        "SELECT ct.revision,ct.verified FROM conversations c JOIN contacts ct ON ct.id=c.contact_id WHERE c.workspace_id=$1 AND c.id=$2",
        [p.workspaceId, r.conversation_id],
      );
      if (
        stale ||
        !contact ||
        contact.revision !== r.contact_snapshot?.revision ||
        contact.verified !== r.contact_snapshot?.verified
      ) {
        r.output = null;
        r.baseline = null;
        r.judge = null;
        r.history = [];
        r.fixtures = {};
        r.contact_snapshot = null;
        r.error =
          "Source or identity authority changed; retained result is no longer available for comparison";
      }
    }
    return {
      experiment: this.publicExperiment(exp),
      stale,
      results: rows,
      interpretation:
        "One-turn counterfactual comparison on actual customer-visible history. Separate Test Lab scenarios test autonomous multi-turn behavior. Shadow queue latency is not production p95; shadow has no CSAT or resolution outcomes.",
    };
  }
  async captureTurn(q: PoolClient, conv: Row, runId: string) {
    for (const exp of await this.db.rows(
      "SELECT * FROM shadow_experiments WHERE workspace_id=$1 AND channel_id=$2 AND status='active' AND ends_at>now() AND started_at<=now() FOR UPDATE",
      [conv.workspace_id, conv.channel_id],
      q,
    )) {
      const count = Number(
        (await this.db.one(
          "SELECT count(*) n FROM shadow_results WHERE experiment_id=$1 AND status<>'excluded'",
          [exp.id],
          q,
        ))!.n,
      );
      const contact = requireValue(
        await this.db.one(
          "SELECT id,revision,verified,name,email,mappings FROM contacts WHERE workspace_id=$1 AND id=$2",
          [conv.workspace_id, conv.contact_id],
          q,
        ),
      );
      const sample =
        count < exp.config.maxSamples &&
        (!exp.config.verifiedOnly || contact.verified) &&
        selected(
          exp.sampling_key,
          `${conv.id}:${conv.revision}`,
          exp.config.samplePercent,
        );
      const counts = sample
        ? Object.fromEntries(
            (
              await this.db.rows(
                "SELECT a.id,count(o.id)::int n FROM actions a LEFT JOIN operations o ON o.workspace_id=a.workspace_id AND o.action_id=a.id AND o.created_at>=date_trunc('day',now()) AND o.status<>'failed' WHERE a.workspace_id=$1 GROUP BY a.id",
                [conv.workspace_id],
                q,
              )
            ).map((a) => [a.id, a.n]),
          )
        : {};
      const history = sample
        ? (
            await this.db.rows(
              "SELECT role,body FROM messages WHERE workspace_id=$1 AND conversation_id=$2 AND (role='customer' OR (role IN ('assistant','staff','reminder') AND delivered_at IS NOT NULL)) ORDER BY created_at DESC,id DESC LIMIT 20",
              [conv.workspace_id, conv.id],
              q,
            )
          ).reverse()
        : [];
      await q.query(
        "INSERT INTO shadow_results(id,workspace_id,experiment_id,conversation_id,source_run_id,source_revision,status,history,contact_snapshot,conversation_snapshot) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT DO NOTHING",
        [
          uid(),
          conv.workspace_id,
          exp.id,
          conv.id,
          runId,
          conv.revision,
          sample ? "waiting_baseline" : "excluded",
          JSON.stringify(history),
          sample ? contact : null,
          sample
            ? {
                actionCounts: counts,
                id: conv.id,
                subject: conv.subject,
                priority: conv.priority,
                category: conv.category,
                status: conv.status,
                channel: (
                  await this.db.one(
                    "SELECT kind FROM channels WHERE id=$1",
                    [conv.channel_id],
                    q,
                  )
                )?.kind,
              }
            : null,
        ],
      );
    }
  }
  async captureRead(run: Row, read: CapturedRead) {
    // Only already-sampled traffic retains authorized read outputs. Capture does
    // not perform another provider lookup or include credentials/attachment bytes.
    const value = {
      result: read.result,
      proof: read.proof ?? null,
      at: new Date().toISOString(),
    };
    if (Buffer.byteLength(JSON.stringify(value)) > 65536) return;
    await this.db.pool.query(
      `UPDATE shadow_results r SET fixtures=jsonb_set(fixtures,ARRAY[$3::text],$4::jsonb) FROM shadow_experiments e WHERE r.experiment_id=e.id AND r.workspace_id=$1 AND r.source_run_id=$2 AND r.status='waiting_baseline' AND e.status='active' AND e.ends_at>now() AND pg_column_size(r.fixtures)<262144`,
      [run.workspace_id, run.id, read.key, value],
    );
  }
  async observe(q: PoolClient, event: Row) {
    if (
      (event.kind === "agent.step" &&
        ["completed", "handed_off", "stale"].includes(event.data.status)) ||
      event.kind === "response.delivered"
    ) {
      const run = await this.db.one(
        "SELECT * FROM runs WHERE workspace_id=$1 AND id=$2",
        [event.workspace_id, event.data.runId],
        q,
      );
      if (!run) return;
      const delivered = await this.db.one(
        "SELECT body,citations FROM messages WHERE workspace_id=$1 AND run_id=$2 AND role='assistant' AND delivered_at IS NOT NULL ORDER BY created_at DESC LIMIT 1",
        [run.workspace_id, run.id],
        q,
      );
      if (!delivered && run.status !== "stale") return;
      const baseline = {
        answer: delivered?.body ?? "",
        intent: run.state.route,
        citations: delivered?.citations ?? [],
        action: run.state.proposal ?? null,
        error: run.state.error ?? null,
        workflowVersion: run.workflow_version,
        trace: (
          await this.db.rows(
            "SELECT data FROM events WHERE workspace_id=$1 AND conversation_id=$2 AND kind='agent.step' AND data->>'runId'=$3 ORDER BY id",
            [run.workspace_id, run.conversation_id, run.id],
            q,
          )
        ).map((r) => r.data),
      };
      const rows = await this.db.rows(
        "UPDATE shadow_results SET status=$3,baseline=$4,baseline_ms=(extract(epoch from ($5::timestamptz-$6::timestamptz))*1000)::int WHERE workspace_id=$1 AND source_run_id=$2 AND status='waiting_baseline' RETURNING id",
        [
          run.workspace_id,
          run.id,
          run.status === "stale" ? "missing_baseline" : "queued",
          baseline,
          run.updated_at,
          run.created_at,
        ],
        q,
      );
      for (const r of rows)
        if (run.status !== "stale")
          await this.db.enqueue(q, "shadow", {
            workspaceId: run.workspace_id,
            resultId: r.id,
          });
    }
  }
  private async authorize(row: Row, q: Queryable = this.db.pool) {
    const source = requireValue(
      await this.db.one(
        `SELECT r.status,c.contact_id,ct.revision,ct.verified FROM shadow_results r JOIN conversations c ON c.id=r.conversation_id JOIN contacts ct ON ct.id=c.contact_id WHERE r.workspace_id=$1 AND r.id=$2`,
        [row.workspace_id, row.id],
        q,
      ),
      409,
      "Source conversation was deleted",
    );
    if (!["queued", "running"].includes(source.status))
      throw new HttpError(409, "Comparison canceled or no longer running");
    const exp = requireValue(
      await this.db.one(
        "SELECT * FROM shadow_experiments WHERE workspace_id=$1 AND id=$2 AND status='active' AND ends_at>now()",
        [row.workspace_id, row.experiment_id],
        q,
      ),
      409,
      "Experiment stopped, expired or paused",
    );
    await this.access(
      { workspaceId: row.workspace_id, userId: exp.created_by, role: "admin" },
      true,
      q,
    );
    if (
      source.contact_id !== row.contact_snapshot.id ||
      source.revision !== row.contact_snapshot.revision ||
      source.verified !== row.contact_snapshot.verified
    )
      throw new HttpError(
        409,
        "Customer identity changed; captured fixtures are no longer authorized",
      );
    const candidate = requireValue(
      await this.db.one(
        "SELECT * FROM shadow_candidates WHERE workspace_id=$1 AND id=$2",
        [row.workspace_id, exp.candidate_id],
        q,
      ),
    );
    if (
      candidate.fingerprint !==
      (await this.dependencies(row.workspace_id, exp.channel_id, q)).fingerprint
    )
      throw new HttpError(
        409,
        "Candidate dependencies changed; snapshot a new candidate",
      );
    return { exp, candidate };
  }
  async advance(ws: string, id: string) {
    const lock = await this.db.pool.connect();
    try {
      if (
        !(
          await lock.query(
            "SELECT pg_try_advisory_lock(hashtextextended($1,0)) locked",
            [`shadow:${ws}:${id}`],
          )
        ).rows[0].locked
      )
        return;
      const row = await this.db.one(
        "SELECT * FROM shadow_results WHERE workspace_id=$1 AND id=$2",
        [ws, id],
      );
      if (!row || !["queued", "running"].includes(row.status)) return;
      if (row.status === "running") {
        await this.db.pool.query(
          "UPDATE shadow_results SET status='uncertain',error='Worker interrupted during evaluation. Explicit retry may incur another charge.' WHERE id=$1",
          [id],
        );
        return;
      }
      try {
        const { exp, candidate } = await this.authorize(row);
        const claimed = await this.db.tx(async (q) => {
          // Aggregate concurrency is separate from production worker slots.
          await q.query(
            "SELECT id FROM shadow_experiments WHERE id=$1 FOR UPDATE",
            [exp.id],
          );
          const running = Number(
            (await this.db.one(
              "SELECT count(*) n FROM shadow_results WHERE experiment_id=$1 AND status='running'",
              [exp.id],
              q,
            ))!.n,
          );
          const production = await this.db.one(
            "SELECT id FROM runs WHERE workspace_id=$1 AND status IN ('queued','running') LIMIT 1",
            [ws],
            q,
          );
          if (production || running >= exp.config.concurrency) return false;
          return !!(await this.db.one(
            "UPDATE shadow_results SET status='running',started_at=now(),error=NULL WHERE id=$1 AND status='queued' RETURNING id",
            [id],
            q,
          ));
        });
        if (!claimed) return;
        const fixtures: any = {
          customer: row.contact_snapshot,
          steps: {},
          dailyActionCount: 0,
        };
        const read = async (request: FixtureRequest) => {
          await this.authorize(row);
          const value =
            row.fixtures[fixtureKey(request.kind, request.node, request.input)];
          if (!value)
            throw new HttpError(
              409,
              "blocked_missing_fixture: No captured read matches the exact step contract and input",
            );
          if (value.proof) await this.app.actions.revalidate(ws, value.proof);
          return structuredClone(value.result);
        };
        const started = Date.now(),
          scope = {
            purpose: "shadow",
            shadowId: id,
            experimentId: exp.id,
            settings: candidate.snapshot.settings,
          };
        const output = await usageContext.run(scope, () =>
          this.engine.previewWorkflow(
            ws,
            candidate.snapshot.definition,
            row.history.filter((m: Row) => m.role === "customer").at(-1)
              ?.body ?? "",
            row.contact_snapshot,
            candidate.snapshot.channel,
            {},
            {
              evaluation: {
                fixtures,
                actions: candidate.snapshot.actions,
                settings: candidate.snapshot.settings,
                conversation: row.conversation_snapshot,
                readFixture: read,
                actionCounts: row.conversation_snapshot?.actionCounts ?? {},
                beforeStep: async () => {
                  await this.authorize(row);
                },
              },
              messages: row.history,
              runId: `shadow-${id}`,
            },
          ),
        );
        await this.authorize(row);
        const rules = [
          {
            name: "No business actions executed",
            passed: output.actionsExecuted === false,
            hard: true,
          },
          {
            name: "Captured read coverage",
            passed: !output.blocked,
            hard: true,
          },
          {
            name: "Approved citations remain accessible",
            passed: await this.app.knowledge.validEvidence(
              ws,
              output.citations.filter((c) => !c.id.startsWith("step:")),
            ),
            hard: true,
          },
        ];
        let judge = null;
        // Optional judging has a separate purpose but shares the same atomic caps.
        if (exp.config.judge && !output.blocked) {
          if (!this.app.model.judge)
            throw new HttpError(
              409,
              "The model adapter does not support AI assessment",
            );
          judge = JudgeResult.parse(
            await usageContext.run(
              { ...scope, purpose: "shadow_judging" },
              () =>
                this.app.model.judge!({
                  workspaceId: ws,
                  model: candidate.snapshot.settings.model,
                  provider: candidate.snapshot.settings.responseProvider,
                  payload: {
                    question: row.history.at(-1)?.body,
                    answer: output.answer,
                    reference: row.baseline?.answer,
                    evidence: output.citations,
                    action: output.action,
                  },
                }),
            ),
          );
          if (
            judge.citationIds.some(
              (c) => !output.citations.some((e) => e.id === c),
            )
          )
            throw new HttpError(409, "Judge cited unavailable evidence");
        }
        await this.authorize(row);
        if (/budget|token cap|allocation/i.test(output.blocked ?? ""))
          throw new HttpError(429, output.blocked!);
        const blocked = output.blocked,
          unresolved = await this.db.one(
            "SELECT 1 FROM usage WHERE workspace_id=$1 AND context_id=$2 AND reserved>0",
            [ws, id],
          );
        await this.db.pool.query(
          "UPDATE shadow_results SET status=$2,output=$3,rules=$4,judge=$5,execution_ms=$6,finished_at=now(),error=$7 WHERE id=$1 AND status='running'",
          [
            id,
            unresolved
              ? "uncertain"
              : blocked
                ? /fixture/i.test(blocked)
                  ? "blocked_missing_fixture"
                  : "blocked"
                : "completed",
            output,
            JSON.stringify(rules),
            judge,
            Date.now() - started,
            unresolved
              ? "Model usage outcome remains uncertain; inspect reservations"
              : blocked,
          ],
        );
      } catch (error) {
        const message = (
            error instanceof Error ? error.message : "Evaluation failed"
          ).slice(0, 2000),
          uncertain = !!(await this.db.one(
            "SELECT 1 FROM usage WHERE workspace_id=$1 AND context_id=$2 AND reserved>0",
            [ws, id],
          ));
        const status = uncertain
          ? "uncertain"
          : /budget|token cap|allocation/i.test(message)
            ? "budget_exhausted"
            : /fixture/.test(message)
              ? "blocked_missing_fixture"
              : /stopped|canceled|expired|paused/.test(message)
                ? "canceled"
                : "failed";
        await this.db.pool.query(
          "UPDATE shadow_results SET status=$2,error=$3,finished_at=now() WHERE id=$1 AND status IN ('running','queued')",
          [id, status, message],
        );
        if (status === "budget_exhausted")
          await this.db.pool.query(
            "UPDATE shadow_experiments SET status='budget_exhausted',reason=$2 WHERE id=(SELECT experiment_id FROM shadow_results WHERE id=$1)",
            [id, message],
          );
      }
      await this.db.event(this.db.pool, ws, "shadow.updated", { resultId: id });
    } finally {
      await lock.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [
        `shadow:${ws}:${id}`,
      ]);
      lock.release();
    }
  }
  async control(p: Principal, id: string, raw: unknown) {
    const input = ShadowControl.parse(raw);
    await this.db.tx(async (q) => {
      await this.access(p, true, q);
      const exp = requireValue(
        await this.db.one(
          "SELECT * FROM shadow_experiments WHERE workspace_id=$1 AND id=$2 FOR UPDATE",
          [p.workspaceId, id],
          q,
        ),
      );
      if (input.action === "stop") {
        await q.query(
          "UPDATE shadow_experiments SET status='stopped',reason='Stopped by staff' WHERE id=$1",
          [id],
        );
        await q.query(
          "UPDATE shadow_results SET status='canceled',error='Experiment stopped by staff' WHERE experiment_id=$1 AND status IN ('queued','running','waiting_baseline')",
          [id],
        );
      } else {
        if (!input.acknowledgeUncertain || !input.resultId)
          throw new HttpError(
            400,
            "Choose a result and acknowledge possible duplicate model charges",
          );
        if (exp.status !== "active" || new Date(exp.ends_at) < new Date())
          throw new HttpError(
            409,
            "Start a new experiment after a stopped, expired or budget-exhausted experiment",
          );
        const r = requireValue(
          await this.db.one(
            "UPDATE shadow_results SET status='queued',error=NULL WHERE workspace_id=$1 AND experiment_id=$2 AND id=$3 AND status IN ('failed','uncertain','blocked_missing_fixture') RETURNING id",
            [p.workspaceId, id, input.resultId],
            q,
          ),
          409,
          "Result is not retryable",
        );
        await this.db.enqueue(q, "shadow", {
          workspaceId: p.workspaceId,
          resultId: r.id,
        });
      }
      await this.db.event(q, p.workspaceId, "shadow.controlled", {
        experimentId: id,
        action: input.action,
        actor: p.userId,
      });
    });
    return { ok: true };
  }
  async review(p: Principal, id: string, raw: unknown) {
    const input = ShadowReview.parse(raw);
    await this.access(p);
    return requireValue(
      await this.db.one(
        "UPDATE shadow_results SET reviews=reviews||$3::jsonb WHERE workspace_id=$1 AND id=$2 AND status='completed' RETURNING id,reviews",
        [
          p.workspaceId,
          id,
          JSON.stringify([
            { ...input, actor: p.userId, at: new Date().toISOString() },
          ]),
        ],
      ),
      409,
      "Only completed comparisons can be reviewed",
    );
  }
  async regression(p: Principal, id: string) {
    await this.access(p);
    const r = requireValue(
      await this.db.one(
        "SELECT * FROM shadow_results WHERE workspace_id=$1 AND id=$2",
        [p.workspaceId, id],
      ),
    );
    const result = await this.results(p, r.experiment_id),
      visible = result.results.find((x) => x.id === id);
    if (!visible?.history.length)
      throw new HttpError(409, "Comparison source is unavailable");
    // Reuse the existing Test Lab privacy review before saving copied personal data.
    return TestCase.parse({
      id: uid(),
      name: "Shadow regression draft",
      channel: r.conversation_snapshot?.channel ?? "portal",
      turns: r.history
        .filter((m: Row) => m.role === "customer")
        .map((m: Row) => ({ question: m.body, expected: {} })),
      sourceConversationId: r.conversation_id,
      personalDataReviewed: false,
      fixtures: {},
    });
  }
  async startCanary(p: Principal, raw: unknown) {
    const input = CanaryStart.parse(raw),
      hash = digest(input);
    await this.access(p, true);
    await this.app.readiness.assertPublication(p.workspaceId);
    return this.db.tx(async (q) => {
      await this.access(p, true, q);
      await q.query("SELECT id FROM workspaces WHERE id=$1 FOR UPDATE", [
        p.workspaceId,
      ]);
      const old = await this.db.one(
        "SELECT * FROM canary_rollouts WHERE workspace_id=$1 AND request_key=$2",
        [p.workspaceId, input.requestKey],
        q,
      );
      if (old) {
        if (old.request_hash !== hash)
          throw new HttpError(
            409,
            "Request key belongs to a different rollout",
          );
        return this.publicExperiment(old);
      }
      const exp = requireValue(
        await this.db.one(
          "SELECT e.*,c.snapshot,c.fingerprint FROM shadow_experiments e JOIN shadow_candidates c ON c.id=e.candidate_id WHERE e.workspace_id=$1 AND e.id=$2",
          [p.workspaceId, input.experimentId],
          q,
        ),
      );
      const deps = await this.dependencies(p.workspaceId, exp.channel_id, q);
      if (deps.fingerprint !== exp.fingerprint || !deps.channel.published)
        throw new HttpError(
          409,
          "Channel is unpublished or candidate evidence is stale",
        );
      const evidence = await this.db.rows(
        "SELECT status,rules,reviews FROM shadow_results WHERE workspace_id=$1 AND experiment_id=$2 AND status<>'excluded'",
        [p.workspaceId, exp.id],
        q,
      );
      const reviewed = evidence.filter(
        (r) =>
          r.status === "completed" &&
          r.rules?.every((c: Row) => !c.hard || c.passed) &&
          r.reviews?.at(-1)?.verdict === "pass",
      );
      if (
        reviewed.length < input.reviewThreshold ||
        evidence.some(
          (r) =>
            r.rules?.some((c: Row) => c.hard && !c.passed) ||
            r.reviews?.at(-1)?.verdict === "fail",
        )
      )
        throw new HttpError(
          409,
          "Review enough completed, passing shadow comparisons and resolve all hard failures before rollout",
        );
      if (
        await this.db.one(
          "SELECT id FROM canary_rollouts WHERE workspace_id=$1 AND channel_id=$2 AND status='active'",
          [p.workspaceId, exp.channel_id],
          q,
        )
      )
        throw new HttpError(409, "Stop the current rollout first");
      const row = await this.db.one(
        "INSERT INTO canary_rollouts(id,workspace_id,experiment_id,channel_id,candidate_id,percent,token_cap,max_failures,sampling_key,created_by,decision,review_threshold,request_key,request_hash,ends_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,now()+($15::int*interval '1 hour')) RETURNING *",
        [
          uid(),
          p.workspaceId,
          exp.id,
          exp.channel_id,
          exp.candidate_id,
          input.percent,
          input.tokenCap,
          input.maxFailures,
          token(),
          p.userId,
          input.decision,
          input.reviewThreshold,
          input.requestKey,
          hash,
          input.hours,
        ],
        q,
      );
      await this.db.event(q, p.workspaceId, "rollout.started", {
        rolloutId: row!.id,
        percent: input.percent,
        actor: p.userId,
        decision: input.decision,
      });
      return this.publicExperiment(row!);
    });
  }
  async selectWorkflow(q: PoolClient, conv: Row) {
    const baseline = await effectiveWorkflow(
      this.db,
      conv.workspace_id,
      conv.channel_id,
      q,
    );
    let assignment = await this.db.one(
      "SELECT * FROM canary_assignments WHERE workspace_id=$1 AND conversation_id=$2",
      [conv.workspace_id, conv.id],
      q,
    );
    if (!assignment) {
      const rollout = await this.db.one(
        "SELECT r.*,c.snapshot,c.fingerprint,c.workflow_version FROM canary_rollouts r JOIN shadow_candidates c ON c.id=r.candidate_id WHERE r.workspace_id=$1 AND r.channel_id=$2 AND r.status='active' AND r.ends_at>now() AND r.started_at<=$3 AND (NOT (SELECT (e.config->>'verifiedOnly')::boolean FROM shadow_experiments e WHERE e.id=r.experiment_id) OR EXISTS(SELECT 1 FROM contacts ct WHERE ct.workspace_id=r.workspace_id AND ct.id=$4 AND ct.verified)) ORDER BY r.started_at DESC LIMIT 1",
        [conv.workspace_id, conv.channel_id, conv.created_at, conv.contact_id],
        q,
      );
      // Strictly new conversations, never a new turn on pre-existing history.
      if (rollout && conv.revision === 1) {
        const deps = await this.dependencies(
          conv.workspace_id,
          conv.channel_id,
          q,
        );
        const valid =
          deps.fingerprint === rollout.fingerprint &&
          deps.channel.published &&
          !!(await this.db.one(
            "SELECT 1 FROM memberships WHERE workspace_id=$1 AND user_id=$2 AND role IN ('owner','admin')",
            [conv.workspace_id, rollout.created_by],
            q,
          ));
        if (valid) {
          const variant = selected(
            rollout.sampling_key,
            conv.id,
            rollout.percent,
          )
            ? "candidate"
            : "baseline";
          assignment = await this.db.one(
            "INSERT INTO canary_assignments(workspace_id,conversation_id,rollout_id,generation,variant,workflow_version) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING RETURNING *",
            [
              conv.workspace_id,
              conv.id,
              rollout.id,
              rollout.generation,
              variant,
              variant === "candidate"
                ? rollout.workflow_version
                : rollout.snapshot.baselineVersion,
            ],
            q,
          );
          await this.db.event(
            q,
            conv.workspace_id,
            "rollout.assigned",
            { rolloutId: rollout.id, variant, generation: rollout.generation },
            conv.id,
          );
        }
      }
    }
    if (assignment?.variant === "candidate" && !assignment.revoked) {
      try {
        await this.authority(
          {
            workspace_id: conv.workspace_id,
            conversation_id: conv.id,
            workflow_version: assignment.workflow_version,
            rollout_id: assignment.rollout_id,
            rollout_generation: assignment.generation,
          },
          q,
        );
        const version = requireValue(
          await this.db.one(
            "SELECT version,coalesce(compiled_definition,definition) definition FROM workflow_versions WHERE workspace_id=$1 AND version=$2",
            [conv.workspace_id, assignment.workflow_version],
            q,
          ),
        );
        return {
          ...version,
          rolloutId: assignment.rollout_id,
          rolloutGeneration: assignment.generation,
        };
      } catch {
        await q.query(
          "UPDATE conversations SET mode='human',status='needs_staff',revision=revision+1 WHERE workspace_id=$1 AND id=$2 AND mode='agent'",
          [conv.workspace_id, conv.id],
        );
        await this.db.event(
          q,
          conv.workspace_id,
          "conversation.updated",
          {
            mode: "human",
            status: "needs_staff",
            handoffCategory: "rollout_stopped",
          },
          conv.id,
          true,
        );
        return { blocked: true };
      }
    }
    return baseline;
  }
  async authority(run: Row, q: Queryable = this.db.pool) {
    const r = requireValue(
      await this.db.one(
        `SELECT r.*,c.snapshot,c.fingerprint,c.workflow_version candidate_version,a.variant,a.workflow_version assigned_version,a.revoked,a.generation assigned_generation,conv.channel_id actual_channel FROM canary_rollouts r JOIN shadow_candidates c ON c.id=r.candidate_id JOIN canary_assignments a ON a.rollout_id=r.id JOIN conversations conv ON conv.id=a.conversation_id WHERE r.workspace_id=$1 AND r.id=$2 AND a.conversation_id=$3`,
        [run.workspace_id, run.rollout_id, run.conversation_id],
        q,
      ),
      409,
      "Rollout assignment is no longer available",
    );
    if (
      r.status !== "active" ||
      new Date(r.ends_at) <= new Date() ||
      r.revoked ||
      r.variant !== "candidate" ||
      r.generation !== run.rollout_generation ||
      r.assigned_generation !== run.rollout_generation ||
      r.actual_channel !== r.channel_id ||
      r.assigned_version !== run.workflow_version ||
      r.candidate_version !== run.workflow_version
    )
      throw new HttpError(409, "Rollout effect authority was revoked");
    await this.access(
      { workspaceId: run.workspace_id, userId: r.created_by, role: "admin" },
      true,
      q,
    );
    const deps = await this.dependencies(run.workspace_id, r.channel_id, q);
    if (
      !deps.channel.published ||
      deps.fingerprint !== r.fingerprint ||
      deps.baseline?.version !== r.snapshot.baselineVersion
    )
      throw new HttpError(
        409,
        "Rollout policy, sources, connector or baseline publication changed",
      );
    const spent = Number(
      (await this.db.one(
        "SELECT coalesce(sum(input_tokens+output_tokens+reserved),0) n FROM usage WHERE workspace_id=$1 AND rollout_id=$2",
        [run.workspace_id, r.id],
        q,
      ))!.n,
    );
    if (spent > r.token_cap)
      throw new HttpError(429, "Rollout token cap reached");
  }
  async stopCanary(ws: string, id: string, reason: string, actor: string) {
    await this.db.tx(async (q) => {
      await q.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        `rollout-effect:${ws}:${id}`,
      ]);
      const r = requireValue(
        await this.db.one(
          "SELECT * FROM canary_rollouts WHERE workspace_id=$1 AND id=$2 FOR UPDATE",
          [ws, id],
          q,
        ),
      );
      if (r.status !== "active") return;
      await q.query(
        "UPDATE canary_rollouts SET status='stopped',generation=generation+1,reason=$2 WHERE id=$1",
        [id, reason],
      );
      await q.query(
        "UPDATE canary_assignments SET revoked=true WHERE rollout_id=$1 AND variant='candidate'",
        [id],
      );
      const conversations = await this.db.rows(
        `SELECT DISTINCT c.id FROM conversations c JOIN runs r ON r.conversation_id=c.id WHERE r.workspace_id=$1 AND r.rollout_id=$2 AND (r.status IN ('queued','running','waiting_approval') OR EXISTS(SELECT 1 FROM deliveries d WHERE d.conversation_id=c.id AND d.status IN ('pending','sending','unknown')))`,
        [ws, id],
        q,
      );
      for (const c of conversations) {
        await q.query(
          "UPDATE conversations SET mode='human',status=CASE WHEN status='resolved' THEN status ELSE 'needs_staff' END,revision=revision+1 WHERE workspace_id=$1 AND id=$2",
          [ws, c.id],
        );
        await this.db.event(
          q,
          ws,
          "conversation.updated",
          {
            mode: "human",
            status: "needs_staff",
            handoffCategory: "rollout_stopped",
          },
          c.id,
          true,
        );
      }
      await q.query(
        "UPDATE approvals SET status='stale' WHERE workspace_id=$1 AND run_id IN (SELECT id FROM runs WHERE workspace_id=$1 AND rollout_id=$2) AND status IN ('pending','approved')",
        [ws, id],
      );
      await q.query(
        "UPDATE runs SET status='stale',updated_at=now() WHERE workspace_id=$1 AND rollout_id=$2 AND status IN ('queued','running','waiting_approval')",
        [ws, id],
      );
      await this.db.event(q, ws, "rollout.stopped", {
        rolloutId: id,
        reason,
        actor,
      });
    });
  }
  async controlCanary(p: Principal, id: string, raw: unknown) {
    const input = CanaryControl.parse(raw);
    await this.access(p, true);
    const r = requireValue(
      await this.db.one(
        "SELECT r.*,c.snapshot,c.draft_channel FROM canary_rollouts r JOIN shadow_candidates c ON c.id=r.candidate_id WHERE r.workspace_id=$1 AND r.id=$2",
        [p.workspaceId, id],
      ),
    );
    if (input.action === "stop")
      await this.stopCanary(p.workspaceId, id, input.reason, p.userId!);
    else if (input.action === "increase") {
      if (
        !input.percent ||
        input.percent <= r.percent ||
        r.status !== "active" ||
        new Date(r.ends_at) <= new Date()
      )
        throw new HttpError(
          400,
          "Choose a higher percentage for an active rollout",
        );
      const deps = await this.dependencies(p.workspaceId, r.channel_id);
      const c = requireValue(
        await this.db.one(
          "SELECT fingerprint FROM shadow_candidates WHERE id=$1",
          [r.candidate_id],
        ),
      );
      if (deps.fingerprint !== c.fingerprint)
        throw new HttpError(409, "Candidate authority changed");
      await this.db.pool.query(
        "UPDATE canary_rollouts SET percent=$3 WHERE workspace_id=$1 AND id=$2 AND status='active'",
        [p.workspaceId, id, input.percent],
      );
      await this.db.event(this.db.pool, p.workspaceId, "rollout.increased", {
        rolloutId: id,
        percent: input.percent,
        reason: input.reason,
        actor: p.userId,
      });
    } else {
      if (!input.draftRevision)
        throw new HttpError(
          400,
          "Review the current draft revision before promotion",
        );
      const current = await this.app.workflows.get(p, r.draft_channel),
        compiled = await this.app.workflows.components.expand(
          p.workspaceId,
          current.draft,
        );
      if (
        current.revision !== input.draftRevision ||
        digest(compiled) !== digest(r.snapshot.definition)
      )
        throw new HttpError(
          409,
          "Save and review a draft exactly matching the candidate, including model overrides, before promotion",
        );
      await this.app.readiness.assertPublication(p.workspaceId);
      await this.stopCanary(
        p.workspaceId,
        id,
        `Promotion through normal publication: ${input.reason}`,
        p.userId!,
      );
      await this.app.workflows.publish(p, input.draftRevision, r.draft_channel);
    }
    return { ok: true };
  }
  async emailGuard(q: PoolClient, ws: string, messageId: string) {
    const run = await this.db.one(
      "SELECT r.* FROM messages m JOIN runs r ON r.id=m.run_id WHERE m.workspace_id=$1 AND m.id=$2 AND r.rollout_id IS NOT NULL",
      [ws, messageId],
      q,
    );
    if (!run) return true;
    await q.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      `rollout-effect:${ws}:${run.rollout_id}`,
    ]);
    try {
      await this.authority(run, q);
      return true;
    } catch {
      return false;
    }
  }
  async retain(ws: string, days: number) {
    // Do not remove usage reservations; transcript deletion never resets a cap.
    await this.db.pool.query(
      "UPDATE shadow_results SET history='[]',contact_snapshot=NULL,conversation_snapshot=NULL,fixtures='{}',output=NULL,baseline=NULL,judge=NULL,rules='[]',reviews='[]',status=CASE WHEN status IN ('queued','running','waiting_baseline') THEN 'canceled' ELSE status END,error='Evidence removed by retention' WHERE workspace_id=$1 AND created_at<now()-($2::int*interval '1 day')",
      [ws, days],
    );
  }
  async reconcile() {
    for (const r of await this.db.rows(
      "SELECT r.*,c.fingerprint,c.snapshot FROM canary_rollouts r JOIN shadow_candidates c ON c.id=r.candidate_id WHERE r.status='active' ORDER BY r.started_at LIMIT 100",
    )) {
      const deps = await this.dependencies(r.workspace_id, r.channel_id);
      const failures = Number(
        (await this.db.one(
          "SELECT count(*) n FROM runs WHERE workspace_id=$1 AND rollout_id=$2 AND status IN ('handed_off','stale')",
          [r.workspace_id, r.id],
        ))!.n,
      );
      const spent = Number(
        (await this.db.one(
          "SELECT coalesce(sum(input_tokens+output_tokens+reserved),0) n FROM usage WHERE workspace_id=$1 AND rollout_id=$2",
          [r.workspace_id, r.id],
        ))!.n,
      );
      const actor = await this.db.one(
        "SELECT 1 FROM memberships WHERE workspace_id=$1 AND user_id=$2 AND role IN ('owner','admin')",
        [r.workspace_id, r.created_by],
      );
      const reason =
        new Date(r.ends_at) <= new Date()
          ? "Maximum rollout duration reached"
          : deps.fingerprint !== r.fingerprint
            ? "Published workflow, policy, source or connector changed"
            : !actor
              ? "Initiating administrator access revoked"
              : spent >= r.token_cap
                ? "Rollout token cap reached"
                : failures >= r.max_failures
                  ? "Configured operational failure threshold reached"
                  : null;
      if (reason) await this.stopCanary(r.workspace_id, r.id, reason, "system");
    }
    await this.db.pool.query(
      "UPDATE shadow_experiments SET status='expired',reason='Sampling end time reached' WHERE status='active' AND ends_at<=now()",
    );
    await this.db.pool.query(
      "UPDATE shadow_results r SET status='canceled',error='Experiment ended' FROM shadow_experiments e WHERE r.experiment_id=e.id AND e.status<>'active' AND r.status IN ('queued','waiting_baseline')",
    );
    await this.db.pool.query(
      "UPDATE shadow_results SET status='missing_baseline',error='Baseline did not complete within the comparison window' WHERE status='waiting_baseline' AND created_at<now()-interval '1 hour'",
    );
    const next = await this.db.rows(
      "SELECT r.workspace_id,r.id FROM shadow_results r JOIN shadow_experiments e ON e.id=r.experiment_id WHERE e.status='active' AND r.status='queued' ORDER BY r.created_at LIMIT 50",
    );
    for (const r of next)
      await this.db.tx((q) =>
        this.db.enqueue(q, "shadow", {
          workspaceId: r.workspace_id,
          resultId: r.id,
        }),
      );
  }
}
