// Additive migration 22. Teams and conversation.team_id are introduced by 19.
export const HUMAN_ROUTING_SCHEMA = `
ALTER TABLE teams ADD COLUMN IF NOT EXISTS routing_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE teams ADD COLUMN IF NOT EXISTS overflow_team_id text;
ALTER TABLE teams ADD COLUMN IF NOT EXISTS overflow_after_minutes integer NOT NULL DEFAULT 30 CHECK(overflow_after_minutes BETWEEN 1 AND 10080);
ALTER TABLE teams ADD COLUMN IF NOT EXISTS last_assigned_user_id text;
CREATE TABLE IF NOT EXISTS team_members(
 workspace_id text NOT NULL,team_id text NOT NULL,user_id text NOT NULL,
 PRIMARY KEY(workspace_id,team_id,user_id),
 FOREIGN KEY(workspace_id,team_id) REFERENCES teams(workspace_id,id) ON DELETE CASCADE,
 FOREIGN KEY(workspace_id,user_id) REFERENCES memberships(workspace_id,user_id) ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS human_routing_settings(
 workspace_id text PRIMARY KEY REFERENCES workspaces ON DELETE CASCADE,
 enabled boolean NOT NULL DEFAULT false,default_team_id text,
 availability_ttl_seconds integer NOT NULL DEFAULT 300 CHECK(availability_ttl_seconds BETWEEN 60 AND 1800),
 FOREIGN KEY(workspace_id,default_team_id) REFERENCES teams(workspace_id,id));
CREATE TABLE IF NOT EXISTS agent_availability(
 workspace_id text NOT NULL,user_id text NOT NULL,
 state text NOT NULL DEFAULT 'offline' CHECK(state IN ('available','away','offline')),
 capacity integer NOT NULL DEFAULT 5 CHECK(capacity BETWEEN 1 AND 200),
 heartbeat_at timestamptz,updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,user_id),
 FOREIGN KEY(workspace_id,user_id) REFERENCES memberships(workspace_id,user_id) ON DELETE CASCADE);
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS assignment_source text CHECK(assignment_source IN ('manual','automatic'));
UPDATE conversations SET assignment_source='manual' WHERE assigned_to IS NOT NULL AND assignment_source IS NULL;
CREATE TABLE IF NOT EXISTS human_queue(
 workspace_id text NOT NULL,conversation_id text NOT NULL,team_id text,origin_team_id text,
 state text NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','assigned','cancelled')),
 reason text NOT NULL DEFAULT 'ready',entered_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),overflowed_at timestamptz,
 last_event_id bigint,selected_user_id text,
 PRIMARY KEY(workspace_id,conversation_id),
 FOREIGN KEY(workspace_id,conversation_id) REFERENCES conversations(workspace_id,id) ON DELETE CASCADE,
 FOREIGN KEY(workspace_id,team_id) REFERENCES teams(workspace_id,id),
 FOREIGN KEY(workspace_id,origin_team_id) REFERENCES teams(workspace_id,id));
CREATE INDEX IF NOT EXISTS human_queue_waiting ON human_queue(workspace_id,entered_at,conversation_id) WHERE state='queued';
CREATE INDEX IF NOT EXISTS human_capacity ON conversations(workspace_id,assigned_to) WHERE status<>'resolved' AND (mode='human' OR status='needs_staff');
CREATE INDEX IF NOT EXISTS team_members_user ON team_members(workspace_id,user_id);
`;
