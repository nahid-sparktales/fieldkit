import { z } from "zod";
import { ModelProvider } from "./model-providers.js";
import { WorkflowDefinition } from "./workflow-definition.js";
const Id = z.string().min(1).max(200);
const Json = z.record(z.string(), z.unknown());
export const Expectations = z
  .object({
    intent: z.enum(["answer", "clarify", "action", "handoff"]).optional(),
    nodes: z.array(Id).max(96).default([]),
    sources: z.array(Id).max(24).default([]),
    actionName: Id.optional(),
    parameters: Json.optional(),
    requiresApproval: z.boolean().optional(),
    reference: z.string().max(12000).default(""),
  })
  .strict();
export const TestCase = z
  .object({
    id: Id,
    name: z.string().trim().min(1).max(200),
    turns: z
      .array(
        z
          .object({
            question: z.string().trim().min(1).max(12000),
            expected: Expectations.prefault({}),
          })
          .strict(),
      )
      .min(1)
      .max(10),
    fixtures: z
      .object({
        customer: z
          .object({
            verified: z.boolean().default(false),
            name: z.string().max(200).default(""),
            email: z.string().max(200).default(""),
            mappings: Json.default({}),
          })
          .strict()
          .prefault({}),
        account: z
          .object({
            billing: z.array(
              z
                .object({
                  mode: z.enum(["test", "live"]),
                  charges: z
                    .array(
                      z
                        .object({
                          id: Id,
                          amountMinor: z.number().int().min(0),
                          refundedMinor: z.number().int().min(0),
                          currency: z.string(),
                          paid: z.boolean(),
                          captured: z.boolean(),
                          disputed: z.boolean().default(false),
                          description: z.string().optional(),
                        })
                        .strict(),
                    )
                    .default([]),
                  subscriptions: z
                    .array(
                      z
                        .object({
                          id: Id,
                          status: z.string(),
                          cancelAtPeriodEnd: z.boolean(),
                          items: z.array(Json).default([]),
                        })
                        .strict(),
                    )
                    .default([]),
                })
                .strict(),
            ),
          })
          .strict()
          .optional(),
        steps: z
          .record(
            z.string(),
            z
              .object({
                output: Json.optional(),
                error: z.string().max(2000).optional(),
              })
              .strict(),
          )
          .default({}),
        dailyActionCount: z.number().int().min(0).default(0),
      })
      .strict()
      .prefault({}),
    channel: z.enum(["portal", "widget", "zendesk"]).default("portal"),
    sourceConversationId: Id.optional(),
    gapId: Id.optional(),
    personalDataReviewed: z.boolean().default(false),
  })
  .strict();
export type TestCaseDefinition = z.infer<typeof TestCase>;
export const SuiteInput = z
  .object({
    name: z.string().trim().min(1).max(200),
    revision: z.number().int().min(0).default(0),
    cases: z.array(TestCase).max(100),
  })
  .strict();
export const EvaluationInput = z
  .object({
    suiteId: Id,
    caseIds: z.array(Id).min(1).max(50).optional(),
    tokenCap: z.number().int().min(1000).max(10000000),
    variants: z
      .array(
        z
          .object({
            name: z.string().trim().min(1).max(80),
            definition: WorkflowDefinition.optional(),
            model: z.string().min(1).max(200).optional(),
            provider: ModelProvider.optional(),
          })
          .strict(),
      )
      .min(1)
      .max(2),
    judge: z
      .object({
        enabled: z.boolean().default(true),
        model: z.string().min(1).max(200).optional(),
        provider: ModelProvider.optional(),
      })
      .strict()
      .prefault({}),
  })
  .strict();
export const JudgeResult = z
  .object({
    grounding: z.number().int().min(1).max(5),
    relevance: z.number().int().min(1).max(5),
    completeness: z.number().int().min(1).max(5),
    referenceConsistency: z.enum([
      "consistent",
      "conflicting",
      "not_applicable",
    ]),
    explanation: z.string().max(4000),
    citationIds: z.array(Id).max(24),
  })
  .strict();
export const GapSuggestion = z
  .object({
    title: z.string().min(1).max(200),
    category: z.enum([
      "missing_knowledge",
      "conflicting_knowledge",
      "unclear_knowledge",
      "operational",
      "identity",
      "intentional",
      "needs_review",
    ]),
    explanation: z.string().max(4000),
    mergeWith: z.string().nullable(),
    missingInformation: z.array(z.string().max(1000)).max(12),
    question: z.string().max(200),
    answer: z.string().max(12000),
    citationIds: z.array(Id).max(24),
  })
  .strict();
export type QualityModelInput = {
  workspaceId: string;
  model: string;
  provider?: z.infer<typeof ModelProvider>;
  payload: unknown;
};
export const FeedbackInput = z
  .object({
    messageId: Id,
    resolved: z.boolean(),
    rating: z.enum(["good", "bad"]).nullable().default(null),
    comment: z.string().trim().max(2000).default(""),
  })
  .strict();
export const GapUpdate = z
  .object({
    status: z.enum(["open", "in_progress", "resolved", "dismissed"]),
    reason: z.string().trim().max(2000).default(""),
  })
  .strict();
export const AnalysisInput = z
  .object({
    tokenCap: z.number().int().min(1000).max(10000000),
    gapIds: z.array(Id).min(1).max(100).optional(),
  })
  .strict();
export const QualitySettings = z
  .object({
    nightly: z.boolean(),
    dailyTokenCap: z.number().int().min(0).max(10000000),
  })
  .strict()
  .refine(
    (v) => !v.nightly || v.dailyTokenCap >= 1000,
    "Set a daily token cap before enabling nightly analysis",
  );
