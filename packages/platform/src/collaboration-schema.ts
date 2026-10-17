/** Migration 24: explicit, tenant-bound grants. Existing tickets stay private. */
export const COLLABORATION_SCHEMA = `
CREATE TABLE IF NOT EXISTS customer_organizations(
 id text PRIMARY KEY,workspace_id text NOT NULL REFERENCES workspaces ON DELETE CASCADE,
 name text NOT NULL,description text NOT NULL DEFAULT '',active boolean NOT NULL DEFAULT true,
 revision integer NOT NULL DEFAULT 1,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(workspace_id,id));
CREATE TABLE IF NOT EXISTS customer_organization_memberships(
 workspace_id text NOT NULL,organization_id text NOT NULL,contact_id text NOT NULL,
 role text NOT NULL CHECK(role IN ('member','manager')),active boolean NOT NULL DEFAULT true,
 created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(workspace_id,organization_id,contact_id),
 FOREIGN KEY(workspace_id,organization_id) REFERENCES customer_organizations(workspace_id,id) ON DELETE CASCADE,
 FOREIGN KEY(workspace_id,contact_id) REFERENCES contacts(workspace_id,id) ON DELETE CASCADE);
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS organization_id text;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS sharing text NOT NULL DEFAULT 'private' CHECK(sharing IN ('private','company'));
DO $$ BEGIN ALTER TABLE conversations ADD CONSTRAINT conversation_organization_fk FOREIGN KEY(workspace_id,organization_id) REFERENCES customer_organizations(workspace_id,id); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS actor_contact_id text;
-- Future-only grants compare publication timestamps, not a waiting transaction's start.
ALTER TABLE messages ALTER COLUMN created_at SET DEFAULT clock_timestamp();
ALTER TABLE events ALTER COLUMN created_at SET DEFAULT clock_timestamp();
CREATE TABLE IF NOT EXISTS ticket_participants(
 id text PRIMARY KEY,workspace_id text NOT NULL,conversation_id text NOT NULL,
 contact_id text NOT NULL,portal_contact_id text,email text NOT NULL,
 active boolean NOT NULL DEFAULT true,joined_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 added_by text NOT NULL,revoked_at timestamptz,UNIQUE(workspace_id,id),
 FOREIGN KEY(workspace_id,conversation_id) REFERENCES conversations(workspace_id,id) ON DELETE CASCADE,
 FOREIGN KEY(workspace_id,contact_id) REFERENCES contacts(workspace_id,id),
 FOREIGN KEY(workspace_id,portal_contact_id) REFERENCES contacts(workspace_id,id));
CREATE UNIQUE INDEX IF NOT EXISTS active_ticket_participant ON ticket_participants(workspace_id,conversation_id,lower(email)) WHERE active;
CREATE TABLE IF NOT EXISTS ticket_followers(
 workspace_id text NOT NULL,conversation_id text NOT NULL,user_id text NOT NULL,
 include_notes boolean NOT NULL DEFAULT false,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(workspace_id,conversation_id,user_id),
 FOREIGN KEY(workspace_id,conversation_id) REFERENCES conversations(workspace_id,id) ON DELETE CASCADE,
 FOREIGN KEY(workspace_id,user_id) REFERENCES memberships(workspace_id,user_id) ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS collaboration_invitations(
 id text PRIMARY KEY,workspace_id text NOT NULL REFERENCES workspaces ON DELETE CASCADE,
 kind text NOT NULL CHECK(kind IN ('participant','organization')),email text NOT NULL,
 participant_id text,organization_id text,role text NOT NULL DEFAULT 'member' CHECK(role IN ('member','manager')),
 token_hash text UNIQUE NOT NULL,token_ciphertext text,expires_at timestamptz NOT NULL,
 accepted_at timestamptz,revoked_at timestamptz,created_by text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 status text NOT NULL DEFAULT 'queued',error text,attempted_at timestamptz,sent_at timestamptz,
 FOREIGN KEY(workspace_id,participant_id) REFERENCES ticket_participants(workspace_id,id) ON DELETE CASCADE,
 FOREIGN KEY(workspace_id,organization_id) REFERENCES customer_organizations(workspace_id,id) ON DELETE CASCADE,
 CHECK((kind='participant' AND participant_id IS NOT NULL AND organization_id IS NULL) OR (kind='organization' AND organization_id IS NOT NULL AND participant_id IS NULL)));
CREATE INDEX IF NOT EXISTS collaboration_invitation_pending ON collaboration_invitations(status,expires_at);
`;
