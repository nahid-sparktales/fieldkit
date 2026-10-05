import type { TestCaseDefinition } from "./quality-contracts.js";
import type { ActionDefinition } from "./contracts.js";
export type EvaluationContext = {
  fixtures: TestCaseDefinition["fixtures"];
  actions: ActionDefinition[];
  settings: any;
  readFixture?: (
    request: import("./shadow-fixtures.js").FixtureRequest,
  ) => Promise<any>;
  actionCounts?: Record<string, number>;
  conversation?: Record<string, any>;
  beforeStep?: () => Promise<void>;
};
