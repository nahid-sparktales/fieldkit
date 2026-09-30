import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { readFile, stat, mkdir, writeFile } from "node:fs/promises";
import { resolve, join, extname } from "node:path";
import { createHmac } from "node:crypto";
import { z, ZodError } from "zod";
import { toNodeHandler } from "better-auth/node";
import { Platform } from "../../packages/platform/src/platform.js";
import {
  type Config,
  HttpError,
  requireValue,
  log,
} from "../../packages/platform/src/config.js";
import {
  userSession,
  principal,
  staff,
  requireStaff,
  requireAdmin,
  requireOwner,
  conversation,
  type Principal,
} from "../../packages/platform/src/auth.js";
import {
  Settings,
  SourceInput,
  MessageInput,
  DraftSchema,
} from "../../packages/platform/src/contracts.js";
import { uid } from "../../packages/platform/src/db.js";
import {
  token,
  tokenHash,
  seal,
  equal,
  digest,
} from "../../packages/platform/src/security.js";

async function rawBody(req: IncomingMessage, max = 256 * 1024) {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const b of req) {
    size += b.length;
    if (size > max) throw new HttpError(413, "Request exceeds size limit");
    chunks.push(Buffer.from(b));
  }
  return Buffer.concat(chunks);
}
async function body(req: IncomingMessage): Promise<any> {
  try {
    return JSON.parse((await rawBody(req)).toString() || "{}");
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(400, "Invalid JSON");
  }
}
function json(res: ServerResponse, value: unknown, status = 200) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(value));
}
const Id = z.string().min(1).max(200);
export async function createApp(
  c: Config,
  options: ConstructorParameters<typeof Platform>[1] & {
    dev?: boolean;
    workers?: boolean;
    migrate?: boolean;
  } = {},
) {
  const app = new Platform(c, options);
  if (options.migrate) await app.migrate();
  else await app.start();
  if (options.workers) await app.workers();
  const authHandler = toNodeHandler(app.auth.auth);
  const vite = options.dev
    ? await (
        await import("vite")
      ).createServer({ server: { middlewareMode: true }, appType: "spa" })
    : null;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", c.FIELDKIT_URL),
      path = url.pathname,
      method = req.method ?? "GET";
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    try {
      if (path === "/v2/health") {
        await app.db.pool.query("SELECT 1");
        json(res, { status: "ok", version: "2.0.0" });
        return;
      }
      if (path === "/v2/readiness") {
        const worker = await app.db.one(
          "SELECT id FROM worker_heartbeats WHERE last_seen>now()-interval '1 minute' LIMIT 1",
        );
        json(
          res,
          { ready: !!worker, worker: !!worker, smtp: !!c.SMTP_URL },
          worker ? 200 : 503,
        );
        return;
      }
      const origin = req.headers.origin;
      if (origin && origin !== new URL(c.FIELDKIT_URL).origin) {
        const match = path.match(
          /^\/v2\/(?:public\/([^/]+)|workspaces\/([^/]+))/,
        );
        let channel: any;
        if (match?.[1])
          channel = await app.db.one(
            "SELECT ch.* FROM channels ch JOIN workspaces w ON w.id=ch.workspace_id WHERE w.slug=$1 AND ch.kind='widget' AND ch.published",
            [match[1]],
          );
        else if (
          match?.[2] &&
          (req.headers.authorization || method === "OPTIONS")
        )
          channel = await app.db.one(
            "SELECT * FROM channels WHERE workspace_id=$1 AND kind='widget' AND published",
            [match[2]],
          );
        if (!channel?.settings.origins?.includes(origin))
          throw new HttpError(403, "Origin is not allowed");
        res.setHeader("Access-Control-Allow-Origin", origin);
        res.setHeader("Vary", "Origin");
        res.setHeader(
          "Access-Control-Allow-Headers",
          "Authorization, Content-Type",
        );
        res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      }
      if (method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
      }
      if (path.startsWith("/api/auth/")) {
        req.headers["x-fieldkit-client-ip"] =
          req.socket.remoteAddress ?? "unknown";
        await authHandler(req, res);
        return;
      }
      if (
        path.startsWith("/v2/") &&
        !["GET", "HEAD"].includes(method) &&
        req.headers.cookie &&
        !req.headers.authorization &&
        origin !== new URL(c.FIELDKIT_URL).origin
      )
        throw new HttpError(403, "Same-origin request required");
      if (path === "/v2/installation" && method === "GET") {
        json(res, {
          initialized: !!(await app.db.one(
            "SELECT id FROM workspaces LIMIT 1",
          )),
          smtpConfigured: !!c.SMTP_URL,
        });
        return;
      }
      let match = path.match(/^\/v2\/webhooks\/zendesk\/([^/]+)$/);
      if (match && method === "POST") {
        await app.support.webhook(
          match[1],
          await rawBody(req),
          String(req.headers["x-zendesk-webhook-signature"] ?? ""),
          String(req.headers["x-zendesk-webhook-signature-timestamp"] ?? ""),
          String(req.headers["x-zendesk-webhook-invocation-id"] ?? ""),
        );
        json(res, { accepted: true }, 202);
        return;
      }
      match = path.match(/^\/v2\/oauth\/(zendesk|google|notion)\/callback$/);
      if (match && method === "GET") {
        const user = await userSession(app.auth, req);
        if (url.searchParams.get("error"))
          throw new HttpError(400, "Provider authorization was declined");
        const ws = await app.connections.finish(
          match[1],
          user.id,
          url.searchParams.get("state") ?? "",
          url.searchParams.get("code") ?? "",
        );
        res.writeHead(302, {
          Location: `/?workspace=${encodeURIComponent(ws)}&view=connections`,
        });
        res.end();
        return;
      }
      match = path.match(/^\/v2\/public\/([^/]+)(.*)$/);
      if (match) {
        const ws = requireValue(
          await app.db.one("SELECT * FROM workspaces WHERE slug=$1", [
            match[1],
          ]),
        );
        const suffix = match[2];
        const portal = await app.db.one(
          "SELECT * FROM channels WHERE workspace_id=$1 AND kind='portal' AND published",
          [ws.id],
        );
        if (suffix === "/widget/config" && method === "GET") {
          const channel = requireValue(
            await app.db.one(
              "SELECT * FROM channels WHERE workspace_id=$1 AND kind='widget' AND published",
              [ws.id],
            ),
            404,
            "Widget is not published",
          );
          const settings = Settings.parse(ws.settings);
          json(res, {
            id: ws.id,
            name: ws.name,
            greeting: settings.greeting,
            brandColor: settings.brandColor,
            origins: channel.settings.origins ?? [],
          });
          return;
        }
        if (suffix === "/widget/session" && method === "POST") {
          await app.rate(`widget:${ws.id}:${req.socket.remoteAddress}`, 20);
          const data = z
            .object({
              signedIdentity: z.string().max(5000).optional(),
              channel: z.enum(["portal", "widget"]).default("widget"),
            })
            .strict()
            .parse(await body(req));
          const channel = requireValue(
            await app.db.one(
              "SELECT * FROM channels WHERE workspace_id=$1 AND kind=$2 AND published",
              [ws.id, data.channel],
            ),
            404,
            "Channel is not published",
          );
          if (
            data.channel === "portal" &&
            origin !== new URL(c.FIELDKIT_URL).origin
          )
            throw new HttpError(
              403,
              "Portal sessions require the portal origin",
            );
          if (
            data.channel === "widget" &&
            (!origin ||
              (!channel.settings.origins?.includes(origin) &&
                origin !== new URL(c.FIELDKIT_URL).origin))
          )
            throw new HttpError(403, "Widget origin is not allowed");
          let contact: any;
          if (data.signedIdentity) {
            const [encoded, signature, ...rest] =
              data.signedIdentity.split(".");
            if (rest.length || !signature)
              throw new HttpError(401, "Invalid signed identity");
            const connection = await app.db.connection(
                ws.id,
                "widget_identity",
              ),
              secret = app.connections.secret(connection).signingSecret!;
            if (
              !equal(
                createHmac("sha256", secret)
                  .update(encoded)
                  .digest("base64url"),
                signature,
              )
            )
              throw new HttpError(401, "Invalid identity signature");
            let value;
            try {
              value = JSON.parse(Buffer.from(encoded, "base64url").toString());
            } catch {
              throw new HttpError(401, "Invalid identity payload");
            }
            const identity = z
              .object({
                sub: z.string().min(1).max(200),
                email: z.email().optional(),
                name: z.string().max(100).optional(),
                exp: z.number().int(),
              })
              .strict()
              .parse(value);
            if (
              identity.exp < Date.now() / 1000 ||
              identity.exp > Date.now() / 1000 + 3600
            )
              throw new HttpError(
                401,
                "Identity expired or exceeds a one-hour lifetime",
              );
            contact = (
              await app.db.rows(
                `INSERT INTO contacts(id,workspace_id,external_id,name,email,verified) VALUES($1,$2,$3,$4,$5,true) ON CONFLICT(workspace_id,external_id) DO UPDATE SET name=excluded.name,email=excluded.email RETURNING *`,
                [
                  uid(),
                  ws.id,
                  `host:${identity.sub}`,
                  identity.name ?? "",
                  identity.email ?? null,
                ],
              )
            )[0];
          } else
            contact = (
              await app.db.rows(
                "INSERT INTO contacts(id,workspace_id,name) VALUES($1,$2,'Visitor') RETURNING *",
                [uid(), ws.id],
              )
            )[0];
          const credential = token();
          await app.db.pool.query(
            "INSERT INTO credentials(hash,workspace_id,contact_id,kind,expires_at) VALUES($1,$2,$3,'widget',now()+interval '1 hour')",
            [tokenHash(credential), ws.id, contact.id],
          );
          json(res, {
            token: credential,
            workspaceId: ws.id,
            channelId: channel.id,
            contactId: contact.id,
          });
          return;
        }
        if (!portal)
          throw new HttpError(404, "Support portal is not published");
        if (!suffix && method === "GET") {
          const settings = Settings.parse(ws.settings);
          json(res, {
            id: ws.id,
            slug: ws.slug,
            name: ws.name,
            greeting: settings.greeting,
            brandColor: settings.brandColor,
            channelId: portal.id,
          });
          return;
        }
        if (suffix === "/articles" && method === "GET") {
          const query = (url.searchParams.get("q") ?? "").slice(0, 200);
          json(res, {
            articles: await app.db.rows(
              "SELECT d.id,d.title,d.slug,left(d.body,240) excerpt FROM documents d JOIN sources s ON s.id=d.source_id WHERE d.workspace_id=$1 AND d.active AND d.published AND s.active AND s.status='ready' AND s.visibility='customer' AND ($2='' OR to_tsvector('english',d.title||' '||d.body)@@websearch_to_tsquery('english',$2)) ORDER BY d.title LIMIT 100",
              [ws.id, query],
            ),
          });
          return;
        }
        const article = suffix.match(/^\/articles\/([^/]+)$/);
        if (article && method === "GET") {
          json(
            res,
            requireValue(
              await app.db.one(
                "SELECT d.id,d.title,d.body,d.version FROM documents d JOIN sources s ON s.id=d.source_id WHERE d.workspace_id=$1 AND d.id=$2 AND d.active AND d.published AND s.active AND s.status='ready' AND s.visibility='customer'",
                [ws.id, article[1]],
              ),
            ),
          );
          return;
        }
        if (suffix === "/join" && method === "POST") {
          const user = await userSession(app.auth, req);
          const contact = (
            await app.db.rows(
              `INSERT INTO contacts(id,workspace_id,user_id,name,email,verified) VALUES($1,$2,$3,$4,$5,true) ON CONFLICT(workspace_id,user_id) DO UPDATE SET verified=true,email=excluded.email,name=excluded.name RETURNING id`,
              [uid(), ws.id, user.id, user.name, user.email],
            )
          )[0];
          json(res, { workspaceId: ws.id, contactId: contact.id });
          return;
        }
        throw new HttpError(404, "Unknown portal endpoint");
      }
      if (path === "/v2/me" && method === "GET") {
        const user = await userSession(app.auth, req);
        json(res, {
          user,
          workspaces: await app.db.rows(
            "SELECT w.*,m.role FROM memberships m JOIN workspaces w ON w.id=m.workspace_id WHERE m.user_id=$1 ORDER BY w.name",
            [user.id],
          ),
        });
        return;
      }
      if (path === "/v2/workspaces" && method === "POST") {
        const user = await userSession(app.auth, req),
          data = await body(req);
        json(
          res,
          await app.createWorkspace(
            user.id,
            { name: data.name, slug: data.slug },
            data.setupToken,
          ),
          201,
        );
        return;
      }
      if (path === "/v2/invitations/accept" && method === "POST") {
        const user = await userSession(app.auth, req);
        json(
          res,
          await app.acceptInvite(user, Id.parse((await body(req)).token)),
        );
        return;
      }
      match = path.match(/^\/v2\/workspaces\/([^/]+)(.*)$/);
      if (match) {
        const ws = match[1],
          suffix = match[2],
          p = await principal(app.db, app.auth, req, ws);
        if (method !== "GET")
          await app.rate(
            `${ws}:${p.userId ?? p.contactId ?? tokenHash(req.headers.authorization ?? "")}`,
            90,
          );
        if (!suffix && method === "GET") {
          requireStaff(p);
          json(res, {
            workspace: requireValue(
              await app.db.one("SELECT * FROM workspaces WHERE id=$1", [ws]),
            ),
            role: p.role,
            channels: await app.db.rows(
              "SELECT * FROM channels WHERE workspace_id=$1 ORDER BY kind",
              [ws],
            ),
            usage: await app.db.one(
              "SELECT COALESCE(sum(input_tokens),0) input_tokens,COALESCE(sum(output_tokens),0) output_tokens,COALESCE(sum(reserved),0) reserved FROM usage WHERE workspace_id=$1 AND created_at>=date_trunc('month',now())",
              [ws],
            ),
          });
          return;
        }
        if (suffix === "/settings" && method === "PUT") {
          requireAdmin(p);
          const settings = Settings.parse(await body(req));
          await app.db.pool.query(
            "UPDATE workspaces SET settings=$1,revision=revision+1 WHERE id=$2",
            [settings, ws],
          );
          json(res, { settings });
          return;
        }
        let m = suffix.match(/^\/channels\/([^/]+)$/);
        if (m && method === "PUT") {
          json(res, await app.publishChannel(p, m[1], await body(req)));
          return;
        }
        if (suffix === "/members" && method === "GET") {
          requireStaff(p);
          json(res, {
            members: await app.db.rows(
              'SELECT m.user_id,m.role,u.name,u.email FROM memberships m JOIN "user" u ON u.id=m.user_id WHERE m.workspace_id=$1',
              [ws],
            ),
          });
          return;
        }
        if (suffix === "/invitations" && method === "POST") {
          const d = z
            .object({ email: z.email(), role: z.enum(["admin", "agent"]) })
            .strict()
            .parse(await body(req));
          json(res, await app.invite(p, d.email, d.role));
          return;
        }
        m = suffix.match(/^\/members\/([^/]+)$/);
        if (m && method === "DELETE") {
          requireOwner(p);
          if (m[1] === p.userId)
            throw new HttpError(400, "Cannot remove your own owner membership");
          await app.db.pool.query(
            "DELETE FROM memberships WHERE workspace_id=$1 AND user_id=$2 AND role<>'owner'",
            [ws, m[1]],
          );
          json(res, { removed: true });
          return;
        }
        if (suffix === "/contacts" && method === "GET") {
          requireStaff(p);
          json(res, {
            contacts: await app.db.rows(
              "SELECT * FROM contacts WHERE workspace_id=$1 ORDER BY name LIMIT 500",
              [ws],
            ),
          });
          return;
        }
        m = suffix.match(/^\/contacts\/([^/]+)\/mapping$/);
        if (m && method === "PUT") {
          requireAdmin(p);
          const d = z
            .object({
              mappings: z.record(
                z.string().regex(/^[a-z][a-z0-9_]{1,40}$/),
                z.string().min(1).max(200),
              ),
              userId: z.string().optional(),
            })
            .strict()
            .parse(await body(req));
          if (
            d.userId &&
            !(await app.db.one(
              'SELECT id FROM "user" WHERE id=$1 AND "emailVerified"=true',
              [d.userId],
            ))
          )
            throw new HttpError(
              400,
              "Customer user must have a verified email",
            );
          const r = await app.db.rows(
            "UPDATE contacts SET mappings=$1,user_id=COALESCE($2,user_id),revision=revision+1 WHERE workspace_id=$3 AND id=$4 RETURNING *",
            [d.mappings, d.userId ?? null, ws, m[1]],
          );
          requireValue(r[0]);
          await app.db.event(app.db.pool, ws, "identity.mapping_reviewed", {
            contactId: m[1],
            actor: p.userId,
          });
          json(res, r[0]);
          return;
        }
        if (suffix === "/agent/test" && method === "POST") {
          requireAdmin(p);
          const d = z
            .object({ question: z.string().trim().min(1).max(12000) })
            .strict()
            .parse(await body(req));
          const settings = Settings.parse(
            requireValue(
              await app.db.one("SELECT settings FROM workspaces WHERE id=$1", [
                ws,
              ]),
            ).settings,
          );
          const evidence = await app.knowledge.retrieve(ws, d.question);
          const draft = DraftSchema.parse(
            await app.model.answer({
              workspaceId: ws,
              runId: `preview-${uid()}`,
              messages: [{ role: "customer", body: d.question }],
              evidence,
              account: null,
              actions: [],
              instructions: settings.instructions,
              model: settings.model,
            }),
          );
          if (
            draft.intent === "action" ||
            (draft.intent === "answer" &&
              (!draft.citationIds.length ||
                draft.citationIds.some(
                  (id) => !evidence.some((e) => e.id === id),
                ) ||
                !(await app.knowledge.validEvidence(ws, evidence))))
          ) {
            json(res, {
              intent: "handoff",
              answer: "This question needs help from your team.",
              citations: [],
            });
            return;
          }
          json(res, {
            intent: draft.intent,
            answer: draft.answer,
            citations: evidence.filter((e) => draft.citationIds.includes(e.id)),
          });
          return;
        }
        if (suffix === "/conversations" && method === "GET") {
          if (p.role === "service")
            throw new HttpError(
              403,
              "Use a scoped request or customer identity",
            );
          json(res, {
            conversations: await app.db.rows(
              "SELECT c.*,ct.name customer_name FROM conversations c JOIN contacts ct ON ct.id=c.contact_id WHERE c.workspace_id=$1 AND ($2::boolean OR c.contact_id=$3) ORDER BY c.updated_at DESC LIMIT 200",
              [ws, staff(p), p.contactId ?? null],
            ),
          });
          return;
        }
        if (suffix === "/conversations" && method === "POST") {
          const d = z
            .object({
              body: z.string(),
              requestKey: z.string(),
              subject: z.string().max(160).optional(),
              channelId: z.string().optional(),
              contactId: z.string().optional(),
            })
            .strict()
            .parse(await body(req));
          json(res, await app.newConversation(p, d), 202);
          return;
        }
        if (suffix === "/requests" && method === "POST") {
          if (p.role !== "service" || !p.scopes?.includes("requests:create"))
            throw new HttpError(403, "Scoped service credential required");
          const d = z
            .object({
              externalCustomerId: z.string().max(200),
              body: z.string(),
              requestKey: z.string(),
              channelId: z.string().optional(),
            })
            .strict()
            .parse(await body(req));
          const contact = requireValue(
            await app.db.one(
              "SELECT * FROM contacts WHERE workspace_id=$1 AND external_id=$2 AND verified",
              [ws, `host:${d.externalCustomerId}`],
            ),
            403,
            "Create a verified customer identity and mapping first",
          );
          json(
            res,
            await app.newConversation(
              { workspaceId: ws, role: "customer", contactId: contact.id },
              d,
            ),
            202,
          );
          return;
        }
        if (suffix === "/identities" && method === "POST") {
          if (p.role !== "service" || !p.scopes?.includes("requests:create"))
            throw new HttpError(403, "Scoped service credential required");
          const d = z
            .object({
              externalCustomerId: z.string().min(1).max(200),
              name: z.string().max(100),
              email: z.email().optional(),
            })
            .strict()
            .parse(await body(req));
          const contact = (
            await app.db.rows(
              `INSERT INTO contacts(id,workspace_id,external_id,name,email,verified) VALUES($1,$2,$3,$4,$5,true) ON CONFLICT(workspace_id,external_id) DO UPDATE SET name=excluded.name,email=excluded.email RETURNING id`,
              [
                uid(),
                ws,
                `host:${d.externalCustomerId}`,
                d.name,
                d.email ?? null,
              ],
            )
          )[0];
          json(res, contact);
          return;
        }
        m = suffix.match(/^\/requests\/([^/]+)\/messages$/);
        if (m && method === "POST") {
          if (p.role !== "service" || !p.scopes?.includes("requests:create"))
            throw new HttpError(403, "Scoped service credential required");
          const d = MessageInput.extend({
            externalCustomerId: z.string().min(1).max(200),
          }).parse(await body(req));
          const contact = requireValue(
            await app.db.one(
              "SELECT id FROM contacts WHERE workspace_id=$1 AND external_id=$2 AND verified",
              [ws, `host:${d.externalCustomerId}`],
            ),
            404,
            "Customer not found",
          );
          json(
            res,
            await app.message(
              { workspaceId: ws, role: "customer", contactId: contact.id },
              m[1],
              { body: d.body, requestKey: d.requestKey },
            ),
            202,
          );
          return;
        }
        m = suffix.match(/^\/requests\/([^/]+)$/);
        if (m && method === "GET") {
          if (p.role !== "service" || !p.scopes?.includes("requests:create"))
            throw new HttpError(403, "Scoped service credential required");
          const conv = requireValue(
            await app.db.one(
              "SELECT id,status,mode,contact_id FROM conversations WHERE workspace_id=$1 AND id=$2",
              [ws, m[1]],
            ),
          );
          const customer = url.searchParams.get("externalCustomerId");
          if (
            customer &&
            !(await app.db.one(
              "SELECT id FROM contacts WHERE workspace_id=$1 AND id=$2 AND external_id=$3",
              [ws, conv.contact_id, `host:${customer}`],
            ))
          )
            throw new HttpError(
              404,
              "Conversation not found for this customer",
            );
          json(res, {
            id: conv.id,
            status: conv.status,
            mode: conv.mode,
            messages: await app.db.rows(
              "SELECT id,role,body,citations,created_at FROM messages WHERE workspace_id=$1 AND conversation_id=$2 AND role IN ('customer','assistant','staff') ORDER BY created_at,id",
              [ws, conv.id],
            ),
          });
          return;
        }
        m = suffix.match(/^\/conversations\/([^/]+)(.*)$/);
        if (m) {
          const id = m[1],
            tail = m[2];
          if (!tail && method === "GET") {
            const conv = await conversation(app.db, p, id);
            json(res, {
              conversation: conv,
              messages: await app.db.rows(
                "SELECT * FROM messages WHERE workspace_id=$1 AND conversation_id=$2 AND ($3::boolean OR role NOT IN ('note','system')) ORDER BY created_at,id",
                [ws, id, staff(p)],
              ),
              ...(staff(p)
                ? {
                    runs: await app.db.rows(
                      "SELECT * FROM runs WHERE workspace_id=$1 AND conversation_id=$2 ORDER BY created_at DESC",
                      [ws, id],
                    ),
                    approvals: await app.db.rows(
                      "SELECT a.* FROM approvals a JOIN runs r ON r.id=a.run_id WHERE a.workspace_id=$1 AND r.conversation_id=$2",
                      [ws, id],
                    ),
                  }
                : {}),
            });
            return;
          }
          if (tail === "/messages" && method === "POST") {
            json(res, await app.message(p, id, await body(req)), 201);
            return;
          }
          if (tail === "/notes" && method === "POST") {
            json(res, await app.message(p, id, await body(req), true), 201);
            return;
          }
          if (tail === "/control" && method === "POST") {
            const d = z
              .object({
                mode: z.enum(["agent", "human"]).optional(),
                status: z.enum(["open", "resolved"]).optional(),
                assignedTo: z.string().nullable().optional(),
                tags: z.array(z.string().max(60)).max(20).optional(),
                externalAssigneeId: z.string().regex(/^\d+$/).optional(),
              })
              .strict()
              .parse(await body(req));
            json(res, await app.control(p, id, d));
            return;
          }
          if (!tail && method === "DELETE") {
            requireAdmin(p);
            await app.deleteConversation(ws, id);
            json(res, { deleted: true });
            return;
          }
          if (tail === "/events" && method === "GET") {
            await conversation(app.db, p, id);
            res.writeHead(200, {
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-cache",
              Connection: "keep-alive",
              "X-Accel-Buffering": "no",
            });
            res.write(": connected\n\n");
            let after = Number(url.searchParams.get("after") ?? 0);
            if (!Number.isSafeInteger(after) || after < 0) after = 0;
            let closed = false,
              busy = false;
            res.on("close", () => {
              closed = true;
              clearInterval(timer);
              clearTimeout(expiry);
            });
            const timer = setInterval(async () => {
              if (closed || busy) return;
              busy = true;
              try {
                const current = await principal(app.db, app.auth, req, ws);
                await conversation(app.db, current, id);
                const events = await app.db.rows(
                  "SELECT * FROM events WHERE workspace_id=$1 AND conversation_id=$2 AND id>$3 AND ($4::boolean OR public) ORDER BY id LIMIT 100",
                  [ws, id, after, staff(current)],
                );
                for (const e of events) {
                  after = Number(e.id);
                  res.write(
                    `id: ${e.id}\ndata: ${JSON.stringify({ kind: e.kind, data: e.data })}\n\n`,
                  );
                }
                if (!events.length) res.write(": heartbeat\n\n");
              } catch {
                res.end();
              } finally {
                busy = false;
              }
            }, 1000);
            const expiry = setTimeout(() => res.end(), 5 * 60 * 1000);
            return;
          }
        }
        if (suffix === "/sources" && method === "GET") {
          requireStaff(p);
          json(res, {
            sources: await app.db.rows(
              "SELECT * FROM sources WHERE workspace_id=$1 ORDER BY title",
              [ws],
            ),
            documents: await app.db.rows(
              "SELECT id,source_id,title,version,active,published,slug FROM documents WHERE workspace_id=$1 ORDER BY created_at DESC",
              [ws],
            ),
          });
          return;
        }
        if (suffix === "/sources" && method === "POST") {
          requireAdmin(p);
          json(
            res,
            await app.knowledge.add(ws, SourceInput.parse(await body(req))),
            202,
          );
          return;
        }
        if (suffix === "/sources/upload" && method === "POST") {
          requireAdmin(p);
          const bytes = await rawBody(req, 21 * 1024 * 1024);
          const form = await new Request(c.FIELDKIT_URL, {
            method: "POST",
            headers: { "Content-Type": req.headers["content-type"] ?? "" },
            body: bytes,
          }).formData();
          const file = form.get("file");
          if (!(file instanceof File))
            throw new HttpError(400, "Choose a file");
          json(
            res,
            await app.knowledge.upload(
              ws,
              file.name,
              Buffer.from(await file.arrayBuffer()),
            ),
            202,
          );
          return;
        }
        m = suffix.match(/^\/sources\/([^/]+)(.*)$/);
        if (m) {
          const sourceId = m[1];
          requireAdmin(p);
          if (!m[2] && method === "DELETE") {
            await app.knowledge.remove(ws, sourceId);
            json(res, { deleted: true });
            return;
          }
          if (m[2] === "/refresh" && method === "POST") {
            await app.knowledge.refresh(ws, sourceId);
            json(res, { queued: true }, 202);
            return;
          }
          if (m[2] === "/visibility" && method === "PUT") {
            const d = z
              .object({ visibility: z.enum(["staff", "customer"]) })
              .strict()
              .parse(await body(req));
            await app.db.tx(async (q) => {
              requireValue(
                (
                  await app.db.rows(
                    "UPDATE sources SET visibility=$1,revision=revision+1 WHERE workspace_id=$2 AND id=$3 RETURNING id",
                    [d.visibility, ws, sourceId],
                    q,
                  )
                )[0],
              );
              if (d.visibility === "staff")
                await q.query(
                  "UPDATE documents SET published=false WHERE workspace_id=$1 AND source_id=$2",
                  [ws, sourceId],
                );
              await app.db.event(q, ws, "knowledge.visibility", {
                sourceId: sourceId,
                visibility: d.visibility,
                actor: p.userId,
              });
            });
            json(res, d);
            return;
          }
        }
        m = suffix.match(/^\/documents\/([^/]+)(.*)$/);
        if (m) {
          requireStaff(p);
          if (!m[2] && method === "GET") {
            json(
              res,
              requireValue(
                await app.db.one(
                  "SELECT * FROM documents WHERE workspace_id=$1 AND id=$2",
                  [ws, m[1]],
                ),
              ),
            );
            return;
          }
          if (m[2] === "/publish" && method === "POST") {
            requireAdmin(p);
            const d = z
              .object({ published: z.boolean() })
              .strict()
              .parse(await body(req));
            const r = await app.db.rows(
              "UPDATE documents d SET published=$1 FROM sources s WHERE d.workspace_id=$2 AND d.id=$3 AND s.id=d.source_id AND d.active AND s.active AND s.status='ready' AND (NOT $1 OR s.visibility='customer') RETURNING d.id,d.published",
              [d.published, ws, m[1]],
            );
            json(
              res,
              requireValue(
                r[0],
                409,
                "Document must be ready and approved for customers",
              ),
            );
            return;
          }
        }
        if (suffix === "/connections" && method === "GET") {
          requireAdmin(p);
          json(res, {
            connections: await app.db.rows(
              "SELECT id,provider,status,metadata,revision,updated_at FROM connections WHERE workspace_id=$1 ORDER BY provider",
              [ws],
            ),
            oauth: {
              zendesk: !!(c.ZENDESK_CLIENT_ID && c.ZENDESK_CLIENT_SECRET),
              notion: !!(c.NOTION_CLIENT_ID && c.NOTION_CLIENT_SECRET),
              google: !!(c.GOOGLE_CLIENT_ID && c.GOOGLE_CLIENT_SECRET),
            },
            webhookUrl: `${c.FIELDKIT_URL}/v2/webhooks/zendesk/${ws}`,
          });
          return;
        }
        if (suffix === "/connections/key" && method === "POST") {
          requireAdmin(p);
          const d = z
            .object({
              provider: z.string().max(80),
              apiKey: z.string().min(8).max(8000),
              model: z.string().max(100).optional(),
            })
            .strict()
            .parse(await body(req));
          if (d.provider.startsWith("custom:")) requireOwner(p);
          json(
            res,
            await app.connections.connectKey(
              ws,
              d.provider,
              d.apiKey,
              d.model ? { model: d.model } : {},
            ),
          );
          return;
        }
        m = suffix.match(/^\/connections\/([^/]+)(.*)$/);
        if (m) {
          requireAdmin(p);
          const provider = decodeURIComponent(m[1]);
          if (!m[2] && method === "DELETE") {
            await app.connections.disconnect(ws, provider);
            json(res, { disconnected: true });
            return;
          }
          if (m[2] === "/oauth" && method === "POST") {
            const d = z
              .object({ subdomain: z.string().optional() })
              .strict()
              .parse(await body(req));
            json(res, {
              url: await app.connections.begin(
                ws,
                p.userId!,
                provider,
                d.subdomain ? { subdomain: d.subdomain } : {},
              ),
            });
            return;
          }
          if (
            m[2] === "/webhook-secret" &&
            method === "PUT" &&
            provider === "zendesk"
          ) {
            const d = z
              .object({ secret: z.string().min(10).max(1000) })
              .strict()
              .parse(await body(req));
            const row = await app.db.connection(ws, provider);
            await app.connections.save(
              ws,
              provider,
              { ...app.connections.secret(row), webhookSecret: d.secret },
              row.metadata,
            );
            json(res, { configured: true });
            return;
          }
          if (m[2] === "/picker" && method === "GET" && provider === "google") {
            if (!c.GOOGLE_PICKER_KEY || !c.GOOGLE_APP_ID)
              throw new HttpError(
                409,
                "Configure the Google Picker key and app ID",
              );
            const access = await app.connections.access(ws, "google");
            json(res, {
              accessToken: access.secret.access_token,
              developerKey: c.GOOGLE_PICKER_KEY,
              appId: c.GOOGLE_APP_ID,
            });
            return;
          }
        }
        if (suffix === "/identity-key" && method === "POST") {
          requireOwner(p);
          const secret = token();
          await app.connections.save(
            ws,
            "widget_identity",
            { signingSecret: secret },
            {},
          );
          json(res, { secret });
          return;
        }
        if (suffix === "/credentials" && method === "GET") {
          requireOwner(p);
          json(res, {
            credentials: await app.db.rows(
              "SELECT hash AS id,label,expires_at FROM credentials WHERE workspace_id=$1 AND kind='service' ORDER BY expires_at DESC",
              [ws],
            ),
          });
          return;
        }
        m = suffix.match(/^\/credentials\/([a-f0-9]{64})$/);
        if (m && method === "DELETE") {
          requireOwner(p);
          await app.db.pool.query(
            "DELETE FROM credentials WHERE workspace_id=$1 AND kind='service' AND hash=$2",
            [ws, m[1]],
          );
          json(res, { revoked: true });
          return;
        }
        if (suffix === "/credentials" && method === "POST") {
          requireOwner(p);
          const d = z
            .object({
              label: z.string().min(1).max(100),
              days: z.number().int().min(1).max(90).default(30),
            })
            .strict()
            .parse(await body(req));
          const secret = token();
          await app.db.pool.query(
            "INSERT INTO credentials(hash,workspace_id,kind,scopes,expires_at,label) VALUES($1,$2,'service',$3,now()+($4::int*interval '1 day'),$5)",
            [tokenHash(secret), ws, ["requests:create"], d.days, d.label],
          );
          json(res, { token: secret });
          return;
        }
        if (suffix === "/actions" && method === "GET") {
          requireStaff(p);
          json(res, {
            actions: await app.db.rows(
              "SELECT * FROM actions WHERE workspace_id=$1 ORDER BY name",
              [ws],
            ),
          });
          return;
        }
        if (suffix === "/actions" && method === "POST") {
          requireOwner(p);
          json(res, await app.actions.save(ws, await body(req)), 201);
          return;
        }
        m = suffix.match(/^\/actions\/([^/]+)$/);
        if (m && method === "PUT") {
          requireOwner(p);
          json(res, await app.actions.save(ws, await body(req), m[1]));
          return;
        }
        if (suffix === "/approvals" && method === "GET") {
          requireStaff(p);
          json(res, {
            approvals: await app.db.rows(
              "SELECT a.*,r.conversation_id FROM approvals a JOIN runs r ON r.id=a.run_id WHERE a.workspace_id=$1 ORDER BY a.expires_at DESC",
              [ws],
            ),
          });
          return;
        }
        m = suffix.match(/^\/approvals\/([^/]+)\/decision$/);
        if (m && method === "POST") {
          const d = z
            .object({
              hash: z.string().length(64),
              decision: z.enum(["approve", "reject"]),
            })
            .strict()
            .parse(await body(req));
          json(res, await app.decide(p, m[1], d.hash, d.decision), 202);
          return;
        }
        if (suffix === "/operations" && method === "GET") {
          requireStaff(p);
          json(res, {
            operations: await app.db.rows(
              "SELECT o.*,r.conversation_id FROM operations o JOIN runs r ON r.id=o.run_id WHERE o.workspace_id=$1 ORDER BY o.created_at DESC",
              [ws],
            ),
          });
          return;
        }
        m = suffix.match(/^\/operations\/([^/]+)\/reconcile$/);
        if (m && method === "POST") {
          requireAdmin(p);
          const op = requireValue(
            await app.db.one(
              "SELECT * FROM operations WHERE workspace_id=$1 AND id=$2",
              [ws, m[1]],
            ),
          );
          const run = requireValue(
            await app.db.one(
              "SELECT * FROM runs WHERE workspace_id=$1 AND id=$2",
              [ws, op.run_id],
            ),
          );
          const { action, identity } = await app.actions.revalidate(
            ws,
            run.state.proposal,
          );
          json(
            res,
            await app.actions.reconcile(
              ws,
              op,
              run.state.proposal,
              action,
              identity,
            ),
          );
          return;
        }
        if (suffix === "/operations/jobs" && method === "GET") {
          requireAdmin(p);
          json(res, {
            jobs: await app.db.rows(
              "SELECT id,name,state,retry_count,created_on,output FROM jobs.job WHERE data->>'workspaceId'=$1 AND state IN ('failed','retry','active') ORDER BY created_on DESC LIMIT 100",
              [ws],
            ),
            deliveries: await app.db.rows(
              "SELECT id,conversation_id,status,attempts,error FROM deliveries WHERE workspace_id=$1 AND status<>'delivered' ORDER BY created_at DESC LIMIT 100",
              [ws],
            ),
          });
          return;
        }
        m = suffix.match(/^\/jobs\/([^/]+)\/retry$/);
        if (m && method === "POST") {
          requireAdmin(p);
          const job = requireValue(
            await app.db.one(
              "SELECT id,name,state FROM jobs.job WHERE id=$1::uuid AND data->>'workspaceId'=$2",
              [m[1], ws],
            ),
          );
          if (job.state !== "failed")
            throw new HttpError(409, "Only failed jobs can be retried");
          await app.db.boss.retry(job.name, job.id);
          json(res, { queued: true });
          return;
        }
        if (suffix === "/audit" && method === "GET") {
          requireAdmin(p);
          json(res, {
            events: await app.db.rows(
              "SELECT * FROM events WHERE workspace_id=$1 ORDER BY id DESC LIMIT 300",
              [ws],
            ),
          });
          return;
        }
        throw new HttpError(404, "Unknown workspace endpoint");
      }
      if (path.startsWith("/v2/") || path.startsWith("/api/"))
        throw new HttpError(404, "Unknown endpoint");
      const widgetPath = path.match(/^\/widget\/([^/]+)$/);
      if (widgetPath) {
        const channel = await app.db.one(
          "SELECT ch.settings FROM channels ch JOIN workspaces w ON w.id=ch.workspace_id WHERE w.slug=$1 AND ch.kind='widget' AND ch.published",
          [widgetPath[1]],
        );
        const origins = channel?.settings.origins ?? [];
        res.setHeader(
          "Content-Security-Policy",
          `frame-ancestors 'self' ${origins.join(" ")}`,
        );
      } else res.setHeader("Content-Security-Policy", "frame-ancestors 'self'");
      if (vite) {
        vite.middlewares(req, res, () =>
          json(res, { error: "Not found" }, 404),
        );
        return;
      }
      const root = resolve("dist/web");
      let file = resolve(root, "." + decodeURIComponent(path));
      if (!file.startsWith(root + "/")) file = join(root, "index.html");
      try {
        if (!(await stat(file)).isFile()) file = join(root, "index.html");
      } catch {
        file = join(root, "index.html");
      }
      const data = await readFile(file);
      res.setHeader(
        "Content-Type",
        (
          {
            ".html": "text/html",
            ".js": "text/javascript",
            ".css": "text/css",
            ".svg": "image/svg+xml",
            ".png": "image/png",
          } as Record<string, string>
        )[extname(file)] ?? "application/octet-stream",
      );
      res.end(data);
    } catch (error) {
      if (res.headersSent) {
        res.end();
        return;
      }
      const status =
        error instanceof HttpError
          ? error.status
          : error instanceof ZodError
            ? 400
            : (error as any)?.code === "23505"
              ? 409
              : 500;
      if (status === 500)
        log("request.error", {
          path,
          error: error instanceof Error ? error.message : "Unknown error",
        });
      json(
        res,
        {
          error:
            status === 500
              ? "An unexpected error occurred. Check the server logs."
              : error instanceof ZodError
                ? error.issues
                    .map((i) => `${i.path.join(".")}: ${i.message}`)
                    .join("; ")
                : (error as any)?.code === "23505"
                  ? "That record already exists"
                  : (error as Error).message,
        },
        status,
      );
    }
  });
  server.requestTimeout = 60000;
  server.headersTimeout = 15000;
  return {
    server,
    app,
    async close() {
      await vite?.close();
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
      await app.close();
    },
  };
}
