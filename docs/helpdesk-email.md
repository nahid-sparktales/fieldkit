# Email to ticket

Email intake uses the existing PostgreSQL database, ticket inbox, public reply composer, attachment scanner, SLA events and pg-boss jobs. Migration 20 adds support-address mappings, durable intake receipts and attempt history. It does not send historical mail or enable new-ticket intake for existing installations: migrated legacy addresses start with new intake disabled while existing private reply addresses keep working.

## Setup

In **Publish → Channels → Email support**:

1. Configure the installation's `SMTP_URL`, `SMTP_FROM`, `FIELDKIT_URL` and encryption key as documented in installation setup. Use HTTPS for the public URL.
2. Connect the initial support address and copy the one-time webhook password. In Postmark, route that address to the intended inbound stream and configure the displayed webhook URL with HTTP Basic Auth username `fieldkit` and that password. Basic Auth is the provider-supported mechanism; no invented webhook signature is used. Review the provider's current [inbound webhook](https://postmarkapp.com/developer/webhooks/inbound-webhook) and [webhook protection](https://postmarkapp.com/developer/webhooks/webhooks-overview#protecting-your-webhook) instructions. Reverse-proxy IP restrictions can supplement authentication.
3. Add each additional support address explicitly. Each has a display name, SMTP From identity, optional default team, optional acknowledgement, workflow preference and new-ticket intake switch. The SMTP provider must permit the configured From identity. Every address maps to the workspace's connected Postmark integration; an address cannot map to two workspaces.
4. Leave acknowledgements and workflow execution off until the intended behavior is understood. The default creates a human-support ticket without an LLM dependency. An optional published support workflow uses the existing workflow and action safeguards. A default team sets queue eligibility, never directly selects an agent. Automatic routing remains governed by its own opt-in settings and capacity policy.

These settings do not change DNS, provision a mailbox or prove live delivery. Operator configuration and activation remain separate. This work does not repeat or replace the owner's prior live-provider verification.

Changing webhook credentials revokes private reply addresses and requires updating Postmark. An address with ticket history cannot be renamed; add its replacement as a new address to preserve historical reply links. Disabling **Accept new email tickets** stops new requests for that address while existing private replies continue. Disconnecting inbound email disables intake and revokes reply routes. Existing tickets and their history remain available to authorized staff.

## Admission and identity

The authenticated integration plus the validated envelope `OriginalRecipient` select the workspace and address. No default workspace, sender-domain inference, subject matching or ticket-number guessing is used. The envelope recipient wins when a message mentions multiple aliases in the same workspace; header aliases never select another workspace. A known cross-workspace alias combination is quarantined. Unknown recipients have a recorded quarantine outcome and create no ticket.

A sender address is contact information, not authentication. New email contacts are separate, unverified contacts with no portal user, customer-provider mappings or staff role. An email matching a staff member still creates a customer message. The application does not treat customer-supplied `Authentication-Results` as proof of identity, nor advertise SPF/DKIM verification from those headers. Provider spam markers can conservatively quarantine mail; a missing or negative marker grants no identity authority.

Email-only customers correspond by email. They are not automatically associated with a verified portal account, and outbound mail does not offer a portal link that grants nonexistent access. Secure, explicit claiming/linking of an email-only ticket to a portal identity is a future workflow; it is not inferred from a matching From address. Attachment-only staff replies to an email-only contact require arranging a secure delivery method with that customer; outbound binary attachment forwarding is not added here.

## Threading and content

Public replies and optional new-ticket acknowledgements use the existing SMTP outbox. A high-entropy, encrypted private Reply-To token is bound to the conversation and original participant. It must arrive through the configured integration and correct support address, with the same sender address. It grants permission to append customer correspondence only; it is not a login, download credential or authorization for account actions. Tokens have no time-based expiry. Credential replacement, disconnect or conversation deletion revokes them, including deletion by the ticket-retention policy. Expiry of retained email source alone does not revoke a reply token.

Message-ID, In-Reply-To and References metadata is recorded. Known conflicting references within the workspace are quarantined. Unknown references never resolve outside the workspace. A message with references but no valid private reply address is quarantined rather than attached by subject. New participants, invalid tokens and mismatched senders require review or a new request to the support address. Valid replies reopen a resolved ticket while preserving human takeover; the routing service applies its documented reopening policy.

Provider `MessageID` plus integration/workspace has a database uniqueness guarantee. If absent, a valid RFC Message-ID plus envelope recipient and sender supplies the fallback; messages without either identifier are rejected. Changed content under an existing identifier is rejected. Subject/body equality is never deduplication. Effects are deduplicated across at-least-once processing, not an exactly-once SMTP transport claim.

Text is preferred; nonempty provider-stripped replies are used for the conversation body. HTML-only messages become plain text with executable elements removed, never rendered HTML. **Processing health → Original message text** lets authorized administrators inspect original text omitted during provider quote stripping. This response excludes headers, recipient lists and attachment bytes. Outbound headers reject or remove control characters. Missing subjects become “Email support request.” International display names are supported.

No inbound To/Cc/Bcc address automatically becomes a notification participant. List mail, automatic responses, delivery-status reports, self-generated mail and spam markers are quarantined to prevent loops. Acknowledgements default off and only one is queued for a new accepted ticket; ordinary replies do not generate acknowledgement chains.

## Attachments, forms and routing

Files use the existing attachment limits, private storage, scanner, quotas and download authorization. Email staging is an internal provider-authorized operation bound to the exact email-origin conversation, participant, address and connected integration. This permits scanning for unverified email-only contacts without granting them portal access. Uploaded files remain quarantined until scanning succeeds; scan failures remain inaccessible. An invalid individual file produces a blocked attachment card while valid text survives. Reprocessing does not create another attachment/message/ticket.

Email does not invent required portal field values. The productivity intake hook can select the configured email-default form, preserve its version and report missing required information to staff without rejecting ordinary email. The support address's default team takes precedence over a form fallback. An archived configured team remains identifiable so routing can report ineligibility rather than silently choosing a different team.

## Health and recovery

**Processing health & recovery** shows the latest 30 inbound and 30 outbound records, with up to 200 recent attempt records for each direction. Record links, histories and retry actions respect ticket visibility. Unbound intake requires workspace-wide visibility. Secrets and encrypted source envelopes are excluded from normal settings responses.

Inbound states are queued, processing, retry scheduled, processed, quarantined and failed. Receipt acceptance and enqueueing commit before a provider success response. The initial processing attempt can run immediately; queued jobs and maintenance recover interrupted work. Database leases prevent concurrent claims, expire after five minutes, and deterministic attachment/message keys cover a crash after a message commits. Automatic processing is limited to five attempts with persisted minimum retry delays (5, 10, 20, 40 seconds, then terminal review). The hourly maintenance job requeues eligible work, so those delays are earliest eligibility times rather than a promise of second-level recovery. **Recheck intake** is an explicit permission-controlled action after fixing configuration or storage. It reruns all recipient, participant and attachment checks; it cannot override quarantine rules. Retained source is required.

Outbound **Provider accepted** means SMTP accepted the message. It is not evidence of final delivery. The application records known connection/authentication/envelope failures separately from uncertain transport outcomes. It does not automatically resend an uncertain SMTP attempt. Check the provider, then explicitly retry if appropriate; SMTP duplicates remain possible after an uncertain acknowledgement. Staff messages, workflow runs and customer history are not recreated by a delivery retry.

The existing generic SMTP transport does not expose authenticated Postmark delivery/bounce callbacks for its messages. Delivery and bounce details beyond transport acceptance remain with the configured SMTP provider. The UI documents that boundary instead of fabricating “delivered” or “bounced” states.

## Retention, upgrades and disabling

Full failed/quarantined envelopes are encrypted for recovery. After processing, attachment bytes and headers are removed from the retained envelope; original text remains encrypted for quote review. Workspace retention clears retained source, sender and subject metadata. Receipt identifiers/hashes and attempt metadata remain until their conversation is deleted (unbound operational receipts retain no content after expiry). Conversation deletion cascades its receipt and attempt records. Use the existing encrypted-key rotation command while app/workers are stopped; it also re-encrypts retained intake payloads and reply tokens.

The migration is additive and preserves legacy reply tokens and receipts. Legacy message receipts prevent replay into duplicate correspondence. Disable new intake per address or disconnect the inbound integration for a reversible operational rollback. Do not drop migration tables or restore an older binary while accepted mail is pending: that would abandon receipts and recovery work. Preserve backups before schema changes.

## Local verification

`tests/email-intake.test.ts` uses synthetic envelopes, mocked SMTP/scanner responses, an isolated PostgreSQL database, concurrent delivery and direct HTTP requests. It covers new tickets, multiple addresses, participant isolation, missing subject, HTML/text, references/tokens, source retention, duplicates, provider-id collision, files and scanner failure, retry after message commit, acknowledgement deduplication, lease recovery, denied administration, schema limits and authenticated recipient mapping. Existing `customer-support.test.ts` and `attachments.test.ts` are neighboring regression suites. No test sends real email or calls a live provider.

Local verification on 2026-10-06: all 18 email-intake tests and all 9 shared permission tests passed on an isolated database. The 10 attachment and 6 customer-support regression tests also passed. The email suite includes live-authority rechecking during a concurrent membership revocation; sensitive email mutations hold the membership row until the transaction commits. The TypeScript check passed. These are local fixtures, not evidence of delivery through a production SMTP or Postmark account.
