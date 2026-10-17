import type { Database, Queryable } from "./db.js";
import { HttpError } from "./config.js";
import {
  REPORT_METRICS,
  ReportQuery,
  type ReportFilter,
  type ReportQueryInput,
  type Dimension,
} from "./reporting-contracts.js";

type Row = Record<string, any>;
const day = 86400000;
export function reportWindow(filters: ReportFilter, now = new Date()) {
  const to = filters.period === "custom" ? filters.to : now.toISOString();
  const from =
    filters.period === "custom"
      ? filters.from
      : new Date(
          now.getTime() -
            { last7: 7, last30: 30, last90: 90 }[filters.period] * day,
        ).toISOString();
  if (
    !from ||
    !to ||
    !Number.isFinite(Date.parse(from)) ||
    !Number.isFinite(Date.parse(to)) ||
    Date.parse(from) >= Date.parse(to) ||
    Date.parse(to) - Date.parse(from) > 366 * day
  )
    throw new HttpError(400, "Choose a valid date range of at most 366 days");
  return { from, to };
}

/** The same delivered-reply and confirmation definitions are used by legacy Analytics. */
export function ticketMetricsSQL(cohort: string) {
  return `WITH cohort AS (${cohort}), metrics AS(SELECT c.*,
    EXISTS(SELECT 1 FROM messages m WHERE m.conversation_id=c.id AND m.role='assistant' AND m.delivered_at IS NOT NULL) ai,
    EXISTS(SELECT 1 FROM messages m WHERE m.conversation_id=c.id AND m.role='staff' AND m.delivered_at IS NOT NULL) staff,
    EXISTS(SELECT 1 FROM events e WHERE e.conversation_id=c.id AND e.data->>'handoffCategory' IS NOT NULL) handoff,
    EXISTS(SELECT 1 FROM events e WHERE e.conversation_id=c.id AND e.data->>'previousStatus'='resolved' AND e.data->>'status'='open' AND e.kind<>'conversation.merged') reopened,
    EXISTS(SELECT 1 FROM events e WHERE e.conversation_id=c.id AND e.data->>'actorType'='staff' AND e.data->>'status'='resolved' AND e.kind<>'conversation.merged') staff_resolved,
    EXISTS(SELECT 1 FROM events e WHERE e.conversation_id=c.id AND e.data->>'actorType'='automation' AND e.data->>'status'='resolved') automation_resolved,
    coalesce((SELECT f.resolved AND f.rating IS DISTINCT FROM 'bad' AND NOT EXISTS(SELECT 1 FROM messages later WHERE later.conversation_id=c.id AND later.role='customer' AND later.created_at>(SELECT created_at FROM messages WHERE id=f.message_id)) FROM customer_feedback f WHERE f.conversation_id=c.id AND f.source='native' ORDER BY f.updated_at DESC,f.id DESC LIMIT 1),false) confirmed,
    (SELECT min(m.created_at) FROM messages m WHERE m.conversation_id=c.id AND m.role='customer') first_customer,
    (SELECT min(m.delivered_at) FROM messages m WHERE m.conversation_id=c.id AND m.role IN ('assistant','staff') AND m.delivered_at>=(SELECT min(created_at) FROM messages WHERE conversation_id=c.id AND role='customer')) first_reply,
    (SELECT min(e.created_at) FROM events e WHERE e.conversation_id=c.id AND e.data->>'status'='resolved' AND e.kind<>'conversation.merged' AND e.created_at>=c.created_at) first_resolution,
    EXISTS(SELECT 1 FROM messages m WHERE m.conversation_id=c.id AND m.role IN ('assistant','staff') AND m.delivered_at IS NULL) unknown_delivery,
    (c.created_at<(SELECT applied_at FROM app_migrations WHERE version=9) OR (c.external_id IS NOT NULL AND (SELECT min(created_at) FROM messages WHERE conversation_id=c.id)<(SELECT applied_at FROM app_migrations WHERE version=9))) unknown_history
    FROM cohort c)`;
}

export function validateReportQuery(raw: unknown) {
  const query = ReportQuery.parse(raw),
    metric = REPORT_METRICS.find((m) => m.id === query.metric)!;
  for (const dimension of [query.groupBy, query.stackBy])
    if (dimension && !metric.dimensions.includes(dimension))
      throw new HttpError(
        400,
        `${metric.label} cannot be grouped by ${dimension.replaceAll("_", " ")}`,
      );
  reportWindow(query.filters);
  return { query, metric };
}

function dataset(ws: string, spec: ReportQueryInput, now: Date) {
  const { metric } = validateReportQuery(spec),
    window = reportWindow(spec.filters, now),
    values: unknown[] = [ws];
  const bind = (v: unknown) => {
    values.push(v);
    return `$${values.length}`;
  };
  const channel = `CASE WHEN c.origin='email' THEN 'email' ELSE coalesce(ch.kind,'unknown') END`;
  const conditions = ["c.workspace_id=$1"];
  const f = spec.filters;
  if (f.channels.length)
    conditions.push(`${channel}=ANY(${bind(f.channels)}::text[])`);
  if (f.organizationIds.length)
    conditions.push(
      `c.organization_id=ANY(${bind(f.organizationIds)}::text[])`,
    );
  if (f.teamIds.length)
    conditions.push(`c.team_id=ANY(${bind(f.teamIds)}::text[])`);
  if (f.agentIds.length)
    conditions.push(`c.assigned_to=ANY(${bind(f.agentIds)}::text[])`);
  if (f.statuses.length)
    conditions.push(`c.status=ANY(${bind(f.statuses)}::text[])`);
  if (f.priorities.length)
    conditions.push(`c.priority=ANY(${bind(f.priorities)}::text[])`);
  if (f.tags.length) conditions.push(`c.tags @> ${bind(f.tags)}::text[]`);
  if (f.query)
    conditions.push(
      `(c.subject ILIKE ${bind(`%${f.query.replace(/[\\%_]/g, "\\$&")}%`)} ESCAPE '\\' OR c.id=${bind(f.query)})`,
    );
  const restrictionColumns: Record<string, string> = {
    channels: channel,
    organizationIds: "c.organization_id",
    teamIds: "c.team_id",
    agentIds: "c.assigned_to",
    statuses: "c.status",
    priorities: "c.priority",
  };
  for (const [key, selection] of Object.entries(spec.restrictions ?? {}))
    if (selection?.length)
      conditions.push(
        `${restrictionColumns[key]}=ANY(${bind(selection)}::text[])`,
      );
  const where = conditions.join(" AND ");
  const start = bind(window.from),
    end = bind(window.to);
  const joins = `LEFT JOIN channels ch ON ch.id=c.channel_id LEFT JOIN customer_organizations org ON org.workspace_id=c.workspace_id AND org.id=c.organization_id LEFT JOIN teams tm ON tm.workspace_id=c.workspace_id AND tm.id=c.team_id LEFT JOIN "user" au ON au.id=c.assigned_to`;
  const meta = `c.id ticket_id,c.subject,c.status,c.priority,${channel} channel,c.organization_id,coalesce(org.name,'No organization') organization,c.team_id,coalesce(tm.name,'No team') team,c.assigned_to agent_id,coalesce(au.name,'Unassigned') agent`;
  let sql: string,
    numerator = "1::float",
    denominator = "1::float",
    eligible = "TRUE",
    unknown = "FALSE";
  if (metric.dataset === "tickets" || metric.dataset === "current") {
    sql =
      ticketMetricsSQL(
        `SELECT c.* FROM conversations c LEFT JOIN channels ch ON ch.id=c.channel_id WHERE ${where} AND c.merged_into_id IS NULL ${metric.dataset === "tickets" ? `AND c.created_at>=${start} AND c.created_at<${end}` : ""}`,
      ) +
      `, records AS(SELECT c.id record_id,c.created_at occurred_at,${meta},c.ai,c.staff,c.handoff,c.reopened,c.staff_resolved,c.automation_resolved,c.confirmed,c.first_customer,c.first_reply,c.first_resolution,c.unknown_delivery,c.unknown_history,c.mode FROM metrics c ${joins})`;
    const yes = (expression: string) =>
      `CASE WHEN ${expression} THEN 1::float ELSE 0::float END`;
    const aiOnly =
      "ai AND NOT staff AND NOT handoff AND NOT unknown_delivery AND NOT unknown_history";
    switch (spec.metric) {
      case "ai_conversations":
        eligible = "ai";
        numerator = yes(eligible);
        break;
      case "confirmed_resolution_rate":
        eligible = "ai";
        denominator = yes(eligible);
        numerator = yes("ai AND confirmed");
        break;
      case "ai_only_resolution_rate":
        eligible = aiOnly;
        denominator = yes(eligible);
        numerator = yes(`(${aiOnly}) AND confirmed`);
        unknown = "unknown_history OR unknown_delivery";
        break;
      case "staff_resolutions":
        eligible = "staff_resolved";
        numerator = yes(eligible);
        break;
      case "automation_resolutions":
        eligible = "automation_resolved";
        numerator = yes(eligible);
        break;
      case "handoffs":
        eligible = "handoff";
        numerator = yes(eligible);
        break;
      case "reopened":
        eligible = "reopened";
        numerator = yes(eligible);
        break;
      case "first_response_ms":
        eligible = "first_reply IS NOT NULL AND first_customer IS NOT NULL";
        denominator = yes(eligible);
        numerator =
          "coalesce(extract(epoch FROM first_reply-first_customer)*1000,0)::float";
        unknown = `NOT (${eligible})`;
        break;
      case "resolution_ms":
        eligible = "first_resolution IS NOT NULL AND NOT unknown_history";
        denominator = yes(eligible);
        numerator = `CASE WHEN ${eligible} THEN extract(epoch FROM first_resolution-occurred_at)*1000 ELSE 0 END::float`;
        unknown = `NOT (${eligible})`;
        break;
      case "current_backlog":
        eligible = "status<>'resolved'";
        numerator = yes(eligible);
        break;
      case "human_workload":
        eligible =
          "status<>'resolved' AND (mode='human' OR status='needs_staff')";
        numerator = yes(eligible);
        break;
      case "unassigned_human":
        eligible =
          "status<>'resolved' AND (mode='human' OR status='needs_staff') AND agent_id IS NULL";
        numerator = yes(eligible);
        break;
    }
  } else if (metric.dataset === "sla") {
    sql = `WITH records AS(SELECT s.id record_id,s.started_at occurred_at,${meta},s.kind sla_kind,s.state,s.breached_at,s.satisfied_at FROM sla_obligations s JOIN conversations c ON c.id=s.conversation_id ${joins} WHERE ${where} AND s.started_at>=${start} AND s.started_at<${end})`;
    if (spec.metric === "sla_breaches") {
      eligible = "breached_at IS NOT NULL OR state='breached'";
      numerator = `CASE WHEN ${eligible} THEN 1::float ELSE 0::float END`;
    } else {
      eligible =
        "satisfied_at IS NOT NULL OR breached_at IS NOT NULL OR state IN ('satisfied','breached')";
      denominator = `CASE WHEN ${eligible} THEN 1::float ELSE 0::float END`;
      numerator =
        "CASE WHEN (satisfied_at IS NOT NULL OR state='satisfied') AND breached_at IS NULL THEN 1::float ELSE 0::float END";
      unknown = `NOT (${eligible})`;
    }
  } else if (metric.dataset === "followups") {
    sql = `WITH records AS(SELECT m.id record_id,coalesce(m.delivered_at,m.created_at) occurred_at,${meta},m.delivered_at,em.status email_status FROM messages m JOIN conversations c ON c.id=m.conversation_id LEFT JOIN ticket_emails em ON em.message_id=m.id ${joins} WHERE ${where} AND m.role='reminder' AND coalesce(m.delivered_at,m.created_at)>=${start} AND coalesce(m.delivered_at,m.created_at)<${end})`;
    eligible =
      spec.metric === "followups_sent"
        ? "delivered_at IS NOT NULL"
        : "email_status IN ('failed','unknown')";
    numerator = `CASE WHEN ${eligible} THEN 1::float ELSE 0::float END`;
    unknown = "email_status='unknown'";
  } else if (metric.dataset === "feedback") {
    sql = `WITH latest AS(SELECT DISTINCT ON(f.conversation_id,f.source) f.* FROM customer_feedback f WHERE f.workspace_id=$1 ORDER BY f.conversation_id,f.source,CASE WHEN f.source='native' THEN f.updated_at ELSE f.answered_at END DESC,f.id DESC), records AS(SELECT f.id record_id,f.answered_at occurred_at,${meta},f.rating,f.source rating_source FROM latest f JOIN conversations c ON c.id=f.conversation_id ${joins} WHERE ${where} AND f.answered_at>=${start} AND f.answered_at<${end})`;
    eligible = "rating IN ('good','bad','neutral')";
    denominator = `CASE WHEN ${eligible} THEN 1::float ELSE 0::float END`;
    numerator = `CASE WHEN ${spec.metric === "csat_good_rate" ? "rating='good'" : eligible} THEN 1::float ELSE 0::float END`;
    unknown = `NOT (${eligible})`;
  } else {
    // Unattributed model work is included only when the user applies no ticket filter.
    const ticketFiltered = conditions.length > 1;
    sql = `WITH records AS(SELECT u.id record_id,u.created_at occurred_at,${meta},coalesce(u.purpose,'unknown') purpose,u.provider,u.model,u.input_tokens,u.output_tokens,u.reserved FROM usage u LEFT JOIN runs r ON r.id=u.run_id LEFT JOIN conversations c ON c.id=r.conversation_id ${joins} WHERE u.workspace_id=$1 AND u.created_at>=${start} AND u.created_at<${end} ${ticketFiltered ? `AND ${where}` : ""})`;
    const col = {
      input_tokens: "input_tokens",
      output_tokens: "output_tokens",
      reserved_tokens: "reserved",
      model_calls: "1",
    }[
      spec.metric as
        | "input_tokens"
        | "output_tokens"
        | "reserved_tokens"
        | "model_calls"
    ];
    numerator = `coalesce(${col},0)::float`;
  }
  sql += `, measured AS(SELECT records.*,(${numerator}) numerator,(${denominator}) denominator,(${eligible}) eligible,(${unknown}) unknown FROM records WHERE ${start}::timestamptz<${end}::timestamptz)`;
  return { sql, values, window, metric };
}
function dim(d: Dimension | undefined): { key: string; label: string } {
  if (!d || d === "none") return { key: "'all'", label: "'All'" };
  if (["day", "week", "month"].includes(d)) {
    const value = `to_char(date_trunc('${d}',occurred_at AT TIME ZONE 'UTC'),'YYYY-MM-DD')`;
    return { key: value, label: value };
  }
  const names: Record<string, [string, string]> = {
    organization: ["organization_id", "organization"],
    team: ["team_id", "team"],
    agent: ["agent_id", "agent"],
  };
  const [key, label] = names[d] ?? [d, d];
  return {
    key: `coalesce(${key}::text,'__none')`,
    label: `coalesce(${label}::text,'Unknown')`,
  };
}
const totalExpression = (unit: string) =>
  unit === "percent"
    ? "100.0*sum(numerator)/nullif(sum(denominator),0)"
    : unit === "milliseconds"
      ? "sum(numerator)/nullif(sum(denominator),0)"
      : "coalesce(sum(numerator),0)";
const aggregation = (unit: string) =>
  `${totalExpression(unit)}::float value,coalesce(sum(numerator),0)::float numerator,coalesce(sum(denominator),0)::float denominator,count(*)::int records,count(*) FILTER(WHERE eligible)::int eligible,count(*) FILTER(WHERE unknown)::int unknown`;

export async function queryReport(
  db: Database,
  ws: string,
  raw: unknown,
  now: Date,
  q: Queryable = db.pool,
) {
  const { query } = validateReportQuery(raw),
    built = dataset(ws, query, now),
    g = dim(query.groupBy),
    s = dim(query.stackBy);
  const [total, groups] = await Promise.all([
    db.one(
      built.sql + ` SELECT ${aggregation(built.metric.unit)} FROM measured`,
      built.values,
      q,
    ),
    db.rows(
      built.sql +
        ` SELECT ${g.key} "key",${g.label} label,${s.key} series_key,${s.label} series,${aggregation(built.metric.unit)} FROM measured GROUP BY 1,2,3,4 ORDER BY 1,3 LIMIT 101`,
      built.values,
      q,
    ),
  ]);
  let comparison: Row | null = null;
  if (query.filters.comparison && built.metric.dataset !== "current") {
    const from = Date.parse(built.window.from),
      to = Date.parse(built.window.to),
      previous = {
        ...query,
        filters: {
          ...query.filters,
          period: "custom" as const,
          from: new Date(from - (to - from)).toISOString(),
          to: built.window.from,
          comparison: false,
        },
      },
      p = dataset(ws, previous, now);
    comparison = {
      ...p.window,
      total: await db.one(
        p.sql + ` SELECT ${aggregation(p.metric.unit)} FROM measured`,
        p.values,
        q,
      ),
    };
  }
  return {
    metric: built.metric,
    query: {
      ...query,
      filters: { ...query.filters, period: "custom", ...built.window },
    },
    window: built.window,
    asOf: now.toISOString(),
    total,
    groups: groups.slice(0, 100),
    truncatedGroups: groups.length > 100,
    comparison,
  };
}

export async function drillReport(
  db: Database,
  ws: string,
  query: ReportQueryInput,
  selection: { group?: string; series?: string },
  offset: number,
  limit: number,
  now: Date,
  q: Queryable = db.pool,
) {
  const built = dataset(ws, query, now),
    g = dim(query.groupBy),
    s = dim(query.stackBy),
    values = [...built.values],
    conditions = ["eligible"];
  for (const [value, expression] of [
    [selection.group, g.key],
    [selection.series, s.key],
  ])
    if (value !== undefined) {
      values.push(value);
      conditions.push(`${expression}=$${values.length}`);
    }
  const where = conditions.join(" AND "),
    count = await db.one(
      built.sql + ` SELECT count(*)::int total FROM measured WHERE ${where}`,
      values,
      q,
    );
  values.push(limit, offset);
  const rows = await db.rows(
    built.sql +
      ` SELECT record_id,ticket_id,subject,status,priority,channel,organization,team,agent,occurred_at,numerator,denominator,unknown FROM measured WHERE ${where} ORDER BY occurred_at DESC,record_id DESC LIMIT $${values.length - 1} OFFSET $${values.length}`,
    values,
    q,
  );
  return {
    rows,
    total: count!.total,
    offset,
    limit,
    hasMore: offset + rows.length < count!.total,
    window: built.window,
    metric: built.metric,
    asOf: now.toISOString(),
  };
}
