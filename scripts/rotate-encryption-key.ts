import { readFile } from "node:fs/promises";
import { config } from "../packages/platform/src/config.js";
import { Database } from "../packages/platform/src/db.js";
import { seal, unseal } from "../packages/platform/src/security.js";

// Stop app and worker first. The operator supplies the new key in a mode-0600 file.
const filename = process.argv[2];
if (!filename)
  throw new Error(
    "Usage: npm run rotate-key -- /secure/path/new-key (stop app and worker first)",
  );
const next = (await readFile(filename, "utf8")).trim();
if (Buffer.from(next, "base64").length !== 32)
  throw new Error("New key must contain 32 random bytes encoded as base64");
const db = new Database(config());
try {
  await db.tx(async (q) => {
    await q.query("LOCK TABLE connections IN ACCESS EXCLUSIVE MODE");
    for (const row of await db.rows(
      "SELECT * FROM connections WHERE secret<>''",
      [],
      q,
    )) {
      const scope = `${row.workspace_id}:${row.provider}`;
      await q.query("UPDATE connections SET secret=$1 WHERE id=$2", [
        seal(
          next,
          scope,
          unseal(db.config.FIELDKIT_ENCRYPTION_KEY, scope, row.secret),
        ),
        row.id,
      ]);
    }
  });
  console.log(
    "Credentials re-encrypted. Set FIELDKIT_ENCRYPTION_KEY to the new key before restarting app and worker. Keep the previous key with the pre-rotation backup.",
  );
} finally {
  await db.pool.end();
}
