import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { Store, id } from '../packages/core/src/store.js';
import { demoActor } from '../packages/core/src/services.js';
import { Runtime } from '../packages/workflows/src/runtime.js';
import { seed } from '../packages/connectors/src/adapters.js';
import { seedExternal, externalIntake, adapter, normalize, integrationFixture, chatbotIntake } from '../packages/integrations/src/support.js';
import { deliveries, deliverWebhooks, enqueueWebhook, signingKey, receiveWebhook } from '../packages/integrations/src/webhooks.js';
import { FieldKitRequestSchema } from '../packages/integrations/src/contracts.js';
import { scan, remediate } from '../packages/core/src/discovery.js';
import { rerun } from '../packages/evals/src/harness.js';
import type { Tenant, Run } from '../packages/core/src/types.js';
async function isolated(tenant:Tenant,fn:(r:Runtime)=>Promise<void>){const dir=mkdtempSync(join(tmpdir(),'fieldkit-integration-')),r=new Runtime(new Store(dir));seed(r.store,tenant);seedExternal(r.store,tenant);try{await fn(r);}finally{await r.close();rmSync(dir,{recursive:true,force:true});}}

for(const tenant of ['acme','northstar'] as const)test(`${tenant} support adapter normalizes distinct schemas and round-trips a governed $49 outcome`,()=>isolated(tenant,async r=>{
  const fixture=integrationFixture(tenant),ticketId=tenant==='acme'?'ACME-1042':'2401',a=demoActor(tenant),ref={provider:fixture.provider,ticketId};
  const run=await externalIntake(r.store,a,fixture.provider,ticketId,id());await r.drain();let done=r.store.run(tenant,run.id);
  if(tenant==='northstar'){assert.equal(done.stage,'WAITING_FOR_APPROVAL');assert.equal(r.store.list(tenant,'receipt').length,0);r.decide(demoActor(tenant,true),done.approvalId!,1,'approve');await r.drain();done=r.store.run(tenant,run.id);}
  assert.equal(done.stage,'COMPLETED');assert.equal(done.receipt?.amountMinor,4900);const ticket=await adapter(r.store,tenant,fixture.provider).getTicket(ref);assert.equal(ticket.status,'resolved');assert.equal(ticket.ref.ticketId,ticketId);assert.equal((ticket.native as {comments:Array<unknown>}).comments.length,2);assert.equal(r.store.list(tenant,'receipt').length,1);
}));
test('external correlation and waiting status survive an actual process restart',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'fieldkit-external-restart-'));
  try {
    const p=spawnSync(process.execPath,['--import','tsx','tests/external-worker.ts',dir],{encoding:'utf8'});assert.equal(p.status,0,p.stderr);const run=JSON.parse(p.stdout) as Run;
    const r=new Runtime(new Store(dir));try{assert.equal(r.store.run('acme',run.id).threadId,run.threadId);assert.equal((await adapter(r.store,'acme','mock_jira_service_management').getTicket({provider:'mock_jira_service_management',ticketId:'ACME-1043'})).status,'waiting_for_approval');r.decide(demoActor('acme',true),run.approvalId!,1,'approve');await r.drain();const final=r.store.run('acme',run.id);assert.equal(final.external?.ticketId,'ACME-1043');assert.equal(final.receipt?.amountMinor,800000);assert.equal((await adapter(r.store,'acme','mock_jira_service_management').getTicket({provider:'mock_jira_service_management',ticketId:'ACME-1043'})).status,'resolved');assert.equal(r.store.list('acme','receipt').length,1);}finally{await r.close();}
  }finally{rmSync(dir,{recursive:true,force:true});}
});
test('duplicate and reordered inbound webhooks return the same stored run',()=>isolated('acme',async r=>{
  const a=demoActor('acme'),first=await externalIntake(r.store,a,'mock_jira_service_management','ACME-1042','event-two',2);const duplicate=await externalIntake(r.store,a,'mock_jira_service_management','ACME-1042','event-two',2),older=await externalIntake(r.store,a,'mock_jira_service_management','ACME-1042','event-one',1);assert.equal(first.id,duplicate.id);assert.equal(first.id,older.id);await r.drain();assert.equal(r.store.list('acme','receipt').length,1);
}));
test('missing custom fields, unknown statuses, unsupported capabilities, and cross-tenant IDs fail safely',()=>isolated('acme',async r=>{
  const fixture=integrationFixture('acme'),raw=structuredClone(fixture.tickets[0]);delete raw.fields.customfield_10042;assert.throws(()=>normalize(fixture.provider,raw,1,fixture.capabilities));const unknown=structuredClone(fixture.tickets[0]);unknown.fields.status.name='Mystery';assert.throws(()=>normalize(fixture.provider,unknown,1,fixture.capabilities),/Unknown external status/);
  seed(r.store,'northstar');await assert.rejects(externalIntake(r.store,demoActor('northstar'),'mock_jira_service_management','ACME-1042',id()),/not found/);
  const a=adapter(r.store,'acme',fixture.provider);a.cap.reply=false;await assert.rejects(a.replyToCustomer({provider:fixture.provider,ticketId:'ACME-1042'},{idempotencyKey:id(),text:'test'}),/does not permit/);assert.equal(r.store.list('acme','receipt').length,0);
}));
test('a stale external ticket blocks a previously approved action',()=>isolated('acme',async r=>{
  const run=await externalIntake(r.store,demoActor('acme'),'mock_jira_service_management','ACME-1043',id());await r.drain();const pending=r.store.run('acme',run.id);r.decide(demoActor('acme',true),pending.approvalId!,1,'approve');r.store.db.prepare("UPDATE external_tickets SET version=version+1 WHERE tenant='acme' AND id='ACME-1043'").run();await r.drain();assert.equal(r.store.run('acme',run.id).stage,'ESCALATED');assert.equal(r.store.list('acme','receipt').length,0);
}));
test('support update failure after billing success retries only support writes',()=>isolated('acme',async r=>{
  const run=await externalIntake(r.store,demoActor('acme'),'mock_jira_service_management','ACME-1042',id());run.faults={ticketFailures:1};r.store.save(run);await r.drain();assert.equal(r.store.run('acme',run.id).stage,'PARTIAL_COMPLETION');assert.equal(r.store.list('acme','receipt').length,1);await r.services.retryTicket(demoActor('acme',true),run.id);assert.equal(r.store.run('acme',run.id).stage,'COMPLETED');assert.equal(r.store.list('acme','receipt').length,1);const ticket=await adapter(r.store,'acme','mock_jira_service_management').getTicket({provider:'mock_jira_service_management',ticketId:'ACME-1042'});assert.equal(ticket.status,'resolved');assert.equal((ticket.native as {comments:unknown[]}).comments.length,2);
}));
test('signed versioned webhook retry uses stable event IDs and unique attempts; consumer deduplicates',()=>isolated('acme',async r=>{
  const run=r.start(demoActor('acme'),{text:'Refund duplicate charge',requestKey:id(),channel:'api'});run.stage='WAITING_FOR_APPROVAL';enqueueWebhook(r.store,run);deliverWebhooks(r.store,1);let d=deliveries(r.store,'acme')[0];assert.equal(d.status,'pending');deliverWebhooks(r.store,1);d=deliveries(r.store,'acme')[0];assert.equal(d.status,'delivered');assert.equal(d.attempts.length,2);assert.notEqual(d.attempts[0].id,d.attempts[1].id);assert.equal(receiveWebhook(r.store,d.event,d.attempts[1].signature,signingKey(r.store)),false);assert.throws(()=>receiveWebhook(r.store,{...d.event,runId:id()},d.attempts[1].signature,signingKey(r.store)),/signature/);
}));
test('chatbot contract validates bounded history and binds host identity, not chat claims',()=>isolated('globex',async r=>{
  const a=demoActor('globex'),input={schemaVersion:1 as const,deploymentId:'globex',idempotencyKey:id(),external:{conversationId:id(),channel:'chat'},message:'Please refund my duplicate charge',trustedContext:{tenantId:'globex',authenticatedCustomerId:'acct-1'}};
  assert.throws(()=>FieldKitRequestSchema.parse({...input,role:'support_manager'}));await assert.rejects(chatbotIntake(r.store,a,{...input,trustedContext:{tenantId:'acme'}}),/identity/);const run=await chatbotIntake(r.store,a,input);await r.drain();assert.equal(r.store.run('globex',run.id).stage,'WAITING_FOR_APPROVAL');assert.equal(r.store.list('globex','receipt').length,0);
}));
test('discovery reads actual files and a reviewed remediation changes subsequent findings',()=>isolated('messycorp',async r=>{
  const before=scan(r.store,'messycorp');assert.ok(before.findings.some(f=>f.id==='unmapped-inv-49'));assert.ok(before.findings.some(f=>f.id==='support-permission-updateStatus'));const mapped=remediate(r.store,demoActor('messycorp',true),'mapping');assert.equal(mapped.findings.length,before.findings.length-1);assert.notEqual(mapped.sourceHash,before.sourceHash);const fixed=remediate(r.store,demoActor('messycorp',true),'reviewed-fixtures');assert.equal(fixed.findings.filter(f=>f.blocking).length,0);assert.notEqual(fixed.sourceHash,mapped.sourceHash);
}));
test('inspection has no calls; rerun writes only a fresh sandbox and preserves original history',()=>isolated('acme',async r=>{
  const run=r.start(demoActor('acme'),{text:'Refund duplicate charge',requestKey:id(),channel:'api'});await r.drain();const original=r.store.run('acme',run.id),before=JSON.stringify(r.store.events('acme',run.id));await r.inspect(demoActor('acme'),run.id);assert.equal(JSON.stringify(r.store.events('acme',run.id)),before);const replay=await rerun(r.store,original);assert.notEqual(replay.trace.run.threadId,original.threadId);assert.notEqual(replay.trace.run.receipt?.id,original.receipt?.id);assert.equal(replay.trace.run.stage,'COMPLETED');assert.equal(r.store.list('acme','receipt').length,1);assert.equal(JSON.stringify(r.store.events('acme',run.id)),before);
}));
test('scoped reset removes selected checkpoints and keeps other tenants intact',()=>isolated('acme',async r=>{
  seed(r.store,'northstar');const one=r.start(demoActor('acme'),{text:'Refund annual $8000 duplicate',requestKey:id(),channel:'api'}),two=r.start(demoActor('northstar'),{text:'Refund duplicate charge',requestKey:id(),channel:'api'});await r.drain();const other=r.store.run('northstar',two.id);await r.reset(demoActor('acme',true));assert.equal(r.store.runs('acme').length,0);assert.equal((await r.graph.getState({configurable:{thread_id:one.threadId}})).values.runId,undefined);assert.equal(r.store.run('northstar',two.id).threadId,other.threadId);assert.equal((await r.inspect(demoActor('northstar'),two.id)).workflow.next[0],'await_approval');
}));
