import Ajv from "ajv";
import { z } from "zod";
import type { Database, Queryable } from "./db.js";
import { uid } from "./db.js";
import type { Connections } from "./connections.js";
import { HttpError, requireValue } from "./config.js";
import {
  ActionInput,
  type ActionDefinition,
  type Proposal,
} from "./contracts.js";
import { canonical, digest, externalURL } from "./security.js";

const ajv = new Ajv({ allErrors: true, strict: true, validateFormats: false });
const Refund = z
  .object({
    chargeId: z.string().regex(/^ch_/),
    amountMinor: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    currency: z.string().regex(/^[a-z]{3}$/),
  })
  .strict();
const Cancel = z.object({ subscriptionId: z.string().regex(/^sub_/) }).strict();
export const schemaFor = (action: ActionDefinition) =>
  action.kind === "stripe_refund"
    ? z.toJSONSchema(Refund)
    : action.kind === "stripe_cancel"
      ? z.toJSONSchema(Cancel)
      : action.config.inputSchema;
export class Actions {
  constructor(
    public db: Database,
    public connections: Connections,
  ) {}
  async save(ws: string, input: unknown, id?: string) {
    const data = ActionInput.parse(input);
    if (data.kind.startsWith("custom")) {
      externalURL(
        requireValue(
          data.config.endpoint,
          400,
          "Custom actions require an HTTPS endpoint",
        ),
      );
      if (!data.config.inputSchema || !data.config.outputSchema)
        throw new HttpError(
          400,
          "Custom actions require input and output JSON schemas",
        );
      if (
        data.config.inputSchema.type !== "object" ||
        data.config.inputSchema.additionalProperties !== false
      )
        throw new HttpError(
          400,
          "Input schemas must be closed objects (additionalProperties: false)",
        );
      ajv.compile(data.config.inputSchema);
      ajv.compile(data.config.outputSchema);
      if (data.config.lookupEndpoint) externalURL(data.config.lookupEndpoint);
      if (
        data.kind === "custom_write" &&
        data.policy.mode === "automatic" &&
        (!data.config.idempotent || !data.config.lookupEndpoint)
      )
        throw new HttpError(
          400,
          "Automatic writes require idempotency and an outcome lookup endpoint",
        );
      if (data.config.credentialId)
        await this.db.connection(ws, `custom:${data.config.credentialId}`);
    }
    if (id) {
      const r = await this.db.rows(
        "UPDATE actions SET name=$1,description=$2,kind=$3,enabled=$4,config=$5,policy=$6,revision=revision+1 WHERE workspace_id=$7 AND id=$8 RETURNING *",
        [
          data.name,
          data.description,
          data.kind,
          data.enabled,
          data.config,
          data.policy,
          ws,
          id,
        ],
      );
      return requireValue(r[0]);
    }
    return (
      await this.db.rows(
        "INSERT INTO actions(id,workspace_id,name,description,kind,enabled,config,policy) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *",
        [
          uid(),
          ws,
          data.name,
          data.description,
          data.kind,
          data.enabled,
          data.config,
          data.policy,
        ],
      )
    )[0];
  }
  async account(ws: string, contact: any) {
    if (!contact.verified) return null;
    const connections = await this.db.rows(
      "SELECT * FROM connections WHERE workspace_id=$1 AND provider IN ('stripe_test','stripe_live') AND status='connected'",
      [ws],
    );
    const result = [];
    for (const connection of connections) {
      const account = await this.accountForConnection(ws, contact, connection);
      if (account) result.push({ mode: connection.metadata.mode, ...account });
    }
    return result.length ? result : null;
  }
  private async accountForConnection(
    ws: string,
    contact: any,
    connection: any,
  ) {
    const customer = contact.mappings[`stripe_${connection!.metadata.mode}`];
    if (typeof customer !== "string" || !customer.startsWith("cus_"))
      return null;
    const paginate = async (path: string) => {
      const result: any[] = [];
      let after = "";
      for (let page = 0; page < 10; page++) {
        const r = await this.connections.json(
          ws,
          connection.provider,
          `${path}&limit=100${after ? "&starting_after=" + encodeURIComponent(after) : ""}`,
        );
        result.push(...r.data);
        if (!r.has_more) return result;
        after = r.data.at(-1).id;
      }
      throw new Error(
        "Customer has too many billing records; hand off to staff",
      );
    };
    const [charges, subs] = await Promise.all([
      paginate(`/v1/charges?customer=${encodeURIComponent(customer)}`),
      paginate(
        `/v1/subscriptions?customer=${encodeURIComponent(customer)}&status=all`,
      ),
    ]);
    return {
      charges: charges
        .filter((c) => c.customer === customer)
        .map((c) => ({
          id: c.id,
          description: c.description,
          amountMinor: c.amount,
          refundedMinor: c.amount_refunded,
          currency: c.currency,
          paid: c.paid,
          captured: c.captured,
          created: c.created,
        })),
      subscriptions: subs
        .filter((s) => s.customer === customer)
        .map((s) => ({
          id: s.id,
          status: s.status,
          cancelAtPeriodEnd: s.cancel_at_period_end,
          items: s.items.data.map((i: any) => ({
            description: i.price?.nickname ?? i.price?.id,
          })),
        })),
    };
  }
  async prepare(
    ws: string,
    run: any,
    contact: any,
    action: ActionDefinition,
    parameters: Record<string, unknown>,
    evidenceHash: string,
    reason: string,
  ): Promise<Proposal> {
    if (!contact.verified)
      throw new HttpError(
        403,
        "Verify the customer identity before account actions",
      );
    this.validateParameters(action, parameters);
    const provider = action.kind.startsWith("stripe")
      ? `stripe_${action.config.stripeMode ?? "test"}`
      : action.config.credentialId
        ? `custom:${action.config.credentialId}`
        : null;
    const connection = provider ? await this.db.connection(ws, provider) : null;
    const workspace = requireValue(
      await this.db.one("SELECT revision FROM workspaces WHERE id=$1", [ws]),
    );
    return {
      actionId: action.id,
      actionRevision: action.revision,
      parameters,
      contactId: contact.id,
      contactRevision: contact.revision,
      connectionRevision: connection?.revision ?? 0,
      workspaceRevision: workspace.revision,
      conversationRevision: run.revision,
      evidenceHash,
      reason,
    };
  }
  validateParameters(
    action: ActionDefinition,
    parameters: Record<string, unknown>,
  ) {
    if (action.kind === "stripe_refund") Refund.parse(parameters);
    else if (action.kind === "stripe_cancel") Cancel.parse(parameters);
    else {
      const validate = ajv.compile(
        requireValue(action.config.inputSchema, 400, "Missing input schema"),
      );
      if (!validate(parameters))
        throw new HttpError(
          400,
          "Parameters do not match the configured action schema",
        );
    }
  }
  async automatic(ws: string, action: ActionDefinition, p: Proposal) {
    if (action.kind === "custom_read") return true;
    if (action.policy.mode !== "automatic") return false;
    if (
      action.kind === "stripe_refund" &&
      (Number(p.parameters.amountMinor) > action.policy.maxAmountMinor ||
        p.parameters.currency !== action.policy.currency)
    )
      return false;
    if (
      action.kind === "custom_write" &&
      (!action.config.idempotent || !action.config.lookupEndpoint)
    )
      return false;
    const used = await this.db.one(
      "SELECT count(*) n FROM operations WHERE workspace_id=$1 AND action_id=$2 AND created_at>=date_trunc('day',now()) AND status<>'failed'",
      [ws, action.id],
    );
    return Number(used!.n) < action.policy.dailyLimit;
  }
  async revalidate(ws: string, p: Proposal, q: Queryable = this.db.pool) {
    const action = requireValue(
      await this.db.one<ActionDefinition>(
        "SELECT * FROM actions WHERE workspace_id=$1 AND id=$2",
        [ws, p.actionId],
        q,
      ),
    );
    const contact = requireValue(
      await this.db.one(
        "SELECT * FROM contacts WHERE workspace_id=$1 AND id=$2",
        [ws, p.contactId],
        q,
      ),
    );
    const workspace = requireValue(
      await this.db.one("SELECT revision FROM workspaces WHERE id=$1", [ws], q),
    );
    if (
      !action.enabled ||
      action.revision !== p.actionRevision ||
      !contact.verified ||
      contact.revision !== p.contactRevision ||
      workspace.revision !== p.workspaceRevision
    )
      throw new HttpError(
        409,
        "The action, identity mapping, or policy changed; a new proposal is required",
      );
    this.validateParameters(action, p.parameters);
    const provider = action.kind.startsWith("stripe")
      ? `stripe_${action.config.stripeMode ?? "test"}`
      : action.config.credentialId
        ? `custom:${action.config.credentialId}`
        : null;
    const connection = provider
      ? requireValue(
          await this.db.one(
            "SELECT * FROM connections WHERE workspace_id=$1 AND provider=$2 AND status='connected'",
            [ws, provider],
            q,
          ),
          409,
          "Connection was removed",
        )
      : null;
    if ((connection?.revision ?? 0) !== p.connectionRevision)
      throw new HttpError(
        409,
        "Connection changed; a new proposal is required",
      );
    const identity = action.kind.startsWith("stripe")
      ? contact.mappings[`stripe_${connection!.metadata.mode}`]
      : contact.mappings[action.config.mappingKey];
    if (typeof identity !== "string" || !identity)
      throw new HttpError(
        403,
        "A staff-reviewed provider identity mapping is required",
      );
    return { action, contact, identity, connection };
  }
  async validateRemote(
    ws: string,
    p: Proposal,
    action: ActionDefinition,
    identity: string,
  ) {
    if (action.kind === "stripe_refund") {
      const charge = await this.connections.json(
        ws,
        `stripe_${action.config.stripeMode ?? "test"}`,
        `/v1/charges/${encodeURIComponent(String(p.parameters.chargeId))}`,
      );
      if (
        charge.customer !== identity ||
        !charge.paid ||
        !charge.captured ||
        charge.disputed ||
        charge.currency !== p.parameters.currency ||
        charge.amount - charge.amount_refunded <
          Number(p.parameters.amountMinor)
      )
        throw new HttpError(
          409,
          "Charge ownership, captured balance, currency or dispute status does not permit this refund",
        );
    } else if (action.kind === "stripe_cancel") {
      const sub = await this.connections.json(
        ws,
        `stripe_${action.config.stripeMode ?? "test"}`,
        `/v1/subscriptions/${encodeURIComponent(String(p.parameters.subscriptionId))}`,
      );
      if (
        sub.customer !== identity ||
        !["active", "trialing", "past_due", "unpaid"].includes(sub.status) ||
        sub.cancel_at_period_end
      )
        throw new HttpError(
          409,
          "Subscription does not belong to this customer or is already ending",
        );
    }
  }
  async execute(
    ws: string,
    runId: string,
    p: Proposal,
    action: ActionDefinition,
    identity: string,
  ): Promise<any> {
    const resource = `${action.kind}:${action.kind.startsWith("stripe_") ? `stripe_${action.config.stripeMode ?? "test"}` : action.id}:${identity}:${p.parameters.chargeId ?? p.parameters.subscriptionId ?? digest(p.parameters)}`;
    let op = await this.db.one(
      "SELECT * FROM operations WHERE workspace_id=$1 AND run_id=$2",
      [ws, runId],
    );
    if (op?.status === "confirmed") return op.receipt;
    if (op?.status === "unknown" || op?.status === "sent")
      return this.reconcile(ws, op, p, action, identity);
    if (op?.status === "failed")
      throw new HttpError(
        409,
        "The previous operation failed; create a new request",
      );
    await this.validateRemote(ws, p, action, identity);
    if (!op)
      op = (
        await this.db.rows(
          "INSERT INTO operations(id,workspace_id,run_id,action_id,proposal_hash,resource) VALUES($1,$2,$3,$4,$5,$6) RETURNING *",
          [uid(), ws, runId, action.id, digest(p), resource],
        )
      )[0];
    await this.db.pool.query(
      "UPDATE operations SET status='sent',sent_at=now() WHERE id=$1",
      [op.id],
    );
    try {
      let result: any;
      if (action.kind === "stripe_refund")
        result = await this.connections.json(
          ws,
          `stripe_${action.config.stripeMode ?? "test"}`,
          "/v1/refunds",
          {
            method: "POST",
            headers: {
              "Content-Type": "application/x-www-form-urlencoded",
              "Idempotency-Key": op.id,
            },
            body: new URLSearchParams({
              charge: String(p.parameters.chargeId),
              amount: String(p.parameters.amountMinor),
              "metadata[fieldkit_operation]": op.id,
            }).toString(),
          },
        );
      else if (action.kind === "stripe_cancel")
        result = await this.connections.json(
          ws,
          `stripe_${action.config.stripeMode ?? "test"}`,
          `/v1/subscriptions/${encodeURIComponent(String(p.parameters.subscriptionId))}`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/x-www-form-urlencoded",
              "Idempotency-Key": op.id,
            },
            body: new URLSearchParams({
              cancel_at_period_end: "true",
              "metadata[fieldkit_operation]": op.id,
            }).toString(),
          },
        );
      else
        result = await this.custom(
          action,
          ws,
          {
            operationId: op.id,
            customerId: identity,
            parameters: p.parameters,
          },
          false,
        );
      if (action.kind === "stripe_refund" && result.status !== "succeeded")
        throw new Error(
          "Refund is pending or failed; reconcile its provider status",
        );
      if (action.kind === "stripe_cancel" && !result.cancel_at_period_end)
        throw new Error("Provider did not confirm period-end cancellation");
      return this.confirm(op, action, result);
    } catch (e) {
      await this.db.pool.query(
        "UPDATE operations SET status='unknown',error=$1 WHERE id=$2",
        [e instanceof Error ? e.message : "Provider outcome unknown", op.id],
      );
      throw new HttpError(
        409,
        "The provider outcome is uncertain. Staff must reconcile it before any retry.",
      );
    }
  }
  async custom(
    action: ActionDefinition,
    ws: string,
    body: unknown,
    lookup: boolean,
  ) {
    const provider = action.config.credentialId
      ? await this.db.connection(ws, `custom:${action.config.credentialId}`)
      : null;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (provider)
      headers.Authorization = `Bearer ${this.connections.secret(provider).apiKey}`;
    if (
      action.config.idempotent &&
      body &&
      typeof body === "object" &&
      "operationId" in body
    )
      headers["Idempotency-Key"] = String(body.operationId);
    const res = await this.connections.fetch(
      requireValue(
        lookup ? action.config.lookupEndpoint : action.config.endpoint,
      ),
      {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        limit: 128 * 1024,
      },
    );
    if (!res.ok) throw new HttpError(502, `Custom API returned ${res.status}`);
    const result = (await res.json()) as any;
    if (!lookup) {
      const validate = ajv.compile(requireValue(action.config.outputSchema));
      if (!validate(result))
        throw new Error(
          "Custom API output did not match its configured schema",
        );
    }
    return result;
  }
  async reconcile(
    ws: string,
    op: any,
    p: Proposal,
    action: ActionDefinition,
    identity: string,
  ) {
    let result: any;
    if (action.kind === "stripe_refund") {
      let after = "";
      for (let page = 0; page < 20; page++) {
        const refunds = await this.connections.json(
          ws,
          `stripe_${action.config.stripeMode ?? "test"}`,
          `/v1/refunds?charge=${encodeURIComponent(String(p.parameters.chargeId))}&limit=100${after ? "&starting_after=" + encodeURIComponent(after) : ""}`,
        );
        result = refunds.data.find(
          (r: any) =>
            r.metadata?.fieldkit_operation === op.id &&
            r.status === "succeeded" &&
            r.amount === p.parameters.amountMinor &&
            r.currency === p.parameters.currency,
        );
        if (result || !refunds.has_more) break;
        after = refunds.data.at(-1).id;
      }
    } else if (action.kind === "stripe_cancel") {
      const sub = await this.connections.json(
        ws,
        `stripe_${action.config.stripeMode ?? "test"}`,
        `/v1/subscriptions/${encodeURIComponent(String(p.parameters.subscriptionId))}`,
      );
      if (
        sub.customer === identity &&
        sub.metadata?.fieldkit_operation === op.id &&
        sub.cancel_at_period_end
      )
        result = sub;
    } else if (action.config.lookupEndpoint) {
      const lookup = await this.custom(
        action,
        ws,
        { operationId: op.id, customerId: identity },
        true,
      );
      if (lookup.status === "confirmed" && lookup.operationId === op.id) {
        const validate = ajv.compile(requireValue(action.config.outputSchema));
        if (validate(lookup.result)) result = lookup.result;
      }
    }
    if (!result) {
      await this.db.pool.query(
        "UPDATE operations SET status='unknown' WHERE id=$1",
        [op.id],
      );
      throw new HttpError(
        409,
        "Outcome remains unknown; no new write was attempted",
      );
    }
    return this.confirm(op, action, result);
  }
  async confirm(op: any, action: ActionDefinition, result: any) {
    const receipt = {
      operationId: op.id,
      action: action.kind,
      providerId: result.id ?? null,
      confirmedAt: new Date().toISOString(),
      result:
        action.kind === "stripe_refund"
          ? {
              amountMinor: result.amount,
              currency: result.currency,
              status: result.status,
            }
          : action.kind === "stripe_cancel"
            ? { cancelAtPeriodEnd: result.cancel_at_period_end }
            : result,
    };
    await this.db.pool.query(
      "UPDATE operations SET status='confirmed',receipt=$1,error=null WHERE id=$2",
      [receipt, op.id],
    );
    return receipt;
  }
}
