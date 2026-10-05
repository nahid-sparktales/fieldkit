import { AsyncLocalStorage } from "node:async_hooks";
export const usageContext = new AsyncLocalStorage<{
  purpose: string;
  jobId?: string;
  diagnosticId?: string;
  shadowId?: string;
  experimentId?: string;
  rolloutId?: string;
  runId?: string;
  settings?: any;
}>();
