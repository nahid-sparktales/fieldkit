export const IDENTITY_SCHEMA = `
CREATE TABLE IF NOT EXISTS staff_identity_settings(
 workspace_id text PRIMARY KEY REFERENCES workspaces ON DELETE CASCADE,
 sso_required boolean NOT NULL DEFAULT false,mfa_required boolean NOT NULL DEFAULT false,
 revision integer NOT NULL DEFAULT 1,updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS staff_oidc_providers(
 id text PRIMARY KEY,workspace_id text NOT NULL UNIQUE REFERENCES workspaces ON DELETE CASCADE,
 name text NOT NULL,issuer text NOT NULL,client_id text NOT NULL,secret text NOT NULL,
 enabled boolean NOT NULL DEFAULT true,revision integer NOT NULL DEFAULT 1,
 metadata jsonb NOT NULL,updated_at timestamptz NOT NULL DEFAULT now(),UNIQUE(workspace_id,id));
CREATE TABLE IF NOT EXISTS staff_oidc_transactions(
 state_hash text PRIMARY KEY,workspace_id text NOT NULL,provider_id text NOT NULL,revision integer NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),expires_at timestamptz NOT NULL,consumed_at timestamptz);
CREATE TABLE IF NOT EXISTS staff_session_security(
 session_id text PRIMARY KEY,user_id text NOT NULL,provider_id text,
 mfa_at timestamptz,step_up_at timestamptz,created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS staff_session_security_user ON staff_session_security(user_id);
CREATE TABLE IF NOT EXISTS staff_sso_challenges(
 id text PRIMARY KEY,user_id text NOT NULL,provider_id text NOT NULL,expires_at timestamptz NOT NULL);
CREATE TABLE IF NOT EXISTS staff_totp_uses(
 user_id text NOT NULL,code_hash text NOT NULL,used_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(user_id,code_hash));
`;

// Install after Better Auth migrations create its user table. Its own factor
// lifecycle and policy writes share these user row locks across all workspaces.
export const IDENTITY_FACTOR_GUARD = `
CREATE OR REPLACE FUNCTION fieldkit_require_staff_mfa() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD."twoFactorEnabled" AND NOT NEW."twoFactorEnabled" AND EXISTS(
   SELECT 1 FROM memberships m JOIN staff_identity_settings i ON i.workspace_id=m.workspace_id
   WHERE m.user_id=OLD.id AND NOT m.disabled AND (i.mfa_required OR i.sso_required)
 ) THEN RAISE EXCEPTION 'Workspace policy requires MFA; disable enforcement before removing this factor' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS fieldkit_staff_mfa_guard ON "user";
CREATE TRIGGER fieldkit_staff_mfa_guard BEFORE UPDATE OF "twoFactorEnabled" ON "user" FOR EACH ROW EXECUTE FUNCTION fieldkit_require_staff_mfa();
`;
