import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { Store, id, now, hash, redact, customerRoot } from '../../core/src/store.js';
import { DomainError, type Actor, type Run, type Tenant } from '../../core/src/types.js';
import { assertActor, startRun } from '../../core/src/services.js';
import { ProviderSchema, type Provider, type SupportAdapter, type SupportCapabilities, type SupportTicket, type ExternalTicketRef, type ExternalWriteReceipt, type NormalizedTicketStatus, FieldKitRequestSchema, type FieldKitRequest } from './contracts.js';
type Native=Record<string,any>;
type Profile={capabilities:SupportCapabilities;provider:Provider;tickets:Native[]};
export function integrationFixture(tenant:Tenant,root=customerRoot):Profile {return JSON.parse(readFileSync(join(root,tenant,'support.json'),'utf8'));}
export function seedExternal(store:Store,tenant:Tenant) {const p=integrationFixture(tenant);for(const ticket of p.tickets){const key=String(ticket.key??ticket.id??ticket.conversation_id);store.db.prepare('INSERT OR IGNORE INTO external_tickets VALUES(?,?,?,?,?)').run(tenant,p.provider,key,1,JSON.stringify(ticket));}}
export function normalize(provider:Provider,raw:unknown,version:number,cap:SupportCapabilities):SupportTicket {
  const v=z.record(z.string(),z.unknown()).parse(raw) as Native;
  let key:string,account:string,requester:string,subject:string,message:string,status:string;
  if(provider==='mock_jira_service_management') {
    const parsed=z.object({key:z.string(),fields:z.object({summary:z.string(),description:z.string(),status:z.object({name:z.string()}),reporter:z.object({accountId:z.string()}),customfield_10042:z.string()})}).parse(v);
    key=parsed.key;account=parsed.fields.customfield_10042;requester=parsed.fields.reporter.accountId;subject=parsed.fields.summary;message=parsed.fields.description;status=parsed.fields.status.name;
  } else if(provider==='mock_zendesk') {
    const parsed=z.object({id:z.number().int(),requester_id:z.number().int(),organization_id:z.number().int(),subject:z.string(),description:z.string(),status:z.string()}).parse(v);
    key=String(parsed.id);account=String(parsed.organization_id);requester=String(parsed.requester_id);subject=parsed.subject;message=parsed.description;status=parsed.status;
  } else {const parsed=z.object({conversation_id:z.string(),customer_ref:z.string(),sender:z.string(),message:z.string(),state:z.string()}).parse(v);key=parsed.conversation_id;account=parsed.customer_ref;requester=parsed.sender;subject='Existing assistant conversation';message=parsed.message;status=parsed.state;}
  if(!cap.accountMap[account])throw new DomainError(422,`External customer mapping is missing or ambiguous: ${account}`);
  if(!cap.statusMap[status])throw new DomainError(422,`Unknown external status: ${status}`);
  return {ref:{provider,ticketId:key},accountId:cap.accountMap[account],requesterId:requester,conversationId:key,subject:redact(subject),message:redact(message),status:cap.statusMap[status],version,native:v};
}
export class MockSupportAdapter implements SupportAdapter {
  constructor(readonly store:Store,readonly tenant:Tenant,readonly provider:Provider,readonly cap:SupportCapabilities) {}
  async capabilities(){return this.cap;}
  async getTicket(ref:ExternalTicketRef) {
    if(!this.cap.read||ref.provider!==this.provider)throw new DomainError(403,'Support read capability unavailable');
    const row=this.store.db.prepare('SELECT data,version FROM external_tickets WHERE tenant=? AND provider=? AND id=?').get(this.tenant,this.provider,ref.ticketId) as {data:string;version:number}|undefined;
    if(!row)throw new DomainError(404,'External ticket not found in this tenant');
    return normalize(this.provider,JSON.parse(row.data),row.version,this.cap);
  }
  private async write(ref:ExternalTicketRef,operation:'internalNote'|'reply'|'updateStatus',value:string,key:string) {
    if(!this.cap[operation])throw new DomainError(422,`Support adapter does not permit ${operation}`);
    await this.getTicket(ref);
    return this.store.transaction(()=>{
      const old=this.store.db.prepare('SELECT data FROM external_writes WHERE tenant=? AND write_key=?').get(this.tenant,key) as {data:string}|undefined;if(old)return JSON.parse(old.data) as ExternalWriteReceipt;
      const row=this.store.db.prepare('SELECT data,version FROM external_tickets WHERE tenant=? AND provider=? AND id=?').get(this.tenant,this.provider,ref.ticketId) as {data:string;version:number};const native=JSON.parse(row.data) as Native;
      if(operation==='updateStatus') {
        const mapped=Object.entries(this.cap.statusMap).find(([,v])=>v===value)?.[0];if(!mapped)throw new DomainError(422,`No provider status mapping for ${value}`);
        if(this.provider==='mock_jira_service_management')native.fields.status={name:mapped};else if(this.provider==='mock_zendesk')native.status=mapped;else native.state=mapped;
      }else if(this.provider==='mock_jira_service_management'){native.comments??=[];native.comments.push({id:key,body:redact(value),jsdPublic:operation==='reply'});}
      else if(this.provider==='mock_zendesk'){native.comments??=[];native.comments.push({id:key,body:redact(value),public:operation==='reply'});}
      else {native.messages??=[];native.messages.push({id:key,role:operation==='reply'?'assistant':'internal',content:redact(value)});}
      const receipt:ExternalWriteReceipt={id:id(),provider:this.provider,ticketId:ref.ticketId,operation,version:row.version+1,at:now()};
      this.store.db.prepare('UPDATE external_tickets SET data=?,version=? WHERE tenant=? AND provider=? AND id=?').run(JSON.stringify(native),receipt.version,this.tenant,this.provider,ref.ticketId);
      this.store.db.prepare('INSERT INTO external_writes VALUES(?,?,?)').run(this.tenant,key,JSON.stringify(receipt));return receipt;
    });
  }
  addInternalNote(ref:ExternalTicketRef,note:{idempotencyKey:string;text:string}){return this.write(ref,'internalNote',note.text,note.idempotencyKey);}
  replyToCustomer(ref:ExternalTicketRef,reply:{idempotencyKey:string;text:string}){return this.write(ref,'reply',reply.text,reply.idempotencyKey);}
  updateStatus(ref:ExternalTicketRef,status:NormalizedTicketStatus,key:string){return this.write(ref,'updateStatus',status,key);}
}
export function adapter(store:Store,tenant:Tenant,provider:Provider) {
  const root=join(store.dir,'customers'),fixture=integrationFixture(tenant,existsSync(join(root,tenant,'support.json'))?root:customerRoot);
  const cap=fixture.provider===provider ? fixture.capabilities : defaultCapabilities(provider);
  return new MockSupportAdapter(store,tenant,provider,cap);
}
export function defaultCapabilities(provider:Provider):SupportCapabilities {return {simulated:true,authentication:'local_demo_session',read:true,internalNote:true,reply:true,updateStatus:true,assign:false,tags:false,webhooks:true,idempotency:true,reconciliation:true,rateLimitPerMinute:60,accountMap:{'acct-1':'acct-1','org-101':'acct-1','501':'acct-1'},statusMap:provider==='mock_jira_service_management'?{'Open':'open','Waiting for internal approval':'waiting_for_approval','Resolved':'resolved','Escalated':'escalated','Declined':'denied'}:provider==='mock_zendesk'?{open:'open',hold:'waiting_for_approval',solved:'resolved',pending:'escalated',closed:'denied'}:{open:'open',waiting_for_approval:'waiting_for_approval',resolved:'resolved',escalated:'escalated',denied:'denied'}};}
export async function externalIntake(store:Store,actor:Actor,provider:Provider,ticketId:string,eventId:string,sequence=1) {
  assertActor(actor,actor.tenant);ProviderSchema.parse(provider);seedExternal(store,actor.tenant);
  const support=adapter(store,actor.tenant,provider),ticket=await support.getTicket({provider,ticketId});
  if(ticket.accountId!==actor.accountId)throw new DomainError(403,'Authenticated host scope does not authorize this external customer');
  const payloadHash=hash({ticketId,sequence});
  return store.transaction(()=>{
    const old=store.db.prepare('SELECT run_id,payload_hash FROM inbound_events WHERE tenant=? AND provider=? AND event_id=?').get(actor.tenant,provider,eventId) as {run_id:string;payload_hash:string}|undefined;
    if(old){if(old.payload_hash!==payloadHash)throw new DomainError(409,'Webhook ID was reused for different content');return store.run(actor.tenant,old.run_id);}
    const latest=store.db.prepare('SELECT sequence,run_id FROM inbound_events WHERE tenant=? AND provider=? AND ticket_id=? ORDER BY sequence DESC LIMIT 1').get(actor.tenant,provider,ticketId) as {sequence:number;run_id:string}|undefined;
    if(latest && sequence<=latest.sequence)return store.run(actor.tenant,latest.run_id);
    const run=startRun(store,actor,{text:ticket.message,requestKey:`${provider}:${eventId}`,accountId:ticket.accountId,channel:'mock_webhook'});
    run.external={provider,ticketId,conversationId:ticket.conversationId,version:ticket.version,initial:ticket.native};store.save(run);
    store.db.prepare('INSERT INTO inbound_events VALUES(?,?,?,?,?,?,?)').run(actor.tenant,provider,eventId,ticketId,sequence,run.id,payloadHash);store.event(run,'external_intake',{provider,ticketId,sequence});return run;
  });
}
export async function chatbotIntake(store:Store,actor:Actor,request:FieldKitRequest) {
  const r=FieldKitRequestSchema.parse(request);assertActor(actor,actor.tenant);
  if(r.deploymentId!==actor.tenant||r.trustedContext.tenantId!==actor.tenant||(r.trustedContext.authenticatedCustomerId&&r.trustedContext.authenticatedCustomerId!==actor.accountId)||(r.trustedContext.actorId&&r.trustedContext.actorId!==actor.id))throw new DomainError(403,'Host identity assertions do not match the authenticated session');
  const ticketId=r.external.ticketId??r.external.conversationId;
  const raw={conversation_id:ticketId,customer_ref:actor.accountId,sender:actor.id,message:redact(r.message),state:'open',metadata:r.context?.metadata??{}};
  const existing=store.db.prepare('SELECT data FROM external_tickets WHERE tenant=? AND provider=? AND id=?').get(actor.tenant,'generic_chatbot',ticketId) as {data:string}|undefined;
  if(existing && JSON.parse(existing.data).message!==raw.message)throw new DomainError(409,'This conversation reference already identifies a different saved request; use a new request/conversation ID');
  store.db.prepare('INSERT OR IGNORE INTO external_tickets VALUES(?,?,?,?,?)').run(actor.tenant,'generic_chatbot',ticketId,1,JSON.stringify(raw));
  return externalIntake(store,actor,'generic_chatbot',ticketId,r.idempotencyKey);
}
export class SupportBridge {
  constructor(readonly store:Store){}
  current(run:Run) {if(!run.external)return true;const x=run.external;const row=this.store.db.prepare('SELECT version FROM external_tickets WHERE tenant=? AND provider=? AND id=?').get(run.tenant,x.provider,x.ticketId) as {version:number}|undefined;return row?.version===x.version;}
  async waiting(run:Run) {if(!run.external)return;const x=run.external,p=ProviderSchema.parse(x.provider),a=adapter(this.store,run.tenant,p),receipt=await a.updateStatus({provider:p,ticketId:x.ticketId},'waiting_for_approval',`${run.id}:waiting`);x.version=receipt.version;this.store.save(run);this.store.event(run,'external_waiting',{...receipt});}
  async publish(run:Run) {
    if(!run.external)return;
    const x=run.external,p=ProviderSchema.parse(x.provider),a=adapter(this.store,run.tenant,p),ref={provider:p,ticketId:x.ticketId};
    if(run.receipt && run.ticketAttempts<=(run.faults.ticketFailures??0))throw new DomainError(503,'External support write failed after the financial action');
    const note=await a.addInternalNote(ref,{idempotencyKey:`${run.id}:note`,text:`FieldKit ${run.id}. ${run.receipt?`Confirmed receipt ${run.receipt.id}.`:run.error??'Policy response.'} Trace available in FieldKit.`});
    const reply=await a.replyToCustomer(ref,{idempotencyKey:`${run.id}:reply`,text:run.response??'A human must review this request.'});
    const status=run.receipt||run.policy?.route==='answer'?'resolved':run.outcome==='REJECTED'?'denied':'escalated';
    const update=await a.updateStatus(ref,status,`${run.id}:status`);x.version=update.version;
    this.store.event(run,'external_updated',{provider:p,ticketId:x.ticketId,writes:[note,reply,update]});this.store.save(run);
  }
}
