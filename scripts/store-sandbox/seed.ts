import { readFile, readdir } from "node:fs/promises";
import { uid } from "../../packages/platform/src/db.js";
import type { Platform } from "../../packages/platform/src/platform.js";
import type { Principal } from "../../packages/platform/src/auth.js";
import { Settings } from "../../packages/platform/src/contracts.js";
import { defaultWorkflow } from "../../packages/platform/src/workflow-definition.js";
import { chargeFixture, subscriptionFixture } from "./providers.js";

export const accounts = [
  { email: "owner@trail.example.test", name: "Sandbox Owner", role: "owner" },
  {
    email: "agent@trail.example.test",
    name: "Jamie · Sandbox Agent",
    role: "agent",
  },
  { email: "alex@trail.example.test", name: "Alex Rivera", role: "customer" },
  { email: "sam@trail.example.test", name: "Sam Chen", role: "customer" },
] as const;
export async function seedStore(
  app: Platform,
  password: string,
  storeOrigin: string,
) {
  await app.db.pool
    .query(`CREATE TABLE IF NOT EXISTS sandbox_state(id integer PRIMARY KEY CHECK(id=1), workspace_id text NOT NULL);
    CREATE TABLE IF NOT EXISTS sandbox_receipts(id text PRIMARY KEY, receipt jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now());`);
  const existing = await app.db.one(
    "SELECT workspace_id FROM sandbox_state WHERE id=1",
  );
  if (existing) return existing.workspace_id as string;
  if (
    await app.db.one(
      'SELECT id FROM workspaces UNION ALL SELECT id FROM "user" LIMIT 1',
    )
  )
    throw new Error(
      "Sandbox database contains an incomplete or unrelated setup. No data was changed. Inspect it, or explicitly run npm run sandbox -- --reset to recreate this sandbox.",
    );
  const users = [];
  for (const account of accounts) {
    const result = await app.auth.auth.api.signUpEmail({
      body: { name: account.name, email: account.email, password },
    });
    // Explicit synthetic-account setup only; normal app signup remains verified-email gated.
    await app.db.pool.query(
      'UPDATE "user" SET "emailVerified"=true WHERE id=$1',
      [result.user.id],
    );
    users.push({ ...account, id: result.user.id });
  }
  const workspace = await app.createWorkspace(
    users[0].id,
    { name: "Trail Supply · Sandbox", slug: "trail-supply" },
    app.config.FIELDKIT_SETUP_TOKEN,
  );
  const ws = workspace.id,
    owner: Principal = { workspaceId: ws, userId: users[0].id, role: "owner" };
  await app.db.pool.query("INSERT INTO memberships VALUES($1,$2,'agent')", [
    ws,
    users[1].id,
  ]);
  const customers = [];
  for (const user of users.slice(2)) {
    const id = uid();
    await app.db.pool.query(
      "INSERT INTO contacts(id,workspace_id,user_id,name,email,verified,mappings) VALUES($1,$2,$3,$4,$5,true,$6)",
      [
        id,
        ws,
        user.id,
        user.name,
        user.email,
        {
          stripe_test: user.email.startsWith("alex")
            ? chargeFixture.customer
            : "cus_sandbox_sam",
        },
      ],
    );
    customers.push({
      workspaceId: ws,
      userId: user.id,
      role: "customer",
      contactId: id,
    } as Principal);
  }
  await app.connections.save(
    ws,
    "openai",
    { apiKey: "offline-sandbox-placeholder-not-a-key" },
    { sandbox: true },
  );
  await app.connections.save(
    ws,
    "stripe_test",
    { apiKey: "rk_test_offline_sandbox_not_a_key" },
    { mode: "test", sandbox: true },
  );
  await app.connections.updateSettings(
    ws,
    Settings.parse({
      model: "offline-store-fixture",
      replies: "automatic",
      instructions:
        "Local simulated store. No model calls, real orders, or money. All account changes require staff approval.",
    }),
  );
  for (const name of (await readdir("examples/store/knowledge")).sort()) {
    const source = await app.knowledge.upload(
      ws,
      name,
      await readFile(`examples/store/knowledge/${name}`),
    );
    if (name !== "staff-only.md")
      await app.db.pool.query(
        "UPDATE sources SET visibility='customer' WHERE id=$1",
        [source.id],
      );
    await app.knowledge.ingest(ws, source.id);
    if (name !== "staff-only.md")
      await app.db.pool.query(
        "UPDATE documents SET published=true WHERE source_id=$1 AND active",
        [source.id],
      );
  }
  const actions = [];
  for (const [name, kind, description] of [
    [
      "refund_payment",
      "stripe_refund",
      "SIMULATION: refund the selected fictional Trail Supply purchase, subject to staff approval.",
    ],
    [
      "cancel_subscription",
      "stripe_cancel",
      "SIMULATION: end the selected fictional Trail Club membership at period end, subject to staff approval.",
    ],
  ])
    actions.push(
      await app.actions.save(ws, {
        name,
        kind,
        description,
        enabled: true,
        config: { stripeMode: "test" },
        policy: {
          mode: "approval",
          maxAmountMinor: 8900,
          currency: "usd",
          dailyLimit: 100,
        },
      }),
    );
  const definition = defaultWorkflow(actions.map((a) => a.id));
  definition.title = "Trail Supply · sandbox workflow";
  const customer = definition.nodes.find((n) => n.type === "customer")!;
  if (customer.type === "customer") {
    customer.data.billing = true;
    customer.data.modes = ["test"];
  }
  await app.workflows.save(owner, { revision: 0, definition });
  await app.workflows.publish(owner, 1);
  await app.branding.save(owner, {
    revision: 0,
    config: {
      brandName: "Trail Supply · Sandbox",
      greeting: "Good gear. Helpful humans.",
      description:
        "Explore a fictional outdoor store. Replies and payments are simulated locally; no AI tokens or real orders are used.",
      accentColor: "#205c45",
      heroColor: "#eaf0df",
      backgroundColor: "#faf9f3",
      footerText:
        "LOCAL TEST STORE · All customers, orders, and payments are fictional.",
    },
  });
  for (const channel of await app.db.rows(
    "SELECT * FROM channels WHERE workspace_id=$1 AND kind IN ('portal','widget')",
    [ws],
  ))
    await app.publishChannel(owner, channel.id, {
      published: true,
      settings: { handoff: "native", origins: [storeOrigin] },
    });
  const account = {
    billing: [
      {
        mode: "test",
        charges: [
          {
            id: chargeFixture.id,
            amountMinor: 8900,
            refundedMinor: 0,
            currency: "usd",
            paid: true,
            captured: true,
          },
        ],
        subscriptions: [
          {
            id: subscriptionFixture.id,
            status: "active",
            cancelAtPeriodEnd: false,
          },
        ],
      },
    ],
  };
  const fixtures = {
    customer: {
      verified: true,
      name: "Alex Rivera",
      email: users[2].email,
      mappings: { stripe_test: chargeFixture.customer },
    },
    account,
  };
  await app.quality.saveSuite(owner, {
    name: "Store smoke tests · offline rules (disable AI assessment)",
    cases: [
      {
        id: "returns",
        name: "Returns and shipping follow-up",
        fixtures,
        turns: [
          {
            question: "What is your return policy?",
            expected: { intent: "answer" },
          },
          {
            question: "How much is express shipping?",
            expected: { intent: "answer" },
          },
        ],
      },
      {
        id: "refund",
        name: "Partial refund requires approval",
        fixtures,
        turns: [
          {
            question: "Please refund $20 from my backpack purchase",
            expected: {
              intent: "action",
              actionName: "refund_payment",
              requiresApproval: true,
              parameters: {
                chargeId: chargeFixture.id,
                amountMinor: 2000,
                currency: "usd",
              },
            },
          },
        ],
      },
      {
        id: "cancel",
        name: "Membership cancellation requires approval",
        fixtures,
        turns: [
          {
            question: "Cancel my Trail Club membership",
            expected: {
              intent: "action",
              actionName: "cancel_subscription",
              requiresApproval: true,
            },
          },
        ],
      },
      {
        id: "anonymous",
        name: "Anonymous billing request needs identity",
        turns: [
          {
            question: "Please refund my order",
            expected: { intent: "clarify" },
          },
        ],
      },
      {
        id: "handoff",
        name: "Warranty exception needs a person",
        fixtures,
        turns: [
          {
            question: "Can I get a lifetime warranty exception?",
            expected: { intent: "handoff" },
          },
        ],
      },
    ],
  });
  for (const [index, body, subject] of [
    [0, "What is your return policy?", "Return policy question"],
    [
      0,
      "Please refund $20 from my backpack purchase",
      "Approval needed · $20 partial refund",
    ],
    [
      1,
      "I need a human to review a damaged bottle",
      "Staff handoff · damaged item",
    ],
  ] as const) {
    const conv = await app.newConversation(customers[index], {
      body,
      subject,
      requestKey: "sandbox-seed-" + index + "-" + subject,
    });
    const run = await app.db.one(
      "SELECT id FROM runs WHERE conversation_id=$1",
      [conv.id],
    );
    await app.agent.advance(ws, run!.id);
  }
  await app.db.pool.query("INSERT INTO sandbox_state VALUES(1,$1)", [ws]);
  return ws;
}
