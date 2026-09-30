import { createApp } from './server.js';
const port=Number(process.env.FIELDKIT_PORT??4317),app=await createApp({dataDir:process.env.FIELDKIT_DATA??'.fieldkit',dev:process.env.NODE_ENV!=='production',port});
app.server.listen(port,'127.0.0.1',()=>console.log(`FieldKit: http://localhost:${port} · offline simulated infrastructure · LangGraph + SQLite`));
let closing=false;for(const signal of ['SIGINT','SIGTERM'])process.on(signal,async()=>{if(closing)return;closing=true;await app.close();process.exit(0);});
