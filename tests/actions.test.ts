import { test } from "node:test";
import assert from "node:assert/strict";
import {
  automaticPolicy,
  declaredOutput,
} from "../packages/platform/src/actions.js";
import type { ActionDefinition } from "../packages/platform/src/contracts.js";

const action = (kind: string, mode: "approval" | "automatic", extra = {}) =>
  ({
    id: "a1",
    name: "lookup",
    description: "",
    kind,
    enabled: true,
    config: { mappingKey: "customer_id", ...extra },
    policy: { mode, maxAmountMinor: 0, currency: "usd", dailyLimit: 2 },
  }) as unknown as ActionDefinition;

test("custom reads honour the approval mode and daily limit like every other kind", () => {
  assert.equal(
    automaticPolicy(action("custom_read", "approval"), {}, 0),
    false,
  );
  assert.equal(
    automaticPolicy(action("custom_read", "automatic"), {}, 0),
    true,
  );
  assert.equal(
    automaticPolicy(action("custom_read", "automatic"), {}, 1),
    true,
  );
  assert.equal(
    automaticPolicy(action("custom_read", "automatic"), {}, 2),
    false,
  );
  assert.equal(
    automaticPolicy(action("custom_write", "automatic"), {}, 0),
    false,
    "automatic writes still need idempotency and a lookup endpoint",
  );
  assert.equal(
    automaticPolicy(
      action("custom_write", "automatic", {
        idempotent: true,
        lookupEndpoint: "https://backend.example.com/lookup",
      }),
      {},
      0,
    ),
    true,
  );
});

test("customer replies render only fields the output schema declares", () => {
  const schema = {
    type: "object",
    properties: {
      status: { type: "string" },
      items: {
        type: "array",
        items: { type: "object", properties: { sku: { type: "string" } } },
      },
      shipping: { type: "object", properties: { eta: { type: "string" } } },
    },
  };
  assert.deepEqual(
    declaredOutput(schema, {
      status: "shipped",
      internalNote: "fraud score 0.9",
      items: [{ sku: "A1", cost: 12 }, "junk"],
      shipping: { eta: "tomorrow", carrierAccount: "secret" },
    }),
    {
      status: "shipped",
      items: [{ sku: "A1" }, {}],
      shipping: { eta: "tomorrow" },
    },
  );
  assert.deepEqual(declaredOutput(schema, { items: "not a list" }), {
    items: [],
  });
  assert.deepEqual(declaredOutput({}, { anything: 1 }), {});
  assert.deepEqual(declaredOutput(undefined, { anything: 1 }), {});
  assert.deepEqual(declaredOutput({ type: "object" }, "text"), {});
  assert.equal(declaredOutput({ type: "number" }, 4), 4);
});
