import type { PoolClient } from "pg";

export async function rolloutFence(
  db: import("./db.js").Database,
  q: PoolClient,
  ws: string,
  runId: string,
) {
  const run = await db.one(
    "SELECT rollout_id FROM runs WHERE workspace_id=$1 AND id=$2",
    [ws, runId],
    q,
  );
  if (run?.rollout_id)
    await q.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      `rollout-effect:${ws}:${run.rollout_id}`,
    ]);
}
