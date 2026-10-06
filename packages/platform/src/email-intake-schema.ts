/** Additive migration 20. Legacy reply credentials and receipts remain valid. */
export const EMAIL_INTAKE_SCHEMA = `
CREATE TABLE IF NOT EXISTS support_email_addresses(
 id text PRIMARY KEY,workspace_id text NOT NULL REFERENCES workspaces ON DELETE CASCADE,
 integration_id text NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
 address text NOT NULL,display_name text NOT NULL DEFAULT '',reply_address text NOT NULL,
 default_team_id text,acknowledge boolean NOT NULL DEFAULT false,workflow_enabled boolean NOT NULL DEFAULT false,
 enabled boolean NOT NULL DEFAULT true,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(workspace_id,id));
CREATE UNIQUE INDEX IF NOT EXISTS support_email_address_unique ON support_email_addresses(lower(address));
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS origin text NOT NULL DEFAULT 'native';
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS support_address_id text;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS team_id text;
CREATE TABLE IF NOT EXISTS email_intake_events(
 id text PRIMARY KEY,workspace_id text NOT NULL REFERENCES workspaces ON DELETE CASCADE,integration_id text NOT NULL,
 provider_id text NOT NULL,payload_hash text NOT NULL,payload_ciphertext text,
 address_id text,conversation_id text,message_id text,
 sender text NOT NULL,subject text NOT NULL DEFAULT '',message_ref text,reply_ref text,references_list jsonb NOT NULL DEFAULT '[]',
 status text NOT NULL DEFAULT 'queued',error text,attempts integer NOT NULL DEFAULT 0,
 available_at timestamptz NOT NULL DEFAULT now(),lease_until timestamptz,lease_token text,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(workspace_id,integration_id,provider_id),UNIQUE(workspace_id,id),
 FOREIGN KEY(workspace_id,conversation_id) REFERENCES conversations(workspace_id,id) ON DELETE CASCADE);
CREATE INDEX IF NOT EXISTS email_intake_pending ON email_intake_events(status,available_at);
CREATE INDEX IF NOT EXISTS email_intake_refs ON email_intake_events(workspace_id,message_ref);
CREATE TABLE IF NOT EXISTS email_intake_attempts(
 id bigserial PRIMARY KEY,workspace_id text NOT NULL,event_id text NOT NULL,attempt integer NOT NULL,
 status text NOT NULL,error text,created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(workspace_id,event_id) REFERENCES email_intake_events(workspace_id,id) ON DELETE CASCADE);
ALTER TABLE ticket_emails ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'reply';
ALTER TABLE ticket_emails ADD COLUMN IF NOT EXISTS last_error_at timestamptz;
CREATE TABLE IF NOT EXISTS ticket_email_attempts(
 id bigserial PRIMARY KEY,workspace_id text NOT NULL,email_id text NOT NULL REFERENCES ticket_emails ON DELETE CASCADE,
 attempt integer NOT NULL,status text NOT NULL,error text,created_at timestamptz NOT NULL DEFAULT now());
INSERT INTO support_email_addresses(id,workspace_id,integration_id,address,reply_address,enabled)
 SELECT 'legacy-'||id,workspace_id,id,lower(metadata->>'address'),lower(metadata->>'address'),false
 FROM connections WHERE provider='ticket_email' AND metadata->>'address' IS NOT NULL
 ON CONFLICT DO NOTHING;
`;
