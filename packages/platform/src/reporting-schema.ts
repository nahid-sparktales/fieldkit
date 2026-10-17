// Additive migration 28. Report artifacts are encrypted and expire after 24 hours.
export const REPORTING_SCHEMA = `
CREATE TABLE IF NOT EXISTS report_dashboards(
 id text PRIMARY KEY,workspace_id text NOT NULL REFERENCES workspaces ON DELETE CASCADE,
 name text NOT NULL,description text NOT NULL DEFAULT '',visibility text NOT NULL CHECK(visibility IN ('personal','workspace')),
 definition jsonb NOT NULL,revision integer NOT NULL DEFAULT 1,created_by text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(workspace_id,id));
CREATE INDEX IF NOT EXISTS report_dashboards_library ON report_dashboards(workspace_id,visibility,created_by,updated_at DESC);
CREATE TABLE IF NOT EXISTS report_schedules(
 id text PRIMARY KEY,workspace_id text NOT NULL, dashboard_id text NOT NULL,created_by text NOT NULL,
 enabled boolean NOT NULL DEFAULT true,revision integer NOT NULL DEFAULT 1,definition jsonb NOT NULL,
 next_run_at timestamptz NOT NULL,last_run_at timestamptz,last_error text,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(workspace_id,id),FOREIGN KEY(workspace_id,dashboard_id) REFERENCES report_dashboards(workspace_id,id) ON DELETE CASCADE);
CREATE INDEX IF NOT EXISTS report_schedules_due ON report_schedules(next_run_at) WHERE enabled;
CREATE TABLE IF NOT EXISTS report_schedule_runs(
 workspace_id text NOT NULL,schedule_id text NOT NULL,due_at timestamptz NOT NULL,
 status text NOT NULL DEFAULT 'queued',error text,created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,schedule_id,due_at),
 FOREIGN KEY(workspace_id,schedule_id) REFERENCES report_schedules(workspace_id,id) ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS report_jobs(
 id text PRIMARY KEY,workspace_id text NOT NULL REFERENCES workspaces ON DELETE CASCADE,
 created_by text NOT NULL,kind text NOT NULL CHECK(kind IN ('csv','dashboard')),
 status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','completed','failed','revoked','expired')),
 request_key text NOT NULL,payload_hash text NOT NULL,snapshot jsonb NOT NULL,
 dashboard_id text,schedule_id text,schedule_creator text,due_at timestamptz,
 artifact_ciphertext text,row_count integer,truncated boolean NOT NULL DEFAULT false,error text,
 required_capabilities jsonb NOT NULL DEFAULT '[]',
 lease_until timestamptz,mail_status text NOT NULL DEFAULT 'disabled',mail_error text,
 created_at timestamptz NOT NULL DEFAULT now(),completed_at timestamptz,
 expires_at timestamptz NOT NULL DEFAULT now()+interval '24 hours',
 UNIQUE(workspace_id,id),UNIQUE(workspace_id,created_by,request_key),
 FOREIGN KEY(workspace_id,dashboard_id) REFERENCES report_dashboards(workspace_id,id) ON DELETE CASCADE,
 FOREIGN KEY(workspace_id,schedule_id) REFERENCES report_schedules(workspace_id,id) ON DELETE CASCADE);
CREATE INDEX IF NOT EXISTS report_jobs_inventory ON report_jobs(workspace_id,created_by,created_at DESC);
ALTER TABLE report_jobs ADD COLUMN IF NOT EXISTS required_capabilities jsonb NOT NULL DEFAULT '[]';
CREATE INDEX IF NOT EXISTS report_jobs_pending ON report_jobs(status,lease_until) WHERE status IN ('queued','running');
INSERT INTO app_migrations(version) VALUES(28) ON CONFLICT DO NOTHING;
`;
