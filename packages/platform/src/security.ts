import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { Agent, request } from "undici";
import { HttpError } from "./config.js";

export function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object")
    return (
      "{" +
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => JSON.stringify(k) + ":" + canonical(v))
        .join(",") +
      "}"
    );
  return JSON.stringify(value) ?? "null";
}
export const digest = (v: unknown) =>
  createHash("sha256").update(canonical(v)).digest("hex");
export const token = () => randomBytes(32).toString("base64url");
export const tokenHash = (v: string) =>
  createHash("sha256").update(v).digest("hex");
export function equal(a: string, b: string) {
  const aa = Buffer.from(a),
    bb = Buffer.from(b);
  return aa.length === bb.length && timingSafeEqual(aa, bb);
}
export function seal(key: string, scope: string, value: unknown): string {
  const iv = randomBytes(12),
    cipher = createCipheriv("aes-256-gcm", Buffer.from(key, "base64"), iv);
  cipher.setAAD(Buffer.from(scope));
  return Buffer.concat([
    iv,
    cipher.update(JSON.stringify(value)),
    cipher.final(),
    cipher.getAuthTag(),
  ]).toString("base64");
}
export function unseal<T>(key: string, scope: string, value: string): T {
  const b = Buffer.from(value, "base64"),
    decipher = createDecipheriv(
      "aes-256-gcm",
      Buffer.from(key, "base64"),
      b.subarray(0, 12),
    );
  decipher.setAAD(Buffer.from(scope));
  decipher.setAuthTag(b.subarray(-16));
  return JSON.parse(
    Buffer.concat([
      decipher.update(b.subarray(12, -16)),
      decipher.final(),
    ]).toString(),
  );
}
export function verifySignature(
  secret: string,
  payload: string,
  signature: string,
  encoding: "hex" | "base64" = "hex",
) {
  return equal(
    createHmac("sha256", secret).update(payload).digest(encoding),
    signature,
  );
}
const blocked = new BlockList();
for (const [ip, bits] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const)
  blocked.addSubnet(ip, bits, "ipv4");
const globalV6 = new BlockList();
globalV6.addSubnet("2000::", 3, "ipv6");
const reservedV6 = new BlockList();
for (const [ip, bits] of [
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["3fff::", 20],
] as const)
  reservedV6.addSubnet(ip, bits, "ipv6");
export function publicAddress(address: string) {
  if (isIP(address) === 4) return !blocked.check(address, "ipv4");
  return (
    isIP(address) === 6 &&
    globalV6.check(address, "ipv6") &&
    !reservedV6.check(address, "ipv6")
  );
}
export function externalURL(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new HttpError(400, "Invalid URL");
  }
  if (
    u.protocol !== "https:" ||
    u.username ||
    u.password ||
    (u.port && u.port !== "443") ||
    u.hash ||
    u.hostname === "localhost"
  )
    throw new HttpError(
      400,
      "Use a public HTTPS URL without credentials or a fragment",
    );
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host) && !publicAddress(host))
    throw new HttpError(400, "Private network destinations are blocked");
  return u;
}
const dispatcher = new Agent({
  connect: {
    lookup: ((
      hostname: string,
      options: { all?: boolean },
      callback: Function,
    ) => {
      lookup(hostname, { all: true, verbatim: true })
        .then((addresses) => {
          if (
            !addresses.length ||
            addresses.some((a) => !publicAddress(a.address))
          )
            return callback(
              new Error("Private network destinations are blocked"),
            );
          if (options.all) callback(null, addresses);
          else callback(null, addresses[0].address, addresses[0].family);
        })
        .catch((e) => callback(e));
    }) as never,
  },
});
export type Fetcher = (
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    limit?: number;
  },
) => Promise<Response>;
export const safeFetch: Fetcher = async (raw, init = {}) => {
  const url = externalURL(raw);
  return boundedFetch(url, init, true);
};
// Only operator-configured model bases may reach private HTTP services. Ingestion
// and business actions continue to use safeFetch and cannot opt into this path.
export function modelBaseURL(raw: string, trustedBases: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new HttpError(400, "Enter a valid model API base URL");
  }
  if (
    !["https:", "http:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new HttpError(
      400,
      "Model base URLs cannot contain credentials, a query, or a fragment",
    );
  const base = url.href.replace(/\/+$/, "");
  if (
    !trustedBases
      .split(",")
      .map((s) => s.trim().replace(/\/+$/, ""))
      .includes(base)
  )
    externalURL(base);
  return base;
}
export const modelFetch = async (
  base: string,
  path: string,
  init: Parameters<Fetcher>[1],
  trustedBases: string,
) => {
  const normalized = modelBaseURL(base, trustedBases);
  if (
    !/^\/(models(?:\/[^/?#]+)?|key|chat\/completions|messages|embeddings)$/.test(
      path,
    )
  )
    throw new HttpError(400, "Unsupported model API route");
  const trusted = trustedBases
    .split(",")
    .map((s) => s.trim().replace(/\/+$/, ""))
    .includes(normalized);
  return boundedFetch(new URL(normalized + path), init ?? {}, !trusted);
};
async function boundedFetch(
  url: URL,
  init: NonNullable<Parameters<Fetcher>[1]>,
  publicOnly: boolean,
) {
  const response = await request(url, {
    ...(publicOnly ? { dispatcher } : {}),
    method: (init.method ?? "GET") as "GET",
    headers: init.headers,
    body: init.body,
    headersTimeout: 30000,
    bodyTimeout: 30000,
    signal: AbortSignal.timeout(45000),
  });
  let length = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of response.body) {
    const b = Buffer.from(chunk);
    length += b.length;
    if (length > (init.limit ?? 20 * 1024 * 1024)) {
      response.body.destroy();
      throw new HttpError(413, "Remote content exceeds the size limit");
    }
    chunks.push(b);
  }
  const headers = new Headers();
  for (const [k, v] of Object.entries(response.headers))
    if (v) headers.set(k, Array.isArray(v) ? v.join(", ") : v);
  return new Response(
    response.statusCode === 204 ? null : Buffer.concat(chunks),
    { status: response.statusCode, headers },
  );
}
