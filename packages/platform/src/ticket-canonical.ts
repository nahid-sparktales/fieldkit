import type { Database, Queryable } from "./db.js";
import { HttpError } from "./config.js";

// Resolution never grants access: callers must authorize the returned ticket.
export async function canonicalTicket(
  db: Database,
  ws: string,
  id: string,
  q: Queryable = db.pool,
) {
  const source = await db.one(
    "SELECT * FROM conversations WHERE workspace_id=$1 AND id=$2",
    [ws, id],
    q,
  );
  if (!source) throw new HttpError(404, "Not found");
  if (!source.merged_into_id) return source;
  const target = await db.one(
    "SELECT * FROM conversations WHERE workspace_id=$1 AND id=$2 AND merged_into_id IS NULL",
    [ws, source.merged_into_id],
    q,
  );
  if (!target) throw new HttpError(404, "Not found");
  return target;
}
export async function ticketGroup(
  db: Database,
  ws: string,
  id: string,
  q: Queryable = db.pool,
): Promise<string[]> {
  return (
    await db.rows(
      "SELECT id FROM conversations WHERE workspace_id=$1 AND (id=$2 OR merged_into_id=$2) ORDER BY id",
      [ws, id],
      q,
    )
  ).map((r) => r.id);
}
