import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Store, customerRoot, hash, id, now } from './store.js';
import { ConfigSchema, type Actor, type Tenant } from './types.js';
import { assertActor } from './services.js';
import { loadSnapshot, normalizeKnowledge } from '../../connectors/src/adapters.js';
export type Finding = {id:string;severity:'critical'|'warning';blocking:boolean;source:string;observed:string;workflow:string;remediation:string};
export type Discovery = {id:string;tenant:Tenant;at:string;sourceHash:string;coverage:{files:number;accounts:number;invoices:number;articles:number;labels:number};findings:Finding[];status:'BLOCKED'|'NOT READY';config:unknown};
export function workingRoot(store:Store,tenant:Tenant) {const root=join(store.dir,'customers');if(!existsSync(join(root,tenant))){mkdirSync(root,{recursive:true});cpSync(join(customerRoot,tenant),join(root,tenant),{recursive:true});}return root;}
export function scan(store:Store,tenant:Tenant):Discovery {
  const root=workingRoot(store,tenant),read=(file:string)=>JSON.parse(readFileSync(join(root,tenant,file),'utf8'));
  const config=read('config.json'),raw=read('records.json'),knowledge=normalizeKnowledge(tenant,read('knowledge.json')),labels=read('labels.json') as Array<{id:string;expected_action?:string}>;
  const support=read('support.json');
  const findings:Finding[]=[];
  const add=(id:string,source:string,observed:string,remediation:string,blocking=true)=>findings.push({id,severity:blocking?'critical':'warning',blocking,source,observed,workflow:'support-resolution-v1',remediation});
  const parsed=ConfigSchema.safeParse(config);
  if(!parsed.success)add('config-invalid','config.json',parsed.error.message,'Correct unsupported or invalid versioned settings.');
  let accounts=raw.accounts.length,invoices=raw.invoices.length;
  try {
    const normalized=loadSnapshot(tenant,root);accounts=normalized.accounts.length;invoices=normalized.invoices.length;
    const keys=new Set(normalized.accounts.map(a=>a.id));
    for(const inv of normalized.invoices)if(!keys.has(inv.accountId))add(`unmapped-${inv.id}`,`records.json#${inv.id}`,`Invoice references ${inv.accountId}, which does not match any of ${keys.size} account identifiers.`,'Validate ownership and add an explicit account-ID mapping.');
  }catch(error){add('schema-invalid','records.json',String(error),'Repair the customer-specific raw schema; never discard unmatched rows.');}
  const current=knowledge.filter(k=>k.authority==='policy'&&k.refundAllowed!==undefined&&k.expires>=now().slice(0,10));
  if(new Set(current.map(k=>k.refundAllowed)).size>1)add('policy-conflict','knowledge.json#refund-policy,refund-policy-conflict','Two current, equally authoritative policies disagree about whether refunds are allowed.','A business owner must explicitly select the authoritative policy and version the decision.');
  for(const k of knowledge)if(k.expires<now().slice(0,10))add(`stale-${k.id}`,`knowledge.json#${k.id}`,`${k.id} expired on ${k.expires}.`,'Review and replace the stale article with approved current content.',k.authority==='policy');
  if(parsed.success&&!parsed.data.connectors.upstream_idempotency&&!parsed.data.connectors.reliable_lookup)add('unsafe-retry','config.json#connectors','The simulated billing connector has neither upstream idempotency nor reliable operation lookup.','Implement and verify upstream outcome lookup; a local idempotency wrapper is insufficient.');
  for(const label of labels)if(!label.expected_action)add(`label-${label.id}`,`labels.json#${label.id}`,`${label.id} has no expected_action label.`,'Have a reviewer independently label the expected action before evaluation.');
  for(const ticket of support.tickets){const account=String(ticket.fields?.customfield_10042??ticket.organization_id??ticket.customer_ref),status=ticket.fields?.status?.name??ticket.status??ticket.state,key=String(ticket.key??ticket.id??ticket.conversation_id);if(!support.capabilities.accountMap[account])add(`support-mapping-${key}`,`support.json#${key}`,`Connected support reads exist, but external customer ${account} has no canonical mapping.`,'Verify ownership and configure the explicit external customer mapping.');if(!support.capabilities.statusMap[status])add(`support-status-${key}`,`support.json#${key}`,`External status ${status} has no normalized equivalent.`,'Add a reviewed status mapping.');}
  for(const permission of ['read','reply','internalNote','updateStatus'])if(!support.capabilities[permission])add(`support-permission-${permission}`,`support.json#capabilities.${permission}`,`The simulated support connector lacks the required ${permission} permission.`,'Explicitly enable the required mock support permission and verify the adapter operation.');
  if(support.capabilities.authentication!=='local_demo_session')add('support-auth','support.json#capabilities.authentication','Unknown authentication configuration','Use the authenticated local demo session boundary.');
  if(!support.capabilities.idempotency&&!support.capabilities.reconciliation)add('support-write-safety','support.json#capabilities','Support writes cannot be safely deduplicated or reconciled','Verify write identity and operation lookup.');
  const report:Discovery={id:id(),tenant,at:now(),sourceHash:hash({config,raw,knowledge,labels,support}),coverage:{files:5,accounts,invoices,articles:knowledge.length,labels:labels.length},findings,status:findings.some(f=>f.blocking)?'BLOCKED':'NOT READY',config:{...config,supportIntegration:support.capabilities}};
  store.report(tenant,'discovery',report);return report;
}
export function remediate(store:Store,actor:Actor,fix:'mapping'|'reviewed-fixtures') {
  assertActor(actor,actor.tenant,true);
  const root=workingRoot(store,actor.tenant),file=(name:string)=>join(root,actor.tenant,name),read=(name:string)=>JSON.parse(readFileSync(file(name),'utf8'));
  const config=read('config.json'),before=hash([config,read('knowledge.json'),read('labels.json')]);
  if(actor.tenant!=='messycorp')throw new Error('This guided remediation is specific to the MessyCorp fixture');
  config.id_mapping['legacy-MC-001']='acct-1';config.version=fix==='mapping'?'1.1-mapping':'1.2-reviewed';
  const changes=['Validated legacy-MC-001 → acct-1 against the fictional discovery ownership exercise'];
  if(fix==='reviewed-fixtures') {
    config.connectors.reliable_lookup=true;config.policies.version='refunds-v2-reviewed';
    const knowledge=read('knowledge.json') as Array<Record<string,unknown>>;
    const conflict=knowledge.find(k=>k.id==='refund-policy-conflict')!;conflict.authority='guide';conflict.version=2;conflict.text='Archived finance draft. The business owner selected refund-policy §2 as the current authority. This draft must not authorize or prohibit execution.';delete conflict.refundAllowed;
    const guide=knowledge.find(k=>k.id==='billing-guide')!;guide.version=3;guide.expires='2030-12-31';guide.text='Reviewed migration guide: verify the original captured charge and duplicate invoice. Refunds follow the current refund-policy §2; they do not change subscriptions.';
    const labels=read('labels.json') as Array<Record<string,unknown>>;labels.find(k=>k.id==='duplicate-49')!.expected_action='refund';
    const support=read('support.json');support.capabilities.accountMap['legacy-customer']='acct-1';support.capabilities.updateStatus=true;
    writeFileSync(file('support.json'),JSON.stringify(support,null,2)+'\n');
    writeFileSync(file('knowledge.json'),JSON.stringify(knowledge,null,2)+'\n');writeFileSync(file('labels.json'),JSON.stringify(labels,null,2)+'\n');
    changes.push('Business owner explicitly selected refund-policy §2; contradictory draft retained as non-authoritative history','Reviewed billing guide v3','Enabled the implemented mock reliable operation lookup','Reviewer labeled duplicate-49 expected_action=refund');
  }
  ConfigSchema.parse(config);writeFileSync(file('config.json'),JSON.stringify(config,null,2)+'\n');
  store.report(actor.tenant,'remediation',{id:id(),actor:actor.id,at:now(),before,changes} as {id:string});
  return scan(store,actor.tenant);
}
