import { z } from "zod";
import { Temporal } from "@js-temporal/polyfill";
const minute = z.number().int().min(1).max(43200);
const clock = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$|^24:00$/);
export const BusinessCalendar = z
  .object({
    timezone: z
      .string()
      .max(100)
      .refine((v) => {
        try {
          Temporal.Now.zonedDateTimeISO(v);
          return /\//.test(v) || v === "UTC";
        } catch {
          return false;
        }
      }, "Choose an IANA timezone"),
    shifts: z
      .array(
        z
          .object({
            day: z.number().int().min(1).max(7),
            start: clock,
            end: clock,
          })
          .strict(),
      )
      .min(1)
      .max(28),
    holidays: z
      .array(
        z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .refine((v) => {
            try {
              Temporal.PlainDate.from(v);
              return true;
            } catch {
              return false;
            }
          }),
      )
      .max(366)
      .default([]),
  })
  .strict()
  .superRefine((c, ctx) => {
    for (const day of [1, 2, 3, 4, 5, 6, 7]) {
      let end = "00:00";
      for (const s of c.shifts
        .filter((s) => s.day === day)
        .sort((a, b) => a.start.localeCompare(b.start))) {
        if (s.start >= s.end || s.start < end)
          ctx.addIssue({
            code: "custom",
            message:
              "Business shifts must be ordered, nonoverlapping and end after they start",
          });
        end = s.end;
      }
    }
  });
export const SlaRule = z
  .object({
    id: z.string().min(1).max(60),
    name: z.string().trim().min(1).max(100),
    channels: z.array(z.enum(["portal", "widget", "zendesk"])).min(1),
    priorities: z.array(z.enum(["low", "normal", "high", "urgent"])).min(1),
    firstMinutes: minute,
    nextMinutes: minute,
    handoffMinutes: minute,
    replies: z.enum(["staff_only", "public_ai_or_staff"]).default("staff_only"),
    warningMinutes: z.number().int().min(0).max(43200).default(15),
    escalateMinutes: z.number().int().min(0).max(43200).default(60),
    escalationUserId: z.string().max(100).nullable().default(null),
  })
  .strict();
export const SlaPolicy = z
  .object({
    enabled: z.boolean().default(false),
    calendar: BusinessCalendar,
    rules: z.array(SlaRule).min(1).max(20),
    staffEmail: z.boolean().default(false),
    followup: z
      .object({
        enabled: z.boolean().default(false),
        afterMinutes: minute.default(1440),
        template: z
          .string()
          .trim()
          .max(2000)
          .default(
            "Do you still need help with this request? Reply here and our team will help.",
          ),
        maxReminders: z.number().int().min(1).max(3).default(1),
      })
      .strict(),
  })
  .strict()
  .superRefine((p, ctx) => {
    if (new Set(p.rules.map((r) => r.id)).size !== p.rules.length)
      ctx.addIssue({
        code: "custom",
        message: "Rule identifiers must be unique",
      });
    if (p.followup.enabled && !p.followup.template)
      ctx.addIssue({
        code: "custom",
        message: "Review an exact follow-up message before enabling reminders",
      });
  });
export type SlaPolicyValue = z.infer<typeof SlaPolicy>;
export type Calendar = z.infer<typeof BusinessCalendar>;
export const defaultSlaPolicy = (): SlaPolicyValue =>
  SlaPolicy.parse({
    enabled: false,
    calendar: {
      timezone: "UTC",
      shifts: [1, 2, 3, 4, 5].map((day) => ({
        day,
        start: "09:00",
        end: "17:00",
      })),
      holidays: [],
    },
    rules: [
      {
        id: "support",
        name: "Support requests",
        channels: ["portal", "widget", "zendesk"],
        priorities: ["low", "normal", "high", "urgent"],
        firstMinutes: 240,
        nextMinutes: 480,
        handoffMinutes: 60,
      },
    ],
    followup: {},
  });
export const SlaPolicySave = z
  .object({ revision: z.number().int().min(0), policy: SlaPolicy })
  .strict();
export const SlaWait = z
  .object({ waiting: z.boolean(), allowReminder: z.boolean().default(false) })
  .strict();
