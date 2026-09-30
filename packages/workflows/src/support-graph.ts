import { Annotation, StateGraph, START, END, interrupt } from '@langchain/langgraph';
import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite';
import { Services } from '../../core/src/services.js';
import type { Run, Tenant } from '../../core/src/types.js';
export const State = Annotation.Root({
  runId:Annotation<string>(), tenant:Annotation<Tenant>(), graphVersion:Annotation<string>(), schemaVersion:Annotation<number>(),
  decisionId:Annotation<string>(), route:Annotation<string>(), status:Annotation<string>(), proposalId:Annotation<string>(), approvalId:Annotation<string>(), operationId:Annotation<string>(), receiptId:Annotation<string>(),
  evidenceIds:Annotation<string[]>(), steps:Annotation<number>(), error:Annotation<string>()
});
export function buildGraph(services:Services, checkpointer:SqliteSaver) {
  const load=(s:typeof State.State)=>services.store.run(s.tenant,s.runId);
  const node=(name:string,fn:(r:Run,s:typeof State.State)=>unknown)=>async(s:typeof State.State)=> {
    const r=load(s);services.enter(r,name);const begin=performance.now();
    await fn(r,s);const elapsed=performance.now()-begin;r.activeMs+=elapsed;r.nodeMs=(r.nodeMs??0)+elapsed;services.save(r);
    return {status:r.stage,route:r.outcome ? 'stop':r.policy?.route??'',proposalId:r.proposal?.id??'',approvalId:r.approvalId??'',operationId:r.operationId??'',receiptId:r.receipt?.id??'',evidenceIds:r.evidence.map(e=>e.id),steps:r.steps,error:r.error??'',graphVersion:r.graphVersion,schemaVersion:r.schemaVersion};
  };
  return new StateGraph(State)
    .addNode('normalize_intake',node('normalize_intake',r=>services.normalize(r)))
    .addNode('triage_ticket',node('triage_ticket',r=>services.triage(r)))
    .addNode('lookup_authorized_account',node('lookup_authorized_account',r=>services.authorize(r)))
    .addNode('retrieve_evidence',node('retrieve_evidence',r=>services.retrieve(r)))
    .addNode('propose_action',node('propose_action',r=>services.propose(r)))
    .addNode('evaluate_policy',node('evaluate_policy',r=>services.evaluate(r)))
    .addNode('record_escalation',node('record_escalation',r=>services.escalate(r)))
    .addNode('record_denial',node('record_denial',r=>services.deny(r)))
    .addNode('create_approval',node('create_approval',r=>services.createApproval(r)))
    .addNode('set_external_wait',node('set_external_wait',async r=>{try{await services.support?.waiting(r);}catch(error){services.store.event(r,'external_wait_failed',{message:String(error)});}}))
    .addNode('await_approval',s=>({ decisionId: interrupt({approvalId:s.approvalId,proposalId:s.proposalId,summary:'Review the exact stored proposal. No write has executed.'}) as string }))
    .addNode('validate_recorded_decision',node('validate_recorded_decision',(r,s)=>services.validateDecision(r,s.decisionId)))
    .addNode('revalidate_action',node('revalidate_action',r=>services.revalidate(r)))
    .addNode('execute_action',node('execute_action',r=>services.execute(r)))
    .addNode('reconcile_or_escalate',node('reconcile_or_escalate',r=>{if(r.operationId && r.outcome==='UNKNOWN_OUTCOME')services.reconcile(r);}))
    .addNode('update_ticket',node('update_ticket',r=>services.updateTicket(r)))
    .addNode('compose_response',node('compose_response',r=>services.compose(r)))
    .addNode('publish_support_result',node('publish_support_result',r=>services.publishSupport(r)))
    .addNode('finalize_run',node('finalize_run',r=>services.finalize(r)))
    .addEdge(START,'normalize_intake')
    .addEdge('normalize_intake','triage_ticket')
    .addEdge('triage_ticket','lookup_authorized_account')
    .addConditionalEdges('lookup_authorized_account',s=>load(s).authorized ? 'retrieve_evidence':'record_escalation',['retrieve_evidence','record_escalation'])
    .addEdge('retrieve_evidence','propose_action').addEdge('propose_action','evaluate_policy')
    .addConditionalEdges('evaluate_policy',s=>({answer:'update_ticket',escalate:'record_escalation',deny:'record_denial',approval:'create_approval',execute:'revalidate_action'} as const)[load(s).policy!.route],['update_ticket','record_escalation','record_denial','create_approval','revalidate_action'])
    .addEdge('record_escalation','update_ticket').addEdge('record_denial','update_ticket')
    .addEdge('create_approval','set_external_wait').addEdge('set_external_wait','await_approval').addEdge('await_approval','validate_recorded_decision')
    .addConditionalEdges('validate_recorded_decision',s=>load(s).outcome ? 'update_ticket':'revalidate_action',['update_ticket','revalidate_action'])
    .addConditionalEdges('revalidate_action',s=>load(s).outcome ? 'update_ticket':'execute_action',['update_ticket','execute_action'])
    .addEdge('execute_action','reconcile_or_escalate').addEdge('reconcile_or_escalate','update_ticket')
    .addEdge('update_ticket','compose_response').addEdge('compose_response','publish_support_result').addEdge('publish_support_result','finalize_run').addEdge('finalize_run',END)
    .compile({checkpointer});
}
