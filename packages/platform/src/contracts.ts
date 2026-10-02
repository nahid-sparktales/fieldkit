import { z } from "zod";

export const WorkspaceInput = z
  .object({
    name: z.string().trim().min(2).max(80),
    slug: z.string().regex(/^[a-z0-9][a-z0-9-]{2,47}$/),
  })
  .strict();
export const Settings = z
  .object({
    model: z.string().min(1).max(100).default("gpt-5.4-mini"),
    embeddingModel: z
      .literal("text-embedding-3-small")
      .default("text-embedding-3-small"),
    instructions: z
      .string()
      .max(6000)
      .default(
        "Be helpful, concise, and honest. Answer from the approved company knowledge. Ask for clarification when needed.",
      ),
    monthlyTokenBudget: z
      .number()
      .int()
      .min(1000)
      .max(1000000000)
      .default(1000000),
    retentionDays: z.number().int().min(7).max(3650).default(90),
    brandColor: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/)
      .default("#146b57"),
    greeting: z.string().max(200).default("How can we help?"),
    replies: z.enum(["review", "automatic"]).default("review"),
  })
  .strict();
export const ChannelInput = z
  .object({
    published: z.boolean(),
    settings: z
      .object({
        origins: z.array(z.url()).max(20).default([]),
        handoff: z.enum(["native", "zendesk"]).default("native"),
      })
      .strict(),
  })
  .strict();
export const MessageInput = z
  .object({
    body: z.string().trim().min(1).max(12000),
    requestKey: z.string().min(8).max(120),
  })
  .strict();
export const SourceInput = z
  .object({
    kind: z.enum(["website", "notion", "google", "zendesk"]),
    title: z.string().trim().min(1).max(200),
    locator: z.string().min(1).max(2000),
    scope: z.enum(["page", "site"]).default("page"),
  })
  .strict()
  .refine(
    (input) => input.scope === "page" || input.kind === "website",
    "Only website sources support a full-site scan",
  );
export const FaqInput = z
  .object({
    question: z.string().trim().min(3).max(200),
    answer: z.string().trim().min(3).max(12000),
  })
  .strict();
export const FaqGenerationInput = z
  .object({
    sourceId: z.string().min(1).max(200).optional(),
    instructions: z.string().trim().max(2000).default(""),
    count: z.number().int().min(1).max(8).default(5),
  })
  .strict();
export const FaqSuggestion = FaqInput.extend({
  citationIds: z.array(z.string()).max(12),
});
export const FaqSuggestions = z
  .object({ faqs: z.array(FaqSuggestion).max(8) })
  .strict();
export type FaqDraft = z.infer<typeof FaqSuggestion>;
export const AssistanceKind = z.enum([
  "faq_review",
  "triage",
  "research",
  "response",
  "escalation",
  "article",
]);
export const AssistanceInput = z
  .object({
    kind: AssistanceKind,
    conversationId: z.string().min(1).max(200).optional(),
    instructions: z.string().trim().max(2000).default(""),
  })
  .strict();
export const SupportSuggestion = z
  .object({
    title: z.string().trim().min(1).max(200),
    body: z.string().trim().min(1).max(12000),
    priority: z.enum(["low", "normal", "high", "urgent"]),
    category: z.string().trim().max(80),
    reason: z.string().max(2000),
    citationIds: z.array(z.string()).max(24),
    gaps: z.array(z.string().max(500)).max(12),
  })
  .strict();
export type SupportDraft = z.infer<typeof SupportSuggestion>;
export const ActionPolicy = z
  .object({
    mode: z.enum(["approval", "automatic"]).default("approval"),
    maxAmountMinor: z
      .number()
      .int()
      .min(0)
      .max(Number.MAX_SAFE_INTEGER)
      .default(0),
    currency: z
      .string()
      .regex(/^[a-z]{3}$/)
      .default("usd"),
    dailyLimit: z.number().int().min(1).max(10000).default(10),
  })
  .strict();
export const ActionInput = z
  .object({
    name: z.string().regex(/^[a-z][a-z0-9_]{2,49}$/),
    description: z.string().min(8).max(1000),
    kind: z.enum([
      "stripe_refund",
      "stripe_cancel",
      "custom_read",
      "custom_write",
    ]),
    enabled: z.boolean().default(false),
    config: z
      .object({
        stripeMode: z.enum(["test", "live"]).default("test"),
        endpoint: z.url().optional(),
        lookupEndpoint: z.url().optional(),
        inputSchema: z.record(z.string(), z.unknown()).optional(),
        outputSchema: z.record(z.string(), z.unknown()).optional(),
        idempotent: z.boolean().default(false),
        credentialId: z.string().optional(),
        mappingKey: z
          .string()
          .regex(/^[a-z][a-z0-9_]{1,40}$/)
          .default("customer_id"),
      })
      .strict()
      .default({
        idempotent: false,
        mappingKey: "customer_id",
        stripeMode: "test",
      }),
    policy: ActionPolicy.default({
      mode: "approval",
      maxAmountMinor: 0,
      currency: "usd",
      dailyLimit: 10,
    }),
  })
  .strict();
export type ActionDefinition = z.infer<typeof ActionInput> & {
  id: string;
  workspace_id: string;
  revision: number;
};
export type Citation = {
  id: string;
  documentId: string;
  sourceId: string;
  title: string;
  version: number;
  excerpt: string;
  url?: string;
};
export type Proposal = {
  actionId: string;
  actionRevision: number;
  parameters: Record<string, unknown>;
  contactId: string;
  contactRevision: number;
  connectionRevision: number;
  workspaceRevision: number;
  conversationRevision: number;
  evidenceHash: string;
  reason: string;
};
export type Draft = {
  intent: "answer" | "clarify" | "action" | "handoff";
  answer: string;
  citationIds: string[];
  actionName: string | null;
  parameters: Record<string, unknown>;
  reason: string;
};
export const DraftSchema = z
  .object({
    intent: z.enum(["answer", "clarify", "action", "handoff"]),
    answer: z.string().max(12000),
    citationIds: z.array(z.string()).max(12),
    actionName: z.string().nullable(),
    parameters: z.record(z.string(), z.unknown()),
    reason: z.string().max(2000),
  })
  .strict();
