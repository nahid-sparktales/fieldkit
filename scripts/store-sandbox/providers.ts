import type { Database } from "../../packages/platform/src/db.js";
import type { Fetcher } from "../../packages/platform/src/security.js";

export const chargeFixture = {
  id: "ch_sandbox_backpack",
  customer: "cus_sandbox_alex",
  amount: 8900,
  amount_refunded: 0,
  currency: "usd",
  paid: true,
  captured: true,
  disputed: false,
  description: "TS-1001 · Summit Daypack · simulated purchase",
  created: 1790812800,
};
export const subscriptionFixture = {
  id: "sub_sandbox_club",
  customer: "cus_sandbox_alex",
  status: "active",
  cancel_at_period_end: false,
  items: {
    data: [{ price: { nickname: "Trail Club · $12/month · simulation" } }],
  },
};

// No fetch fallback: every unsupported destination fails closed. Receipts survive restarts.
export function storeProviders(db: Database): Fetcher {
  return async (raw, init = {}) => {
    const url = new URL(raw),
      path = url.pathname,
      method = init.method ?? "GET";
    if (url.origin !== "https://api.stripe.com")
      throw new Error(
        "Offline sandbox: external connections and imports are disabled. Upload a local document instead.",
      );
    const receipts = async () =>
      (
        await db.rows(
          "SELECT receipt FROM sandbox_receipts ORDER BY created_at",
        )
      ).map((r) => r.receipt);
    const refunds = async () =>
      (await receipts()).filter((r) => r.object === "refund");
    const charge = async () => ({
      ...chargeFixture,
      amount_refunded: (await refunds()).reduce((n, r) => n + r.amount, 0),
    });
    const subscription = async () =>
      (await receipts()).findLast((r) => r.object === "subscription") ??
      subscriptionFixture;
    if (method === "GET") {
      const customer = url.searchParams.get("customer");
      if (path === "/v1/charges")
        return Response.json({
          data: customer === chargeFixture.customer ? [await charge()] : [],
          has_more: false,
        });
      if (path === `/v1/charges/${chargeFixture.id}`)
        return Response.json(await charge());
      if (path === "/v1/subscriptions")
        return Response.json({
          data:
            customer === subscriptionFixture.customer
              ? [await subscription()]
              : [],
          has_more: false,
        });
      if (path === `/v1/subscriptions/${subscriptionFixture.id}`)
        return Response.json(await subscription());
      if (path === "/v1/refunds")
        return Response.json({ data: await refunds(), has_more: false });
    }
    if (
      method === "POST" &&
      ["/v1/refunds", `/v1/subscriptions/${subscriptionFixture.id}`].includes(
        path,
      )
    ) {
      const id = init.headers?.["Idempotency-Key"];
      if (!id) throw new Error("Sandbox writes require an operation ID");
      return db.tx(async (q) => {
        await q.query(
          "SELECT pg_advisory_xact_lock(hashtextextended('sandbox-billing',0))",
        );
        const old = await db.one(
          "SELECT receipt FROM sandbox_receipts WHERE id=$1",
          [id],
          q,
        );
        if (old) return Response.json(old.receipt);
        const body = new URLSearchParams(init.body),
          metadata = { fieldkit_operation: id };
        let receipt;
        if (path === "/v1/refunds") {
          const amount = Number(body.get("amount"));
          const existing = await db.rows(
            "SELECT receipt FROM sandbox_receipts WHERE receipt->>'object'='refund'",
            [],
            q,
          );
          const remaining =
            chargeFixture.amount -
            existing.reduce((n, r) => n + r.receipt.amount, 0);
          if (
            body.get("charge") !== chargeFixture.id ||
            !Number.isInteger(amount) ||
            amount <= 0 ||
            amount > remaining
          )
            return Response.json(
              { error: "Invalid simulated refund" },
              { status: 400 },
            );
          receipt = {
            id: "re_sandbox_" + id,
            object: "refund",
            charge: chargeFixture.id,
            amount,
            currency: "usd",
            status: "succeeded",
            metadata,
            simulated: true,
          };
        } else {
          if (body.get("cancel_at_period_end") !== "true")
            return Response.json(
              { error: "Only period-end cancellation is supported" },
              { status: 400 },
            );
          receipt = {
            ...subscriptionFixture,
            object: "subscription",
            cancel_at_period_end: true,
            metadata,
            simulated: true,
          };
        }
        await q.query(
          "INSERT INTO sandbox_receipts(id,receipt) VALUES($1,$2)",
          [id, receipt],
        );
        return Response.json(receipt);
      });
    }
    throw new Error(`Offline sandbox has no fixture for ${method} ${path}`);
  };
}
