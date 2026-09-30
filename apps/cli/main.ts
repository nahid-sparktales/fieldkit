import { FieldKitClient } from "../../packages/sdk/src/index.js";
import { existsSync } from "node:fs";
if (existsSync(".env")) process.loadEnvFile(".env");
const [command, ...args] = process.argv.slice(2);
if (command === "help" || !command) {
  console.log(
    "FieldKit v2\n\nSet FIELDKIT_URL, FIELDKIT_WORKSPACE, and FIELDKIT_TOKEN (a scoped service token).\n\nidentify CUSTOMER_ID NAME [EMAIL]\nrequest CUSTOMER_ID MESSAGE\nstatus CONVERSATION_ID\n\nAdministrative setup, knowledge review, and approvals are available in the authenticated web app.",
  );
  process.exit(0);
}
const { FIELDKIT_URL, FIELDKIT_WORKSPACE, FIELDKIT_TOKEN } = process.env;
if (!FIELDKIT_URL || !FIELDKIT_WORKSPACE || !FIELDKIT_TOKEN)
  throw new Error(
    "Set FIELDKIT_URL, FIELDKIT_WORKSPACE, and FIELDKIT_TOKEN; no demo identity is created automatically",
  );
const client = new FieldKitClient({
  url: FIELDKIT_URL,
  workspaceId: FIELDKIT_WORKSPACE,
  token: FIELDKIT_TOKEN,
});
let result: unknown;
if (command === "identify" && args.length >= 2)
  result = await client.identify({
    externalCustomerId: args[0],
    name: args[1],
    email: args[2],
  });
else if (command === "request" && args.length >= 2)
  result = await client.request({
    externalCustomerId: args[0],
    body: args.slice(1).join(" "),
    requestKey: crypto.randomUUID(),
  });
else if (command === "status" && args[0]) result = await client.status(args[0]);
else throw new Error("Unknown command or missing arguments; run fieldkit help");
console.log(JSON.stringify(result, null, 2));
