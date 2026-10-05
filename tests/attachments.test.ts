import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Platform } from "../packages/platform/src/platform.js";
import type { AttachmentScanner } from "../packages/platform/src/attachment-scanner.js";
import {
  testConfig,
  resetDatabase,
  workspace,
  TestModel,
  TestProviders,
} from "./helpers.js";
import { uid } from "../packages/platform/src/db.js";
const c = testConfig();
c.FIELDKIT_CLAM_HOST = "test-scanner-double";
let scanCount = 0,
  fail = false,
  hold: Promise<void> | undefined;
const scanner: AttachmentScanner = {
  health: async () => {
    if (fail) throw new Error("Scanner unavailable");
    return {
      engine: "TEST DOUBLE - not live ClamAV",
      signaturesAt: new Date().toISOString(),
    };
  },
  scan: async (bytes) => {
    scanCount++;
    await hold;
    return {
      ...(await scanner.health()),
      scannedAt: new Date().toISOString(),
      clean: !bytes.includes(Buffer.from("malware-fixture")),
    };
  },
};
const emails: any[] = [],
  app = new Platform(c, {
    scanner,
    model: new TestModel(),
    fetch: new TestProviders().fetch,
    mailer: async (...args) => {
      emails.push(args);
    },
  });
before(async () => {
  await resetDatabase(c.DATABASE_URL);
  await app.migrate();
});
after(() => app.close());
beforeEach(() => {
  scanCount = 0;
  fail = false;
  hold = undefined;
  c.FIELDKIT_ATTACHMENT_STORAGE_BYTES = 1024 * 1024 * 1024;
});
async function setup() {
  const w = await workspace(app);
  await app.attachments.settings(w.owner, { enabled: true, anonymous: false });
  const conv = await app.newConversation(w.customer, {
    body: "Help with this order",
    requestKey: uid(),
    channelId: w.channelId,
  });
  return { ...w, conv };
}
async function upload(
  w: any,
  bytes = Buffer.from("Customer log message"),
  name = "log.txt",
  p = w.customer,
  privateNote = false,
) {
  const row = await app.attachments.reserve(p, {
    conversationId: w.conv.id,
    name,
    size: bytes.length,
    mime: name.endsWith("png") ? "image/png" : "application/octet-stream",
    private: privateNote,
    requestKey: uid(),
  });
  await app.attachments.upload(
    p,
    row.id,
    (async function* () {
      yield bytes;
    })(),
  );
  return row;
}
test("attachments default off and owners must have a working scanner to enable admission", async () => {
  const w = await workspace(app);
  assert.equal((await app.attachments.settings(w.customer)).enabled, false);
  await assert.rejects(
    () =>
      app.attachments.reserve(w.customer, {
        channelId: w.channelId,
        name: "test.txt",
        size: 2,
        requestKey: uid(),
      }),
    /not enabled/,
  );
  await assert.rejects(
    () =>
      app.attachments.settings(
        { ...w.owner, role: "admin" },
        { enabled: true },
      ),
    /owner/,
  );
  fail = true;
  await assert.rejects(
    () => app.attachments.settings(w.owner, { enabled: true }),
    /Scanner unavailable/,
  );
  assert.equal((await app.attachments.settings(w.owner)).enabled, false);
});
test("quarantine, content sniffing, actual byte limits and safe names", async () => {
  const w = await setup(),
    file = await upload(w);
  await assert.rejects(
    () => app.attachments.download(w.customer, file.id),
    /until scanning/,
  );
  assert.equal(
    (await app.attachments.get(w.customer, file.id)).status,
    "quarantined",
  );
  await app.attachments.scan(w.ws.id, file.id);
  const content = await app.attachments.download(w.customer, file.id);
  assert.equal(content.bytes.toString(), "Customer log message");
  assert.equal(content.mime, "text/plain");
  await assert.rejects(
    () =>
      app.attachments.reserve(w.customer, {
        conversationId: w.conv.id,
        name: "exploit.svg",
        size: 10,
        requestKey: uid(),
      }),
    /PNG/,
  );
  const wrong = await app.attachments.reserve(w.customer, {
    conversationId: w.conv.id,
    name: "../forged.pdf",
    size: 4,
    requestKey: uid(),
  });
  assert.equal(wrong.name, "forged.pdf");
  await assert.rejects(
    () =>
      app.attachments.upload(
        w.customer,
        wrong.id,
        (async function* () {
          yield Buffer.from("oops");
        })(),
      ),
    /type/,
  );
  assert.equal(
    (await app.attachments.get(w.customer, wrong.id)).status,
    "blocked",
  );
  const oversize = await app.attachments.reserve(w.customer, {
    conversationId: w.conv.id,
    name: "big.txt",
    size: 1,
    requestKey: uid(),
  });
  await assert.rejects(
    () =>
      app.attachments.upload(
        w.customer,
        oversize.id,
        (async function* () {
          yield Buffer.from("123");
        })(),
      ),
    /exceeds/,
  );
  assert.equal(
    (await app.attachments.get(w.customer, oversize.id)).status,
    "blocked",
  );
});
test("association enforces uploader, customer, visibility and idempotence", async () => {
  const w = await setup(),
    file = await upload(w),
    other = await workspace(app);
  await assert.rejects(
    () => app.attachments.get(other.customer, file.id),
    /Not found/,
  );
  const stranger = { ...w.customer, contactId: other.contactId };
  await assert.rejects(() => app.attachments.get(stranger, file.id));
  await assert.rejects(
    () =>
      app.message(w.owner, w.conv.id, {
        body: "Cannot steal customer draft upload",
        attachments: [file.id],
        requestKey: uid(),
      }),
    /cannot be associated/,
  );
  const key = uid(),
    msg = await app.message(w.customer, w.conv.id, {
      body: "Here is my log",
      attachments: [file.id],
      requestKey: key,
    });
  assert.equal(
    (
      await app.message(w.customer, w.conv.id, {
        body: "Here is my log",
        attachments: [file.id],
        requestKey: key,
      })
    ).id,
    msg.id,
  );
  await assert.rejects(
    () =>
      app.message(w.customer, w.conv.id, {
        body: "Here is my log",
        requestKey: key,
      }),
    /different attachments/,
  );
  const note = await upload(
    w,
    Buffer.from("Private note file"),
    "note.txt",
    w.owner,
    true,
  );
  await app.message(
    w.owner,
    w.conv.id,
    { body: "Internal only", attachments: [note.id], requestKey: uid() },
    true,
  );
  await app.attachments.scan(w.ws.id, note.id);
  await assert.rejects(
    () => app.attachments.get(w.customer, note.id),
    /not found/,
  );
  assert.equal((await app.attachments.list(w.customer, w.conv.id)).length, 1);
  assert.equal((await app.attachments.list(w.owner, w.conv.id)).length, 2);
  const events = await app.db.rows(
    "SELECT data FROM events WHERE conversation_id=$1 AND public",
    [w.conv.id],
  );
  assert.equal(JSON.stringify(events).includes(note.id), false);
});
test("file-only messages route to staff with no automatic run or implied file reading", async () => {
  const w = await workspace(app);
  await app.attachments.settings(w.owner, { enabled: true });
  const bytes = Buffer.from("File-only initial request");
  const file = await app.attachments.reserve(w.customer, {
    channelId: w.channelId,
    name: "help.log",
    size: bytes.length,
    requestKey: uid(),
  });
  await app.attachments.upload(
    w.customer,
    file.id,
    (async function* () {
      yield bytes;
    })(),
  );
  const conv = await app.newConversation(w.customer, {
    body: "",
    attachments: [file.id],
    channelId: w.channelId,
    requestKey: uid(),
  });
  assert.equal(conv.mode, "human");
  assert.equal(
    await app.db.one("SELECT id FROM runs WHERE conversation_id=$1", [conv.id]),
    undefined,
  );
  assert.equal(
    (await app.attachments.get(w.customer, file.id)).aiEligible,
    false,
  );
  await app.attachments.scan(w.ws.id, file.id);
  assert.equal(
    await app.db.one("SELECT id FROM runs WHERE conversation_id=$1", [conv.id]),
    undefined,
  );
});
test("scan failure is closed, explicit retry works, and simultaneous scans are serialized", async () => {
  const w = await setup(),
    file = await upload(w);
  fail = true;
  await app.attachments.scan(w.ws.id, file.id);
  assert.equal(
    (await app.attachments.get(w.customer, file.id)).status,
    "scan_failed",
  );
  await assert.rejects(() => app.attachments.download(w.customer, file.id));
  fail = false;
  await app.attachments.control(w.customer, file.id, "retry");
  await Promise.all([
    app.attachments.scan(w.ws.id, file.id),
    app.attachments.scan(w.ws.id, file.id),
  ]);
  assert.equal(scanCount, 2);
  assert.equal(
    (await app.attachments.get(w.customer, file.id)).status,
    "available",
  );
  const infected = await upload(w, Buffer.from("malware-fixture"));
  await app.attachments.scan(w.ws.id, infected.id);
  assert.equal(
    (await app.attachments.get(w.customer, infected.id)).status,
    "blocked",
  );
  await assert.rejects(
    () => app.attachments.control(w.customer, infected.id, "retry"),
    /Only failed scans/,
  );
});
test("deletion during scanning is terminal and revoked staff cannot complete pending file processing", async () => {
  const w = await setup(),
    file = await upload(w);
  let release!: () => void;
  hold = new Promise((r) => {
    release = r;
  });
  const pending = app.attachments.scan(w.ws.id, file.id);
  for (let i = 0; i < 100 && !scanCount; i++)
    await new Promise((r) => setTimeout(r, 5));
  assert.equal(scanCount, 1);
  await app.attachments.control(w.customer, file.id, "delete");
  release();
  await pending;
  await assert.rejects(
    () => app.attachments.get(w.customer, file.id),
    /not found/,
  );
  assert.equal(
    (await app.db.one("SELECT status FROM attachments WHERE id=$1", [file.id]))!
      .status,
    "deleted",
  );
  hold = undefined;
  const staffFile = await upload(
    w,
    Buffer.from("Internal upload"),
    "internal.log",
    w.owner,
    true,
  );
  await app.db.pool.query(
    "DELETE FROM memberships WHERE workspace_id=$1 AND user_id=$2",
    [w.ws.id, w.owner.userId],
  );
  await app.attachments.scan(w.ws.id, staffFile.id);
  assert.equal(scanCount, 1);
  assert.equal(
    (await app.db.one("SELECT status FROM attachments WHERE id=$1", [
      staffFile.id,
    ]))!.status,
    "scan_failed",
  );
});
test("storage quota reservations serialize and crashed fsync staging can resume without overwriting", async () => {
  const w = await setup();
  c.FIELDKIT_ATTACHMENT_STORAGE_BYTES = 1024 * 1024;
  const attempts = await Promise.allSettled(
    [1, 2].map(() =>
      app.attachments.reserve(w.customer, {
        conversationId: w.conv.id,
        name: "large.txt",
        size: 700000,
        requestKey: uid(),
      }),
    ),
  );
  assert.equal(attempts.filter((x) => x.status === "fulfilled").length, 1);
  const reserved = (
    attempts.find(
      (x) => x.status === "fulfilled",
    ) as PromiseFulfilledResult<any>
  ).value;
  await app.attachments.control(w.customer, reserved.id, "cancel");
  const bytes = Buffer.from("recoverable staging"),
    row = await app.attachments.reserve(w.customer, {
      conversationId: w.conv.id,
      name: "crash.log",
      size: bytes.length,
      requestKey: uid(),
    });
  const stored = await app.db.one(
    "SELECT storage_key FROM attachments WHERE id=$1",
    [row.id],
  );
  await mkdir(app.attachments.directory, { recursive: true });
  await writeFile(
    join(app.attachments.directory, stored!.storage_key + ".bin"),
    bytes,
    { mode: 0o600 },
  );
  await app.attachments.upload(
    w.customer,
    row.id,
    (async function* () {
      yield bytes;
    })(),
  );
  await app.attachments.scan(w.ws.id, row.id);
  assert.equal(
    (await app.attachments.download(w.customer, row.id)).bytes.toString(),
    bytes.toString(),
  );
});
test("raster previews are bounded and PDF files stay download-only", async () => {
  const w = await setup(),
    png = await upload(
      w,
      await readFile("tests/fixtures/logo.png"),
      "screenshot.png",
    );
  await app.attachments.scan(w.ws.id, png.id);
  await app.message(w.customer, w.conv.id, {
    body: "Screenshot",
    attachments: [png.id],
    requestKey: uid(),
  });
  const preview = await app.attachments.download(w.owner, png.id, true);
  assert.equal(preview.mime, "image/png");
  assert.ok(preview.bytes.length < 2 * 1024 * 1024);
  await assert.rejects(
    () => app.attachments.download(w.customer, png.id, true),
    /staff only/,
  );
  const pdf = await upload(
    w,
    await readFile("tests/fixtures/returns.pdf"),
    "document.pdf",
  );
  await app.attachments.scan(w.ws.id, pdf.id);
  await app.message(w.customer, w.conv.id, {
    body: "PDF",
    attachments: [pdf.id],
    requestKey: uid(),
  });
  await assert.rejects(
    () => app.attachments.download(w.owner, pdf.id, true),
    /download-only/,
  );
});
test("inbound valid text survives bad individual files and retries do not duplicate messages or attachments", async () => {
  const w = await setup(),
    emailSetup = await app.ticketEmail.configure(w.owner, {
      address: "support@inbound.example.test",
    });
  const m = await app.message(w.owner, w.conv.id, {
    body: "Please send a log",
    requestKey: uid(),
  });
  const email = await app.db.one(
    "SELECT id FROM ticket_emails WHERE message_id=$1",
    [m.id],
  );
  await app.ticketEmail.deliver(w.ws.id, email!.id);
  const address = emails.at(-1)[3].replyTo,
    authorization = `Basic ${Buffer.from(`fieldkit:${emailSetup.password}`).toString("base64")}`;
  const data = {
    MessageID: uid(),
    OriginalRecipient: address,
    FromFull: { Email: "customer@example.test" },
    TextBody: "Keep this useful text",
    Attachments: [
      {
        Name: "bad.exe",
        Content: Buffer.from("danger").toString("base64"),
        ContentLength: 6,
        ContentType: "application/octet-stream",
      },
      {
        Name: "good.log",
        Content: Buffer.from("a useful log").toString("base64"),
        ContentLength: 12,
        ContentType: "text/plain",
      },
      { Name: "broken.txt", Content: "%invalid%", ContentLength: 123 },
    ],
  };
  const results = await Promise.all([
    app.ticketEmail.receive(w.ws.id, authorization, data),
    app.ticketEmail.receive(w.ws.id, authorization, data),
  ]);
  assert.equal(
    results.every((x) => x.status === "received"),
    true,
  );
  assert.equal(
    (await app.db.one(
      "SELECT count(*) n FROM messages WHERE conversation_id=$1 AND body=$2",
      [w.conv.id, data.TextBody],
    ))!.n,
    "1",
  );
  const files = await app.attachments.list(w.owner, w.conv.id);
  assert.equal(files.length, 3);
  assert.equal(files.filter((f) => f.status === "blocked").length, 2);
  assert.equal(
    (await app.db.one(
      "SELECT count(*) n FROM ticket_emails WHERE conversation_id=$1",
      [w.conv.id],
    ))!.n,
    "1",
  );
});

test("retention invalidates downloads and removes bytes even while conversation evidence is retained", async () => {
  const w = await setup(),
    row = await upload(w);
  await app.message(w.customer, w.conv.id, {
    body: "Attached log",
    requestKey: uid(),
    attachments: [row.id],
  });
  await app.attachments.scan(w.ws.id, row.id);
  await app.db.pool.query(
    "UPDATE attachments SET created_at=now()-interval '31 days' WHERE id=$1",
    [row.id],
  );
  await app.attachments.retain(w.ws.id, 30);
  assert.equal(
    (await app.db.one("SELECT status FROM attachments WHERE id=$1", [row.id]))!
      .status,
    "deleted",
  );
  assert.ok(
    await app.db.one("SELECT id FROM conversations WHERE id=$1", [w.conv.id]),
  );
  await assert.rejects(() =>
    app.attachments.download(w.customer, row.id, false),
  );
});
