export const PRODUCTIVITY_SCHEMA = `
CREATE TABLE IF NOT EXISTS ticket_fields(
 workspace_id text NOT NULL REFERENCES workspaces ON DELETE CASCADE,id text NOT NULL,
 definition jsonb NOT NULL,revision integer NOT NULL DEFAULT 1,created_by text NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(workspace_id,id));
CREATE TABLE IF NOT EXISTS ticket_field_versions(
 workspace_id text NOT NULL,field_id text NOT NULL,revision integer NOT NULL,definition jsonb NOT NULL,
 PRIMARY KEY(workspace_id,field_id,revision),FOREIGN KEY(workspace_id,field_id) REFERENCES ticket_fields(workspace_id,id) ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS ticket_forms(
 workspace_id text NOT NULL REFERENCES workspaces ON DELETE CASCADE,id text NOT NULL,
 definition jsonb NOT NULL,revision integer NOT NULL DEFAULT 1,created_by text NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(workspace_id,id));
CREATE TABLE IF NOT EXISTS ticket_form_versions(
 workspace_id text NOT NULL,form_id text NOT NULL,revision integer NOT NULL,definition jsonb NOT NULL,
 PRIMARY KEY(workspace_id,form_id,revision),FOREIGN KEY(workspace_id,form_id) REFERENCES ticket_forms(workspace_id,id) ON DELETE CASCADE);
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS form_id text;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS form_version integer;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS intake_source text NOT NULL DEFAULT 'legacy';
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS tags text[] NOT NULL DEFAULT '{}';
CREATE INDEX IF NOT EXISTS conversations_form ON conversations(workspace_id,form_id,created_at DESC);
CREATE INDEX IF NOT EXISTS conversations_tags ON conversations USING gin(tags);
CREATE TABLE IF NOT EXISTS ticket_intakes(
 workspace_id text NOT NULL,conversation_id text NOT NULL,payload jsonb NOT NULL,
 PRIMARY KEY(workspace_id,conversation_id),
 FOREIGN KEY(workspace_id,conversation_id) REFERENCES conversations(workspace_id,id) ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS ticket_field_values(
 workspace_id text NOT NULL,conversation_id text NOT NULL,field_id text NOT NULL,
 value jsonb NOT NULL,field_revision integer NOT NULL,definition jsonb NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(workspace_id,conversation_id,field_id),
 FOREIGN KEY(workspace_id,conversation_id) REFERENCES conversations(workspace_id,id) ON DELETE CASCADE,
 FOREIGN KEY(workspace_id,field_id) REFERENCES ticket_fields(workspace_id,id));
CREATE INDEX IF NOT EXISTS ticket_field_lookup ON ticket_field_values(workspace_id,field_id,conversation_id);
CREATE INDEX IF NOT EXISTS ticket_field_value_gin ON ticket_field_values USING gin(value);
CREATE TABLE IF NOT EXISTS ticket_macros(
 workspace_id text NOT NULL REFERENCES workspaces ON DELETE CASCADE,id text NOT NULL,
 owner_id text NOT NULL,definition jsonb NOT NULL,revision integer NOT NULL DEFAULT 1,
 updated_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(workspace_id,id));
CREATE TABLE IF NOT EXISTS inbox_views(
 workspace_id text NOT NULL REFERENCES workspaces ON DELETE CASCADE,id text NOT NULL,
 owner_id text NOT NULL,definition jsonb NOT NULL,revision integer NOT NULL DEFAULT 1,
 updated_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(workspace_id,id));
CREATE TABLE IF NOT EXISTS macro_applications(
 workspace_id text NOT NULL,conversation_id text NOT NULL,request_key text NOT NULL,
 macro_id text NOT NULL,macro_revision integer NOT NULL,proposal jsonb NOT NULL,actor_id text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(workspace_id,conversation_id,request_key),
 FOREIGN KEY(workspace_id,conversation_id) REFERENCES conversations(workspace_id,id) ON DELETE CASCADE);
INSERT INTO app_migrations(version) VALUES(21) ON CONFLICT DO NOTHING;
`;
