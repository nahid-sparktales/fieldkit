import { z } from "zod";

const Id = z.string().trim().min(1).max(200);
const Ids = z.array(Id).max(50);
export const ReportFilterShape = {
  period: z.enum(["last7", "last30", "last90", "custom"]),
  from: z.iso.datetime().optional(),
  to: z.iso.datetime().optional(),
  comparison: z.boolean(),
  channels: z.array(z.enum(["portal", "email", "widget", "zendesk"])).max(4),
  organizationIds: Ids,
  teamIds: Ids,
  agentIds: Ids,
  statuses: z
    .array(z.enum(["open", "needs_staff", "waiting_approval", "resolved"]))
    .max(4),
  priorities: z.array(z.enum(["low", "normal", "high", "urgent"])).max(4),
  tags: z.array(z.string().trim().min(1).max(60)).max(20),
  query: z.string().trim().max(200),
};
export const defaultReportFilters = {
  period: "last30" as const,
  comparison: true,
  channels: [],
  organizationIds: [],
  teamIds: [],
  agentIds: [],
  statuses: [],
  priorities: [],
  tags: [],
  query: "",
};
export const ReportFilters = z.object(ReportFilterShape).strict();
export const ReportOverrides = ReportFilters.partial();
export const ReportRestrictions = ReportFilters.pick({
  channels: true,
  organizationIds: true,
  teamIds: true,
  agentIds: true,
  statuses: true,
  priorities: true,
}).partial();
export type ReportFilter = z.infer<typeof ReportFilters>;
export const ReportDimension = z.enum([
  "none",
  "day",
  "week",
  "month",
  "channel",
  "organization",
  "team",
  "agent",
  "status",
  "priority",
  "purpose",
  "provider",
  "model",
  "rating_source",
  "sla_kind",
]);
export type Dimension = z.infer<typeof ReportDimension>;
export const ReportMetric = z.enum([
  "conversations",
  "ai_conversations",
  "confirmed_resolution_rate",
  "ai_only_resolution_rate",
  "staff_resolutions",
  "automation_resolutions",
  "handoffs",
  "reopened",
  "first_response_ms",
  "resolution_ms",
  "current_backlog",
  "human_workload",
  "unassigned_human",
  "sla_breaches",
  "sla_met_rate",
  "followups_sent",
  "followups_failed",
  "csat_good_rate",
  "rated_responses",
  "input_tokens",
  "output_tokens",
  "reserved_tokens",
  "model_calls",
]);
export type MetricId = z.infer<typeof ReportMetric>;
export const ReportQuery = z
  .object({
    metric: ReportMetric,
    groupBy: ReportDimension.default("none"),
    stackBy: ReportDimension.optional(),
    restrictions: ReportRestrictions.default({}),
    filters: ReportFilters.prefault(defaultReportFilters),
  })
  .strict()
  .refine(
    (v) =>
      !v.stackBy ||
      (v.stackBy !== "none" && v.stackBy !== v.groupBy && v.groupBy !== "none"),
    "Choose two different grouping dimensions",
  );
export type ReportQueryInput = z.infer<typeof ReportQuery>;
export const ReportSelection = z
  .object({
    group: z.string().max(500).optional(),
    series: z.string().max(500).optional(),
  })
  .strict();
export const ReportDrilldown = z
  .object({
    query: ReportQuery,
    selection: ReportSelection.default({}),
    offset: z.number().int().min(0).max(10000000).default(0),
    limit: z.number().int().min(1).max(100).default(50),
  })
  .strict();
export const Widget = z
  .object({
    id: Id,
    title: z.string().trim().min(1).max(120),
    type: z.enum(["kpi", "line", "bar", "stacked_bar", "donut", "table"]),
    metric: ReportMetric,
    groupBy: ReportDimension.default("none"),
    stackBy: ReportDimension.optional(),
    overrides: ReportOverrides.default({}),
    restrictions: ReportRestrictions.default({}),
    layout: z
      .object({
        x: z.number().int().min(0).max(10),
        y: z.number().int().min(0).max(400),
        w: z.number().int().min(2).max(12),
        h: z.number().int().min(3).max(14),
      })
      .strict()
      .refine((v) => v.x + v.w <= 12, "Widget must fit the 12-column grid"),
  })
  .strict();
export type ReportWidget = z.infer<typeof Widget>;
export const DashboardDefinition = z
  .object({
    filters: ReportFilters.prefault(defaultReportFilters),
    widgets: z.array(Widget).max(24),
  })
  .strict()
  .refine(
    (v) => new Set(v.widgets.map((w) => w.id)).size === v.widgets.length,
    "Widget IDs must be unique",
  );
export const DashboardInput = z
  .object({
    name: z.string().trim().min(1).max(120),
    description: z.string().trim().max(500).default(""),
    visibility: z.enum(["personal", "workspace"]).default("personal"),
    revision: z.number().int().min(0).default(0),
    definition: DashboardDefinition,
  })
  .strict();
export const ExportInput = z
  .object({
    requestKey: Id,
    query: ReportQuery,
    selection: ReportSelection.default({}),
    mode: z.enum(["rows", "summary"]).default("rows"),
    rowLimit: z.number().int().min(1).max(50000),
  })
  .strict();
const TimeZone = z
  .string()
  .min(1)
  .max(80)
  .refine((v) => {
    try {
      new Intl.DateTimeFormat("en", { timeZone: v });
      return true;
    } catch {
      return false;
    }
  }, "Choose an IANA time zone");
export const ScheduleDefinition = z
  .object({
    frequency: z.enum(["daily", "weekly"]),
    time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
    weekday: z.number().int().min(1).max(7).default(1),
    timeZone: TimeZone.default("UTC"),
    recipientIds: Ids.min(1).max(20),
  })
  .strict()
  .refine(
    (v) => new Set(v.recipientIds).size === v.recipientIds.length,
    "Choose each recipient once",
  );
export const ScheduleInput = z
  .object({
    dashboardId: Id,
    enabled: z.boolean().default(true),
    revision: z.number().int().min(0).default(0),
    definition: ScheduleDefinition,
  })
  .strict();

export type MetricDefinition = {
  id: MetricId;
  label: string;
  unit: "count" | "percent" | "milliseconds" | "tokens";
  dataset: "tickets" | "current" | "sla" | "followups" | "feedback" | "usage";
  description: string;
  dimensions: Dimension[];
};
const common: Dimension[] = [
  "none",
  "day",
  "week",
  "month",
  "channel",
  "organization",
  "team",
  "agent",
  "status",
  "priority",
];
const def = (
  id: MetricId,
  label: string,
  unit: MetricDefinition["unit"],
  dataset: MetricDefinition["dataset"],
  description: string,
  dimensions = common,
): MetricDefinition => ({ id, label, unit, dataset, description, dimensions });
export const REPORT_METRICS: MetricDefinition[] = [
  def(
    "conversations",
    "Conversation volume",
    "count",
    "tickets",
    "Tickets created in the selected period; merged source tickets are excluded.",
  ),
  def(
    "ai_conversations",
    "AI participation",
    "count",
    "tickets",
    "Tickets in the created cohort with at least one delivered AI reply. Reminders are excluded.",
  ),
  def(
    "confirmed_resolution_rate",
    "Customer-confirmed resolution",
    "percent",
    "tickets",
    "Confirmed solved among tickets with delivered AI replies. Later customer messages or negative feedback invalidate confirmation.",
  ),
  def(
    "ai_only_resolution_rate",
    "AI-only confirmed resolution",
    "percent",
    "tickets",
    "Confirmed solved among AI tickets without staff replies, handoffs, unknown delivery or unknown historical transitions.",
  ),
  def(
    "staff_resolutions",
    "Staff resolutions",
    "count",
    "tickets",
    "Created-cohort tickets with an explicit staff resolution event. Automated resolutions are excluded.",
  ),
  def(
    "automation_resolutions",
    "Automated resolutions",
    "count",
    "tickets",
    "Created-cohort tickets explicitly resolved by a ticket automation; not counted as staff work.",
  ),
  def(
    "handoffs",
    "Handoffs",
    "count",
    "tickets",
    "Created-cohort tickets with a recorded handoff category.",
  ),
  def(
    "reopened",
    "Reopened tickets",
    "count",
    "tickets",
    "Created-cohort tickets with an explicit resolved-to-open event.",
  ),
  def(
    "first_response_ms",
    "Average first response",
    "milliseconds",
    "tickets",
    "Time from first customer message to first delivered staff or AI reply. Missing deliveries remain unknown; reminders do not count.",
  ),
  def(
    "resolution_ms",
    "Average time to resolution",
    "milliseconds",
    "tickets",
    "Time from ticket creation to first explicit resolution event. Missing historical transitions remain unknown.",
  ),
  def(
    "current_backlog",
    "Current open backlog",
    "count",
    "current",
    "Current unresolved tickets, as of query time. Date range and previous-period comparison do not apply.",
    common.filter((d) => !["day", "week", "month"].includes(d)),
  ),
  def(
    "human_workload",
    "Current human workload",
    "count",
    "current",
    "Current unresolved tickets in human handling. Date range and comparison do not apply.",
    common.filter((d) => !["day", "week", "month"].includes(d)),
  ),
  def(
    "unassigned_human",
    "Unassigned human tickets",
    "count",
    "current",
    "Current unresolved human tickets without an assignee. Date range and comparison do not apply.",
    common.filter((d) => !["day", "week", "month"].includes(d)),
  ),
  def(
    "sla_breaches",
    "SLA breaches",
    "count",
    "sla",
    "Obligations started in the selected period that breached, including obligations later satisfied.",
    [...common, "sla_kind"],
  ),
  def(
    "sla_met_rate",
    "SLA met",
    "percent",
    "sla",
    "Satisfied on time / obligations satisfied or breached. Running, paused and canceled obligations are excluded from the denominator.",
    [...common, "sla_kind"],
  ),
  def(
    "followups_sent",
    "Delivered follow-ups",
    "count",
    "followups",
    "Delivered reminder messages in the selected period, including SLA and ticket automation reminders. They are not staff replies.",
  ),
  def(
    "followups_failed",
    "Failed follow-up email deliveries",
    "count",
    "followups",
    "Reminder email deliveries marked failed or unknown. An unknown SMTP outcome is shown as uncertain, never retried automatically.",
  ),
  def(
    "csat_good_rate",
    "Customer satisfaction",
    "percent",
    "feedback",
    "Good / all latest rated responses per ticket and source submitted in the selected period. Neutral ratings count in the denominator; unrated responses do not.",
    [...common, "rating_source"],
  ),
  def(
    "rated_responses",
    "Rated responses",
    "count",
    "feedback",
    "Latest submitted non-null rating per ticket and source in the selected period.",
    [...common, "rating_source"],
  ),
  def(
    "input_tokens",
    "Reported input tokens",
    "tokens",
    "usage",
    "Provider-reported input tokens for calls in the selected period. Unattributed calls are included only when no ticket filters are active.",
    [...common, "purpose", "provider", "model"],
  ),
  def(
    "output_tokens",
    "Reported output tokens",
    "tokens",
    "usage",
    "Provider-reported output tokens; reserved usage is excluded.",
    [...common, "purpose", "provider", "model"],
  ),
  def(
    "reserved_tokens",
    "Unresolved token reservations",
    "tokens",
    "usage",
    "Reserved tokens still unresolved for calls made in the selected period; distinct from actual reported usage.",
    [...common, "purpose", "provider", "model"],
  ),
  def(
    "model_calls",
    "Model calls",
    "count",
    "usage",
    "Recorded model usage calls in the selected period, including separately labeled production, preview, evaluation and assistance.",
    [...common, "purpose", "provider", "model"],
  ),
];
export const widgetQuery = (
  widget: ReportWidget,
  filters: ReportFilter,
): ReportQueryInput =>
  ReportQuery.parse({
    metric: widget.metric,
    groupBy: widget.groupBy,
    stackBy: widget.stackBy,
    filters: { ...filters, ...widget.overrides },
    restrictions: widget.restrictions ?? {},
  });
