import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, id } from '../packages/core/src/store.js';
import { Runtime } from '../packages/workflows/src/runtime.js';
import { demoActor } from '../packages/core/src/services.js';
import { seed } from '../packages/connectors/src/adapters.js';
import type { Tenant } from '../packages/core/src/types.js';
export async function fixture(fn:(r:Runtime)=>Promise<void>,tenant:Tenant='acme') {const dir=mkdtempSync(join(tmpdir(),'fieldkit-test-'));const r=new Runtime(new Store(dir));seed(r.store,tenant);try{await fn(r);}finally{await r.close();rmSync(dir,{recursive:true,force:true});}}
test('$49 traverses real graph, changes one ledger record and ticket; duplicates are safe',()=>fixture(async r=>{
  const a=demoActor('acme'),input={text:'Charged for both plans. Please refund the duplicate.',requestKey:id(),channel:'web_chat' as const};
  const run=r.start(a,input);await r.drain();const done=r.store.run('acme',run.id);
  assert.equal(done.stage,'COMPLETED');assert.equal(done.receipt?.amountMinor,4900);assert.equal(r.store.list('acme','receipt').length,1);assert.equal(r.store.get('acme','ticket',run.ticketId)?.status,'resolved');
  assert.equal(r.start(a,input).id,run.id);const other=r.start(a,{...input,requestKey:id()});await r.drain();assert.equal(r.store.run('acme',other.id).stage,'REJECTED');assert.equal(r.store.list('acme','receipt').length,1);
  const trace=await r.inspect(a,run.id);assert.ok(trace.workflow.history.length>10);assert.ok(trace.events.some(e=>e.kind==='graph_update'&&e.node==='execute_action'));
}));
test('$8,000 pauses with no writes and resumes the exact proposal once',()=>fixture(async r=>{
  const a=demoActor('acme'),run=r.start(a,{text:'Refund duplicate annual $8000 invoice',requestKey:id(),channel:'api'});await r.drain();
  const pending=r.store.run('acme',run.id);assert.equal(pending.stage,'WAITING_FOR_APPROVAL');assert.equal(r.store.list('acme','receipt').length,0);
  assert.throws(()=>r.decide(a,pending.approvalId!,1,'approve'),/authorized/);
  r.decide(demoActor('acme',true),pending.approvalId!,1,'approve');await r.drain();
  assert.equal(r.store.run('acme',run.id).receipt?.amountMinor,800000);r.decide(demoActor('acme',true),pending.approvalId!,1,'approve');await r.drain();assert.equal(r.store.list('acme','receipt').length,1);
}));
