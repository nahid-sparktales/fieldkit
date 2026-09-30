import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve, extname } from 'node:path';
import { z, ZodError } from 'zod';
import { Store, id, redact } from '../../packages/core/src/store.js';
import { DomainError, TENANTS, TenantId, IntakeSchema, SCENARIOS, type Actor, type Tenant, type Run } from '../../packages/core/src/types.js';
import { demoActor, assertActor } from '../../packages/core/src/services.js';
import { Runtime } from '../../packages/workflows/src/runtime.js';
import { seed } from '../../packages/connectors/src/adapters.js';
import { scan, remediate, type Discovery } from '../../packages/core/src/discovery.js';
import { makeReport, executeReport, readiness, rerun, decideSandbox, type Report } from '../../packages/evals/src/harness.js';
import { adapter, seedExternal, externalIntake, chatbotIntake, integrationFixture } from '../../packages/integrations/src/support.js';
import { FieldKitRequestSchema, ProviderSchema } from '../../packages/integrations/src/contracts.js';
import { deliveries, enqueueWebhook, deliverWebhooks } from '../../packages/integrations/src/webhooks.js';

const json=(res:ServerResponse,status:number,value:unknown)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(redact(JSON.stringify(value,(key,value)=>key==='snapshot'?undefined:value)));};
async function body(req:IncomingMessage) {let data='';for await(const chunk of req){data+=chunk;if(Buffer.byteLength(data)>32768)throw new DomainError(413,'Request body exceeds 32 KiB');}try{return data?JSON.parse(data):{};}catch{throw new DomainError(400,'Request body must be JSON');}}
export async function createApp(options:{dataDir:string;dev?:boolean;port?:number}) {
  const store=new Store(options.dataDir);for(const t of TENANTS){seed(store,t);seedExternal(store,t);}
  const runtime=new Runtime(store);const background=new Set<Promise<unknown>>();
  const launch=(p:Promise<unknown>)=>{background.add(p);p.catch(e=>console.error('Background task failed:',String(e))).finally(()=>background.delete(p));};
  // Interrupted evaluation processes are reported honestly, never left looking active after restart.
  for(const t of TENANTS)for(const report of store.reports<Report>(t,'evaluation'))if(report.status==='running'){report.status='failed';report.error='Evaluation process stopped; start a new isolated suite.';store.report(t,'evaluation',report);}
  for(const t of TENANTS)if(store.reports(t,'reset').length)await runtime.reset(demoActor(t,true));
  launch(runtime.drain());
  const vite=options.dev?await(await import('vite')).createServer({server:{middlewareMode:true},appType:'spa'}):undefined;
  const actor=(req:IncomingMessage):Actor=>{
    const token=req.headers.authorization?.replace(/^Bearer /,'')??req.headers.cookie?.match(/(?:^|; )fieldkit_session=([^;]+)/)?.[1];
    const row=token?store.db.prepare('SELECT data FROM sessions WHERE token=?').get(token) as {data:string}|undefined:undefined;
    if(!row)throw new DomainError(401,'Choose a local demo identity first');const a=JSON.parse(row.data) as Actor;assertActor(a,a.tenant);return a;
  };
  function findRun(tenant:Tenant,runId:string):Run {
    try{return store.run(tenant,runId);}catch(error){if(!(error instanceof DomainError))throw error;}
    const saved=store.getReport<{trace:{run:Run}}>(tenant,'eval-trace',runId);if(saved)return saved.trace.run;
    for(const report of store.reports<{trace:{run:Run}}>(tenant,'rerun'))if(report.trace.run.id===runId)return report.trace.run;
    throw new DomainError(404,'Trace not found in this tenant');
  }
  const server=createServer(async(req,res)=>{
    const url=new URL(req.url??'/',`http://${req.headers.host??'localhost'}`),path=url.pathname,method=req.method??'GET';
    try {
      const host=(req.headers.host??'').split(':')[0];if(!['localhost','127.0.0.1'].includes(host))throw new DomainError(403,'Only loopback hosts are supported');
      if(req.headers.origin && req.headers.origin!==`http://${req.headers.host}`)throw new DomainError(403,'Cross-origin requests are not allowed');
      if(!path.startsWith('/api/')&&!path.startsWith('/v1/')){
        if(vite){vite.middlewares(req,res,()=>json(res,404,{error:'Not found'}));return;}
        const root=resolve('dist/web');let file=resolve(root,'.'+decodeURIComponent(path));if(!file.startsWith(root+'/'))file=join(root,'index.html');if(!existsSync(file)||!extname(file))file=join(root,'index.html');
        if(!existsSync(file)){json(res,503,{error:'Run npm run build before production start'});return;}
        const mime:Record<string,string>={'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png'};res.writeHead(200,{'Content-Type':mime[extname(file)]??'application/octet-stream'});res.end(readFileSync(file));return;
      }
      if(method!=='GET'&&!req.headers['content-type']?.includes('application/json'))throw new DomainError(415,'Use application/json');
      if(path==='/api/health'){json(res,200,{ok:true,mode:'offline_mock',engine:'@langchain/langgraph'});return;}
      if(path==='/api/session'&&method==='POST'){
        const data=z.object({tenant:TenantId,persona:z.enum(['requester','support_manager'])}).strict().parse(await body(req));const a=demoActor(data.tenant,data.persona==='support_manager'),token=id();store.db.prepare('INSERT INTO sessions VALUES(?,?)').run(token,JSON.stringify(a));res.setHeader('Set-Cookie',`fieldkit_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800`);json(res,200,{actor:a,token,simulation:'Local demo identity selection; not enterprise authentication'});return;
      }
      const a=actor(req),t=a.tenant;
      if(path==='/api/bootstrap'&&method==='GET') {
        const reports=store.reports<Report>(t,'evaluation'),discovery=store.reports<Discovery>(t,'discovery')[0]??scan(store,t),runs=store.runs(t);
        json(res,200,{actor:a,tenants:TENANTS.map(tenant=>({id:tenant,name:store.config(tenant).name,business:store.config(tenant).business})),config:store.config(t),scenarios:SCENARIOS,runs,approvals:store.list(t,'approval'),invoices:store.list(t,'invoice').filter(i=>i.accountId===a.accountId),accounts:store.list(t,'account').filter(x=>x.id===a.accountId),discovery,readiness:readiness(store,t,discovery),reports:reports.map(({results,markdown,...report})=>({...report,failures:results.filter(r=>!r.passed).length})),deliveries:deliveries(store,t),integrations:{profile:integrationFixture(t),tickets:store.db.prepare('SELECT provider,id,version,data FROM external_tickets WHERE tenant=?').all(t)},metrics:{runs:runs.length,resolved:runs.filter(r=>r.stage==='COMPLETED').length,pending:runs.filter(r=>r.stage==='WAITING_FOR_APPROVAL').length,receipts:store.list(t,'receipt').length,modelCost:'N/A — no model calls'}});return;
      }
      if(path==='/api/runs'&&method==='POST'){
        const data=IntakeSchema.parse(await body(req));const run=runtime.start(a,data);
        if(!run.external){const ticketId=`native-${run.ticketId}`,raw={conversation_id:ticketId,customer_ref:run.accountId,sender:a.id,message:run.input,state:'open'};store.db.prepare('INSERT OR IGNORE INTO external_tickets VALUES(?,?,?,?,?)').run(t,'fieldkit_native',ticketId,1,JSON.stringify(raw));run.external={provider:'fieldkit_native',ticketId,conversationId:ticketId,version:1,initial:raw};store.save(run);}
        launch(runtime.drain());json(res,202,{run});return;
      }
      if(path==='/v1/requests'&&method==='POST'){const run=await chatbotIntake(store,a,FieldKitRequestSchema.parse(await body(req)));launch(runtime.drain());json(res,202,{schemaVersion:1,runId:run.id,status:run.stage,statusUrl:`/v1/runs/${run.id}`});return;}
      let match=path.match(/^\/(?:api|v1)\/runs\/([^/]+)$/);
      if(match&&method==='GET') {json(res,200,await runtime.inspect(a,match[1]));return;}
      match=path.match(/^\/api\/runs\/([^/]+)\/events$/);
      if(match&&method==='GET'){const after=z.coerce.number().int().min(0).parse(url.searchParams.get('after')??0);json(res,200,{events:store.events(t,match[1],after)});return;}
      match=path.match(/^\/api\/runs\/([^/]+)\/retry-ticket$/);
      if(match&&method==='POST'){const run=await runtime.services.retryTicket(a,match[1]);enqueueWebhook(store,run);deliverWebhooks(store);json(res,200,{run});return;}
      match=path.match(/^\/api\/traces\/([^/]+)$/);
      if(match&&method==='GET'){
        const run=findRun(t,match[1]);if(store.runs(t).some(r=>r.id===run.id)){json(res,200,await runtime.inspect(a,run.id));return;}
        const result=store.getReport<{trace:unknown}>(t,'eval-trace',run.id)?.trace??store.reports<{trace:{run:Run}}>(t,'rerun').find(r=>r.trace.run.id===run.id)?.trace;json(res,200,result);return;
      }
      match=path.match(/^\/api\/traces\/([^/]+)\/rerun$/);
      if(match&&method==='POST'){json(res,200,await rerun(store,findRun(t,match[1])));return;}
      match=path.match(/^\/api\/sandbox\/([^/]+)\/decision$/);
      if(match&&method==='POST'){const data=z.object({decision:z.enum(['approve','reject','escalate'])}).strict().parse(await body(req));json(res,200,await decideSandbox(store,a,match[1],data.decision));return;}
      if(path==='/api/approvals'&&method==='GET'){json(res,200,{approvals:store.list(t,'approval')});return;}
      match=path.match(/^\/api\/approvals\/([^/]+)\/decision$/);
      if(match&&method==='POST'){const data=z.object({revision:z.number().int().positive(),decision:z.enum(['approve','reject','escalate'])}).strict().parse(await body(req));const approval=runtime.decide(a,match[1],data.revision,data.decision);launch(runtime.drain());json(res,202,{approval});return;}
      if(path==='/api/discovery/scan'&&method==='POST'){json(res,200,scan(store,t));return;}
      if(path==='/api/discovery/remediate'&&method==='POST'){const data=z.object({fix:z.enum(['mapping','reviewed-fixtures'])}).strict().parse(await body(req));json(res,200,remediate(store,a,data.fix));return;}
      if(path==='/api/evaluations'&&method==='POST'){
        const data=z.object({suite:z.enum(['smoke','full','recovery']),seed:z.number().int().min(0).max(2147483647).default(42)}).strict().parse(await body(req));
        if(store.reports<Report>(t,'evaluation').some(r=>r.status==='running'))throw new DomainError(409,'A suite is already running for this customer');
        const report=makeReport(store,t,data.suite,data.seed);launch(executeReport(store,report));json(res,202,report);return;
      }
      match=path.match(/^\/api\/evaluations\/([^/]+)$/);if(match&&method==='GET'){const report=store.reports<Report>(t,'evaluation').find(r=>r.id===match![1]);if(!report)throw new DomainError(404,'Report not found');json(res,200,report);return;}
      if(path==='/api/integrations/intake'&&method==='POST') {const data=z.object({provider:ProviderSchema,ticketId:z.string().min(1).max(100),eventId:z.string().min(1).max(100),sequence:z.number().int().positive().default(1)}).strict().parse(await body(req));const run=await externalIntake(store,a,data.provider,data.ticketId,data.eventId,data.sequence);launch(runtime.drain());json(res,202,{run});return;}
      match=path.match(/^\/api\/integrations\/([^/]+)\/webhook$/);if(match&&method==='POST'){const provider=ProviderSchema.parse(match[1]),data=z.object({schemaVersion:z.literal(1),eventId:z.string().max(100),ticketId:z.string().max(100),sequence:z.number().int().positive()}).strict().parse(await body(req));const run=await externalIntake(store,a,provider,data.ticketId,data.eventId,data.sequence);launch(runtime.drain());json(res,202,{run});return;}
      if(path==='/api/webhooks'&&method==='GET'){json(res,200,{deliveries:deliveries(store,t)});return;}
      if(path==='/api/reset'&&method==='POST'){const data=z.object({confirm:TenantId}).strict().parse(await body(req));if(data.confirm!==t)throw new DomainError(400,'Reset confirmation must match the active customer');if(background.size)throw new DomainError(409,'Wait for active work to finish before resetting');await runtime.reset(a);seedExternal(store,t);json(res,200,{reset:t});return;}
      if(path==='/api/init'&&method==='POST'){throw new DomainError(409,`Deployment ${t} already exists; init never overwrites it. Use the scoped reset deliberately.`);}
      throw new DomainError(404,'Unknown endpoint');
    }catch(error){json(res,error instanceof DomainError?error.status:error instanceof ZodError?400:500,{error:error instanceof Error?error.message:'Unexpected server error'});}
  });
  return {server,store,runtime,async close(){await Promise.allSettled(background);await vite?.close();await new Promise<void>(resolve=>server.close(()=>resolve()));await runtime.close();}};
}
