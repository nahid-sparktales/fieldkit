import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { FieldKitClient } from "../../sdk/src/index.js";
const { FIELDKIT_URL, FIELDKIT_WORKSPACE, FIELDKIT_TOKEN, FIELDKIT_CUSTOMER } =
  process.env;
if (
  !FIELDKIT_URL ||
  !FIELDKIT_WORKSPACE ||
  !FIELDKIT_TOKEN ||
  !FIELDKIT_CUSTOMER
)
  throw new Error(
    "Provide URL, workspace, scoped service token, and the fixed verified external customer ID in the MCP host environment",
  );
const client = new FieldKitClient({
  url: FIELDKIT_URL,
  workspaceId: FIELDKIT_WORKSPACE,
  token: FIELDKIT_TOKEN,
  customerId: FIELDKIT_CUSTOMER,
});
const server = new McpServer({ name: "fieldkit", version: "2.0.0" });
server.registerTool(
  "request_support",
  {
    description:
      "Request governed support for the customer fixed by this MCP host. The server controls identity, policy, and action approvals.",
    inputSchema: {
      message: z.string().min(1).max(12000),
      idempotencyKey: z.string().min(8).max(120),
      conversationId: z.string().uuid().optional(),
    },
  },
  async ({ message, idempotencyKey, conversationId }) => ({
    content: [
      {
        type: "text",
        text: JSON.stringify(
          await (conversationId
            ? client.reply(conversationId, {
                externalCustomerId: FIELDKIT_CUSTOMER,
                body: message,
                requestKey: idempotencyKey,
              })
            : client.request({
                externalCustomerId: FIELDKIT_CUSTOMER,
                body: message,
                requestKey: idempotencyKey,
              })),
        ),
      },
    ],
  }),
);
server.registerTool(
  "support_status",
  {
    description:
      "Read customer-visible messages and status of a support request in the configured workspace.",
    inputSchema: { conversationId: z.string().uuid() },
  },
  async ({ conversationId }) => ({
    content: [
      {
        type: "text",
        text: JSON.stringify(await client.status(conversationId)),
      },
    ],
  }),
);
await server.connect(new StdioServerTransport());
