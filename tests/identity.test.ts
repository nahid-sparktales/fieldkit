import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import { createOTP } from "@better-auth/utils/otp";
import { base32 } from "@better-auth/utils/base32";
import { createApp } from "../apps/api/server.js";
import { resetDatabase, testConfig } from "./helpers.js";
import { uid } from "../packages/platform/src/db.js";
import { tokenHash } from "../packages/platform/src/security.js";

const config = testConfig(4873),
  password = "identity-local-fixture-password";
let server: Awaited<ReturnType<typeof createApp>>,
  issuer: string,
  privateKey: CryptoKey,
  jwk: any;
const codes = new Map<
  string,
  {
    nonce: string;
    challenge: string;
    redirect: string;
    claims?: Record<string, unknown>;
  }
>();
let providerClaims: Record<string, unknown> = {},
  idpEmail = "",
  failDelivery = false;
const sentMail: { options: any; text: string }[] = [];
const idp = createServer(async (req, res) => {
  try {
    const url = new URL(req.url!, issuer);
    res.setHeader("Content-Type", "application/json");
    if (url.pathname === "/.well-known/openid-configuration")
      return res.end(
        JSON.stringify({
          issuer,
          authorization_endpoint: issuer + "/authorize",
          token_endpoint: issuer + "/token",
          jwks_uri: issuer + "/jwks",
          code_challenge_methods_supported: ["S256"],
          id_token_signing_alg_values_supported: ["RS256"],
          token_endpoint_auth_methods_supported: ["client_secret_basic"],
        }),
      );
    if (url.pathname === "/jwks")
      return res.end(JSON.stringify({ keys: [jwk] }));
    if (url.pathname === "/authorize") {
      assert.equal(url.searchParams.get("code_challenge_method"), "S256");
      const code = uid();
      codes.set(code, {
        nonce: url.searchParams.get("nonce")!,
        challenge: url.searchParams.get("code_challenge")!,
        redirect: url.searchParams.get("redirect_uri")!,
        claims: { ...providerClaims },
      });
      const dest = new URL(url.searchParams.get("redirect_uri")!);
      dest.searchParams.set("code", code);
      dest.searchParams.set("state", url.searchParams.get("state")!);
      dest.searchParams.set("iss", issuer);
      res.writeHead(302, { Location: dest.href });
      return res.end();
    }
    if (url.pathname === "/token") {
      let body = "";
      for await (const c of req) body += c;
      const data = new URLSearchParams(body),
        code = codes.get(data.get("code")!);
      codes.delete(data.get("code")!);
      assert.ok(code);
      assert.equal(
        Buffer.from(tokenHash(data.get("code_verifier")!), "hex").toString(
          "base64url",
        ),
        code.challenge,
      );
      assert.equal(data.get("redirect_uri"), code.redirect);
      assert.equal(
        req.headers.authorization,
        "Basic " +
          Buffer.from("fixture-client:fixture-secret").toString("base64"),
      );
      const jwt = await new SignJWT({
        sub: "stable-subject",
        email: idpEmail,
        email_verified: true,
        nonce: code.nonce,
        ...code.claims,
      })
        .setProtectedHeader({ alg: "RS256", kid: "fixture" })
        .setIssuer(String(code.claims?.iss ?? issuer))
        .setAudience(String(code.claims?.aud ?? "fixture-client"))
        .setIssuedAt()
        .setExpirationTime(
          (code.claims?.exp as number) ?? Math.floor(Date.now() / 1000) + 300,
        )
        .sign(privateKey);
      return res.end(
        JSON.stringify({
          access_token: "unused",
          token_type: "Bearer",
          id_token: jwt,
        }),
      );
    }
    res.statusCode = 404;
    res.end("{}");
  } catch {
    res.statusCode = 400;
    res.end(JSON.stringify({ error: "invalid_grant" }));
  }
});
class Browser {
  cookies = new Map<string, string>();
  async call(path: string, data?: unknown, method?: string) {
    const res = await fetch(config.FIELDKIT_URL + path, {
      method: method ?? (data === undefined ? "GET" : "POST"),
      headers: {
        Origin: config.FIELDKIT_URL,
        "Content-Type": "application/json",
        Cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; "),
      },
      body: data === undefined ? undefined : JSON.stringify(data),
      redirect: "manual",
    });
    for (const c of res.headers.getSetCookie()) {
      const part = c.split(";")[0],
        at = part.indexOf("=");
      this.cookies.set(part.slice(0, at), part.slice(at + 1));
    }
    return res;
  }
  async json(path: string, data?: unknown, method?: string) {
    const res = await this.call(path, data, method);
    const text = await res.text();
    assert.ok(
      [200, 201].includes(res.status),
      `${path} (${res.status}): ${text}`,
    );
    return JSON.parse(text);
  }
}
async function clearRate() {
  await server.app.db.pool.query('DELETE FROM "rateLimit"');
  await server.app.db.pool.query("DELETE FROM rate_limits");
}
async function person() {
  await clearRate();
  const b = new Browser(),
    email = `identity-${uid()}@example.test`;
  const { user } = await b.json("/api/auth/sign-up/email", {
    email,
    password,
    name: "Identity Fixture",
  });
  await server.app.db.pool.query(
    'UPDATE "user" SET "emailVerified"=true WHERE id=$1',
    [user.id],
  );
  await b.json("/api/auth/sign-in/email", { email, password });
  const ws = uid();
  await server.app.db.pool.query(
    "INSERT INTO workspaces(id,slug,name) VALUES($1,$1,'Identity fixture')",
    [ws],
  );
  await server.app.db.pool.query(
    "INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,'owner')",
    [ws, user.id],
  );
  return { b, user, ws, email };
}
async function step(b: Browser) {
  await clearRate();
  return b.json("/v2/identity/step-up", { password });
}
async function enroll(w: Awaited<ReturnType<typeof person>>) {
  await step(w.b);
  const setup = await w.b.json("/api/auth/two-factor/enable", {
    password,
    method: "totp",
  });
  const secret = Buffer.from(
    base32.decode(new URL(setup.totpURI).searchParams.get("secret")!),
  ).toString();
  await clearRate();
  await w.b.json("/api/auth/two-factor/verify-totp", {
    code: await createOTP(secret).totp(),
  });
  return { ...setup, secret };
}
async function configure(w: Awaited<ReturnType<typeof person>>) {
  await step(w.b);
  const data = await w.b.json(
    `/v2/workspaces/${w.ws}/identity/provider`,
    {
      name: "Local OIDC",
      issuer,
      clientId: "fixture-client",
      clientSecret: "fixture-secret",
      enabled: true,
      revision: 0,
    },
    "PUT",
  );
  return data.provider;
}
async function start(b: Browser, id: string, link = false) {
  await clearRate();
  return b.json(link ? "/api/auth/link-social" : "/api/auth/sign-in/social", {
    provider: `oidc-${id}`,
  });
}
async function callback(b: Browser, url: string) {
  const redirected = await fetch(url, { redirect: "manual" });
  assert.equal(redirected.status, 302);
  const dest = new URL(redirected.headers.get("location")!);
  return b.call(dest.pathname + dest.search);
}
before(async () => {
  const portReservation = createServer();
  await new Promise<void>((r) => portReservation.listen(0, "127.0.0.1", r));
  config.FIELDKIT_PORT = (portReservation.address() as { port: number }).port;
  config.FIELDKIT_URL = `http://127.0.0.1:${config.FIELDKIT_PORT}`;
  await new Promise<void>((r) => portReservation.close(() => r()));
  const keys = await generateKeyPair("RS256");
  privateKey = keys.privateKey;
  jwk = { ...(await exportJWK(keys.publicKey)), kid: "fixture" };
  await new Promise<void>((r) => idp.listen(0, "127.0.0.1", r));
  issuer = `http://127.0.0.1:${(idp.address() as any).port}`;
  config.FIELDKIT_OIDC_ISSUERS = issuer;
  config.FIELDKIT_CLAM_HOST = "identity-test-scanner";
  await resetDatabase(config.DATABASE_URL);
  server = await createApp(config, {
    migrate: true,
    scanner: {
      health: async () => ({
        engine: "Local fixture",
        signaturesAt: new Date().toISOString(),
      }),
      scan: async () => ({
        engine: "Local fixture",
        signaturesAt: new Date().toISOString(),
        scannedAt: new Date().toISOString(),
        clean: true,
      }),
    },
    mailer: async (_to, _subject, text, options) => {
      if (failDelivery && options?.messageId)
        throw Object.assign(new Error("Synthetic transport refusal"), {
          code: "ECONNREFUSED",
        });
      sentMail.push({ text, options });
    },
  });
  await new Promise<void>((resolve, reject) => {
    server.server.once("error", reject);
    server.server.listen(config.FIELDKIT_PORT, "127.0.0.1", resolve);
  });
});
after(async () => {
  await server?.close();
  idp.closeAllConnections();
  await new Promise<void>((r) => idp.close(() => r()));
});

test("TOTP requires confirmed enrollment; encrypted secrets and hashed recovery; password challenge blocks APIs and concurrent recovery is single-use", async () => {
  const w = await person();
  const oldSession = new Browser();
  await oldSession.json("/api/auth/sign-in/email", {
    email: w.email,
    password,
  });
  assert.equal(
    (await w.b.call("/api/auth/two-factor/enable", { password })).status,
    403,
  );
  await step(w.b);
  const setup = await w.b.json("/api/auth/two-factor/enable", {
    password,
    method: "totp",
  });
  const secret = Buffer.from(
    base32.decode(new URL(setup.totpURI).searchParams.get("secret")!),
  ).toString();
  const raw = await server.app.db.one(
    'SELECT * FROM "twoFactor" WHERE "userId"=$1',
    [w.user.id],
  );
  assert.equal(raw!.verified, false);
  assert.equal(
    (
      await w.b.call("/api/auth/two-factor/verify-backup-code", {
        code: setup.backupCodes[0],
      })
    ).status,
    403,
  );
  assert.equal((await w.b.json("/v2/identity/me")).mfaVerified, false);
  assert.ok(!raw!.secret.includes(secret));
  for (const code of setup.backupCodes)
    assert.ok(!raw!.backupCodes.includes(code));
  await clearRate();
  assert.notEqual(
    (await w.b.call("/api/auth/two-factor/verify-totp", { code: "not-a-code" }))
      .status,
    200,
  );
  const code = await createOTP(secret).totp();
  await w.b.json("/api/auth/two-factor/verify-totp", { code });
  assert.equal((await w.b.json("/v2/identity/me")).mfaVerified, true);
  assert.equal((await oldSession.call("/v2/me")).status, 401);
  assert.equal(
    (await w.b.call("/api/auth/two-factor/verify-totp", { code })).status,
    403,
  );
  const next = new Browser();
  await clearRate();
  assert.equal(
    (await next.json("/api/auth/sign-in/email", { email: w.email, password }))
      .twoFactorRedirect,
    true,
  );
  assert.equal((await next.call("/v2/me")).status, 401);
  assert.equal(
    (await next.call(`/v2/workspaces/${w.ws}/conversations`)).status,
    401,
  );
  await clearRate();
  const other = new Browser();
  await other.json("/api/auth/sign-in/email", { email: w.email, password });
  const results = await Promise.all([
    next.call("/api/auth/two-factor/verify-backup-code", {
      code: setup.backupCodes[0],
    }),
    other.call("/api/auth/two-factor/verify-backup-code", {
      code: setup.backupCodes[0],
    }),
  ]);
  assert.equal(results.filter((r) => r.status === 200).length, 1);
  const winner = results[0].status === 200 ? next : other;
  assert.equal((await winner.json("/v2/identity/me")).mfaVerified, true);
  assert.equal(
    (await winner.call(`/v2/workspaces/${w.ws}/conversations`)).status,
    200,
  );
  await step(winner);
  await clearRate();
  const regen = await winner.json(
    "/api/auth/two-factor/generate-backup-codes",
    { password },
  );
  assert.equal(regen.backupCodes.length, 10);
  assert.equal((await w.b.call("/v2/me")).status, 401);
  await clearRate();
  await winner.json("/api/auth/two-factor/disable", { password });
  assert.equal((await winner.json("/v2/identity/me")).twoFactorEnabled, false);
});

test("OIDC links only an authenticated invited member, uses PKCE/nonce, rotates session, and rejects invalid or replayed transactions", async () => {
  const w = await person(),
    p = await configure(w);
  idpEmail = w.email;
  providerClaims = {};
  const unlinked = new Browser();
  const denied = await callback(unlinked, (await start(unlinked, p.id)).url);
  assert.ok(denied.headers.get("location")?.includes("error="));
  assert.equal((await unlinked.call("/v2/me")).status, 401);
  const before = await w.b.json("/api/auth/get-session");
  const linked = await callback(w.b, (await start(w.b, p.id, true)).url);
  assert.equal(linked.status, 302, await linked.text());
  assert.ok(!linked.headers.get("location")?.includes("error="));
  const after = await w.b.json("/api/auth/get-session");
  assert.notEqual(after.session.id, before.session.id);
  assert.equal(
    (await server.app.db.one(
      'SELECT count(*)::int n FROM account WHERE "userId"=$1 AND "providerId"=$2',
      [w.user.id, `oidc-${p.id}`],
    ))!.n,
    1,
  );
  const signin = new Browser(),
    started = await start(signin, p.id),
    redirect = await fetch(started.url, { redirect: "manual" }),
    dest = new URL(redirect.headers.get("location")!);
  const ok = await signin.call(dest.pathname + dest.search);
  assert.equal(ok.status, 302);
  assert.equal(
    (await signin.call(`/v2/workspaces/${w.ws}/conversations`)).status,
    200,
  );
  assert.equal((await signin.call(dest.pathname + dest.search)).status, 403);
  assert.equal(
    (
      await signin.call(
        `/api/auth/callback/oidc-${p.id}?state=bogus&code=bogus`,
      )
    ).status,
    403,
  );
  await clearRate();
  assert.equal(
    (
      await signin.call("/api/auth/sign-in/social", {
        provider: `oidc-${p.id}`,
        callbackURL: "https://attacker.example/",
      })
    ).status,
    403,
  );
  for (const claims of [
    { nonce: "wrong" },
    { iss: issuer + "/other" },
    { aud: "wrong-client" },
    { exp: 1 },
  ]) {
    providerClaims = claims;
    const b = new Browser();
    const result = await callback(b, (await start(b, p.id)).url);
    assert.notEqual(
      result.headers.get("location"),
      config.FIELDKIT_URL + `/?workspace=${w.ws}`,
    );
    assert.equal((await b.call("/v2/me")).status, 401);
  }
  providerClaims = {};
  const stranger = await person();
  await step(stranger.b);
  assert.equal(
    (
      await stranger.b.call("/api/auth/link-social", {
        provider: `oidc-${p.id}`,
      })
    ).status,
    403,
  );
});

test("MFA is required after SSO too; policy changes gate existing sessions and preserve a configured recovery owner", async () => {
  const w = await person(),
    mfa = await enroll(w),
    p = await configure(w);
  idpEmail = w.email;
  providerClaims = {};
  await callback(w.b, (await start(w.b, p.id, true)).url);
  const b = new Browser(),
    result = await callback(b, (await start(b, p.id)).url);
  assert.equal(result.headers.get("location"), config.FIELDKIT_URL + "/?mfa=1");
  assert.equal((await b.call("/v2/me")).status, 401);
  await clearRate();
  await b.json("/api/auth/two-factor/verify-backup-code", {
    code: mfa.backupCodes[0],
  });
  assert.equal(
    (await b.call(`/v2/workspaces/${w.ws}/conversations`)).status,
    200,
  );
  await step(b);
  const path = `/v2/workspaces/${w.ws}/identity/policy`;
  assert.equal(
    (
      await b.call(
        path,
        { ssoRequired: true, mfaRequired: true, revision: 0, confirm: true },
        "PUT",
      )
    ).status,
    409,
  );
  config.FIELDKIT_BREAK_GLASS_USERS = w.user.id;
  await b.json(
    path,
    { ssoRequired: true, mfaRequired: true, revision: 0, confirm: true },
    "PUT",
  );
  const basic = await person();
  await server.app.db.pool.query(
    "INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,'agent')",
    [w.ws, basic.user.id],
  );
  assert.equal(
    (await basic.b.call(`/v2/workspaces/${w.ws}/conversations`)).status,
    403,
  );
  assert.equal((await basic.b.call("/v2/identity/me")).status, 200);
  await clearRate();
  assert.equal(
    (await b.call("/api/auth/two-factor/disable", { password })).status,
    403,
  );
  const local = new Browser();
  await clearRate();
  await local.json("/api/auth/sign-in/email", { email: w.email, password });
  await local.json("/api/auth/two-factor/verify-backup-code", {
    code: mfa.backupCodes[1],
  });
  await step(local);
  assert.equal(
    (await local.call(`/v2/workspaces/${w.ws}/identity`)).status,
    200,
  );
  await local.json(
    path,
    { ssoRequired: false, mfaRequired: false, revision: 1, confirm: true },
    "PUT",
  );
});

test("failed account linking cannot grant SSO proof; callback cannot switch workspace and unsafe discovery is rejected", async () => {
  const w = await person(),
    p = await configure(w);
  idpEmail = w.email;
  providerClaims = {};
  const other = await person(),
    foreign = await configure(other);
  const started = await start(w.b, p.id, true),
    redirect = await fetch(started.url, { redirect: "manual" }),
    dest = new URL(redirect.headers.get("location")!);
  assert.equal(
    (await w.b.call(dest.pathname.replace(p.id, foreign.id) + dest.search))
      .status,
    403,
  );
  idpEmail = "different@example.test";
  providerClaims = { email: "different@example.test" };
  const before = await w.b.json("/api/auth/get-session"),
    failed = await callback(w.b, (await start(w.b, p.id, true)).url);
  assert.match(failed.headers.get("location") ?? "", /error=/);
  const after = await w.b.json("/api/auth/get-session");
  assert.equal(after.session.id, before.session.id);
  assert.equal(
    (await server.app.db.one(
      "SELECT provider_id FROM staff_session_security WHERE session_id=$1",
      [after.session.id],
    ))!.provider_id,
    null,
  );
  providerClaims = {};
  idpEmail = w.email;
  await callback(w.b, (await start(w.b, p.id, true)).url);
  await server.app.db.pool.query(
    "INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,'agent')",
    [w.ws, other.user.id],
  );
  await step(other.b);
  const conflicting = await callback(
    other.b,
    (await start(other.b, p.id, true)).url,
  );
  assert.match(conflicting.headers.get("location") ?? "", /error=/);
  assert.equal(
    (await server.app.db.one(
      'SELECT count(*)::int n FROM account WHERE "userId"=$1 AND "providerId"=$2',
      [other.user.id, `oidc-${p.id}`],
    ))!.n,
    0,
  );
  const unsafe = await person();
  await step(unsafe.b);
  const blocked = await unsafe.b.call(
    `/v2/workspaces/${unsafe.ws}/identity/provider`,
    {
      name: "Unsafe",
      issuer: "http://169.254.169.254",
      clientId: "x",
      clientSecret: "x",
      enabled: true,
      revision: 0,
    },
    "PUT",
  );
  assert.equal(blocked.status, 400);
});

test("MFA proof persists across a recreated auth instance and factor removal cannot race an enforced policy", async () => {
  const w = await person();
  await enroll(w);
  const initial = await w.b.json("/api/auth/get-session");
  const { createAuth, principal } = await import(
    "../packages/platform/src/auth.js"
  );
  const restarted = createAuth(server.app.db, async () => {});
  const cookie = [...w.b.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
  const p = await principal(
    server.app.db,
    restarted,
    { headers: { cookie } } as any,
    w.ws,
  );
  assert.equal(p.userId, w.user.id);
  config.FIELDKIT_BREAK_GLASS_USERS = w.user.id;
  const q = await server.app.db.pool.connect();
  try {
    await q.query("BEGIN");
    await q.query('SELECT id FROM "user" WHERE id=$1 FOR UPDATE', [w.user.id]);
    await q.query(
      "INSERT INTO staff_identity_settings(workspace_id,mfa_required) VALUES($1,true)",
      [w.ws],
    );
    // Actual concurrent update blocks on the user row, then observes the committed policy.
    const attempted = server.app.db.pool.query(
      'UPDATE "user" SET "twoFactorEnabled"=false WHERE id=$1',
      [w.user.id],
    );
    await q.query("COMMIT");
    await assert.rejects(attempted, /policy requires MFA/);
  } finally {
    await q.query("ROLLBACK");
    q.release();
  }
  assert.equal(
    (await server.app.db.one(
      'SELECT "twoFactorEnabled" FROM "user" WHERE id=$1',
      [w.user.id],
    ))!.twoFactorEnabled,
    true,
  );
  await server.app.db.pool.query("DELETE FROM session WHERE id=$1", [
    initial.session.id,
  ]);
  const { requireFreshSession } = await import(
    "../packages/platform/src/identity-auth.js"
  );
  await assert.rejects(
    requireFreshSession(server.app.db, initial.session.id, w.user.id),
    /Verify/,
  );
});

test("complete local help-desk path: billing email, safe attachment, compatible form, routing, saved team view, edited macro, threaded reply, recovery and restricted staff under SSO+MFA", async () => {
  const w = await person(),
    app = server.app,
    prefix = `/v2/workspaces/${w.ws}`;
  const mfa = await enroll(w),
    provider = await configure(w);
  idpEmail = w.email;
  providerClaims = {};
  await callback(w.b, (await start(w.b, provider.id, true)).url);
  const sso = new Browser();
  await callback(sso, (await start(sso, provider.id)).url);
  await clearRate();
  await sso.json("/api/auth/two-factor/verify-backup-code", {
    code: mfa.backupCodes[0],
  });
  await step(sso);
  config.FIELDKIT_BREAK_GLASS_USERS = w.user.id;
  await sso.json(
    prefix + "/identity/policy",
    { ssoRequired: true, mfaRequired: true, revision: 0, confirm: true },
    "PUT",
  );
  const { resolveStaffPrincipal } = await import(
    "../packages/platform/src/permissions.js"
  );
  const owner = await resolveStaffPrincipal(app.db, w.ws, w.user.id);
  await app.db.pool.query(
    "INSERT INTO channels(id,workspace_id,kind) VALUES($1,$2,'portal')",
    [uid(), w.ws],
  );
  const billing = await sso.json(prefix + "/routing/teams", {
    name: "Billing",
    routingEnabled: true,
    memberIds: [w.user.id],
  });
  const technical = await sso.json(prefix + "/routing/teams", {
    name: "Technical",
    memberIds: [],
  });
  await sso.json(
    prefix + "/routing/settings",
    { enabled: true, defaultTeamId: billing.id },
    "PUT",
  );
  await sso.json(
    prefix + "/routing/availability",
    { state: "available" },
    "PUT",
  );
  await sso.json(
    prefix + `/routing/agents/${w.user.id}/capacity`,
    { capacity: 1 },
    "PUT",
  );
  const field = await sso.json(prefix + "/ticket-fields", {
    definition: {
      label: "Invoice reference",
      type: "text",
      customerVisible: true,
      customerEditable: true,
    },
  });
  const internal = await sso.json(prefix + "/ticket-fields", {
    definition: { label: "Internal review", type: "text" },
  });
  await sso.json(prefix + "/ticket-forms", {
    definition: {
      name: "Billing request",
      active: true,
      emailDefault: true,
      defaultTeamId: billing.id,
      fields: [{ fieldId: field.id, required: true }],
    },
  });
  const address = `billing@${w.ws}.example.test`,
    mailSetup = await sso.json(prefix + "/ticket-email", { address }, "PUT");
  const row = mailSetup.addresses.find((a: any) => a.address === address),
    { id: addressId, integrationId, ...addressOptions } = row;
  await sso.json(
    prefix + `/ticket-email/addresses/${addressId}`,
    { ...addressOptions, defaultTeamId: billing.id, acknowledge: false },
    "PUT",
  );
  await app.attachments.settings(owner, { enabled: true, anonymous: false });
  const basic =
      "Basic " +
      Buffer.from(`fieldkit:${mailSetup.password}`).toString("base64"),
    payload = {
      MessageID: uid(),
      OriginalRecipient: address,
      FromFull: {
        Email: "billing-customer@example.test",
        Name: "Synthetic customer",
      },
      Subject: "Invoice assistance",
      TextBody: "Please check my invoice.",
      Headers: [{ Name: "Message-ID", Value: `<${uid()}@fixture.test>` }],
      Attachments: [
        {
          Name: "invoice.txt",
          Content: Buffer.from("synthetic attachment").toString("base64"),
          ContentLength: 20,
          ContentType: "text/plain",
        },
      ],
    };
  const webhook = () =>
    fetch(config.FIELDKIT_URL + `/v2/webhooks/email/${w.ws}`, {
      method: "POST",
      headers: { Authorization: basic, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  const accepted = await Promise.all([webhook(), webhook(), webhook()]);
  assert.ok(accepted.every((r) => r.ok));
  const receipt = (await app.db.one(
      "SELECT * FROM email_intake_events WHERE workspace_id=$1 AND provider_id=$2",
      [w.ws, payload.MessageID],
    ))!,
    ticketId = receipt.conversation_id;
  assert.ok(ticketId);
  assert.equal(
    (await app.db.one(
      "SELECT count(*)::int n FROM conversations WHERE workspace_id=$1",
      [w.ws],
    ))!.n,
    1,
  );
  const attachment = (await app.db.one(
    "SELECT * FROM attachments WHERE conversation_id=$1",
    [ticketId],
  ))!;
  assert.equal(attachment.status, "quarantined");
  await assert.rejects(app.attachments.download(owner, attachment.id));
  await app.attachments.scan(w.ws, attachment.id);
  assert.equal(
    (await app.attachments.download(owner, attachment.id)).bytes.toString(),
    "synthetic attachment",
  );
  await app.routing.drain(w.ws);
  let detail = await sso.json(prefix + `/conversations/${ticketId}`);
  assert.equal(detail.conversation.origin, "email");
  assert.equal(detail.conversation.assigned_to, w.user.id);
  const values = await sso.json(prefix + `/conversations/${ticketId}/fields`);
  assert.deepEqual(values.missing, ["Invoice reference"]);
  await sso.json(
    prefix + `/conversations/${ticketId}/fields`,
    { values: { [internal.id]: "private-marker" } },
    "PUT",
  );
  const view = await sso.json(prefix + "/saved-views", {
    definition: {
      name: "Billing queue",
      scope: "team",
      teamId: billing.id,
      filters: [{ field: "team", op: "eq", value: billing.id }],
      columns: ["subject", "priority"],
    },
  });
  assert.equal(
    (await sso.json(prefix + `/saved-views/${view.id}/results`)).total,
    1,
  );
  const macro = await sso.json(prefix + "/macros", {
    definition: {
      name: "Request invoice reference",
      scope: "team",
      teamId: billing.id,
      body: "Hello {{customer.name}}, please send your invoice reference.",
      changes: {
        priority: "high",
        fields: { [field.id]: "Follow-up pending" },
      },
    },
  });
  const preview = await sso.json(
    prefix + `/conversations/${ticketId}/macros/${macro.id}/preview`,
    {},
  );
  assert.equal(
    (await app.db.one(
      "SELECT count(*)::int n FROM messages WHERE conversation_id=$1",
      [ticketId],
    ))!.n,
    1,
  );
  const response = await sso.json(
    prefix + `/conversations/${ticketId}/messages`,
    {
      body: "Edited response: please send the invoice reference.",
      requestKey: uid(),
      macro: preview.macro,
    },
  );
  const outbound = (await app.db.one(
    "SELECT * FROM ticket_emails WHERE message_id=$1",
    [response.id],
  ))!;
  assert.ok(outbound);
  failDelivery = true;
  await app.ticketEmail.deliver(w.ws, outbound.id);
  failDelivery = false;
  assert.equal(
    (await app.db.one("SELECT status FROM ticket_emails WHERE id=$1", [
      outbound.id,
    ]))!.status,
    "failed",
  );
  await app.ticketEmail.retry(owner, outbound.id);
  await app.ticketEmail.deliver(w.ws, outbound.id);
  assert.equal(
    (await app.db.one("SELECT status FROM ticket_emails WHERE id=$1", [
      outbound.id,
    ]))!.status,
    "sent",
  );
  const delivery = sentMail.findLast(
    (m) => m.options?.replyTo && m.text.includes("Edited response"),
  )!;
  assert.ok(delivery);
  const reply = {
    ...payload,
    MessageID: uid(),
    OriginalRecipient: delivery.options.replyTo,
    Attachments: [],
    TextBody: "My reference is INV-100.",
    Headers: [
      { Name: "Message-ID", Value: `<${uid()}@fixture.test>` },
      { Name: "In-Reply-To", Value: delivery.options.messageId },
    ],
  };
  await app.ticketEmail.receive(w.ws, basic, reply);
  assert.equal(
    (await app.db.one(
      "SELECT count(*)::int n FROM conversations WHERE workspace_id=$1",
      [w.ws],
    ))!.n,
    1,
  );
  assert.equal(
    (await app.db.one(
      "SELECT count(*)::int n FROM messages WHERE conversation_id=$1",
      [ticketId],
    ))!.n,
    3,
  );
  const restricted = await person();
  await app.db.pool.query(
    "INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,'agent')",
    [w.ws, restricted.user.id],
  );
  const rmfa = await enroll(restricted);
  idpEmail = restricted.email;
  providerClaims = { sub: "restricted-subject" };
  await callback(
    restricted.b,
    (await start(restricted.b, provider.id, true)).url,
  );
  const rlogin = new Browser();
  await callback(rlogin, (await start(rlogin, provider.id)).url);
  await clearRate();
  await rlogin.json("/api/auth/two-factor/verify-backup-code", {
    code: rmfa.backupCodes[0],
  });
  const role = await sso.json(prefix + "/staff-roles", {
    name: "Technical reader",
    capabilities: ["tickets:read", "views:personal"],
    ticketScope: "team",
  });
  await sso.json(
    prefix + `/staff-roles/members/${restricted.user.id}`,
    { role: "agent", customRoleId: role.id },
    "PUT",
  );
  await app.db.pool.query(
    "INSERT INTO team_members(workspace_id,team_id,user_id) VALUES($1,$2,$3)",
    [w.ws, technical.id, restricted.user.id],
  );
  assert.equal(
    (await rlogin.call(prefix + `/conversations/${ticketId}`)).status,
    401,
  );
  const fresh = new Browser();
  await callback(fresh, (await start(fresh, provider.id)).url);
  await clearRate();
  await fresh.json("/api/auth/two-factor/verify-backup-code", {
    code: rmfa.backupCodes[1],
  });
  assert.equal(
    (await fresh.call(prefix + `/conversations/${ticketId}`)).status,
    404,
  );
  assert.equal(
    (await fresh.call(prefix + `/conversations/${ticketId}/fields`)).status,
    404,
  );
  assert.equal(
    (await fresh.call(prefix + `/saved-views/${view.id}/results`)).status,
    404,
  );
  assert.equal((await fresh.call(prefix + "/identity")).status, 403);
  assert.equal(
    (await fresh.json(prefix + "/conversations")).conversations.length,
    0,
  );
  providerClaims = {};
});
