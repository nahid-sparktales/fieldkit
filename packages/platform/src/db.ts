import { Pool, type PoolClient, type QueryResultRow } from "pg";
import { PgBoss } from "pg-boss";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import { randomUUID } from "node:crypto";
import { type Config, HttpError, log } from "./config.js";

export const uid = randomUUID;
export type Queryable = Pick<Pool, "query"> | PoolClient;
export class Database {
  pool: Pool;
  boss: PgBoss;
  saver: PostgresSaver;
  constructor(public config: Config) {
    this.pool = new Pool({ connectionString: config.DATABASE_URL, max: 15 });
    this.pool.on("error", (e) => log("database_error", { message: e.message }));
    this.boss = new PgBoss({
      connectionString: config.DATABASE_URL,
      schema: "jobs",
    });
    this.boss.on("error", (e) => log("queue_error", { message: e.message }));
    this.saver = new PostgresSaver(this.pool, undefined, {
      schema: "checkpoints",
    });
  }
  async rows<T extends QueryResultRow = any>(
    sql: string,
    args: unknown[] = [],
    q: Queryable = this.pool,
  ): Promise<T[]> {
    return (await q.query<T>(sql, args)).rows;
  }
  async one<T extends QueryResultRow = any>(
    sql: string,
    args: unknown[] = [],
    q: Queryable = this.pool,
  ): Promise<T | undefined> {
    return (await this.rows<T>(sql, args, q))[0];
  }
  async tx<T>(fn: (q: PoolClient) => Promise<T>): Promise<T> {
    const q = await this.pool.connect();
    try {
      await q.query("BEGIN");
      const v = await fn(q);
      await q.query("COMMIT");
      return v;
    } catch (e) {
      await q.query("ROLLBACK");
      throw e;
    } finally {
      q.release();
    }
  }
  async enqueue(q: PoolClient, name: string, data: object) {
    return this.boss.send(name, data, {
      db: { executeSql: (sql, values) => q.query(sql, values) },
      retryLimit: 4,
      retryDelay: 5,
      retryBackoff: true,
      expireInSeconds: name === "ingest" ? 1800 : 300,
    });
  }
  async event(
    q: Queryable,
    ws: string,
    kind: string,
    data: object = {},
    conversation?: string,
    publicEvent = false,
  ) {
    await q.query(
      "INSERT INTO events(workspace_id,conversation_id,kind,data,public) VALUES($1,$2,$3,$4,$5)",
      [ws, conversation ?? null, kind, data, publicEvent],
    );
  }
  async connection(ws: string, provider: string) {
    const r = await this.one(
      "SELECT * FROM connections WHERE workspace_id=$1 AND provider=$2 AND status='connected'",
      [ws, provider],
    );
    if (!r) throw new HttpError(409, `Connect ${provider} first`);
    return r;
  }
  async migrate() {
    await this.pool.query(SCHEMA);
    await this.saver.setup();
    await this.boss.start();
    for (const name of [
      "turn",
      "ingest",
      "sync",
      "delivery",
      "maintenance",
      "assist",
    ])
      await this.boss.createQueue(name, {
        retryLimit: 4,
        retryDelay: 5,
        retryBackoff: true,
        expireInSeconds: 300,
      });
  }
  async close() {
    await this.boss.stop({ graceful: true, timeout: 5000 });
    await this.pool.end();
  }
}

const SCHEMA = `
CREATE EXTENSION IF NOT EXISTS vector;
CREATE SCHEMA IF NOT EXISTS checkpoints;
CREATE TABLE IF NOT EXISTS app_migrations(version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS workspaces(
 id text PRIMARY KEY, slug text UNIQUE NOT NULL, name text NOT NULL,
 settings jsonb NOT NULL DEFAULT '{}', revision integer NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS memberships(workspace_id text REFERENCES workspaces ON DELETE CASCADE, user_id text NOT NULL, role text NOT NULL CHECK(role IN ('owner','admin','agent')), PRIMARY KEY(workspace_id,user_id));
CREATE TABLE IF NOT EXISTS invitations(id text PRIMARY KEY, workspace_id text REFERENCES workspaces ON DELETE CASCADE, email text NOT NULL, role text NOT NULL CHECK(role IN ('admin','agent')), token_hash text UNIQUE NOT NULL, expires_at timestamptz NOT NULL, accepted_at timestamptz);
CREATE TABLE IF NOT EXISTS contacts(id text PRIMARY KEY, workspace_id text NOT NULL REFERENCES workspaces ON DELETE CASCADE, user_id text, external_id text, name text NOT NULL DEFAULT '', email text, verified boolean NOT NULL DEFAULT false, mappings jsonb NOT NULL DEFAULT '{}', revision integer NOT NULL DEFAULT 1, UNIQUE(workspace_id,user_id), UNIQUE(workspace_id,external_id), UNIQUE(workspace_id,id));
CREATE TABLE IF NOT EXISTS channels(id text PRIMARY KEY, workspace_id text NOT NULL REFERENCES workspaces ON DELETE CASCADE, kind text NOT NULL CHECK(kind IN ('portal','widget','zendesk')), published boolean NOT NULL DEFAULT false, settings jsonb NOT NULL DEFAULT '{}', UNIQUE(workspace_id,kind));
CREATE TABLE IF NOT EXISTS connections(id text PRIMARY KEY, workspace_id text NOT NULL REFERENCES workspaces ON DELETE CASCADE, provider text NOT NULL, status text NOT NULL, secret text NOT NULL, metadata jsonb NOT NULL DEFAULT '{}', revision integer NOT NULL DEFAULT 1, updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(workspace_id,provider));
CREATE TABLE IF NOT EXISTS oauth_states(hash text PRIMARY KEY, workspace_id text NOT NULL REFERENCES workspaces ON DELETE CASCADE, user_id text NOT NULL, provider text NOT NULL, context jsonb NOT NULL, expires_at timestamptz NOT NULL);
CREATE TABLE IF NOT EXISTS credentials(hash text PRIMARY KEY, workspace_id text NOT NULL REFERENCES workspaces ON DELETE CASCADE, contact_id text, kind text NOT NULL CHECK(kind IN ('widget','service')), scopes text[] NOT NULL DEFAULT '{}', expires_at timestamptz NOT NULL, label text NOT NULL DEFAULT '', FOREIGN KEY(workspace_id,contact_id) REFERENCES contacts(workspace_id,id));
CREATE TABLE IF NOT EXISTS conversations(id text PRIMARY KEY, workspace_id text NOT NULL REFERENCES workspaces ON DELETE CASCADE, contact_id text NOT NULL, channel_id text REFERENCES channels, subject text NOT NULL, status text NOT NULL DEFAULT 'open', mode text NOT NULL DEFAULT 'agent' CHECK(mode IN ('agent','human')), revision integer NOT NULL DEFAULT 1, assigned_to text, external_id text, external_version text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(workspace_id,id), UNIQUE(workspace_id,external_id), FOREIGN KEY(workspace_id,contact_id) REFERENCES contacts(workspace_id,id));
CREATE TABLE IF NOT EXISTS messages(id text PRIMARY KEY, workspace_id text NOT NULL, conversation_id text NOT NULL, role text NOT NULL CHECK(role IN ('customer','assistant','staff','note','system')), body text NOT NULL, citations jsonb NOT NULL DEFAULT '[]', author_id text, request_key text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(workspace_id,conversation_id,request_key), FOREIGN KEY(workspace_id,conversation_id) REFERENCES conversations(workspace_id,id) ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS sources(id text PRIMARY KEY, workspace_id text NOT NULL REFERENCES workspaces ON DELETE CASCADE, kind text NOT NULL CHECK(kind IN ('file','website','notion','google','zendesk')), title text NOT NULL, locator text NOT NULL, visibility text NOT NULL DEFAULT 'staff' CHECK(visibility IN ('staff','customer')), status text NOT NULL DEFAULT 'queued', error text, revision integer NOT NULL DEFAULT 1, active boolean NOT NULL DEFAULT true, metadata jsonb NOT NULL DEFAULT '{}', last_synced timestamptz, UNIQUE(workspace_id,id));
CREATE TABLE IF NOT EXISTS documents(id text PRIMARY KEY, workspace_id text NOT NULL, source_id text NOT NULL, version integer NOT NULL, title text NOT NULL, body text NOT NULL, hash text NOT NULL, active boolean NOT NULL DEFAULT true, published boolean NOT NULL DEFAULT false, slug text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(source_id,version), UNIQUE(workspace_id,id), FOREIGN KEY(workspace_id,source_id) REFERENCES sources(workspace_id,id) ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS chunks(id text PRIMARY KEY, workspace_id text NOT NULL, document_id text NOT NULL, position integer NOT NULL, body text NOT NULL, embedding vector(1536), embedding_model text, search tsvector GENERATED ALWAYS AS (to_tsvector('english',body)) STORED, FOREIGN KEY(workspace_id,document_id) REFERENCES documents(workspace_id,id) ON DELETE CASCADE);
CREATE INDEX IF NOT EXISTS chunk_text ON chunks USING gin(search);
CREATE INDEX IF NOT EXISTS chunk_workspace ON chunks(workspace_id);
CREATE TABLE IF NOT EXISTS actions(id text PRIMARY KEY, workspace_id text NOT NULL REFERENCES workspaces ON DELETE CASCADE, name text NOT NULL, description text NOT NULL, kind text NOT NULL CHECK(kind IN ('stripe_refund','stripe_cancel','custom_read','custom_write')), enabled boolean NOT NULL DEFAULT false, revision integer NOT NULL DEFAULT 1, config jsonb NOT NULL DEFAULT '{}', policy jsonb NOT NULL DEFAULT '{"mode":"approval"}', UNIQUE(workspace_id,name), UNIQUE(workspace_id,id));
CREATE TABLE IF NOT EXISTS runs(id text PRIMARY KEY, workspace_id text NOT NULL, conversation_id text NOT NULL, revision integer NOT NULL, status text NOT NULL DEFAULT 'queued', state jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(conversation_id,revision), UNIQUE(workspace_id,id), FOREIGN KEY(workspace_id,conversation_id) REFERENCES conversations(workspace_id,id) ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS approvals(id text PRIMARY KEY, workspace_id text NOT NULL, run_id text NOT NULL, action_id text NOT NULL, proposal jsonb NOT NULL, hash text NOT NULL, status text NOT NULL DEFAULT 'pending', decision_by text, decision_at timestamptz, expires_at timestamptz NOT NULL DEFAULT now()+interval '24 hours', UNIQUE(run_id), FOREIGN KEY(workspace_id,run_id) REFERENCES runs(workspace_id,id) ON DELETE CASCADE, FOREIGN KEY(workspace_id,action_id) REFERENCES actions(workspace_id,id));
CREATE TABLE IF NOT EXISTS operations(id text PRIMARY KEY, workspace_id text NOT NULL, run_id text NOT NULL, action_id text NOT NULL, proposal_hash text NOT NULL, resource text NOT NULL, status text NOT NULL DEFAULT 'prepared', receipt jsonb, error text, sent_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(run_id), FOREIGN KEY(workspace_id,run_id) REFERENCES runs(workspace_id,id) ON DELETE CASCADE);
CREATE UNIQUE INDEX IF NOT EXISTS active_resource ON operations(workspace_id,resource) WHERE status IN ('prepared','sent','unknown');
CREATE TABLE IF NOT EXISTS usage(id text PRIMARY KEY, workspace_id text NOT NULL REFERENCES workspaces ON DELETE CASCADE, run_id text, kind text NOT NULL, model text NOT NULL, input_tokens integer NOT NULL DEFAULT 0, output_tokens integer NOT NULL DEFAULT 0, reserved integer NOT NULL DEFAULT 0, created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS usage_month ON usage(workspace_id,created_at);
CREATE TABLE IF NOT EXISTS events(id bigserial PRIMARY KEY, workspace_id text NOT NULL REFERENCES workspaces ON DELETE CASCADE, conversation_id text, kind text NOT NULL, data jsonb NOT NULL, public boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS event_conversation ON events(workspace_id,conversation_id,id);
CREATE TABLE IF NOT EXISTS inbound_events(workspace_id text NOT NULL REFERENCES workspaces ON DELETE CASCADE, provider text NOT NULL, event_id text NOT NULL, hash text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(workspace_id,provider,event_id));
CREATE TABLE IF NOT EXISTS deliveries(id text PRIMARY KEY, workspace_id text NOT NULL, conversation_id text NOT NULL, payload jsonb NOT NULL, status text NOT NULL DEFAULT 'pending', attempts integer NOT NULL DEFAULT 0, error text, receipt jsonb, created_at timestamptz NOT NULL DEFAULT now(), FOREIGN KEY(workspace_id,conversation_id) REFERENCES conversations(workspace_id,id) ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS rate_limits(key text PRIMARY KEY, count integer NOT NULL, expires_at timestamptz NOT NULL);
CREATE TABLE IF NOT EXISTS worker_heartbeats(id text PRIMARY KEY, last_seen timestamptz NOT NULL DEFAULT now());
ALTER TABLE operations ADD COLUMN IF NOT EXISTS context jsonb NOT NULL DEFAULT '{}';
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS external_requester_id text;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS graph_version text NOT NULL DEFAULT 'support-v2';
ALTER TABLE documents ADD COLUMN IF NOT EXISTS locator text NOT NULL DEFAULT '';
ALTER TABLE documents DROP CONSTRAINT IF EXISTS documents_source_id_version_key;
CREATE UNIQUE INDEX IF NOT EXISTS document_page_version ON documents(source_id,locator,version);
ALTER TABLE sources DROP CONSTRAINT IF EXISTS sources_kind_check;
ALTER TABLE sources ADD CONSTRAINT sources_kind_check CHECK(kind IN ('file','website','notion','google','zendesk','faq','article'));
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS priority text NOT NULL DEFAULT 'normal';
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS category text NOT NULL DEFAULT '';
CREATE TABLE IF NOT EXISTS assistance_tasks(
 id text PRIMARY KEY, workspace_id text NOT NULL REFERENCES workspaces ON DELETE CASCADE,
 conversation_id text, conversation_revision integer, created_by text NOT NULL,
 kind text NOT NULL, status text NOT NULL DEFAULT 'queued', instructions text NOT NULL DEFAULT '',
 completed integer NOT NULL DEFAULT 0, total integer NOT NULL DEFAULT 1, document_count integer NOT NULL DEFAULT 0,
 output jsonb NOT NULL DEFAULT '{}', error text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(workspace_id,conversation_id) REFERENCES conversations(workspace_id,id) ON DELETE CASCADE);
CREATE INDEX IF NOT EXISTS assistance_workspace ON assistance_tasks(workspace_id,created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS one_faq_review ON assistance_tasks(workspace_id) WHERE kind='faq_review' AND status IN ('queued','running');
CREATE TABLE IF NOT EXISTS assistance_batches(
 task_id text NOT NULL REFERENCES assistance_tasks ON DELETE CASCADE, position integer NOT NULL,
 document_id text NOT NULL, source_revision integer NOT NULL, chunk_ids text[] NOT NULL,
 done boolean NOT NULL DEFAULT false, PRIMARY KEY(task_id,position));
CREATE TABLE IF NOT EXISTS workflows(workspace_id text PRIMARY KEY REFERENCES workspaces ON DELETE CASCADE,draft jsonb NOT NULL,revision integer NOT NULL DEFAULT 1,published_version integer,updated_by text NOT NULL,updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS workflow_versions(workspace_id text REFERENCES workspaces ON DELETE CASCADE,version integer NOT NULL,title text NOT NULL,definition jsonb NOT NULL,created_by text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(workspace_id,version));
ALTER TABLE runs ADD COLUMN IF NOT EXISTS workflow_definition jsonb;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS workflow_version integer;
DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM app_migrations WHERE version=7) THEN
  ALTER TABLE chunks ALTER COLUMN embedding TYPE vector;
  ALTER TABLE usage ADD COLUMN IF NOT EXISTS provider text NOT NULL DEFAULT 'openai';
END IF; END $$;
INSERT INTO app_migrations(version) VALUES(2) ON CONFLICT DO NOTHING;
INSERT INTO app_migrations(version) VALUES(3) ON CONFLICT DO NOTHING;
INSERT INTO app_migrations(version) VALUES(4) ON CONFLICT DO NOTHING;
INSERT INTO app_migrations(version) VALUES(5) ON CONFLICT DO NOTHING;
INSERT INTO app_migrations(version) VALUES(6) ON CONFLICT DO NOTHING;
INSERT INTO app_migrations(version) VALUES(7) ON CONFLICT DO NOTHING;
`;
