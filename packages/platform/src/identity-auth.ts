import type { BetterAuthPlugin } from "better-auth";
import {
  APIError,
  createAuthMiddleware,
  getSessionFromCtx,
  addOAuthServerContext,
  getOAuthState,
} from "better-auth/api";
import { twoFactor } from "better-auth/plugins";
import { expireCookie, setSessionCookie } from "better-auth/cookies";
import {
  createAuthorizationURL,
  authorizationCodeRequest,
  getOAuth2Tokens,
  verifyProviderIdToken,
  type OAuthProvider,
} from "better-auth/oauth2";
import { createLocalJWKSet, decodeJwt } from "jose";
import type { Database, Queryable } from "./db.js";
import { token, tokenHash, seal, unseal, oidcFetch } from "./security.js";
import { HttpError } from "./config.js";

function fail(message: string): never {
  throw new APIError("FORBIDDEN", { message });
}
const recoveryHash = (code: string) => `sha256:${tokenHash(code)}`;
export async function discoverOidc(db: Database, issuer: string) {
  const base = new URL(issuer);
  if (
    base.search ||
    base.hash ||
    base.username ||
    base.password ||
    issuer.endsWith("/")
  )
    throw new HttpError(
      400,
      "Use the exact issuer URL without a trailing slash, query or credentials",
    );
  const response = await oidcFetch(
    issuer,
    `${issuer}/.well-known/openid-configuration`,
    {},
    db.config.FIELDKIT_OIDC_ISSUERS,
  );
  if (!response.ok) throw new HttpError(400, "OIDC discovery failed");
  const data = (await response.json()) as Record<string, any>;
  if (
    data.issuer !== issuer ||
    !data.code_challenge_methods_supported?.includes("S256")
  )
    throw new HttpError(400, "OIDC issuer must match and support S256 PKCE");
  for (const key of ["authorization_endpoint", "token_endpoint", "jwks_uri"]) {
    const url = new URL(data[key]);
    if (url.origin !== base.origin || url.username || url.password || url.hash)
      throw new HttpError(
        400,
        "OIDC endpoints must remain on the issuer origin",
      );
  }
  const algorithms = (data.id_token_signing_alg_values_supported ?? []).filter(
    (a: string) =>
      ["RS256", "RS384", "RS512", "ES256", "ES384", "ES512", "EdDSA"].includes(
        a,
      ),
  );
  if (!algorithms.length)
    throw new HttpError(
      400,
      "OIDC requires an asymmetric ID-token signing algorithm",
    );
  if (
    data.token_endpoint_auth_methods_supported &&
    !data.token_endpoint_auth_methods_supported.includes("client_secret_basic")
  )
    throw new HttpError(400, "OIDC provider must support client_secret_basic");
  return {
    issuer,
    authorization_endpoint: data.authorization_endpoint,
    token_endpoint: data.token_endpoint,
    jwks_uri: data.jwks_uri,
    algorithms,
  };
}

export async function oidcProvider(
  db: Database,
  row: any,
): Promise<OAuthProvider<Record<string, any>>> {
  const options = {
    clientId: row.client_id,
    clientSecret: unseal<string>(
      db.config.FIELDKIT_ENCRYPTION_KEY,
      `oidc:${row.workspace_id}:${row.id}`,
      row.secret,
    ),
    disableSignUp: true,
    disableImplicitSignUp: true,
    disableIdTokenSignIn: true,
  };
  const fetcher = (url: string, init: Parameters<typeof oidcFetch>[2] = {}) =>
    oidcFetch(row.issuer, url, init, db.config.FIELDKIT_OIDC_ISSUERS);
  const provider: OAuthProvider<Record<string, any>> = {
    id: `oidc-${row.id}`,
    name: row.name,
    issuer: row.issuer,
    requiresIdTokenNonce: true,
    disableSignUp: true,
    disableImplicitSignUp: true,
    options,
    accountSubject: ({ profile }) => profile.sub,
    idToken: {
      issuer: row.issuer,
      audience: row.client_id,
      algorithms: row.metadata.algorithms,
      maxTokenAge: "10m",
      verifyClaims: (c) =>
        typeof c.sub === "string" &&
        typeof c.exp === "number" &&
        typeof c.iat === "number" &&
        c.email_verified === true,
      jwks: async (header, jwt) => {
        const res = await fetcher(row.metadata.jwks_uri);
        if (!res.ok) throw new Error("OIDC signing keys unavailable");
        return createLocalJWKSet((await res.json()) as any)(header, jwt);
      },
    },
    async createAuthorizationURL(data) {
      await db.pool.query(
        `INSERT INTO staff_oidc_transactions(state_hash,workspace_id,provider_id,revision,expires_at) VALUES($1,$2,$3,$4,now()+interval '10 minutes')`,
        [tokenHash(data.state), row.workspace_id, row.id, row.revision],
      );
      return createAuthorizationURL({
        id: provider.id,
        options,
        authorizationEndpoint: row.metadata.authorization_endpoint,
        state: data.state,
        codeVerifier: data.codeVerifier,
        scopes: ["openid", "profile", "email"],
        redirectURI: data.redirectURI,
        nonce: data.idTokenNonce,
      });
    },
    async validateAuthorizationCode(data) {
      const req = await authorizationCodeRequest({
        ...data,
        options,
        tokenEndpoint: row.metadata.token_endpoint,
        tokenEndpointAuth: { method: "client_secret_basic" },
      });
      const res = await fetcher(row.metadata.token_endpoint, {
        method: "POST",
        headers: req.headers,
        body: req.body.toString(),
      });
      if (!res.ok) throw new Error("OIDC code exchange failed");
      const parsed = (await res.json()) as Record<string, any>;
      if (typeof parsed.id_token !== "string")
        throw new Error("OIDC ID token missing");
      // Access/refresh tokens are unnecessary for support sign-in; do not persist them.
      return { idToken: getOAuth2Tokens(parsed).idToken };
    },
    async getUserInfo(tokens) {
      if (
        !tokens.idToken ||
        !tokens.expectedIdTokenNonce ||
        !(await verifyProviderIdToken(
          { ...provider, options: { ...options, disableIdTokenSignIn: false } },
          tokens.idToken,
          tokens.expectedIdTokenNonce,
        ))
      )
        return null;
      const claims = decodeJwt(tokens.idToken),
        state = await getOAuthState();
      if (
        !state ||
        !state.serverContext ||
        state.serverContext.workspaceId !== row.workspace_id ||
        state.serverContext.providerId !== row.id ||
        state.serverContext.revision !== row.revision ||
        typeof claims.email !== "string"
      )
        return null;
      if (
        !(await db.one(
          "SELECT 1 FROM staff_oidc_providers WHERE id=$1 AND workspace_id=$2 AND revision=$3 AND enabled",
          [row.id, row.workspace_id, row.revision],
        ))
      )
        return null;
      const linked = await db.one(
        `SELECT "userId" FROM account WHERE "providerId"=$1 AND "accountId"=$2`,
        [provider.id, claims.sub],
      );
      const userId = state.link?.userId ?? linked?.userId;
      if (
        !userId ||
        (linked && linked.userId !== userId) ||
        !(await db.one(
          "SELECT 1 FROM memberships WHERE workspace_id=$1 AND user_id=$2 AND NOT disabled",
          [row.workspace_id, userId],
        ))
      )
        return null;
      return {
        user: {
          email: claims.email,
          name: typeof claims.name === "string" ? claims.name : claims.email,
          emailVerified: true,
        },
        data: claims,
      };
    },
  };
  return provider;
}

export function staffIdentityPlugins(db: Database) {
  const mfa = twoFactor({
    issuer: "Navigated Support",
    skipVerificationOnEnable: false,
    allowPasswordless: false,
    accountLockout: {
      enabled: true,
      maxFailedAttempts: 8,
      durationSeconds: 900,
    },
    backupCodeOptions: {
      customBackupCodesGenerate: () =>
        Array.from({ length: 10 }, () => token()),
      storeBackupCodes: {
        encrypt: async (raw) =>
          JSON.stringify(
            (JSON.parse(raw) as string[]).map((c) =>
              c.startsWith("sha256:") ? c : recoveryHash(c),
            ),
          ),
        decrypt: async (raw) => raw,
      },
    },
  });
  // Library schema transforms keep its TOTP lifecycle intact while using the deployment encryption key.
  Object.assign(mfa.schema.twoFactor.fields.secret, {
    transform: {
      input: (value: unknown) =>
        seal(db.config.FIELDKIT_ENCRYPTION_KEY, "auth:totp", value),
      output: (value: unknown) =>
        unseal<string>(
          db.config.FIELDKIT_ENCRYPTION_KEY,
          "auth:totp",
          String(value),
        ),
    },
  });
  const original = mfa.hooks.after[0].handler;
  mfa.hooks.after[0] = {
    matcher: (ctx) =>
      ctx.path === "/sign-in/email" || !!ctx.path?.startsWith("/callback/"),
    handler: createAuthMiddleware(async (ctx) => {
      const next = ctx.context.newSession;
      if (!next) return;
      const state = await getOAuthState(),
        providerId = ctx.path?.startsWith("/callback/")
          ? state?.serverContext?.providerId
          : undefined;
      // Never allow a trusted-device cookie to skip staff MFA; remembered sessions retain server-side proof.
      const trust = ctx.context.createAuthCookie("trust_device");
      expireCookie(ctx, trust);
      const oldCookie = ctx.headers?.get("cookie");
      if (ctx.headers && oldCookie)
        ctx.headers.set(
          "cookie",
          oldCookie
            .split(";")
            .filter((v) => !v.trim().startsWith(`${trust.name}=`))
            .join(";"),
        );
      const result = (await original(ctx)) as unknown as {
        headers?: HeadersInit;
        response?: { twoFactorRedirect: boolean; twoFactorMethods: string[] };
      };
      new Headers(result.headers).forEach((value, name) =>
        ctx.setHeader(name, value),
      );
      if (!ctx.context.newSession && typeof providerId === "string") {
        const id = token(),
          cookie = ctx.context.createAuthCookie("fieldkit_sso_pending", {
            maxAge: 600,
          });
        await db.pool.query(
          `INSERT INTO staff_sso_challenges(id,user_id,provider_id,expires_at) VALUES($1,$2,$3,now()+interval '10 minutes')`,
          [tokenHash(id), next.user.id, providerId],
        );
        await ctx.setSignedCookie(
          cookie.name,
          id,
          ctx.context.secret,
          cookie.attributes,
        );
        throw ctx.redirect(`${db.config.FIELDKIT_URL}/?mfa=1`);
      }
      if (ctx.context.newSession && typeof providerId === "string")
        await db.pool.query(
          `INSERT INTO staff_session_security(session_id,user_id,provider_id) VALUES($1,$2,$3) ON CONFLICT(session_id) DO UPDATE SET provider_id=excluded.provider_id`,
          [next.session.id, next.user.id, providerId],
        );
      return result.response;
    }),
  };
  const guard: BetterAuthPlugin = {
    id: "fieldkit-staff-identity",
    hooks: {
      before: [
        {
          matcher: () => true,
          handler: createAuthMiddleware(async (ctx) => {
            const path = ctx.path;
            if (path === "/sign-in/email")
              expireCookie(
                ctx,
                ctx.context.createAuthCookie("fieldkit_sso_pending"),
              );
            if (
              path === "/sign-in/social" ||
              path === "/link-social" ||
              path.startsWith("/callback/")
            ) {
              const id = String(
                path.startsWith("/callback/")
                  ? ctx.params?.id
                  : ctx.body?.provider,
              );
              if (!id.startsWith("oidc-")) return;
              const row = await db.one(
                "SELECT * FROM staff_oidc_providers WHERE id=$1 AND enabled",
                [id.slice(5)],
              );
              if (!row) fail("SSO provider is unavailable");
              if (path.startsWith("/callback/")) {
                if (ctx.method === "GET") {
                  const state = String(ctx.query?.state ?? "");
                  const accepted = await db.one(
                    `UPDATE staff_oidc_transactions SET consumed_at=now() WHERE state_hash=$1 AND provider_id=$2 AND workspace_id=$3 AND revision=$4 AND consumed_at IS NULL AND expires_at>now() RETURNING state_hash`,
                    [tokenHash(state), row.id, row.workspace_id, row.revision],
                  );
                  if (!accepted)
                    fail("SSO transaction is invalid, expired or already used");
                }
              } else {
                for (const key of [
                  "callbackURL",
                  "errorCallbackURL",
                  "newUserCallbackURL",
                ])
                  if (ctx.body?.[key]) {
                    const dest = new URL(ctx.body[key], db.config.FIELDKIT_URL);
                    if (
                      dest.origin !== new URL(db.config.FIELDKIT_URL).origin ||
                      dest.username ||
                      dest.password
                    )
                      fail("Return URL must remain inside this application");
                  }
                if (ctx.body?.idToken)
                  fail("SSO requires authorization code flow");
                if (path === "/link-social") {
                  const session = await getSessionFromCtx(ctx);
                  if (!session) fail("Sign in before linking SSO");
                  const member = await db.one(
                    "SELECT 1 FROM memberships WHERE workspace_id=$1 AND user_id=$2 AND NOT disabled",
                    [row.workspace_id, session.user.id],
                  );
                  if (!member) fail("Workspace membership required");
                  await requireFreshSession(
                    db,
                    session.session.id,
                    session.user.id,
                  ).catch((e) => fail(e.message));
                }
                await addOAuthServerContext({
                  workspaceId: row.workspace_id,
                  providerId: row.id,
                  revision: row.revision,
                });
                ctx.body.callbackURL = `${db.config.FIELDKIT_URL}/?workspace=${encodeURIComponent(row.workspace_id)}`;
                ctx.body.errorCallbackURL = `${db.config.FIELDKIT_URL}/?ssoError=1`;
              }
              const provider = await oidcProvider(db, row);
              ctx.context.socialProviders = [provider];
            }
            if (path === "/unlink-account")
              fail(
                "SSO links are managed through workspace security to preserve recovery access",
              );
            if (path.startsWith("/two-factor/")) {
              if (ctx.body) {
                ctx.body.trustDevice = false;
                ctx.body.disableSession = false;
              }
              if (
                path === "/two-factor/enable" &&
                ctx.body?.method &&
                ctx.body.method !== "totp"
              )
                fail("Use an authenticator app");
              if (path === "/two-factor/verify-backup-code")
                ctx.body.code = recoveryHash(String(ctx.body.code));
              if (
                [
                  "/two-factor/enable",
                  "/two-factor/disable",
                  "/two-factor/generate-backup-codes",
                  "/two-factor/get-totp-uri",
                ].includes(path)
              ) {
                const s = await getSessionFromCtx(ctx);
                if (!s) fail("Sign in first");
                await requireFreshSession(db, s.session.id, s.user.id).catch(
                  (e) => fail(e.message),
                );
                if (
                  path === "/two-factor/disable" &&
                  (await db.one(
                    `SELECT 1 FROM memberships m JOIN staff_identity_settings i ON i.workspace_id=m.workspace_id WHERE m.user_id=$1 AND NOT m.disabled AND (i.mfa_required OR i.sso_required)`,
                    [s.user.id],
                  ))
                )
                  fail(
                    "Workspace policy requires MFA. Ask an owner to change policy before removing your factor",
                  );
              }
              if (
                [
                  "/two-factor/verify-totp",
                  "/two-factor/verify-backup-code",
                ].includes(path)
              ) {
                let userId = (await getSessionFromCtx(ctx))?.user.id;
                if (!userId) {
                  const cookie = ctx.context.createAuthCookie("two_factor");
                  const value = await ctx.getSignedCookie(
                    cookie.name,
                    ctx.context.secret,
                  );
                  if (value) {
                    const pending =
                      await ctx.context.internalAdapter.findVerificationValue(
                        value,
                      );
                    if (pending && pending.expiresAt > new Date())
                      userId = pending.value;
                  }
                }
                if (userId && path === "/two-factor/verify-backup-code") {
                  const active = await db.one(
                    'SELECT 1 FROM "user" u JOIN "twoFactor" f ON f."userId"=u.id WHERE u.id=$1 AND u."twoFactorEnabled" AND f.verified',
                    [userId],
                  );
                  if (!active)
                    fail(
                      "Confirm your authenticator before using recovery codes",
                    );
                }
                if (userId && path === "/two-factor/verify-totp") {
                  const claimed = await db.one(
                    `INSERT INTO staff_totp_uses(user_id,code_hash) VALUES($1,$2) ON CONFLICT(user_id,code_hash) DO UPDATE SET used_at=now() WHERE staff_totp_uses.used_at<now()-interval '2 minutes' RETURNING user_id`,
                    [
                      userId,
                      tokenHash(
                        `${db.config.BETTER_AUTH_SECRET}:${ctx.body.code}`,
                      ),
                    ],
                  );
                  if (!claimed)
                    fail(
                      "This authenticator code was already attempted; wait for a new code",
                    );
                }
              }
            }
          }),
        },
      ],
      after: [
        {
          matcher: (ctx) =>
            !!ctx.path?.startsWith("/two-factor/") ||
            !!ctx.path?.startsWith("/callback/") ||
            ["/change-password", "/reset-password"].includes(ctx.path ?? ""),
          handler: createAuthMiddleware(async (ctx) => {
            const path = ctx.path;
            const successful =
              ctx.context.returned &&
              (!(ctx.context.returned instanceof APIError) ||
                ctx.context.returned.statusCode < 400);
            if (!successful) return;
            let session =
              ctx.context.newSession ??
              ctx.context.session ??
              (await getSessionFromCtx(ctx));
            if (
              [
                "/two-factor/verify-totp",
                "/two-factor/verify-backup-code",
              ].includes(path) &&
              session
            ) {
              if (
                !(await db.one(
                  'SELECT 1 FROM "user" u JOIN "twoFactor" f ON f."userId"=u.id WHERE u.id=$1 AND u."twoFactorEnabled" AND f.verified',
                  [session.user.id],
                ))
              )
                fail("Authenticator enrollment is not confirmed");
              if (
                path === "/two-factor/verify-totp" &&
                ctx.context.session &&
                !ctx.context.session.user.twoFactorEnabled
              ) {
                await db.pool.query(
                  'DELETE FROM session WHERE "userId"=$1 AND id<>$2',
                  [session.user.id, session.session.id],
                );
                await identityAudit(
                  db,
                  session.user.id,
                  "identity.mfa_enrolled",
                );
              }
              const pendingCookie = ctx.context.createAuthCookie(
                  "fieldkit_sso_pending",
                ),
                proof = await ctx.getSignedCookie(
                  pendingCookie.name,
                  ctx.context.secret,
                );
              const sso = proof
                ? await db.one(
                    `DELETE FROM staff_sso_challenges WHERE id=$1 AND user_id=$2 AND expires_at>now() RETURNING provider_id`,
                    [tokenHash(proof), session.user.id],
                  )
                : null;
              expireCookie(ctx, pendingCookie);
              await db.pool.query(
                `INSERT INTO staff_session_security(session_id,user_id,provider_id,mfa_at,step_up_at) VALUES($1,$2,$3,now(),now()) ON CONFLICT(session_id) DO UPDATE SET mfa_at=now(),step_up_at=now(),provider_id=COALESCE(excluded.provider_id,staff_session_security.provider_id)`,
                [session.session.id, session.user.id, sso?.provider_id ?? null],
              );
              await identityAudit(db, session.user.id, "identity.mfa_verified");
            }
            if (path.startsWith("/callback/")) {
              const state = await getOAuthState();
              const callbackLocation = new Headers(
                ctx.context.returned instanceof APIError
                  ? ctx.context.returned.headers
                  : ctx.context.responseHeaders,
              ).get("location");
              const providerId = state?.serverContext?.providerId;
              const linked =
                state?.link && typeof providerId === "string"
                  ? await db.one(
                      'SELECT 1 FROM account WHERE "userId"=$1 AND "providerId"=$2',
                      [state.link.userId, `oidc-${providerId}`],
                    )
                  : null;
              if (
                state?.link &&
                session &&
                linked &&
                callbackLocation === state.callbackURL
              ) {
                const replacement =
                  await ctx.context.internalAdapter.createSession(
                    session.user.id,
                  );
                if (!replacement) fail("Could not rotate linked session");
                await setSessionCookie(ctx, {
                  session: replacement,
                  user: session.user,
                });
                await db.pool.query(
                  `INSERT INTO staff_session_security(session_id,user_id,provider_id,mfa_at,step_up_at) SELECT $1,user_id,$2,mfa_at,step_up_at FROM staff_session_security WHERE session_id=$3`,
                  [
                    replacement.id,
                    state.serverContext?.providerId,
                    session.session.id,
                  ],
                );
                await ctx.context.internalAdapter.deleteSession(
                  session.session.token,
                );
                await identityAudit(db, session.user.id, "identity.sso_linked");
              }
            }
            if (
              [
                "/two-factor/disable",
                "/two-factor/generate-backup-codes",
                "/change-password",
              ].includes(path) &&
              session
            ) {
              await db.pool.query(
                'DELETE FROM session WHERE "userId"=$1 AND id<>$2',
                [session.user.id, session.session.id],
              );
              await identityAudit(
                db,
                session.user.id,
                path === "/change-password"
                  ? "identity.password_changed"
                  : path === "/two-factor/disable"
                    ? "identity.mfa_disabled"
                    : "identity.recovery_regenerated",
              );
            }
          }),
        },
      ],
    },
  };
  return [mfa, guard] as const;
}
export async function identityAudit(
  db: Database,
  userId: string,
  kind: string,
) {
  for (const m of await db.rows(
    "SELECT workspace_id FROM memberships WHERE user_id=$1",
    [userId],
  ))
    await db.event(db.pool, m.workspace_id, kind, { actorId: userId });
}
export async function requireFreshSession(
  db: Database,
  sessionId: string,
  userId: string,
  q: Queryable = db.pool,
) {
  const proof = await db.one(
    `SELECT s.*,u."twoFactorEnabled" FROM staff_session_security s JOIN "user" u ON u.id=s.user_id JOIN session active ON active.id=s.session_id AND active."userId"=s.user_id AND active."expiresAt">now() WHERE s.session_id=$1 AND s.user_id=$2 AND s.step_up_at>now()-interval '5 minutes'`,
    [sessionId, userId],
    q,
  );
  if (!proof || (proof.twoFactorEnabled && !proof.mfa_at))
    throw new HttpError(
      403,
      "Verify your password and authenticator in Security before this sensitive change",
    );
}
export async function staffSessionPolicy(
  db: Database,
  workspaceId: string,
  userId: string,
  sessionId: string,
  q: Queryable = db.pool,
) {
  const row = await db.one(
    `SELECT COALESCE(i.sso_required,false) sso_required,COALESCE(i.mfa_required,false) mfa_required,u."twoFactorEnabled",s.provider_id,s.mfa_at,s.step_up_at,m.role,p.id current_provider,p.enabled FROM memberships m JOIN "user" u ON u.id=m.user_id LEFT JOIN staff_identity_settings i ON i.workspace_id=m.workspace_id LEFT JOIN staff_session_security s ON s.session_id=$3 AND s.user_id=m.user_id LEFT JOIN staff_oidc_providers p ON p.workspace_id=m.workspace_id WHERE m.workspace_id=$1 AND m.user_id=$2 AND NOT m.disabled`,
    [workspaceId, userId, sessionId],
    q,
  );
  if (!row) throw new HttpError(403, "Membership unavailable");
  if (
    (row.mfa_required && !row.twoFactorEnabled) ||
    ((row.mfa_required || row.twoFactorEnabled) && !row.mfa_at)
  )
    throw new HttpError(
      403,
      row.twoFactorEnabled
        ? "MFA_REQUIRED: Confirm your authenticator in Security"
        : "MFA_ENROLLMENT_REQUIRED: Set up an authenticator in Security",
    );
  const breakGlass =
    db.config.FIELDKIT_BREAK_GLASS_USERS.split(",")
      .map((v) => v.trim())
      .includes(userId) &&
    row.role === "owner" &&
    row.mfa_at &&
    row.step_up_at &&
    new Date(row.step_up_at).getTime() > Date.now() - 300000;
  if (
    row.sso_required &&
    !(row.enabled && row.provider_id === row.current_provider) &&
    !breakGlass
  )
    throw new HttpError(
      403,
      "SSO_REQUIRED: Sign in with your workspace SSO provider",
    );
  return row;
}
