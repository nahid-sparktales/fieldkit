import {
  Annotation,
  StateGraph,
  START,
  END,
  interrupt,
} from "@langchain/langgraph";
import type { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import {
  PORTS,
  type Workflow,
  type WorkflowNode,
} from "./workflow-definition.js";

export const WorkflowState = Annotation.Root({
  workspaceId: Annotation<string>(),
  runId: Annotation<string>(),
  route: Annotation<string>(),
  approvalId: Annotation<string>(),
  outcome: Annotation<string>(),
});
type Step = (
  node: WorkflowNode,
  state: typeof WorkflowState.State,
) => Promise<Partial<typeof WorkflowState.State>>;
export function compileWorkflow(
  def: Workflow,
  step: Step,
  governed?: { approve: Step; execute: Step },
  saver?: PostgresSaver,
) {
  const graph: any = new StateGraph(WorkflowState);
  const targets = (n: WorkflowNode) =>
    Object.fromEntries(
      def.edges.filter((e) => e.from === n.id).map((e) => [e.port, e.to]),
    );
  for (const n of def.nodes) {
    graph.addNode(n.id, (s: typeof WorkflowState.State) => step(n, s));
    if (n.type === "action" && governed) {
      const wait = `__${n.id}_approval`,
        approve = `__${n.id}_validate`,
        execute = `__${n.id}_execute`;
      graph.addNode(wait, (s: typeof WorkflowState.State) => {
        interrupt({
          approvalId: s.approvalId,
          summary: "Review the exact proposed customer action.",
        });
        return {};
      });
      graph.addNode(approve, (s: typeof WorkflowState.State) =>
        governed.approve(n, s),
      );
      graph.addNode(execute, (s: typeof WorkflowState.State) =>
        governed.execute(n, s),
      );
      graph.addConditionalEdges(
        n.id,
        (s: typeof WorkflowState.State) => s.outcome,
        { ...targets(n), approval: wait, execute },
      );
      graph.addEdge(wait, approve);
      graph.addConditionalEdges(
        approve,
        (s: typeof WorkflowState.State) =>
          s.route === "execute" ? "execute" : "failed",
        { execute, failed: targets(n).failed },
      );
      graph.addConditionalEdges(
        execute,
        (s: typeof WorkflowState.State) =>
          s.route === "respond" ? "done" : "failed",
        targets(n),
      );
    } else if (!PORTS[n.type].length) graph.addEdge(n.id, END);
    else
      graph.addConditionalEdges(
        n.id,
        (s: typeof WorkflowState.State) => s.outcome,
        { ...targets(n), __stop: END },
      );
  }
  graph.addEdge(START, def.nodes.find((n) => n.type === "start")!.id);
  return graph.compile(saver ? { checkpointer: saver } : {});
}
