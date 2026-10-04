import { z } from "zod";
import type { Database, Queryable } from "./db.js";
export const WorkflowChannel = z.enum([
  "default",
  "portal",
  "widget",
  "zendesk",
]);
export type WorkflowChannel = z.infer<typeof WorkflowChannel>;

export async function effectiveWorkflow(
  db: Database,
  ws: string,
  channelId?: string | null,
  q?: Queryable,
) {
  return db.one(
    `SELECT v.version,COALESCE(v.compiled_definition,v.definition) definition,v.channel
     FROM workflow_versions v WHERE v.workspace_id=$1 AND v.version=COALESCE(
       (SELECT cw.published_version FROM channel_workflows cw JOIN channels ch ON ch.workspace_id=cw.workspace_id AND ch.kind=cw.channel WHERE cw.workspace_id=$1 AND ch.id=$2),
       (SELECT published_version FROM workflows WHERE workspace_id=$1))`,
    [ws, channelId ?? null],
    q,
  );
}
