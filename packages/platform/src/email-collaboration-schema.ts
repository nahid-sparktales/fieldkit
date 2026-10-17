/** Migration 25: one durable delivery per recipient; legacy routes retain their AAD. */
export const EMAIL_COLLABORATION_SCHEMA = `
ALTER TABLE ticket_email_routes ADD COLUMN IF NOT EXISTS id text;
UPDATE ticket_email_routes SET id='legacy-'||conversation_id WHERE id IS NULL;
ALTER TABLE ticket_email_routes ALTER COLUMN id SET NOT NULL;
ALTER TABLE ticket_email_routes ADD COLUMN IF NOT EXISTS participant_id text;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_constraint WHERE conname='ticket_email_routes_pkey' AND pg_get_constraintdef(oid)='PRIMARY KEY (conversation_id)') THEN
 ALTER TABLE ticket_email_routes DROP CONSTRAINT ticket_email_routes_pkey;
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='ticket_email_routes_pkey') THEN ALTER TABLE ticket_email_routes ADD PRIMARY KEY(id); END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS ticket_email_requester_route ON ticket_email_routes(conversation_id) WHERE participant_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ticket_email_participant_route ON ticket_email_routes(participant_id) WHERE participant_id IS NOT NULL;
DO $$ BEGIN ALTER TABLE ticket_email_routes ADD CONSTRAINT email_route_participant_fk FOREIGN KEY(workspace_id,participant_id) REFERENCES ticket_participants(workspace_id,id) ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
ALTER TABLE ticket_emails ADD COLUMN IF NOT EXISTS recipients_snapshotted boolean NOT NULL DEFAULT false;
CREATE TABLE IF NOT EXISTS ticket_email_deliveries(
 id text PRIMARY KEY,workspace_id text NOT NULL,email_id text NOT NULL REFERENCES ticket_emails(id) ON DELETE CASCADE,
 recipient_key text NOT NULL,recipient text NOT NULL,kind text NOT NULL CHECK(kind IN ('requester','participant','follower')),
 contact_id text,participant_id text,user_id text,status text NOT NULL DEFAULT 'queued',
 attempts integer NOT NULL DEFAULT 0,error text,message_ref text NOT NULL,
 files jsonb NOT NULL DEFAULT '[]',created_at timestamptz NOT NULL DEFAULT now(),attempted_at timestamptz,sent_at timestamptz,
 UNIQUE(email_id,recipient_key),UNIQUE(workspace_id,id));
CREATE TABLE IF NOT EXISTS ticket_email_delivery_attempts(
 id bigserial PRIMARY KEY,workspace_id text NOT NULL,delivery_id text NOT NULL,attempt integer NOT NULL,status text NOT NULL,error text,
 created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(workspace_id,delivery_id) REFERENCES ticket_email_deliveries(workspace_id,id) ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS email_cc_suggestions(workspace_id text NOT NULL,conversation_id text NOT NULL,email text NOT NULL,status text NOT NULL DEFAULT 'pending',created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(workspace_id,conversation_id,email),FOREIGN KEY(workspace_id,conversation_id) REFERENCES conversations(workspace_id,id) ON DELETE CASCADE);
CREATE INDEX IF NOT EXISTS ticket_email_delivery_pending ON ticket_email_deliveries(workspace_id,status,created_at);
`;
