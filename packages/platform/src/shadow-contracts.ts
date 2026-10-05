import { z } from "zod";
import { ModelProvider } from "./model-providers.js";
export const ShadowCandidateInput = z
  .object({
    name: z.string().trim().min(1).max(100),
    channel: z.enum(["portal", "widget", "zendesk"]),
    draftChannel: z
      .enum(["default", "portal", "widget", "zendesk"])
      .default("default"),
    revision: z.number().int().min(1),
    model: z.string().min(1).max(200).optional(),
    provider: ModelProvider.optional(),
  })
  .strict();
export const ShadowStart = z
  .object({
    candidateId: z.string().min(1),
    samplePercent: z.number().int().min(1).max(100),
    hours: z.number().int().min(1).max(168),
    maxSamples: z.number().int().min(1).max(10000),
    concurrency: z.number().int().min(1).max(2).default(1),
    perRunTokenCap: z.number().int().min(1000).max(100000),
    tokenCap: z.number().int().min(1000).max(10000000),
    productionReserve: z.number().int().min(10000).max(10000000).default(50000),
    verifiedOnly: z.boolean().default(true),
    judge: z.boolean().default(false),
    authorizedPaid: z.literal(true),
    requestKey: z.string().min(8).max(200),
  })
  .strict()
  .refine((x) => x.tokenCap >= x.perRunTokenCap, {
    message: "Aggregate budget must cover at least one run",
  });
export const ShadowControl = z
  .object({
    action: z.enum(["stop", "retry"]),
    resultId: z.string().optional(),
    acknowledgeUncertain: z.boolean().default(false),
  })
  .strict();
export const ShadowReview = z
  .object({
    verdict: z.enum(["pass", "fail", "needs_review"]),
    note: z.string().trim().min(1).max(2000),
  })
  .strict();
export const CanaryStart = z
  .object({
    experimentId: z.string().min(1),
    percent: z.union([
      z.literal(1),
      z.literal(5),
      z.literal(10),
      z.literal(25),
      z.literal(50),
    ]),
    hours: z.number().int().min(1).max(168),
    tokenCap: z.number().int().min(1000).max(10000000),
    reviewThreshold: z.number().int().min(1).max(1000),
    maxFailures: z.number().int().min(1).max(100).default(1),
    authorizedLiveEffects: z.literal(true),
    decision: z.string().trim().min(10).max(2000),
    requestKey: z.string().min(8).max(200),
  })
  .strict();
export const CanaryControl = z
  .object({
    action: z.enum(["stop", "increase", "promote"]),
    percent: z
      .union([
        z.literal(1),
        z.literal(5),
        z.literal(10),
        z.literal(25),
        z.literal(50),
      ])
      .optional(),
    reason: z.string().trim().min(1).max(2000),
    draftRevision: z.number().int().min(1).optional(),
  })
  .strict();
