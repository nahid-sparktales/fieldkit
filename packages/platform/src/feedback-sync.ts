import type { Database } from "./db.js";
import { uid } from "./db.js";
import type { Connections } from "./connections.js";

// These imports only read tickets which already belong to this installation.
export class FeedbackSync {
  onNegative?: (ws: string, id: string, key: string) => Promise<unknown>;
  constructor(
    private db: Database,
    private connections: Connections,
  ) {}
  async queue(ws: string, ticketId?: string) {
    await this.db.tx((q) =>
      this.db.enqueue(q, "feedback-sync", { workspaceId: ws, ticketId }),
    );
  }
  async advance(ws: string, ticketId?: string, path?: string) {
    try {
      if (ticketId) {
        await this.ticket(ws, ticketId, path);
        return;
      }
      const state = await this.db.one(
        "SELECT sync_cursor FROM quality_settings WHERE workspace_id=$1",
        [ws],
      );
      const rows = await this.db.rows(
        "SELECT id,external_id FROM conversations WHERE workspace_id=$1 AND external_id IS NOT NULL AND ($2::text IS NULL OR id>$2) ORDER BY id LIMIT 20",
        [ws, state?.sync_cursor ?? null],
      );
      await this.db.tx(async (q) => {
        for (const row of rows)
          await this.db.enqueue(q, "feedback-sync", {
            workspaceId: ws,
            ticketId: row.external_id,
          });
        const cursor = rows.length === 20 ? rows.at(-1)!.id : null;
        await q.query(
          "INSERT INTO quality_settings(workspace_id,sync_cursor) VALUES($1,$2) ON CONFLICT(workspace_id) DO UPDATE SET sync_cursor=$2",
          [ws, cursor],
        );
        if (cursor)
          await this.db.enqueue(q, "feedback-sync", { workspaceId: ws });
      });
    } catch (e) {
      await this.db.pool.query(
        "INSERT INTO quality_settings(workspace_id,sync_error) VALUES($1,$2) ON CONFLICT(workspace_id) DO UPDATE SET sync_error=$2",
        [ws, e instanceof Error ? e.message : String(e)],
      );
      throw e;
    }
  }
  private async ticket(ws: string, id: string, path?: string) {
    const conv = await this.db.one(
      "SELECT id FROM conversations WHERE workspace_id=$1 AND external_id=$2",
      [ws, id],
    );
    if (!conv) return;
    if (!path) {
      const { ticket } = await this.connections.json(
        ws,
        "zendesk",
        `/api/v2/tickets/${encodeURIComponent(id)}.json`,
      );
      let rating = ticket.satisfaction_rating;
      if (rating?.id && ["good", "bad"].includes(rating.score)) {
        const full = await this.connections.json(
          ws,
          "zendesk",
          `/api/v2/satisfaction_ratings/${encodeURIComponent(String(rating.id))}.json`,
        );
        const value = Array.isArray(full.satisfaction_rating)
          ? full.satisfaction_rating.find(
              (r: any) => String(r.id) === String(rating.id),
            )
          : full.satisfaction_rating;
        if (String(value?.ticket_id) !== id)
          throw new Error("Legacy feedback did not match the linked ticket");
        rating = value;
      }
      if (rating && ["good", "bad"].includes(rating.score))
        await this.save(
          ws,
          conv.id,
          "zendesk_legacy",
          String(rating.id ?? id),
          rating.score,
          rating.comment ?? "",
          rating,
          rating.updated_at ?? ticket.updated_at,
        );
      else if (rating?.score === "unoffered" || rating?.score === "offered")
        await this.db.pool.query(
          "DELETE FROM customer_feedback WHERE workspace_id=$1 AND conversation_id=$2 AND source='zendesk_legacy'",
          [ws, conv.id],
        );
    }
    const prefix = "/api/v2/guide/survey_responses";
    if (path && !path.startsWith(prefix + "?"))
      throw new Error("Unexpected survey pagination destination");
    const response = await this.connections.json(
      ws,
      "zendesk",
      path ??
        `${prefix}?filter[subject_zrns]=${encodeURIComponent(`zen:ticket:${id}`)}&page[size]=100`,
    );
    for (const survey of response.survey_responses ?? []) {
      const ticketIds = (survey.subjects ?? [])
        .filter((s: any) => s.type === "ticket" || s.type === "zen:ticket")
        .map((s: any) => String(s.id));
      // Filtering is not authorization: validate the returned subject against this linked ticket.
      if (!ticketIds.includes(id)) continue;
      const parsed = modernRating(survey);
      if (parsed)
        await this.save(
          ws,
          conv.id,
          "zendesk_modern",
          String(survey.id),
          parsed.rating,
          parsed.comment,
          survey,
          parsed.updatedAt,
        );
      else
        await this.db.pool.query(
          "DELETE FROM customer_feedback WHERE workspace_id=$1 AND source='zendesk_modern' AND external_id=$2",
          [ws, String(survey.id)],
        );
    }
    let next = response.links?.next;
    if (!next && response.meta?.has_more) {
      if (!response.meta.after_cursor)
        throw new Error("Survey pagination omitted its continuation cursor");
      next = `${prefix}?filter[subject_zrns]=${encodeURIComponent(`zen:ticket:${id}`)}&page[size]=100&page[after]=${encodeURIComponent(response.meta.after_cursor)}`;
    }
    if (!Array.isArray(response.survey_responses))
      throw new Error("Zendesk returned an unsupported survey response");
    if (next === path)
      throw new Error("Zendesk repeated its survey pagination cursor");
    if (next) {
      const connection = await this.db.connection(ws, "zendesk"),
        base = `https://${connection.metadata.subdomain}.zendesk.com`,
        url = new URL(next, base);
      if (url.origin !== base || url.pathname !== prefix)
        throw new Error("Unexpected survey pagination destination");
      await this.db.tx((q) =>
        this.db.enqueue(q, "feedback-sync", {
          workspaceId: ws,
          ticketId: id,
          path: url.pathname + url.search,
        }),
      );
    } else
      await this.db.pool.query(
        "INSERT INTO quality_settings(workspace_id,sync_at,sync_error) VALUES($1,now(),null) ON CONFLICT(workspace_id) DO UPDATE SET sync_at=now(),sync_error=null",
        [ws],
      );
  }
  private async save(
    ws: string,
    conversationId: string,
    source: string,
    id: string,
    rating: string,
    comment: string,
    raw: any,
    at?: string,
  ) {
    await this.db.pool.query(
      "INSERT INTO customer_feedback(id,workspace_id,conversation_id,source,external_id,rating,comment,raw,answered_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(workspace_id,source,external_id) DO UPDATE SET rating=$6,comment=$7,raw=$8,answered_at=$9,updated_at=now() WHERE customer_feedback.answered_at <= excluded.answered_at",
      [
        uid(),
        ws,
        conversationId,
        source,
        id,
        rating,
        comment,
        raw,
        at ?? new Date().toISOString(),
      ],
    );
    if (rating === "bad")
      await this.onNegative?.(ws, conversationId, `${source}:${id}`);
  }
}
export function modernRating(survey: any) {
  const answers = survey.answers ?? [];
  const answer = answers.find(
    (a: any) =>
      a.question?.sub_type === "customer_satisfaction" &&
      a.type === "rating_scale" &&
      a.rating_category,
  );
  if (!answer || !["good", "bad", "neutral"].includes(answer.rating_category))
    return null;
  const comment = answers
    .filter((a: any) => a.type === "open_ended")
    .map((a: any) =>
      typeof a.value === "string" ? a.value : (a.value?.text ?? ""),
    )
    .join("\n");
  return {
    rating: answer.rating_category,
    comment,
    updatedAt: answer.updated_at ?? answer.created_at,
  };
}
