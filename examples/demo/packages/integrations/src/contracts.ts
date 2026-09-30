import { z } from 'zod';
export const ProviderSchema=z.enum(['mock_jira_service_management','mock_zendesk','generic_chatbot','fieldkit_native']);
export type Provider=z.infer<typeof ProviderSchema>;
export type NormalizedTicketStatus='open'|'waiting_for_approval'|'resolved'|'escalated'|'denied';
export type ExternalTicketRef={provider:Provider;ticketId:string};
export type SupportTicket={ref:ExternalTicketRef;accountId:string;requesterId:string;conversationId:string;subject:string;message:string;status:NormalizedTicketStatus;version:number;native:unknown};
export type SupportCapabilities={simulated:true;authentication:'local_demo_session';read:boolean;internalNote:boolean;reply:boolean;updateStatus:boolean;assign:boolean;tags:boolean;webhooks:boolean;idempotency:boolean;reconciliation:boolean;rateLimitPerMinute:number;statusMap:Record<string,NormalizedTicketStatus>;accountMap:Record<string,string>};
export type SupportNote={idempotencyKey:string;text:string};
export type SupportReply=SupportNote;
export type ExternalWriteReceipt={id:string;provider:Provider;ticketId:string;operation:string;version:number;at:string};
export interface SupportAdapter {
  capabilities():Promise<SupportCapabilities>;
  getTicket(ref:ExternalTicketRef):Promise<SupportTicket>;
  addInternalNote(ref:ExternalTicketRef,note:SupportNote):Promise<ExternalWriteReceipt>;
  replyToCustomer(ref:ExternalTicketRef,reply:SupportReply):Promise<ExternalWriteReceipt>;
  updateStatus(ref:ExternalTicketRef,status:NormalizedTicketStatus,idempotencyKey:string):Promise<ExternalWriteReceipt>;
  assignTicket?(ref:ExternalTicketRef,assignee:{id:string},idempotencyKey:string):Promise<ExternalWriteReceipt>;
  addTags?(ref:ExternalTicketRef,tags:string[],idempotencyKey:string):Promise<ExternalWriteReceipt>;
}
export const FieldKitRequestSchema=z.object({schemaVersion:z.literal(1),deploymentId:z.string().max(60),idempotencyKey:z.string().min(8).max(100),external:z.object({conversationId:z.string().min(1).max(100),channel:z.string().max(40),ticketId:z.string().max(100).optional()}).strict(),message:z.string().min(3).max(4000),trustedContext:z.object({authenticatedCustomerId:z.string().optional(),actorId:z.string().optional(),tenantId:z.string()}).strict(),context:z.object({recentMessages:z.array(z.object({role:z.enum(['user','assistant']),content:z.string().max(2000)}).strict()).max(6).optional(),metadata:z.record(z.string().max(60),z.string().max(200)).optional()}).strict().optional()}).strict();
export type FieldKitRequest=z.infer<typeof FieldKitRequestSchema>;
