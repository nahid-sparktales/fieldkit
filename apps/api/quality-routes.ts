import type { IncomingMessage, ServerResponse } from "node:http";
import type { Platform } from "../../packages/platform/src/platform.js";
import {
  principal,
  requireStaff,
  type Principal,
} from "../../packages/platform/src/auth.js";
import { z } from "zod";
export async function qualityRoutes(
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
    q = app.quality;
  let m: RegExpMatchArray | null, result: unknown;
  if (
    [
      "/quality/events",
      "/readiness/events",
      "/sla/events",
      "/shadow/events",
    ].includes(path) &&
    method === "GET"
  ) {
    requireStaff(p);
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    let after = Number(url.searchParams.get("after") ?? 0),
      busy = false;
    if (!Number.isSafeInteger(after) || after < 0) after = 0;
    res.write(": connected\n\n");
    const timer = setInterval(async () => {
      if (busy) return;
      busy = true;
      try {
        requireStaff(await principal(app.db, app.auth, req, p.workspaceId));
        const events = await app.db.rows(
          "SELECT id,kind,data FROM events WHERE workspace_id=$1 AND id>$2 AND (($3='readiness' AND kind LIKE 'readiness.%') OR ($3='sla' AND kind LIKE 'sla.%') OR ($3='shadow' AND (kind LIKE 'shadow.%' OR kind LIKE 'rollout.%')) OR ($3='quality' AND (kind LIKE 'quality.%' OR kind LIKE 'gap.%'))) ORDER BY id LIMIT 100",
          [p.workspaceId, after, path.split("/")[1]],
        );
        for (const e of events) {
          after = Number(e.id);
          res.write(`id: ${e.id}\ndata: ${JSON.stringify(e)}\n\n`);
        }
        if (!events.length) res.write(": heartbeat\n\n");
      } catch {
        res.end();
      } finally {
        busy = false;
      }
    }, 1000);
    const expiry = setTimeout(() => res.end(), 300000);
    res.on("close", () => {
      clearInterval(timer);
      clearTimeout(expiry);
    });
    return true;
  }
  if (path === "/evaluation/suites" && method === "GET")
    result = await q.suites(p);
  else if (path === "/evaluation/suites" && method === "POST")
    result = await q.saveSuite(p, await body(req));
  else if (
    (m = path.match(/^\/evaluation\/suites\/([^/]+)$/)) &&
    method === "PUT"
  )
    result = await q.saveSuite(p, await body(req), m[1]);
  else if (path === "/evaluation/runs" && method === "POST")
    result = await q.startEvaluation(p, await body(req));
  else if (path === "/evaluation/runs" && method === "GET")
    result = await q.jobs(p, "evaluation");
  else if ((m = path.match(/^\/quality\/jobs\/([^/]+)$/)) && method === "GET")
    result = await q.job(p, m[1]);
  else if ((m = path.match(/^\/quality\/jobs\/([^/]+)$/)) && method === "PATCH")
    result = await q.control(p, m[1], await body(req));
  else if (
    (m = path.match(
      /^\/evaluation\/runs\/([^/]+)\/results\/([^/]+)\/reviews$/,
    )) &&
    method === "POST"
  )
    result = await q.review(p, m[1], m[2], await body(req));
  else if (path === "/knowledge/gaps" && method === "GET")
    result = await q.gaps(p);
  else if ((m = path.match(/^\/knowledge\/gaps\/([^/]+)$/)) && method === "GET")
    result = await q.gap(p, m[1]);
  else if (
    (m = path.match(/^\/knowledge\/gaps\/([^/]+)$/)) &&
    method === "PATCH"
  )
    result = await q.updateGap(p, m[1], await body(req));
  else if (
    (m = path.match(/^\/knowledge\/gaps\/([^/]+)\/merge$/)) &&
    method === "POST"
  )
    result = await q.merge(
      p,
      m[1],
      z
        .object({ targetId: z.string().min(1) })
        .strict()
        .parse(await body(req)).targetId,
    );
  else if (
    (m = path.match(/^\/knowledge\/gaps\/([^/]+)\/draft$/)) &&
    method === "POST"
  )
    result = await q.draft(p, m[1]);
  else if (
    (m = path.match(/^\/knowledge\/gaps\/([^/]+)\/case$/)) &&
    method === "GET"
  )
    result = await q.gapCase(p, m[1]);
  else if (path === "/knowledge/analysis" && method === "POST")
    result = await q.startAnalysis(p, await body(req));
  else if (path === "/knowledge/analysis" && method === "GET")
    result = await q.jobs(p, "analysis");
  else if (path === "/knowledge/gap-scan" && method === "POST")
    result = await q.historicalScan(p, await body(req));
  else if (path === "/quality/settings" && method === "GET")
    result = await q.settings(p);
  else if (path === "/quality/settings" && method === "PUT")
    result = await q.settings(p, await body(req));
  else if (path === "/analytics" && method === "GET")
    result = await q.analytics(p, Object.fromEntries(url.searchParams));
  else if (
    (m = path.match(/^\/conversations\/([^/]+)\/test-case$/)) &&
    method === "GET"
  )
    result = await q.importCase(p, m[1]);
  else if (
    (m = path.match(/^\/conversations\/([^/]+)\/gap$/)) &&
    method === "POST"
  )
    result = await q.flag(p, m[1]);
  else if (
    (m = path.match(/^\/conversations\/([^/]+)\/feedback$/)) &&
    method === "GET"
  )
    result = await q.feedback(p, m[1]);
  else if (
    (m = path.match(/^\/conversations\/([^/]+)\/feedback$/)) &&
    method === "PUT"
  )
    result = await q.feedback(p, m[1], await body(req));
  else return false;
  json(res, result ?? { ok: true });
  return true;
}
