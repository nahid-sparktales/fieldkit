# Ticket automations

Automations apply reviewed, deterministic actions to native portal, widget, and email tickets. They never call a model, execute an account action, or change an authoritative external ticket. Rules are inactive until an administrator saves, previews, and explicitly activates a version. Administration requires `automations:manage`, `tickets:read`, and all-workspace ticket scope. The configuring staff member must retain every action capability at execution and delivery time.

## Configure a rule

Open **Automations → New rule**. Give it a clear name and run order, choose its trigger, add **all** and optional **any** conditions, and choose actions. Save the draft, preview current matches, then activate the reviewed saved revision. Preview examines the newest 500 tickets and displays at most 30 matches; it does not enqueue or execute work. Activating a rule affects future observed events. It does not backfill older tickets.

Saving an active rule creates a draft version; the previously activated definition stays active until the new revision is activated. Activation and disabling suppress the rule's pending executions. Run order is a workspace rule setting; lower numbers run first. Conflicting conditions are checked again before each ordered execution. New customer activity or staff ticket changes suppress stale work instead of applying outdated actions.

Triggers: ticket created, customer message, delivered staff reply, staff ticket property change, SLA warning, SLA breach, or time since ticket creation, the latest customer message, latest delivered staff reply, ticket change, or the current waiting-for-customer cycle. Timers use elapsed minutes or a saved business calendar with IANA timezone, weekly shifts, and holidays. Business calendars use the same daylight-saving-aware calculation as SLA deadlines. A timer records its source generation and deadline; later edits do not silently reset that saved deadline. A newly observed source can create a new timer.

Conditions: status, channel (including email), priority, team, assignee, tags, form, organization, current waiting state, SLA state, and active typed custom fields. Organization is the ticket's explicit organization snapshot. Custom free-text fields are not eligible. Private field conditions require `fields:internal:read`; rule definitions and histories depending on private fields are hidden from administrators without that capability. References must belong to the workspace. **All** conditions must match; if **Any** contains conditions, at least one must also match.

Actions: set priority, add/remove tags, move to a team with optional requeue, private note, notification to the current assignee or selected staff, literal public template, or optional resolution. Queue actions use normal routing membership, availability, and capacity rules and never replace a current manual assignee. A requeue explicitly changes the ticket to human mode. Templates are literal reviewed text; variables are rejected. Email notifications recheck recipient visibility and current assignee eligibility before sending.

Automatic resolution requires a waiting-for-customer timer of at least 1,440 minutes and at least 24 elapsed hours of that same waiting cycle. A new public message, pending approval, or prepared/sent/unknown account operation prevents closure. Resolution and a public reply cannot be combined in one rule: send a follow-up first and use a separate later resolution rule.

## Execution and delivery

Rule versions, source snapshots, executions, action results, messages, and transactional queue entries are durable. Workers lock the routing workspace, then the ticket, then execution records. Duplicate events and concurrent jobs share a unique execution identity. All actions in one rule commit together; a failure rolls them back together. Distinct public rules share a unique contact-generation claim, so they cannot send two follow-ups for the same source message. Migrated SLA reminder cycles preserve their explicit reminder generation count.

Automation-origin events and nested events produced in an automation transaction do not trigger additional rules. Background routing-assignment events do not enroll rules, preventing delayed requeue loops; direct staff assignment is observed through the normal ticket-update event. Completion means the native action was committed. It does **not** mean an email reached a customer's inbox. Public messages use the existing ticket-email outbox and delivery recheck; accepted, suppressed, and uncertain outcomes remain transport states. Staff notification SMTP failures with an unknown outcome are marked uncertain and are not automatically resent.

Execution history shows pending, completed, suppressed, and failed records, their reason, rule revision, ticket link, and action results. Public automation messages use role `reminder`; internal automation notes carry `automation_execution_id`; resolution events carry `actorType=automation`. Reporting can distinguish these from staff performance.

## Existing SLA reminders

Migration 27 creates the automation tables and marks adopted waiting cycles with `sla_waits.automation_managed`. Existing enabled reminder policies are represented as **Migrated SLA follow-up** rules when there is an eligible waiting cycle. Their original due time, source reply, policy snapshot, allowed flag, and sent count are retained. The old SLA worker skips managed cycles; shared contact-generation claims also prevent overlap during adoption. Existing reminders remain controlled through SLA policy settings. Disabling or changing their source policy suppresses stale work. No reminders become enabled merely because the migration ran.

New automation rules and old reminders are independent of SLA response-obligation reporting. Public reminders do not count as substantive staff replies or staff resolution.

## API and integration

- `GET /v2/workspaces/:ws/automations`: rules and permitted form options.
- `POST /v2/workspaces/:ws/automations`: save `{id?,revision?,position,definition}`.
- `POST /v2/workspaces/:ws/automations/preview`: read-only definition preview.
- `PUT /v2/workspaces/:ws/automations/:id/activation`: `{revision,enabled,confirm}`.
- `GET /v2/workspaces/:ws/automations/history` and `/:id/history`: recent execution and saved-version history.
- `GET /v2/workspaces/:ws/automations/notifications` and `POST /notifications/:id/read`: the current staff member's visible notifications.

`TicketAutomation.observe(q,event)` enrolls work in the source transaction. `run(workspaceId,executionId)` processes due work in rule order. `sweep()` adopts legacy waits, recovers due executions after downtime, and marks interrupted staff mail uncertain. `migrateLegacy()` runs after migrations and before workers. `emailGuard(q,workspaceId,messageId)` participates in the existing customer email guard. Queue names are `ticket-automation` and `ticket-automation-notify`.

To stop a rule, disable it. Pending work and later email attempts recheck enablement. Keep schema and completed execution history intact; rolling back the UI must not reactivate the legacy SLA sender for already managed waits.

## Verification

`TEST_DATABASE_URL=postgresql://nahid@127.0.0.1:54329/isolated_automation_test npx tsx --test --test-concurrency=1 tests/ticket-automation.test.ts` exercises isolated fixtures and synthetic mail only. The browser helper `tests/browser-automation.ts` verifies save, preview, confirmed activation, disable, draft preservation, and narrow-screen editing. No live provider or production database is used.
