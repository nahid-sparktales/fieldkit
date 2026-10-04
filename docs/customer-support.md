# Customer tickets, live chat, and email replies

The help center offers two distinct support experiences. **Submit a ticket** requires a verified account and asks for a subject and one message. The customer sees a ticket reference, a chronological correspondence history, and a clear waiting state. Public native-ticket replies from staff or the agent are queued for email in the same PostgreSQL transaction as the message. Internal notes, chat messages, evaluations, previews, and Zendesk-owned tickets do not generate FieldKit reply emails.

**Chat now** opens the live assistant, using the published widget channel. General questions may be anonymous. Enter sends; Shift+Enter adds a line. Chat sessions survive a refresh within the same browser tab, for the existing credential lifetime. Anonymous visitors cannot create portal tickets or read another channel's conversations. Signed-in portal users can return to their own chat history in My tickets. A staff member visiting the customer portal acts only as their own customer identity there.

**Close ticket / End chat** ends the conversation and invalidates in-flight responses and pending approvals. Only a closed conversation with a latest delivered support answer can collect “Did this solve your issue?” feedback. Resolution and optional satisfaction remain separate. A later reply reopens the conversation. Human takeover remains in force until staff explicitly resume the agent. Zendesk-owned tickets remain controlled by Zendesk.

## Independent channel workflows

Choose **Workflow → Channel workflow**:

- Workspace default
- Support tickets & email (`portal`)
- Live chat & embedded widget (`widget`)
- Zendesk (`zendesk`)

Each channel has its own draft, revision, and publication history. Until a channel publishes a version, it uses the published workspace default (or the built-in workflow). New channel drafts start from the published default, not an unsaved default draft. Saving never publishes. Knowledge, actions, policies, customers, and reusable components remain shared. Version IDs are unique within a workspace; each run retains its compiled snapshot. Publication invalidates only affected pending approvals and moves unfinished affected conversations to staff review; it never silently reruns a customer request. Older responses/actions recheck channel authority before delivery or execution.

## Outgoing email

Configure the installation's `SMTP_URL`, `SMTP_FROM`, and public HTTPS `FIELDKIT_URL`. Native portal replies are delivered by the `ticket-email` pg-boss worker. Without inbound configuration, the email contains a link to reply in the portal. Subject, stable Message-ID, and thread headers are retained.

**Publish → Email support → Recent email delivery & recovery** shows delivery state and incoming rejections. The inbox's **Activity & tools → Ticket email** shows the same conversation's delivery issues to staff. “Sent” means SMTP accepted the email, not proof of final inbox delivery; inspect your SMTP provider for bounces. A timeout or worker interruption after sending may have an unknown outcome. FieldKit never automatically resends an uncertain email. An administrator checks the provider and explicitly retries it, acknowledging the duplicate-delivery risk. Deleted/unverified customers and unpublished channels are rechecked before delivery.

## Reply directly by email: Postmark inbound

SMTP alone cannot receive mail. Configure a [Postmark inbound stream](https://postmarkapp.com/developer/webhooks/inbound-webhook) and an inbound address or forwarded domain, then:

1. In **Publish → Email support**, enter the inbound address. Its local part must be 1–20 characters and contain no plus sign.
2. Save and copy the webhook URL, username, and one-time password.
3. Configure the Postmark inbound webhook for that URL with those HTTP Basic Auth credentials. Use HTTPS. At your reverse proxy, allowlist Postmark's current inbound webhook IP ranges where practical. See [Postmark's webhook protection documentation](https://postmarkapp.com/developer/webhooks/webhooks-overview#protecting-your-webhook).
4. Send a dedicated test customer's ticket reply, reply from that mailbox, and confirm exactly one new customer message appears in FieldKit. Test quoting, spam, duplicates, and credential replacement before using real customers.

FieldKit sets a private plus-addressed Reply-To for each customer conversation. It is a high-entropy, encrypted email-delivered capability; protect it like a login link and do not forward it. Only an authenticated provider webhook with the correct workspace/address capability and matching verified sender can append a reply. Subjects or supplied conversation IDs do not establish ownership. This capability is not a substitute for a provider mapping required by account actions. Replacing or disconnecting the inbound configuration revokes previous reply addresses; old portal links continue to work.

Incoming JSON is bounded to 256 KiB. Postmark's `StrippedTextReply` is preferred, with plain text as fallback; HTML is never rendered. Quoted-thread stripping is provider-dependent. Automated messages, spam flagged by the provider, mismatched senders, empty/oversized replies, and messages containing attachments are rejected. Rejections associated with a recognized ticket appear to staff; they do not create customer messages or trigger reply loops. Attachments are currently unsupported: use text-only messages. An invalid address or webhook secret returns 403. A valid but rejected payload is acknowledged with a recorded rejection, preventing pointless provider retries. Message-ID deduplication and a deterministic message request key cover retries and a crash between message and receipt persistence.

Webhook passwords and reply tokens are encrypted using `FIELDKIT_ENCRYPTION_KEY`; key rotation re-encrypts both. Deleting or retaining away a conversation removes its messages, outbound email records, inbound receipts, and reply capability. The migration is additive and never sends historical mail.

**Verification boundary:** automated tests and the local sandbox exercise provider-shaped payloads and captured delivery. A real Postmark account, routed domain, HTTPS endpoint, and dedicated mailbox round trip must pass before claiming this connector is release-verified.

## Local store walkthrough

Run `npm run sandbox`. Open the customer portal, submit a ticket, and wait for the scripted answer. Open the [local store launcher](http://127.0.0.1:4321/) and expand its **Local email outbox** entry. Use **Send local email reply** to exercise the real inbound handler with a simulated provider payload; no email leaves your computer. The reply should appear on the same ticket. Close the ticket to reveal feedback. Try Chat now separately, and customize each channel in Workflow.
