import { ConfigSchema, type Account, type Invoice, type Snapshot, type Subscription, type Knowledge, type Tenant } from '../../core/src/types.js';
import { readCustomerFile, Store } from '../../core/src/store.js';
import { z } from 'zod';
const acmeAccount = z.object({ id: z.string(), name: z.string(), email: z.string() });
const northstarAccount = z.object({ customer_key: z.string(), display_name: z.string(), billing_contact: z.string() });
const globexAccount = z.object({ OrganizationId: z.string(), LegalName: z.string(), PrimaryContact: z.string() });
const normalizedInvoice = z.object({ id: z.string(), accountId: z.string(), amountMinor: z.number().int().nonnegative(), refundedMinor: z.number().int().nonnegative(), currency: z.string(), status: z.enum(['captured','unpaid']), duplicateOf: z.string().nullable(), subscriptionId: z.string(), version: z.number().int() });
export function normalizeKnowledge(tenant:Tenant,input:unknown):Knowledge[]{
  let rows=input;
  if(tenant==='northstar')rows=z.object({pages:z.array(z.object({id:z.string(),title:z.string(),version:z.object({number:z.number()}),body:z.object({storage:z.object({value:z.string()})}),fieldkit:z.record(z.string(),z.unknown())}))}).parse(input).pages.map(p=>({id:p.id,title:p.title,version:p.version.number,text:p.body.storage.value,...p.fieldkit}));
  if(tenant==='globex')rows=z.object({documents:z.array(z.object({document_key:z.string(),revision:z.number(),heading:z.string(),content:z.string(),governance:z.record(z.string(),z.unknown())}))}).parse(input).documents.map(p=>({id:p.document_key,version:p.revision,title:p.heading,text:p.content,...p.governance}));
  return z.array(z.object({ id:z.string(),title:z.string(),section:z.string(),text:z.string(),version:z.number().int(),effective:z.string(),expires:z.string(),authority:z.enum(['policy','guide','untrusted']),refundAllowed:z.boolean().optional() })).parse(rows);
}
// Customer formats intentionally differ at the source; only this boundary knows their schemas.
export function loadSnapshot(tenant: Tenant, root?: string): Snapshot {
  const config = ConfigSchema.parse(readCustomerFile(tenant,'config.json',root));
  const raw = z.object({ accounts: z.array(z.unknown()), invoices: z.array(z.record(z.string(),z.unknown())), subscriptions: z.array(z.custom<Subscription>()) }).parse(readCustomerFile(tenant,'records.json',root));
  const map = (key: string) => config.id_mapping[key] ?? key;
  const accounts: Account[] = raw.accounts.map(value => {
    const a = tenant === 'northstar' ? northstarAccount.parse(value) : tenant === 'globex' ? globexAccount.parse(value) : acmeAccount.parse(value);
    const v = 'customer_key' in a ? {id:a.customer_key,name:a.display_name,email:a.billing_contact} : 'OrganizationId' in a ? {id:a.OrganizationId,name:a.LegalName,email:a.PrimaryContact} : a;
    return {id:map(v.id),name:v.name,contact:v.email,authorizedActor: `${tenant}-requester`, deleted:false, version:1};
  });
  const invoices: Invoice[] = raw.invoices.map(v => normalizedInvoice.parse(tenant === 'northstar' ? {id:v.bill_key,accountId:map(String(v.customer_ref)),amountMinor:v.gross_cents,refundedMinor:v.credited_cents,currency:v.iso_currency,status:v.settled ? 'captured':'unpaid',duplicateOf:v.duplicate_bill,subscriptionId:v.subscription_ref,version:1} : tenant === 'globex' ? {id:v.DocumentId,accountId:map(String(v.OrganizationRef)),amountMinor:v.TotalMinor,refundedMinor:v.ReturnedMinor,currency:v.CurrencyCode,status:v.CaptureState === 'SETTLED' ? 'captured':'unpaid',duplicateOf:v.DuplicateDocument,subscriptionId:v.EntitlementId,version:1} : {...v,accountId:map(String(v.accountId))}));
  const knowledge = normalizeKnowledge(tenant,readCustomerFile(tenant,'knowledge.json',root));
  return { config, accounts, invoices, subscriptions:raw.subscriptions, knowledge };
}
export function seed(store: Store, tenant: Tenant, root?: string): boolean {
  if (store.get(tenant,'config',tenant)) return false;
  store.transaction(()=>store.restore(tenant,loadSnapshot(tenant,root))); return true;
}
