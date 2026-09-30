import { config, log } from "../packages/platform/src/config.js";
import { Platform } from "../packages/platform/src/platform.js";
const app = new Platform(config());
try {
  await app.migrate();
  log("migrations.complete");
} finally {
  await app.close();
}
