import type { IncomingMessage, ServerResponse } from "node:http";
import type { Platform } from "../../packages/platform/src/platform.js";
import type { Principal } from "../../packages/platform/src/auth.js";
import { z } from "zod";
export async function reportingRoutes(
  app: Platform,
  p: Principal,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  path: string,
  body: (r: IncomingMessage) => Promise<any>,
  json: (r: ServerResponse, v: unknown) => void,
) {
  const method = req.method ?? "GET",
    service = app.reporting;
  let m: RegExpMatchArray | null, result: unknown;
  if (path === "/reports/catalog" && method === "GET")
    result = await service.catalog(p);
  else if (path === "/reports/query" && method === "POST")
    result = await service.query(p, await body(req));
  else if (path === "/reports/queries" && method === "POST")
    result = await service.queries(p, await body(req));
  else if (path === "/reports/drilldown" && method === "POST")
    result = await service.drilldown(p, await body(req));
  else if (path === "/dashboards" && method === "POST")
    result = await service.saveDashboard(p, await body(req));
  else if (
    (m = path.match(/^\/dashboards\/([^/]+)\/duplicate$/)) &&
    method === "POST"
  )
    result = await service.duplicateDashboard(p, m[1]);
  else if ((m = path.match(/^\/dashboards\/([^/]+)$/)) && method === "GET")
    result = await service.getDashboard(p, m[1]);
  else if ((m = path.match(/^\/dashboards\/([^/]+)$/)) && method === "PUT")
    result = await service.saveDashboard(p, await body(req), m[1]);
  else if ((m = path.match(/^\/dashboards\/([^/]+)$/)) && method === "DELETE")
    result = await service.deleteDashboard(
      p,
      m[1],
      z.coerce
        .number()
        .int()
        .positive()
        .parse(url.searchParams.get("revision")),
    );
  else if (path === "/reports/exports" && method === "POST")
    result = await service.export(p, await body(req));
  else if (path === "/reports/jobs" && method === "GET")
    result = await service.jobs(p);
  else if (
    (m = path.match(/^\/reports\/jobs\/([^/]+)\/download$/)) &&
    method === "GET"
  ) {
    const job = await service.job(p, m[1], true);
    if (job.kind !== "csv") {
      json(res, job);
      return true;
    }
    res.writeHead(200, {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${job.artifact.filename}"`,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    res.end(job.artifact.csv);
    return true;
  } else if ((m = path.match(/^\/reports\/jobs\/([^/]+)$/)) && method === "GET")
    result = await service.job(
      p,
      m[1],
      url.searchParams.get("artifact") === "true",
    );
  else if (path === "/reports/schedules" && method === "GET")
    result = await service.schedules(p);
  else if (path === "/reports/schedules" && method === "POST")
    result = await service.saveSchedule(p, await body(req));
  else if (
    (m = path.match(/^\/reports\/schedules\/([^/]+)$/)) &&
    method === "PUT"
  )
    result = await service.saveSchedule(p, await body(req), m[1]);
  else if (
    (m = path.match(/^\/reports\/schedules\/([^/]+)$/)) &&
    method === "DELETE"
  )
    result = await service.deleteSchedule(
      p,
      m[1],
      z.coerce
        .number()
        .int()
        .positive()
        .parse(url.searchParams.get("revision")),
    );
  else return false;
  res.setHeader("Cache-Control", "no-store");
  json(res, result);
  return true;
}
