import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import type { Platform } from "../../packages/platform/src/platform.js";
import type { Principal } from "../../packages/platform/src/auth.js";
export async function collaborationRoutes(
  app: Platform,
  p: Principal,
  req: IncomingMessage,
  res: ServerResponse,
  _url: URL,
  path: string,
  body: (req: IncomingMessage) => Promise<unknown>,
  json: (res: ServerResponse, result: unknown) => void,
) {
  const method = req.method ?? "GET",
    c = app.collaboration;
  let m: RegExpMatchArray | null, result: unknown;
  if (path === "/organizations" && method === "GET")
    result = await c.organizations(p);
  else if (path === "/organizations" && method === "POST")
    result = await c.saveOrganization(p, await body(req));
  else if ((m = path.match(/^\/organizations\/([^/]+)$/)) && method === "GET")
    result = await c.organization(p, m[1]);
  else if ((m = path.match(/^\/organizations\/([^/]+)$/)) && method === "PUT")
    result = await c.saveOrganization(p, await body(req), m[1]);
  else if (
    (m = path.match(/^\/organizations\/([^/]+)\/invitations$/)) &&
    method === "POST"
  )
    result = await c.inviteOrganization(p, m[1], await body(req));
  else if (
    (m = path.match(/^\/organizations\/([^/]+)\/members\/([^/]+)$/)) &&
    method === "DELETE"
  )
    result = await c.removeMember(p, m[1], m[2]);
  else if (
    (m = path.match(/^\/conversations\/([^/]+)\/collaboration$/)) &&
    method === "GET"
  )
    result = await c.ticket(p, m[1]);
  else if (
    (m = path.match(/^\/conversations\/([^/]+)\/participants$/)) &&
    method === "POST"
  )
    result = await c.addParticipant(p, m[1], await body(req));
  else if (
    (m = path.match(/^\/conversations\/([^/]+)\/participants\/([^/]+)$/)) &&
    method === "DELETE"
  )
    result = await c.removeParticipant(p, m[1], m[2]);
  else if (
    (m = path.match(/^\/conversations\/([^/]+)\/sharing$/)) &&
    method === "PUT"
  )
    result = await c.share(p, m[1], await body(req));
  else if (
    (m = path.match(/^\/conversations\/([^/]+)\/following$/)) &&
    method === "PUT"
  )
    result = await c.follow(p, m[1], await body(req));
  else if (
    (m = path.match(/^\/collaboration\/invitations\/([^/]+)$/)) &&
    method === "GET"
  )
    result = await c.invitation(p, m[1]);
  else if (
    (m = path.match(/^\/collaboration\/invitations\/([^/]+)$/)) &&
    method === "POST"
  ) {
    z.object({ accept: z.literal(true) })
      .strict()
      .parse(await body(req));
    result = await c.invitation(p, m[1], true);
  } else if (
    (m = path.match(/^\/collaboration\/invitations\/([^/]+)\/retry$/)) &&
    method === "POST"
  )
    result = await c.retryInvitation(p, m[1]);
  else if (
    (m = path.match(/^\/collaboration\/invitations\/([^/]+)\/resend$/)) &&
    method === "POST"
  )
    result = await c.resendInvitation(p, m[1]);
  else if (
    (m = path.match(
      /^\/conversations\/([^/]+)\/participant-suggestions\/dismiss$/,
    )) &&
    method === "POST"
  )
    result = await c.dismissSuggestion(p, m[1], await body(req));
  else return false;
  json(res, result);
  return true;
}
