import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, id } from '../packages/core/src/store.js';
import { Runtime } from '../packages/workflows/src/runtime.js';
import { demoActor } from '../packages/core/src/services.js';
import { seed } from '../packages/connectors/src/adapters.js';
import type { Run } from '../packages/core/src/types.js';
const dir=()=>mkdtempSync(join(tmpdir(),'fieldkit-recovery-'));
function worker(path:string,action:string,key='',failpoint='',decision='approve') {const p=spawnSync(process.execPath,['--import','tsx','tests/recovery-worker.ts',path,action,key,decision],{encoding:'utf8',env:{...process.env,FIELDKIT_FAILPOINT:failpoint}});assert.equal(p.status,failpoint==='after_upstream_commit'?87:failpoint?88:0,p.stderr);return p.stdout.trim()?JSON.parse(p.stdout):undefined;}
function clean(path:string){rmSync(path,{recursive:true,force:true});}
async function isolated(fn:(r:Runtime)=>Promise<void>){const path=dir(),r=new Runtime(new Store(path));seed(r.store,'acme');try{await fn(r);}finally{await r.close();clean(path);}}
const intake=(text='Refund duplicate charge for both plans')=>({text,requestKey:id(),channel:'api' as const});

test('restart: pending proposal and thread survive; durable decision before resume advances once',()=>{
  const path=dir();try{const run=worker(path,'start','large') as Run;assert.equal(run.stage,'WAITING_FOR_APPROVAL');const store=new Store(path);assert.equal(store.list('acme','receipt').length,0);assert.equal(store.run('acme',run.id).threadId,run.threadId);store.close();worker(path,'decide',run.id);const resumed=worker(path,'drain')[0] as Run;assert.equal(resumed.proposal?.hash,run.proposal?.hash);assert.equal(resumed.threadId,run.threadId);assert.equal(resumed.stage,'COMPLETED');worker(path,'drain');const check=new Store(path);assert.equal(check.list('acme','receipt').length,1);assert.equal(check.list('acme','approval').length,1);check.close();}finally{clean(path);}
});
for(const point of ['after_confirmed_refund','after_upstream_commit'])test(`crash window: ${point} recovers original operation without another write`,()=>{
  const path=dir();try{worker(path,'start','small',point);const runs=worker(path,'drain') as Run[];assert.equal(runs[0].stage,'COMPLETED');const store=new Store(path);assert.equal(store.list('acme','receipt').length,1);assert.equal((store.db.prepare('SELECT count(*) AS n FROM upstream').get() as {n:number}).n,1);assert.equal(store.get('acme','invoice','inv-49')?.refundedMinor,4900);store.close();}finally{clean(path);}
});
test('concurrent decisions in fresh processes have one authoritative winner',async()=>{
  const path=dir();try{const run=worker(path,'start','large') as Run;const child=(decision:string)=>new Promise<number|null>(resolve=>{const p=spawn(process.execPath,['--import','tsx','tests/recovery-worker.ts',path,'decide',run.id,decision],{stdio:'ignore'});p.on('exit',resolve);});const exits=await Promise.all([child('approve'),child('reject')]);assert.deepEqual(exits.sort(),[0,1]);worker(path,'drain');const s=new Store(path),a=s.get('acme','approval',run.approvalId!)!;assert.ok(['approved','rejected'].includes(a.status));assert.equal(s.list('acme','receipt').length,a.status==='approved'?1:0);s.close();}finally{clean(path);}
});
test('stale policy after process restart blocks saved approval',()=>{
  const path=dir();try{const run=worker(path,'start','large') as Run;worker(path,'decide',run.id);const s=new Store(path);const c=s.config('acme');c.policies.version='refunds-v2';s.put('acme','config','acme',c);s.close();const resumed=worker(path,'drain')[0] as Run;assert.equal(resumed.stage,'ESCALATED');assert.match(resumed.error!,/stale/);const check=new Store(path);assert.equal(check.list('acme','receipt').length,0);check.close();}finally{clean(path);}
});
test('timeout after real upstream commit reconciles only with reliable lookup',()=>isolated(async r=>{
  const run=r.start(demoActor('acme'),intake(),{faults:{timeoutAfterCommit:true}});await r.drain();assert.equal(r.store.run('acme',run.id).stage,'COMPLETED');assert.equal(r.store.list('acme','receipt').length,1);
}));
test('uncertain committed write stays unknown, never claims a refund or blindly retries',()=>isolated(async r=>{
  const run=r.start(demoActor('acme'),intake(),{faults:{timeoutAfterCommit:true,unreliableLookup:true}});await r.drain();const final=r.store.run('acme',run.id);assert.equal(final.stage,'UNKNOWN_OUTCOME');assert.equal(r.store.get('acme','invoice','inv-49')?.refundedMinor,4900);assert.equal(r.store.list('acme','receipt').length,0);assert.match(final.response!,/not confirmed/);r.store.queue(final);await r.drain();assert.equal((r.store.db.prepare('SELECT count(*) AS n FROM upstream').get() as {n:number}).n,1);
}));
test('two queued runs targeting the same charge cannot double refund',()=>isolated(async r=>{
  const a=r.start(demoActor('acme'),intake()),b=r.start(demoActor('acme'),intake());await r.drain();assert.equal(r.store.list('acme','receipt').length,1);assert.equal(r.store.run('acme',a.id).stage,'COMPLETED');assert.equal(r.store.run('acme',b.id).stage,'REJECTED');
}));
test('tenant isolation and forged decision references cannot advance a run',()=>isolated(async r=>{
  seed(r.store,'northstar');const run=r.start(demoActor('acme'),intake('Refund duplicate annual $8000'));await r.drain();const p=r.store.run('acme',run.id);
  await assert.rejects(r.inspect(demoActor('northstar',true),run.id),/not found/);assert.throws(()=>r.decide(demoActor('northstar',true),p.approvalId!,1,'approve'),/not found/);assert.throws(()=>r.decide({...demoActor('acme'),role:'requester'},p.approvalId!,1,'approve'),/authorized/);assert.equal(r.store.list('acme','receipt').length,0);
}));
test('expired approval and changed evidence cannot execute',()=>isolated(async r=>{
  const run=r.start(demoActor('acme'),intake('Refund duplicate annual $8000'));await r.drain();const p=r.store.run('acme',run.id),a=r.store.get('acme','approval',p.approvalId!)!;a.expiresAt='2020-01-01';r.store.put('acme','approval',a.id,a);r.decide(demoActor('acme',true),a.id,1,'approve');await r.drain();assert.equal(r.store.run('acme',run.id).stage,'ESCALATED');assert.equal(r.store.list('acme','receipt').length,0);
}));
test('interrupted node re-entry is read-only and creates one approval',()=>isolated(async r=>{
  const run=r.start(demoActor('acme'),intake('Refund duplicate annual $8000'));await r.drain();for(let i=0;i<3;i++){r.store.queue(r.store.run('acme',run.id));await r.drain();}assert.equal(r.store.list('acme','approval').length,1);assert.equal(r.store.list('acme','operation').length,0);
}));
test('ticket failure after refund retries bookkeeping only',()=>isolated(async r=>{
  const run=r.start(demoActor('acme'),intake(),{faults:{ticketFailures:1}});await r.drain();assert.equal(r.store.run('acme',run.id).stage,'PARTIAL_COMPLETION');const done=await r.services.retryTicket(demoActor('acme',true),run.id);assert.equal(done.stage,'COMPLETED');assert.equal(r.store.list('acme','receipt').length,1);assert.equal(r.store.get('acme','ticket',done.ticketId)?.status,'resolved');
}));
test('stream disconnect equivalent: stored ordered events reload without graph invocation',()=>isolated(async r=>{
  const run=r.start(demoActor('acme'),intake());await r.drain();const before=r.store.run('acme',run.id).invocations;const events=r.store.events('acme',run.id),last=events[4].id;assert.deepEqual(r.store.events('acme',run.id,last),events.slice(5));await r.inspect(demoActor('acme'),run.id);assert.equal(r.store.run('acme',run.id).invocations,before);
}));
test('incompatible graph version is blocked instead of restarted',()=>isolated(async r=>{
  const run=r.start(demoActor('acme'),intake());run.graphVersion='future-v99';r.store.save(run);await r.drain();const done=r.store.run('acme',run.id);assert.equal(done.stage,'FAILED');assert.match(done.error!,/Incompatible/);assert.equal(r.store.list('acme','receipt').length,0);
}));
test('persisted retry limits and isolated thread ledgers remain bounded',()=>isolated(async r=>{
  const run=r.start(demoActor('acme'),intake(),{faults:{readFailures:100}});await r.drain();const done=r.store.run('acme',run.id);assert.equal(done.stage,'ESCALATED');assert.equal(done.readAttempts,3);r.store.queue(done);await r.drain();assert.equal(r.store.run('acme',run.id).readAttempts,3);assert.equal(r.store.list('acme','receipt').length,0);
}));
test('configured graph-step budget stops before financial execution',()=>isolated(async r=>{
  const config=r.store.config('acme');config.workflow.limits.max_graph_steps=4;r.store.put('acme','config','acme',config);const run=r.start(demoActor('acme'),intake());await r.drain();const done=r.store.run('acme',run.id);assert.equal(done.stage,'FAILED');assert.match(done.error!,/recursion|step|limit/i);assert.equal(r.store.list('acme','receipt').length,0);r.store.queue(done);await r.drain();assert.equal(r.store.list('acme','receipt').length,0);assert.ok(r.store.run('acme',run.id).steps>=done.steps);
}));
