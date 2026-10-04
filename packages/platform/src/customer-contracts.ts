import { z } from "zod";

export const InboxQuery = z
  .object({
    type: z.enum(["all", "ticket", "chat"]).default("all"),
    group: z.enum(["conversation", "customer"]).default("customer"),
    state: z
      .enum(["all", "human", "approval", "agent", "resolved"])
      .default("all"),
    assignee: z.string().max(200).default("all"),
    q: z.string().trim().max(200).default(""),
    contactId: z.string().max(200).optional(),
    page: z.coerce.number().int().min(1).max(100000).default(1),
  })
  .strict();
export const CustomerQuery = z
  .object({
    q: z.string().trim().max(200).default(""),
    kind: z.enum(["all", "verified", "visitor"]).default("all"),
    page: z.coerce.number().int().min(1).max(100000).default(1),
  })
  .strict();
export const CustomerNote = z
  .object({
    body: z.string().trim().min(1).max(12000),
    requestKey: z.string().min(8).max(200),
  })
  .strict();
export const CustomerPage = z
  .object({
    page: z.coerce.number().int().min(1).max(100000).default(1),
  })
  .strict();
