import { FieldKitClient } from '../../packages/sdk/src/index.js';
import { TenantId } from '../../packages/core/src/types.js';
import type { Report } from '../../packages/evals/src/harness.js';
const args=process.argv.slice(2),url=process.env.FIELDKIT_URL??'http://localhost:4317';
const flag=(name:string)=>args[args.indexOf(name)+1];
const tenant=TenantId.parse(process.env.FIELDKIT_CUSTOMER??(args[0]==='eval'||args[0]==='init'?args[1]:args[0]==='onboard'?args[1]?.split('/').filter(Boolean).at(-1):args.includes('--customer')?flag('--customer'):undefined)??'acme');
try {
  let token=process.env.FIELDKIT_TOKEN;
  if(!token){const r=await fetch(`${url}/api/session`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({tenant,persona:'support_manager'})});const session=await r.json();if(!r.ok)throw new Error(session.error);token=session.token;}
  const client=new FieldKitClient(url,token!);let result:unknown;
  if(args[0]==='init'){result=await client.request('/api/init',{});}
  else if(args[0]==='onboard'){result=await client.request('/api/discovery/scan',{});}
  else if(args[0]==='eval'){
    let report=await client.request<Report>('/api/evaluations',{suite:args.includes('--suite')?flag('--suite'):'smoke',seed:args.includes('--seed')?Number(flag('--seed')):42});
    while(report.status==='running'){await new Promise(r=>setTimeout(r,500));report=await client.request<Report>(`/api/evaluations/${report.id}`);}
    console.log(report.markdown);console.log(`Report ID: ${report.id}`);if(report.status==='failed')process.exitCode=1;
  }else if(args[0]==='workflow'&&args[1]==='inspect')result=await client.request(`/api/traces/${encodeURIComponent(args[2])}`);
  else if(args[0]==='replay'){
    if(args.includes('--rerun')){if(!args.includes('--sandbox'))throw new Error('Rerun requires --sandbox');result=await client.request(`/api/traces/${encodeURIComponent(args[1])}/rerun`,{});}
    else result=await client.request(`/api/traces/${encodeURIComponent(args[1])}`);
  }else if(args[0]==='demo'&&args[1]==='reset')result=await client.request('/api/reset',{confirm:tenant});
  else throw new Error('Commands: init <customer>, onboard ./customers/<customer>, eval <customer> --suite smoke|full|recovery --seed 42, workflow inspect <run-id>, replay <trace-id> [--rerun --sandbox], demo reset --customer <customer>. Start the local API first.');
  if(result)console.log(JSON.stringify(result,null,2));
}catch(error){console.error(String(error));process.exitCode=1;}
