import { betterAuth } from "better-auth";
import { getMigrations } from "better-auth/db/migration";
import { fromNodeHeaders } from "better-auth/node";
import nodemailer from "nodemailer";
import type { IncomingMessage } from "node:http";
import type { Database } from "./db.js";
import { HttpError, requireValue } from "./config.js";
import { tokenHash } from "./security.js";

export type Mailer = (
  to: string,
  subject: string,
  text: string,
  options?: {
    replyTo?: string;
    messageId?: string;
    inReplyTo?: string;
    references?: string[];
  },
) => Promise<void>;
export function createAuth(db: Database, mailer?: Mailer) {
  const c = db.config;
  const transport = c.SMTP_URL
    ? nodemailer.createTransport({
        url: c.SMTP_URL,
        connectionTimeout: 10000,
        greetingTimeout: 10000,
        socketTimeout: 30000,
      } as import("nodemailer/lib/smtp-transport/index.js").Options)
    : null;
  const send: Mailer =
    mailer ??
    (async (to, subject, text, options) => {
      if (!transport)
        throw new HttpError(
          503,
          "Configure SMTP before sending verification or invitation email",
        );
      await transport.sendMail({
        from: c.SMTP_FROM,
        to,
        subject,
        text,
        ...options,
        headers: { "Auto-Submitted": "auto-generated" },
      });
    });
  const auth = betterAuth({
    appName: "Navigated Support",
    baseURL: c.FIELDKIT_URL,
    basePath: "/api/auth",
    secret: c.BETTER_AUTH_SECRET,
    database: db.pool,
    trustedOrigins: [c.FIELDKIT_URL],
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: true,
      minPasswordLength: 12,
      sendResetPassword: async ({ user, url }) =>
        send(
          user.email,
          "Reset your Navigated Support password",
          `Reset your password: ${url}`,
        ),
    },
    emailVerification: {
      sendOnSignUp: true,
      autoSignInAfterVerification: true,
      sendVerificationEmail: async ({ user, url }) =>
        send(
          user.email,
          "Verify your Navigated Support email",
          `Verify your email: ${url}`,
        ),
    },
    session: {
      expiresIn: 60 * 60 * 24 * 7,
      updateAge: 60 * 60,
      cookieCache: { enabled: false },
    },
    advanced: {
      ipAddress: { ipAddressHeaders: ["x-fieldkit-client-ip"] },
      useSecureCookies: c.FIELDKIT_URL.startsWith("https:"),
    },
    rateLimit: { enabled: true, storage: "database", window: 60, max: 40 },
  });
  return {
    auth,
    send,
    async migrate() {
      const m = await getMigrations(auth.options);
      await m.runMigrations();
    },
  };
}
export type Auth = ReturnType<typeof createAuth>;
export type Principal = {
  workspaceId: string;
  userId?: string;
  role: "owner" | "admin" | "agent" | "customer" | "visitor" | "service";
  contactId?: string;
  channelId?: string;
  scopes?: string[];
};
export async function userSession(auth: Auth, req: IncomingMessage) {
  const session = await auth.auth.api.getSession({
    headers: fromNodeHeaders(req.headers),
  });
  if (!session?.user.emailVerified)
    throw new HttpError(401, "Sign in with a verified email address");
  return session.user;
}
export async function principal(
  db: Database,
  auth: Auth,
  req: IncomingMessage,
  workspaceId: string,
): Promise<Principal> {
  const bearer = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
  if (bearer) {
    const credential = await db.one(
      "SELECT * FROM credentials WHERE hash=$1 AND workspace_id=$2 AND expires_at>now()",
      [tokenHash(bearer), workspaceId],
    );
    if (!credential)
      throw new HttpError(401, "Credential is invalid or expired");
    if (credential.kind === "service")
      return { workspaceId, role: "service", scopes: credential.scopes };
    if (
      !(await db.one(
        "SELECT id FROM channels WHERE workspace_id=$1 AND published AND (id=$2 OR ($2::text IS NULL AND kind='widget'))",
        [workspaceId, credential.channel_id ?? null],
      ))
    )
      throw new HttpError(401, "The widget is no longer published");
    const contact = requireValue(
      await db.one("SELECT * FROM contacts WHERE workspace_id=$1 AND id=$2", [
        workspaceId,
        credential.contact_id,
      ]),
    );
    return {
      workspaceId,
      role: contact.verified ? "customer" : "visitor",
      contactId: contact.id,
      channelId: credential.channel_id ?? undefined,
    };
  }
  const user = await userSession(auth, req);
  if (req.headers["x-fieldkit-audience"] === "customer") {
    const contact = requireValue(
      await db.one(
        "SELECT id FROM contacts WHERE workspace_id=$1 AND user_id=$2 AND verified",
        [workspaceId, user.id],
      ),
      403,
      "Join the support portal first",
    );
    return {
      workspaceId,
      userId: user.id,
      contactId: contact.id,
      role: "customer",
    };
  }
  const member = await db.one(
    "SELECT role FROM memberships WHERE workspace_id=$1 AND user_id=$2",
    [workspaceId, user.id],
  );
  if (member) return { workspaceId, userId: user.id, role: member.role };
  const contact = await db.one(
    "SELECT id FROM contacts WHERE workspace_id=$1 AND user_id=$2",
    [workspaceId, user.id],
  );
  if (contact)
    return {
      workspaceId,
      userId: user.id,
      contactId: contact.id,
      role: "customer",
    };
  throw new HttpError(403, "You do not belong to this workspace");
}
export const staff = (p: Principal) =>
  ["owner", "admin", "agent"].includes(p.role);
export function requireStaff(p: Principal) {
  if (!staff(p)) throw new HttpError(403, "Staff access required");
}
export function requireAdmin(p: Principal) {
  if (!["owner", "admin"].includes(p.role))
    throw new HttpError(403, "Workspace administrator access required");
}
export function requireOwner(p: Principal) {
  if (p.role !== "owner")
    throw new HttpError(403, "Workspace owner access required");
}
export async function conversation(
  db: Database,
  p: Principal,
  id: string,
  q = db.pool as import("./db.js").Queryable,
) {
  const row = requireValue(
    await db.one(
      "SELECT * FROM conversations WHERE workspace_id=$1 AND id=$2",
      [p.workspaceId, id],
      q,
    ),
  );
  if (
    !staff(p) &&
    (row.contact_id !== p.contactId ||
      (p.channelId && p.channelId !== row.channel_id))
  )
    throw new HttpError(404, "Conversation not found");
  return row;
}
