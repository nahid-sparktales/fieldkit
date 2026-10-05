import { z } from "zod";
export const TestResource = z
  .object({
    dedicated: z.literal(true),
    ticketId: z.string().regex(/^\d+$/).optional(),
    customerId: z.string().min(1).max(200).optional(),
    chargeId: z
      .string()
      .regex(/^ch_[A-Za-z0-9]+$/)
      .optional(),
    subscriptionId: z
      .string()
      .regex(/^sub_[A-Za-z0-9]+$/)
      .optional(),
    amountMinor: z.number().int().min(1).max(100).optional(),
    contactId: z.string().min(1).max(200).optional(),
    parameters: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();

export const EvidenceLevel = z.enum([
  "not_configured",
  "configured_untested",
  "access_verified",
  "read_verified",
  "dedicated_test_write_verified",
  "manual_attestation",
]);
export const CheckHealth = z.enum([
  "current",
  "stale",
  "blocked",
  "degraded",
  "failed",
  "running",
  "canceled",
  "uncertain",
]);
export const CheckRisk = z.enum([
  "local_read",
  "paid_model",
  "test_email",
  "test_write",
]);
export const CheckRequest = z
  .object({
    requestKey: z.string().min(8).max(200),
    checkIds: z.array(z.string().min(1).max(200)).min(1).max(50),
    authorizedEffects: z.boolean().default(false),
    tokenCap: z.number().int().min(0).max(100000).default(0),
    testEmail: z.email().max(254).optional(),
    testResource: TestResource.optional(),
  })
  .strict();
export const ReadinessSettings = z.object({ strict: z.boolean() }).strict();
export const CheckEvidence = z
  .object({
    summary: z.string().max(2000),
    facts: z
      .record(
        z.string().max(80),
        z.union([
          z.string().max(400),
          z.number().finite(),
          z.boolean(),
          z.null(),
        ]),
      )
      .default({}),
  })
  .strict();
export const CheckControl = z
  .object({
    action: z.enum(["cancel", "retry", "reconcile"]),
    acknowledgeUncertain: z.boolean().default(false),
  })
  .strict();
export const Attestation = z
  .object({
    note: z.string().trim().min(10).max(1500),
    runId: z.string().optional(),
  })
  .strict();
