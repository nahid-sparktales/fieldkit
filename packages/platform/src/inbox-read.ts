import { z } from "zod";
import { type Database } from "./db.js";
import { type Principal, requireStaff, conversation } from "./auth.js";
import { HttpError } from "./config.js";

export const INBOX_READ_SCHEMA = `
ALTER TABLE messages ADD COLUMN IF NOT EXISTS inbox_sequence bigserial;
CREATE INDEX IF NOT EXISTS messages_inbox_sequence ON messages(workspace_id,conversation_id,inbox_sequence DESC) WHERE role='customer';
CREATE TABLE IF NOT EXISTS conversation_reads(
 workspace_id text NOT NULL,conversation_id text NOT NULL,user_id text NOT NULL,
 customer_sequence bigint NOT NULL DEFAULT 0,read_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,conversation_id,user_id),
 FOREIGN KEY(workspace_id,conversation_id) REFERENCES conversations(workspace_id,id) ON DELETE CASCADE,
 FOREIGN KEY(workspace_id,user_id) REFERENCES memberships(workspace_id,user_id) ON DELETE CASCADE);
`;
const Cursor = z
  .string()
  .regex(/^\d{1,19}$/)
  .pipe(z.string().refine((s) => BigInt(s) <= 9223372036854775807n));
const Input = z.discriminatedUnion("read", [
  z.object({ read: z.literal(true), cursor: Cursor }).strict(),
  z.object({ read: z.literal(false) }).strict(),
]);

export function customerMessageCursor(
  messages: { role: string; inbox_sequence: string }[],
) {
  return messages.reduce(
    (max, m) =>
      m.role === "customer" && BigInt(m.inbox_sequence) > BigInt(max)
        ? String(m.inbox_sequence)
        : max,
    "0",
  );
}
export async function inboxReadState(
  db: Database,
  p: Principal,
  id: string,
  cursor: string,
) {
  requireStaff(p);
  const row = await db.one(
    "SELECT customer_sequence FROM conversation_reads WHERE workspace_id=$1 AND conversation_id=$2 AND user_id=$3",
    [p.workspaceId, id, p.userId],
  );
  return {
    cursor,
    unread: !row || BigInt(row.customer_sequence) < BigInt(cursor),
  };
}
export async function setInboxRead(
  db: Database,
  p: Principal,
  id: string,
  raw: unknown,
) {
  requireStaff(p);
  const d = Input.parse(raw);
  await conversation(db, p, id);
  if (!d.read) {
    await db.pool.query(
      "DELETE FROM conversation_reads WHERE workspace_id=$1 AND conversation_id=$2 AND user_id=$3",
      [p.workspaceId, id, p.userId],
    );
    return { unread: true };
  }
  // Acknowledge the snapshot the staff member actually opened, never unseen messages.
  const current = (await db.one(
    "SELECT coalesce(max(inbox_sequence),0)::text cursor FROM messages WHERE workspace_id=$1 AND conversation_id=$2 AND role='customer'",
    [p.workspaceId, id],
  ))!.cursor;
  if (BigInt(d.cursor) > BigInt(current))
    throw new HttpError(400, "Read cursor is ahead of this conversation");
  await db.pool.query(
    `INSERT INTO conversation_reads(workspace_id,conversation_id,user_id,customer_sequence) VALUES($1,$2,$3,$4)
    ON CONFLICT(workspace_id,conversation_id,user_id) DO UPDATE SET customer_sequence=greatest(conversation_reads.customer_sequence,EXCLUDED.customer_sequence),read_at=now()`,
    [p.workspaceId, id, p.userId, d.cursor],
  );
  return inboxReadState(db, p, id, current);
}
