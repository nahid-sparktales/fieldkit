export const TICKET_OPERATIONS_SCHEMA = `
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS reply_version integer NOT NULL DEFAULT 1;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS edit_version integer NOT NULL DEFAULT 1;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS merged_into_id text;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS merged_at timestamptz;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS merged_by text;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='conversation_merge_target') THEN
 ALTER TABLE conversations ADD CONSTRAINT conversation_merge_target FOREIGN KEY(workspace_id,merged_into_id) REFERENCES conversations(workspace_id,id) DEFERRABLE INITIALLY DEFERRED;
 END IF;
END $$;
CREATE INDEX IF NOT EXISTS conversation_merge_group ON conversations(workspace_id,merged_into_id) WHERE merged_into_id IS NOT NULL;
CREATE OR REPLACE FUNCTION ticket_edit_version() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF (to_jsonb(NEW)-ARRAY['edit_version','sla_checked_at','updated_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['edit_version','sla_checked_at','updated_at']) THEN NEW.edit_version=OLD.edit_version+1; END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS ticket_edit_version ON conversations;
CREATE TRIGGER ticket_edit_version BEFORE UPDATE ON conversations FOR EACH ROW EXECUTE FUNCTION ticket_edit_version();
CREATE OR REPLACE FUNCTION ticket_child_edit_version() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 UPDATE conversations SET edit_version=edit_version+1 WHERE workspace_id=NEW.workspace_id AND id=NEW.conversation_id;
 RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION ticket_reply_version() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 UPDATE conversations SET reply_version=reply_version+1 WHERE workspace_id=NEW.workspace_id AND id=NEW.conversation_id AND NEW.role NOT IN ('note','system');
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS ticket_reply_version ON messages;
CREATE TRIGGER ticket_reply_version AFTER INSERT ON messages FOR EACH ROW EXECUTE FUNCTION ticket_reply_version();
DROP TRIGGER IF EXISTS ticket_message_edit_version ON messages;
CREATE TRIGGER ticket_message_edit_version AFTER INSERT ON messages FOR EACH ROW EXECUTE FUNCTION ticket_child_edit_version();
DROP TRIGGER IF EXISTS ticket_field_edit_version ON ticket_field_values;
CREATE TRIGGER ticket_field_edit_version AFTER INSERT OR UPDATE ON ticket_field_values FOR EACH ROW EXECUTE FUNCTION ticket_child_edit_version();
CREATE TABLE IF NOT EXISTS ticket_batches(id text PRIMARY KEY,workspace_id text NOT NULL REFERENCES workspaces ON DELETE CASCADE,actor_id text NOT NULL,request_key text NOT NULL,payload_hash text NOT NULL,action jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(workspace_id,actor_id,request_key));
CREATE TABLE IF NOT EXISTS ticket_batch_items(batch_id text NOT NULL REFERENCES ticket_batches ON DELETE CASCADE,conversation_id text NOT NULL,expected_version integer NOT NULL,status text NOT NULL DEFAULT 'pending',result jsonb,PRIMARY KEY(batch_id,conversation_id));
CREATE TABLE IF NOT EXISTS ticket_merges(workspace_id text NOT NULL REFERENCES workspaces ON DELETE CASCADE,source_id text NOT NULL,target_id text NOT NULL,actor_id text NOT NULL,request_key text NOT NULL,payload_hash text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(workspace_id,source_id),UNIQUE(workspace_id,actor_id,request_key),FOREIGN KEY(workspace_id,source_id) REFERENCES conversations(workspace_id,id) ON DELETE CASCADE,FOREIGN KEY(workspace_id,target_id) REFERENCES conversations(workspace_id,id) ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS ticket_presence(workspace_id text NOT NULL,conversation_id text NOT NULL,user_id text NOT NULL,session_id text NOT NULL,tab_id text NOT NULL,expires_at timestamptz NOT NULL,typing_until timestamptz NOT NULL,PRIMARY KEY(workspace_id,conversation_id,session_id,tab_id),FOREIGN KEY(workspace_id,conversation_id) REFERENCES conversations(workspace_id,id) ON DELETE CASCADE,FOREIGN KEY(workspace_id,user_id) REFERENCES memberships(workspace_id,user_id) ON DELETE CASCADE);
CREATE INDEX IF NOT EXISTS ticket_presence_expiry ON ticket_presence(expires_at);
`;
