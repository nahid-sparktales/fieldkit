import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createServer,
  request,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { EventEmitter } from "node:events";
import { gzipSync, brotliCompressSync } from "node:zlib";
import { serveStatic, contentPolicy } from "../apps/api/static.js";
import { EventStreams } from "../apps/api/event-stream.js";

// Raw HTTP preserves malformed paths and encoded bytes (fetch normalizes/decompresses).
export function rawRequest(
  port: number,
  path: string,
  headers = {},
  method = "GET",
) {
  return new Promise<{
    status: number;
    headers: import("node:http").IncomingHttpHeaders;
    bytes: Buffer;
  }>((resolve, reject) => {
    const req = request(
      { host: "127.0.0.1", port, path, method, headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (b) => chunks.push(b));
        res.on("end", () =>
          resolve({
            status: res.statusCode!,
            headers: res.headers,
            bytes: Buffer.concat(chunks),
          }),
        );
      },
    );
    req.on("error", reject);
    req.end();
  });
}

test("static assets negotiate compression, cache safely, support HEAD and reject missing/private paths", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "navigated-static-"));
  const script = Buffer.from("console.log('synthetic');".repeat(100));
  await mkdir(join(root, "assets"));
  await writeFile(
    join(root, "index.html"),
    "<!doctype html><title>Navigated Support</title>",
  );
  await writeFile(join(root, "assets/app-12345678.js"), script);
  await writeFile(join(root, "assets/app-12345678.js.gz"), gzipSync(script));
  await writeFile(
    join(root, "assets/app-12345678.js.br"),
    brotliCompressSync(script),
  );
  await writeFile(join(root, ".env"), "not public");
  const server = createServer(async (req, res) => {
    try {
      await serveStatic(req, res, req.url!, root);
    } catch (e) {
      if (!res.headersSent) res.statusCode = (e as any).status ?? 500;
      res.end();
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    await rm(root, { recursive: true });
  });
  const port = (server.address() as AddressInfo).port;
  const plain = await rawRequest(port, "/assets/app-12345678.js");
  assert.deepEqual(plain.bytes, script);
  assert.match(plain.headers["cache-control"]!, /immutable/);
  const br = await rawRequest(port, "/assets/app-12345678.js", {
    "Accept-Encoding": "gzip, br",
  });
  assert.equal(br.headers["content-encoding"], "br");
  assert.deepEqual(br.bytes, brotliCompressSync(script));
  assert.notEqual(br.headers.etag, plain.headers.etag);
  const gz = await rawRequest(port, "/assets/app-12345678.js", {
    "Accept-Encoding": "br;q=0,gzip;q=0.5",
  });
  assert.equal(gz.headers["content-encoding"], "gzip");
  assert.deepEqual(gz.bytes, gzipSync(script));
  assert.equal(
    (await rawRequest(port, "/", { "Accept-Encoding": "identity;q=0,*;q=0" }))
      .status,
    406,
  );
  const cached = await rawRequest(port, "/assets/app-12345678.js", {
    "Accept-Encoding": "br",
    "If-None-Match": br.headers.etag,
  });
  assert.equal(cached.status, 304);
  assert.equal(cached.bytes.length, 0);
  assert.equal(cached.headers.vary, "Accept-Encoding");
  const head = await rawRequest(port, "/assets/app-12345678.js", {}, "HEAD");
  assert.equal(head.headers["content-length"], String(script.length));
  assert.equal(head.bytes.length, 0);
  const html = await rawRequest(port, "/support/test");
  assert.equal(html.status, 200);
  assert.equal(html.headers["cache-control"], "no-cache");
  for (const path of [
    "/.env",
    "/%2e%2e/.env",
    "/assets/missing.js",
    "/brand/missing.svg",
    "/assets/app-12345678.js.gz",
    "/%00",
    "/%5c.env",
  ])
    assert.equal((await rawRequest(port, path)).status, 404, path);
  assert.equal((await rawRequest(port, "/%ZZ")).status, 400);
  assert.equal((await rawRequest(port, "/", {}, "POST")).status, 405);
});

test("production CSP disallows scripts and framing except configured Picker and widget origins", () => {
  const normal = contentPolicy();
  assert.match(normal, /script-src 'self';/);
  assert.match(normal, /object-src 'none'/);
  assert.ok(!normal.includes("unsafe-eval") && !normal.includes("google"));
  const widget = contentPolicy(["https://shop.example"], false, true);
  assert.match(widget, /frame-ancestors 'self' https:\/\/shop.example;/);
  assert.match(widget, /https:\/\/apis.google.com/);
});

class Output extends EventEmitter {
  frames: string[] = [];
  destroyed = false;
  writableNeedDrain = false;
  stopAfterNextEvent = false;
  headers: Record<string, any> = {};
  writeHead(_status: number, headers: any) {
    this.headers = headers;
  }
  setHeader(name: string, value: any) {
    this.headers[name] = value;
  }
  write(frame: string) {
    this.frames.push(frame);
    if (this.stopAfterNextEvent && frame.includes('"kind":"test"'))
      this.writableNeedDrain = true;
    return !this.writableNeedDrain;
  }
  end() {
    this.destroyed = true;
    this.emit("close");
  }
  destroy() {
    this.end();
  }
  get response() {
    return this as unknown as ServerResponse;
  }
}
const incoming = (headers = {}) => ({ headers }) as IncomingMessage;
const waitFor = async (condition: () => boolean) => {
  for (let n = 0; n < 100 && !condition(); n++)
    await new Promise((r) => setTimeout(r, 10));
  assert.ok(condition(), "stream made progress");
};

test("SSE starts at the current cursor, resumes without replay, bounds connections and releases capacity", async (t) => {
  const streams = new EventStreams({
    perActor: 1,
    total: 2,
    pollMs: 10,
    lifetimeMs: 10000,
  });
  const outputs = [new Output(), new Output(), new Output(), new Output()];
  t.after(() => outputs.forEach((o) => o.end()));
  const reads: number[] = [];
  const source = {
    authorize: async () => {},
    latest: async () => 55,
    read: async (after: number) => {
      reads.push(after);
      return [];
    },
  };
  await streams.open(
    incoming(),
    outputs[0].response,
    new URL("http://test/events"),
    "a",
    source,
  );
  assert.match(outputs[0].frames[0], /id: 55\ndata: .*stream.connected/);
  await waitFor(() => reads.length > 0);
  assert.equal(reads[0], 55);
  await assert.rejects(
    () =>
      streams.open(
        incoming(),
        outputs[1].response,
        new URL("http://test/events"),
        "a",
        source,
      ),
    /Too many/,
  );
  await streams.open(
    incoming({ "last-event-id": "17" }),
    outputs[1].response,
    new URL("http://test/events"),
    "b",
    source,
  );
  await waitFor(() => reads.includes(17));
  await assert.rejects(
    () =>
      streams.open(
        incoming(),
        outputs[2].response,
        new URL("http://test/events"),
        "c",
        source,
      ),
    /Too many/,
  );
  outputs[0].end();
  await streams.open(
    incoming({ "last-event-id": "17" }),
    outputs[2].response,
    new URL("http://test/events?after=0"),
    "a",
    source,
  );
  await waitFor(() => reads.includes(0));
  await assert.rejects(
    () =>
      streams.open(
        incoming({ "last-event-id": "bogus" }),
        outputs[3].response,
        new URL("http://test/events"),
        "d",
        source,
      ),
    /Invalid event cursor/,
  );
});

test("SSE honors backpressure, continues from the last written event, and stops on revoked access", async (t) => {
  const streams = new EventStreams({
    perActor: 1,
    total: 2,
    pollMs: 10,
    lifetimeMs: 10000,
  });
  const output = new Output();
  t.after(() => output.end());
  let authorized = true,
    reads = 0;
  await streams.open(
    incoming(),
    output.response,
    new URL("http://test/events?after=0"),
    "a",
    {
      authorize: async () => {
        if (!authorized) throw new Error("Revoked");
      },
      latest: async () => 0,
      read: async (after) => {
        reads++;
        return [1, 2]
          .filter((id) => id > after)
          .map((id) => ({ id, kind: "test", data: {} }));
      },
    },
  );
  output.stopAfterNextEvent = true;
  await waitFor(() => output.writableNeedDrain);
  const count = reads;
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(reads, count);
  assert.ok(!output.frames.some((f) => f.startsWith("id: 2")));
  output.stopAfterNextEvent = false;
  output.writableNeedDrain = false;
  await waitFor(() => output.frames.some((f) => f.startsWith("id: 2")));
  assert.equal(output.frames.filter((f) => f.startsWith("id: 1")).length, 1);
  authorized = false;
  await waitFor(() => output.destroyed);
  const stopped = reads;
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(reads, stopped);
});

test("filtered SSE advances past unrelated events without skipping data under backpressure", async (t) => {
  const streams = new EventStreams({
    perActor: 1,
    total: 1,
    pollMs: 10,
    lifetimeMs: 10000,
  });
  const output = new Output();
  t.after(() => output.end());
  const cursors: number[] = [];
  await streams.open(
    incoming(),
    output.response,
    new URL("http://test/events?after=0"),
    "staff",
    {
      authorize: async () => {},
      latest: async () => 0,
      read: async (after) => {
        cursors.push(after);
        return after === 0
          ? { events: [], cursor: 100 }
          : {
              events: [
                { id: 101, kind: "test", data: {} },
                { id: 105, kind: "test", data: {} },
              ].filter((e) => e.id > after),
              cursor: 110,
            };
      },
    },
  );
  output.stopAfterNextEvent = true;
  await waitFor(() => output.writableNeedDrain);
  assert.ok(cursors.includes(100));
  assert.ok(!output.frames.some((f) => f.startsWith("id: 110")));
  output.stopAfterNextEvent = false;
  output.writableNeedDrain = false;
  await waitFor(() => cursors.includes(110));
  assert.ok(cursors.includes(101));
  assert.equal(output.frames.filter((f) => f.startsWith("id: 105")).length, 1);
});
