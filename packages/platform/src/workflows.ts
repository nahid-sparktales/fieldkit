import {
  WorkflowComponents,
  ComponentDefinition,
  validateObject,
} from "./workflow-components.js";
import { newWorkflowNode } from "./workflow-definition.js";
import { z } from "zod";
import type { Database, Queryable } from "./db.js";
import { HttpError, requireValue } from "./config.js";
import { requireAdmin, requireStaff, type Principal } from "./auth.js";
import {
  WorkflowDefinition,
  defaultWorkflow,
  workflowProblems,
  type Workflow,
} from "./workflow-definition.js";
import type { Agent } from "./agent.js";

export class Workflows {
  components: WorkflowComponents;
  constructor(
    public db: Database,
    public agent: Agent,
  ) {
    this.components = new WorkflowComponents(db);
  }
  async resources(ws: string) {
    const [actions, sources, members, contacts, channels, connections] =
      await Promise.all([
        this.db.rows(
          "SELECT id,name,description,kind,enabled,policy,config->>'mappingKey' mapping_key,config->>'stripeMode' stripe_mode,config->'inputSchema' input_schema,config->'outputSchema' output_schema FROM actions WHERE workspace_id=$1 ORDER BY name",
          [ws],
        ),
        this.db.rows(
          "SELECT id,title,kind,visibility,status FROM sources WHERE workspace_id=$1 AND active ORDER BY title",
          [ws],
        ),
        this.db.rows(
          'SELECT m.user_id id,m.role,COALESCE(u.name,m.user_id) name FROM memberships m LEFT JOIN "user" u ON u.id=m.user_id WHERE m.workspace_id=$1',
          [ws],
        ),
        this.db.rows(
          "SELECT id,name,email,verified,ARRAY(SELECT jsonb_object_keys(mappings)) mapping_keys FROM contacts WHERE workspace_id=$1 ORDER BY name LIMIT 500",
          [ws],
        ),
        this.db.rows(
          "SELECT id,kind,published,settings FROM channels WHERE workspace_id=$1 ORDER BY kind",
          [ws],
        ),
        this.db.rows(
          "SELECT provider,status FROM connections WHERE workspace_id=$1 ORDER BY provider",
          [ws],
        ),
      ]);
    return {
      actions,
      sources,
      members,
      contacts,
      channels,
      connections,
      components: await this.components.list(ws),
      runnerConfigured: Boolean(
        this.db.config.FIELDKIT_RUNNER_URL &&
          this.db.config.FIELDKIT_RUNNER_TOKEN.length >= 32,
      ),
    };
  }
  async problems(ws: string, definition: Workflow, q?: Queryable) {
    const errors = workflowProblems(definition);
    let expanded = definition;
    if (!errors.length)
      try {
        expanded = await this.components.expand(ws, definition, q);
      } catch (e) {
        errors.push((e as Error).message);
      }
    for (const n of expanded.nodes) {
      if (n.type === "action" && n.data.actionIds.length) {
        const found = await this.db.rows(
          "SELECT id FROM actions WHERE workspace_id=$1 AND id=ANY($2::text[]) AND enabled",
          [ws, n.data.actionIds],
          q,
        );
        if (
          new Set(n.data.actionIds).size !== n.data.actionIds.length ||
          found.length !== n.data.actionIds.length
        )
          errors.push(
            `${n.title}: choose existing, enabled actions in this workspace.`,
          );
      }
      if (n.type === "knowledge" && n.data.scope === "selected") {
        const found = await this.db.rows(
          "SELECT id FROM sources WHERE workspace_id=$1 AND id=ANY($2::text[]) AND active AND status='ready' AND visibility='customer'",
          [ws, n.data.sourceIds],
          q,
        );
        if (
          new Set(n.data.sourceIds).size !== n.data.sourceIds.length ||
          found.length !== n.data.sourceIds.length
        )
          errors.push(
            `${n.title}: selected knowledge must be ready and customer-approved in this workspace.`,
          );
      }
      if (
        n.type === "handoff" &&
        n.data.assignedTo &&
        !(await this.db.one(
          "SELECT user_id FROM memberships WHERE workspace_id=$1 AND user_id=$2",
          [ws, n.data.assignedTo],
          q,
        ))
      )
        errors.push(`${n.title}: choose a current staff member.`);
    }
    return errors;
  }
  async get(p: Principal) {
    requireStaff(p);
    const ws = p.workspaceId,
      resources = await this.resources(ws);
    const row = await this.db.one(
      "SELECT * FROM workflows WHERE workspace_id=$1",
      [ws],
    );
    const draft = WorkflowDefinition.parse(
      row?.draft ??
        defaultWorkflow(
          resources.actions.filter((a) => a.enabled).map((a) => a.id),
        ),
    );
    return {
      draft,
      revision: row?.revision ?? 0,
      publishedVersion: row?.published_version ?? null,
      resources,
      problems: await this.problems(ws, draft),
      versions: await this.db.rows(
        "SELECT version,title,created_at,created_by FROM workflow_versions WHERE workspace_id=$1 ORDER BY version DESC LIMIT 30",
        [ws],
      ),
    };
  }
  async save(p: Principal, input: unknown) {
    requireAdmin(p);
    const d = z
      .object({
        revision: z.number().int().min(0),
        definition: WorkflowDefinition,
      })
      .strict()
      .parse(input);
    await this.db.tx(async (q) => {
      await q.query("SELECT id FROM workspaces WHERE id=$1 FOR UPDATE", [
        p.workspaceId,
      ]);
      const old = await this.db.one(
        "SELECT revision FROM workflows WHERE workspace_id=$1 FOR UPDATE",
        [p.workspaceId],
        q,
      );
      if ((old?.revision ?? 0) !== d.revision)
        throw new HttpError(
          409,
          "The workflow changed in another editor. Reload before saving.",
        );
      await q.query(
        "INSERT INTO workflows(workspace_id,draft,revision,updated_by) VALUES($1,$2,1,$3) ON CONFLICT(workspace_id) DO UPDATE SET draft=$2,revision=workflows.revision+1,updated_by=$3,updated_at=now()",
        [p.workspaceId, d.definition, p.userId],
      );
      await this.db.event(q, p.workspaceId, "workflow.saved", {
        actor: p.userId,
        revision: d.revision + 1,
      });
    });
    return this.get(p);
  }
  async publish(p: Principal, revision: number) {
    requireAdmin(p);
    await this.db.tx(async (q) => {
      await q.query("SELECT id FROM workspaces WHERE id=$1 FOR UPDATE", [
        p.workspaceId,
      ]);
      const row = requireValue(
        await this.db.one(
          "SELECT * FROM workflows WHERE workspace_id=$1 FOR UPDATE",
          [p.workspaceId],
          q,
        ),
        409,
        "Save a draft first.",
      );
      if (row.revision !== revision)
        throw new HttpError(
          409,
          "The workflow changed. Review and save the latest draft before publishing.",
        );
      const def = WorkflowDefinition.parse(row.draft),
        problems = await this.problems(p.workspaceId, def, q);
      if (problems.length) throw new HttpError(400, problems.join("\n"));
      const compiled = await this.components.expand(p.workspaceId, def, q);
      const version = (row.published_version ?? 0) + 1;
      await q.query(
        "INSERT INTO workflow_versions(workspace_id,version,title,definition,created_by,compiled_definition) VALUES($1,$2,$3,$4,$5,$6)",
        [p.workspaceId, version, def.title, def, p.userId, compiled],
      );
      await q.query(
        "UPDATE workflows SET published_version=$2,revision=revision+1,updated_by=$3,updated_at=now() WHERE workspace_id=$1",
        [p.workspaceId, version, p.userId],
      );
      // The action authority boundary changes immediately, including paused approvals.
      await q.query("UPDATE workspaces SET revision=revision+1 WHERE id=$1", [
        p.workspaceId,
      ]);
      await q.query(
        "UPDATE approvals SET status='stale' WHERE workspace_id=$1 AND status='pending'",
        [p.workspaceId],
      );
      for (const run of await this.db.rows(
        "SELECT id FROM runs WHERE workspace_id=$1 AND status='waiting_approval'",
        [p.workspaceId],
        q,
      ))
        await this.db.enqueue(q, "turn", {
          workspaceId: p.workspaceId,
          runId: run.id,
        });
      await this.db.event(q, p.workspaceId, "workflow.published", {
        actor: p.userId,
        version,
      });
    });
    return this.get(p);
  }
  async testComponent(p: Principal, raw: unknown) {
    requireAdmin(p);
    const d = z
      .object({
        definition: ComponentDefinition,
        input: z.record(z.string(), z.unknown()).default({}),
        contactId: z.string().optional(),
      })
      .strict()
      .parse(raw);
    validateObject(d.definition.inputSchema, d.input, "Component input");
    if (d.definition.kind === "subflow") {
      const errors = workflowProblems(d.definition.workflow, { subflow: true });
      if (errors.length) throw new HttpError(400, errors.join("\n"));
    }
    const contact = d.contactId
      ? requireValue(
          await this.db.one(
            "SELECT * FROM contacts WHERE workspace_id=$1 AND id=$2 AND verified",
            [p.workspaceId, d.contactId],
          ),
        )
      : { id: "anonymous-preview", verified: false, mappings: {} };
    let def: Workflow;
    if (d.definition.kind === "subflow")
      def = await this.components.expand(
        p.workspaceId,
        d.definition.workflow,
        undefined,
        true,
      );
    else {
      def = WorkflowDefinition.parse({
        format: 1,
        title: d.definition.name,
        nodes: [
          newWorkflowNode("start", "start"),
          {
            ...newWorkflowNode("task", "test"),
            data: {
              definition: d.definition,
              inputs: Object.fromEntries(
                Object.entries(d.input).map(([k, value]) => [
                  k,
                  { type: "value", value },
                ]),
              ),
              componentId: "preview",
              version: 1,
            },
          },
          {
            ...newWorkflowNode("return", "result"),
            data: {
              outcome: "done",
              outputs: { value: { type: "path", path: "steps.test.output" } },
            },
          },
        ],
        edges: [
          { from: "start", port: "next", to: "test" },
          { from: "test", port: "done", to: "result" },
          { from: "test", port: "failed", to: "result" },
        ],
      });
    }
    const result = await this.agent.previewWorkflow(
      p.workspaceId,
      def,
      "Component test",
      contact,
      "portal",
      d.input,
    );
    const output =
      d.definition.kind === "subflow" ? result.output : result.output?.value;
    const failure = result.trace.find(
      (s) => s.type === "task" && s.outcome === "failed",
    );
    if (failure)
      throw new HttpError(400, failure.error ?? "Component test failed");
    // A reply or handoff inside a subflow deliberately ends the whole turn.
    if (
      (output !== null && output !== undefined) ||
      d.definition.kind !== "subflow"
    )
      validateObject(d.definition.outputSchema, output, "Component output");
    return { ...result, output };
  }
  async preview(p: Principal, raw: unknown) {
    requireAdmin(p);
    const d = z
      .object({
        definition: WorkflowDefinition,
        question: z.string().trim().min(1).max(12000),
        contactId: z.string().max(200).optional(),
        channel: z.enum(["portal", "widget", "zendesk"]).default("portal"),
      })
      .strict()
      .parse(raw);
    const problems = await this.problems(p.workspaceId, d.definition);
    if (problems.length) throw new HttpError(400, problems.join("\n"));
    const contact = d.contactId
      ? requireValue(
          await this.db.one(
            "SELECT * FROM contacts WHERE workspace_id=$1 AND id=$2 AND verified",
            [p.workspaceId, d.contactId],
          ),
        )
      : { id: "anonymous-preview", verified: false, mappings: {} };
    return this.agent.previewWorkflow(
      p.workspaceId,
      await this.components.expand(p.workspaceId, d.definition),
      d.question,
      contact,
      d.channel,
    );
  }
}
