# Everyday help-desk collaboration

This release extends the existing application and PostgreSQL jobs through schema 28. No customer is enrolled, ticket shared, or new general automation enabled by migration. Production migration, mail configuration, real messages, and deployment are operator actions.

## Activation and migration

Back up PostgreSQL, the private attachment store, and the encryption key together. Stop old application/worker processes before applying `npm run migrate`, then start the matching application and worker release. The five additive groups run in this order: 24 customer access/organizations/participants; 25 individual email recipients/routes/manifests; 26 bulk results/merge aliases/presence/edit versions; 27 automation versions/timers/results; 28 dashboards/exports/schedules. Migration is idempotent. Test on a restored disposable database first.

The AI revision counter remains separate from `edit_version` (optimistic ticket edits) and `reply_version` (public message collisions). Clients return `expectedEditVersion` for bulk changes and the displayed reply version as `expectedReplyRevision` when sending a staff reply. A successful request-key replay is checked before the stale-version check and returns the original result. Changing its payload returns a conflict.

Follow the detailed [customer collaboration](customer-collaboration.md), [email delivery](helpdesk-email.md), [automation](ticket-automations.md), and [reporting](reporting.md) documentation. Customer invitations need the existing authenticated portal and SMTP configuration. Binary email attachments additionally require enabled private storage and a healthy scanner.

## Everyday use

In Inbox, select **Select tickets** for up to 40 explicit native portal/email tickets. Selection preserves drafts. Assign/unassign, change team or priority, add/remove tags, resolve or reopen using the compact action bar. Each item commits independently. Partial results identify changed tickets, stale versions, capacity conflicts, unavailable tickets and failures. Retry a transport failure with the same request key; to retry a conflict, refresh, review and submit a new selection. There is no bulk send, deletion, capacity override or “all matching” action.

Advisory presence is per authenticated session and tab: a viewing lease expires after 45 seconds, a typing indicator after eight. No draft text is transmitted or stored by presence. Presence does not assign tickets or grant access. A new public message invalidates an existing reply draft's sending token; the draft remains visible until the agent reviews the new activity. Internal notes do not create public-reply conflicts.

**Activity & tools → People & sharing** manages external Participants, staff following, and company sharing. External mail uses one private message per recipient; participants cannot see other addresses. Followers remain staff-only and must retain ticket access. Customers accept portal invitations explicitly with the verified invited identity. Matching an email address never claims an earlier history.

Customers → Organizations manages verified member/manager memberships. Tickets remain private unless staff explicitly share them. Company managers can read full public history and public files, reply and upload; ordinary company members see their own tickets. Company access never implies email subscription. Portal **My tickets** includes requester tickets and explicitly accepted participant invitations; **Company tickets** includes tickets shared with companies the verified customer manages. Requester-only status, fields and feedback remain requester-only.

## Merging

Owners/admins with all-ticket access can preview one source into one target under Activity & tools. Both must be native tickets with the same requester, channel, email intake address, organization/sharing state and approved participants. A source already containing merged children cannot be merged again; one target supports up to ten source aliases. Queued, failed, sending or uncertain mail and unresolved business operations block merge; finish or reconcile those deliveries first.

The confirmed merge preserves target fields, ownership, priority and status. Both tickets switch to human handling, pending approvals become stale, and source timers are canceled. Source records, messages, original attachment locations, timestamps, fields, audit records and SLA evidence remain retained. Combined history labels source provenance and checks each source's original access cutoff. A participant added later does not gain earlier source history.

Old authorized URLs and reply routes resolve to the target. Original message IDs and receipts still deduplicate retries. Source aliases cannot be edited as independent tickets. Deleting a canonical ticket deletes its complete retained merge group and queues checkpoint cleanup. There is no unmerge, cross-customer merge, automated merge or Zendesk/widget merge. A merge is not a successful support resolution.

## Default permissions

| Capability | Owner/admin | Agent |
| --- | --- | --- |
| Manage participants on readable tickets | Yes | Yes |
| Follow an already readable ticket | Yes | Yes |
| Organization and membership administration/sharing | Yes | No |
| Merge, with all-ticket/internal-history access | Yes | No |
| Bulk mutation | Underlying action permission | Underlying action permission |
| Configure/activate automation | Yes, all-ticket access | No |
| View personal dashboards | Existing analytics permission, all-ticket access | Existing analytics permission, all-ticket access |
| Shared dashboards, schedules, CSV export | Yes | No |

Custom roles can narrow these permissions. Company membership, following, and shared dashboard definitions never broaden staff ticket visibility. All customer views, downloads and streams revalidate the current grant. A non-requester customer reply forces human handling; account actions cannot use the requester's identity for that collaborator's request, even after a staff member reactivates the agent.

## Delivery and disabling

Database transactions atomically snapshot recipients and notification jobs with their source messages. Workers recheck current grants, visibility, authority, file state and message eligibility before claiming transport. Newly added participants do not receive older queued messages. Removed participants lose queued delivery and portal access. Successful recipients are never resent by retrying another recipient. SMTP acceptance is not proof of delivery; uncertain attempts require explicit review and may duplicate a copy if an operator retries after provider acceptance. Never automatically retry an uncertain send.

Disable new automation rules in Automations; pending work rechecks activation and authority. Disable report schedules to stop future jobs. Revoke participants/memberships or make shared tickets private to remove that access. Stop the worker to pause background transport globally. Keep the additive tables and records during a disable; a destructive downgrade would lose grants, receipts, timer evidence and aliases. Restore the full pre-upgrade backup only as a separately planned rollback, including private files and key material.

## Verification

Use only dedicated databases ending `_test`, synthetic email and local fixtures. Run strict TypeScript, production build, backend/security/concurrency tests, browser journeys and dependency audit. The existing CI workflow also checks the isolated runner, demo regression, application containers, fresh Compose installation/worker restart, and real scanner clean/EICAR detection after startup and restart. Scanner doubles in backend/browser tests do not replace the live scanner check. See the [verification record](verification.md) for commands and actual results; never infer a hosted CI pass from local test results.
