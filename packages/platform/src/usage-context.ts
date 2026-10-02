import { AsyncLocalStorage } from "node:async_hooks";
export const usageContext = new AsyncLocalStorage<{
  purpose: string;
  jobId?: string;
  runId?: string;
  settings?: any;
}>();
