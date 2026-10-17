# Dashboards and reports

Open **Analytics → Dashboards** to start with the support overview or create a personal dashboard. Workspace dashboards are visible to staff who currently have Analytics permission and access to all tickets. Staff with team-only or assigned-ticket scope cannot query, receive or download workspace reports. Only staff with **reports:manage** can save shared dashboards or configure schedules; **reports:export** is required for CSV exports. Owners and administrators receive these permissions by default.

## Design a dashboard

Dashboards support up to 24 metric cards, line charts, bar charts, stacked bar charts, donut charts and tables. Choose a metric from the catalog and the allowed grouping dimensions. Rates and response times use cards, lines, bars or tables: adding them together as donut segments or stacked bars would misrepresent their denominators.

In edit mode, drag a widget handle to move it and drag its corner to resize. Focus the handle and use arrow keys to move, or Shift + arrow keys to resize. The corner also supports arrow keys. Widgets stack in layout order on small screens. Charts have exact-value tables and keyboard-accessible record links. Save explicitly to keep layout changes; Discard restores the saved definition. Concurrent saves are rejected instead of overwriting someone else's work. Duplicate creates a personal copy.

Global filters include date range, comparison, channel, ticket organization, team, assigned agent, status, priority, tags and subject/ticket search. Date windows use UTC, with an exclusive upper bound; the UI's “Through” date includes that calendar day. Relative periods move when the report is run. Custom dates stay fixed. The maximum window is 366 days.

Widget **additional filters** intersect channel, organization, team, agent, status and priority with the dashboard filters. They can narrow the selection but cannot broaden it. **Overrides** deliberately replace individual dashboard filter settings and are labeled on the widget. Organization reporting requires current customer-read permission. Internal notes, message bodies, internal field values and customer email addresses are not included in reporting datasets or exported record columns.

## Definitions and limits

- Conversation outcomes use tickets created in the selected window and their retained history through the query time. Merged source tickets are excluded from volume and current-work counts. Automated resolution events are separate from staff resolutions.
- First response measures the first delivered AI/staff reply after a customer message. A queued reply, reminder or internal note does not count. Missing times remain unknown. Resolution time uses the first explicit resolution event; missing historical transitions remain unknown.
- Confirmed resolution requires current native customer confirmation after an AI reply; later customer messages or negative feedback invalidate it. AI-only resolution excludes staff replies, handoffs and unknown delivery/history. Silence and a resolved status do not imply customer confirmation.
- Current backlog and human workload are current snapshots. Date range and previous-period comparison do not apply. Organization/team/agent dimensions use current ticket assignment, not reconstructed historical ownership.
- SLA metrics use obligations started in the selected window. Satisfied or breached obligations form the met-rate denominator. Running, paused and canceled obligations are excluded. An obligation that breached before later satisfaction remains breached.
- Follow-ups are reminder messages, separate from staff performance. Delivered native reminders and failed/unknown email deliveries are separate metrics. Unknown SMTP outcome is not treated as successful delivery or automatically resent.
- CSAT uses the latest response per ticket and source submitted in the window. Good ratings are divided by good, bad and neutral rated responses; unrated responses are excluded. Native, modern Zendesk and legacy Zendesk sources can be grouped separately.
- Usage measures calls in the selected window. Reported input/output tokens and unresolved reservations remain separate. Unattributed usage is included only without ticket filters; channel/organization/team/agent filters exclude it. No monetary estimate is inferred.

Every widget, drill-down, CSV and scheduled snapshot uses the same validated query service. Comparison uses the immediately preceding window of equal duration. Charts return at most 100 groups and label truncation while their totals still cover all matching records. Drill-down uses stable server pagination, including records beyond the previous 200-ticket analytics limit. Legacy Analytics also searches and paginates the complete cohort.

Reports are computed from retained data; a live drill-down may reflect later status/ownership changes, deletions or retention since a saved snapshot. Each result records its calculation time and explicit window. Refresh for current values.

## Exports

Request a CSV of the chart summary or contributing records, with an explicit limit from 1 to 50,000 rows. Work runs asynchronously through the existing PostgreSQL worker. Partial exports are labeled truncated. Record exports contain ticket metadata and numeric contributions, not transcripts. Summary exports preserve numerator, denominator, eligible and unknown counts.

CSV text is quoted and spreadsheet formula prefixes are neutralized. Artifacts are encrypted in PostgreSQL, unavailable as public files, and expire 24 hours after request. Current permissions are checked before generation and again on download, including customer-read access for artifacts containing organization information. A lost or expired permission cannot be bypassed with an old link. Repeated request keys return the same job; changed payloads with the same key are rejected.

Deleting a ticket revokes existing exports and snapshots across its workspace, including generation already in progress. Aggregate artifacts can contain a ticket without identifying it individually, so this invalidation is deliberately conservative. Dashboard definitions and schedules remain available. Affected links explain that source data was removed and ask staff to run a new report.

## Scheduled delivery

Save a workspace dashboard, then choose daily or weekly delivery, local time, IANA time zone and up to 20 eligible current staff recipients. Daylight-saving changes are handled in the selected zone; metric windows remain UTC. Each recipient gets a separate authenticated snapshot link. Email contains no ticket data or file attachment. The creator's management access and every recipient's current reporting access are checked at execution and opening.

The scheduler records due slots durably and never creates duplicate reports for the same recipient and slot. After downtime it catches up once and moves to the next future slot, avoiding a burst of missed emails. Revoked recipients are skipped visibly. Losing creator access disables the schedule with a reason. Pause stops future scheduled slots. Deleting a dashboard or schedule also removes its dependent snapshot links.

Mail claims are durable before SMTP. Interrupted or failed sends are marked uncertain and are not silently resent; the authenticated report remains in **Reports & exports** until expiry. Future scheduled slots are independent.

## Operations and validation

Schema 28 is additive. Run normal migrations, rebuild and restart app/worker together. The existing `reporting` queue generates exports/snapshots and checks schedules each minute; no new service or chart package is required. Key rotation includes `report_jobs.artifact_ciphertext`. Maintenance erases expired artifact content and removes report metadata according to workspace retention.

Focused regression coverage is in `tests/reporting.test.ts`; the browser journey is `tests/browser/reporting-journey.ts`. Tests use disposable databases and an injected mailer. No production migration or live email is required for local validation.
