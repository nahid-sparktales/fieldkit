# UI/UX audit — October 2, 2026

This pass reviewed the staff workspace and customer portal, with closer interaction checks on setup, knowledge, connections, inbox, workflow editing, Test Lab, and analytics. The goal was to make existing features easier to find and use while retaining FieldKit’s green visual identity.

## Findings and changes

| Finding | Change |
| --- | --- |
| Twelve navigation items had no grouping; browser Back did not follow section changes. | Grouped sections into Support, Agent, and Workspace. Added active-page semantics, page titles, history navigation, and a skip-to-content link. |
| The mobile menu lacked a close button, Escape handling, and focus containment. Hidden navigation remained keyboard reachable. | Added a dismissible overlay, close button, focus trap and restoration, background isolation, and an independently scrollable menu. |
| Functional text was often 8–11px with pale foregrounds. | Increased functional text to at least 12px, strengthened muted colors, aligned page headings, and enlarged mobile targets. Decorative brand/group labels remain smaller. |
| Setup used a large marketing illustration and put its checklist below the preview form. Optional account actions appeared mandatory. | Replaced the illustration with an actionable next step and three-essential progress indicator. Placed the checklist beside the preview. Customer-approved knowledge is required for readiness; account actions are marked optional. |
| The inbox lacked search and filtering. Switching conversations could briefly show the previous transcript. | Added name/subject search, status filters, and useful empty states. Scoped fetched data to its current resource keys so old transcripts are hidden immediately on selection changes. |
| Knowledge opened on an import form and did not help users find existing sources. | Made connection import a disclosure, added source search/audience filters, upload feedback, and readable mobile source cards. Customer approval and public publication remain separate controls. |
| Article previews were visually modal but did not contain keyboard focus. | Replaced the open-only dialog with a native modal dialog, accessible title, Escape close, and focus restoration. |
| Provider setup required scrolling past every provider card. | Added provider search and placed configuration beside the selector; bounded the selector’s scroll area and hid disconnect controls for unconnected providers. |
| Advanced FAQ generation crowded manual authoring. | Made whole-library AI generation expandable while keeping job progress visible. |
| New measurement screens had inconsistent headings, blank sections, and technical date errors. | Standardized their typography, added Test Lab onboarding and loading/empty states, moved gap evidence ahead of analysis settings, and added readable date validation and filter reset in Analytics. |

## Verification scope

The browser regression covers onboarding, document import and approval, modal Escape/focus restoration, search/filter recovery, browser Back, FAQ generation, workflow and reusable-step editing, portal replies, human takeover, Test Lab, analytics date validation, and the mobile menu’s keyboard loop. Provider/model calls use the existing test doubles.

Manual review uses the local installation at desktop and 390px mobile widths. This is a targeted usability and accessibility pass, not a claim of complete WCAG conformance or a study with external users. No new UI runtime dependency or backend migration is introduced.

Final checks passed: strict TypeScript including unused bindings, the production build, and the expanded end-to-end browser journey (including mobile sign-out releasing the navigation scroll lock). Backend behavior was exercised through that journey with dedicated test data and provider doubles; live customer accounts and paid model calls were not used for test execution.

## Customer correspondence follow-up — October 4, 2026

The portal reused the widget's chat composer, showed feedback on open conversations, and had no ticket email path. This pass separates ticket submission/history from live chat, makes waiting and closed states explicit, adds deliberate replies/reopening, and limits feedback both in the UI and on the server. It adds per-channel workflows, durable SMTP notification jobs, authenticated Postmark inbound replies, email recovery views, and a captured-email sandbox round trip. See [customer support](customer-support.md) for installation and verification boundaries; unlike the earlier visual-only pass, this includes an additive database migration.

Other findings addressed: ticket retries retain their text and request key; drafts warn before leaving; new sections return to the top; public reads hide undelivered replies; widget sessions bind to the published chat channel; staff browsing the portal cannot accidentally view all customers as their own history; stale turns after workflow publication move to staff review; closed chats use an explicit continue action; mobile chat inputs fill the available width. Labels accompany every status color. Existing branding, keyboard controls, and reduced-motion behavior are retained.

The local verification uses test fixtures, real PostgreSQL/LangGraph execution, captured email, and local Mailpit SMTP. No paid model calls, external customer email, or real business actions are used. A real Postmark mailbox flow remains an external release gate.
