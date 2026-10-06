# Fields, request forms, macros, and inbox views

Staff use **Productivity** to manage ticket fields, customer request forms, reusable macros, and saved inbox views. This extends the existing portal, ticket detail, reply composer, and inbox. No external service is required.

## Storage and migration

Migration 21 (`packages/platform/src/productivity-schema.ts`) follows the centralized permissions/team foundation in migration 19. It adds workspace-scoped field and form definitions with immutable version snapshots, per-ticket field values, macro and view definitions, intake retry records, and committed macro records. It does not rewrite existing tickets or create a copy of the inbox. Definitions are archived rather than deleted. Stable field and option IDs are independent of their displayed labels.

## Ticket fields

The supported types are text, multiline text, number, boolean, date, single select, and multi-select. Labels, help text, ordering, text limits, numeric bounds, and active options are validated. Dates must be real calendar dates in `YYYY-MM-DD` format. Field types cannot change after creation; create a new field for a different type. Existing option IDs cannot be removed: archive an option instead. Historical values retain the definition and option labels used when saved.

`fields:manage` permits administration. `tickets:update` permits staff value edits; internal fields additionally require `fields:internal:read` and `fields:internal:write`. Customer editability requires customer visibility. Customers only see public values on their own tickets and may edit fields offered by that ticket's form. Changes to current visibility immediately restrict reads, even if an old snapshot was public. Internal values do not appear in portal responses or workflow field context.

## Request forms

Create a named form, add customer-editable fields, set their order, preview it, and activate it for the existing portal. Subject and message remain present. General support keeps the original lightweight flow, and the widget remains compatible. A submission records its form ID and version. A changed field definition marks dependent forms **Review field changes**; review and save a new form version before accepting new portal submissions through that form. Historical submissions still render their saved versions.

Conditions are declarative: `eq`, `neq`, `in`, `contains`, and `is_set`. All listed conditions must match. Conditions may refer only to fields in the same form. References, field types, values, cycles, and dependency depth are checked; maximum depth is eight, with at most eight conditions per field and fifty fields per form. Hidden dependencies cannot activate their dependents. The same evaluator drives preview and server validation. New hidden values are rejected, while unrelated edits preserve historical values. Required checks apply to visible fields; newly required unrelated fields do not make old tickets unusable.

An active form can be the default email intake form. Email intake stores its schema and identifies missing required information for staff without rejecting ordinary email or inventing answers. A configured active default team is passed to the shared human-routing service. Portal-only field requirements never become a prerequisite for email delivery or the embedded widget.

## Macros

Personal macros belong to their creator. Team macros are visible to current team members; workspace macros are shared. `macros:personal` and `macros:shared` govern management. Shared definitions do not grant ticket access or field permissions. Editable examples provide starting text for requesting information, billing follow-up, and technical escalation; they contain no invented company policy.

The composer picker searches permitted macros and displays an editable draft plus proposed changes. **Use this draft** stages the result; **Send reply** or **Save internal note** explicitly commits it. Staff can remove proposed changes and edit the text before sending. Supported changes are priority, tags, open/resolved status, team, assignee, and permitted custom fields. Assignment uses the same manual-routing checks as the ticket controls. Macros never execute governed business actions.

Allowed placeholders are `{{customer.name}}`, `{{customer.email}}`, `{{ticket.id}}`, `{{ticket.subject}}`, `{{ticket.priority}}`, and `{{field.FIELD_ID}}`. Missing values are marked in preview. Unknown placeholders and template expressions are rejected. Public-reply templates cannot interpolate internal fields; private-note templates still require current internal-field permission. Output is rendered as text.

The normal message transaction rechecks the current member, ticket visibility, macro revision and sharing, every proposed change, field definition, and assignment target. It commits the message, changes, audit event, retry record, and normal delivery outbox together. A denied change rolls back the response too. A retry with the same request key and same proposal returns the original effect; changing the proposal under that key is rejected.

## Saved views

Personal, team, and workspace views store a validated query and column selection. Defaults are Unassigned, My Active Tickets, Team Queue, and SLA At Risk; they are evaluated for the current viewer without creating duplicate database records. Fields include status, priority, assignee, team, channel, tags, form, dates, actual existing SLA obligations, and supported custom fields. Operators are validated for the selected field. Archived fields or options invalidate a dependent query with an actionable error rather than silently broadening it.

Queries use bound parameters, at most twelve filters and twelve columns, forty tickets per page, and at most 250 pages. Subject remains visible. Built-in sorts use fixed SQL expressions. Field lookup indexes cover workspace/field and JSON values. Counts and rows use the same current ticket-visibility predicate. Internal field columns and filters require read permission; a shared view never expands that permission. There is no new export surface or second SLA clock.

## Verification

`tests/productivity.test.ts` covers the seven value types, conditional dependencies, historical schemas, legacy and email intake, request retry identity, customer/internal-field isolation, macro preview/atomic commit/retry/rollback, current sharing permissions, and saved-view filters/counts/pagination. `tests/browser/productivity-journey.ts` exercises administration, portal submission, macro review and explicit send, saved-view results, and a narrow viewport against local disposable fixtures. These checks do not send real email or call live model providers.
