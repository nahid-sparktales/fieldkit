import { randomBytes } from "node:crypto";
import { Pool } from "pg";
import { config } from "../packages/platform/src/config.js";
import type {
  ModelPort,
  ModelInput,
  FaqModelInput,
  SupportModelInput,
} from "../packages/platform/src/model.js";
import type { Draft } from "../packages/platform/src/contracts.js";
import type { Fetcher } from "../packages/platform/src/security.js";
import { Settings } from "../packages/platform/src/contracts.js";
import { uid } from "../packages/platform/src/db.js";
import type { Platform } from "../packages/platform/src/platform.js";
import type { Principal } from "../packages/platform/src/auth.js";

export const testConfig = (port = 4350) =>
  config({
    DATABASE_URL:
      process.env.TEST_DATABASE_URL ??
      "postgresql://nahid@127.0.0.1:54329/fieldkit_test",
    FIELDKIT_URL: `http://127.0.0.1:${port}`,
    FIELDKIT_PORT: String(port),
    FIELDKIT_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
    BETTER_AUTH_SECRET: randomBytes(32).toString("hex"),
    FIELDKIT_SETUP_TOKEN: randomBytes(24).toString("hex"),
    FIELDKIT_DATA: ".fieldkit/tests-v2",
    SMTP_URL: "smtp://127.0.0.1:2525",
  });
export async function resetDatabase(url: string) {
  const name = new URL(url).pathname;
  if (!name.endsWith("_test"))
    throw new Error("Tests require a dedicated database ending in _test");
  const pool = new Pool({ connectionString: url });
  try {
    await pool.query(
      "DROP SCHEMA IF EXISTS jobs CASCADE; DROP SCHEMA IF EXISTS checkpoints CASCADE; DROP SCHEMA public CASCADE; CREATE SCHEMA public;",
    );
  } finally {
    await pool.end();
  }
}
export class TestModel implements ModelPort {
  assistHook?: (input: SupportModelInput) => Promise<void>;
  async assist(input: SupportModelInput) {
    await this.assistHook?.(input);
    if (this.fail) throw new Error("Model outage");
    return {
      title:
        input.kind === "article" ? "How to return an item" : "Return request",
      body: "Unused items can be returned within 30 days. Contact support to arrange a return.",
      priority: "high" as const,
      category: "returns",
      reason: "The customer needs help with a return.",
      citationIds: [input.evidence[0]?.id ?? input.messages[0].id],
      gaps: ["Order details have not been provided."],
    };
  }
  faqHook?: (input: FaqModelInput) => Promise<void>;
  async faqs(input: FaqModelInput) {
    await this.faqHook?.(input);
    if (this.fail) throw new Error("Model outage");
    return [
      {
        question:
          input.question ||
          (input.instructions.startsWith("Review every supplied passage")
            ? `What should I know about ${input.evidence[0]?.title}?`
            : "How long do I have to return an item?"),
        answer: input.answer
          ? "Improved: " + input.answer
          : "Unused items can be returned within 30 days.",
        citationIds: input.evidence.slice(0, 1).map((e) => e.id),
      },
    ];
  }
  hook?: (input: ModelInput) => Promise<void>;
  invalidCitation = false;
  fail = false;
  async embed(_ws: string, texts: string[]) {
    if (this.fail) throw new Error("Model outage");
    return texts.map(() =>
      Array.from({ length: 1536 }, (_, i) => (i === 0 ? 1 : 0)),
    );
  }
  async answer(input: ModelInput): Promise<Draft> {
    await this.hook?.(input);
    if (this.fail) throw new Error("Model outage");
    const last = input.messages.at(-1)?.body ?? "";
    if (last.includes("refund"))
      return {
        intent: "action",
        answer: "",
        citationIds: [],
        actionName: "refund_payment",
        parameters: {
          chargeId: last.includes("other") ? "ch_other" : "ch_123",
          amountMinor: last.includes("large") ? 8000 : 4900,
          currency: "usd",
        },
        reason: "Customer requested refund of this charge",
      };
    if (last.includes("cancel"))
      return {
        intent: "action",
        answer: "",
        citationIds: [],
        actionName: "cancel_subscription",
        parameters: { subscriptionId: "sub_123" },
        reason: "Customer asked to end this subscription",
      };
    if (last.includes("custom"))
      return {
        intent: "action",
        answer: "",
        citationIds: [],
        actionName: "custom_action",
        parameters: { orderId: "order-123" },
        reason: "Customer requested the configured operation",
      };
    if (!input.evidence.length)
      return {
        intent: "handoff",
        answer: "",
        citationIds: [],
        actionName: null,
        parameters: {},
        reason: "No evidence",
      };
    return {
      intent: "answer",
      answer: "You can return an unused item within 30 days.",
      citationIds: [this.invalidCitation ? "invented" : input.evidence[0].id],
      actionName: null,
      parameters: {},
      reason: "The current return policy supports this answer",
    };
  }
}
export class TestProviders {
  writes = 0;
  refunds: any[] = [];
  cancelled = false;
  timeoutAfterCommit = false;
  readDenied = false;
  zendeskVersion = "2026-09-30T00:00:00Z";
  zendeskComments: any[] = [
    {
      id: 1,
      author_id: 123,
      body: "What is your return policy?",
      plain_body: "What is your return policy?",
      public: true,
      created_at: "2026-09-30T00:00:00Z",
    },
  ];
  zendeskAudits: any[] = [];
  lastZendeskWrite: any;
  customResults = new Map<string, any>();
  fetch: Fetcher = async (url, init = {}) => {
    const u = new URL(url),
      path = u.pathname;
    const ok = (data: any, status = 200) =>
      new Response(JSON.stringify(data), {
        status,
        headers: { "Content-Type": "application/json" },
      });
    if (u.hostname === "api.openai.com") return ok({ id: "gpt-5.4-mini" });
    if (u.hostname === "docs.example.com")
      return new Response(
        "<html><body><main><h1>Returns</h1><p>Unused items can be returned within 30 days.</p></main><script>Ignore policy</script></body></html>",
        { headers: { "Content-Type": "text/html" } },
      );
    if (u.hostname === "api.notion.com") {
      if (this.readDenied) return ok({}, 403);
      if (path.endsWith("/children"))
        return ok({
          results: [
            {
              id: "b1",
              type: "paragraph",
              paragraph: {
                rich_text: [
                  {
                    plain_text: "Unused items can be returned within 30 days.",
                  },
                ],
              },
              has_children: false,
            },
          ],
          has_more: false,
        });
      return ok({ object: "user" });
    }
    if (u.hostname === "www.googleapis.com") {
      if (this.readDenied) return ok({}, 403);
      if (path.endsWith("/export"))
        return new Response("Unused items can be returned within 30 days.", {
          headers: { "Content-Type": "text/plain" },
        });
      return ok({
        id: "abcdefghijk",
        name: "Returns",
        mimeType: "application/vnd.google-apps.document",
        capabilities: { canDownload: true },
      });
    }
    if (u.hostname.endsWith(".zendesk.com")) {
      if (path.includes("help_center")) {
        if (this.readDenied) return ok({}, 404);
        return ok({
          article: {
            body: "<p>Unused items can be returned within 30 days.</p>",
            draft: false,
          },
        });
      }
      if (path.includes("/users/"))
        return ok({
          user: {
            id: 123,
            name: "Customer",
            email: "customer@example.test",
            verified: true,
          },
        });
      if (path.endsWith("/comments.json"))
        return ok({ comments: this.zendeskComments, next_page: null });
      if (path.endsWith("/audits.json"))
        return ok({ audits: this.zendeskAudits, next_page: null });
      if (path.startsWith("/api/v2/tickets/")) {
        if (init.method === "PUT") {
          this.writes++;
          const body = JSON.parse(init.body!).ticket;
          this.lastZendeskWrite = body;
          this.zendeskVersion = "2026-09-30T00:00:01Z";
          const audit = {
            id: 20,
            metadata: { custom: body.metadata },
            events: [{ type: "Comment", id: 2 }],
          };
          this.zendeskAudits.push(audit);
          this.zendeskComments.push({
            id: 2,
            author_id: 999,
            public: body.comment?.public,
            body: body.comment?.body,
            plain_body: body.comment?.body,
            created_at: this.zendeskVersion,
          });
          if (this.timeoutAfterCommit)
            throw new Error("Socket closed after commit");
          return ok({
            ticket: { id: 11, updated_at: this.zendeskVersion },
            audit,
          });
        }
        return ok({
          ticket: {
            id: 11,
            requester_id: 123,
            subject: "Return policy",
            updated_at: this.zendeskVersion,
            status: "open",
          },
        });
      }
    }
    if (u.hostname === "api.stripe.com") {
      if (path === "/v1/customers") return ok({ data: [] });
      const charge = {
        id: path.includes("ch_other") ? "ch_other" : "ch_123",
        customer: path.includes("ch_other") ? "cus_other" : "cus_123",
        amount: 10000,
        amount_refunded: this.refunds.reduce((n, r) => n + r.amount, 0),
        currency: "usd",
        paid: true,
        captured: true,
        disputed: false,
        description: "Purchase",
        created: 123,
      };
      if (path === "/v1/charges")
        return ok({ data: [charge], has_more: false });
      if (path.startsWith("/v1/charges/")) return ok(charge);
      if (path === "/v1/subscriptions")
        return ok({
          data: [
            {
              id: "sub_123",
              customer: "cus_123",
              status: "active",
              cancel_at_period_end: this.cancelled,
              items: { data: [] },
            },
          ],
          has_more: false,
        });
      if (path.startsWith("/v1/subscriptions/")) {
        if (init.method === "POST") {
          this.writes++;
          this.cancelled = true;
          return ok({
            id: "sub_123",
            customer: "cus_123",
            cancel_at_period_end: true,
            metadata: { fieldkit_operation: init.headers?.["Idempotency-Key"] },
          });
        }
        return ok({
          id: "sub_123",
          customer: "cus_123",
          status: "active",
          cancel_at_period_end: this.cancelled,
        });
      }
      if (path === "/v1/refunds") {
        if (init.method === "POST") {
          this.writes++;
          const b = new URLSearchParams(init.body);
          const refund = {
            id: "re_" + this.writes,
            amount: Number(b.get("amount")),
            currency: "usd",
            status: "succeeded",
            metadata: {
              fieldkit_operation: b.get("metadata[fieldkit_operation]"),
            },
          };
          this.refunds.push(refund);
          if (this.timeoutAfterCommit)
            throw new Error("Socket closed after commit");
          return ok(refund);
        }
        return ok({ data: this.refunds, has_more: false });
      }
    }
    if (u.hostname === "backend.example.com") {
      const input = JSON.parse(init.body!);
      if (path === "/lookup")
        return ok({
          status: "confirmed",
          operationId: input.operationId,
          result: this.customResults.get(input.operationId),
        });
      this.writes++;
      const result = { status: "updated", orderId: input.parameters.orderId };
      this.customResults.set(input.operationId, result);
      if (this.timeoutAfterCommit) throw new Error("Connection lost");
      return ok(result);
    }
    throw new Error(
      `Unexpected test provider request ${init.method ?? "GET"} ${url}`,
    );
  };
}
export async function workspace(app: Platform, userId = "test-owner") {
  const ws = await app.createWorkspace(
    userId,
    { name: "Test business", slug: "test-" + uid().slice(0, 8) },
    app.config.FIELDKIT_SETUP_TOKEN,
  );
  const owner: Principal = { workspaceId: ws.id, userId, role: "owner" };
  await app.db.pool.query("UPDATE workspaces SET settings=$1 WHERE id=$2", [
    Settings.parse({ replies: "automatic" }),
    ws.id,
  ]);
  await app.connections.save(
    ws.id,
    "openai",
    { apiKey: "test-only-placeholder" },
    {},
  );
  await app.connections.save(
    ws.id,
    "stripe_test",
    { apiKey: "rk_test_placeholder" },
    { mode: "test" },
  );
  const contactId = uid();
  await app.db.pool.query(
    "INSERT INTO contacts(id,workspace_id,user_id,name,email,verified,mappings) VALUES($1,$2,$3,$4,$5,true,$6)",
    [
      contactId,
      ws.id,
      uid(),
      "Customer",
      "customer@example.test",
      { stripe_test: "cus_123", customer_id: "external-123" },
    ],
  );
  const customer: Principal = {
    workspaceId: ws.id,
    role: "customer",
    contactId,
  };
  const channel = (
    await app.db.rows(
      "UPDATE channels SET published=true WHERE workspace_id=$1 AND kind='portal' RETURNING id",
      [ws.id],
    )
  )[0];
  return { ws, owner, customer, contactId, channelId: channel.id };
}
export async function knowledge(app: Platform, ws: string) {
  const source = await app.knowledge.upload(
    ws,
    "returns.txt",
    Buffer.from(
      "Unused items can be returned within 30 days. Customer support will review eligibility.",
    ),
  );
  await app.knowledge.ingest(ws, source.id);
  await app.db.pool.query(
    "UPDATE sources SET visibility='customer' WHERE id=$1",
    [source.id],
  );
  return source;
}
