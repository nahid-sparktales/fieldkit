import { Temporal } from "@js-temporal/polyfill";
import { z } from "zod";
import { Database, uid, type Queryable } from "./db.js";
import { requireStaff, type Mailer, type Principal } from "./auth.js";
import { HttpError, requireValue } from "./config.js";
import {
  refreshPrincipal,
  resolveStaffPrincipal,
  requireCapability,
  hasCapability,
} from "./permissions.js";
import { digest, seal, unseal } from "./security.js";
import {
  DashboardInput,
  DashboardDefinition,
  ExportInput,
  ScheduleInput,
  ScheduleDefinition,
  ReportDrilldown,
  ReportQuery,
  REPORT_METRICS,
  widgetQuery,
} from "./reporting-contracts.js";
import {
  queryReport,
  drillReport,
  validateReportQuery,
  reportWindow,
} from "./reporting-query.js";

type Row = Record<string, any>;
const jobColumns =
  "id,kind,status,row_count,truncated,error,dashboard_id,schedule_id,created_at,completed_at,expires_at,mail_status,mail_error";
export function csvCell(value: unknown) {
  let text =
    value === null || value === undefined
      ? ""
      : value instanceof Date
        ? value.toISOString()
        : String(value);
  if (/^[\s\u0000-\u001f]*[=+\-@]/.test(text) || /^[\t\r\n]/.test(text))
    text = "'" + text;
  return `"${text.replaceAll('"', '""')}"`;
}
export function reportCSV(rows: Row[], columns: string[]) {
  return (
    "\ufeff" +
    [
      columns.map(csvCell).join(","),
      ...rows.map((row) => columns.map((k) => csvCell(row[k])).join(",")),
    ].join("\r\n") +
    "\r\n"
  );
}
export function nextReportAt(raw: unknown, after: Date) {
  const d = ScheduleDefinition.parse(raw),
    local = Temporal.Instant.from(after.toISOString()).toZonedDateTimeISO(
      d.timeZone,
    ),
    [hour, minute] = d.time.split(":").map(Number);
  for (let n = 0; n <= 8; n++) {
    const date = local.toPlainDate().add({ days: n });
    if (d.frequency === "weekly" && date.dayOfWeek !== d.weekday) continue;
    const at = date
      .toPlainDateTime({ hour, minute })
      .toZonedDateTime(d.timeZone, { disambiguation: "compatible" });
    if (at.epochMilliseconds > after.getTime())
      return new Date(at.epochMilliseconds);
  }
  throw new Error("Unable to calculate the next report delivery");
}

export class Reporting {
  constructor(
    public db: Database,
    private send: Mailer,
    private now: () => Date = () => new Date(),
  ) {}
  private async actor(p: Principal, q: Queryable = this.db.pool) {
    requireStaff(p);
    p = await refreshPrincipal(this.db, p, q);
    requireCapability(p, "analytics:read");
    requireCapability(p, "tickets:read");
    if (p.ticketScope && p.ticketScope !== "all")
      throw new HttpError(
        403,
        "Reports require access to all tickets in this workspace",
      );
    return p;
  }
  private validateQuery(p: Principal, raw: unknown) {
    const { query } = validateReportQuery(raw);
    if (
      (query.groupBy === "organization" ||
        query.stackBy === "organization" ||
        query.filters.organizationIds.length ||
        query.restrictions.organizationIds?.length) &&
      !hasCapability(p, "customers:read")
    )
      throw new HttpError(
        403,
        "Organization reporting requires customer access",
      );
    return query;
  }
  private async dashboard(
    p: Principal,
    id: string,
    q: Queryable = this.db.pool,
    write = false,
  ) {
    const row = requireValue(
      await this.db.one(
        "SELECT * FROM report_dashboards WHERE workspace_id=$1 AND id=$2",
        [p.workspaceId, id],
        q,
      ),
    );
    if (row.visibility === "personal" && row.created_by !== p.userId)
      throw new HttpError(404, "Dashboard not found");
    if (write && row.visibility === "workspace")
      requireCapability(p, "reports:manage");
    for (const widget of DashboardDefinition.parse(row.definition).widgets)
      this.validateQuery(p, widgetQuery(widget, row.definition.filters));
    return row;
  }
  async catalog(p: Principal) {
    p = await this.actor(p);
    const [dashboards, organizations, teams, agents] = await Promise.all([
      this.db.rows(
        "SELECT id,name,description,visibility,revision,created_by,updated_at FROM report_dashboards WHERE workspace_id=$1 AND (visibility='workspace' OR created_by=$2) ORDER BY updated_at DESC,id",
        [p.workspaceId, p.userId],
      ),
      hasCapability(p, "customers:read")
        ? this.db.rows(
            "SELECT id,name FROM customer_organizations WHERE workspace_id=$1 AND active ORDER BY name,id",
            [p.workspaceId],
          )
        : [],
      this.db.rows(
        "SELECT id,name FROM teams WHERE workspace_id=$1 AND active ORDER BY name,id",
        [p.workspaceId],
      ),
      this.db.rows(
        'SELECT u.id,u.name FROM memberships m JOIN "user" u ON u.id=m.user_id WHERE m.workspace_id=$1 AND NOT m.disabled ORDER BY u.name,u.id',
        [p.workspaceId],
      ),
    ]);
    const recipients: Row[] = [];
    if (hasCapability(p, "reports:manage"))
      for (const agent of agents) {
        try {
          await this.actor(
            await resolveStaffPrincipal(this.db, p.workspaceId, agent.id),
          );
          recipients.push(agent);
        } catch (error) {
          if (!(error instanceof HttpError)) throw error;
        }
      }
    return {
      dashboards,
      organizations,
      teams,
      agents,
      recipients,
      metrics: REPORT_METRICS.map((m) => ({
        ...m,
        dimensions: m.dimensions.filter(
          (d) => d !== "organization" || hasCapability(p, "customers:read"),
        ),
      })),
      permissions: {
        shared: hasCapability(p, "reports:manage"),
        schedule: hasCapability(p, "reports:manage"),
        export: hasCapability(p, "reports:export"),
      },
      userId: p.userId,
      limits: {
        widgets: 24,
        groups: 100,
        days: 366,
        exportRows: 50000,
        exportHours: 24,
      },
    };
  }
  async getDashboard(p: Principal, id: string) {
    p = await this.actor(p);
    return this.dashboard(p, id);
  }
  async saveDashboard(p: Principal, raw: unknown, id?: string) {
    const d = DashboardInput.parse(raw);
    return this.db.tx(async (q) => {
      p = await this.actor(p, q);
      if (d.visibility === "workspace") requireCapability(p, "reports:manage");
      for (const w of d.definition.widgets) {
        this.validateQuery(p, widgetQuery(w, d.definition.filters));
        if (w.type === "stacked_bar" && !w.stackBy)
          throw new HttpError(400, "Choose a series for a stacked bar chart");
        const metric = REPORT_METRICS.find((m) => m.id === w.metric)!;
        if (
          ["donut", "stacked_bar"].includes(w.type) &&
          ["percent", "milliseconds"].includes(metric.unit)
        )
          throw new HttpError(
            400,
            "Use a line, bar or table for rates and response times; these measures cannot be stacked or added as donut segments",
          );
      }
      // Serialized saves use one revision; a stale browser never overwrites a newer layout.
      if (id) {
        const before = await this.dashboard(p, id, q, true);
        if (d.visibility === "personal" && before.created_by !== p.userId)
          throw new HttpError(
            403,
            "Only the dashboard's creator may make it personal; duplicate it for your own copy",
          );
        if (before.revision !== d.revision)
          throw new HttpError(
            409,
            "This dashboard changed. Reload it before saving your edits.",
          );
        if (
          before.visibility !== d.visibility &&
          before.visibility === "workspace"
        )
          await q.query(
            "UPDATE report_schedules SET enabled=false,last_error='Dashboard is now personal' WHERE workspace_id=$1 AND dashboard_id=$2",
            [p.workspaceId, id],
          );
        const saved = await this.db.one(
          "UPDATE report_dashboards SET name=$3,description=$4,visibility=$5,definition=$6,revision=revision+1,updated_at=$7 WHERE workspace_id=$1 AND id=$2 AND revision=$8 RETURNING *",
          [
            p.workspaceId,
            id,
            d.name,
            d.description,
            d.visibility,
            d.definition,
            this.now(),
            d.revision,
          ],
          q,
        );
        if (!saved)
          throw new HttpError(
            409,
            "This dashboard changed. Reload it before saving your edits.",
          );
        await this.db.event(q, p.workspaceId, "report.dashboard_saved", {
          dashboardId: id,
          actor: p.userId,
          revision: saved.revision,
        });
        return saved;
      }
      const saved = requireValue(
        await this.db.one(
          "INSERT INTO report_dashboards(id,workspace_id,name,description,visibility,definition,created_by) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *",
          [
            uid(),
            p.workspaceId,
            d.name,
            d.description,
            d.visibility,
            d.definition,
            p.userId,
          ],
          q,
        ),
      );
      await this.db.event(q, p.workspaceId, "report.dashboard_created", {
        dashboardId: saved.id,
        actor: p.userId,
      });
      return saved;
    });
  }
  async duplicateDashboard(p: Principal, id: string) {
    p = await this.actor(p);
    const row = await this.dashboard(p, id);
    return this.saveDashboard(p, {
      name: `${row.name.slice(0, 112)} (copy)`,
      description: row.description,
      visibility: "personal",
      definition: row.definition,
    });
  }
  async deleteDashboard(p: Principal, id: string, revision: number) {
    return this.db.tx(async (q) => {
      p = await this.actor(p, q);
      await this.dashboard(p, id, q, true);
      const r = await q.query(
        "DELETE FROM report_dashboards WHERE workspace_id=$1 AND id=$2 AND revision=$3",
        [p.workspaceId, id, revision],
      );
      if (!r.rowCount)
        throw new HttpError(
          409,
          "This dashboard changed. Reload before deleting it.",
        );
      await this.db.event(q, p.workspaceId, "report.dashboard_deleted", {
        dashboardId: id,
        actor: p.userId,
      });
      return { deleted: true };
    });
  }
  async query(p: Principal, raw: unknown) {
    p = await this.actor(p);
    const query = this.validateQuery(p, raw);
    return this.db.tx(async (q) => {
      await q.query("SET LOCAL statement_timeout='15s'");
      const result = await queryReport(
        this.db,
        p.workspaceId,
        query,
        this.now(),
        q,
      );
      this.validateQuery(await this.actor(p, q), query);
      return result;
    });
  }
  async queries(p: Principal, raw: unknown) {
    const d = z
      .object({
        queries: z
          .array(
            z
              .object({ id: z.string().min(1).max(200), query: ReportQuery })
              .strict(),
          )
          .max(24),
      })
      .strict()
      .parse(raw);
    p = await this.actor(p);
    const cache = new Map<string, any>(),
      results: Record<string, any> = {};
    // Request-local only: there is no shared result cache across principals or tenants.
    for (const item of d.queries) {
      const query = this.validateQuery(p, item.query),
        key = digest(query);
      if (!cache.has(key)) cache.set(key, await this.query(p, query));
      results[item.id] = cache.get(key);
    }
    return { results };
  }
  async drilldown(p: Principal, raw: unknown) {
    p = await this.actor(p);
    const d = ReportDrilldown.parse(raw),
      query = this.validateQuery(p, d.query);
    return this.db.tx(async (q) => {
      await q.query("SET LOCAL statement_timeout='15s'");
      const result = await drillReport(
        this.db,
        p.workspaceId,
        query,
        d.selection,
        d.offset,
        d.limit,
        this.now(),
        q,
      );
      p = await this.actor(p, q);
      this.validateQuery(p, query);
      if (!hasCapability(p, "customers:read"))
        for (const row of result.rows) delete row.organization;
      return result;
    });
  }
  private async createJob(
    p: Principal,
    kind: string,
    snapshot: Row,
    key: string,
    q: Queryable,
    extra: Row = {},
  ) {
    const hash = digest({ kind, snapshot, ...extra }),
      old = await this.db.one(
        "SELECT * FROM report_jobs WHERE workspace_id=$1 AND created_by=$2 AND request_key=$3",
        [p.workspaceId, p.userId, key],
        q,
      );
    if (old) {
      if (old.payload_hash !== hash)
        throw new HttpError(
          409,
          "Request key already belongs to a different report",
        );
      return old;
    }
    const job = requireValue(
      await this.db.one(
        "INSERT INTO report_jobs(id,workspace_id,created_by,kind,request_key,payload_hash,snapshot,dashboard_id,schedule_id,schedule_creator,due_at,expires_at,mail_status,required_capabilities) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *",
        [
          uid(),
          p.workspaceId,
          p.userId,
          kind,
          key,
          hash,
          snapshot,
          extra.dashboardId ?? null,
          extra.scheduleId ?? null,
          extra.creator ?? null,
          extra.dueAt ?? null,
          new Date(this.now().getTime() + 86400000),
          kind === "dashboard" ? "queued" : "disabled",
          JSON.stringify(
            kind === "csv" && hasCapability(p, "customers:read")
              ? ["customers:read"]
              : [],
          ),
        ],
        q,
      ),
    );
    await this.db.enqueue(q as any, "reporting", {
      workspaceId: p.workspaceId,
      jobId: job.id,
    });
    return job;
  }
  async export(p: Principal, raw: unknown) {
    const d = ExportInput.parse(raw);
    return this.db.tx(async (q) => {
      p = await this.actor(p, q);
      requireCapability(p, "reports:export");
      this.validateQuery(p, d.query);
      await q.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        `report-export:${p.workspaceId}:${p.userId}:${d.requestKey}`,
      ]);
      const job = await this.createJob(p, "csv", d, d.requestKey, q);
      await this.db.event(q, p.workspaceId, "report.export_requested", {
        jobId: job.id,
        actor: p.userId,
        rowLimit: d.rowLimit,
      });
      return { id: job.id, status: job.status, expires_at: job.expires_at };
    });
  }
  async jobs(p: Principal) {
    p = await this.actor(p);
    return this.db.rows(
      `SELECT ${jobColumns} FROM report_jobs WHERE workspace_id=$1 AND created_by=$2 ORDER BY created_at DESC,id DESC LIMIT 100`,
      [p.workspaceId, p.userId],
    );
  }
  private async jobActor(job: Row, q: Queryable = this.db.pool) {
    const p = await this.actor(
      await resolveStaffPrincipal(this.db, job.workspace_id, job.created_by, q),
      q,
    );
    for (const cap of job.required_capabilities ?? [])
      if (!hasCapability(p, cap))
        throw new HttpError(
          403,
          `This report contains data you can no longer access (${cap})`,
        );
    if (job.kind === "csv") {
      requireCapability(p, "reports:export");
      this.validateQuery(p, ExportInput.parse(job.snapshot).query);
    } else
      for (const widget of DashboardDefinition.parse(job.snapshot.definition)
        .widgets)
        this.validateQuery(
          p,
          widgetQuery(widget, job.snapshot.definition.filters),
        );
    if (job.dashboard_id) await this.dashboard(p, job.dashboard_id, q);
    if (job.schedule_creator) {
      const creator = await this.actor(
        await resolveStaffPrincipal(
          this.db,
          job.workspace_id,
          job.schedule_creator,
          q,
        ),
        q,
      );
      requireCapability(creator, "reports:manage");
      await this.dashboard(creator, job.dashboard_id, q);
    }
    return p;
  }
  async job(p: Principal, id: string, artifact = false) {
    p = await this.actor(p);
    const row = requireValue(
      await this.db.one(
        "SELECT * FROM report_jobs WHERE workspace_id=$1 AND id=$2 AND created_by=$3",
        [p.workspaceId, id, p.userId],
      ),
    );
    await this.jobActor(row);
    if (new Date(row.expires_at) <= this.now())
      throw new HttpError(410, "This report expired. Run a new report.");
    const safe = Object.fromEntries(
      jobColumns.split(",").map((k) => [k, row[k]]),
    );
    if (!artifact) return safe;
    if (row.status !== "completed" || !row.artifact_ciphertext)
      throw new HttpError(409, row.error || "This report is not ready to open");
    return {
      ...safe,
      artifact: unseal<Row>(
        this.db.config.FIELDKIT_ENCRYPTION_KEY,
        `report:${p.workspaceId}:${id}`,
        row.artifact_ciphertext,
      ),
    };
  }
  async schedules(p: Principal) {
    p = await this.actor(p);
    requireCapability(p, "reports:manage");
    return this.db.rows(
      "SELECT s.*,d.name dashboard_name FROM report_schedules s JOIN report_dashboards d ON d.id=s.dashboard_id WHERE s.workspace_id=$1 ORDER BY s.created_at DESC",
      [p.workspaceId],
    );
  }
  async saveSchedule(p: Principal, raw: unknown, id?: string) {
    const d = ScheduleInput.parse(raw);
    return this.db.tx(async (q) => {
      p = await this.actor(p, q);
      requireCapability(p, "reports:manage");
      const dash = await this.dashboard(p, d.dashboardId, q);
      if (dash.visibility !== "workspace")
        throw new HttpError(
          400,
          "Share this dashboard with the workspace before scheduling it",
        );
      for (const recipient of d.definition.recipientIds) {
        const rp = await this.actor(
          await resolveStaffPrincipal(this.db, p.workspaceId, recipient, q),
          q,
        );
        for (const widget of DashboardDefinition.parse(dash.definition).widgets)
          this.validateQuery(rp, widgetQuery(widget, dash.definition.filters));
      }
      const next = nextReportAt(d.definition, this.now());
      const row = id
        ? await this.db.one(
            "UPDATE report_schedules SET dashboard_id=$3,enabled=$4,definition=$5,revision=revision+1,next_run_at=$6,last_error=NULL,updated_at=$7,created_by=$8 WHERE workspace_id=$1 AND id=$2 AND revision=$9 RETURNING *",
            [
              p.workspaceId,
              id,
              d.dashboardId,
              d.enabled,
              d.definition,
              next,
              this.now(),
              p.userId,
              d.revision,
            ],
            q,
          )
        : await this.db.one(
            "INSERT INTO report_schedules(id,workspace_id,dashboard_id,created_by,enabled,definition,next_run_at) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *",
            [
              uid(),
              p.workspaceId,
              d.dashboardId,
              p.userId,
              d.enabled,
              d.definition,
              next,
            ],
            q,
          );
      if (!row)
        throw new HttpError(
          409,
          "This schedule changed. Reload it before saving.",
        );
      await this.db.event(q, p.workspaceId, "report.schedule_saved", {
        scheduleId: row.id,
        actor: p.userId,
        enabled: d.enabled,
      });
      return row;
    });
  }
  async deleteSchedule(p: Principal, id: string, revision: number) {
    return this.db.tx(async (q) => {
      p = await this.actor(p, q);
      requireCapability(p, "reports:manage");
      const r = await q.query(
        "DELETE FROM report_schedules WHERE workspace_id=$1 AND id=$2 AND revision=$3",
        [p.workspaceId, id, revision],
      );
      if (!r.rowCount)
        throw new HttpError(409, "This schedule changed. Reload it first.");
      await this.db.event(q, p.workspaceId, "report.schedule_deleted", {
        scheduleId: id,
        actor: p.userId,
      });
      return { deleted: true };
    });
  }
  async advance(ws: string, id: string) {
    try {
      await this.db.tx(async (q) => {
        const lock = await this.db.one(
          "SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) locked",
          [`report-job:${ws}:${id}`],
          q,
        );
        if (!lock?.locked) return;
        // Deletion takes the exclusive lock before invalidating artifacts. A
        // worker either finishes first and is invalidated, or reads after it.
        await q.query(
          "SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))",
          [`report-source:${ws}`],
        );
        const job = await this.db.one(
          "SELECT * FROM report_jobs WHERE workspace_id=$1 AND id=$2 FOR UPDATE",
          [ws, id],
          q,
        );
        if (!job || !["queued", "running"].includes(job.status)) return;
        if (new Date(job.expires_at) <= this.now()) {
          await q.query(
            "UPDATE report_jobs SET status='expired',artifact_ciphertext=NULL WHERE id=$1",
            [id],
          );
          return;
        }
        let p = await this.jobActor(job, q);
        await q.query("SET LOCAL statement_timeout='15s'");
        await q.query(
          "UPDATE report_jobs SET status='running',lease_until=$2 WHERE id=$1",
          [id, new Date(this.now().getTime() + 300000)],
        );
        const at = this.now();
        let artifact: Row,
          rowCount = 0,
          truncated = false;
        if (job.kind === "csv") {
          const d = ExportInput.parse(job.snapshot),
            query = this.validateQuery(p, d.query);
          let rows: Row[], columns: string[];
          if (d.mode === "summary") {
            const result = await queryReport(this.db, ws, query, at, q);
            rows = result.groups.slice(0, d.rowLimit);
            rowCount = rows.length;
            truncated =
              result.truncatedGroups || result.groups.length > d.rowLimit;
            columns = [
              "label",
              "series",
              "value",
              "numerator",
              "denominator",
              "records",
              "eligible",
              "unknown",
            ];
          } else {
            const result = await drillReport(
              this.db,
              ws,
              query,
              d.selection,
              0,
              d.rowLimit,
              at,
              q,
            );
            rows = result.rows;
            rowCount = rows.length;
            truncated = result.hasMore;
            columns = [
              "record_id",
              "ticket_id",
              "subject",
              "status",
              "priority",
              "channel",
              ...(hasCapability(p, "customers:read") ? ["organization"] : []),
              "team",
              "agent",
              "occurred_at",
              "numerator",
              "denominator",
              "unknown",
            ];
          }
          artifact = {
            csv: reportCSV(rows, columns),
            filename: `${query.metric}-${at.toISOString().slice(0, 10)}.csv`,
            definition: REPORT_METRICS.find((m) => m.id === query.metric),
            window: reportWindow(query.filters, at),
            asOf: at.toISOString(),
            rowLimit: d.rowLimit,
          };
        } else {
          const definition = DashboardDefinition.parse(job.snapshot.definition),
            cache = new Map<string, any>(),
            results: Row = {};
          for (const widget of definition.widgets) {
            const query = this.validateQuery(
                p,
                widgetQuery(widget, definition.filters),
              ),
              key = digest(query);
            if (!cache.has(key))
              cache.set(key, await queryReport(this.db, ws, query, at, q));
            results[widget.id] = cache.get(key);
          }
          artifact = {
            name: job.snapshot.name,
            definition,
            results,
            asOf: at.toISOString(),
          };
          rowCount = definition.widgets.length;
        }
        p = await this.jobActor(job, q);
        await q.query(
          "UPDATE report_jobs SET status='completed',artifact_ciphertext=$3,row_count=$4,truncated=$5,completed_at=$6,lease_until=NULL,error=NULL WHERE workspace_id=$1 AND id=$2",
          [
            ws,
            id,
            seal(
              this.db.config.FIELDKIT_ENCRYPTION_KEY,
              `report:${ws}:${id}`,
              artifact,
            ),
            rowCount,
            truncated,
            this.now(),
          ],
        );
        await this.db.event(q, ws, "report.completed", {
          jobId: id,
          actor: p.userId,
          rowCount,
          truncated,
        });
      });
    } catch (error) {
      const e = error as Error;
      await this.db.pool.query(
        "UPDATE report_jobs SET status=$3,error=$4,artifact_ciphertext=NULL,lease_until=NULL WHERE workspace_id=$1 AND id=$2 AND status IN ('queued','running')",
        [
          ws,
          id,
          error instanceof HttpError && error.status === 403
            ? "revoked"
            : "failed",
          e.message.slice(0, 500),
        ],
      );
    }
    await this.deliverReady(ws, id);
  }
  private async deliverReady(ws: string, id: string) {
    let mail: Row | null = null;
    try {
      mail = await this.db.tx(async (q) => {
        const row = await this.db.one(
          "SELECT * FROM report_jobs WHERE workspace_id=$1 AND id=$2 FOR UPDATE",
          [ws, id],
          q,
        );
        if (
          !row ||
          row.kind !== "dashboard" ||
          row.status !== "completed" ||
          row.mail_status !== "queued" ||
          new Date(row.expires_at) <= this.now()
        )
          return null;
        await this.jobActor(row, q);
        const recipient = requireValue(
          await this.db.one(
            'SELECT email FROM "user" WHERE id=$1',
            [row.created_by],
            q,
          ),
        );
        await q.query(
          "UPDATE report_jobs SET mail_status='sending' WHERE id=$1",
          [id],
        );
        return { email: recipient.email };
      });
      if (!mail) return;
      await this.send(
        mail.email,
        "Your support report is ready",
        `A scheduled report is ready. Sign in with your staff account to view it. Access is checked when you open the report, and the report expires after 24 hours.\n\n${this.db.config.FIELDKIT_URL}/?workspace=${encodeURIComponent(ws)}&view=dashboards&report=${encodeURIComponent(id)}`,
        {
          messageId: `<report-${id}@${new URL(this.db.config.FIELDKIT_URL).hostname}>`,
        },
      );
      await this.db.pool.query(
        "UPDATE report_jobs SET mail_status='sent',mail_error=NULL WHERE id=$1 AND mail_status='sending'",
        [id],
      );
    } catch (error) {
      await this.db.pool.query(
        "UPDATE report_jobs SET mail_status=$3,mail_error=$4 WHERE workspace_id=$1 AND id=$2 AND mail_status IN ('queued','sending')",
        [
          ws,
          id,
          mail ? "unknown" : "failed",
          (error as Error).message.slice(0, 500),
        ],
      );
    }
  }
  async tick() {
    await this.db.tx(async (q) => {
      const due = await this.db.rows(
        "SELECT * FROM report_schedules WHERE enabled AND next_run_at<=$1 ORDER BY next_run_at,id FOR UPDATE SKIP LOCKED LIMIT 25",
        [this.now()],
        q,
      );
      for (const schedule of due) {
        let definition: z.infer<typeof ScheduleDefinition>;
        try {
          definition = ScheduleDefinition.parse(schedule.definition);
          const creator = await this.actor(
            await resolveStaffPrincipal(
              this.db,
              schedule.workspace_id,
              schedule.created_by,
              q,
            ),
            q,
          );
          requireCapability(creator, "reports:manage");
          const dashboard = await this.dashboard(
            creator,
            schedule.dashboard_id,
            q,
          );
          if (dashboard.visibility !== "workspace")
            throw new HttpError(403, "Dashboard is no longer shared");
          const dueAt = new Date(schedule.next_run_at).toISOString();
          await q.query(
            "INSERT INTO report_schedule_runs(workspace_id,schedule_id,due_at) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
            [schedule.workspace_id, schedule.id, dueAt],
          );
          const rejected: string[] = [];
          for (const recipientId of definition.recipientIds) {
            try {
              const recipient = await this.actor(
                await resolveStaffPrincipal(
                  this.db,
                  schedule.workspace_id,
                  recipientId,
                  q,
                ),
                q,
              );
              await this.dashboard(recipient, dashboard.id, q);
              for (const w of DashboardDefinition.parse(dashboard.definition)
                .widgets)
                this.validateQuery(
                  recipient,
                  widgetQuery(w, dashboard.definition.filters),
                );
              await this.createJob(
                recipient,
                "dashboard",
                {
                  name: dashboard.name,
                  definition: dashboard.definition,
                  revision: dashboard.revision,
                },
                `schedule:${schedule.id}:${dueAt}`,
                q,
                {
                  dashboardId: dashboard.id,
                  scheduleId: schedule.id,
                  creator: schedule.created_by,
                  dueAt,
                },
              );
            } catch (error) {
              if (
                error instanceof HttpError &&
                (error.status === 403 || error.status === 404)
              ) {
                rejected.push(recipientId);
              } else throw error;
            }
          }
          await q.query(
            "UPDATE report_schedule_runs SET status=$4,error=$5 WHERE workspace_id=$1 AND schedule_id=$2 AND due_at=$3",
            [
              schedule.workspace_id,
              schedule.id,
              dueAt,
              rejected.length ? "partial" : "queued",
              rejected.length
                ? `${rejected.length} recipient(s) no longer have report access`
                : null,
            ],
          );
          await q.query(
            "UPDATE report_schedules SET next_run_at=$2,last_run_at=$3,last_error=$4 WHERE id=$1",
            [
              schedule.id,
              nextReportAt(definition, this.now()),
              this.now(),
              rejected.length
                ? `${rejected.length} recipient(s) skipped because their access changed`
                : null,
            ],
          );
        } catch (error) {
          await q.query(
            "UPDATE report_schedules SET enabled=false,last_error=$2,updated_at=$3 WHERE id=$1",
            [schedule.id, (error as Error).message.slice(0, 500), this.now()],
          );
        }
      }
    });
    const pending = await this.db.rows(
      "SELECT id,workspace_id FROM report_jobs WHERE expires_at>$1 AND (status='queued' OR (status='running' AND lease_until<$1) OR (status='completed' AND mail_status='queued')) ORDER BY created_at LIMIT 100",
      [this.now()],
    );
    for (const job of pending)
      await this.db.tx((q) =>
        this.db.enqueue(q, "reporting", {
          workspaceId: job.workspace_id,
          jobId: job.id,
        }),
      );
    await this.db.pool.query(
      "UPDATE report_jobs SET mail_status='unknown',mail_error='Delivery was interrupted. Check the mail provider; this notification will not resend automatically.' WHERE mail_status='sending' AND completed_at<$1",
      [new Date(this.now().getTime() - 300000)],
    );
    await this.db.pool.query(
      "UPDATE report_jobs SET status='expired',artifact_ciphertext=NULL WHERE expires_at<=$1 AND status<>'expired'",
      [this.now()],
    );
  }
  async forgetConversation(ws: string, _id: string, q: Queryable) {
    await q.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      `report-source:${ws}`,
    ]);
    // Aggregates can include a ticket without identifying it in the artifact.
    // Revoke workspace artifacts conservatively; definitions and schedules stay.
    const result = await q.query(
      "UPDATE report_jobs SET status='revoked',artifact_ciphertext=NULL,lease_until=NULL,error='Source data was removed. Run a new report.',mail_status=CASE WHEN mail_status='queued' THEN 'disabled' ELSE mail_status END WHERE workspace_id=$1 AND status IN ('queued','running','completed')",
      [ws],
    );
    return { revoked: result.rowCount ?? 0 };
  }
  async retain(ws: string, days = 30) {
    await this.db.pool.query(
      "UPDATE report_jobs SET status='expired',artifact_ciphertext=NULL WHERE workspace_id=$1 AND expires_at<=$2 AND status<>'expired'",
      [ws, this.now()],
    );
    await this.db.pool.query(
      "DELETE FROM report_jobs WHERE workspace_id=$1 AND created_at<$2",
      [ws, new Date(this.now().getTime() - Math.max(1, days) * 86400000)],
    );
    await this.db.pool.query(
      "DELETE FROM report_schedule_runs WHERE workspace_id=$1 AND created_at<$2",
      [ws, new Date(this.now().getTime() - Math.max(1, days) * 86400000)],
    );
  }
}
