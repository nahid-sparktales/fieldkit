import { z } from "zod";

export const FieldValue = z.union([
  z.string().max(6000),
  z.number().finite(),
  z.boolean(),
  z.array(z.string().max(80)).max(50),
  z.null(),
]);
export const FieldValues = z
  .record(z.string().min(1).max(80), FieldValue)
  .refine((v) => Object.keys(v).length <= 50, "At most 50 fields are allowed");
export const FieldDefinition = z
  .object({
    label: z.string().trim().min(1).max(120),
    type: z.enum([
      "text",
      "multiline",
      "number",
      "boolean",
      "date",
      "select",
      "multiselect",
    ]),
    description: z.string().max(500).default(""),
    position: z.number().int().min(0).max(1000).default(0),
    customerVisible: z.boolean().default(false),
    customerEditable: z.boolean().default(false),
    options: z
      .array(
        z
          .object({
            id: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),
            label: z.string().trim().min(1).max(120),
            archived: z.boolean().default(false),
          })
          .strict(),
      )
      .max(50)
      .default([]),
    min: z.number().finite().optional(),
    max: z.number().finite().optional(),
    maxLength: z.number().int().min(1).max(6000).default(6000),
    archived: z.boolean().default(false),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.customerEditable && !v.customerVisible)
      ctx.addIssue({
        code: "custom",
        message: "Customer-editable fields must be customer-visible",
      });
    if (v.min !== undefined && v.max !== undefined && v.min > v.max)
      ctx.addIssue({
        code: "custom",
        message: "Minimum must not exceed maximum",
      });
    if (new Set(v.options.map((o) => o.id)).size !== v.options.length)
      ctx.addIssue({ code: "custom", message: "Option IDs must be unique" });
    if (["select", "multiselect"].includes(v.type) && !v.options.length)
      ctx.addIssue({ code: "custom", message: "Select fields need options" });
  });
export const Condition = z
  .object({
    fieldId: z.string().min(1).max(80),
    op: z.enum(["eq", "neq", "in", "contains", "is_set"]),
    value: FieldValue.optional(),
  })
  .strict();
export const FormEntry = z
  .object({
    fieldId: z.string().min(1).max(80),
    required: z.boolean().default(false),
    visibleWhen: z.array(Condition).max(8).default([]),
    requiredWhen: z.array(Condition).max(8).default([]),
  })
  .strict();
export const FormDefinition = z
  .object({
    name: z.string().trim().min(1).max(120),
    description: z.string().max(500).default(""),
    position: z.number().int().min(0).max(1000).default(0),
    active: z.boolean().default(false),
    archived: z.boolean().default(false),
    emailDefault: z.boolean().default(false),
    defaultTeamId: z.string().max(200).nullable().default(null),
    fields: z.array(FormEntry).max(50).default([]),
  })
  .strict();
export const IntakeInput = z
  .object({
    formId: z.string().max(200).optional(),
    formVersion: z.number().int().positive().optional(),
    values: FieldValues.default({}),
    source: z.enum(["portal", "email", "widget"]).default("portal"),
  })
  .strict();
export const TicketPatch = z
  .object({
    priority: z.enum(["low", "normal", "high", "urgent"]).optional(),
    tags: z.array(z.string().trim().min(1).max(60)).max(20).optional(),
    status: z.enum(["open", "resolved"]).optional(),
    teamId: z.string().max(200).nullable().optional(),
    assignedTo: z.string().max(200).nullable().optional(),
    fields: FieldValues.optional(),
  })
  .strict();
const scope = {
  scope: z.enum(["personal", "team", "workspace"]).default("personal"),
  teamId: z.string().max(200).nullable().default(null),
};
export const MacroDefinition = z
  .object({
    name: z.string().trim().min(1).max(120),
    description: z.string().max(500).default(""),
    ...scope,
    body: z.string().max(12000),
    note: z.boolean().default(false),
    changes: TicketPatch.default({}),
    archived: z.boolean().default(false),
  })
  .strict();
export const MacroProposal = z
  .object({
    id: z.string().min(1).max(200),
    revision: z.number().int().positive(),
    changes: TicketPatch,
  })
  .strict();
export const ViewFilter = z
  .object({
    field: z.string().min(1).max(100),
    op: z.enum([
      "eq",
      "neq",
      "in",
      "contains",
      "is_set",
      "before",
      "after",
      "gte",
      "lte",
    ]),
    value: FieldValue.optional(),
  })
  .strict();
export const ViewDefinition = z
  .object({
    name: z.string().trim().min(1).max(120),
    ...scope,
    filters: z.array(ViewFilter).max(12).default([]),
    sort: z
      .enum([
        "updated_desc",
        "created_desc",
        "created_asc",
        "priority_desc",
        "sla_asc",
      ])
      .default("updated_desc"),
    columns: z
      .array(z.string().max(100))
      .min(1)
      .max(12)
      .refine((v) => v.includes("subject"), "Subject must remain visible")
      .default(["subject", "customer", "status", "priority", "assignee"]),
    archived: z.boolean().default(false),
  })
  .strict();
export const ViewQuery = z
  .object({
    page: z.coerce.number().int().min(1).max(250).default(1),
    q: z.string().trim().max(200).default(""),
  })
  .strict();
export type TicketField = z.infer<typeof FieldDefinition> & {
  id: string;
  revision: number;
};
export type FormField = z.infer<typeof FormEntry> & { definition: TicketField };
export type Values = z.infer<typeof FieldValues>;
export const isMissing = (value: unknown) =>
  value === undefined ||
  value === null ||
  value === "" ||
  (Array.isArray(value) && value.length === 0);
export function matchesConditions(
  conditions: z.infer<typeof Condition>[],
  values: Values,
): boolean {
  return conditions.every((c) => {
    const v = values[c.fieldId];
    if (c.op === "is_set") return !isMissing(v);
    if (c.op === "eq") return JSON.stringify(v) === JSON.stringify(c.value);
    if (c.op === "neq") return JSON.stringify(v) !== JSON.stringify(c.value);
    if (c.op === "in")
      return Array.isArray(c.value) && c.value.includes(String(v));
    return Array.isArray(v)
      ? v.includes(String(c.value))
      : typeof v === "string" && v.includes(String(c.value ?? ""));
  });
}
export function visibleFormFields(fields: FormField[], values: Values) {
  const entries = new Map(fields.map((f) => [f.fieldId, f]));
  const visible = new Map<string, boolean>();
  const visit = (id: string, depth = 0): boolean => {
    if (visible.has(id)) return visible.get(id)!;
    if (depth > 8) return false;
    const f = entries.get(id);
    if (!f) return false;
    const yes =
      f.visibleWhen.every((c) => visit(c.fieldId, depth + 1)) &&
      matchesConditions(f.visibleWhen, values);
    visible.set(id, yes);
    return yes;
  };
  return fields.filter((f) => visit(f.fieldId));
}
