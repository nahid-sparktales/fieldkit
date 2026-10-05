import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import { ClamScanner } from "../packages/platform/src/attachment-scanner.js";
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
