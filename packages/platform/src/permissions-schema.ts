export const PERMISSIONS_SCHEMA = `
CREATE TABLE IF NOT EXISTS staff_roles(
 workspace_id text NOT NULL REFERENCES workspaces ON DELETE CASCADE,
 id text NOT NULL,name text NOT NULL,description text NOT NULL DEFAULT '',
 capabilities jsonb NOT NULL DEFAULT '[]',ticket_scope text NOT NULL DEFAULT 'assigned' CHECK(ticket_scope IN ('all','team','assigned')),
 revision integer NOT NULL DEFAULT 1,created_by text NOT NULL,updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,id),UNIQUE(workspace_id,name));
ALTER TABLE memberships ADD COLUMN IF NOT EXISTS custom_role_id text;
ALTER TABLE memberships ADD COLUMN IF NOT EXISTS disabled boolean NOT NULL DEFAULT false;
ALTER TABLE memberships ADD COLUMN IF NOT EXISTS auth_revision integer NOT NULL DEFAULT 1;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='memberships_custom_role_tenant') THEN
  ALTER TABLE memberships ADD CONSTRAINT memberships_custom_role_tenant FOREIGN KEY(workspace_id,custom_role_id) REFERENCES staff_roles(workspace_id,id);
 END IF;
END $$;
CREATE TABLE IF NOT EXISTS teams(
 workspace_id text NOT NULL REFERENCES workspaces ON DELETE CASCADE,id text NOT NULL,
 name text NOT NULL DEFAULT 'Team',description text NOT NULL DEFAULT '',active boolean NOT NULL DEFAULT true,
 PRIMARY KEY(workspace_id,id));
CREATE TABLE IF NOT EXISTS team_members(
 workspace_id text NOT NULL,team_id text NOT NULL,user_id text NOT NULL,
 PRIMARY KEY(workspace_id,team_id,user_id),
 FOREIGN KEY(workspace_id,team_id) REFERENCES teams(workspace_id,id) ON DELETE CASCADE,
 FOREIGN KEY(workspace_id,user_id) REFERENCES memberships(workspace_id,user_id) ON DELETE CASCADE);
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS team_id text;
CREATE INDEX IF NOT EXISTS conversations_team_access ON conversations(workspace_id,team_id,updated_at DESC);
CREATE INDEX IF NOT EXISTS conversations_assignee_access ON conversations(workspace_id,assigned_to,updated_at DESC);
`;
