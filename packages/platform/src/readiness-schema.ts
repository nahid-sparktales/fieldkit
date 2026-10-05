export const READINESS_SCHEMA = `
CREATE TABLE IF NOT EXISTS readiness_settings (
 workspace_id text PRIMARY KEY REFERENCES workspaces ON DELETE CASCADE,
 strict boolean NOT NULL DEFAULT false, updated_by text, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS diagnostic_runs (
 id text PRIMARY KEY, workspace_id text NOT NULL REFERENCES workspaces ON DELETE CASCADE,
 check_id text NOT NULL, definition_version integer NOT NULL, fingerprint text NOT NULL,
 environment text NOT NULL, actor_id text NOT NULL, request_key text NOT NULL, request_hash text NOT NULL,
 risk text NOT NULL, request jsonb NOT NULL, token_cap integer NOT NULL DEFAULT 0 CHECK(token_cap>=0),
 status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','complete','canceled','uncertain')),
 health text NOT NULL DEFAULT 'running', evidence_level text NOT NULL DEFAULT 'configured_untested',
 evidence jsonb NOT NULL DEFAULT '{}', remediation text, cancel_requested boolean NOT NULL DEFAULT false,
 created_at timestamptz NOT NULL DEFAULT now(), started_at timestamptz, finished_at timestamptz,
 effect_started_at timestamptz, UNIQUE(workspace_id,request_key,check_id), UNIQUE(workspace_id,id)
);
CREATE INDEX IF NOT EXISTS diagnostic_recent ON diagnostic_runs(workspace_id,check_id,created_at DESC);
CREATE TABLE IF NOT EXISTS diagnostic_attestations (
 id text PRIMARY KEY, workspace_id text NOT NULL REFERENCES workspaces ON DELETE CASCADE,
 check_id text NOT NULL, run_id text, fingerprint text NOT NULL, actor_id text NOT NULL,
 note text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(workspace_id,run_id) REFERENCES diagnostic_runs(workspace_id,id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS diagnostic_mail_challenges (
 workspace_id text NOT NULL, run_id text PRIMARY KEY, token_hash text UNIQUE NOT NULL,
 sender text NOT NULL, expires_at timestamptz NOT NULL, received_at timestamptz,
 provider_id_hash text, FOREIGN KEY(workspace_id,run_id) REFERENCES diagnostic_runs(workspace_id,id) ON DELETE CASCADE
);
`;
