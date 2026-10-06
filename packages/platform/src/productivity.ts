import type { PoolClient } from "pg";
import { type Database, type Queryable, uid } from "./db.js";
import { type Principal, conversation, staff } from "./auth.js";
import {
  refreshPrincipal,
  requireCapability,
  hasCapability,
  conversationVisibility,
} from "./permissions.js";
import { HttpError, requireValue } from "./config.js";
import {
  FieldDefinition,
  FormDefinition,
  IntakeInput,
  MacroDefinition,
  MacroProposal,
  ViewDefinition,
  ViewQuery,
  FieldValues,
  isMissing,
  matchesConditions,
  visibleFormFields,
  type TicketField,
  type FormField,
  type Values,
} from "./productivity-contracts.js";
import { z } from "zod";
type Row = Record<string, any>;
type Assign = (
  q: PoolClient,
  p: Principal,
  conv: Row,
  input: {
    teamId?: string | null;
    assignedTo?: string | null;
    reason?: string;
  },
) => Promise<Row>;
const own = (o: object, key: string) =>
  Object.prototype.hasOwnProperty.call(o, key);
const normalized = (value: any): any =>
  Array.isArray(value)
    ? value.map(normalized)
    : value && typeof value === "object"
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((k) => [k, normalized(value[k])]),
        )
      : value;
const equal = (a: any, b: any) =>
  JSON.stringify(normalized(a)) === JSON.stringify(normalized(b));
const definition = (row: Row) => ({
  ...row.definition,
  id: row.id,
  revision: row.revision,
  ownerId: row.owner_id,
});
const fail = (message: string): never => {
  throw new HttpError(400, message);
};
export function validateFieldValue(field: TicketField, value: unknown): any {
  if (value === null) return null;
  const label = field.label;
  if (field.type === "text" || field.type === "multiline") {
    if (
      typeof value !== "string" ||
      value.length >
        Math.min(field.maxLength, field.type === "text" ? 500 : 6000)
    )
      fail(`${label}: enter text within the length limit`);
    if (field.type === "text" && /[\r\n]/.test(value as string))
      fail(`${label}: enter a single line`);
  } else if (field.type === "number") {
    if (
      typeof value !== "number" ||
      !Number.isFinite(value) ||
      (field.min !== undefined && value < field.min) ||
      (field.max !== undefined && value > field.max)
    )
      fail(`${label}: enter a number within the permitted range`);
  } else if (field.type === "boolean") {
    if (typeof value !== "boolean") fail(`${label}: choose yes or no`);
  } else if (field.type === "date") {
    if (
      typeof value !== "string" ||
      !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
      !Number.isFinite(Date.parse(value)) ||
      new Date(value).toISOString().slice(0, 10) !== value
    )
      fail(`${label}: enter a valid YYYY-MM-DD date`);
  } else {
    const options = new Set(
      field.options.filter((o) => !o.archived).map((o) => o.id),
    );
    if (field.type === "select") {
      if (typeof value !== "string" || !options.has(value))
        fail(`${label}: choose an available option`);
    } else if (
      !Array.isArray(value) ||
      value.length > 50 ||
      new Set(value).size !== value.length ||
      value.some((v) => typeof v !== "string" || !options.has(v))
    )
      fail(`${label}: choose available options without duplicates`);
  }
  return value;
}
export function validateFormDependencies(fields: FormField[]) {
  const entries = new Map(fields.map((f) => [f.fieldId, f]));
  if (entries.size !== fields.length)
    fail("Each field may appear only once in a form");
  const visit = (id: string, path: string[]) => {
    if (path.includes(id)) fail("Form conditions must not contain a cycle");
    if (path.length > 8)
      fail("Form conditions may depend on at most eight levels");
    const entry = entries.get(id);
    if (!entry) fail("Conditions must refer to a field in this form");
    for (const condition of [...entry!.visibleWhen, ...entry!.requiredWhen]) {
      const source = entries.get(condition.fieldId);
      if (!source) fail("Conditions must refer to a field in this form");
      if (condition.op !== "is_set" && condition.value === undefined)
        fail("A condition needs a comparison value");
      if (condition.op === "in") {
        if (
          !Array.isArray(condition.value) ||
          !["select", "text"].includes(source!.definition.type)
        )
          fail("The in operator requires a text/select field and a list");
      } else if (condition.op === "contains") {
        if (
          !["text", "multiline", "multiselect"].includes(
            source!.definition.type,
          ) ||
          typeof condition.value !== "string"
        )
          fail("Contains requires text or multiple choices and a text value");
      } else if (condition.op !== "is_set")
        validateFieldValue(source!.definition, condition.value);
      visit(condition.fieldId, [...path, id]);
    }
  };
  fields.forEach((f) => visit(f.fieldId, []));
}
const defaults = [
  {
    id: "default-unassigned",
    name: "Unassigned",
    filters: [
      { field: "assignee", op: "eq", value: "unassigned" },
      { field: "status", op: "neq", value: "resolved" },
    ],
  },
  {
    id: "default-mine",
    name: "My Active Tickets",
    filters: [
      { field: "assignee", op: "eq", value: "me" },
      { field: "status", op: "neq", value: "resolved" },
    ],
  },
  {
    id: "default-team",
    name: "Team Queue",
    filters: [
      { field: "team", op: "eq", value: "my_teams" },
      { field: "status", op: "neq", value: "resolved" },
    ],
  },
  {
    id: "default-sla",
    name: "SLA At Risk",
    filters: [{ field: "sla", op: "in", value: ["at risk", "overdue"] }],
  },
].map((v) => ({
  ...v,
  scope: "workspace",
  teamId: null,
  sort: "updated_desc",
  columns: ["subject", "customer", "status", "priority", "assignee"],
  archived: false,
  revision: 1,
  builtin: true,
}));
export const MACRO_EXAMPLES = [
  {
    name: "Request More Information",
    body: "Hi {{customer.name}},\n\nCould you share the steps you took, what you expected, and what happened? Please omit passwords and payment details.\n\nThank you.",
    note: false,
    changes: {},
  },
  {
    name: "Billing Follow-Up",
    body: "Hi {{customer.name}},\n\nWe are reviewing your billing question about {{ticket.subject}}. Could you share a non-sensitive invoice reference and the date of the charge?",
    note: false,
    changes: { tags: ["billing-follow-up"] },
  },
  {
    name: "Escalate to Technical Support",
    body: "Technical review requested for {{ticket.subject}}.\n\nObserved behavior:\nExpected behavior:\nSteps already tried:",
    note: true,
    changes: { priority: "high", tags: ["technical-review"] },
  },
];
export class Productivity {
  constructor(
    private db: Database,
    private hooks: { assign?: Assign } = {},
  ) {}
  private async fresh(p: Principal, q?: Queryable) {
    return refreshPrincipal(this.db, p, q);
  }
  private async fieldRows(ws: string, q?: Queryable): Promise<TicketField[]> {
    return (
      await this.db.rows(
        "SELECT * FROM ticket_fields WHERE workspace_id=$1 ORDER BY (definition->>'position')::int,id",
        [ws],
        q,
      )
    ).map(definition) as TicketField[];
  }
  private readable(p: Principal, f: TicketField) {
    return f.customerVisible || hasCapability(p, "fields:internal:read");
  }
  private writable(p: Principal, f: TicketField) {
    if (f.archived) throw new HttpError(409, `${f.label} is archived`);
    if (staff(p)) {
      requireCapability(p, "tickets:update");
      if (!f.customerVisible) requireCapability(p, "fields:internal:write");
    } else if (!f.customerVisible || !f.customerEditable)
      throw new HttpError(403, "This field is not customer-editable");
  }
  async config(p: Principal) {
    p = await this.fresh(p);
    requireCapability(p, "tickets:read");
    const names = [
      "fields:manage",
      "fields:internal:read",
      "fields:internal:write",
      "macros:personal",
      "macros:shared",
      "views:personal",
      "views:shared",
      "tickets:update",
      "tickets:assign",
    ];
    return {
      permissions: Object.fromEntries(
        names.map((name) => [name, hasCapability(p, name)]),
      ),
      viewTeams: await this.db.rows(
        "SELECT id,name FROM teams WHERE workspace_id=$1 AND active AND ($2::boolean OR id=ANY($3::text[])) ORDER BY name",
        [
          p.workspaceId,
          !p.ticketScope || p.ticketScope === "all",
          p.teamIds ?? [],
        ],
      ),
      formOptions: await this.db.rows(
        "SELECT id,definition->>'name' name FROM ticket_forms WHERE workspace_id=$1 AND definition->>'archived'='false' ORDER BY definition->>'name',id",
        [p.workspaceId],
      ),
      formTeams: hasCapability(p, "fields:manage")
        ? await this.db.rows(
            "SELECT id,name FROM teams WHERE workspace_id=$1 AND active ORDER BY name",
            [p.workspaceId],
          )
        : [],
      teams: await this.db.rows(
        "SELECT id,name FROM teams WHERE workspace_id=$1 AND active AND id=ANY($2::text[]) ORDER BY name",
        [p.workspaceId, (p as any).teamIds ?? []],
      ),
    };
  }
  async fields(p: Principal, includeArchived = false) {
    p = await this.fresh(p);
    requireCapability(p, "tickets:read");
    return {
      fields: (await this.fieldRows(p.workspaceId)).filter(
        (f) =>
          (includeArchived || !f.archived) &&
          (this.readable(p, f) || hasCapability(p, "fields:manage")),
      ),
    };
  }
  async saveField(p: Principal, id: string | null, raw: unknown) {
    const input = z
      .object({
        revision: z.number().int().positive().optional(),
        definition: FieldDefinition,
      })
      .strict()
      .parse(raw);
    return this.db.tx(async (q) => {
      p = await this.fresh(p, q);
      requireCapability(p, "fields:manage");
      const old = id
        ? requireValue(
            await this.db.one(
              "SELECT * FROM ticket_fields WHERE workspace_id=$1 AND id=$2 FOR UPDATE",
              [p.workspaceId, id],
              q,
            ),
          )
        : null;
      if (old && old.revision !== input.revision)
        throw new HttpError(409, "This field changed. Reload before saving.");
      if (old && old.definition.type !== input.definition.type)
        fail(
          "A field's type cannot change. Archive it and create a new field.",
        );
      if (
        old &&
        old.definition.options.some(
          (o: Row) => !input.definition.options.some((n) => n.id === o.id),
        )
      )
        fail("Archive old options instead of removing their stable IDs");
      const count = await this.db.one(
        "SELECT count(*)::int n FROM ticket_fields WHERE workspace_id=$1",
        [p.workspaceId],
        q,
      );
      if (!old && count!.n >= 100)
        fail("This workspace has reached its 100-field limit");
      const fieldId = id ?? uid(),
        rev = (old?.revision ?? 0) + 1;
      await q.query(
        `INSERT INTO ticket_fields(workspace_id,id,definition,revision,created_by) VALUES($1,$2,$3,$4,$5) ON CONFLICT(workspace_id,id) DO UPDATE SET definition=$3,revision=$4,updated_at=now()`,
        [p.workspaceId, fieldId, input.definition, rev, p.userId],
      );
      await q.query(
        "INSERT INTO ticket_field_versions(workspace_id,field_id,revision,definition) VALUES($1,$2,$3,$4)",
        [p.workspaceId, fieldId, rev, input.definition],
      );
      await this.db.event(q, p.workspaceId, "ticket_field.saved", {
        fieldId,
        revision: rev,
        actor: p.userId,
      });
      return { ...input.definition, id: fieldId, revision: rev };
    });
  }
  async forms(p: Principal, admin = false) {
    p = await this.fresh(p);
    if (admin) requireCapability(p, "fields:manage");
    const rows = await this.db.rows(
      "SELECT * FROM ticket_forms WHERE workspace_id=$1 ORDER BY (definition->>'position')::int,id",
      [p.workspaceId],
    );
    const current = await this.fieldRows(p.workspaceId);
    return {
      forms: rows
        .map(definition)
        .map((f) => ({
          ...f,
          needsReview: f.fields.some(
            (v: FormField) =>
              !current.some(
                (c) =>
                  c.id === v.fieldId &&
                  !c.archived &&
                  c.customerVisible &&
                  c.customerEditable &&
                  c.revision === v.definition.revision,
              ),
          ),
        }))
        .filter((f) => admin || (f.active && !f.archived && !f.needsReview)),
    };
  }

  async saveForm(p: Principal, id: string | null, raw: unknown) {
    const input = z
      .object({
        revision: z.number().int().positive().optional(),
        definition: FormDefinition,
      })
      .strict()
      .parse(raw);
    return this.db.tx(async (q) => {
      p = await this.fresh(p, q);
      requireCapability(p, "fields:manage");
      const old = id
        ? requireValue(
            await this.db.one(
              "SELECT * FROM ticket_forms WHERE workspace_id=$1 AND id=$2 FOR UPDATE",
              [p.workspaceId, id],
              q,
            ),
          )
        : null;
      if (old && old.revision !== input.revision)
        throw new HttpError(409, "This form changed. Reload before saving.");
      const fields = await this.fieldRows(p.workspaceId, q),
        d = input.definition;
      const entries = d.fields.map((entry) => {
        const f = fields.find((f) => f.id === entry.fieldId);
        if (!f || f.archived || !f.customerVisible || !f.customerEditable)
          fail(
            "Customer forms can only use active customer-visible, customer-editable fields",
          );
        return { ...entry, definition: f! };
      });
      validateFormDependencies(entries);
      if (d.defaultTeamId)
        requireValue(
          await this.db.one(
            "SELECT id FROM teams WHERE workspace_id=$1 AND id=$2 AND active",
            [p.workspaceId, d.defaultTeamId],
            q,
          ),
          400,
          "Choose an active team in this workspace",
        );
      if (d.emailDefault && d.active && !d.archived) {
        await q.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
          `forms:${p.workspaceId}`,
        ]);
        if (
          await this.db.one(
            'SELECT id FROM ticket_forms WHERE workspace_id=$1 AND id<>$2 AND definition @> \'{"emailDefault":true,"active":true,"archived":false}\'',
            [p.workspaceId, id ?? ""],
            q,
          )
        )
          fail("Only one active form can be the email intake default");
      }
      const count = await this.db.one(
        "SELECT count(*)::int n FROM ticket_forms WHERE workspace_id=$1",
        [p.workspaceId],
        q,
      );
      if (!old && count!.n >= 50)
        fail("This workspace has reached its 50-form limit");
      const formId = id ?? uid(),
        rev = (old?.revision ?? 0) + 1,
        snapshot = { ...d, fields: entries };
      await q.query(
        "INSERT INTO ticket_forms(workspace_id,id,definition,revision,created_by) VALUES($1,$2,$3,$4,$5) ON CONFLICT(workspace_id,id) DO UPDATE SET definition=$3,revision=$4,updated_at=now()",
        [p.workspaceId, formId, snapshot, rev, p.userId],
      );
      await q.query(
        "INSERT INTO ticket_form_versions(workspace_id,form_id,revision,definition) VALUES($1,$2,$3,$4)",
        [p.workspaceId, formId, rev, snapshot],
      );
      await this.db.event(q, p.workspaceId, "ticket_form.saved", {
        formId,
        revision: rev,
        actor: p.userId,
      });
      return { ...snapshot, id: formId, revision: rev };
    });
  }
  private async writeValues(
    p: Principal,
    id: string,
    values: Values,
    q: PoolClient,
  ) {
    const fields = await this.fieldRows(p.workspaceId, q);
    for (const [fieldId, value] of Object.entries(values)) {
      const f = fields.find((f) => f.id === fieldId);
      if (!f) fail("Unknown ticket field");
      this.writable(p, f!);
      validateFieldValue(f!, value);
      await q.query(
        "INSERT INTO ticket_field_values(workspace_id,conversation_id,field_id,value,field_revision,definition) VALUES($1,$2,$3,$4::jsonb,$5,$6) ON CONFLICT(workspace_id,conversation_id,field_id) DO UPDATE SET value=$4::jsonb,field_revision=$5,definition=$6,updated_at=now()",
        [p.workspaceId, id, fieldId, JSON.stringify(value), f!.revision, f],
      );
    }
  }
  async verifyIntakeRetry(
    p: Principal,
    previous: Row,
    raw: unknown,
    q: Queryable,
  ) {
    const d = IntakeInput.parse(raw);
    const old = await this.db.one(
      "SELECT payload FROM ticket_intakes WHERE workspace_id=$1 AND conversation_id=$2",
      [p.workspaceId, previous.id],
      q,
    );
    if (
      old
        ? !equal(old.payload, d)
        : Boolean(d.formId && d.formId !== "default") ||
          Object.keys(d.values).length > 0
    )
      throw new HttpError(
        409,
        "Request key already belongs to a different form submission",
      );
  }
  async applyIntake(p: Principal, conv: Row, raw: unknown, q: PoolClient) {
    const d = IntakeInput.parse(raw);
    await q.query(
      "INSERT INTO ticket_intakes(workspace_id,conversation_id,payload) VALUES($1,$2,$3)",
      [p.workspaceId, conv.id, d],
    );
    let row: Row | undefined;
    if (d.formId && d.formId !== "default")
      row = requireValue(
        await this.db.one(
          "SELECT * FROM ticket_forms WHERE workspace_id=$1 AND id=$2",
          [p.workspaceId, d.formId],
          q,
        ),
      );
    else if (d.source === "email")
      row = await this.db.one(
        'SELECT * FROM ticket_forms WHERE workspace_id=$1 AND definition @> \'{"emailDefault":true,"active":true,"archived":false}\'',
        [p.workspaceId],
        q,
      );
    if (!row) {
      if (Object.keys(d.values).length)
        fail("Choose a configured form before supplying fields");
      await q.query(
        "UPDATE conversations SET intake_source=$3 WHERE workspace_id=$1 AND id=$2",
        [p.workspaceId, conv.id, d.source],
      );
      return { defaultTeamId: null };
    }
    if (!row.definition.active || row.definition.archived)
      throw new HttpError(409, "This form is no longer available");
    if (d.source !== "email" && d.formVersion !== row.revision)
      throw new HttpError(
        409,
        "This form changed. Refresh it before submitting.",
      );
    const fields = row.definition.fields as FormField[],
      visible = visibleFormFields(fields, d.values),
      allowed = new Set(visible.map((f) => f.fieldId));
    const currentFields = await this.fieldRows(p.workspaceId, q);
    if (
      d.source !== "email" &&
      fields.some(
        (f) =>
          !currentFields.some(
            (c) =>
              c.id === f.fieldId &&
              c.revision === f.definition.revision &&
              !c.archived &&
              c.customerVisible &&
              c.customerEditable,
          ),
      )
    )
      throw new HttpError(
        409,
        "The form's fields changed. Ask the team to review and publish the form again.",
      );
    for (const id of Object.keys(d.values))
      if (!allowed.has(id)) fail("A hidden or unknown field was submitted");
    for (const entry of visible)
      if (
        d.source !== "email" &&
        (entry.required ||
          (entry.requiredWhen.length &&
            matchesConditions(entry.requiredWhen, d.values))) &&
        isMissing(d.values[entry.fieldId])
      )
        fail(`${entry.definition.label} is required`);
    await this.writeValues(p, conv.id, d.values, q);
    await q.query(
      "UPDATE conversations SET form_id=$3,form_version=$4,intake_source=$5 WHERE workspace_id=$1 AND id=$2",
      [p.workspaceId, conv.id, row.id, row.revision, d.source],
    );
    const defaultTeam = row.definition.defaultTeamId
      ? await this.db.one(
          "SELECT id FROM teams WHERE workspace_id=$1 AND id=$2 AND active",
          [p.workspaceId, row.definition.defaultTeamId],
          q,
        )
      : null;
    return { defaultTeamId: defaultTeam?.id ?? null };
  }
  async ticketFields(p: Principal, id: string, q: Queryable = this.db.pool) {
    p = await this.fresh(p, q);
    const conv = await conversation(this.db, p, id, q);
    const fields = await this.fieldRows(p.workspaceId, q),
      stored = await this.db.rows(
        "SELECT * FROM ticket_field_values WHERE workspace_id=$1 AND conversation_id=$2",
        [p.workspaceId, id],
        q,
      );
    const allowed = fields.filter((f) => this.readable(p, f));
    const values: Values = {},
      historical: Row[] = [];
    for (const row of stored)
      if (allowed.some((f) => f.id === row.field_id)) {
        values[row.field_id] = row.value;
        historical.push({
          fieldId: row.field_id,
          value: row.value,
          definition: row.definition,
          revision: row.field_revision,
        });
      }
    const form = conv.form_id
      ? await this.db.one(
          "SELECT definition FROM ticket_form_versions WHERE workspace_id=$1 AND form_id=$2 AND revision=$3",
          [p.workspaceId, conv.form_id, conv.form_version],
          q,
        )
      : null;
    const missing = form
      ? visibleFormFields(form.definition.fields, values)
          .filter(
            (f) =>
              (f.required ||
                (f.requiredWhen.length &&
                  matchesConditions(f.requiredWhen, values))) &&
              isMissing(values[f.fieldId]) &&
              allowed.some((a) => a.id === f.fieldId),
          )
          .map((f) => f.definition.label)
      : [];
    return {
      fields: allowed
        .filter((f) => !f.archived)
        .map((f) => ({
          ...f,
          writable: staff(p)
            ? hasCapability(p, "tickets:update") &&
              (f.customerVisible || hasCapability(p, "fields:internal:write"))
            : f.customerEditable &&
              Boolean(
                form?.definition.fields.some(
                  (e: FormField) => e.fieldId === f.id,
                ),
              ),
        })),
      values,
      historical,
      form: form
        ? {
            id: conv.form_id,
            version: conv.form_version,
            name: form.definition.name,
          }
        : null,
      missing,
      formFields:
        !staff(p) && form
          ? form.definition.fields
              .filter((e: FormField) =>
                allowed.some(
                  (f) =>
                    f.id === e.fieldId && f.customerEditable && !f.archived,
                ),
              )
              .map((e: FormField) => ({
                ...e,
                definition: allowed.find((f) => f.id === e.fieldId),
              }))
          : [],
      editable: staff(p)
        ? hasCapability(p, "tickets:update")
        : Boolean(
            form?.definition.fields.some((e: FormField) =>
              allowed.some(
                (f) => f.id === e.fieldId && f.customerEditable && !f.archived,
              ),
            ),
          ),
    };
  }
  async updateFields(p: Principal, id: string, raw: unknown) {
    const d = z.object({ values: FieldValues }).strict().parse(raw);
    return this.db.tx(async (q) => {
      p = await this.fresh(p, q);
      const conv = await conversation(this.db, p, id, q);
      await q.query(
        "SELECT id FROM conversations WHERE workspace_id=$1 AND id=$2 FOR UPDATE",
        [p.workspaceId, id],
      );
      if (!staff(p)) {
        const stored = await this.ticketFields(p, id, q);
        const form = conv.form_id
          ? await this.db.one(
              "SELECT definition FROM ticket_form_versions WHERE workspace_id=$1 AND form_id=$2 AND revision=$3",
              [p.workspaceId, conv.form_id, conv.form_version],
              q,
            )
          : null;
        const allowed = new Set(
          visibleFormFields(form?.definition.fields ?? [], {
            ...stored.values,
            ...d.values,
          }).map((f) => f.fieldId),
        );
        if (Object.keys(d.values).some((id) => !allowed.has(id)))
          fail("A hidden or unrelated field cannot be updated");
        const before = visibleFormFields(
          form?.definition.fields ?? [],
          stored.values,
        );
        const merged = { ...stored.values, ...d.values };
        for (const entry of visibleFormFields(
          form?.definition.fields ?? [],
          merged,
        )) {
          const required =
            entry.required ||
            (entry.requiredWhen.length &&
              matchesConditions(entry.requiredWhen, merged));
          const wasRequired =
            entry.required ||
            (entry.requiredWhen.length &&
              matchesConditions(entry.requiredWhen, stored.values));
          if (
            required &&
            isMissing(merged[entry.fieldId]) &&
            (own(d.values, entry.fieldId) ||
              !before.some((f) => f.fieldId === entry.fieldId) ||
              !wasRequired)
          )
            fail(`${entry.definition.label} is required`);
        }
      }
      await this.writeValues(p, id, d.values, q);
      await this.db.event(
        q,
        p.workspaceId,
        "ticket_fields.updated",
        { actor: p.userId ?? p.contactId, fieldIds: Object.keys(d.values) },
        id,
        false,
      );
      return this.ticketFields(p, id, q);
    });
  }
  private canReadShared(p: Principal, row: Row) {
    const d = row.definition;
    return d.scope === "personal"
      ? row.owner_id === p.userId
      : d.scope === "workspace" ||
          ((p as any).teamIds ?? []).includes(d.teamId);
  }
  private async share(
    p: Principal,
    d: Row,
    kind: "macros" | "views",
    q?: Queryable,
  ) {
    requireCapability(
      p,
      `${kind}:${d.scope === "personal" ? "personal" : "shared"}`,
    );
    if (d.scope === "team") {
      if (!d.teamId || !((p as any).teamIds ?? []).includes(d.teamId))
        throw new HttpError(403, "Join this team before sharing with it");
      requireValue(
        await this.db.one(
          "SELECT id FROM teams WHERE workspace_id=$1 AND id=$2 AND active",
          [p.workspaceId, d.teamId],
          q,
        ),
        400,
        "Choose an active team",
      );
    } else if (d.teamId) fail("Only team-shared definitions have a team");
  }
  async library(
    p: Principal,
    kind: "macros" | "views",
    includeArchived = false,
    q: Queryable = this.db.pool,
  ): Promise<Row> {
    p = await this.fresh(p, q);
    requireCapability(p, "tickets:read");
    const table = kind === "macros" ? "ticket_macros" : "inbox_views";
    const rows = await this.db.rows(
      `SELECT * FROM ${table} WHERE workspace_id=$1 ORDER BY lower(definition->>'name'),id LIMIT 500`,
      [p.workspaceId],
      q,
    );
    const fields = await this.fieldRows(p.workspaceId, q);
    const readableMacro = (r: Row) =>
      kind !== "macros" ||
      (Object.keys(r.definition.changes.fields ?? {}).every((id) =>
        fields.some((f) => f.id === id && this.readable(p, f)),
      ) &&
        [...r.definition.body.matchAll(/\{\{field\.([^{}]+)\}\}/g)].every((m) =>
          fields.some((f) => f.id === m[1].trim() && this.readable(p, f)),
        ));
    return {
      [kind]: [
        ...(kind === "views" ? defaults : []),
        ...rows
          .filter(
            (r) =>
              (includeArchived || !r.definition.archived) &&
              this.canReadShared(p, r) &&
              readableMacro(r),
          )
          .map((r) => ({
            ...definition(r),
            canManage:
              r.owner_id === p.userId && r.definition.scope === "personal"
                ? hasCapability(p, `${kind}:personal`)
                : hasCapability(p, `${kind}:shared`),
          })),
      ],
      ...(kind === "macros" ? { examples: MACRO_EXAMPLES } : {}),
    };
  }
  async saveLibrary(
    p: Principal,
    kind: "macros" | "views",
    id: string | null,
    raw: unknown,
  ) {
    const schema = kind === "macros" ? MacroDefinition : ViewDefinition;
    const input = z
      .object({
        revision: z.number().int().positive().optional(),
        definition: schema,
      })
      .strict()
      .parse(raw);
    return this.db.tx(async (q) => {
      p = await this.fresh(p, q);
      await this.share(p, input.definition, kind, q);
      const table = kind === "macros" ? "ticket_macros" : "inbox_views";
      const old = id
        ? requireValue(
            await this.db.one(
              `SELECT * FROM ${table} WHERE workspace_id=$1 AND id=$2 FOR UPDATE`,
              [p.workspaceId, id],
              q,
            ),
          )
        : null;
      if (old) {
        if (!this.canReadShared(p, old))
          throw new HttpError(404, "Definition not found");
        await this.share(p, old.definition, kind, q);
        if (old.definition.scope === "personal" && old.owner_id !== p.userId)
          throw new HttpError(
            403,
            "Only the author can edit a personal definition",
          );
        if (old.revision !== input.revision)
          throw new HttpError(
            409,
            "This definition changed. Reload before saving.",
          );
      }
      if (kind === "macros") {
        await this.validateTemplate(
          p,
          (input.definition as any).body,
          q,
          !(input.definition as any).note,
        );
        await this.validatePatch(p, {}, (input.definition as any).changes, q);
      } else await this.compileView(p, input.definition as any, [], q);
      if (
        !old &&
        (await this.db.one(
          `SELECT count(*)::int n FROM ${table} WHERE workspace_id=$1`,
          [p.workspaceId],
          q,
        ))!.n >= 500
      )
        fail("This workspace has reached its 500-definition limit");
      const next = id ?? uid(),
        rev = (old?.revision ?? 0) + 1;
      await q.query(
        `INSERT INTO ${table}(workspace_id,id,owner_id,definition,revision) VALUES($1,$2,$3,$4,$5) ON CONFLICT(workspace_id,id) DO UPDATE SET definition=$4,revision=$5,updated_at=now()`,
        [p.workspaceId, next, old?.owner_id ?? p.userId, input.definition, rev],
      );
      await this.db.event(q, p.workspaceId, `${kind}.saved`, {
        id: next,
        revision: rev,
        actor: p.userId,
      });
      return { ...input.definition, id: next, revision: rev };
    });
  }
  private async macro(p: Principal, id: string, q?: Queryable) {
    const row = requireValue(
      await this.db.one(
        "SELECT * FROM ticket_macros WHERE workspace_id=$1 AND id=$2",
        [p.workspaceId, id],
        q,
      ),
    );
    if (row.definition.archived || !this.canReadShared(p, row))
      throw new HttpError(404, "Macro is unavailable");
    return row;
  }
  private async validateTemplate(
    p: Principal,
    body: string,
    q?: Queryable,
    publicResponse = false,
  ) {
    const fields = await this.fieldRows(p.workspaceId, q);
    const names = [...body.matchAll(/\{\{([^{}]+)\}\}/g)].map((m) =>
      m[1].trim(),
    );
    for (const name of names)
      if (
        ![
          "customer.name",
          "customer.email",
          "ticket.id",
          "ticket.subject",
          "ticket.priority",
        ].includes(name)
      ) {
        const f = name.startsWith("field.")
          ? fields.find((f) => f.id === name.slice(6))
          : null;
        if (
          !f ||
          f.archived ||
          !this.readable(p, f) ||
          (publicResponse && !f.customerVisible)
        )
          fail("A macro contains an unknown or restricted placeholder");
      }
    if (body.replace(/\{\{[^{}]+\}\}/g, "").includes("{{"))
      fail("Use complete allowlisted {{placeholders}}");
    return fields;
  }
  private async validatePatch(
    p: Principal,
    conv: Row,
    patch: Row,
    q?: Queryable,
  ) {
    if (Object.keys(patch).some((k) => k !== "fields"))
      requireCapability(p, "tickets:update");
    if (own(patch, "teamId") || own(patch, "assignedTo"))
      requireCapability(p, "tickets:assign");
    if (conv.external_id && Object.keys(patch).length)
      throw new HttpError(
        409,
        "Ticket-change macros are only supported on native tickets; edit Zendesk-controlled tickets with their existing controls",
      );
    const fields = await this.fieldRows(p.workspaceId, q);
    for (const [id, value] of Object.entries(patch.fields ?? {})) {
      const f = fields.find((f) => f.id === id);
      if (!f) fail("Unknown macro field");
      this.writable(p, f!);
      validateFieldValue(f!, value);
    }
    if (patch.teamId)
      requireValue(
        await this.db.one(
          "SELECT id FROM teams WHERE workspace_id=$1 AND id=$2 AND active",
          [p.workspaceId, patch.teamId],
          q,
        ),
        400,
        "Team is unavailable",
      );
    if (patch.assignedTo)
      requireValue(
        await this.db.one(
          "SELECT user_id FROM memberships WHERE workspace_id=$1 AND user_id=$2",
          [p.workspaceId, patch.assignedTo],
          q,
        ),
        400,
        "Assignee is unavailable",
      );
  }
  async previewMacro(p: Principal, id: string, macroId: string) {
    p = await this.fresh(p);
    const conv = await conversation(this.db, p, id),
      row = await this.macro(p, macroId),
      d = row.definition;
    requireCapability(p, d.note ? "tickets:note" : "tickets:reply");
    await this.validatePatch(p, conv, d.changes);
    await this.validateTemplate(p, d.body, undefined, !d.note);
    const customer = await this.db.one(
      "SELECT name,email FROM contacts WHERE workspace_id=$1 AND id=$2",
      [p.workspaceId, conv.contact_id],
    );
    const fieldData = await this.ticketFields(p, id),
      values: Row = {
        "customer.name": customer?.name,
        "customer.email": customer?.email,
        "ticket.id": id,
        "ticket.subject": conv.subject,
        "ticket.priority": conv.priority,
      };
    for (const f of fieldData.fields) {
      const v = fieldData.values[f.id];
      values[`field.${f.id}`] =
        f.type === "select"
          ? f.options.find((o) => o.id === v)?.label
          : f.type === "multiselect" && Array.isArray(v)
            ? v
                .map((id) => f.options.find((o) => o.id === id)?.label ?? id)
                .join(", ")
            : v;
    }
    const missing: string[] = [];
    const body = d.body.replace(
      /\{\{([^{}]+)\}\}/g,
      (_: string, key: string) => {
        key = key.trim();
        if (isMissing(values[key])) {
          missing.push(key);
          return `[Missing: ${key}]`;
        }
        return String(values[key]);
      },
    );
    return {
      body,
      note: d.note,
      macro: { id: row.id, revision: row.revision, changes: d.changes },
      missing,
      notice:
        "Draft only. Review the reply and proposed changes, then explicitly send or save.",
    };
  }
  async verifyMacroRetry(
    p: Principal,
    id: string,
    key: string,
    raw: unknown,
    q: Queryable,
  ) {
    const old = await this.db.one(
      "SELECT proposal FROM macro_applications WHERE workspace_id=$1 AND conversation_id=$2 AND request_key=$3",
      [p.workspaceId, id, key],
      q,
    );
    if (!equal(old?.proposal ?? null, raw ?? null))
      throw new HttpError(
        409,
        "This request key belongs to a different macro application",
      );
  }
  async commitMacro(
    p: Principal,
    id: string,
    raw: unknown,
    context: { requestKey: string; note: boolean },
    q: PoolClient,
  ) {
    if (raw === undefined) return;
    const d = MacroProposal.parse(raw);
    p = await this.fresh(p, q);
    const conv = await conversation(this.db, p, id, q),
      row = await this.macro(p, d.id, q);
    if (row.revision !== d.revision)
      throw new HttpError(
        409,
        "The macro changed. Preview it again before sending.",
      );
    requireCapability(p, context.note ? "tickets:note" : "tickets:reply");
    await this.validateTemplate(p, row.definition.body, q, !context.note);
    await this.validatePatch(p, conv, d.changes, q);
    // The draft may edit or remove proposed ticket changes. All edited values are
    // revalidated with exactly the authority required by ordinary controls.
    if (own(d.changes, "teamId") || own(d.changes, "assignedTo")) {
      if (!this.hooks.assign)
        throw new HttpError(409, "Manual assignment is not configured");
      await this.hooks.assign(q, p, conv, {
        ...(own(d.changes, "teamId") ? { teamId: d.changes.teamId } : {}),
        ...(own(d.changes, "assignedTo")
          ? { assignedTo: d.changes.assignedTo }
          : {}),
        reason: `Macro: ${row.definition.name}`,
      });
    }
    if (d.changes.fields) await this.writeValues(p, id, d.changes.fields, q);
    await q.query(
      "UPDATE conversations SET priority=coalesce($3,priority),tags=coalesce($4,tags),status=coalesce($5,status),revision=revision+1,updated_at=now() WHERE workspace_id=$1 AND id=$2",
      [
        p.workspaceId,
        id,
        d.changes.priority ?? null,
        d.changes.tags ?? null,
        d.changes.status ?? null,
      ],
    );
    await q.query(
      "INSERT INTO macro_applications(workspace_id,conversation_id,request_key,macro_id,macro_revision,proposal,actor_id) VALUES($1,$2,$3,$4,$5,$6,$7)",
      [p.workspaceId, id, context.requestKey, d.id, d.revision, d, p.userId],
    );
    await this.db.event(
      q,
      p.workspaceId,
      "macro.applied",
      {
        macroId: d.id,
        revision: d.revision,
        actor: p.userId,
        changed: Object.keys(d.changes),
      },
      id,
      false,
    );
    if (d.changes.status)
      await this.db.event(
        q,
        p.workspaceId,
        "conversation.updated",
        {
          status: d.changes.status,
          previousStatus: conv.status,
          actorType: "staff",
        },
        id,
        true,
      );
  }
  private async compileView(
    p: Principal,
    d: Row,
    args: unknown[],
    q?: Queryable,
  ) {
    const param = (v: any) => {
      args.push(v);
      return `$${args.length}`;
    };
    const fields = await this.fieldRows(p.workspaceId, q),
      clauses: string[] = [];
    const builtin: Record<string, string> = {
      status: "c.status",
      priority: "c.priority",
      assignee: "c.assigned_to",
      team: "c.team_id",
      channel:
        "CASE WHEN c.intake_source='email' THEN 'email' ELSE ch.kind END",
      form: "c.form_id",
      created: "c.created_at",
      updated: "c.updated_at",
    };
    for (const f of d.filters) {
      let value = f.value,
        expr = builtin[f.field];
      if (f.field === "assignee" && value === "me") value = p.userId;
      if (f.field === "team" && value === "my_teams") {
        if (f.op !== "eq") fail("My teams requires equals");
        clauses.push(
          `c.team_id=ANY(${param((p as any).teamIds ?? [])}::text[])`,
        );
        continue;
      }
      if (f.field === "assignee" && value === "unassigned") {
        if (!["eq", "neq"].includes(f.op))
          fail("Unassigned supports equals/not equals");
        clauses.push(`c.assigned_to IS ${f.op === "neq" ? "NOT " : ""}NULL`);
        continue;
      }
      if (f.field === "sla") {
        const valid = ["at risk", "overdue", "on track"],
          requested = Array.isArray(value) ? value : [value];
        if (
          !["eq", "in"].includes(f.op) ||
          requested.some((v: any) => !valid.includes(v))
        )
          fail("Choose a valid SLA urgency");
        clauses.push(
          `EXISTS(SELECT 1 FROM sla_obligations o WHERE o.workspace_id=c.workspace_id AND o.conversation_id=c.id AND o.ended_at IS NULL AND o.state<>'paused' AND (CASE WHEN o.breached_at IS NOT NULL OR o.due_at<=now() THEN 'overdue' WHEN o.warning_at<=now() THEN 'at risk' ELSE 'on track' END)=ANY(${param(requested)}::text[]))`,
        );
        continue;
      }
      if (f.field === "tags") {
        if (!["contains", "in"].includes(f.op))
          fail("Tags support contains/in");
        const list = Array.isArray(value) ? value : [value];
        if (list.some((v: any) => typeof v !== "string"))
          fail("Tags must be text");
        clauses.push(
          `c.tags ${f.op === "contains" ? "@>" : "&&"} ${param(list)}::text[]`,
        );
        continue;
      }
      if (f.field.startsWith("field.")) {
        const field = fields.find((v) => v.id === f.field.slice(6));
        if (!field || field.archived || !this.readable(p, field))
          throw new HttpError(
            409,
            "This view uses an archived or inaccessible field. Edit its filters.",
          );
        const prefix = `v.workspace_id=c.workspace_id AND v.conversation_id=c.id AND v.field_id=${param(field.id)}`;
        let comparison = "";
        if (f.op === "is_set")
          comparison =
            "v.value<>'null'::jsonb AND v.value<>'\"\"'::jsonb AND v.value<>'[]'::jsonb";
        else if (["eq", "neq"].includes(f.op)) {
          validateFieldValue(field, value);
          comparison = `v.value ${f.op === "eq" ? "=" : "<>"} ${param(JSON.stringify(value))}::jsonb`;
        } else if (f.op === "contains" && field.type === "multiselect") {
          validateFieldValue(field, [value]);
          comparison = `v.value @> ${param(JSON.stringify([value]))}::jsonb`;
        } else if (
          f.op === "contains" &&
          ["text", "multiline"].includes(field.type)
        ) {
          if (typeof value !== "string") fail("Text filter requires text");
          comparison = `strpos(lower(v.value#>>'{}'),lower(${param(value)}))>0`;
        } else if (
          ["gte", "lte", "before", "after"].includes(f.op) &&
          ["number", "date"].includes(field.type)
        ) {
          validateFieldValue(field, value);
          const op = ({ gte: ">=", lte: "<=", before: "<", after: ">" } as Row)[
            f.op
          ];
          comparison = `(v.value#>>'{}')::${field.type === "number" ? "numeric" : "date"} ${op} ${param(value)}::${field.type === "number" ? "numeric" : "date"}`;
        } else fail("That operator is not supported for this custom field");
        clauses.push(
          `EXISTS(SELECT 1 FROM ticket_field_values v WHERE ${prefix} AND ${comparison})`,
        );
        continue;
      }
      if (!expr) fail("Unknown saved-view filter");
      if (f.op === "is_set") {
        clauses.push(`${expr} IS NOT NULL`);
        continue;
      }
      if (["created", "updated"].includes(f.field)) {
        if (
          !["before", "after"].includes(f.op) ||
          typeof value !== "string" ||
          !Number.isFinite(Date.parse(value))
        )
          fail("Dates need a valid before/after date");
        clauses.push(
          `${expr} ${f.op === "before" ? "<" : ">="} ${param(value)}::timestamptz`,
        );
        continue;
      }
      if (!["eq", "neq", "in"].includes(f.op))
        fail("Choose equals, not equals, or in for this filter");
      const list = Array.isArray(value) ? value : [value];
      if (list.some((v: any) => typeof v !== "string"))
        fail("Filter values must be text");
      const choices: Row = {
        status: ["open", "resolved", "needs_staff", "waiting_approval"],
        priority: ["low", "normal", "high", "urgent"],
        channel: ["portal", "widget", "zendesk", "email"],
      };
      if (
        choices[f.field] &&
        list.some((v: any) => !choices[f.field].includes(v))
      )
        fail("Unknown filter option");
      clauses.push(
        f.op === "in"
          ? `${expr}=ANY(${param(list)}::text[])`
          : `${expr} ${f.op === "neq" ? "IS DISTINCT FROM" : "="} ${param(value)}`,
      );
    }
    for (const column of d.columns) {
      if (
        [
          "subject",
          "customer",
          "status",
          "priority",
          "assignee",
          "team",
          "channel",
          "tags",
          "form",
          "created",
          "updated",
          "sla",
        ].includes(column)
      )
        continue;
      const field = column.startsWith("field.")
        ? fields.find((f) => f.id === column.slice(6))
        : null;
      if (!field || field.archived || !this.readable(p, field))
        throw new HttpError(
          409,
          "A view column uses an archived or inaccessible field",
        );
    }
    return clauses;
  }
  async viewResults(p: Principal, id: string, raw: unknown): Promise<Row> {
    p = await this.fresh(p);
    requireCapability(p, "tickets:read");
    const { page, q: search } = ViewQuery.parse(raw);
    let d: Row = defaults.find((v) => v.id === id)!;
    if (!d) {
      const row = requireValue(
        await this.db.one(
          "SELECT * FROM inbox_views WHERE workspace_id=$1 AND id=$2",
          [p.workspaceId, id],
        ),
      );
      if (row.definition.archived || !this.canReadShared(p, row))
        throw new HttpError(404, "View is unavailable");
      d = definition(row);
    }
    const args: unknown[] = [p.workspaceId],
      visibility = conversationVisibility(p, "c", args),
      clauses = await this.compileView(p, d, args);
    if (search) {
      args.push(search);
      clauses.push(
        `strpos(lower(c.subject||' '||ct.name||' '||coalesce(ct.email,'')),lower($${args.length}))>0`,
      );
    }
    const where = `c.workspace_id=$1 AND (${visibility})${clauses.length ? ` AND ${clauses.join(" AND ")}` : ""}`;
    const order: Row = {
      updated_desc: "updated_at DESC,id DESC",
      created_desc: "created_at DESC,id DESC",
      created_asc: "created_at,id",
      priority_desc:
        "CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,created_at,id",
      sla_asc: "sla_due ASC NULLS LAST,created_at,id",
    };
    args.push(40, (page - 1) * 40);
    const result = requireValue(
      await this.db.one(
        `WITH filtered AS (SELECT c.id,c.contact_id,c.subject,c.status,c.mode,c.priority,c.tags,c.team_id,c.assigned_to,c.form_id,c.created_at,c.updated_at,tm.name team_name,u.name assignee_name,tf.definition->>'name' form_name,ct.name customer_name,ct.email customer_email,ch.kind channel_kind,
+      (SELECT min(o.due_at) FROM sla_obligations o WHERE o.workspace_id=c.workspace_id AND o.conversation_id=c.id AND o.ended_at IS NULL AND o.state<>'paused') sla_due,
+      (SELECT left(body,240) FROM messages m WHERE m.workspace_id=c.workspace_id AND m.conversation_id=c.id AND m.role IN ('customer','staff','assistant') ORDER BY m.created_at DESC,m.id DESC LIMIT 1) last_message
+      FROM conversations c JOIN contacts ct ON ct.workspace_id=c.workspace_id AND ct.id=c.contact_id LEFT JOIN channels ch ON ch.workspace_id=c.workspace_id AND ch.id=c.channel_id LEFT JOIN teams tm ON tm.workspace_id=c.workspace_id AND tm.id=c.team_id LEFT JOIN "user" u ON u.id=c.assigned_to LEFT JOIN ticket_forms tf ON tf.workspace_id=c.workspace_id AND tf.id=c.form_id WHERE ${where}), page AS (SELECT * FROM filtered ORDER BY ${order[d.sort]} LIMIT $${args.length - 1} OFFSET $${args.length}) SELECT (SELECT count(*)::int FROM filtered) total,coalesce((SELECT jsonb_agg(p) FROM page p),'[]') conversations`.replaceAll(
          "\n+",
          "\n",
        ),
        args,
      ),
    );
    const ids = result.conversations.map((c: Row) => c.id),
      fieldIds = d.columns
        .filter((v: string) => v.startsWith("field."))
        .map((v: string) => v.slice(6));
    const values =
      ids.length && fieldIds.length
        ? await this.db.rows(
            "SELECT conversation_id,field_id,value FROM ticket_field_values WHERE workspace_id=$1 AND conversation_id=ANY($2::text[]) AND field_id=ANY($3::text[])",
            [p.workspaceId, ids, fieldIds],
          )
        : [];
    for (const row of result.conversations)
      row.fields = Object.fromEntries(
        values
          .filter((v) => v.conversation_id === row.id)
          .map((v) => [v.field_id, v.value]),
      );
    return {
      ...result,
      view: d,
      page,
      pageSize: 40,
      fieldColumns: (await this.fieldRows(p.workspaceId)).filter(
        (f) => fieldIds.includes(f.id) && this.readable(p, f),
      ),
    };
  }
  async workflowFields(ws: string, id: string, q?: Queryable) {
    return this.db.rows(
      "SELECT v.field_id,v.value,v.definition->>'label' label FROM ticket_field_values v JOIN ticket_fields f ON f.workspace_id=v.workspace_id AND f.id=v.field_id WHERE v.workspace_id=$1 AND v.conversation_id=$2 AND f.definition->>'customerVisible'='true' AND f.definition->>'archived'='false' ORDER BY v.field_id LIMIT 50",
      [ws, id],
      q,
    );
  }
}
