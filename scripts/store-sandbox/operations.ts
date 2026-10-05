// Imported only by the explicitly invoked offline store sandbox and its tests.
import { readFile } from "node:fs/promises";
import type { Platform } from "../../packages/platform/src/platform.js";
import type { AttachmentScanner } from "../../packages/platform/src/attachment-scanner.js";
import type { Principal } from "../../packages/platform/src/auth.js";
import { uid } from "../../packages/platform/src/db.js";
import { defaultSlaPolicy } from "../../packages/platform/src/sla-contracts.js";
export const sandboxScanner: AttachmentScanner = {
  health: async () => ({
    engine: "LOCAL SANDBOX DOUBLE — no malware engine",
    signaturesAt: new Date().toISOString(),
  }),
  scan: async (bytes) => ({
    ...(await sandboxScanner.health()),
    scannedAt: new Date().toISOString(),
    clean: !bytes.includes(Buffer.from("sandbox-rejected-file")),
  }),
};
export async function seedOperationalScenarios(
  app: Platform,
  ws: string,
  advanceClock: (ms: number) => void,
) {
  if (
    !new URL(app.config.DATABASE_URL).pathname.endsWith("_sandbox") &&
    !new URL(app.config.DATABASE_URL).pathname.endsWith("_test")
  )
    throw Error(
      "Operational scenarios require the dedicated sandbox or disposable test database",
    );
  await app.db.pool.query(
    "CREATE TABLE IF NOT EXISTS sandbox_operations(workspace_id text PRIMARY KEY,created_at timestamptz DEFAULT now())",
  );
  if (
    await app.db.one("SELECT 1 FROM sandbox_operations WHERE workspace_id=$1", [
      ws,
    ])
  )
    return;
  const user = (await app.db.one(
    "SELECT user_id FROM memberships WHERE workspace_id=$1 AND role='owner'",
    [ws],
  ))!;
  const contact = (await app.db.one(
    "SELECT id,user_id FROM contacts WHERE workspace_id=$1 AND email='alex@trail.example.test'",
    [ws],
  ))!;
  const owner: Principal = {
      workspaceId: ws,
      userId: user.user_id,
      role: "owner",
    },
    customer: Principal = {
      workspaceId: ws,
      userId: contact.user_id,
      contactId: contact.id,
      role: "customer",
    };
  const check = async () => {
    const [r] = await app.readiness.start(owner, {
      requestKey: uid(),
      checkIds: ["scanner"],
    });
    await app.readiness.advance(ws, r.id);
  };
  const original = app.attachments.scanner;
  app.attachments.scanner = {
    ...sandboxScanner,
    health: async () => {
      throw Error("Simulated scanner outage");
    },
  };
  await check();
  app.attachments.scanner = original;
  await check();
  await app.attachments.settings(owner, { enabled: true, anonymous: false });
  const fileTicket = await app.newConversation(customer, {
    body: "Please inspect the attached screenshot and log.",
    subject: "Local scenario · safe and rejected files",
    requestKey: uid(),
  });
  await app.control(owner, fileTicket.id, { mode: "human" });
  const ids: string[] = [];
  for (const [name, bytes, mime] of [
    ["sample.png", await readFile("tests/fixtures/logo.png"), "image/png"],
    ["rejected.log", Buffer.from("sandbox-rejected-file"), "text/plain"],
  ] as const) {
    const a = await app.attachments.reserve(customer, {
      conversationId: fileTicket.id,
      name,
      size: bytes.length,
      mime,
      requestKey: uid(),
    });
    await app.attachments.upload(
      customer,
      a.id,
      (async function* () {
        yield bytes;
      })(),
    );
    ids.push(a.id);
  }
  await app.message(customer, fileTicket.id, {
    body: "One clean fixture and one deliberately rejected fixture. No real malware.",
    requestKey: uid(),
    attachments: ids,
  });
  for (const id of ids) await app.attachments.scan(ws, id);
  const policy = defaultSlaPolicy();
  policy.enabled = true;
  policy.calendar.shifts = [1, 2, 3, 4, 5, 6, 7].map((day) => ({
    day,
    start: "00:00",
    end: "24:00",
  }));
  Object.assign(policy.rules[0], {
    firstMinutes: 1,
    nextMinutes: 1,
    handoffMinutes: 1,
    warningMinutes: 1,
    escalateMinutes: 1,
    replies: "staff_only",
  });
  policy.followup = {
    enabled: true,
    afterMinutes: 1,
    maxReminders: 1,
    template: "[Local sandbox fixture] Do you still need help?",
  };
  const saved = await app.sla.settings(owner);
  await app.sla.save(owner, { revision: saved.revision, policy });
  const overdue = await app.newConversation(customer, {
    body: "I need a human for this request.",
    subject: "Local scenario · overdue response",
    requestKey: uid(),
  });
  await app.control(owner, overdue.id, { mode: "human" });
  await app.sla.advance(ws, overdue.id);
  advanceClock(120000);
  await app.sla.advance(ws, overdue.id);
  const waiting = await app.newConversation(customer, {
    body: "Can you help with returns?",
    subject: "Local scenario · canceled reminder",
    requestKey: uid(),
  });
  await app.control(owner, waiting.id, { mode: "human" });
  await app.message(owner, waiting.id, {
    body: "[Local staff fixture] Please send your order details.",
    requestKey: uid(),
  });
  await app.sla.waiting(owner, waiting.id, {
    waiting: true,
    allowReminder: true,
  });
  await app.message(customer, waiting.id, {
    body: "Here are the details; do not send an obsolete reminder.",
    requestKey: uid(),
  });
  advanceClock(120000);
  await app.sla.advance(ws, waiting.id);
  const current = await app.workflows.get(owner),
    candidate = (await app.shadow.createCandidate(owner, {
      name: "Local scenario · governed refund",
      channel: "portal",
      revision: current.revision,
    }))!;
  const exp = await app.shadow.start(owner, {
    candidateId: candidate.id,
    samplePercent: 100,
    hours: 1,
    maxSamples: 10,
    perRunTokenCap: 20000,
    tokenCap: 100000,
    productionReserve: 10000,
    verifiedOnly: true,
    judge: false,
    authorizedPaid: true,
    requestKey: uid(),
  });
  const conv = await app.newConversation(customer, {
    body: "Please refund $1 from my backpack purchase",
    subject: "Local scenario · shadow action boundary",
    requestKey: uid(),
  });
  const run = (await app.db.one("SELECT * FROM runs WHERE conversation_id=$1", [
    conv.id,
  ]))!;
  await app.agent.advance(ws, run.id);
  const approval = await app.db.one(
    "SELECT id,hash FROM approvals WHERE run_id=$1 AND status='pending'",
    [run.id],
  );
  if (approval) {
    await app.decide(owner, approval.id, approval.hash, "approve");
    await app.agent.advance(ws, run.id);
  }
  const comparison = (await app.db.one(
    "SELECT id FROM shadow_results WHERE source_run_id=$1",
    [run.id],
  ))!;
  // Settle only these fixture turns through the real worker path. Takeover must
  // make their pending runs stale; never edit unrelated sandbox conversations.
  for (const pending of await app.db.rows(
    "SELECT id FROM runs WHERE workspace_id=$1 AND conversation_id=ANY($2::text[]) AND status='queued'",
    [ws, [fileTicket.id, overdue.id, waiting.id]],
  ))
    await app.agent.advance(ws, pending.id);
  // Baseline work in this explicit fixture is complete before evaluating shadow.
  await app.shadow.advance(ws, comparison.id);
  const result = await app.db.one(
    "SELECT status FROM shadow_results WHERE id=$1",
    [comparison.id],
  );
  if (result?.status !== "completed")
    throw Error("Local comparison did not complete; inspect Shadow & rollout");
  await app.shadow.review(owner, comparison.id, {
    verdict: "pass",
    note: "Offline fixture only. The candidate proposed an action and executed no business effect.",
  });
  await app.shadow.control(owner, exp.id, { action: "stop" });
  const rollout = await app.shadow.startCanary(owner, {
    experimentId: exp.id,
    percent: 50,
    hours: 1,
    tokenCap: 100000,
    reviewThreshold: 1,
    maxFailures: 10,
    authorizedLiveEffects: true,
    decision: "Explicit offline scenario with local provider doubles only.",
    requestKey: uid(),
  });
  for (let i = 0; i < 40; i++) {
    const c = await app.newConversation(customer, {
      body: "What is the return policy?",
      subject: "Local scenario · stopped candidate",
      requestKey: uid(),
    });
    const a = await app.db.one(
      "SELECT variant FROM canary_assignments WHERE conversation_id=$1",
      [c.id],
    );
    if (a?.variant === "candidate") break;
  }
  await app.shadow.controlCanary(owner, rollout.id, {
    action: "stop",
    reason: "Local kill switch before the candidate worker sends an answer",
  });
  await app.db.pool.query(
    "INSERT INTO sandbox_operations(workspace_id) VALUES($1)",
    [ws],
  );
}
