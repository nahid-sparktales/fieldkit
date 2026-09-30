import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";

if (existsSync(".env")) process.loadEnvFile(".env");
const Schema = z.object({
  DATABASE_URL: z.string().min(1),
  FIELDKIT_URL: z.url().default("http://localhost:4317"),
  FIELDKIT_PORT: z.coerce.number().int().min(1).max(65535).default(4317),
  FIELDKIT_HOST: z.string().default("127.0.0.1"),
  FIELDKIT_DATA: z.string().default(".fieldkit/v2"),
  FIELDKIT_ENCRYPTION_KEY: z
    .string()
    .refine(
      (v) => Buffer.from(v, "base64").length === 32,
      "Use a base64-encoded 32-byte key",
    ),
  BETTER_AUTH_SECRET: z.string().min(32),
  FIELDKIT_SETUP_TOKEN: z.string().min(24),
  SMTP_URL: z.string().optional(),
  SMTP_FROM: z.string().default("FieldKit <support@localhost>"),
  ZENDESK_CLIENT_ID: z.string().optional(),
  ZENDESK_CLIENT_SECRET: z.string().optional(),
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  GOOGLE_PICKER_KEY: z.string().optional(),
  GOOGLE_APP_ID: z.string().optional(),
  NOTION_CLIENT_ID: z.string().optional(),
  NOTION_CLIENT_SECRET: z.string().optional(),
});
export type Config = z.infer<typeof Schema>;
export function config(input: NodeJS.ProcessEnv = process.env): Config {
  const c = Schema.parse(input);
  c.FIELDKIT_URL = c.FIELDKIT_URL.replace(/\/$/, "");
  c.FIELDKIT_DATA = resolve(c.FIELDKIT_DATA);
  return c;
}
export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export function requireValue<T>(
  value: T | null | undefined,
  status = 404,
  message = "Not found",
): T {
  if (value == null) throw new HttpError(status, message);
  return value;
}
export function log(event: string, data: Record<string, unknown> = {}) {
  console.log(JSON.stringify({ at: new Date().toISOString(), event, ...data }));
}
