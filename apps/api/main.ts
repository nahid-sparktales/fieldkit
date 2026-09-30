import { config, log } from "../../packages/platform/src/config.js";
import { createApp } from "./server.js";
const c = config();
const app = await createApp(c, {
  dev: process.env.NODE_ENV !== "production",
  workers: process.env.FIELDKIT_INLINE_WORKER === "true",
});
app.server.listen(c.FIELDKIT_PORT, c.FIELDKIT_HOST, () =>
  log("server.ready", { url: c.FIELDKIT_URL, version: "2.0.0" }),
);
let closing = false;
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, async () => {
    if (closing) return;
    closing = true;
    await app.close();
    process.exit(0);
  });
