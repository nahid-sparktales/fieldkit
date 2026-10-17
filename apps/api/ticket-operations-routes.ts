import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import type { Platform } from "../../packages/platform/src/platform.js";
import type { Principal } from "../../packages/platform/src/auth.js";
export async function ticketOperationsRoutes(
  app: Platform,
  p: Principal,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  path: string,
  body: (req: IncomingMessage) => Promise<unknown>,
  json: (res: ServerResponse, value: unknown) => void,
) {
  const method = req.method ?? "GET",
    s = app.ticketOperations;
  let m: RegExpMatchArray | null, result: unknown;
  if (path === "/ticket-batches" && method === "POST")
    result = await s.bulk(p, await body(req));
  else if ((m = path.match(/^\/ticket-batches\/([^/]+)$/)) && method === "GET")
    result = await s.batch(p, m[1]);
  else if (
    (m = path.match(/^\/conversations\/([^/]+)\/merge-candidates$/)) &&
    method === "GET"
  )
    result = {
      tickets: await s.candidates(p, m[1], url.searchParams.get("q") ?? ""),
    };
  else if (
    (m = path.match(/^\/conversations\/([^/]+)\/merge-preview$/)) &&
    method === "POST"
  )
    result = await s.preview(
      p,
      m[1],
      z
        .object({ targetId: z.string().min(1).max(200) })
        .strict()
        .parse(await body(req)).targetId,
    );
  else if (
    (m = path.match(/^\/conversations\/([^/]+)\/merge$/)) &&
    method === "POST"
  )
    result = await s.merge(p, m[1], await body(req));
  else if (
    (m = path.match(/^\/conversations\/([^/]+)\/presence$/)) &&
    (method === "GET" || method === "PUT")
  )
    result = await s.presence(
      p,
      m[1],
      method === "PUT" ? await body(req) : undefined,
    );
  else return false;
  json(res, result);
  return true;
}
