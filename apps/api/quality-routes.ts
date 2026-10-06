import { authorizeWorkspaceRoute } from "./route-permissions.js";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Platform } from "../../packages/platform/src/platform.js";
import {
  principal,
  requireStaff,
  type Principal,
} from "../../packages/platform/src/auth.js";
import type { EventStreams } from "./event-stream.js";
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
  streams: EventStreams,
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
    await streams.open(
      req,
      res,
      url,
      `${p.workspaceId}:${p.userId ?? p.role}`,
      {
        authorize: async () => {
          const current = await principal(app.db, app.auth, req, p.workspaceId);
          requireStaff(current);
          authorizeWorkspaceRoute(current,path,method);
        },
        latest: async () =>
          (await app.db.one(
            "SELECT coalesce(max(id),0) id FROM events WHERE workspace_id=$1",
            [p.workspaceId],
          ))!.id,
        read: async (after) => {
          // Advance across a bounded workspace batch, including unrelated events.
          const rows = await app.db.rows(
            "SELECT id,kind,data FROM events WHERE workspace_id=$1 AND id>$2 ORDER BY id LIMIT 100",
            [p.workspaceId, after],
          );
          const category = path.split("/")[1];
          const prefixes =
            category === "quality"
              ? ["quality.", "gap."]
              : category === "shadow"
                ? ["shadow.", "rollout."]
                : [`${category}.`];
          return {
            cursor: Number(rows.at(-1)?.id ?? after),
            events: rows.filter((event) =>
              prefixes.some((prefix) => event.kind.startsWith(prefix)),
            ),
          };
        },
      },
    );
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
