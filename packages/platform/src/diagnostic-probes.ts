import { TestResource } from "./readiness-contracts.js";
import type { ActionDefinition } from "./contracts.js";
import type { Platform } from "./platform.js";
import { HttpError, requireValue } from "./config.js";
import { validateObject } from "./workflow-components.js";

// A diagnostic operation has its own persistent ID, never a production approval.
// Every write is marked before dispatch by the diagnostic runner. Reconciliation
// only performs outcome reads; uncertain writes are never retried automatically.
export async function dedicatedProbe(
  app: Platform,
  ws: string,
  kind: string,
  run: any,
  reconcile = false,
  beforeWrite: () => Promise<void> = async () => {},
) {
  const input = TestResource.parse(run.request.testResource),
    operationId = `diagnostic-${run.id}`;
  const result = (id: string) => ({
    level: "dedicated_test_write_verified" as const,
    summary:
      "The exact dedicated test operation was confirmed. This does not verify other operations or production resources.",
    facts: { operationId, providerId: id, operation: kind },
  });
  if (kind === "zendesk_note") {
    const ticketId = requireValue(
      input.ticketId,
      400,
      "Enter the dedicated Zendesk test ticket ID",
    );
    const { ticket } = await app.connections.json(
      ws,
      "zendesk",
      `/api/v2/tickets/${ticketId}.json`,
    );
    if (
      !Array.isArray(ticket.tags) ||
      !ticket.tags.includes("fieldkit_diagnostic_test")
    )
      throw new HttpError(
        409,
        "Tag the dedicated test ticket fieldkit_diagnostic_test before testing",
      );
    if (
      await app.db.one(
        "SELECT 1 FROM conversations WHERE workspace_id=$1 AND external_id=$2",
        [ws, ticketId],
      )
    )
      throw new HttpError(
        409,
        "Use an unlinked dedicated ticket, never a customer ticket handled by FieldKit",
      );
    if (reconcile) {
      let path = `/api/v2/tickets/${ticketId}/audits.json?page[size]=100`;
      for (let page = 0; page < 20 && path; page++) {
        const response = await app.connections.json(ws, "zendesk", path);
        const audit = response.audits?.find((a: any) =>
          a.events?.some(
            (e: any) =>
              e.type === "Comment" &&
              e.public === false &&
              e.body === `FieldKit dedicated diagnostic ${operationId}`,
          ),
        );
        if (audit) return result(String(audit.id));
        if (!response.next_page && !response.links?.next) break;
        const root = `https://${(await app.db.connection(ws, "zendesk")).metadata.subdomain}.zendesk.com`,
          next = new URL(response.next_page ?? response.links.next, root);
        if (next.origin !== root)
          throw new HttpError(502, "Unexpected diagnostic pagination origin");
        path = next.pathname + next.search;
      }
      throw new HttpError(
        409,
        "Outcome remains unknown; no second note was sent",
      );
    }
    await beforeWrite();
    const response = await app.connections.json(
      ws,
      "zendesk",
      `/api/v2/tickets/${ticketId}.json`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ticket: {
            safe_update: true,
            updated_stamp: ticket.updated_at,
            comment: {
              body: `FieldKit dedicated diagnostic ${operationId}`,
              public: false,
            },
            metadata: { fieldkit_diagnostic: operationId },
          },
        }),
      },
    );
    if (!response.audit?.id)
      throw new HttpError(502, "Provider did not return a confirmed audit");
    return result(String(response.audit.id));
  }
  if (kind === "stripe_refund" || kind === "stripe_cancel") {
    const customerId = requireValue(
      input.customerId,
      400,
      "Enter the dedicated Stripe test customer ID",
    );
    const customer = await app.connections.json(
      ws,
      "stripe_test",
      `/v1/customers/${encodeURIComponent(customerId)}`,
    );
    if (
      customer.livemode !== false ||
      customer.metadata?.fieldkit_diagnostic !== "true"
    )
      throw new HttpError(
        409,
        "Use a Stripe test-mode customer with metadata fieldkit_diagnostic=true",
      );
    if (kind === "stripe_refund") {
      const chargeId = requireValue(
          input.chargeId,
          400,
          "Enter a dedicated test charge ID",
        ),
        amount = requireValue(
          input.amountMinor,
          400,
          "Enter the exact test refund amount (1–100 minor units)",
        );
      const charge = await app.connections.json(
        ws,
        "stripe_test",
        `/v1/charges/${encodeURIComponent(chargeId)}`,
      );
      if (
        charge.livemode !== false ||
        charge.customer !== customerId ||
        charge.metadata?.fieldkit_diagnostic !== "true"
      )
        throw new HttpError(
          409,
          "Charge does not belong to the marked dedicated test customer",
        );
      if (reconcile) {
        let after = "";
        for (let page = 0; page < 20; page++) {
          const data = await app.connections.json(
            ws,
            "stripe_test",
            `/v1/refunds?charge=${chargeId}&limit=100${after ? "&starting_after=" + encodeURIComponent(after) : ""}`,
          );
          const found = data.data?.find(
            (r: any) =>
              r.metadata?.fieldkit_diagnostic === operationId &&
              r.amount === amount &&
              r.status === "succeeded",
          );
          if (found) return result(found.id);
          if (!data.has_more) break;
          after = data.data.at(-1).id;
        }
        throw new HttpError(
          409,
          "Refund outcome remains unknown; no second refund was attempted",
        );
      }
      if (
        !charge.paid ||
        !charge.captured ||
        charge.disputed ||
        charge.amount - charge.amount_refunded < amount
      )
        throw new HttpError(
          409,
          "Dedicated charge is not eligible for this exact partial refund",
        );
      await beforeWrite();
      const refund = await app.connections.json(
        ws,
        "stripe_test",
        "/v1/refunds",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            "Idempotency-Key": operationId,
          },
          body: new URLSearchParams({
            charge: chargeId,
            amount: String(amount),
            "metadata[fieldkit_diagnostic]": operationId,
          }).toString(),
        },
      );
      if (refund.status !== "succeeded" || refund.amount !== amount)
        throw new HttpError(502, "Refund not yet confirmed");
      return result(refund.id);
    }
    const subId = requireValue(
      input.subscriptionId,
      400,
      "Enter the exact dedicated test subscription ID",
    );
    const sub = await app.connections.json(
      ws,
      "stripe_test",
      `/v1/subscriptions/${encodeURIComponent(subId)}`,
    );
    if (
      sub.livemode !== false ||
      sub.customer !== customerId ||
      sub.metadata?.fieldkit_diagnostic !== "true"
    )
      throw new HttpError(
        409,
        "Subscription is not a marked dedicated test resource owned by this customer",
      );
    if (reconcile) {
      if (
        sub.cancel_at_period_end &&
        sub.metadata?.fieldkit_diagnostic_operation === operationId
      )
        return result(sub.id);
      throw new HttpError(
        409,
        "Cancellation outcome remains unknown; no second update was attempted",
      );
    }
    if (
      sub.cancel_at_period_end ||
      !["active", "trialing", "past_due"].includes(sub.status)
    )
      throw new HttpError(
        409,
        "Test subscription is already ending or inactive",
      );
    await beforeWrite();
    const changed = await app.connections.json(
      ws,
      "stripe_test",
      `/v1/subscriptions/${encodeURIComponent(subId)}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "Idempotency-Key": operationId,
        },
        body: new URLSearchParams({
          cancel_at_period_end: "true",
          "metadata[fieldkit_diagnostic_operation]": operationId,
        }).toString(),
      },
    );
    if (!changed.cancel_at_period_end)
      throw new HttpError(502, "Period-end cancellation not confirmed");
    return result(changed.id);
  }
  if (kind.startsWith("custom:")) {
    const action = requireValue(
      await app.db.one<ActionDefinition>(
        "SELECT * FROM actions WHERE workspace_id=$1 AND id=$2 AND enabled AND kind IN ('custom_read','custom_write')",
        [ws, kind.slice(7)],
      ),
    );
    if (!action.config.diagnosticTest)
      throw new HttpError(
        409,
        "Mark this fixed action endpoint as a dedicated test integration in its configuration first",
      );
    if (
      action.kind === "custom_write" &&
      (!action.config.idempotent || !action.config.lookupEndpoint)
    )
      throw new HttpError(
        409,
        "A diagnostic write requires both idempotency and outcome lookup",
      );
    const contact = requireValue(
      await app.db.one(
        "SELECT * FROM contacts WHERE workspace_id=$1 AND id=$2 AND verified AND external_id LIKE 'fieldkit-test-%'",
        [ws, input.contactId],
      ),
      409,
      "Choose a verified staff-mapped test identity whose external ID starts fieldkit-test-",
    );
    const identity = contact.mappings?.[action.config.mappingKey];
    if (typeof identity !== "string" || !identity)
      throw new HttpError(
        409,
        "Review the dedicated test customer provider mapping first",
      );
    validateObject(
      requireValue(
        action.config.inputSchema,
        409,
        "Configure a test input schema",
      ),
      input.parameters,
      "Diagnostic action input",
    );
    if (reconcile) {
      const lookup = await app.actions.custom(
        action,
        ws,
        { operationId, customerId: identity },
        true,
      );
      if (lookup.status !== "confirmed" || lookup.operationId !== operationId)
        throw new HttpError(
          409,
          "Custom outcome remains unknown; no second write was attempted",
        );
      validateObject(
        requireValue(
          action.config.outputSchema,
          409,
          "Configure a test output schema",
        ),
        lookup.result,
        "Diagnostic lookup result",
      );
    } else {
      await beforeWrite();
      const current = await app.db.one(
        "SELECT revision FROM contacts WHERE workspace_id=$1 AND id=$2",
        [ws, contact.id],
      );
      if (current?.revision !== contact.revision)
        throw new HttpError(409, "Dedicated test identity changed");
      await app.actions.custom(
        action,
        ws,
        { operationId, customerId: identity, parameters: input.parameters },
        false,
      );
    }
    return {
      ...result(operationId),
      level:
        action.kind === "custom_read"
          ? ("read_verified" as const)
          : ("dedicated_test_write_verified" as const),
    };
  }
  throw new HttpError(400, "Unsupported dedicated test capability");
}
