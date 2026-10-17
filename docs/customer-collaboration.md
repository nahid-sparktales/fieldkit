# Customer organizations, participants and email attachments

Migrations 24–25 add customer organizations, explicit ticket participants, internal followers and recipient-specific delivery. Existing tickets remain private. No address, domain, To/Cc header or organization membership silently claims an existing customer identity or adds notification recipients.

## People and sharing

Staff with `tickets:participants` can use **Inbox → Activity & tools → People & sharing** to approve up to 20 external participants. Each receives future public correspondence as an individual email copy with a recipient-bound private reply address. There is no visible To/Cc group or conventional Reply-All behavior. Incoming Cc addresses are untrusted review suggestions; staff must explicitly approve them. New participants cannot see older messages, files, fields, feedback or event contents in the portal. The ticket subject remains visible context. Removing a participant revokes portal access, future email replies and unsent notifications. Already transmitted emails and files cannot be recalled.

Adding an email participant creates or reuses a separate unverified email identity; it does not merge their account, requester identity or provider mappings. A durable invitation lets the recipient sign in to a verified customer account with that exact email and explicitly accept portal access. Invitations expire after seven days and are revoked when the participant is removed. An invitation is not an account-action credential. Unknown senders, forwarded private addresses, reference headers and unapproved copied addresses cannot append to a ticket.

Staff may follow a ticket without changing its assignment or access. Followers receive only future notifications while their current role and ticket scope still permit access. Internal-note notifications require explicit opt-in plus current note permission. External participants never receive private notes. Public-message authors do not receive an echo copy. Company membership alone never subscribes every employee to email.

## Organizations

**Customers → Organizations** is available to staff with `organizations:manage` and full ticket scope. Create an organization and invite members or managers. Membership requires the same verified sign-in and explicit invitation acceptance; matching an email domain is insufficient. Members see their own tickets. Managers can read and reply to the entire public history and files of tickets that staff explicitly share with that company.

Ticket organization is an explicit assignment, not a live inference from a contact's memberships. Sharing an existing ticket requires confirming the historical disclosure. Private tickets remain private. Managers cannot close another requester's ticket, edit its intake fields, submit requester feedback or authorize requester account actions. Removing a membership or archiving its organization immediately removes company access. Restoring an organization restores the access of its still-active memberships; the UI confirms this. Customer organizations never grant staff permissions and do not broaden a staff member's team/assigned-ticket scope. Organization hierarchy and automatic domain enrollment are not implemented.

The primary requester remains unchanged. Collaborator messages are attributed to their actual contact and send the conversation to human support. Even if staff reenable the agent, a latest customer message from a non-requester cannot use the requester's verified account mappings. Existing automation is invalidated when participants or sharing change.

## Outbound files and recovery

Public ticket replies can include their exact attached files through SMTP. Files remain in private storage and must pass the existing scanner. Delivery waits while scanning is pending; blocked, missing, changed or expired files cause a visible failure without sending a partial message. Waiting deliveries are revisited by the minute recovery sweep and require review after 24 hours. Limits include the existing file/count/decoded-message limits and a 25 MiB encoded SMTP envelope budget. Email delivery never uses arbitrary file paths or remote URLs. Files remain unavailable to AI processing.

The audience and file identities are recorded with the message. Participants added later do not receive old queued messages. Each recipient has independent attempts, stable Message-ID, reply token and delivery state. Before claiming a delivery, current recipient and attachment authority are rechecked. A revocation cancels work not yet claimed; it cannot recall an email already handed to transport. Delivery claims and merges use the same workspace/ticket lock order.

**Publish → Email support → Processing health & recovery** shows per-recipient outcomes. SMTP acceptance is not proof of final inbox delivery. Known failures can be retried; uncertain outcomes require checking the mail provider first. Retrying an envelope retries only failed or uncertain recipients, never copies already accepted. Invitation delivery has the same uncertain-outcome boundary and explicit retry controls. No automatic uncertain resend is performed.

## Upgrade and retention

Migrations are additive and repeatable. Legacy requester reply tokens retain their encryption context and keep working. Existing terminal emails are never resent. Pending legacy mail gets only its original requester audience; it does not gain newly added participants. An interrupted legacy SMTP attempt becomes uncertain and requires manual review.

Reply-route primary keys now identify an individual route instead of a conversation. `scripts/rotate-encryption-key.ts` re-encrypts each route independently and also covers invitation tokens; stop app and workers as that command requires. Existing ticket retention cascades participants, routes, invitations tied to tickets and delivery records. Invitation token ciphertext is cleared on expiry, acceptance or revocation. Organization membership and organization invitations are administrative records until explicitly revoked or the workspace is removed.

## Verification

`tests/collaboration.test.ts` covers organization and participant boundaries, explicit invitation verification, future-only public history, private files, concurrent per-recipient workers, partial failure and uncertain SMTP recovery, revocation, actor attribution and human handoff, scanner-gated binary delivery, staff follower permissions, CC suggestions and invitation idempotence. The adjacent email-intake, attachment, customer-support and customer suites preserve legacy behavior. Fixtures use an isolated PostgreSQL database, local scanner doubles and mock mail transport; they do not send external mail.
