export const TICKET_AUTOMATION_SCHEMA = `
CREATE TABLE IF NOT EXISTS ticket_automation_rules(
 workspace_id text NOT NULL REFERENCES workspaces ON DELETE CASCADE,id text NOT NULL,
 revision integer NOT NULL DEFAULT 1,active_revision integer,enabled boolean NOT NULL DEFAULT false,
 position integer NOT NULL DEFAULT 0,definition jsonb NOT NULL,configured_by text NOT NULL,activated_by text,
 legacy_sla boolean NOT NULL DEFAULT false,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,id));
CREATE UNIQUE INDEX IF NOT EXISTS ticket_automation_legacy ON ticket_automation_rules(workspace_id) WHERE legacy_sla;
CREATE TABLE IF NOT EXISTS ticket_automation_versions(
 workspace_id text NOT NULL,rule_id text NOT NULL,revision integer NOT NULL,definition jsonb NOT NULL,configured_by text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(workspace_id,rule_id,revision),
 FOREIGN KEY(workspace_id,rule_id) REFERENCES ticket_automation_rules(workspace_id,id) ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS ticket_automation_executions(
 id text PRIMARY KEY,workspace_id text NOT NULL,conversation_id text NOT NULL,rule_id text NOT NULL,rule_revision integer NOT NULL,
 source_key text NOT NULL,source_event_id bigint,source_snapshot jsonb NOT NULL,definition jsonb NOT NULL,
 configured_by text NOT NULL,due_at timestamptz NOT NULL,status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','completed','suppressed','failed')),
 reason text,legacy_wait_id text,legacy_generation integer,created_at timestamptz NOT NULL DEFAULT now(),finished_at timestamptz,
 UNIQUE(workspace_id,rule_id,rule_revision,conversation_id,source_key),UNIQUE(workspace_id,id),
 FOREIGN KEY(workspace_id,rule_id) REFERENCES ticket_automation_rules(workspace_id,id),
 FOREIGN KEY(workspace_id,conversation_id) REFERENCES conversations(workspace_id,id) ON DELETE CASCADE);
CREATE INDEX IF NOT EXISTS ticket_automation_due ON ticket_automation_executions(due_at,id) WHERE status='pending';
CREATE TABLE IF NOT EXISTS ticket_automation_results(
 workspace_id text NOT NULL,execution_id text NOT NULL,action_index integer NOT NULL,kind text NOT NULL,result jsonb NOT NULL DEFAULT '{}',
 created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(workspace_id,execution_id,action_index),
 FOREIGN KEY(workspace_id,execution_id) REFERENCES ticket_automation_executions(workspace_id,id) ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS ticket_automation_followups(
 workspace_id text NOT NULL,conversation_id text NOT NULL,source_message_id text NOT NULL,generation integer NOT NULL DEFAULT 1,
 execution_id text NOT NULL,message_id text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,conversation_id,source_message_id,generation),
 FOREIGN KEY(workspace_id,execution_id) REFERENCES ticket_automation_executions(workspace_id,id) ON DELETE CASCADE,
 FOREIGN KEY(workspace_id,conversation_id) REFERENCES conversations(workspace_id,id) ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS ticket_automation_notifications(
 id text PRIMARY KEY,workspace_id text NOT NULL,execution_id text NOT NULL,action_index integer NOT NULL,recipient_id text NOT NULL,
 body text NOT NULL,email_status text NOT NULL DEFAULT 'disabled',read_at timestamptz,email_attempted_at timestamptz,error text,
 created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(workspace_id,execution_id,action_index,recipient_id),
 FOREIGN KEY(workspace_id,execution_id) REFERENCES ticket_automation_executions(workspace_id,id) ON DELETE CASCADE);
ALTER TABLE messages ADD COLUMN IF NOT EXISTS automation_execution_id text;
ALTER TABLE sla_waits ADD COLUMN IF NOT EXISTS automation_managed boolean NOT NULL DEFAULT false;
`;
