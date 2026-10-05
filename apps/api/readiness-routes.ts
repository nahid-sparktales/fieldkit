import type { IncomingMessage, ServerResponse } from "node:http";
import type { Platform } from "../../packages/platform/src/platform.js";
import type { Principal } from "../../packages/platform/src/auth.js";

export async function readinessRoutes(
  app: Platform,
  p: Principal,
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  body: (req: IncomingMessage) => Promise<unknown>,
  json: (res: ServerResponse, result: unknown) => void,
) {
  const r = app.readiness,
    method = req.method ?? "GET";
  let match: RegExpMatchArray | null, result: unknown;
  if (path === "/readiness/summary" && method === "GET")
    result = await r.summary(p);
  else if (path === "/readiness" && method === "GET")
    result = await r.dashboard(p);
  else if (path === "/readiness/runs" && method === "POST")
    result = await r.start(p, await body(req));
  else if (path === "/readiness/settings" && method === "PUT")
    result = await r.settings(p, await body(req));
  else if (
    (match = path.match(/^\/readiness\/runs\/([^/]+)$/)) &&
    method === "PATCH"
  )
    result = await r.control(p, match[1], await body(req));
  else if (
    (match = path.match(/^\/readiness\/checks\/([^/]+)$/)) &&
    method === "GET"
  )
    result = await r.history(p, decodeURIComponent(match[1]));
  else if (
    (match = path.match(/^\/readiness\/checks\/([^/]+)\/attestations$/)) &&
    method === "POST"
  )
    result = await r.attest(p, decodeURIComponent(match[1]), await body(req));
  else return false;
  json(res, result);
  return true;
}
