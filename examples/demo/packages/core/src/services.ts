import { Store, id, hash, now, redact } from './store.js';
import { DomainError, IntakeSchema, VERSION, type Actor, type Approval, type Evidence, type Faults, type Intake, type Invoice, type Operation, type PolicyResult, type Proposal, type Receipt, type Run, type Tenant } from './types.js';

export function assertActor(actor: Actor, tenant: Tenant, manager = false) {
  if (actor.tenant !== tenant || Date.parse(actor.expiresAt) <= Date.now() || (manager && actor.role !== 'support_manager')) throw new DomainError(403, 'This demo session is not authorized for this action');
}
export function demoActor(tenant: Tenant, manager = false): Actor { return { id: `${tenant}-${manager ? 'manager':'requester'}`, tenant, role: manager ? 'support_manager':'requester', accountId:'acct-1', expiresAt:new Date(Date.now()+8*3600000).toISOString() }; }

export function startRun(store: Store, actor: Actor, input: Intake, options: { faults?: Faults; seed?: number; originalRunId?: string } = {}): Run {
  const data = IntakeSchema.parse(input); assertActor(actor,actor.tenant);
  return store.transaction(()=> {
    const existing = store.runs(actor.tenant).find(r=>r.requestKey===data.requestKey);
    if (existing) {
      if (existing.input !== redact(data.text) || existing.accountId !== (data.accountId ?? (data.scenario==='missing' ? 'acct-2':actor.accountId))) throw new DomainError(409,'Request key already belongs to different input');
      return existing;
    }
    const config = store.config(actor.tenant), key = id();
    const faults: Faults = options.faults ?? (data.scenario==='read_failure' ? {readFailures:1}:data.scenario==='unknown' ? {timeoutAfterCommit:true,unreliableLookup:true}:data.scenario==='ticket_failure' ? {ticketFailures:1}:{});
    const accountId = data.accountId ?? (data.scenario==='missing' ? 'acct-2':actor.accountId);
    const run: Run = {id:key,tenant:actor.tenant,threadId:id(),ticketId:id(),actorId:actor.id,accountId,input:redact(data.text),channel:data.channel,requestKey:data.requestKey,graphVersion:VERSION.graph,schemaVersion:VERSION.schema,configVersion:config.version,policyVersion:config.policies.version,modelMode:'deterministic_demo',simulatorVersion:VERSION.simulator,stage:'RECEIVED',evidence:[],createdAt:now(),activeMs:0,approvalWaitMs:0,steps:0,readAttempts:0,modelCalls:0,ticketAttempts:0,invocations:0,faults,provenance:{snapshot:store.snapshot(actor.tenant),seed:options.seed??42,clock:now(),originalRunId:options.originalRunId}};
    store.db.prepare('INSERT INTO runs VALUES(?,?,?,?)').run(key,run.tenant,run.requestKey,JSON.stringify(run));
    store.put(run.tenant,'ticket',run.ticketId,{id:run.ticketId,accountId,text:run.input,channel:run.channel,status:'open'});
    store.event(run,'intake',{channel:run.channel,mode:run.modelMode}); store.queue(run); return run;
  });
}

export function decide(store: Store, actor: Actor, approvalId: string, revision: number, decision: 'approve'|'reject'|'escalate'): Approval {
  assertActor(actor,actor.tenant,true);
  return store.transaction(()=> {
    const a = store.get(actor.tenant,'approval',approvalId);
    if (!a) throw new DomainError(404,'Approval not found in this tenant');
    const status = ({approve:'approved',reject:'rejected',escalate:'escalated'} as const)[decision];
    if (a.status !== 'pending') { if (a.status===status) return a; throw new DomainError(409,'A decision is already authoritative; refresh the approval'); }
    if (revision !== a.revision) throw new DomainError(409,'Approval revision changed');
    a.status = Date.parse(a.expiresAt)<=Date.now() ? 'expired':status; a.actor=actor.id; a.decidedAt=now(); a.decisionId=id(); a.revision++;
    const run=store.run(actor.tenant,a.runId);
    if (a.proposalHash !== run.proposal?.hash) throw new DomainError(409,'Proposal no longer matches this approval');
    store.put(actor.tenant,'approval',a.id,a); store.event(run,'approval_decision',{approvalId:a.id,status:a.status,actor:a.actor,decisionId:a.decisionId}); store.queue(run); return a;
  });
}

export interface SupportPort {current(run:Run):boolean;waiting(run:Run):Promise<void>;publish(run:Run):Promise<void>;}
export class Services {
  constructor(readonly store: Store, readonly support?:SupportPort) {}
  save(r:Run) { this.store.save(r); }
  enter(r:Run,node:string) {
    r.steps++;
    if (r.steps>this.store.config(r.tenant).workflow.limits.max_graph_steps) throw new Error('Persisted graph-step budget exhausted');
    this.save(r); this.store.event(r,'node_started',{},node);
  }
  normalize(r:Run) { r.stage='RECEIVED'; }
  triage(r:Run) {
    const t=r.input.toLowerCase();
    // ponytail: intentionally narrow lexical simulator; add a tested proposal adapter for broader language coverage.
    r.intent=/ignore.*policy|ignore.*instructions|change tenant|without approval/.test(t) ? 'unknown' : /delete|erase.*account/.test(t) ? 'delete' : /cancel/.test(t) ? 'cancel' : /what.*policy|how.*bill|billing.*work|explain.*bill/.test(t) ? 'answer' : /refund|duplicate|both plans|double.?charg/.test(t) ? 'refund':'unknown';
    r.stage='TRIAGED'; this.store.event(r,'triage',{intent:r.intent,adapter:VERSION.simulator,modelCalls:0});
  }
  authorize(r:Run) {
    const a=this.store.get(r.tenant,'account',r.accountId);
    r.authorized=!!a && !a.deleted && r.accountId==='acct-1' && [a.authorizedActor,`${r.tenant}-manager`].includes(r.actorId);
    if (!r.authorized) { r.outcome='ESCALATED'; r.error='Account ownership could not be verified. No protected evidence was retrieved.'; }
    this.store.event(r,'account_authorization',{authorized:r.authorized});
  }
  evidence(r:Run): Evidence[] {
    const s=this.store, today=now().slice(0,10), result:Evidence[]=[];
    const account=s.get(r.tenant,'account',r.accountId);
    if (account) result.push({id:account.id,kind:'account',version:account.version,text:`${account.name}; ownership verified; deleted=${account.deleted}`,used:true});
    const words=r.input.toLowerCase().match(/[a-z]{4,}/g)??[];
    for (const k of s.list(r.tenant,'knowledge')) {
      const applicable=k.authority==='policy' && (r.intent==='delete'||r.intent==='cancel' ? k.id==='account-policy' : k.refundAllowed!==undefined);
      if (applicable || words.some(w=>k.text.toLowerCase().includes(w))) result.push({id:k.id,kind:'knowledge',version:k.version,text:k.text,authority:k.authority,section:k.section,used:applicable && k.effective<=today && k.expires>=today});
    }
    if (r.intent==='refund') {
      const target=/unpaid/i.test(r.input) ? 'inv-unpaid': /8,?000|annual|enterprise/i.test(r.input) ? 'inv-8000':'inv-49';
      const inv=s.get(r.tenant,'invoice',target);
      if (inv?.accountId===r.accountId) {
        result.push({id:inv.id,kind:'invoice',version:inv.version,text:JSON.stringify(inv),used:true});
        const original=inv.duplicateOf ? s.get(r.tenant,'invoice',inv.duplicateOf):undefined;
        if (original?.accountId===r.accountId) result.push({id:original.id,kind:'original_invoice',version:original.version,text:JSON.stringify(original),used:true});
      }
      for (const sub of s.list(r.tenant,'subscription').filter(x=>x.accountId===r.accountId)) result.push({id:sub.id,kind:'subscription',version:sub.version,text:JSON.stringify(sub),used:true});
      for (const past of s.list(r.tenant,'invoice').filter(x=>x.accountId===r.accountId && x.refundedMinor>0 && x.id!==target)) result.push({id:past.id,kind:'prior_refund',version:past.version,text:JSON.stringify(past),used:false});
    }
    return result;
  }
  async retrieve(r:Run) {
    const max=this.store.config(r.tenant).workflow.limits.read_max_attempts;
    while (r.readAttempts<max) {
      r.readAttempts++; this.save(r);
      if (r.readAttempts <= (r.faults.readFailures??0)) {
        this.store.event(r,'read_retry',{attempt:r.readAttempts,max,reason:'Simulated transient CRM read error'});
        if (r.readAttempts<max) await new Promise(resolve=>setTimeout(resolve,10*r.readAttempts));
        continue;
      }
      r.evidence=this.evidence(r); r.stage='EVIDENCE_READY'; this.store.event(r,'evidence_retrieved',{references:r.evidence.map(e=>({id:e.id,version:e.version,used:e.used})),attempt:r.readAttempts}); return;
    }
    r.error='CRM read attempts exhausted'; r.evidence=[]; r.outcome='ESCALATED';
  }
  propose(r:Run) {
    if (r.proposal) return;
    const c=this.store.config(r.tenant), ref=r.evidence.find(e=>e.kind==='invoice'), inv=ref ? this.store.get(r.tenant,'invoice',ref.id):undefined;
    const draft:Omit<Proposal,'hash'> = {id:id(),tenant:r.tenant,accountId:r.accountId,action:r.intent==='refund' ? 'refund':r.intent==='delete' ? 'delete':r.intent==='answer' ? 'answer':'escalate',policyVersion:c.policies.version,configHash:hash(c),evidenceHash:hash(r.evidence.filter(e=>e.used)),reason:r.intent==='refund' ? 'Correct the verified duplicate charge independently of the subscription.':r.intent==='delete' ? 'Delete the authorized mock customer profile only after manager approval.':r.intent==='answer' ? 'Answer from current authoritative policy.':'The request needs human clarification.'};
    if (inv) Object.assign(draft,{invoiceId:inv.id,amountMinor:inv.amountMinor-inv.refundedMinor,currency:inv.currency});
    r.proposal={...draft,hash:hash(draft)}; r.stage='ACTION_PROPOSED'; this.store.event(r,'proposal_created',{proposal:r.proposal});
  }
  policy(r:Run):PolicyResult {
    const c=this.store.config(r.tenant), p=r.proposal;
    const result=(route:PolicyResult['route'],reason:string,signals:string[]=[]):PolicyResult=>({route,reasons:[reason],signals});
    if (!r.authorized || !p || r.error) return result('escalate',r.error??'Verified account evidence is missing');
    if (p.action==='escalate') return result('escalate',r.intent==='cancel' ? 'Subscription target is ambiguous; a human must clarify it.':'Unsupported or adversarial request; instructions cannot grant authority.');
    const today=now().slice(0,10);
    const policies=this.store.list(r.tenant,'knowledge').filter(k=>k.authority==='policy' && k.refundAllowed!==undefined && k.effective<=today && k.expires>=today);
    if (p.action==='refund'||p.action==='answer') {
      if (!policies.length) return result('escalate','No current authoritative refund policy');
      if (new Set(policies.map(k=>k.refundAllowed)).size>1) return result('escalate','Authoritative refund policies conflict; no automatic precedence within equal authority');
      if (policies[0].refundAllowed===false) return result('deny','Current authoritative policy prohibits refunds, including manager-approved refunds');
    }
    if (p.action==='answer') return result('answer','Current policy evidence is sufficient');
    if (p.action==='delete') {
      if (!r.evidence.some(e=>e.id==='account-policy' && e.used)) return result('escalate','Missing current account-deletion policy');
      return result('approval','Destructive account changes always require support-manager approval',['authorized_account','destructive_action']);
    }
    const invoice=p.invoiceId ? this.store.get(r.tenant,'invoice',p.invoiceId):undefined;
    if (!invoice || invoice.accountId!==r.accountId) return result('escalate','Authorized invoice not found');
    const original=invoice.duplicateOf ? this.store.get(r.tenant,'invoice',invoice.duplicateOf):undefined;
    const history=this.store.list(r.tenant,'subscription').filter(s=>s.accountId===r.accountId);
    if (!original || original.accountId!==r.accountId || original.status!=='captured' || !history.some(s=>s.id===invoice.subscriptionId)) return result('escalate','Duplicate relationship and subscription history could not be verified');
    if (invoice.status!=='captured') return result('deny','Invoice is unpaid; there are no captured funds to refund');
    if (invoice.currency!==c.currency || p.currency!==c.currency || original.currency!==invoice.currency) return result('deny','Currency mismatch; currency conversion is unsupported');
    if (!Number.isSafeInteger(p.amountMinor) || !p.amountMinor || p.amountMinor<1 || p.amountMinor>invoice.amountMinor-invoice.refundedMinor) return result('deny','No sufficient refundable balance remains');
    if (!c.connectors.upstream_idempotency && !c.connectors.reliable_lookup) return result('escalate','Billing connector lacks both safe idempotency and reliable outcome lookup');
    const signals=['authorized_account','captured_payment','verified_duplicate','current_policy','sufficient_balance','explicit_currency'];
    return c.policies.refunds.all_require_approval || p.amountMinor>c.policies.refunds.max_auto_refund_minor ? result('approval','Amount exceeds automatic authority or customer policy requires all refunds to be approved',signals):result('execute','Eligible refund is within this customer’s automatic authority',signals);
  }
  evaluate(r:Run) { r.policy=this.policy(r);r.stage='POLICY_CHECKED';this.store.event(r,'policy_checked',{...r.policy}); }
  escalate(r:Run) { r.outcome='ESCALATED';r.error=r.error??r.policy?.reasons.join('; ')??'A human must clarify this request'; }
  deny(r:Run) { r.outcome='REJECTED';r.error=r.policy?.reasons.join('; ')??'Action denied'; }
  createApproval(r:Run) {
    if (!r.approvalId) {
      const key=`approval-${r.id}`;
      const existing=this.store.get(r.tenant,'approval',key);
      if (!existing) this.store.put(r.tenant,'approval',key,{id:key,runId:r.id,tenant:r.tenant,proposalHash:r.proposal!.hash,proposal:r.proposal!,revision:1,status:'pending',createdAt:now(),expiresAt:new Date(Date.now()+24*3600000).toISOString()});
      r.approvalId=key;
    }
    r.stage='WAITING_FOR_APPROVAL'; this.store.event(r,'approval_pending',{approvalId:r.approvalId,financialWriteExecuted:false});
  }
  validateDecision(r:Run,decisionId:string) {
    const a=r.approvalId ? this.store.get(r.tenant,'approval',r.approvalId):undefined;
    if (!a || a.decisionId!==decisionId || a.proposalHash!==r.proposal?.hash || a.actor!==`${r.tenant}-manager`) { r.outcome='ESCALATED';r.error='Stored approval decision is invalid';return; }
    r.approvalWaitMs=Math.max(0,Date.parse(a.decidedAt!)-Date.parse(a.createdAt));
    if (a.status!=='approved') { r.outcome=a.status==='rejected' ? 'REJECTED':'ESCALATED';r.error=`Approval ${a.status}; no action executed.`; }
    else if (Date.parse(a.expiresAt)<=Date.now()) { a.status='expired';this.store.put(r.tenant,'approval',a.id,a);r.outcome='ESCALATED';r.error='Approval authority expired'; }
    this.store.event(r,'decision_validated',{approvalId:a.id,status:a.status});
  }
  revalidate(r:Run): boolean {
    const op=r.operationId ? this.store.get(r.tenant,'operation',r.operationId):undefined;
    if (op?.status==='confirmed' && op.receipt) {r.receipt=op.receipt;return true;}
    if (op && ['sent','unknown'].includes(op.status)) return true; // Existing effects must be reconciled before balance is reinterpreted.
    const p=r.proposal!, c=this.store.config(r.tenant);
    const a=this.store.get(r.tenant,'account',r.accountId);
    const policy=this.policy(r);
    const approval=r.approvalId ? this.store.get(r.tenant,'approval',r.approvalId):undefined;
    const stale = !a || a.deleted || !r.authorized || a.authorizedActor!==`${r.tenant}-requester` || p.configHash!==hash(c) || p.evidenceHash!==hash(this.evidence(r).filter(e=>e.used)) || (this.support && !this.support.current(r));
    const permitted=policy.route==='execute'||(policy.route==='approval' && approval?.status==='approved' && approval.proposalHash===p.hash && Date.parse(approval.expiresAt)>Date.now());
    if (stale || !permitted) {
      r.outcome='ESCALATED';r.error=stale ? 'Action is stale: account, policy, evidence, or balance changed. A new reviewed proposal is required.':'Fresh execution authorization failed: '+policy.reasons.join('; ');
      if (approval?.status==='approved') {approval.status='stale';this.store.put(r.tenant,'approval',approval.id,approval);}
      this.store.event(r,'revalidation_blocked',{reason:r.error});return false;
    }
    this.store.event(r,'revalidation_passed',{proposalHash:p.hash}); return true;
  }
  confirm(r:Run,op:Operation,receipt:Receipt) {
    this.store.transaction(()=>{op.status='confirmed';op.receipt=receipt;this.store.put(r.tenant,'operation',op.id,op);this.store.put(r.tenant,'receipt',receipt.id,receipt);r.receipt=receipt;r.outcome=undefined;this.save(r);this.store.event(r,'write_confirmed',{receipt});});
  }
  reconcile(r:Run) {
    const op=this.store.get(r.tenant,'operation',r.operationId!)!;
    if (op.status==='confirmed' && op.receipt) {r.receipt=op.receipt;return;}
    const c=this.store.config(r.tenant);
    if (c.connectors.reliable_lookup && !r.faults.unreliableLookup) {
      const row=this.store.db.prepare('SELECT data FROM upstream WHERE tenant=? AND operation_id=?').get(r.tenant,op.id) as {data:string}|undefined;
      if (row) { this.confirm(r,op,JSON.parse(row.data));this.store.event(r,'outcome_reconciled',{operationId:op.id});return; }
    }
    op.status='unknown';op.error='A write may have committed. No blind retry; manual reconciliation is required.';this.store.put(r.tenant,'operation',op.id,op);r.outcome='UNKNOWN_OUTCOME';r.error=op.error;this.store.event(r,'unknown_write_outcome',{operationId:op.id,blindRetry:false});
  }
  execute(r:Run) {
    const p=r.proposal!; let op:Operation|undefined;
    this.store.transaction(()=>{
      r.operationId??=`operation-${p.id}`;
      op=this.store.get(r.tenant,'operation',r.operationId);
      if (!op) {op={id:r.operationId,runId:r.id,proposalHash:p.hash,resourceId:p.invoiceId??r.accountId,action:p.action as 'refund'|'delete',status:'prepared'};this.store.put(r.tenant,'operation',op.id,op);}
      this.save(r);
    });
    if (op!.status==='confirmed') {r.receipt=op!.receipt;return;}
    if (op!.status==='sent'||op!.status==='unknown') {this.reconcile(r);return;}
    if (op!.status==='failed') {r.outcome='FAILED';r.error=op!.error;return;}
    const allowed=this.store.transaction(()=>{
      if (!this.revalidate(r)) return false;
      const occupied=this.store.db.prepare('SELECT operation_id FROM reservations WHERE tenant=? AND resource=? AND action=?').get(r.tenant,op!.resourceId,op!.action) as {operation_id:string}|undefined;
      if (occupied && occupied.operation_id!==op!.id) {r.outcome='REJECTED';r.error='This business resource already has a correction operation.';return false;}
      this.store.db.prepare('INSERT OR IGNORE INTO reservations VALUES(?,?,?,?)').run(r.tenant,op!.resourceId,op!.action,op!.id);
      op!.status='sent';this.store.put(r.tenant,'operation',op!.id,op!);r.stage='EXECUTING';this.save(r);this.store.event(r,'write_dispatched',{tool:op!.action==='refund' ? 'mock_billing.refund':'mock_crm.delete',operationId:op!.id,accountId:r.accountId,resource:op!.resourceId,amountMinor:p.amountMinor??0,currency:p.currency??'USD'});return true;
    });
    if (!allowed) return;
    if (r.faults.knownWriteFailure) { op!.status='failed';op!.error='Connector rejected the write before committing';this.store.put(r.tenant,'operation',op!.id,op!);r.outcome='FAILED';r.error=op!.error;return; }
    // Separate commit: a connector side effect and a graph checkpoint are deliberately not atomic.
    const receipt=this.store.transaction(()=>{
      const receipt:Receipt={id:id(),tenant:r.tenant,accountId:r.accountId,operationId:op!.id,action:op!.action,resourceId:op!.resourceId,amountMinor:p.amountMinor??0,currency:p.currency??this.store.config(r.tenant).currency,createdAt:now()};
      if (op!.action==='refund') {
        const inv=this.store.get(r.tenant,'invoice',op!.resourceId)!;
        if (inv.accountId!==r.accountId || inv.amountMinor-inv.refundedMinor<receipt.amountMinor) throw new Error('Resource reservation no longer valid');
        inv.refundedMinor+=receipt.amountMinor;inv.version++;this.store.put(r.tenant,'invoice',inv.id,inv);
      } else {const a=this.store.get(r.tenant,'account',r.accountId)!;a.deleted=true;a.version++;this.store.put(r.tenant,'account',a.id,a);}
      this.store.db.prepare('INSERT INTO upstream VALUES(?,?,?,?)').run(receipt.id,r.tenant,op!.id,JSON.stringify(receipt));return receipt;
    });
    if (process.env.FIELDKIT_FAILPOINT==='after_upstream_commit') process.exit(87);
    if (r.faults.timeoutAfterCommit) {r.outcome='UNKNOWN_OUTCOME';this.store.event(r,'connector_timeout',{operationId:op!.id,committed:'unconfirmed'});return;}
    this.confirm(r,op!,receipt);
    if (process.env.FIELDKIT_FAILPOINT==='after_confirmed_refund') process.exit(88);
  }
  updateTicket(r:Run) {
    if (r.receipt) {
      const max=this.store.config(r.tenant).workflow.limits.read_max_attempts;
      if (r.ticketAttempts>=max) {r.outcome='PARTIAL_COMPLETION';r.error='Ticket update retry budget exhausted; confirmed financial history is preserved.';return;}
      r.ticketAttempts++;this.save(r);
      if (r.ticketAttempts<=(r.faults.ticketFailures??0)) {r.outcome='PARTIAL_COMPLETION';r.error='The action is confirmed, but the ticket connector failed. Retry the remaining ticket update.';this.store.event(r,'ticket_update_failed',{receiptId:r.receipt.id,attempt:r.ticketAttempts});return;}
    }
    const t=this.store.get(r.tenant,'ticket',r.ticketId)!;
    t.status=r.receipt || r.policy?.route==='answer' ? 'resolved':r.outcome==='REJECTED' ? 'denied':'escalated';t.receiptId=r.receipt?.id;
    this.store.put(r.tenant,'ticket',t.id,t);this.store.event(r,'ticket_updated',{ticketId:t.id,status:t.status,receiptId:t.receiptId});
  }
  compose(r:Run) {
    if (r.outcome==='UNKNOWN_OUTCOME') r.response='The payment provider timed out and the result is not confirmed. I have escalated this for reconciliation. No additional refund will be attempted.';
    else if (r.receipt) {r.response=r.receipt.action==='refund' ? `Your ${new Intl.NumberFormat('en-US',{style:'currency',currency:r.receipt.currency}).format(r.receipt.amountMinor/100)} refund is confirmed. Receipt ${r.receipt.id}. Your subscriptions were not changed.`:`Your mock account profile was deleted. Receipt ${r.receipt.id}.`;if(r.outcome==='PARTIAL_COMPLETION')r.response+=' The ticket update is still pending and needs a safe retry.';}
    else if (r.policy?.route==='answer') r.response='Captured duplicate payments can be refunded after account and billing verification. Refunds above your deployment’s automatic limit require a support manager. Source: refund-policy §2.';
    else if(r.outcome==='REJECTED')r.response='This action was not executed. '+r.error;
    else r.response='I have referred this request for human review. '+(r.error??'More information is needed.');
    r.stage='RESPONDED';const t=this.store.get(r.tenant,'ticket',r.ticketId)!;t.response=r.response;this.store.put(r.tenant,'ticket',t.id,t);this.store.event(r,'response_persisted',{response:r.response});
  }
  finalize(r:Run) {r.stage=r.outcome??(r.receipt||r.policy?.route==='answer' ? 'COMPLETED':'ESCALATED');r.completedAt=now();this.store.event(r,'run_finalized',{outcome:r.stage,receiptId:r.receipt?.id});}
  async publishSupport(r:Run) {
    try {await this.support?.publish(r);} catch(error) {r.outcome=r.receipt?'PARTIAL_COMPLETION':'ESCALATED';r.error=String(error);this.store.event(r,'external_update_failed',{message:r.error,receiptId:r.receipt?.id});this.compose(r);}
  }
  async retryTicket(actor:Actor,runId:string) {
    assertActor(actor,actor.tenant,true);const r=this.store.run(actor.tenant,runId);
    if(r.stage!=='PARTIAL_COMPLETION'||!r.receipt)throw new DomainError(409,'Only confirmed actions with incomplete ticket bookkeeping can be retried');
    // A safe, idempotent bookkeeping service; this cannot call the financial connector or restart the graph.
    r.outcome=undefined;r.error=undefined;this.updateTicket(r);this.compose(r);await this.publishSupport(r);this.finalize(r);this.save(r);return r;
  }
}
