import { Store, id } from '../packages/core/src/store.js';
import { Runtime } from '../packages/workflows/src/runtime.js';
import { seed } from '../packages/connectors/src/adapters.js';
import { externalIntake } from '../packages/integrations/src/support.js';
import { demoActor } from '../packages/core/src/services.js';
const r=new Runtime(new Store(process.argv[2]));seed(r.store,'acme');const run=await externalIntake(r.store,demoActor('acme'),'mock_jira_service_management','ACME-1043',id());await r.drain();console.log(JSON.stringify(r.store.run('acme',run.id)));await r.close();
