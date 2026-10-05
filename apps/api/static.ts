import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { HttpError } from "../../packages/platform/src/config.js";

const mime: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

export function contentPolicy(
  origins: string[] = [],
  dev = false,
  picker = false,
) {
  const framing = `frame-ancestors 'self' ${origins.join(" ")}; object-src 'none'; base-uri 'none'; form-action 'self'`;
  // Vite injects its refresh script and uses a WebSocket during development.
  if (dev) return framing;
  return `${framing}; default-src 'self'; script-src 'self'${picker ? " https://apis.google.com https://accounts.google.com" : ""}; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:${picker ? " https://*.googleusercontent.com" : ""}; connect-src 'self'${picker ? " https://*.googleapis.com" : ""}; frame-src 'self'${picker ? " https://docs.google.com https://drive.google.com https://accounts.google.com" : ""}; font-src 'self'${picker ? " https://fonts.gstatic.com" : ""}`;
}

export async function serveStatic(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  root = resolve("dist/web"),
) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.setHeader("Allow", "GET, HEAD");
    throw new HttpError(405, "Method not allowed");
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    throw new HttpError(400, "Invalid request path");
  }
  if (
    decoded.includes("\0") ||
    decoded.includes("\\") ||
    decoded.split("/").some((part) => part.startsWith("."))
  )
    throw new HttpError(404, "Not found");
  let file = resolve(root, "." + decoded);
  if (file !== root && !file.startsWith(root + sep))
    throw new HttpError(404, "Not found");
  let info = await stat(file).catch(() => null);
  if (!info?.isFile()) {
    // Only application routes may fall back to the SPA, never missing assets.
    if (
      extname(decoded) ||
      decoded.startsWith("/assets/") ||
      decoded.startsWith("/brand/")
    )
      throw new HttpError(404, "Not found");
    file = resolve(root, "index.html");
    info = await stat(file);
  }
  const extension = extname(file);
  if (!mime[extension]) throw new HttpError(404, "Not found");
  const accepted = new Map(
    (req.headers["accept-encoding"] ?? "").split(",").map((v) => {
      const [name, ...params] = v.trim().split(";");
      const q = params.find((p) => p.trim().startsWith("q="));
      const weight = q ? Number(q.trim().slice(2)) : 1;
      return [
        name.toLowerCase(),
        Number.isFinite(weight) && weight >= 0 && weight <= 1 ? weight : 0,
      ];
    }),
  );
  const weight = (name: string) => accepted.get(name) ?? accepted.get("*") ?? 0;
  let encoding = "identity";
  for (const name of ["br", "gzip"].sort((a, b) => weight(b) - weight(a))) {
    if (!weight(name) || weight(name) < (accepted.get("identity") ?? 0))
      continue;
    const compressed = file + (name === "br" ? ".br" : ".gz");
    const compressedInfo = await stat(compressed).catch(() => null);
    if (!compressedInfo?.isFile()) continue;
    file = compressed;
    info = compressedInfo;
    encoding = name;
    break;
  }
  if (
    encoding === "identity" &&
    (accepted.get("identity") ?? accepted.get("*") ?? 1) === 0
  )
    throw new HttpError(406, "No acceptable content encoding");
  const etag = `W/"${info.size.toString(16)}-${info.mtimeMs.toString(16)}-${encoding}"`;
  res.setHeader("Content-Type", mime[extension]);
  res.setHeader(
    "Vary",
    [res.getHeader("Vary"), "Accept-Encoding"].filter(Boolean).join(", "),
  );
  res.setHeader(
    "Cache-Control",
    /\/assets\/[^/]+-[\w-]{8,}\.[\w]+$/.test(file.replace(/\.(br|gz)$/, ""))
      ? "public, max-age=31536000, immutable"
      : "no-cache",
  );
  res.setHeader("ETag", etag);
  if (encoding !== "identity") res.setHeader("Content-Encoding", encoding);
  if (
    (req.headers["if-none-match"] ?? "")
      .split(",")
      .some(
        (tag) =>
          tag.trim() === "*" ||
          tag.trim().replace(/^W\//, "") === etag.replace(/^W\//, ""),
      )
  ) {
    res.writeHead(304);
    res.end();
    return;
  }
  res.setHeader("Content-Length", info.size);
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  await pipeline(createReadStream(file), res);
}
