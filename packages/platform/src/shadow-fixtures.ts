import { digest } from "./security.js";
import type { WorkflowNode } from "./workflow-definition.js";
// Contract and canonical value, never a model-selected name, grant fixture access.
export function fixtureKey(kind: string, node: WorkflowNode, input: unknown) {
  return digest({ kind, type: node.type, contract: node.data, input });
}
export type FixtureRequest = {
  kind: "account" | "api";
  node: WorkflowNode;
  input: unknown;
};
export type CapturedRead = { key: string; result: unknown; proof?: any };
