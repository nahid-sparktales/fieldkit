import { config } from "../packages/platform/src/config.js";
import { Database } from "../packages/platform/src/db.js";
// Offline operator command. Database/host access is required; no HTTP recovery bypass exists.
const [workspaceId, userId, mode, confirmation] = process.argv.slice(2);
if (
  !workspaceId ||
  !userId ||
  !["disable-enforcement", "reset-factor"].includes(mode) ||
  confirmation !== "--confirm-offline"
)
  throw new Error(
    "Stop app and workers, back up the database, then run: npx tsx scripts/recover-staff-identity.ts <workspace-id> <owner-user-id> disable-enforcement|reset-factor --confirm-offline",
  );
const db = new Database(config());
try {
  await db.tx(async (q) => {
    const owner = await db.one(
      "SELECT * FROM memberships WHERE workspace_id=$1 AND user_id=$2 AND role='owner' AND NOT disabled FOR UPDATE",
      [workspaceId, userId],
      q,
    );
    if (!owner)
      throw new Error("Recovery must target an active workspace owner");
    if (
      !(await db.one(
        'SELECT id FROM account WHERE "userId"=$1 AND "providerId"=\'credential\' AND password IS NOT NULL',
        [userId],
        q,
      ))
    )
      throw new Error(
        "Owner must have an existing local password. This command cannot create credentials",
      );
    if (mode === "reset-factor") {
      // A factor belongs to the global user. Clear enforcement in each staff workspace
      // explicitly and record each affected workspace so the existing password can recover.
      for (const m of await db.rows(
        "SELECT workspace_id FROM memberships WHERE user_id=$1",
        [userId],
        q,
      )) {
        await q.query(
          "UPDATE staff_identity_settings SET mfa_required=false,sso_required=false,revision=revision+1,updated_at=now() WHERE workspace_id=$1",
          [m.workspace_id],
        );
        await db.event(q, m.workspace_id, "identity.operator_factor_reset", {
          userId,
          actor: "offline-operator",
        });
      }
      await q.query('DELETE FROM "twoFactor" WHERE "userId"=$1', [userId]);
      await q.query('UPDATE "user" SET "twoFactorEnabled"=false WHERE id=$1', [
        userId,
      ]);
    } else {
      await q.query(
        "UPDATE staff_identity_settings SET sso_required=false,mfa_required=false,revision=revision+1,updated_at=now() WHERE workspace_id=$1",
        [workspaceId],
      );
      await db.event(q, workspaceId, "identity.operator_policy_recovery", {
        userId,
        actor: "offline-operator",
      });
    }
    await q.query('DELETE FROM session WHERE "userId"=$1', [userId]);
    await q.query("DELETE FROM staff_session_security WHERE user_id=$1", [
      userId,
    ]);
  });
  console.log(
    "Recovery recorded. Restart the app, sign in with the existing owner password, and restore MFA and policy after verifying recovery access.",
  );
} finally {
  await db.pool.end();
}
