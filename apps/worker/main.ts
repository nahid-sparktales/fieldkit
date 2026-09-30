import { config, log } from "../../packages/platform/src/config.js";
import { Platform } from "../../packages/platform/src/platform.js";
const app = new Platform(config());
await app.start();
await app.workers();
log("worker.ready");
let closing = false;
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, async () => {
    if (closing) return;
    closing = true;
    await app.close();
    process.exit(0);
  });
