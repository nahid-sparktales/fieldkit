import { z } from "zod";
import { BusinessCalendar } from "./sla-contracts.js";

export const AutomationCondition = z
  .object({
    field: z.string().min(1).max(100),
    op: z.enum(["eq", "neq", "in", "contains", "is_set", "gte", "lte"]),
    value: z
      .union([
        z.string().max(500),
        z.number().finite(),
        z.boolean(),
        z.array(z.string().max(200)).max(50),
        z.null(),
      ])
      .optional(),
  })
  .strict();
export const AutomationTrigger = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("event"),
      event: z.enum([
        "created",
        "customer_message",
        "staff_reply",
        "ticket_changed",
        "sla_warning",
        "sla_breach",
      ]),
    })
    .strict(),
  z
    .object({
      type: z.literal("inactivity"),
      anchor: z.enum([
        "created",
        "last_customer",
        "last_staff",
        "ticket_changed",
        "waiting",
      ]),
      minutes: z.number().int().min(1).max(43200),
      clock: z.enum(["elapsed", "business"]).default("elapsed"),
      calendar: BusinessCalendar.optional(),
    })
    .strict(),
]);
export const AutomationAction = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("priority"),
      value: z.enum(["low", "normal", "high", "urgent"]),
    })
    .strict(),
  z
    .object({
      type: z.literal("tags"),
      add: z.array(z.string().trim().min(1).max(60)).max(20).default([]),
      remove: z.array(z.string().trim().min(1).max(60)).max(20).default([]),
    })
    .strict(),
  z
    .object({
      type: z.literal("route"),
      teamId: z.string().min(1).max(200),
      requeue: z.boolean().default(true),
    })
    .strict(),
  z
    .object({
      type: z.literal("note"),
      body: z.string().trim().min(1).max(4000),
    })
    .strict(),
  z
    .object({
      type: z.literal("notify"),
      recipient: z.enum(["assignee", "staff"]),
      userIds: z.array(z.string().min(1).max(200)).max(20).default([]),
      body: z.string().trim().min(1).max(2000),
      email: z.boolean().default(false),
    })
    .strict(),
  z
    .object({
      type: z.literal("reply"),
      body: z.string().trim().min(1).max(2000),
    })
    .strict(),
  z.object({ type: z.literal("resolve") }).strict(),
]);
export const AutomationDefinition = z
  .object({
    name: z.string().trim().min(1).max(100),
    description: z.string().trim().max(500).default(""),
    trigger: AutomationTrigger,
    all: z.array(AutomationCondition).max(12).default([]),
    any: z.array(AutomationCondition).max(12).default([]),
    actions: z.array(AutomationAction).min(1).max(8),
  })
  .strict()
  .superRefine((d, ctx) => {
    if (
      d.trigger.type === "inactivity" &&
      d.trigger.clock === "business" &&
      !d.trigger.calendar
    )
      ctx.addIssue({
        code: "custom",
        message: "Choose a business calendar",
        path: ["trigger", "calendar"],
      });
    if (d.actions.filter((a) => a.type === "reply").length > 1)
      ctx.addIssue({
        code: "custom",
        message: "A rule may send at most one public reply per source event",
      });
    if (
      d.actions.some((a) => a.type === "resolve") &&
      (d.trigger.type !== "inactivity" ||
        d.trigger.anchor !== "waiting" ||
        d.trigger.minutes < 1440)
    )
      ctx.addIssue({
        code: "custom",
        message:
          "Automatic resolution requires at least 24 hours waiting for the customer",
      });
    if (
      d.actions.some((a) => a.type === "resolve") &&
      d.actions.some((a) => a.type === "reply")
    )
      ctx.addIssue({
        code: "custom",
        message: "Send the reminder before a separate later resolution rule",
      });
    for (const [i, a] of d.actions.entries())
      if (a.type === "notify" && a.recipient === "staff" && !a.userIds.length)
        ctx.addIssue({
          code: "custom",
          message: "Choose notification recipients",
          path: ["actions", i, "userIds"],
        });
  });
export const AutomationSave = z
  .object({
    id: z.string().min(1).max(200).optional(),
    revision: z.number().int().min(1).optional(),
    position: z.number().int().min(0).max(1000).default(0),
    definition: AutomationDefinition,
  })
  .strict();
export const AutomationActivation = z
  .object({
    revision: z.number().int().min(1),
    enabled: z.boolean(),
    confirm: z.boolean().default(false),
  })
  .strict();
export type AutomationDefinitionValue = z.infer<typeof AutomationDefinition>;
export type AutomationConditionValue = z.infer<typeof AutomationCondition>;
export type AutomationActionValue = z.infer<typeof AutomationAction>;
