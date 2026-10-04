import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Pool } from "pg";
import { config } from "../../packages/platform/src/config.js";

export const directory = resolve(".fieldkit/store-sandbox");
export const storeOrigin = "http://127.0.0.1:4321";
export function sandboxDatabase(input: string) {
  const url = new URL(input);
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
    !/^\/fieldkit_store_sandbox(?:_test)?$/.test(url.pathname) ||
    url.search ||
    url.hash
  )
    throw new Error(
      "Sandbox requires a local PostgreSQL database named fieldkit_store_sandbox (or fieldkit_store_sandbox_test for tests), without URL parameters.",
    );
  return url;
}
export async function ensureDatabase(input: string) {
  const url = sandboxDatabase(input),
    name = url.pathname.slice(1);
  const admin = new URL(url);
  admin.pathname = "/postgres";
  const pool = new Pool({ connectionString: admin.href });
  try {
    if (
      !(await pool.query("SELECT 1 FROM pg_database WHERE datname=$1", [name]))
        .rowCount
    )
      await pool.query(`CREATE DATABASE "${name}"`);
  } finally {
    await pool.end();
  }
}
export async function sandboxConfig() {
  const database = new URL(
    process.env.DATABASE_URL ?? "postgresql://localhost:5432/fieldkit",
  );
  database.pathname = "/fieldkit_store_sandbox";
  const url = sandboxDatabase(
    process.env.SANDBOX_DATABASE_URL ?? database.href,
  );
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = resolve(directory, "config.json");
  try {
    await writeFile(
      path,
      JSON.stringify(
        {
          encryption: randomBytes(32).toString("base64"),
          auth: randomBytes(32).toString("base64url"),
          setup: randomBytes(32).toString("base64url"),
          password: "Store-" + randomBytes(12).toString("base64url"),
        },
        null,
        2,
      ),
      { flag: "wx", mode: 0o600 },
    );
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
  }
  const secrets = JSON.parse(await readFile(path, "utf8"));
  return {
    password: secrets.password as string,
    config: config({
      DATABASE_URL: url.href,
      FIELDKIT_URL: "http://127.0.0.1:4320",
      FIELDKIT_PORT: "4320",
      FIELDKIT_HOST: "127.0.0.1",
      FIELDKIT_DATA: directory,
      FIELDKIT_ENCRYPTION_KEY: secrets.encryption,
      BETTER_AUTH_SECRET: secrets.auth,
      FIELDKIT_SETUP_TOKEN: secrets.setup,
      // The supplied file mailer handles every message; this URL is never contacted.
      SMTP_URL: "smtp://127.0.0.1:1",
      SMTP_FROM: "Trail Supply Sandbox <support@example.test>",
    }),
  };
}
