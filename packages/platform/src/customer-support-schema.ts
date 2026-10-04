export const CUSTOMER_SUPPORT_SCHEMA = `
CREATE TABLE IF NOT EXISTS channel_workflows(
 workspace_id text NOT NULL REFERENCES workspaces ON DELETE CASCADE,
 channel text NOT NULL CHECK(channel IN ('portal','widget','zendesk')),
 draft jsonb NOT NULL,revision integer NOT NULL DEFAULT 1,published_version integer,
 updated_by text NOT NULL,updated_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(workspace_id,channel));
ALTER TABLE workflow_versions ADD COLUMN IF NOT EXISTS channel text NOT NULL DEFAULT 'default';
ALTER TABLE credentials ADD COLUMN IF NOT EXISTS channel_id text REFERENCES channels ON DELETE CASCADE;
CREATE TABLE IF NOT EXISTS ticket_email_routes(
 workspace_id text NOT NULL,conversation_id text PRIMARY KEY,contact_id text NOT NULL,
 token_hash text UNIQUE NOT NULL,token_ciphertext text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(workspace_id,conversation_id) REFERENCES conversations(workspace_id,id) ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS ticket_emails(
 id text PRIMARY KEY,workspace_id text NOT NULL,conversation_id text NOT NULL,message_id text NOT NULL UNIQUE,
 status text NOT NULL DEFAULT 'queued',attempts integer NOT NULL DEFAULT 0,error text,
 recipient text,message_ref text,created_at timestamptz NOT NULL DEFAULT now(),sent_at timestamptz,attempted_at timestamptz,
 FOREIGN KEY(workspace_id,conversation_id) REFERENCES conversations(workspace_id,id) ON DELETE CASCADE,
 FOREIGN KEY(message_id) REFERENCES messages(id) ON DELETE CASCADE);
ALTER TABLE ticket_emails ADD COLUMN IF NOT EXISTS attempted_at timestamptz;
CREATE INDEX IF NOT EXISTS ticket_emails_workspace ON ticket_emails(workspace_id,status,created_at);
CREATE TABLE IF NOT EXISTS inbound_ticket_emails(
 workspace_id text NOT NULL,provider_id text NOT NULL,conversation_id text NOT NULL,
 status text NOT NULL,error text,created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(workspace_id,provider_id),
 FOREIGN KEY(workspace_id,conversation_id) REFERENCES conversations(workspace_id,id) ON DELETE CASCADE);
`;
