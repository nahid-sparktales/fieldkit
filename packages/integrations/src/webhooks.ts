import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Store, id, now } from '../../core/src/store.js';
import type { Run, Tenant } from '../../core/src/types.js';
export type WebhookEnvelope={schemaVersion:1;eventId:string;type:string;tenantId:Tenant;runId:string;occurredAt:string;data:{status:string;receiptId?:string;external?:{provider:string;ticketId:string}}};
export type Delivery={id:string;event:WebhookEnvelope;status:'pending'|'delivered'|'failed';attempts:Array<{id:string;at:string;signature:string;status:number}>;destination:'local simulated receiver';maxAttempts:3};
export function signingKey(store:Store){const path=join(store.dir,'webhook-secret');if(!existsSync(path))writeFileSync(path,randomBytes(32).toString('hex'),{mode:0o600,flag:'wx'});return readFileSync(path,'utf8');}
export function sign(key:string,body:string){return createHmac('sha256',key).update(body).digest('hex');}
export function verify(key:string,body:string,signature:string){if(!/^[a-f0-9]{64}$/.test(signature))return false;return timingSafeEqual(Buffer.from(sign(key,body),'hex'),Buffer.from(signature,'hex'));}
export function enqueueWebhook(store:Store,r:Run) {
  const types:Record<string,string>={WAITING_FOR_APPROVAL:'run.waiting_for_approval',COMPLETED:'run.completed',FAILED:'run.failed',UNKNOWN_OUTCOME:'run.unknown_outcome',PARTIAL_COMPLETION:'run.partial_completion',REJECTED:'run.rejected',ESCALATED:'run.escalated'};
  if(!types[r.stage])return;
  const key=`${r.id}:${r.stage}`;
  const event:WebhookEnvelope={schemaVersion:1,eventId:id(),type:types[r.stage],tenantId:r.tenant,runId:r.id,occurredAt:now(),data:{status:r.stage,receiptId:r.receipt?.id,external:r.external?{provider:r.external.provider,ticketId:r.external.ticketId}:undefined}};
  const delivery:Delivery={id:id(),event,status:'pending',attempts:[],destination:'local simulated receiver',maxAttempts:3};
  store.db.prepare('INSERT OR IGNORE INTO deliveries VALUES(?,?,?,?)').run(delivery.id,r.tenant,key,JSON.stringify(delivery));
}
export function receiveWebhook(store:Store,event:WebhookEnvelope,signature:string,key:string):boolean {
  if(!verify(key,JSON.stringify(event),signature))throw new Error('Webhook signature mismatch');
  return !!store.db.prepare('INSERT OR IGNORE INTO webhook_received VALUES(?,?,?)').run(event.eventId,event.tenantId,JSON.stringify(event)).changes;
}
export function deliverWebhooks(store:Store,failures=0) {
  const key=signingKey(store);
  for(const row of store.db.prepare('SELECT id,data FROM deliveries').all() as {id:string;data:string}[]) {
    const d=JSON.parse(row.data) as Delivery;if(d.status==='delivered'||d.attempts.length>=d.maxAttempts)continue;
    const signature=sign(key,JSON.stringify(d.event)),attempt={id:id(),at:now(),signature,status:d.attempts.length<failures?503:200};
    d.attempts.push(attempt);
    if(attempt.status===200){receiveWebhook(store,d.event,signature,key);d.status='delivered';}else d.status=d.attempts.length>=3?'failed':'pending';
    store.db.prepare('UPDATE deliveries SET data=? WHERE id=?').run(JSON.stringify(d),d.id);
  }
}
export function deliveries(store:Store,tenant:Tenant):Delivery[]{return (store.db.prepare('SELECT data FROM deliveries WHERE tenant=? ORDER BY rowid DESC').all(tenant) as {data:string}[]).map(r=>JSON.parse(r.data));}
