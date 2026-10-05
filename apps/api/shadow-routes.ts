import type { IncomingMessage, ServerResponse } from "node:http";
import type { Platform } from "../../packages/platform/src/platform.js";
import type { Principal } from "../../packages/platform/src/auth.js";
export async function shadowRoutes(
  app: Platform,
  p: Principal,
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  body: (req: IncomingMessage) => Promise<unknown>,
  json: (res: ServerResponse, result: unknown) => void,
) {
  const s = app.shadow,
    method = req.method ?? "GET";
  let m: RegExpMatchArray | null, result: unknown;
  if (path === "/shadow" && method === "GET") result = await s.dashboard(p);
  else if (path === "/shadow/candidates" && method === "POST")
    result = await s.createCandidate(p, await body(req));
  else if (path === "/shadow/experiments" && method === "POST")
    result = await s.start(p, await body(req));
  else if (
    (m = path.match(/^\/shadow\/experiments\/([^/]+)$/)) &&
    method === "GET"
  )
    result = await s.results(p, m[1]);
  else if (
    (m = path.match(/^\/shadow\/experiments\/([^/]+)$/)) &&
    method === "PATCH"
  )
    result = await s.control(p, m[1], await body(req));
  else if (
    (m = path.match(/^\/shadow\/results\/([^/]+)\/review$/)) &&
    method === "POST"
  )
    result = await s.review(p, m[1], await body(req));
  else if (
    (m = path.match(/^\/shadow\/results\/([^/]+)\/case$/)) &&
    method === "GET"
  )
    result = await s.regression(p, m[1]);
  else if (path === "/rollouts" && method === "POST")
    result = await s.startCanary(p, await body(req));
  else if ((m = path.match(/^\/rollouts\/([^/]+)$/)) && method === "PATCH")
    result = await s.controlCanary(p, m[1], await body(req));
  else return false;
  json(res, result);
  return true;
}
