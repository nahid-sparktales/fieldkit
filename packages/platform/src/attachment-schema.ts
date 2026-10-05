export const ATTACHMENT_SCHEMA = `
CREATE TABLE IF NOT EXISTS attachment_settings (
 workspace_id text PRIMARY KEY REFERENCES workspaces ON DELETE CASCADE, enabled boolean NOT NULL DEFAULT false,
 anonymous boolean NOT NULL DEFAULT false, revision integer NOT NULL DEFAULT 1, updated_by text
);
CREATE TABLE IF NOT EXISTS attachments (
 id text PRIMARY KEY,workspace_id text NOT NULL REFERENCES workspaces ON DELETE CASCADE,
 conversation_id text, channel_id text NOT NULL REFERENCES channels ON DELETE CASCADE, message_id text REFERENCES messages ON DELETE CASCADE,
 uploader text NOT NULL,uploader_role text NOT NULL DEFAULT 'unknown',contact_id text,visibility text NOT NULL CHECK(visibility IN ('customer','staff')),
 ai_eligible boolean NOT NULL DEFAULT false CHECK(ai_eligible=false), storage_key text NOT NULL UNIQUE,
 display_name text NOT NULL,mime text,client_mime text NOT NULL,bytes bigint NOT NULL CHECK(bytes>=0),hash text,
 status text NOT NULL DEFAULT 'uploading' CHECK(status IN ('uploading','quarantined','scanning','available','blocked','scan_failed','canceled','deleted')),
 generation integer NOT NULL DEFAULT 1,settings_revision integer NOT NULL,request_key text NOT NULL,request_hash text NOT NULL,
 error text,scan jsonb,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(workspace_id,id),UNIQUE(workspace_id,uploader,request_key),
 FOREIGN KEY(workspace_id,conversation_id) REFERENCES conversations(workspace_id,id) ON DELETE CASCADE,
 FOREIGN KEY(workspace_id,contact_id) REFERENCES contacts(workspace_id,id) ON DELETE CASCADE
);
ALTER TABLE inbound_ticket_emails ADD COLUMN IF NOT EXISTS payload_hash text;
CREATE INDEX IF NOT EXISTS attachments_message ON attachments(workspace_id,conversation_id,message_id);
CREATE TABLE IF NOT EXISTS attachment_cleanup_cursor(id integer PRIMARY KEY CHECK(id=1),last_key text NOT NULL);
CREATE INDEX IF NOT EXISTS attachments_cleanup ON attachments(status,updated_at);
ALTER TABLE attachments ADD COLUMN IF NOT EXISTS uploader_role text NOT NULL DEFAULT 'unknown';
`;
