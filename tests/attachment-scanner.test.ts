import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import {
  ClamScanner,
  ScannerHealthError,
} from "../packages/platform/src/attachment-scanner.js";
import { testConfig } from "./helpers.js";

test("ClamAV streaming protocol validates exact clean verdict, current signatures and fragmented replies", async () => {
  let mode = "clean",
    observed = Buffer.alloc(0);
  const now = Date.parse("2026-10-04T12:00:00Z");
  const server = createServer((socket) => {
    let input = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      input = Buffer.concat([input, chunk]);
      const end = input.indexOf(0);
      if (end < 0) return;
      const command = input.subarray(0, end).toString();
      if (command === "zVERSIONCOMMANDS") {
        const stamp =
          mode === "stale"
            ? "Thu Oct 01 10:00:00 2026"
            : "Sun Oct 04 10:00:00 2026";
        socket.write(`ClamAV 1.5.4/123/${stamp}| COM`);
        socket.end("MANDS: PING VERSIONCOMMANDS INSTREAM\0");
        return;
      }
      assert.equal(command, "zINSTREAM");
      let position = end + 1;
      const chunks: Buffer[] = [];
      while (position + 4 <= input.length) {
        const n = input.readUInt32BE(position);
        position += 4;
        if (!n) {
          observed = Buffer.concat(chunks);
          socket.end(
            mode === "infected"
              ? "stream: Eicar-Signature FOUND\0"
              : mode === "error"
                ? "stream: size limit exceeded ERROR\0"
                : mode === "ambiguous"
                  ? "stream: OK\0stream: Access denied ERROR\0"
                  : "stream: OK\0",
          );
          return;
        }
        if (position + n > input.length) return;
        chunks.push(input.subarray(position, position + n));
        position += n;
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const c = testConfig();
  c.FIELDKIT_CLAM_HOST = "127.0.0.1";
  c.FIELDKIT_CLAM_PORT = (server.address() as AddressInfo).port;
  const scanner = new ClamScanner(c, () => now);
  try {
    const bytes = Buffer.alloc(160000, 65);
    assert.equal((await scanner.scan(bytes)).clean, true);
    assert.deepEqual(observed, bytes);
    mode = "infected";
    assert.equal(
      (await scanner.scan(Buffer.from("EICAR fixture"))).clean,
      false,
    );
    for (const value of ["error", "ambiguous"]) {
      mode = value;
      await assert.rejects(
        () => scanner.scan(Buffer.from("test")),
        /indeterminate/,
      );
    }
    mode = "stale";
    await assert.rejects(() => scanner.health(), /too old/);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((e) => (e ? reject(e) : resolve())),
    );
  }
});

test("ClamAV freshness diagnostics distinguish invalid, future and stale timestamps without streaming files", async () => {
  const now = Date.parse("2026-10-04T12:00:00Z");
  let reply = "",
    streams = 0;
  const server = createServer((socket) => {
    socket.once("data", (data) => {
      if (data.toString() === "zVERSIONCOMMANDS\0") socket.end(`${reply}\0`);
      else {
        streams++;
        socket.end("stream: OK\0");
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const c = testConfig();
  c.FIELDKIT_CLAM_HOST = "127.0.0.1";
  c.FIELDKIT_CLAM_PORT = (server.address() as AddressInfo).port;
  const scanner = new ClamScanner(c, () => now);
  const version = (stamp: string) =>
    `ClamAV 1.5.4/28143/${stamp}| COMMANDS: PING VERSIONCOMMANDS INSTREAM`;
  try {
    // Exactly 48 hours and up to five minutes of future clock skew remain allowed.
    for (const stamp of [
      "Fri Oct  2 12:00:00 2026",
      "Sun Oct  4 12:05:00 2026",
      "Sun Oct  4 13:00:00 2026 +0100",
    ]) {
      reply = version(stamp);
      const health = await scanner.health();
      assert.ok(health.signaturesAt.endsWith("Z"));
    }
    for (const [stamp, reason, ageHours] of [
      ["unparseable", "invalid_timestamp", null],
      ["Fri Oct  2 11:59:59 2026", "stale", 48 + 1 / 3600],
      ["Sun Oct  4 12:05:01 2026", "future_timestamp", -301 / 3600],
    ] as const) {
      reply = version(stamp);
      await assert.rejects(
        () => scanner.scan(Buffer.from("never sent")),
        (e: unknown) => {
          assert.ok(e instanceof ScannerHealthError);
          assert.equal(e.status, 503);
          assert.equal(e.diagnostics.reason, reason);
          assert.equal(e.diagnostics.versionReply, reply);
          assert.equal(e.diagnostics.checkedAt, new Date(now).toISOString());
          assert.equal(e.diagnostics.maxAgeHours, 48);
          assert.equal(e.diagnostics.ageHours, ageHours);
          assert.equal(
            e.diagnostics.signaturesAt === null,
            reason === "invalid_timestamp",
          );
          return true;
        },
      );
    }
    reply = "ClamAV 1.5.4/28143/Sun Oct  4 12:00:00 2026| COMMANDS: PING";
    await assert.rejects(
      () => scanner.health(),
      (e: unknown) => {
        assert.ok(e instanceof ScannerHealthError);
        assert.equal(e.diagnostics.reason, "protocol");
        return true;
      },
    );
    assert.equal(streams, 0);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((e) => (e ? reject(e) : resolve())),
    );
  }
});
