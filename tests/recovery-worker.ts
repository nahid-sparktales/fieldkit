import { Platform } from "../packages/platform/src/platform.js";
import { config } from "../packages/platform/src/config.js";
import { TestModel, TestProviders } from "./helpers.js";
const c = config(process.env),
  providers = new TestProviders(),
  app = new Platform(c, {
    model: new TestModel(),
    fetch: providers.fetch,
    mailer: async () => {},
  });
try {
  await app.start();
  await app.agent.advance(process.argv[2], process.argv[3]);
  console.log(JSON.stringify({ writes: providers.writes }));
} finally {
  await app.close();
}
