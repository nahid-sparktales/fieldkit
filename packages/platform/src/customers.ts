import { type Database, uid } from "./db.js";
import { type Principal, requireStaff } from "./auth.js";
import { HttpError, requireValue } from "./config.js";
import {
  InboxQuery,
  CustomerQuery,
  CustomerPage,
  CustomerNote,
} from "./customer-contracts.js";

const PAGE_SIZE = 40;
// The same state precedence as the inbox badges, evaluated across all retained tickets.
const stateSQL = `CASE WHEN c.status='resolved' THEN 'resolved'
 WHEN c.mode='human' OR c.status='needs_staff' THEN 'human'
 WHEN c.status='waiting_approval' THEN CASE WHEN EXISTS(
 SELECT 1 FROM approvals a JOIN runs r ON r.id=a.run_id AND r.workspace_id=a.workspace_id
 WHERE a.workspace_id=c.workspace_id AND r.conversation_id=c.id AND a.status='pending' AND a.expires_at>now())
 THEN 'approval' ELSE 'human' END ELSE 'agent' END`;
const typeSQL = "CASE WHEN ch.kind='widget' THEN 'chat' ELSE 'ticket' END";

export class Customers {
  constructor(private db: Database) {}
  async contact(p: Principal, id: string) {
    requireStaff(p);
    return requireValue(
      await this.db.one(
        "SELECT * FROM contacts WHERE workspace_id=$1 AND id=$2",
        [p.workspaceId, id],
      ),
    );
  }
  async inbox(p: Principal, raw: unknown) {
    requireStaff(p);
    const d = InboxQuery.parse(raw);
    const args = [
      p.workspaceId,
      d.type,
      d.assignee,
      d.q,
      d.contactId ?? null,
      d.state,
      PAGE_SIZE,
      (d.page - 1) * PAGE_SIZE,
    ];
    const cte = `WITH base AS (
      SELECT c.*,ct.name customer_name,ct.email customer_email,ch.kind channel_kind,
      ${typeSQL} conversation_type,${stateSQL} inbox_state
      FROM conversations c JOIN contacts ct ON ct.workspace_id=c.workspace_id AND ct.id=c.contact_id
      LEFT JOIN channels ch ON ch.workspace_id=c.workspace_id AND ch.id=c.channel_id
      WHERE c.workspace_id=$1 AND ($2='all' OR ${typeSQL}=$2)
      AND ($3='all' OR ($3='unassigned' AND c.assigned_to IS NULL) OR c.assigned_to=$3)
      AND ($4='' OR strpos(lower(c.subject||' '||ct.name||' '||coalesce(ct.email,'')),lower($4))>0)
      AND ($5::text IS NULL OR c.contact_id=$5)
    ), filtered AS (SELECT * FROM base WHERE $6='all' OR inbox_state=$6)`;
    // Group before pagination: one prolific customer cannot consume every queue slot.
    const grouped = d.group === "customer";
    const result = await this.db.one(
      `${cte}, items AS (
      SELECT f.*,count(*) OVER (PARTITION BY contact_id)::int group_count,
      count(*) FILTER(WHERE status<>'resolved') OVER(PARTITION BY contact_id)::int group_open,
      count(*) FILTER(WHERE conversation_type='ticket') OVER(PARTITION BY contact_id)::int group_tickets,
      count(*) FILTER(WHERE conversation_type='chat') OVER(PARTITION BY contact_id)::int group_chats,
      count(*) FILTER(WHERE inbox_state='human') OVER(PARTITION BY contact_id)::int group_human,
      count(*) FILTER(WHERE inbox_state='approval') OVER(PARTITION BY contact_id)::int group_approval,
      row_number() OVER(PARTITION BY contact_id ORDER BY updated_at DESC,id DESC) position FROM filtered f
    ), page AS (SELECT * FROM items ${grouped ? "WHERE position=1" : ""} ORDER BY updated_at DESC,id DESC LIMIT $7 OFFSET $8)
    SELECT (SELECT count(${grouped ? "DISTINCT contact_id" : "*"})::int FROM filtered) total,
    (SELECT count(*)::int FROM filtered) conversation_total,
    (SELECT coalesce(jsonb_object_agg(inbox_state,n),'{}') FROM (SELECT inbox_state,count(*)::int n FROM base GROUP BY inbox_state) counts) counts,
    coalesce((SELECT jsonb_agg(row_to_json(p) ORDER BY p.updated_at DESC,p.id DESC) FROM page p),'[]') conversations`,
      args,
    );
    const rows = result!.conversations;
    if (rows.length) {
      const summaries = await this.db.rows(
        `SELECT c.id,
        (SELECT left(body,240) FROM messages m WHERE m.workspace_id=c.workspace_id AND m.conversation_id=c.id AND role IN ('customer','assistant','staff') ORDER BY created_at DESC,id DESC LIMIT 1) last_message,
        (SELECT count(*)::int FROM customer_feedback f WHERE f.workspace_id=c.workspace_id AND f.conversation_id=c.id) feedback_count,
        (SELECT resolved FROM customer_feedback f WHERE f.workspace_id=c.workspace_id AND f.conversation_id=c.id ORDER BY updated_at DESC LIMIT 1) feedback_resolved,
        (SELECT rating FROM customer_feedback f WHERE f.workspace_id=c.workspace_id AND f.conversation_id=c.id ORDER BY updated_at DESC LIMIT 1) feedback_rating
        FROM conversations c WHERE c.workspace_id=$1 AND c.id=ANY($2::text[])`,
        [p.workspaceId, rows.map((r: any) => r.id)],
      );
      for (const row of rows)
        Object.assign(
          row,
          summaries.find((s) => s.id === row.id),
        );
    }
    return { ...result, page: d.page, pageSize: PAGE_SIZE };
  }
  async list(p: Principal, raw: unknown) {
    requireStaff(p);
    const d = CustomerQuery.parse(raw);
    const where = `WHERE ct.workspace_id=$1 AND ($2='' OR strpos(lower(ct.name||' '||coalesce(ct.email,'')||' '||coalesce(ct.external_id,'')),lower($2))>0)
      AND ($3='all' OR ($3='verified' AND ct.verified) OR ($3='visitor' AND NOT ct.verified))`;
    return this.db.one(
      `WITH customers AS (
      SELECT ct.id,ct.name,ct.email,ct.verified,ct.user_id,ct.external_id,
      (SELECT count(*)::int FROM conversations c WHERE c.workspace_id=ct.workspace_id AND c.contact_id=ct.id) conversations,
      (SELECT count(*)::int FROM conversations c WHERE c.workspace_id=ct.workspace_id AND c.contact_id=ct.id AND c.status<>'resolved') open_conversations,
      (SELECT max(updated_at) FROM conversations c WHERE c.workspace_id=ct.workspace_id AND c.contact_id=ct.id) last_activity
      FROM contacts ct ${where}
    ), page AS (SELECT * FROM customers ORDER BY last_activity DESC NULLS LAST,name,id LIMIT $4 OFFSET $5)
    SELECT (SELECT count(*)::int FROM customers) total,coalesce((SELECT jsonb_agg(row_to_json(p)) FROM page p),'[]') customers,
    $6::int page,$4::int "pageSize"`,
      [p.workspaceId, d.q, d.kind, PAGE_SIZE, (d.page - 1) * PAGE_SIZE, d.page],
    );
  }
  async detail(p: Principal, id: string) {
    const contact = await this.contact(p, id);
    const summary = await this.db.one(
      `SELECT count(*)::int total,
      count(*) FILTER(WHERE c.status<>'resolved')::int open,
      count(*) FILTER(WHERE ch.kind='widget')::int chats,
      count(*) FILTER(WHERE ch.kind IS DISTINCT FROM 'widget')::int tickets,
      min(c.created_at) first_contact,max(c.updated_at) last_activity
      FROM conversations c LEFT JOIN channels ch ON ch.id=c.channel_id AND ch.workspace_id=c.workspace_id WHERE c.workspace_id=$1 AND c.contact_id=$2`,
      [p.workspaceId, id],
    );
    const notes = await this.db.one(
      `SELECT
      (SELECT count(*) FROM contact_notes WHERE workspace_id=$1 AND contact_id=$2)+
      (SELECT count(*) FROM messages m JOIN conversations c ON c.id=m.conversation_id AND c.workspace_id=m.workspace_id WHERE c.workspace_id=$1 AND c.contact_id=$2 AND m.role='note') AS count`,
      [p.workspaceId, id],
    );
    return { contact, summary: { ...summary, notes: Number(notes!.count) } };
  }
  async notes(p: Principal, id: string, raw: unknown) {
    await this.contact(p, id);
    const { page } = CustomerPage.parse(raw);
    return this.db.one(
      `WITH notes AS (
      SELECT n.id,n.body,n.created_at,u.name author_name,NULL::text conversation_id,NULL::text subject,'customer' scope
      FROM contact_notes n LEFT JOIN "user" u ON u.id=n.author_id WHERE n.workspace_id=$1 AND n.contact_id=$2
      UNION ALL
      SELECT m.id,m.body,m.created_at,u.name author_name,c.id conversation_id,c.subject,'conversation' scope
      FROM messages m JOIN conversations c ON c.id=m.conversation_id AND c.workspace_id=m.workspace_id LEFT JOIN "user" u ON u.id=m.author_id
      WHERE c.workspace_id=$1 AND c.contact_id=$2 AND m.role='note'
    ), page AS (SELECT * FROM notes ORDER BY created_at DESC,id DESC LIMIT $3 OFFSET $4)
    SELECT (SELECT count(*)::int FROM notes) total,coalesce((SELECT jsonb_agg(row_to_json(p)) FROM page p),'[]') notes,
    $5::int page,$3::int "pageSize"`,
      [p.workspaceId, id, PAGE_SIZE, (page - 1) * PAGE_SIZE, page],
    );
  }
  async addNote(p: Principal, id: string, raw: unknown) {
    await this.contact(p, id);
    const d = CustomerNote.parse(raw);
    return this.db.tx(async (q) => {
      const saved = await this.db.one(
        `INSERT INTO contact_notes(id,workspace_id,contact_id,author_id,body,request_key) VALUES($1,$2,$3,$4,$5,$6)
        ON CONFLICT(workspace_id,contact_id,request_key) DO NOTHING RETURNING *`,
        [uid(), p.workspaceId, id, p.userId, d.body, d.requestKey],
        q,
      );
      const note =
        saved ??
        requireValue(
          await this.db.one(
            "SELECT * FROM contact_notes WHERE workspace_id=$1 AND contact_id=$2 AND request_key=$3",
            [p.workspaceId, id, d.requestKey],
            q,
          ),
        );
      if (note.body !== d.body || note.author_id !== p.userId)
        throw new HttpError(409, "Request key already belongs to another note");
      if (saved)
        await this.db.event(q, p.workspaceId, "customer.note_added", {
          contactId: id,
          noteId: note.id,
          actor: p.userId,
        });
      return note;
    });
  }
}
