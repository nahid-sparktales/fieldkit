import Database from 'better-sqlite3';
import { mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { ConfigSchema, DomainError, type Resources, type Run, type Tenant, type TraceEvent, type Snapshot } from './types.js';
export const id = () => randomUUID();
export const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const now = () => new Date().toISOString();
export function redact(text: string): string { return text.replace(/\b(?:sk-|Bearer\s+)[\w.-]+/gi, '[REDACTED]').replace(/\b[\w.+-]+@[\w.-]+\.[a-z]{2,}\b/gi, '[email redacted]'); }
export class Store {
  db: Database.Database;
  dir: string;
  constructor(dir: string) {
    this.dir = resolve(dir); mkdirSync(this.dir, { recursive: true });
    this.db = new Database(join(this.dir, 'application.sqlite'));
    this.db.pragma('journal_mode = WAL'); this.db.pragma('synchronous = FULL'); this.db.pragma('busy_timeout = 5000');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS migrations(version INTEGER PRIMARY KEY);
      INSERT OR IGNORE INTO migrations VALUES(1);
      CREATE TABLE IF NOT EXISTS records(tenant TEXT, kind TEXT, id TEXT, data TEXT NOT NULL, PRIMARY KEY(tenant,kind,id));
      CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY, tenant TEXT NOT NULL, request_key TEXT NOT NULL, data TEXT NOT NULL, UNIQUE(tenant, request_key));
      CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY AUTOINCREMENT, tenant TEXT NOT NULL, run_id TEXT NOT NULL, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS event_scope ON events(tenant,run_id,id);
      CREATE TABLE IF NOT EXISTS jobs(run_id TEXT PRIMARY KEY, tenant TEXT NOT NULL, status TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1);
      CREATE TABLE IF NOT EXISTS runner(singleton INTEGER PRIMARY KEY CHECK(singleton=1), pid INTEGER NOT NULL, token TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS reservations(tenant TEXT, resource TEXT, action TEXT, operation_id TEXT NOT NULL, PRIMARY KEY(tenant,resource,action));
      CREATE TABLE IF NOT EXISTS upstream(id TEXT PRIMARY KEY, tenant TEXT NOT NULL, operation_id TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS reports(id TEXT PRIMARY KEY, tenant TEXT NOT NULL, kind TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS external_tickets(tenant TEXT, provider TEXT, id TEXT, version INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(tenant,provider,id));
      CREATE TABLE IF NOT EXISTS external_writes(tenant TEXT, write_key TEXT, data TEXT NOT NULL, PRIMARY KEY(tenant,write_key));
      CREATE TABLE IF NOT EXISTS inbound_events(tenant TEXT, provider TEXT, event_id TEXT, ticket_id TEXT, sequence INTEGER NOT NULL, run_id TEXT NOT NULL, payload_hash TEXT NOT NULL, PRIMARY KEY(tenant,provider,event_id));
      CREATE TABLE IF NOT EXISTS deliveries(id TEXT PRIMARY KEY, tenant TEXT NOT NULL, event_key TEXT NOT NULL UNIQUE, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS webhook_received(event_id TEXT PRIMARY KEY, tenant TEXT NOT NULL, data TEXT NOT NULL);
    `);
  }
  transaction<T>(fn: () => T): T { return this.db.transaction(fn).immediate(); }
  get<K extends keyof Resources>(tenant: Tenant, kind: K, key: string): Resources[K] | undefined {
    const row = this.db.prepare('SELECT data FROM records WHERE tenant=? AND kind=? AND id=?').get(tenant, kind, key) as { data: string } | undefined;
    return row ? JSON.parse(row.data) : undefined;
  }
  list<K extends keyof Resources>(tenant: Tenant, kind: K): Resources[K][] {
    return (this.db.prepare('SELECT data FROM records WHERE tenant=? AND kind=? ORDER BY id').all(tenant, kind) as { data: string }[]).map(r => JSON.parse(r.data));
  }
  put<K extends keyof Resources>(tenant: Tenant, kind: K, key: string, data: Resources[K]) { this.db.prepare('INSERT INTO records VALUES(?,?,?,?) ON CONFLICT(tenant,kind,id) DO UPDATE SET data=excluded.data').run(tenant, kind, key, JSON.stringify(data)); }
  config(tenant: Tenant) { const c = this.get(tenant, 'config', tenant); if (!c) throw new DomainError(404, 'Deployment not initialized'); return ConfigSchema.parse(c); }
  run(tenant: Tenant, key: string): Run {
    const row = this.db.prepare('SELECT data FROM runs WHERE tenant=? AND id=?').get(tenant, key) as { data: string } | undefined;
    if (!row) throw new DomainError(404, 'Run not found in this tenant'); return JSON.parse(row.data);
  }
  runs(tenant: Tenant): Run[] { return (this.db.prepare('SELECT data FROM runs WHERE tenant=? ORDER BY rowid DESC').all(tenant) as {data: string}[]).map(r => JSON.parse(r.data)); }
  save(run: Run) { this.db.prepare('UPDATE runs SET data=? WHERE tenant=? AND id=?').run(JSON.stringify(run), run.tenant, run.id); }
  event(run: Run, kind: string, detail: Record<string, unknown> = {}, node?: string) {
    const event: Omit<TraceEvent, 'id'> = { schemaVersion: 1, runId: run.id, tenant: run.tenant, at: now(), stage: run.stage, kind, node, graphVersion: run.graphVersion, threadId: run.threadId, invocationId: run.invocationId, detail };
    this.db.prepare('INSERT INTO events(tenant,run_id,data) VALUES(?,?,?)').run(run.tenant, run.id, JSON.stringify(event));
  }
  events(tenant: Tenant, runId: string, after = 0): TraceEvent[] {
    this.run(tenant, runId);
    return (this.db.prepare('SELECT id,data FROM events WHERE tenant=? AND run_id=? AND id>? ORDER BY id').all(tenant, runId, after) as {id: number; data: string}[]).map(r => ({...JSON.parse(r.data), id: r.id}));
  }
  queue(run: Run) { this.db.prepare("INSERT INTO jobs(run_id,tenant,status) VALUES(?,?,'pending') ON CONFLICT(run_id) DO UPDATE SET status='pending', revision=revision+1").run(run.id, run.tenant); }
  snapshot(tenant: Tenant): Snapshot { return { config: this.config(tenant), accounts: this.list(tenant,'account'), invoices: this.list(tenant,'invoice'), subscriptions: this.list(tenant,'subscription'), knowledge: this.list(tenant,'knowledge') }; }
  restore(tenant: Tenant, s: Snapshot) {
    this.put(tenant, 'config', tenant, s.config);
    for (const a of s.accounts) this.put(tenant,'account',a.id,a);
    for (const a of s.invoices) this.put(tenant,'invoice',a.id,a);
    for (const a of s.subscriptions) this.put(tenant,'subscription',a.id,a);
    for (const a of s.knowledge) this.put(tenant,'knowledge',a.id,a);
  }
  report(tenant: Tenant, kind: string, data: {id: string}) { this.db.prepare('INSERT OR REPLACE INTO reports VALUES(?,?,?,?)').run(data.id, tenant, kind, JSON.stringify(data)); }
  reports<T>(tenant: Tenant, kind: string): T[] { return (this.db.prepare('SELECT data FROM reports WHERE tenant=? AND kind=? ORDER BY rowid DESC').all(tenant,kind) as {data: string}[]).map(r=>JSON.parse(r.data)); }
  getReport<T>(tenant:Tenant,kind:string,key:string):T|undefined{const row=this.db.prepare('SELECT data FROM reports WHERE tenant=? AND kind=? AND id=?').get(tenant,kind,key) as {data:string}|undefined;return row?JSON.parse(row.data):undefined;}
  close() { this.db.close(); }
}
export const customerRoot = resolve('customers');
export function readCustomerFile(tenant: Tenant, file: string, root = customerRoot): unknown { return JSON.parse(readFileSync(join(root, tenant, file), 'utf8')); }
