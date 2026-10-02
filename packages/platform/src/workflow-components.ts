import Ajv from "ajv";
import { z } from "zod";
import { createHash } from "node:crypto";
import type { Database, Queryable } from "./db.js";
import { uid } from "./db.js";
import { HttpError, requireValue } from "./config.js";
import { requireAdmin, type Principal } from "./auth.js";
import {
  WorkflowDefinition,
  WorkflowNodeSchema,
  workflowProblems,
  type Workflow,
  type WorkflowNode,
} from "./workflow-definition.js";
import { JsonSchema, EMPTY_SCHEMA, boundedJson } from "./workflow-values.js";
import { externalURL } from "./security.js";

const common = {
  customerSafe: z.boolean().default(false),
  name: z.string().trim().min(1).max(80),
  description: z.string().max(1000).default(""),
  inputSchema: JsonSchema.default(EMPTY_SCHEMA),
  outputSchema: JsonSchema.default(EMPTY_SCHEMA),
};
export const ComponentDefinition = z.discriminatedUnion("kind", [
  z
    .object({
      ...common,
      kind: z.literal("code"),
      language: z.enum(["python", "javascript"]),
      code: z.string().min(1).max(20000),
    })
    .strict(),
  z
    .object({
      ...common,
      kind: z.literal("api"),
      source: z.enum(["public_get", "customer_action"]),
      endpoint: z.string().max(2000).default(""),
      actionId: z.string().max(200).default(""),
    })
    .strict(),
  z
    .object({
      ...common,
      kind: z.literal("subflow"),
      workflow: WorkflowDefinition,
    })
    .strict(),
]);
export type Component = z.infer<typeof ComponentDefinition>;
const ajv = new Ajv({ strict: true, allErrors: true, validateFormats: false });
export function validateObject(
  schema: Record<string, unknown>,
  value: unknown,
  label: string,
) {
  if (schema.type !== "object" || schema.additionalProperties !== false)
    throw new HttpError(
      400,
      `${label} schema must be a closed object (additionalProperties: false)`,
    );
  try {
    const validate = ajv.compile(schema);
    if (("$async" in validate && validate.$async) || !validate(value))
      throw new Error(ajv.errorsText(validate.errors));
  } catch (error) {
    throw new HttpError(400, `${label}: ${(error as Error).message}`);
  } finally {
    ajv.removeSchema(schema);
  }
  return boundedJson(value);
}
function validateSchema(schema: Record<string, unknown>, label: string) {
  if (schema.type !== "object" || schema.additionalProperties !== false)
    throw new HttpError(400, `${label} schema must be a closed object`);
  try {
    if ("$async" in ajv.compile(schema))
      throw new Error("Async schemas are unsupported");
  } catch {
    throw new HttpError(400, `Invalid ${label.toLowerCase()} schema`);
  } finally {
    ajv.removeSchema(schema);
  }
}
export class WorkflowComponents {
  constructor(public db: Database) {}
  async list(ws: string, q?: Queryable) {
    return this.db.rows(
      "SELECT id,name,kind,revision,definition,active,updated_at FROM workflow_components WHERE workspace_id=$1 AND active ORDER BY name",
      [ws],
      q,
    );
  }
  async version(
    ws: string,
    id: string,
    version: number,
    q?: Queryable,
  ): Promise<Component> {
    const row = requireValue(
      await this.db.one(
        "SELECT v.definition FROM workflow_component_versions v JOIN workflow_components c ON c.id=v.component_id AND c.workspace_id=v.workspace_id WHERE v.workspace_id=$1 AND v.component_id=$2 AND v.version=$3 AND c.active",
        [ws, id, version],
        q,
      ),
      409,
      "Choose an existing component version in this workspace",
    );
    return ComponentDefinition.parse(row.definition);
  }
  async save(p: Principal, raw: unknown, id?: string) {
    requireAdmin(p);
    const { revision, definition } = z
      .object({
        revision: z.number().int().min(0),
        definition: ComponentDefinition,
      })
      .strict()
      .parse(raw);
    validateSchema(definition.inputSchema, "Input");
    validateSchema(definition.outputSchema, "Output");
    if (definition.kind === "api") {
      if (definition.source === "public_get") externalURL(definition.endpoint);
      else
        requireValue(
          await this.db.one(
            "SELECT id FROM actions WHERE workspace_id=$1 AND id=$2 AND enabled AND kind='custom_read'",
            [p.workspaceId, definition.actionId],
          ),
          400,
          "Choose an enabled custom read action in this workspace",
        );
    }
    if (definition.kind === "subflow") {
      const errors = workflowProblems(definition.workflow, { subflow: true });
      if (errors.length) throw new HttpError(400, errors.join("\n"));
      // Expanding a wrapper checks cross-workspace references, recursive inclusion and total bounds.
      await this.expand(p.workspaceId, definition.workflow, undefined, true, [
        id ?? "new",
      ]);
    }
    const componentId = id ?? uid();
    await this.db.tx(async (q) => {
      await q.query("SELECT id FROM workspaces WHERE id=$1 FOR UPDATE", [
        p.workspaceId,
      ]);
      const old = await this.db.one(
        "SELECT revision,kind FROM workflow_components WHERE workspace_id=$1 AND id=$2 FOR UPDATE",
        [p.workspaceId, componentId],
        q,
      );
      if ((id && !old) || (old?.revision ?? 0) !== revision)
        throw new HttpError(
          409,
          "The component changed. Reload before saving a new version.",
        );
      if (old && old.kind !== definition.kind)
        throw new HttpError(400, "Create a new component to change its type");
      await q.query(
        "INSERT INTO workflow_components(id,workspace_id,name,kind,revision,definition) VALUES($1,$2,$3,$4,1,$5) ON CONFLICT(id) DO UPDATE SET name=$3,definition=$5,revision=workflow_components.revision+1,updated_at=now()",
        [
          componentId,
          p.workspaceId,
          definition.name,
          definition.kind,
          definition,
        ],
      );
      await q.query(
        "INSERT INTO workflow_component_versions(workspace_id,component_id,version,definition,created_by) VALUES($1,$2,$3,$4,$5)",
        [p.workspaceId, componentId, revision + 1, definition, p.userId],
      );
      await this.db.event(q, p.workspaceId, "workflow.component_saved", {
        componentId,
        version: revision + 1,
        actor: p.userId,
      });
    });
    return { id: componentId, revision: revision + 1, definition };
  }
  async archive(p: Principal, id: string) {
    requireAdmin(p);
    requireValue(
      (
        await this.db.rows(
          "UPDATE workflow_components SET active=false,updated_at=now() WHERE workspace_id=$1 AND id=$2 RETURNING id",
          [p.workspaceId, id],
        )
      )[0],
    );
    // Published graphs contain immutable snapshots and continue running until republished.
    return { archived: true };
  }
  async expand(
    ws: string,
    def: Workflow,
    q?: Queryable,
    subflow = false,
    ancestry: string[] = [],
  ): Promise<Workflow> {
    const nodes: WorkflowNode[] = [],
      edges: Workflow["edges"] = [];
    const prefix = (id: string) =>
      "sf_" + createHash("sha256").update(id).digest("hex").slice(0, 10) + "_";
    const qualified = (scope: string, id: string) =>
      scope
        ? prefix(scope) +
          createHash("sha256").update(id).digest("hex").slice(0, 24)
        : id;
    const visit = async (
      graph: Workflow,
      scope: string,
      origin: string,
      stack: string[],
      exits?: Record<string, string>,
      outputs?: {
        schema: Record<string, unknown>;
        parentScope: string;
        outputId: string;
        customerSafe: boolean;
      },
    ) => {
      if (stack.length > 3)
        throw new HttpError(400, "Subflows may be nested at most three levels");
      const target = (id: string) => qualified(scope, id);
      for (const n of graph.nodes) {
        const id = target(n.id),
          parentOrigin = origin || n.id;
        const base = { ...n, id, scope, localId: n.id, origin: parentOrigin };
        const routes = Object.fromEntries(
          graph.edges
            .filter((e) => e.from === n.id)
            .map((e) => [e.port, target(e.to)]),
        );
        if (n.type === "custom" || n.type === "subflow") {
          if (stack.includes(n.data.componentId))
            throw new HttpError(
              400,
              "Recursive subflow references are not allowed",
            );
          const component = await this.version(
            ws,
            n.data.componentId,
            n.data.version,
            q,
          );
          if ((n.type === "subflow") !== (component.kind === "subflow"))
            throw new HttpError(
              400,
              `${n.title}: component type does not match the step`,
            );
          if (component.kind === "subflow") {
            const innerStart = component.workflow.nodes.find(
              (x) => x.type === "start",
            )!;
            nodes.push(
              WorkflowNodeSchema.parse({
                ...base,
                type: "scope",
                data: {
                  direction: "enter",
                  targetScope: id,
                  parentScope: scope,
                  outputId: n.id,
                  bindings: n.data.inputs,
                  schema: component.inputSchema,
                },
              }),
            );
            edges.push(
              { from: id, port: "next", to: qualified(id, innerStart.id) },
              { from: id, port: "failed", to: routes.failed },
            );
            await visit(
              component.workflow,
              id,
              parentOrigin,
              [...stack, n.data.componentId],
              routes,
              {
                schema: component.outputSchema,
                parentScope: scope,
                outputId: n.id,
                customerSafe: component.customerSafe,
              },
            );
          } else {
            nodes.push(
              WorkflowNodeSchema.parse({
                ...base,
                type: "task",
                data: {
                  definition: component,
                  inputs: n.data.inputs,
                  componentId: n.data.componentId,
                  version: n.data.version,
                },
              }),
            );
            for (const [port, to] of Object.entries(routes))
              edges.push({ from: id, port, to });
          }
        } else if (n.type === "return" && exits && outputs) {
          nodes.push(
            WorkflowNodeSchema.parse({
              ...base,
              type: "scope",
              data: {
                direction: "exit",
                targetScope: scope,
                parentScope: outputs.parentScope,
                outputId: outputs.outputId,
                bindings: n.data.outputs,
                schema: outputs.schema,
                customerSafe: outputs.customerSafe,
              },
            }),
          );
          edges.push(
            { from: id, port: "next", to: exits[n.data.outcome] },
            { from: id, port: "failed", to: exits.failed },
          );
        } else {
          // Subflow starts are ordinary pass-through boundaries after expansion.
          nodes.push(
            scope && n.type === "start"
              ? WorkflowNodeSchema.parse({
                  ...base,
                  type: "scope",
                  data: {
                    direction: "enter",
                    targetScope: scope,
                    parentScope: scope,
                    outputId: "",
                    bindings: {},
                    schema: EMPTY_SCHEMA,
                  },
                })
              : base,
          );
          for (const [port, to] of Object.entries(routes))
            edges.push({ from: id, port, to });
          if (scope && n.type === "start")
            edges.push({ from: id, port: "failed", to: exits!.failed });
        }
        if (nodes.length > 96)
          throw new HttpError(400, "Expanded workflow exceeds 96 steps");
      }
    };
    await visit(def, "", "", ancestry);
    const result = WorkflowDefinition.parse({ ...def, nodes, edges });
    const errors = workflowProblems(result, { expanded: true, subflow });
    if (errors.length) throw new HttpError(400, errors.join("\n"));
    return result;
  }
}
