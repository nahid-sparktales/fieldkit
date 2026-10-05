import type { IncomingMessage, ServerResponse } from "node:http";
import type { Platform } from "../../packages/platform/src/platform.js";
import type { Principal } from "../../packages/platform/src/auth.js";
import { requireStaff } from "../../packages/platform/src/auth.js";
export async function slaRoutes(
  app: Platform,
  p: Principal,
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  body: (req: IncomingMessage) => Promise<unknown>,
  json: (res: ServerResponse, result: unknown) => void,
) {
  let m: RegExpMatchArray | null, result: unknown;
  const method = req.method ?? "GET",
    s = app.sla;
  if (path === "/sla" && method === "GET") result = await s.dashboard(p);
  else if (path === "/sla/policy" && method === "GET")
    result = await s.settings(p);
  else if (path === "/sla/policy" && method === "PUT")
    result = await s.save(p, await body(req));
  else if (path === "/sla/preview" && method === "POST") {
    requireStaff(p);
    result = s.preview(await body(req));
  } else if (path === "/sla/recalculate" && method === "POST")
    result = await s.recalculate(p, await body(req));
  else if (
    (m = path.match(/^\/sla\/notifications\/([^/]+)\/read$/)) &&
    method === "POST"
  )
    result = await s.read(p, m[1]);
  else if (
    (m = path.match(/^\/conversations\/([^/]+)\/sla$/)) &&
    method === "GET"
  )
    result = await s.conversation(p, m[1]);
  else if (
    (m = path.match(/^\/conversations\/([^/]+)\/waiting$/)) &&
    method === "PUT"
  )
    result = await s.waiting(p, m[1], await body(req));
  else return false;
  json(res, result);
  return true;
}
