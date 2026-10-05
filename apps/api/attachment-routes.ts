import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import type { Platform } from "../../packages/platform/src/platform.js";
import type { Principal } from "../../packages/platform/src/auth.js";
export async function attachmentRoutes(
  app: Platform,
  p: Principal,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  path: string,
  body: (req: IncomingMessage) => Promise<unknown>,
  json: (res: ServerResponse, result: unknown) => void,
) {
  const method = req.method ?? "GET",
    a = app.attachments;
  let match: RegExpMatchArray | null, result: unknown;
  if (path === "/attachments/settings" && method === "GET")
    result = await a.settings(p);
  else if (path === "/attachments/settings" && method === "PUT")
    result = await a.settings(p, await body(req));
  else if (path === "/attachments" && method === "POST")
    result = await a.reserve(p, await body(req));
  else if ((match = path.match(/^\/attachments\/([^/]+)$/)) && method === "GET")
    result = await a.get(p, match[1]);
  else if (
    (match = path.match(/^\/attachments\/([^/]+)$/)) &&
    method === "PATCH"
  )
    result = await a.control(
      p,
      match[1],
      z
        .object({ action: z.enum(["retry", "cancel", "delete"]) })
        .strict()
        .parse(await body(req)).action,
    );
  else if (
    (match = path.match(/^\/attachments\/([^/]+)\/content$/)) &&
    method === "PUT"
  )
    result = await a.upload(p, match[1], req);
  else if (
    (match = path.match(/^\/attachments\/([^/]+)\/content$/)) &&
    method === "GET"
  ) {
    const file = await a.download(
      p,
      match[1],
      url.searchParams.get("preview") === "true",
    );
    res.writeHead(200, {
      "Content-Type": file.mime,
      "Content-Length": file.bytes.length,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "sandbox; default-src 'none'",
      "Content-Disposition": `${file.inline ? "inline" : "attachment"}; filename="attachment"; filename*=UTF-8''${encodeURIComponent(file.name).replaceAll("'", "%27")}`,
    });
    res.end(file.bytes);
    return true;
  } else return false;
  json(res, result);
  return true;
}
