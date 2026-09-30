import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { FieldKitClient } from '../../sdk/src/index.js';
const base=process.env.FIELDKIT_URL??'http://localhost:4317',token=process.env.FIELDKIT_TOKEN;
if(!token)throw new Error('FIELDKIT_TOKEN must be a local demo session token. MCP cannot select or elevate an identity.');
const client=new FieldKitClient(base,token),server=new McpServer({name:'fieldkit',version:'1.0.0'});
const text=(value:unknown)=>({content:[{type:'text' as const,text:JSON.stringify(value)}]});
server.registerTool('resolve_support_request',{description:'Request a governed mock support resolution. Scope comes from the host session. Large or destructive actions wait for a manager; this tool cannot approve them.',inputSchema:{message:z.string().min(3).max(4000),conversationId:z.string().min(1).max(100),idempotencyKey:z.string().min(8).max(100)}},async input=>{
  const data=await client.request<{actor:{tenant:string;id:string;accountId:string}}>('/api/bootstrap');
  return text(await client.resolve({schemaVersion:1,deploymentId:data.actor.tenant,idempotencyKey:input.idempotencyKey,external:{conversationId:input.conversationId,channel:'mcp'},message:input.message,trustedContext:{tenantId:data.actor.tenant,actorId:data.actor.id,authenticatedCustomerId:data.actor.accountId}}));
});
server.registerTool('get_run_status',{description:'Read a tenant-authorized run and safe result. Does not execute or resume the graph.',inputSchema:{runId:z.string().uuid()}},async({runId})=>{const {run,approval}=await client.inspect(runId);return text({runId:run.id,status:run.stage,response:run.response,receipt:run.receipt,approval:approval?{id:approval.id,status:approval.status}:undefined});});
server.registerTool('get_policy_status',{description:'Read this deployment’s deterministic action constraints. Does not change policy.',inputSchema:{}},async()=>{const d=await client.request<{config:unknown;readiness:unknown}>('/api/bootstrap');return text({config:d.config,readiness:d.readiness});});
await server.connect(new StdioServerTransport());
