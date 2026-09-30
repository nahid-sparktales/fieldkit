import { Runtime } from '../packages/workflows/src/runtime.js';
import { Store, id } from '../packages/core/src/store.js';
import { seed } from '../packages/connectors/src/adapters.js';
import { demoActor } from '../packages/core/src/services.js';
const [dir,action,key,decision]=process.argv.slice(2);
const r=new Runtime(new Store(dir));seed(r.store,'acme');
try {
  if(action==='start') {const run=r.start(demoActor('acme'),{text:key==='large'?'Refund duplicate annual $8000 invoice':'Refund duplicate charge for both plans',requestKey:id(),channel:'api'});await r.drain();console.log(JSON.stringify(r.store.run('acme',run.id)));}
  else if(action==='decide') {const run=r.store.run('acme',key);r.decide(demoActor('acme',true),run.approvalId!,1,(decision??'approve') as 'approve'|'reject');console.log(JSON.stringify({saved:true}));}
  else if(action==='drain') {await r.drain();console.log(JSON.stringify(r.store.runs('acme')));}
} catch(error) {console.error(String(error));process.exitCode=1;} finally {await r.close();}
