import type { IncomingMessage, ServerResponse } from "node:http";
import type { Platform } from "../../packages/platform/src/platform.js";
import type { Principal } from "../../packages/platform/src/auth.js";
export async function automationRoutes(
  app: Platform,
  p: Principal,
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  body: (req: IncomingMessage) => Promise<unknown>,
  json: (res: ServerResponse, result: unknown) => void,
) {
  const method = req.method ?? "GET",
    s = app.automation;
  let m: RegExpMatchArray | null, result: unknown;
  if (path === "/automations" && method === "GET") result = await s.list(p);
  else if (path === "/automations" && method === "POST")
    result = await s.save(p, await body(req));
  else if (path === "/automations/preview" && method === "POST")
    result = await s.preview(p, await body(req));
  else if (path === "/automations/history" && method === "GET")
    result = await s.history(p);
  else if (path === "/automations/notifications" && method === "GET")
    result = await s.notifications(p);
  else if (
    (m = path.match(/^\/automations\/notifications\/([^/]+)\/read$/)) &&
    method === "POST"
  )
    result = await s.readNotification(p, m[1]);
  else if (
    (m = path.match(/^\/automations\/([^/]+)\/activation$/)) &&
    method === "PUT"
  )
    result = await s.activate(p, m[1], await body(req));
  else if (
    (m = path.match(/^\/automations\/([^/]+)\/history$/)) &&
    method === "GET"
  )
    result = await s.history(p, m[1]);
  else return false;
  json(res, result);
  return true;
}
