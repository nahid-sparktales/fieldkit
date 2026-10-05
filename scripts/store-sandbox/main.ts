import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createApp } from "../../apps/api/server.js";
import { sandboxConfig, ensureDatabase, storeOrigin } from "./config.js";
import { StoreModel } from "./model.js";
import { storeProviders } from "./providers.js";
import { seedStore } from "./seed.js";
import { sandboxScanner, seedOperationalScenarios } from "./operations.js";
import { launcher } from "./launcher.js";

if (
  process.argv
    .slice(2)
    .some((arg) => !["--reset", "--operations"].includes(arg))
)
  throw new Error("Usage: npm run sandbox [-- --reset] [-- --operations]");
const { config, password } = await sandboxConfig();
let clockOffset = 0;
if (process.argv.includes("--operations"))
  config.FIELDKIT_CLAM_HOST = "offline-sandbox-double";
// Check both listener ports before provisioning or resetting anything.
for (const port of [4320, 4321]) {
  const probe = createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(port, "127.0.0.1", resolve);
  });
  await new Promise<void>((resolve, reject) =>
    probe.close((e) => (e ? reject(e) : resolve())),
  );
}
await ensureDatabase(config.DATABASE_URL);
const mailDirectory = join(config.FIELDKIT_DATA, "mail");
await mkdir(mailDirectory, { recursive: true, mode: 0o700 });
// Use the real app with explicitly injected, local-only collaborators. Production has no simulation flag.
let app: Awaited<ReturnType<typeof createApp>> | undefined;
try {
  if (process.argv.includes("--reset")) {
    const { Pool } = await import("pg");
    const pool = new Pool({ connectionString: config.DATABASE_URL });
    try {
      await pool.query(
        "DROP SCHEMA IF EXISTS jobs CASCADE; DROP SCHEMA IF EXISTS checkpoints CASCADE; DROP SCHEMA public CASCADE; CREATE SCHEMA public;",
      );
    } finally {
      await pool.end();
    }
    const { rm } = await import("node:fs/promises");
    for (const folder of ["mail", "uploads"])
      await rm(join(config.FIELDKIT_DATA, folder), {
        recursive: true,
        force: true,
      });
    await mkdir(mailDirectory, { recursive: true, mode: 0o700 });
  }
  app = await createApp(config, {
    migrate: true,
    scanner: sandboxScanner,
    clock: () => new Date(Date.now() + clockOffset),
    model: new StoreModel(),
    fetch: async (url, init) => {
      if (!app) throw new Error("Sandbox is still starting");
      return storeProviders(app.app.db)(url, init);
    },
    mailer: async (to, subject, text, options) => {
      await writeFile(
        join(mailDirectory, `${Date.now()}-${randomUUID()}.json`),
        JSON.stringify({ to, subject, text, options }),
        { mode: 0o600 },
      );
    },
    runner: async () => {
      throw new Error(
        "Code execution is disabled in the offline store sandbox.",
      );
    },
  });
  const ws = await seedStore(app.app, password, storeOrigin);
  if (
    !(await app.app.db.one(
      "SELECT id FROM connections WHERE workspace_id=$1 AND provider='ticket_email'",
      [ws],
    ))
  ) {
    await app.app.ticketEmail.configure(
      { workspaceId: ws, role: "owner" },
      { address: "support@inbound.example.test" },
    );
  }
  if (process.argv.includes("--operations"))
    await seedOperationalScenarios(app.app, ws, (ms) => {
      clockOffset += ms;
    });
  await app.app.workers();
  const home = launcher(app.app, ws, password, storeOrigin);
  const application = app;
  // Only this explicit sandbox entry point adds the notice; the shared app is untouched.
  application.server.prependListener("request", (_req, res) => {
    const end = res.end.bind(res);
    res.end = ((chunk: any, ...args: any[]) => {
      if (
        String(res.getHeader("Content-Type")).includes("text/html") &&
        (typeof chunk === "string" || Buffer.isBuffer(chunk))
      ) {
        chunk = chunk
          .toString()
          .replace(
            "<body>",
            '<body><div style="position:sticky;top:0;z-index:10000;background:#205c45;color:white;padding:8px 16px;text-align:center;font:13px system-ui">LOCAL STORE SANDBOX · Scripted replies and simulated payments · <a href="http://127.0.0.1:4321/" style="color:white">Guide &amp; logins</a></div>',
          );
        res.removeHeader("Content-Length");
      }
      return (end as Function)(chunk, ...args);
    }) as typeof res.end;
  });
  await new Promise<void>((resolve, reject) => {
    application.server.once("error", reject);
    application.server.listen(4320, "127.0.0.1", resolve);
  });
  await new Promise<void>((resolve, reject) => {
    home.once("error", reject);
    home.listen(4321, "127.0.0.1", resolve);
  });
  console.log(
    `\nStore sandbox ready: ${storeOrigin}/\nStaff app: ${config.FIELDKIT_URL}/?workspace=${ws}&view=inbox\nCustomer portal: ${config.FIELDKIT_URL}/support/trail-supply\nLogin details are on the local launch page. No paid model or real payment calls.\nCtrl+C stops both servers. Restarting preserves your edits.\n`,
  );
  let closing = false;
  for (const signal of ["SIGINT", "SIGTERM"])
    process.on(signal, async () => {
      if (closing) return;
      closing = true;
      home.closeAllConnections();
      home.close();
      await application.close();
      process.exit(0);
    });
} catch (e) {
  await app?.close();
  throw e;
}
