export const CUSTOMER_SCHEMA = `
CREATE TABLE IF NOT EXISTS contact_notes(
 id text PRIMARY KEY,workspace_id text NOT NULL,contact_id text NOT NULL,
 author_id text NOT NULL,body text NOT NULL,request_key text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(workspace_id,contact_id,request_key),
 FOREIGN KEY(workspace_id,contact_id) REFERENCES contacts(workspace_id,id) ON DELETE CASCADE);
CREATE INDEX IF NOT EXISTS contact_notes_customer ON contact_notes(workspace_id,contact_id,created_at DESC,id);
CREATE INDEX IF NOT EXISTS conversations_customer ON conversations(workspace_id,contact_id,updated_at DESC,id);
CREATE INDEX IF NOT EXISTS conversations_inbox ON conversations(workspace_id,updated_at DESC,id);
CREATE INDEX IF NOT EXISTS messages_customer_notes ON messages(workspace_id,conversation_id,created_at DESC) WHERE role='note';
`;
