import { createApp } from "../apps/api/server.js";
import {
  testConfig,
  resetDatabase,
  TestModel,
  TestProviders,
} from "./helpers.js";
import { writeFile, mkdir } from "node:fs/promises";
import { docsFixture } from "./website-fixture.js";
const c = testConfig(4351);
const docs = docsFixture(),
  providers = new TestProviders();
await resetDatabase(c.DATABASE_URL);
await mkdir(".fieldkit/browser", { recursive: true });
const app = await createApp(c, {
  migrate: true,
  workers: true,
  model: new TestModel(),
  fetch: (url, init) =>
    url === "https://status.example.com/api"
      ? Promise.resolve(Response.json({ status: "operational" }))
      : new URL(url).origin === docs.origin
        ? docs.fetch(url, init)
        : providers.fetch(url, init),
  mailer: async (to, _subject, text) => {
    await writeFile(
      ".fieldkit/browser/" + to.replace(/[^a-zA-Z0-9]/g, "_") + ".txt",
      text,
      { mode: 0o600 },
    );
  },
});
await writeFile(".fieldkit/browser/setup-token", c.FIELDKIT_SETUP_TOKEN, {
  mode: 0o600,
});
app.server.listen(4351, "127.0.0.1", () =>
  console.log("Isolated browser test server ready"),
);
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, async () => {
    await app.close();
    process.exit(0);
  });
