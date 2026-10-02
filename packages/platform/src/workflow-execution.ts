import type { Database, Queryable } from "./db.js";
import type { Actions } from "./actions.js";
import type { WorkflowNode } from "./workflow-definition.js";
import { ComponentDefinition, validateObject } from "./workflow-components.js";
import { bindValues, boundedJson, valueAt } from "./workflow-values.js";
import { digest } from "./security.js";
import { requireValue } from "./config.js";
import { codeRunner, type CodeRunner } from "./code-runner.js";

export class WorkflowExecution {
  runner: CodeRunner;
  constructor(
    public db: Database,
    public actions: Actions,
    runner?: CodeRunner,
  ) {
    this.runner = runner ?? codeRunner(db.config);
  }
  async validate(run: any, q?: Queryable) {
    for (const proof of run.state.readProofs ?? [])
      await this.actions.revalidate(run.workspace_id, proof, q);
  }
  async context(run: any, node: WorkflowNode, customerFacing = false) {
    await this.validate(run);
    const conv =
      run.previewConversation ??
      requireValue(
        await this.db.one(
          "SELECT * FROM conversations WHERE workspace_id=$1 AND id=$2",
          [run.workspace_id, run.conversation_id],
        ),
      );
    const customer =
      run.previewContact ??
      requireValue(
        await this.db.one(
          "SELECT * FROM contacts WHERE workspace_id=$1 AND id=$2",
          [run.workspace_id, conv.contact_id],
        ),
      );
    if (
      run.state.accountContactRevision !== undefined &&
      (!customer.verified ||
        customer.id !== run.state.accountContactId ||
        customer.revision !== run.state.accountContactRevision)
    )
      throw new Error("Customer identity changed during the workflow");
    if (customer.verified) {
      run.state.accountContactId = customer.id;
      run.state.accountContactRevision = customer.revision;
    }
    const last =
      run.previewMessages?.[0] ??
      (await this.db.one(
        "SELECT body FROM messages WHERE workspace_id=$1 AND conversation_id=$2 AND role='customer' ORDER BY created_at DESC,id DESC LIMIT 1",
        [run.workspace_id, conv.id],
      ));
    const channel =
      run.previewChannel ??
      (
        await this.db.one(
          "SELECT kind FROM channels WHERE workspace_id=$1 AND id=$2",
          [run.workspace_id, conv.channel_id],
        )
      )?.kind;
    const steps = Object.fromEntries(
      Object.entries(run.state.outputs?.[node.scope ?? ""] ?? {})
        .filter(([, v]: [string, any]) => !customerFacing || v.customerSafe)
        .map(([id, v]: [string, any]) => [
          id,
          { output: v.output, status: v.status },
        ]),
    );
    return {
      customer: customer.verified
        ? {
            id: customer.id,
            name: customer.name,
            email: customer.email,
            verified: true,
          }
        : { verified: false },
      account: customer.verified ? (run.state.account ?? {}) : {},
      ticket: {
        id: conv.id,
        subject: conv.subject ?? "",
        category: conv.category ?? "",
        priority: conv.priority ?? "normal",
        status: conv.status ?? "open",
      },
      message: { text: last?.body ?? "" },
      channel: { kind: channel },
      agent: {
        intent: run.state.draft?.intent,
        answer: run.state.draft?.answer,
      },
      action: run.state.receipt
        ? {
            result: run.state.receipt.result,
            reference: run.state.receipt.providerId,
          }
        : {},
      steps,
      inputs: customerFacing
        ? (run.state.safeInputs?.[node.scope ?? ""] ?? {})
        : (run.state.inputs?.[node.scope ?? ""] ?? {}),
    };
  }
  store(
    run: any,
    scope: string,
    id: string,
    output: unknown,
    customerSafe: boolean,
    status = "done",
  ) {
    run.state.outputs ??= {};
    run.state.outputs[scope] ??= {};
    run.state.outputs[scope][id] = { output, customerSafe, status };
  }
  async boundary(run: any, node: Extract<WorkflowNode, { type: "scope" }>) {
    const d = node.data;
    if (!d.outputId) {
      run.state.outcome = "next";
      return;
    }
    try {
      const output = validateObject(
        d.schema,
        bindValues(d.bindings, await this.context(run, node)),
        d.direction === "enter" ? "Subflow input" : "Subflow output",
      );
      if (d.direction === "enter") {
        run.state.inputs ??= {};
        run.state.inputs[d.targetScope] = output;
        const safeContext = await this.context(run, node, true);
        run.state.safeInputs ??= {};
        run.state.safeInputs[d.targetScope] = Object.fromEntries(
          Object.entries(d.bindings)
            .filter(
              ([, binding]) =>
                binding.type === "value" ||
                valueAt(safeContext, binding.path) !== undefined,
            )
            .map(([key]) => [key, output[key]]),
        );
      } else this.store(run, d.parentScope, d.outputId, output, d.customerSafe);
      run.state.outcome = "next";
    } catch (error) {
      run.state.error = (error as Error).message;
      run.state.outcome = "failed";
      run.state.stepEvidence = (run.state.stepEvidence ?? []).filter(
        (c: any) => c.id !== `step:${node.id}`,
      );
      this.store(run, d.parentScope, d.outputId, {}, false, "failed");
    }
  }
  async task(run: any, node: Extract<WorkflowNode, { type: "task" }>) {
    const definition = ComponentDefinition.parse(node.data.definition);
    if (definition.kind === "subflow")
      throw new Error("Subflow must be expanded before execution");
    let inputHash = "",
      logs = "";
    run.state.lastStepLogs = "";
    try {
      const input = validateObject(
        definition.inputSchema,
        bindValues(node.data.inputs, await this.context(run, node)),
        "Step input",
      );
      boundedJson(input, 16384);
      inputHash = digest({ definition, input });
      const cached = run.preview
        ? null
        : await this.db.one(
            "SELECT * FROM workflow_step_results WHERE workspace_id=$1 AND run_id=$2 AND node_id=$3",
            [run.workspace_id, run.id, node.id],
          );
      if (cached && cached.input_hash !== inputHash)
        throw new Error("Custom step inputs changed during recovery");
      let output: unknown, proof: any;
      if (cached?.status === "completed") {
        output = cached.output.result;
        proof = cached.output.proof;
        if (proof) await this.actions.revalidate(run.workspace_id, proof);
        logs = cached.logs ?? "";
      } else {
        if (!run.preview)
          await this.db.pool.query(
            "INSERT INTO workflow_step_results(workspace_id,run_id,node_id,input_hash,status) VALUES($1,$2,$3,$4,'running') ON CONFLICT(workspace_id,run_id,node_id) DO UPDATE SET status='running',error=null",
            [run.workspace_id, run.id, node.id, inputHash],
          );
        if (definition.kind === "code") {
          const result = await this.runner({
            language: definition.language,
            code: definition.code,
            input,
          });
          output = result.output;
          logs = result.logs;
        } else if (definition.source === "public_get") {
          const response = await this.actions.connections.fetch(
            definition.endpoint,
            { limit: 32768 },
          );
          if (!response.ok)
            throw new Error(`Read API returned HTTP ${response.status}`);
          output = await response.json();
        } else {
          const conv =
            run.previewConversation ??
            requireValue(
              await this.db.one(
                "SELECT contact_id FROM conversations WHERE workspace_id=$1 AND id=$2",
                [run.workspace_id, run.conversation_id],
              ),
            );
          const customer =
            run.previewContact ??
            requireValue(
              await this.db.one(
                "SELECT * FROM contacts WHERE workspace_id=$1 AND id=$2",
                [run.workspace_id, conv.contact_id],
              ),
            );
          const result = await this.actions.readForWorkflow(
            run.workspace_id,
            run,
            customer,
            definition.actionId,
            input,
            `workflow-${digest({ ws: run.workspace_id, run: run.id, node: node.id }).slice(0, 40)}`,
          );
          output = result.result;
          proof = result.proof;
        }
        output = validateObject(definition.outputSchema, output, "Step output");
        if (!run.preview)
          await this.db.pool.query(
            "UPDATE workflow_step_results SET status='completed',output=$4,logs=$5,finished_at=now() WHERE workspace_id=$1 AND run_id=$2 AND node_id=$3",
            [
              run.workspace_id,
              run.id,
              node.id,
              { result: output, proof },
              logs,
            ],
          );
      }
      if (proof) {
        run.state.readProofs ??= [];
        run.state.readProofs.push(proof);
      }
      this.store(
        run,
        node.scope ?? "",
        node.localId ?? node.id,
        output,
        definition.customerSafe,
      );
      if (definition.customerSafe) {
        run.state.stepEvidence ??= [];
        const id = `step:${node.id}`;
        run.state.stepEvidence = run.state.stepEvidence.filter(
          (c: any) => c.id !== id,
        );
        run.state.stepEvidence.push({
          id,
          documentId: `component:${node.data.componentId}`,
          sourceId: `component:${node.data.componentId}`,
          title: definition.name,
          version: node.data.version,
          excerpt: JSON.stringify(output).slice(0, 4000),
          ...(definition.kind === "api" && definition.source === "public_get"
            ? { url: definition.endpoint }
            : {}),
        });
      }
      run.state.outcome = "done";
      run.state.error = undefined;
      run.state.lastStepLogs = logs;
    } catch (error) {
      run.state.error = (error as Error).message;
      run.state.outcome = "failed";
      run.state.stepEvidence = (run.state.stepEvidence ?? []).filter(
        (c: any) => c.id !== `step:${node.id}`,
      );
      this.store(
        run,
        node.scope ?? "",
        node.localId ?? node.id,
        {},
        false,
        "failed",
      );
      if (!run.preview && inputHash)
        await this.db.pool.query(
          "UPDATE workflow_step_results SET status='failed',error=$4,finished_at=now() WHERE workspace_id=$1 AND run_id=$2 AND node_id=$3 AND status<>'completed'",
          [run.workspace_id, run.id, node.id, run.state.error],
        );
    }
  }
}
