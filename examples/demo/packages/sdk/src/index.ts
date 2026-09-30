import type { FieldKitRequest } from '../../integrations/src/contracts.js';
import type { Run, Approval } from '../../core/src/types.js';
export class FieldKitClient {
  constructor(readonly baseUrl:string,readonly token:string){}
  async request<T>(path:string,body?:unknown):Promise<T>{
    let response:Response|undefined;
    for(let attempt=0;attempt<(body===undefined?3:1);attempt++){
      try{response=await fetch(new URL(path,this.baseUrl),{method:body===undefined?'GET':'POST',headers:{Authorization:`Bearer ${this.token}`,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});break;}
      catch(error){if(body!==undefined||attempt===2)throw error;await new Promise(resolve=>setTimeout(resolve,50*(attempt+1)));}
    }
    const data=await response!.json();if(!response!.ok)throw new Error(`${response!.status}: ${data.error}`);return data as T;
  }
  resolve(request:FieldKitRequest){return this.request<{schemaVersion:1;runId:string;status:string;statusUrl:string}>('/v1/requests',request);}
  inspect(runId:string){return this.request<{run:Run;approval?:Approval}>(`/v1/runs/${encodeURIComponent(runId)}`);}
  approvals(){return this.request<{approvals:Approval[]}>('/api/approvals');}
}
