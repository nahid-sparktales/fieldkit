import type { IncomingMessage } from "node:http";
import { fromNodeHeaders } from "better-auth/node";
import { z } from "zod";
import type { Auth, Principal } from "./auth.js";
import type { Database } from "./db.js";
import { uid } from "./db.js";
import { HttpError } from "./config.js";
import { seal } from "./security.js";
import {
  discoverOidc,
  requireFreshSession,
  staffSessionPolicy,
} from "./identity-auth.js";
import {
  resolveStaffPrincipal,
  refreshPrincipal,
  requireCapability,
} from "./permissions.js";
export class Identity {
  constructor(
    private db: Database,
    private auth: Auth,
  ) {}
  async actor(req: IncomingMessage, ws?: string) {
    if (
      req.headers.authorization ||
      req.headers["x-fieldkit-audience"] === "customer"
    )
      throw new HttpError(403, "Use your staff session for identity settings");
    const s = await this.auth.auth.api.getSession({
      headers: fromNodeHeaders(req.headers),
    });
    if (!s?.user.emailVerified)
      throw new HttpError(401, "Sign in with a verified account");
    const p: Principal = ws
      ? {
          ...(await resolveStaffPrincipal(this.db, ws, s.user.id)),
          sessionId: s.session.id,
        }
      : {
          workspaceId: "",
          role: "agent",
          userId: s.user.id,
          sessionId: s.session.id,
        };
    return { s, p };
  }
  async account(req: IncomingMessage) {
    const { s } = await this.actor(req);
    const proof = await this.db.one(
      "SELECT mfa_at,step_up_at FROM staff_session_security WHERE session_id=$1 AND user_id=$2",
      [s.session.id, s.user.id],
    );
    const providers = await this.db.rows(
      `SELECT p.id,p.name,p.workspace_id,w.name workspace_name,p.enabled,EXISTS(SELECT 1 FROM account a WHERE a."userId"=$1 AND a."providerId"='oidc-'||p.id) linked,COALESCE(i.sso_required,false) sso_required,COALESCE(i.mfa_required,false) mfa_required FROM memberships m JOIN workspaces w ON w.id=m.workspace_id LEFT JOIN staff_oidc_providers p ON p.workspace_id=m.workspace_id LEFT JOIN staff_identity_settings i ON i.workspace_id=m.workspace_id WHERE m.user_id=$1 AND NOT m.disabled`,
      [s.user.id],
    );
    return {
      twoFactorEnabled: !!s.user.twoFactorEnabled,
      mfaVerified: !!proof?.mfa_at,
      stepUpUntil: proof?.step_up_at
        ? new Date(new Date(proof.step_up_at).getTime() + 300000).toISOString()
        : null,
      providers,
    };
  }
  async stepUp(req: IncomingMessage, raw: unknown) {
    const { s } = await this.actor(req),
      { password } = z
        .object({ password: z.string().min(1).max(1024) })
        .strict()
        .parse(raw);
    await this.auth.auth.api.verifyPassword({
      headers: fromNodeHeaders(req.headers),
      body: { password },
    });
    if (
      s.user.twoFactorEnabled &&
      !(await this.db.one(
        "SELECT 1 FROM staff_session_security WHERE session_id=$1 AND user_id=$2 AND mfa_at IS NOT NULL",
        [s.session.id, s.user.id],
      ))
    )
      throw new HttpError(
        403,
        "Confirm your authenticator before changing security settings",
      );
    await this.db.pool.query(
      "INSERT INTO staff_session_security(session_id,user_id,step_up_at) VALUES($1,$2,now()) ON CONFLICT(session_id) DO UPDATE SET step_up_at=now()",
      [s.session.id, s.user.id],
    );
    return { ok: true, expiresInSeconds: 300 };
  }
  async get(p: Principal) {
    requireCapability(p, "identity:manage");
    const policy = (await this.db.one(
      "SELECT sso_required,mfa_required,revision FROM staff_identity_settings WHERE workspace_id=$1",
      [p.workspaceId],
    )) ?? { sso_required: false, mfa_required: false, revision: 0 };
    const provider = await this.db.one(
      "SELECT id,name,issuer,client_id,enabled,revision FROM staff_oidc_providers WHERE workspace_id=$1",
      [p.workspaceId],
    );
    const enrollments = await this.db.rows(
      `SELECT m.user_id,u.name,u.email,m.role,m.disabled,u."twoFactorEnabled" mfa_enabled,EXISTS(SELECT 1 FROM account a JOIN staff_oidc_providers p ON a."providerId"='oidc-'||p.id WHERE p.workspace_id=m.workspace_id AND a."userId"=m.user_id) sso_linked FROM memberships m JOIN "user" u ON u.id=m.user_id WHERE m.workspace_id=$1 ORDER BY u.name`,
      [p.workspaceId],
    );
    return {
      policy,
      provider: provider
        ? {
            ...provider,
            secretConfigured: true,
            callbackURL: `${this.db.config.FIELDKIT_URL}/api/auth/callback/oidc-${provider.id}`,
          }
        : null,
      enrollments,
      operatorRecoveryConfigured:
        this.db.config.FIELDKIT_BREAK_GLASS_USERS.split(",").some((v) =>
          enrollments.some(
            (m) => m.user_id === v.trim() && m.role === "owner" && !m.disabled,
          ),
        ),
    };
  }
  async saveProvider(p: Principal, raw: unknown) {
    requireCapability(p, "identity:manage");
    await requireFreshSession(this.db, p.sessionId!, p.userId!);
    const input = z
      .object({
        name: z.string().trim().min(1).max(80),
        issuer: z.url().max(2048),
        clientId: z.string().trim().min(1).max(500),
        clientSecret: z.string().min(1).max(4096).optional(),
        enabled: z.boolean(),
        revision: z.number().int().min(0),
      })
      .strict()
      .parse(raw);
    const old = await this.db.one(
      "SELECT * FROM staff_oidc_providers WHERE workspace_id=$1",
      [p.workspaceId],
    );
    if ((old?.revision ?? 0) !== input.revision)
      throw new HttpError(409, "Provider changed; reload before saving");
    if (
      old &&
      (old.issuer !== input.issuer || old.client_id !== input.clientId)
    )
      throw new HttpError(
        409,
        "Issuer and client ID are immutable once configured. Disable this provider and use the documented operator recovery procedure before replacing identity associations",
      );
    if (
      !input.enabled &&
      (await this.db.one(
        "SELECT 1 FROM staff_identity_settings WHERE workspace_id=$1 AND sso_required",
        [p.workspaceId],
      ))
    )
      throw new HttpError(
        409,
        "Turn off SSO enforcement before disabling the provider",
      );
    if (!old && !input.clientSecret)
      throw new HttpError(400, "Client secret is required");
    const metadata = await discoverOidc(this.db, input.issuer),
      id = old?.id ?? uid();
    await this.db.tx(async (q) => {
      await q.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        `human-routing:${p.workspaceId}`,
      ]);
      await q.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        `identity:${p.workspaceId}`,
      ]);
      p = await refreshPrincipal(this.db, p, q);
      requireCapability(p, "identity:manage");
      await requireFreshSession(this.db, p.sessionId!, p.userId!, q);
      await staffSessionPolicy(
        this.db,
        p.workspaceId,
        p.userId!,
        p.sessionId!,
        q,
      );
      const current = await this.db.one(
        "SELECT revision FROM staff_oidc_providers WHERE workspace_id=$1 FOR UPDATE",
        [p.workspaceId],
        q,
      );
      if ((current?.revision ?? 0) !== input.revision)
        throw new HttpError(409, "Provider changed; reload before saving");
      const enforced = await this.db.one(
        "SELECT 1 FROM staff_identity_settings WHERE workspace_id=$1 AND sso_required",
        [p.workspaceId],
        q,
      );
      if (!input.enabled && enforced)
        throw new HttpError(409, "Turn off SSO enforcement first");
      await q.query(
        `INSERT INTO staff_oidc_providers(id,workspace_id,name,issuer,client_id,secret,enabled,metadata) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(workspace_id) DO UPDATE SET name=excluded.name,secret=excluded.secret,enabled=excluded.enabled,metadata=excluded.metadata,revision=staff_oidc_providers.revision+1,updated_at=now()`,
        [
          id,
          p.workspaceId,
          input.name,
          input.issuer,
          input.clientId,
          input.clientSecret
            ? seal(
                this.db.config.FIELDKIT_ENCRYPTION_KEY,
                `oidc:${p.workspaceId}:${id}`,
                input.clientSecret,
              )
            : old.secret,
          input.enabled,
          metadata,
        ],
      );
      await this.db.event(q, p.workspaceId, "identity.provider_updated", {
        actorId: p.userId,
        providerId: id,
        enabled: input.enabled,
      });
    });
    return this.get(p);
  }
  async savePolicy(p: Principal, raw: unknown) {
    requireCapability(p, "identity:manage");
    await requireFreshSession(this.db, p.sessionId!, p.userId!);
    const input = z
      .object({
        ssoRequired: z.boolean(),
        mfaRequired: z.boolean(),
        revision: z.number().int().min(0),
        confirm: z.literal(true),
      })
      .strict()
      .parse(raw);
    await this.db.tx(async (q) => {
      await q.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        `human-routing:${p.workspaceId}`,
      ]);
      await q.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        `identity:${p.workspaceId}`,
      ]);
      p = await refreshPrincipal(this.db, p, q);
      requireCapability(p, "identity:manage");
      await requireFreshSession(this.db, p.sessionId!, p.userId!, q);
      await staffSessionPolicy(
        this.db,
        p.workspaceId,
        p.userId!,
        p.sessionId!,
        q,
      );
      const current = await this.db.one(
        "SELECT * FROM staff_identity_settings WHERE workspace_id=$1 FOR UPDATE",
        [p.workspaceId],
        q,
      );
      if ((current?.revision ?? 0) !== input.revision)
        throw new HttpError(409, "Policy changed; reload first");
      if (input.ssoRequired || input.mfaRequired) {
        const recoveryIds = this.db.config.FIELDKIT_BREAK_GLASS_USERS.split(",")
          .map((v) => v.trim())
          .filter(Boolean);
        await q.query(
          'SELECT id FROM "user" WHERE id=ANY($1::text[]) ORDER BY id FOR UPDATE',
          [[...recoveryIds, p.userId]],
        );
        const recovery = await this.db.one(
          `SELECT m.user_id FROM memberships m JOIN "user" u ON u.id=m.user_id WHERE m.workspace_id=$1 AND m.role='owner' AND NOT m.disabled AND u."twoFactorEnabled" AND m.user_id=ANY($2::text[]) AND EXISTS(SELECT 1 FROM account a WHERE a."userId"=m.user_id AND a."providerId"='credential' AND a.password IS NOT NULL)`,
          [p.workspaceId, recoveryIds],
          q,
        );
        if (!recovery)
          throw new HttpError(
            409,
            "Configure an operator-approved owner recovery account with local password and confirmed MFA before enforcing identity policy",
          );
        const self = await this.db.one(
          `SELECT "twoFactorEnabled" FROM "user" WHERE id=$1`,
          [p.userId],
          q,
        );
        if (!self?.twoFactorEnabled)
          throw new HttpError(
            409,
            "Enroll your authenticator before enforcing identity policy",
          );
        if (input.ssoRequired) {
          const linked = await this.db.one(
            `SELECT p.id FROM staff_oidc_providers p JOIN account a ON a."providerId"='oidc-'||p.id AND a."userId"=$2 JOIN staff_session_security s ON s.provider_id=p.id AND s.session_id=$3 WHERE p.workspace_id=$1 AND p.enabled`,
            [p.workspaceId, p.userId, p.sessionId],
            q,
          );
          if (!linked)
            throw new HttpError(
              409,
              "Link and verify your own SSO session before requiring SSO",
            );
        }
      }
      await q.query(
        `INSERT INTO staff_identity_settings(workspace_id,sso_required,mfa_required) VALUES($1,$2,$3) ON CONFLICT(workspace_id) DO UPDATE SET sso_required=excluded.sso_required,mfa_required=excluded.mfa_required,revision=staff_identity_settings.revision+1,updated_at=now()`,
        [p.workspaceId, input.ssoRequired, input.mfaRequired],
      );
      // Every staff request checks current policy and MFA proof; no cached grace period.
      await this.db.event(q, p.workspaceId, "identity.policy_updated", {
        actorId: p.userId,
        ssoRequired: input.ssoRequired,
        mfaRequired: input.mfaRequired,
      });
    });
    return this.get(p);
  }
}
