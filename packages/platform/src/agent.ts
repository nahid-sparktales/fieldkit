import {
  Annotation,
  StateGraph,
  START,
  END,
  Command,
  interrupt,
} from "@langchain/langgraph";
import type { Database } from "./db.js";
import { uid } from "./db.js";
import type { Knowledge } from "./knowledge.js";
import type { ModelPort } from "./model.js";
import {
  Settings,
  type Citation,
  type Draft,
  type Proposal,
  type ActionDefinition,
} from "./contracts.js";
import type { Actions } from "./actions.js";
import type { Support } from "./support.js";
import { HttpError, requireValue } from "./config.js";
import { digest } from "./security.js";
import { compileWorkflow, WorkflowState } from "./workflow-graph.js";
import {
  WorkflowDefinition,
  PORTS,
  workflowProblems,
  type Workflow,
  type WorkflowNode,
} from "./workflow-definition.js";

const State = Annotation.Root({
  workspaceId: Annotation<string>(),
  runId: Annotation<string>(),
  route: Annotation<string>(),
  approvalId: Annotation<string>(),
});
type RunState = {
  evidence?: Citation[];
  draft?: Draft;
  proposal?: Proposal;
  receipt?: any;
  error?: string;
  approvalId?: string;
  route?: string;
  response?: string;
};
export class Agent {
  graph;
  constructor(
    public db: Database,
    public knowledge: Knowledge,
    public model: ModelPort,
    public actions: Actions,
    public support: Support,
  ) {
    const step =
      (name: string, fn: (run: any) => Promise<void>) =>
      async (s: typeof State.State) => {
        const run = requireValue(
          await db.one("SELECT * FROM runs WHERE workspace_id=$1 AND id=$2", [
            s.workspaceId,
            s.runId,
          ]),
        );
        await fn(run);
        await db.tx(async (q) => {
          await q.query(
            "UPDATE runs SET state=$1,status=$2,updated_at=now() WHERE id=$3",
            [run.state, run.status, run.id],
          );
          await db.event(
            q,
            run.workspace_id,
            "agent.step",
            {
              runId: run.id,
              node: name,
              status: run.status,
              route: run.state.route,
            },
            run.conversation_id,
          );
        });
        return {
          route: run.state.route ?? "",
          approvalId: run.state.approvalId ?? "",
        };
      };
    this.graph = new StateGraph(State)
      .addNode(
        "retrieve_knowledge",
        step("retrieve_knowledge", (r) => this.retrieve(r)),
      )
      .addNode(
        "draft_response",
        step("draft_response", (r) => this.draft(r)),
      )
      .addNode(
        "check_policy",
        step("check_policy", (r) => this.policy(r)),
      )
      .addNode("approval_wait", (s) => {
        interrupt({
          approvalId: s.approvalId,
          summary: "Review the exact proposed customer action.",
        });
        return {};
      })
      .addNode(
        "validate_approval",
        step("validate_approval", (r) => this.approved(r)),
      )
      .addNode(
        "execute_action",
        step("execute_action", (r) => this.execute(r)),
      )
      .addNode(
        "publish_response",
        step("publish_response", (r) => this.publish(r)),
      )
      .addEdge(START, "retrieve_knowledge")
      .addEdge("retrieve_knowledge", "draft_response")
      .addEdge("draft_response", "check_policy")
      .addConditionalEdges(
        "check_policy",
        (s) =>
          s.route === "approval"
            ? "approval_wait"
            : s.route === "execute"
              ? "execute_action"
              : "publish_response",
        ["approval_wait", "execute_action", "publish_response"],
      )
      .addEdge("approval_wait", "validate_approval")
      .addConditionalEdges(
        "validate_approval",
        (s) => (s.route === "execute" ? "execute_action" : "publish_response"),
        ["execute_action", "publish_response"],
      )
      .addEdge("execute_action", "publish_response")
      .addEdge("publish_response", END)
      .compile({ checkpointer: db.saver });
  }
  private async workflowAuthority(run: any, q?: import("./db.js").Queryable) {
    if (run.preview) return;
    const active = await this.db.one(
      "SELECT published_version FROM workflows WHERE workspace_id=$1",
      [run.workspace_id],
      q,
    );
    if (
      active?.published_version &&
      active.published_version !== run.workflow_version
    )
      throw new HttpError(
        409,
        "The published workflow changed; start a new turn before performing an action.",
      );
  }
  private configuredGraph(def: Workflow) {
    const problems = workflowProblems(def);
    if (problems.length) throw new HttpError(409, problems.join("\n"));
    const step =
      (operation: "node" | "approve" | "execute") =>
      async (node: WorkflowNode, s: typeof WorkflowState.State) => {
        const run = requireValue(
          await this.db.one(
            "SELECT * FROM runs WHERE workspace_id=$1 AND id=$2",
            [s.workspaceId, s.runId],
          ),
        );
        if (operation === "node") await this.workflowStep(run, node, def);
        else if (operation === "approve") await this.approved(run);
        else await this.execute(run);
        await this.db.tx(async (q) => {
          await q.query(
            "UPDATE runs SET state=$1,status=$2,updated_at=now() WHERE id=$3",
            [run.state, run.status, run.id],
          );
          await this.db.event(
            q,
            run.workspace_id,
            "agent.step",
            {
              runId: run.id,
              node: node.id,
              title: node.title,
              operation,
              workflowVersion: run.workflow_version,
              status: run.status,
              route:
                operation === "node"
                  ? (run.state.outcome ?? run.state.route)
                  : run.state.route,
            },
            run.conversation_id,
          );
        });
        return {
          outcome: run.state.outcome ?? "",
          route: run.state.route ?? "",
          approvalId: run.state.approvalId ?? "",
        };
      };
    return compileWorkflow(
      def,
      step("node"),
      { approve: step("approve"), execute: step("execute") },
      this.db.saver,
    );
  }
  private async workflowStep(run: any, node: WorkflowNode, def: Workflow) {
    const conv = await this.current(run);
    if (!conv) {
      run.state.outcome = PORTS[node.type][0] ?? "";
      return;
    }
    const ws = run.workspace_id;
    const contact = async () =>
      run.previewContact ??
      requireValue(
        await this.db.one(
          "SELECT * FROM contacts WHERE workspace_id=$1 AND id=$2",
          [ws, conv.contact_id],
        ),
      );
    const question = async () =>
      run.previewMessages?.[0].body ??
      (
        await this.db.one(
          "SELECT body FROM messages WHERE workspace_id=$1 AND conversation_id=$2 AND role='customer' ORDER BY created_at DESC,id DESC LIMIT 1",
          [ws, conv.id],
        )
      )?.body ??
      "";
    run.status = "running";
    if (node.type === "start") {
      run.state.evidence = [];
      run.state.outcome = "next";
      return;
    }
    if (node.type === "knowledge") {
      try {
        run.state.evidence = await this.knowledge.retrieve(
          ws,
          await question(),
          {
            sourceIds:
              node.data.scope === "selected" ? node.data.sourceIds : undefined,
            limit: node.data.limit,
          },
        );
        run.state.outcome = run.state.evidence.length ? "found" : "empty";
      } catch (e) {
        run.state.evidence = [];
        run.state.error =
          e instanceof Error ? e.message : "Knowledge unavailable";
        run.state.outcome = "failed";
      }
      return;
    }
    if (node.type === "customer") {
      run.state.account = null;
      try {
        const c = await contact();
        run.state.outcome = c.verified ? "verified" : "anonymous";
        if (c.verified) {
          run.state.account = {
            ...(node.data.profile
              ? { customer: { name: c.name, email: c.email } }
              : {}),
            ...(node.data.billing
              ? { billing: await this.actions.account(ws, c, node.data.modes) }
              : {}),
          };
          run.state.accountContactRevision = c.revision;
          run.state.accountContactId = c.id;
        }
      } catch (e) {
        run.state.error =
          e instanceof Error ? e.message : "Customer account unavailable";
        run.state.outcome = "failed";
      }
      return;
    }
    if (node.type === "condition") {
      let yes = false;
      if (node.data.field === "evidence")
        yes = Boolean(run.state.evidence?.length);
      else if (node.data.field === "channel")
        yes =
          (run.previewChannel ??
            (
              await this.db.one(
                "SELECT kind FROM channels WHERE workspace_id=$1 AND id=$2",
                [ws, conv.channel_id],
              )
            )?.kind) === node.data.value;
      else {
        const c = await contact();
        yes = Boolean(
          c.verified &&
            (node.data.field === "verified" || c.mappings[node.data.value]),
        );
      }
      run.state.outcome = yes ? "yes" : "no";
      return;
    }
    if (node.type === "agent") {
      run.state.route = "";
      run.state.error = undefined;
      const reachable = new Set<string>();
      const walk = (id: string) => {
        if (reachable.has(id)) return;
        reachable.add(id);
        for (const edge of def.edges.filter((e) => e.from === id))
          walk(edge.to);
      };
      walk(node.id);
      const gate = def.nodes.find(
        (n) => n.type === "action" && reachable.has(n.id),
      );
      const c = await contact();
      if (
        run.state.accountContactRevision !== undefined &&
        (!c.verified ||
          c.id !== run.state.accountContactId ||
          c.revision !== run.state.accountContactRevision)
      )
        this.handoff(
          run,
          "The customer identity changed after account lookup.",
        );
      else
        await this.draft(run, {
          actionIds: gate?.type === "action" ? gate.data.actionIds : [],
          instructions: node.data.instructions,
          model: node.data.model,
          provider: node.data.provider || undefined,
        });
      run.state.outcome =
        run.state.route === "handoff"
          ? "handoff"
          : (run.state.draft?.intent ?? "handoff");
      return;
    }
    if (node.type === "action") {
      await this.policy(run, {
        actionIds: node.data.actionIds,
        forceApproval: node.data.approval === "always",
      });
      run.state.outcome =
        run.state.route === "preview_action"
          ? "__stop"
          : run.state.route === "approval"
            ? "approval"
            : run.state.route === "execute"
              ? "execute"
              : run.state.route === "respond"
                ? "done"
                : "failed";
      return;
    }
    if (node.type === "handoff") {
      this.handoff(
        run,
        run.state.error ??
          "The configured workflow requested staff assistance.",
      );
      run.state.response = node.data.message;
      // A removed assignee should never prevent a safe handoff.
      const assignedTo =
        node.data.assignedTo &&
        (await this.db.one(
          "SELECT user_id FROM memberships WHERE workspace_id=$1 AND user_id=$2",
          [ws, node.data.assignedTo],
        ))
          ? node.data.assignedTo
          : undefined;
      await this.publish(run, { assignedTo, priority: node.data.priority });
      run.state.outcome = "end";
      return;
    }
    if (node.type === "reply") {
      if (!run.state.receipt && run.state.route !== "handoff") {
        if (["answer", "clarify"].includes(run.state.draft?.intent)) {
          run.state.response = run.state.draft.answer;
          run.state.route = "respond";
        } else
          this.handoff(
            run,
            "An account action cannot be completed without the governed action step.",
          );
      }
      await this.publish(run, { forceReview: node.data.mode === "review" });
      run.state.outcome = "end";
    }
  }
  async previewWorkflow(
    ws: string,
    def: Workflow,
    question: string,
    contact: any,
    channel: string,
  ) {
    const run: any = {
      id: `preview-${uid()}`,
      workspace_id: ws,
      revision: 0,
      state: { evidence: [] },
      status: "running",
      preview: true,
      previewContact: contact,
      previewConversation: {
        id: "preview",
        contact_id: contact.id,
        mode: "agent",
        revision: 0,
      },
      previewMessages: [{ role: "customer", body: question }],
      previewChannel: channel,
    };
    const trace: any[] = [];
    const graph = compileWorkflow(def, async (node) => {
      await this.workflowStep(run, node, def);
      trace.push({
        nodeId: node.id,
        title: node.title,
        type: node.type,
        outcome: run.state.outcome ?? run.state.route,
        error: run.state.error ?? null,
        evidenceCount: run.state.evidence?.length ?? 0,
        hasAccount: !!run.state.account,
      });
      return { outcome: run.state.outcome ?? "", route: run.state.route ?? "" };
    });
    await graph.invoke(
      { workspaceId: ws, runId: run.id },
      { recursionLimit: 80 },
    );
    if (!(await this.knowledge.validEvidence(ws, run.state.evidence ?? [])))
      throw new HttpError(
        409,
        "Knowledge changed during the preview. Test again.",
      );
    if (run.state.accountContactRevision !== undefined) {
      const current = await this.db.one(
        "SELECT revision,verified FROM contacts WHERE workspace_id=$1 AND id=$2",
        [ws, contact.id],
      );
      if (
        !current?.verified ||
        current.revision !== run.state.accountContactRevision
      )
        throw new HttpError(
          409,
          "The customer identity changed during preview.",
        );
    }
    return {
      trace,
      answer: run.state.response ?? "",
      intent: run.state.route ?? run.state.draft?.intent,
      action: run.state.previewAction ?? null,
      citations: (run.state.evidence ?? []).filter((e: Citation) =>
        run.state.draft?.citationIds.includes(e.id),
      ),
      actionsExecuted: false,
    };
  }
  private handoff(run: any, message: string) {
    run.state.route = "handoff";
    run.state.error = message;
    if (run.state.draft) run.state.draft.citationIds = [];
    run.state.response =
      "I’m passing this to the support team so they can help you further.";
  }
  async current(run: any) {
    if (run.preview) return run.previewConversation;
    const c = requireValue(
      await this.db.one(
        "SELECT * FROM conversations WHERE workspace_id=$1 AND id=$2",
        [run.workspace_id, run.conversation_id],
      ),
    );
    if (c.mode !== "agent" || c.revision !== run.revision) {
      run.status = "stale";
      run.state.route = "stale";
      return null;
    }
    return c;
  }
  async retrieve(run: any) {
    if (!(await this.current(run))) return;
    run.status = "running";
    const messages = await this.db.rows(
      "SELECT body FROM messages WHERE workspace_id=$1 AND conversation_id=$2 AND role='customer' ORDER BY created_at DESC,id DESC LIMIT 1",
      [run.workspace_id, run.conversation_id],
    );
    try {
      run.state.evidence = await this.knowledge.retrieve(
        run.workspace_id,
        messages[0]?.body ?? "",
      );
    } catch (e) {
      this.handoff(
        run,
        e instanceof Error ? e.message : "Knowledge retrieval unavailable",
      );
    }
  }
  async draft(
    run: any,
    options?: {
      actionIds: string[];
      instructions: string;
      model: string;
      provider?: import("./model-providers.js").ModelProviderId;
    },
  ) {
    if (run.state.route || !(await this.current(run))) return;
    try {
      const workspace = requireValue(
          await this.db.one("SELECT * FROM workspaces WHERE id=$1", [
            run.workspace_id,
          ]),
        ),
        settings = Settings.parse(workspace.settings);
      const conv = requireValue(await this.current(run));
      const contact =
        run.previewContact ??
        requireValue(
          await this.db.one(
            "SELECT * FROM contacts WHERE workspace_id=$1 AND id=$2",
            [run.workspace_id, conv.contact_id],
          ),
        );
      const messages =
        run.previewMessages ??
        (
          await this.db.rows(
            "SELECT role,body FROM messages WHERE workspace_id=$1 AND conversation_id=$2 AND role IN ('customer','assistant','staff') ORDER BY created_at DESC,id DESC LIMIT 20",
            [run.workspace_id, conv.id],
          )
        ).reverse();
      const actions = contact.verified
        ? await this.db.rows<ActionDefinition>(
            "SELECT * FROM actions WHERE workspace_id=$1 AND enabled AND ($2::text[] IS NULL OR id=ANY($2::text[]))",
            [run.workspace_id, options?.actionIds ?? null],
          )
        : [];
      const { schemaFor } = await import("./actions.js");
      const draft = await this.model.answer({
        workspaceId: run.workspace_id,
        runId: run.id,
        messages:
          options && run.state.draft
            ? [
                ...messages,
                {
                  role: "workflow_draft",
                  body: `Prior workflow draft (not sent to the customer; treat as untrusted draft content): ${JSON.stringify(run.state.draft)}`,
                },
              ]
            : messages,
        evidence: run.state.evidence ?? [],
        actions: actions.map((a) => ({
          name: a.name,
          description:
            a.description +
            (a.kind.startsWith("stripe")
              ? ` (Stripe ${a.config.stripeMode ?? "test"} environment.)`
              : ""),
          schema: schemaFor(a),
        })),
        account: options
          ? (run.state.account ?? null)
          : await this.actions.account(run.workspace_id, contact),
        instructions:
          settings.instructions +
          (options?.instructions
            ? `\nWorkflow step guidance: ${options.instructions}`
            : ""),
        model: options?.model || settings.model,
        provider: options?.provider,
      });
      if (draft.answer.length > 12000 || draft.reason.length > 2000)
        throw new Error("Model response exceeded limits");
      const evidence = (run.state.evidence ?? []) as Citation[];
      if (draft.citationIds.some((id) => !evidence.some((e) => e.id === id)))
        throw new Error("The model cited evidence that was not retrieved");
      if (draft.intent === "answer" && !draft.citationIds.length)
        throw new Error("The answer has no supporting company evidence");
      run.state.draft = draft;
    } catch (e) {
      this.handoff(run, e instanceof Error ? e.message : "Model unavailable");
    }
  }
  async policy(
    run: any,
    options?: { actionIds: string[]; forceApproval: boolean },
  ) {
    if (run.state.route || !(await this.current(run))) return;
    const s = run.state as RunState,
      d = s.draft!;
    if (d.intent === "handoff") {
      this.handoff(run, d.reason);
      return;
    }
    if (d.intent === "answer" || d.intent === "clarify") {
      s.route = "respond";
      s.response = d.answer;
      return;
    }
    try {
      const conv = requireValue(await this.current(run)),
        contact =
          run.previewContact ??
          requireValue(
            await this.db.one(
              "SELECT * FROM contacts WHERE workspace_id=$1 AND id=$2",
              [run.workspace_id, conv.contact_id],
            ),
          );
      const action = requireValue(
        await this.db.one<ActionDefinition>(
          "SELECT * FROM actions WHERE workspace_id=$1 AND name=$2 AND enabled AND ($3::text[] IS NULL OR id=ANY($3::text[]))",
          [run.workspace_id, d.actionName, options?.actionIds ?? null],
        ),
        409,
        "Action is not enabled",
      );
      await this.workflowAuthority(run);
      s.proposal = await this.actions.prepare(
        run.workspace_id,
        run,
        contact,
        action,
        d.parameters,
        digest(s.evidence),
        d.reason,
      );
      const validated = await this.actions.revalidate(
        run.workspace_id,
        s.proposal,
      );
      const automatic =
        !options?.forceApproval &&
        (await this.actions.automatic(run.workspace_id, action, s.proposal));
      if (run.preview) {
        await this.actions.validateRemote(
          run.workspace_id,
          s.proposal,
          action,
          validated.identity,
        );
        run.state.previewAction = {
          name: action.name,
          parameters: s.proposal.parameters,
          requiresApproval: !automatic,
        };
        run.state.response = automatic
          ? "Preview stopped before executing the proposed action."
          : "Preview stopped before requesting staff approval.";
        run.state.route = "preview_action";
        return;
      }
      if (automatic) {
        s.route = "execute";
        return;
      }
      const id = uid();
      const a = (
        await this.db.rows(
          `INSERT INTO approvals(id,workspace_id,run_id,action_id,proposal,hash) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(run_id) DO UPDATE SET run_id=excluded.run_id RETURNING *`,
          [
            id,
            run.workspace_id,
            run.id,
            action.id,
            s.proposal,
            digest(s.proposal),
          ],
        )
      )[0];
      s.approvalId = a.id;
      s.route = "approval";
      run.status = "waiting_approval";
      await this.db.tx(async (q) => {
        await q.query(
          "UPDATE conversations SET status='waiting_approval' WHERE id=$1 AND revision=$2",
          [run.conversation_id, run.revision],
        );
        await this.db.event(
          q,
          run.workspace_id,
          "approval.requested",
          { approvalId: a.id },
          run.conversation_id,
        );
      });
    } catch (e) {
      this.handoff(
        run,
        e instanceof Error ? e.message : "Action could not be authorized",
      );
    }
  }
  async approved(run: any) {
    if (!(await this.current(run))) return;
    const approval = await this.db.one(
      "SELECT * FROM approvals WHERE workspace_id=$1 AND id=$2",
      [run.workspace_id, run.state.approvalId],
    );
    if (
      approval?.status !== "approved" ||
      new Date(approval.expires_at).getTime() < Date.now() ||
      approval.hash !== digest(run.state.proposal)
    ) {
      this.handoff(run, "Action was not approved or the approval expired");
      return;
    }
    const role = await this.db.one(
      "SELECT role FROM memberships WHERE workspace_id=$1 AND user_id=$2 AND role IN ('owner','admin') FOR SHARE",
      [run.workspace_id, approval.decision_by],
    );
    if (!role) {
      this.handoff(
        run,
        "The approving staff member no longer has approval authority",
      );
      return;
    }
    run.state.route = "execute";
  }
  async execute(run: any) {
    if (!(await this.current(run))) return;
    try {
      await this.db.tx(async (q) => {
        // Serialize the final side-effect boundary with takeover and incoming messages.
        const conv = requireValue(
          await this.db.one(
            "SELECT * FROM conversations WHERE workspace_id=$1 AND id=$2 FOR UPDATE",
            [run.workspace_id, run.conversation_id],
            q,
          ),
        );
        if (conv.mode !== "agent" || conv.revision !== run.revision)
          throw new HttpError(409, "Conversation changed before execution");
        const p = run.state.proposal as Proposal;
        await q.query(
          "SELECT id FROM actions WHERE workspace_id=$1 AND id=$2 FOR UPDATE",
          [run.workspace_id, p.actionId],
        );
        await q.query(
          "SELECT id FROM contacts WHERE workspace_id=$1 AND id=$2 FOR SHARE",
          [run.workspace_id, p.contactId],
        );
        await q.query("SELECT id FROM workspaces WHERE id=$1 FOR SHARE", [
          run.workspace_id,
        ]);
        await this.workflowAuthority(run, q);
        const { action, identity, connection } = await this.actions.revalidate(
          run.workspace_id,
          p,
          q,
        );
        if (connection)
          await q.query("SELECT id FROM connections WHERE id=$1 FOR SHARE", [
            connection.id,
          ]);
        if (
          !(await this.knowledge.validEvidence(
            run.workspace_id,
            run.state.evidence ?? [],
            q,
          ))
        )
          throw new HttpError(409, "Knowledge changed after the proposal");
        const approval = run.state.approvalId
          ? await this.db.one(
              "SELECT * FROM approvals WHERE workspace_id=$1 AND id=$2",
              [run.workspace_id, run.state.approvalId],
              q,
            )
          : null;
        if (approval) {
          if (
            approval.status !== "approved" ||
            approval.hash !== digest(p) ||
            new Date(approval.expires_at).getTime() < Date.now()
          )
            throw new HttpError(409, "Approval is no longer valid");
          const role = await this.db.one(
            "SELECT role FROM memberships WHERE workspace_id=$1 AND user_id=$2 AND role IN ('owner','admin') FOR SHARE",
            [run.workspace_id, approval.decision_by],
            q,
          );
          if (!role) throw new HttpError(403, "Approval authority was revoked");
        } else if (!(await this.actions.automatic(run.workspace_id, action, p)))
          throw new HttpError(
            409,
            "Automatic action limits changed; staff review required",
          );
        if (conv.external_id) {
          const latest = await this.support.connections.json(
            run.workspace_id,
            "zendesk",
            `/api/v2/tickets/${encodeURIComponent(conv.external_id)}.json`,
          );
          if (
            conv.external_version &&
            latest.ticket.updated_at !== conv.external_version
          )
            throw new HttpError(
              409,
              "Zendesk ticket changed before action execution",
            );
        }
        run.state.receipt = await this.actions.execute(
          run.workspace_id,
          run.id,
          p,
          action,
          identity,
        );
      });
      const receipt = run.state.receipt;
      run.state.response =
        receipt.action === "stripe_refund"
          ? `Your refund of ${(receipt.result.amountMinor / 100).toFixed(2)} ${String(receipt.result.currency).toUpperCase()} has been confirmed. Reference: ${receipt.providerId}.`
          : receipt.action === "stripe_cancel"
            ? `Your selected subscription is set to end at the end of its current billing period. Reference: ${receipt.providerId}.`
            : `The ${receipt.action === "custom_read" ? "lookup" : "requested action"} completed.\n${JSON.stringify(receipt.result, null, 2)}`;
      run.state.route = "respond";
    } catch (e) {
      this.handoff(
        run,
        e instanceof Error ? e.message : "Action execution failed",
      );
      const op = await this.db.one(
        "SELECT status FROM operations WHERE workspace_id=$1 AND run_id=$2",
        [run.workspace_id, run.id],
      );
      if (op?.status === "unknown" || op?.status === "sent")
        run.state.response =
          "The service has not confirmed the outcome. The support team will check it before attempting any further action.";
    }
  }
  async publish(
    run: any,
    options?: { forceReview?: boolean; assignedTo?: string; priority?: string },
  ) {
    if (run.preview) {
      run.status = run.state.route === "handoff" ? "handed_off" : "completed";
      return;
    }
    await this.db.tx(async (q) => {
      const conv = requireValue(
        await this.db.one(
          "SELECT * FROM conversations WHERE workspace_id=$1 AND id=$2 FOR UPDATE",
          [run.workspace_id, run.conversation_id],
          q,
        ),
      );
      if (
        conv.revision !== run.revision ||
        conv.mode !== "agent" ||
        run.state.route === "stale"
      ) {
        run.status = "stale";
        return;
      }
      if (
        !(await this.knowledge.validEvidence(
          run.workspace_id,
          run.state.evidence ?? [],
          q,
        ))
      ) {
        this.handoff(
          run,
          "Knowledge changed before the response was published",
        );
      }
      if (run.state.accountContactRevision !== undefined) {
        const contact = await this.db.one(
          "SELECT id,revision,verified FROM contacts WHERE workspace_id=$1 AND id=$2 FOR SHARE",
          [run.workspace_id, conv.contact_id],
          q,
        );
        if (
          !contact?.verified ||
          contact.id !== run.state.accountContactId ||
          contact.revision !== run.state.accountContactRevision
        )
          this.handoff(
            run,
            "Customer identity changed before the response was published.",
          );
      }
      const settings = Settings.parse(
        requireValue(
          await this.db.one(
            "SELECT settings FROM workspaces WHERE id=$1",
            [run.workspace_id],
            q,
          ),
        ).settings,
      );
      const review =
        Boolean(
          options?.forceReview ||
            (settings.replies === "review" && !run.state.receipt),
        ) && run.state.route !== "handoff";
      const citations = (run.state.evidence ?? []).filter((e: Citation) =>
        (run.state.draft?.citationIds ?? []).includes(e.id),
      );
      const body =
        run.state.response ||
        "A member of our support team will help you with this request.";
      const role = review ? "note" : "assistant";
      await q.query(
        "INSERT INTO messages(id,workspace_id,conversation_id,role,body,citations,request_key) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(workspace_id,conversation_id,request_key) DO NOTHING",
        [
          uid(),
          run.workspace_id,
          conv.id,
          role,
          body,
          JSON.stringify(citations),
          `run:${run.id}`,
        ],
      );
      if (conv.external_id)
        await this.support.queue(
          q,
          run.workspace_id,
          conv.id,
          {
            body,
            public: !review && run.state.route !== "handoff",
            ...(!review && run.state.route !== "handoff"
              ? {
                  guardRevision: run.revision,
                  evidenceIds: citations.map((e: Citation) => e.id),
                }
              : {}),
          },
          run.id,
        );
      const human = review || run.state.route === "handoff";
      if (human && options?.assignedTo) {
        if (
          !(await this.db.one(
            "SELECT 1 FROM memberships WHERE workspace_id=$1 AND user_id=$2",
            [run.workspace_id, options.assignedTo],
            q,
          ))
        )
          throw new HttpError(
            409,
            "Workflow assignee is no longer a staff member",
          );
        await q.query("UPDATE conversations SET assigned_to=$2 WHERE id=$1", [
          conv.id,
          options.assignedTo,
        ]);
      }
      if (human && options?.priority && options.priority !== "keep") {
        await q.query("UPDATE conversations SET priority=$2 WHERE id=$1", [
          conv.id,
          options.priority,
        ]);
        if (conv.external_id)
          await this.support.queue(q, run.workspace_id, conv.id, {
            priority: options.priority,
          });
      }
      await q.query(
        "UPDATE conversations SET status=$1,mode=$2,updated_at=now() WHERE id=$3",
        [human ? "needs_staff" : "open", human ? "human" : "agent", conv.id],
      );
      if (human && !conv.external_id) {
        const channel = await this.db.one(
          "SELECT settings FROM channels WHERE id=$1",
          [conv.channel_id],
          q,
        );
        if (channel?.settings.handoff === "zendesk")
          await this.support.queue(
            q,
            run.workspace_id,
            conv.id,
            {
              body: (
                await this.db.rows(
                  "SELECT body FROM messages WHERE conversation_id=$1 AND role='customer' ORDER BY created_at",
                  [conv.id],
                  q,
                )
              )
                .map((m) => m.body)
                .join("\n\n"),
            },
            run.id,
          );
      }
      run.status = human ? "handed_off" : "completed";
      await this.db.event(
        q,
        run.workspace_id,
        "conversation.updated",
        { status: human ? "needs_staff" : "open" },
        conv.id,
        true,
      );
    });
  }
  async advance(ws: string, id: string) {
    const initial = requireValue(
      await this.db.one(
        "SELECT conversation_id FROM runs WHERE workspace_id=$1 AND id=$2",
        [ws, id],
      ),
    );
    const lockKey = `conversation:${ws}:${initial.conversation_id}`;
    const lock = await this.db.pool.connect();
    try {
      await lock.query("SELECT pg_advisory_lock(hashtextextended($1,0))", [
        lockKey,
      ]);
      const run = requireValue(
        await this.db.one(
          "SELECT * FROM runs WHERE workspace_id=$1 AND id=$2",
          [ws, id],
        ),
      );
      if (!["support-v2", "support-v3"].includes(run.graph_version))
        throw new Error(
          "Saved workflow version is incompatible; restore matching code or migrate the run explicitly",
        );
      if (["completed", "handed_off", "stale"].includes(run.status)) return;
      const graph =
        run.graph_version === "support-v3"
          ? this.configuredGraph(
              WorkflowDefinition.parse(run.workflow_definition),
            )
          : this.graph;
      const config = {
        configurable: { thread_id: `${ws}:${id}` },
        recursionLimit: 80,
        durability: "sync" as const,
      };
      const saved = await graph.getState(config);
      let input: any = { workspaceId: ws, runId: id };
      if (
        saved.next.some(
          (name: string) =>
            name === "approval_wait" || name.endsWith("_approval"),
        )
      ) {
        const a = await this.db.one(
          "SELECT * FROM approvals WHERE workspace_id=$1 AND run_id=$2",
          [ws, id],
        );
        if (!a || a.status === "pending") return;
        input = new Command({ resume: a.id });
      } else if (saved.values?.runId) {
        if (!saved.next.length) return;
        input = null;
      }
      await graph.invoke(input, config);
    } finally {
      await lock.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [
        lockKey,
      ]);
      lock.release();
    }
  }
}
