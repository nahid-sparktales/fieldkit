import type { TestCaseDefinition } from "./quality-contracts.js";
import type { ActionDefinition } from "./contracts.js";
export type EvaluationContext = {
  fixtures: TestCaseDefinition["fixtures"];
  actions: ActionDefinition[];
  settings: any;
  beforeStep?: () => Promise<void>;
};
