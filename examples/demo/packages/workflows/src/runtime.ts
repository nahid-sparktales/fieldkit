import { Command } from '@langchain/langgraph';
import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite';
import { join } from 'node:path';
import { Store, id, now } from '../../core/src/store.js';
import { Services, assertActor, decide, startRun } from '../../core/src/services.js';
import { DomainError, VERSION, type Actor, type Intake, type Run, type Tenant } from '../../core/src/types.js';
import { buildGraph } from './support-graph.js';
import { seed } from '../../connectors/src/adapters.js';
import { SupportBridge } from '../../integrations/src/support.js';
import { enqueueWebhook, deliverWebhooks } from '../../integrations/src/webhooks.js';
export class Runtime {
  readonly saver:SqliteSaver;
  readonly services:Services;
  readonly graph:ReturnType<typeof buildGraph>;
  private busy:Promise<void>|undefined;
  private token=id();
  constructor(readonly store:Store) {
    // This offline demo never inherits an ambient opt-in to hosted tracing.
    process.env.LANGSMITH_TRACING='false';process.env.LANGCHAIN_TRACING_V2='false';process.env.LANGCHAIN_TRACING='false';
    this.saver=SqliteSaver.fromConnString(join(store.dir,'checkpoints.sqlite'));
    this.saver.db.pragma('journal_mode = WAL');this.saver.db.pragma('synchronous = FULL');this.saver.db.pragma('busy_timeout = 5000');
    this.services=new Services(store,new SupportBridge(store));this.graph=buildGraph(this.services,this.saver);
  }
  start(actor:Actor,input:Intake,options?:Parameters<typeof startRun>[3]) {return startRun(this.store,actor,input,options);}
  decide(actor:Actor,approvalId:string,revision:number,decision:'approve'|'reject'|'escalate') {return decide(this.store,actor,approvalId,revision,decision);}
  private acquire():boolean {
    return this.store.transaction(()=>{
      const old=this.store.db.prepare('SELECT pid,token FROM runner WHERE singleton=1').get() as {pid:number;token:string}|undefined;
      if(old && old.token!==this.token) {try{process.kill(old.pid,0);return false;}catch(error){if((error as NodeJS.ErrnoException).code!=='ESRCH')return false;}}
      this.store.db.prepare('INSERT OR REPLACE INTO runner VALUES(1,?,?)').run(process.pid,this.token);return true;
    });
  }
  async drain():Promise<void> {
    if(this.busy)return this.busy;
    this.busy=this.work().finally(()=>{this.busy=undefined;});return this.busy;
  }
  private async work() {
    if(!this.acquire())return;
    try {
      this.store.db.prepare("UPDATE jobs SET status='pending' WHERE status='running'").run();
      for(;;) {
        const job=this.store.db.prepare("SELECT run_id,tenant,revision FROM jobs WHERE status='pending' ORDER BY rowid LIMIT 1").get() as {run_id:string;tenant:Tenant;revision:number}|undefined;
        if(!job)break;
        const claimed=this.store.db.prepare("UPDATE jobs SET status='running' WHERE run_id=? AND status='pending' AND revision=?").run(job.run_id,job.revision).changes;
        if(!claimed)continue;
        try {await this.advance(this.store.run(job.tenant,job.run_id));}
        catch(error) {const r=this.store.run(job.tenant,job.run_id);r.stage=r.receipt ? 'PARTIAL_COMPLETION':'FAILED';r.error=error instanceof Error ? error.message:'Execution failed';this.store.save(r);this.store.event(r,'execution_failed',{message:r.error});}
        enqueueWebhook(this.store,this.store.run(job.tenant,job.run_id));
        this.store.db.prepare("UPDATE jobs SET status='done' WHERE run_id=? AND revision=?").run(job.run_id,job.revision);
      }
      deliverWebhooks(this.store);
    } finally {this.store.db.prepare('DELETE FROM runner WHERE token=?').run(this.token);}
  }
  private async advance(run:Run) {
    if(run.graphVersion!==VERSION.graph||run.schemaVersion!==VERSION.schema)throw new Error('Incompatible saved graph/schema version. Restore the matching code or migrate explicitly; this run was not restarted.');
    const limits=this.store.config(run.tenant).workflow.limits;
    if(run.activeMs>=limits.active_ms)throw new Error('Persisted active execution-time budget exhausted');
    const config={configurable:{thread_id:run.threadId},durability:'sync' as const,recursionLimit:limits.max_graph_steps};
    const snapshot=await this.graph.getState(config);
    let input:Parameters<typeof this.graph.stream>[0];
    if(snapshot.next.includes('await_approval')) {
      const a=run.approvalId ? this.store.get(run.tenant,'approval',run.approvalId):undefined;
      if(!a?.decisionId)return;
      input=new Command({resume:a.decisionId});
    } else if(snapshot.values?.runId) {if(!snapshot.next.length)return;input=null;}
    else input={runId:run.id,tenant:run.tenant,graphVersion:VERSION.graph,schemaVersion:VERSION.schema};
    run.invocations++;run.invocationId=id();this.store.save(run);this.store.event(run,'invocation_started',{attempt:run.invocations});
    const began=performance.now();const activeBefore=run.activeMs;
    try {
      for await(const [mode,value] of await this.graph.stream(input,{...config,streamMode:['updates','checkpoints']})) {
        const current=this.store.run(run.tenant,run.id);
        if(mode==='updates') {
          for(const [node,partial] of Object.entries(value)) this.store.event(current,node==='__interrupt__'?'graph_interrupt':'graph_update',{status:(partial as {status?:string})?.status??current.stage},node);
        } else {
          const cp=value as {config?:{configurable?:{checkpoint_id?:string}};metadata?:{step?:number};next?:string[]};
          this.store.event(current,'checkpoint',{checkpointId:cp.config?.configurable?.checkpoint_id,step:cp.metadata?.step,next:cp.next});
        }
        if(activeBefore+performance.now()-began>limits.active_ms)throw new Error('Active execution-time budget exhausted; existing effects retained');
      }
    } finally {const r=this.store.run(run.tenant,run.id);r.activeMs=activeBefore+performance.now()-began;r.overheadMs=Math.max(0,r.activeMs-(r.nodeMs??0));this.store.save(r);}
  }
  async inspect(actor:Actor,runId:string) {
    assertActor(actor,actor.tenant);const run=this.store.run(actor.tenant,runId);
    const config={configurable:{thread_id:run.threadId}}, state=await this.graph.getState(config);
    const history=[];
    for await(const item of this.graph.getStateHistory(config,{limit:128}))history.push({id:item.config.configurable?.checkpoint_id,next:item.next,step:item.metadata?.step,createdAt:item.createdAt});
    const structure=await this.graph.getGraphAsync();
    return {run,events:this.store.events(actor.tenant,runId),approval:run.approvalId?this.store.get(actor.tenant,'approval',run.approvalId):undefined,ticket:this.store.get(actor.tenant,'ticket',run.ticketId),workflow:{nodes:Object.keys(structure.nodes),edges:structure.edges.map(e=>({source:e.source,target:e.target,conditional:e.conditional})),next:state.next,checkpointId:state.config.configurable?.checkpoint_id,history}};
  }
  async reset(actor:Actor) {
    assertActor(actor,actor.tenant,true);
    if(this.busy||!this.acquire())throw new DomainError(409,'An execution is active. Wait for it to finish before resetting.');
    try {
      const runs=this.store.runs(actor.tenant);
      // Durable reset fence: a crash leaves no queued work that could rebuild a deleted checkpoint.
      this.store.transaction(()=> {this.store.db.prepare('DELETE FROM jobs WHERE tenant=?').run(actor.tenant);this.store.db.prepare('INSERT OR REPLACE INTO reports VALUES(?,?,?,?)').run(`reset-${actor.tenant}`,actor.tenant,'reset',JSON.stringify({id:`reset-${actor.tenant}`,at:now()}));});
      for(const r of runs)await this.saver.deleteThread(r.threadId);
      this.store.transaction(()=>{
        for(const table of ['records','runs','events','jobs','reservations','upstream','reports','external_tickets','external_writes','inbound_events','deliveries','webhook_received'])this.store.db.prepare(`DELETE FROM ${table} WHERE tenant=?`).run(actor.tenant);
        seed(this.store,actor.tenant);
      });
    } finally {this.store.db.prepare('DELETE FROM runner WHERE token=?').run(this.token);}
  }
  async close() {if(this.busy)await this.busy;this.saver.db.close();this.store.close();}
}
