# Staff/admin UI and UX audit

**October 6, 2026 · Navigated Support · 16 sections · desktop and mobile**

Implementation follow-up: [fixes for all 21 findings and regression coverage](backend-ui-ux-fixes-2026-10-06.md). The observations below describe the interface before those fixes.

The interface has a coherent visual foundation, but several workflows do not reliably preserve the user's work or show the state of the selected record. Those issues should be fixed before another broad visual redesign. The recurring layout problem is that management lists, creation forms, advanced configuration and execution controls compete on the same page.

The recommended direction is a calm support workspace: show the current work first, open one focused editor at a time, preserve context when moving between views, and make saved, unsaved, loading and failed states explicit.

This audit contains **21 consolidated findings: 14 P2 and 7 P3**. P2 means meaningful task correctness, recovery or efficiency problems; P3 means contextual clarity, consistency or a design improvement. This is a prioritization scheme, not a vulnerability rating. No critical production incident or persisted data corruption was established.

## Scope and evidence

Applied the requested Dashboard SaaS UI skill (`uiuxdesigner:dashboard-saas-ui`) and UI UX Designer skill (`uiuxdesigner:ui-ux-designer`). Reviewed the staff/admin application, plus sign-in and password-reset screens. Customer portal design and backend API architecture were outside scope. 21st.dev was not needed to diagnose the existing workflows.

- Browser review at **1440 × 1000** and **390 × 844**; primary owner role, with targeted agent-role permission checks.
- Exercised navigation, filters, disclosures, record selection, keyboard behavior, local unsaved edits and simulated read failures; compared behavior with source.
- Used synthetic local fixtures. An existing sandbox supplied history volume; a separate current-source disposable fixture supplied working SLA, Shadow and Readiness states.
- The older process lacked some current endpoints. Those missing endpoints are **not reported as production defects**. Findings about failure presentation concern frontend behavior after a request fails.
- No invites, saved configuration changes, credential rotations, outbound messages, business actions, model runs, deployment, publishing or access revocation were performed as part of this audit.
- This is an expert heuristic and interaction audit, not a user study, screen-reader certification or complete WCAG conformance assessment. Mutation success, large datasets in every section, live providers and all role combinations remain untested.

Sixteen representative screenshots are preserved in [the evidence folder](assets/backend-ui-ux-audit-2026-10-06). Additional captures, measurements and reproduction records remain in the ignored local audit folder (`.fieldkit/ui-ux-audit-2026-10-06`, local-only). Measurements describe the tested fixture and viewport, not every production session. Some full-page captures place the fixed sandbox banner at the capture's scroll position.

## Fix order

| Order | Work | Why it comes first |
| --- | --- | --- |
| 1 | Correct selected-record state in Actions and Test Lab (F01–02) | Editors currently show values from a different record or case. |
| 2 | Preserve drafts and make the tested revision explicit (F03–04) | Users can lose work or believe an unsaved change was tested. |
| 3 | Fix direct-load Publish styling and truthful request states (F05–06) | Core choices render incorrectly; failures imply empty or disconnected data. |
| 4 | Make mobile selection reveal its detail immediately (F07) | Several primary actions appear to do nothing. |
| 5 | Complete key-rotation and member-removal flows (F08–09) | Consequential administrative tasks need a clear, deliberate path. |
| 6 | Restructure Activity, Test Lab, FAQs and mobile Workflow (F10–13) | Long forms and lists obscure the user's main task. |
| 7 | Preserve analytics context, then refine information hierarchy (F14–21) | Improve investigation, ownership, status and everyday clarity. |

## Coverage by section

| Section | Reviewed | Assessment and findings |
| --- | --- | --- |
| Inbox | Queue, search/filter disclosure, selected conversation, management controls, notes, mobile list/detail | Recent split layout improves focus. Preserve it; show ownership without opening management (F17). |
| Needs attention | Deadlines, filters, notifications, policy calendar/rules/follow-up, error state | Useful policy draft/version behavior; failed loading and selected-section styling need work (F05, F20). |
| Customers | Search/filter/list, profile, history, notes, mobile return | Profile context is useful; note draft survives sibling tabs. Restore focus on mobile return (F18). |
| Knowledge | Sources/import choices, article preview, FAQs/manual and generated drafts, gaps and evidence | Good audience distinctions and gap review; draft loss, false empty states and FAQ hierarchy need work (F03, F05, F12). |
| Analytics | Date/channel filters, metrics, definitions, drill-down, invalid range and failed read | Clear denominators; return context and investigation hierarchy need work (F14–15). |
| Workflow | Graph, guided steps, inspector, expand/Escape, keyboard move/Undo, reusable component editors | Good guided and expanded-editor behavior; component drafts and mobile default need work (F03, F13). |
| Test Lab | Suite/case selection, exact checks, fixtures, comparison/run setup, empty history | Strong fixture explanations; stale assertions, drafts, launch semantics and layout need work (F02–04, F11). |
| Shadow & rollout | Sampling, candidate creation disclosure, live review, completed comparison, failure state | Baseline/candidate distinction is useful; failure must not claim sampling or rollout is off (F05). |
| Actions | Overview, create/edit selection, tool and policy fields, mobile configure | Mixed records, distant editor and policy language need work (F01, F07, F19). |
| Setup | Progress, completed setup, next-step actions, mobile | Checklist is understandable. After completion, shift emphasis toward operating the workspace rather than repeating onboarding. |
| Readiness | Check list, selected evidence/remedy/history; safe, email, model and test-write forms | Risk distinctions are clear; mobile detail transition fails (F07). |
| Connections | Provider search/selection, no matches, configuration, Google setup, simulated failure | Desktop list/detail works; mobile continuation and unavailable status need work (F05, F07). |
| Publish | Channels, support choices, attachment settings, email setup, appearance preview, integration keys | Direct-load styling, appearance draft loss, key rotation and hierarchy need work (F03, F06, F08, F16). |
| Team | Member list/invite UI, owner and agent visibility, direct-route permission behavior | Invitation path is visible; offboarding is missing (F09). No invitation/removal submitted. |
| Settings | Agent, Workspace, profile, password and sessions; agent-role view | Clear labels and account/workspace distinction; drafts and session presentation need work (F03, F21). |
| Activity | Failed jobs, delivery work, audit history/details at fixture volume | Investigation requires excessive scrolling; filters and section navigation are missing (F10). |
| Shared shell/auth | Desktop/mobile navigation, menu Escape/focus return, sign-in/reset forms | Menu behavior and form labels are sound in sampled states; navigation should become more task-oriented as the product grows. |

## Findings

### F01 · P2 · Actions mixes fields from different selected records

**Observed:** Configure `cancel_subscription`, then configure `refund_payment` without closing the editor. Tool changes to “Stripe: refund a payment,” while name and description still describe cancellation. The save handler targets the newly selected ID while reading the retained form fields. No save was made; persisted corruption is not claimed.

**Evidence:** [Mixed-record editor](assets/backend-ui-ux-audit-2026-10-06/actions-mixed-record.png); [selection and form](../apps/web/src/main.tsx#L3692), [save target](../apps/web/src/main.tsx#L3774). The unkeyed form retains uncontrolled `defaultValue` fields.

**Fix:** Give the selected record one controlled draft, or reset/remount all fields by record identity after protecting dirty work. Include the action's name in the editor heading.

**Acceptance:** A→B, edit→create and create→edit show the correct complete record. Saving B cannot contain untouched A values. Dirty switching offers an explicit retain/discard decision.

### F02 · P2 · Test Lab shows stale exact action parameters after changing cases

**Observed:** Expand exact checks, then change from the first case to “Partial refund requires approval.” The message, action and approval requirement change, but exact parameters remain `{}`. The seeded refund case contains `chargeId`, `amountMinor: 2000` and `currency: "usd"`.

**Evidence:** [Stale parameters](assets/backend-ui-ux-audit-2026-10-06/test-lab-stale-parameters.png); [JsonEditor](../apps/web/src/TestLabPage.tsx#L721) initializes text once from props; [fixture expectation](../scripts/store-sandbox/seed.ts#L247). No assertions were saved or executed.

**Fix:** Scope the JSON draft to suite/case/turn identity, including invalid text and validation state.

**Acceptance:** Switching cases immediately displays each case's actual parameters; text and validation errors cannot leak between cases.

### F03 · P2 · Ordinary navigation silently discards drafts across five areas

| Surface | Reproduced loss | Source |
| --- | --- | --- |
| Knowledge FAQs | Type question/answer → Sources → FAQs: fields are blank. | [FAQ draft](../apps/web/src/main.tsx#L2890) |
| Publish Appearance | Change welcome heading → Channels → Appearance: saved value returns. | [Local appearance state](../apps/web/src/AppearanceEditor.tsx#L56) |
| Settings Agent | Edit instructions → Workspace → Agent: edit is gone. | [Conditional sections](../apps/web/src/ProfileSettings.tsx#L359) |
| Test Lab | Edit suite name → select the same suite row: original name returns. | [Unconditional selection reset](../apps/web/src/TestLabPage.tsx#L53) |
| Workflow reusable components | New Python step → enter name → New API step: draft is replaced. | [Component loading/creation](../apps/web/src/WorkflowLibrary.tsx#L166) |

**Impact:** Consulting another section or exploring a type can erase substantial work. Appearance's existing “Unsaved changes” label does not protect tab navigation. FAQ and Appearance losses were also confirmed in the current-source fixture.

**Fix:** Preserve non-secret drafts by workspace and record above the switching surface. Adopt a common saved/unsaved/saving/error indicator and Save/Discard actions. Guard exits that cannot preserve the draft. Do not automatically publish or save to avoid prompting; do not persist passwords or credentials.

**Acceptance:** Each reproduction retains the draft or asks before discarding. Same-record selection is harmless; explicit discard restores saved state; drafts never cross workspace or record boundaries. Reuse the working Workflow/SLA dirty-state patterns.

### F04 · P2 · Test Lab allows a run that excludes visible unsaved edits

**Observed/source-confirmed:** After editing the suite name, Launch remains enabled. The handler submits `suiteId`, not the editor's current draft. Generic advice to save before launching does not identify whether this particular editor is dirty. No run was launched.

**Evidence:** [Run controls](../apps/web/src/TestLabPage.tsx#L497), [run submission](../apps/web/src/TestLabPage.tsx#L615); local `builder-interaction-results.json` records dirty editor and enabled Launch.

**Fix:** Disable launch while dirty with a clear reason, or provide a deliberate “Save and run” flow. Display the exact saved suite revision next to Launch.

**Acceptance:** Users cannot unknowingly launch against a version that omits their visible edits. Save failure prevents launch and preserves the draft.

### F05 · P2 · Failed requests are presented as empty or disconnected data

**Observed:** Simulated initial GET 503s make Knowledge display “0 sources” and first-source onboarding, and Connections label existing providers “Not Connected.” Failed SLA/Shadow reads show an error alongside indefinite loading; Shadow also claims there are no candidates and sampling/rollout is off. Separately, a failed source import still says “Discovering pages…”.

**Evidence:** [Simulated connection error](assets/backend-ui-ux-audit-2026-10-06/connections-simulated-load-error.png); [sources fallback](../apps/web/src/main.tsx#L2391), [provider fallback](../apps/web/src/main.tsx#L3357), [SLA loading](../apps/web/src/SlaPage.tsx#L51), [Shadow loading](../apps/web/src/ShadowPage.tsx#L57), [source progress](../apps/web/src/main.tsx#L2665).

**Impact:** Users may repeat setup, replace credentials or wait indefinitely based on a state the app has not established. The older sandbox's missing endpoints were only a failure stimulus; no production outage is inferred. The failed import was an intentional sandbox rejection; the defect is its contradictory progress text.

**Fix:** Separate loading, successful empty, populated, failed and stale states. Say “Status unavailable,” stop loading, offer Retry, and preserve labeled last-known data when possible. Tie progress text to lifecycle; failed discovery should read “Stopped during discovery.”

**Acceptance:** An initial 503 shows error/recovery without zero-count onboarding or confirmed disconnected/off claims. Successful empty responses still show onboarding. Retry restores data; failed refresh retains clearly stale results.

### F06 · P2 · Publish support options lose their layout on a direct visit

**Observed:** In a fresh authenticated context, the four support options and descriptions run together inside a default fieldset. Mobile wrapping separates radios from their titles. Confirmed in both fixtures. Intended choice-card CSS lives in a stylesheet imported by the lazy customer portal, not the admin entry.

**Evidence:** [Mobile choices](assets/backend-ui-ux-audit-2026-10-06/publish-support-options.png); [component](../apps/web/src/SupportOptions.tsx#L77), [styles](../apps/web/src/customer-support.css#L682), [portal import](../apps/web/src/Portal.tsx#L27).

**Fix:** Import the necessary styles with the component/admin entry. Use distinct labeled choices, visible selected/focus states and comfortable touch targets.

**Acceptance:** A fresh hard-loaded Publish page at both widths renders separate radio/title/description groups, regardless of whether the portal was visited.

### F07 · P2 · Mobile selection opens details outside the visible area

| Surface | Observed after selection at 390 × 844 |
| --- | --- |
| Readiness | Selected check's diagnostics start 3,687px below the viewport; focus and scroll remain on the trigger. |
| Actions | Configure editor starts around y=933 at scrollY=0, after another action card. |
| Connections | Configuration heading starts around y=832; first field is below the viewport and focus stays on the provider. |

**Evidence:** [Readiness immediately after selection](assets/backend-ui-ux-audit-2026-10-06/readiness-mobile-after-selection.png), [distant detail](assets/backend-ui-ux-audit-2026-10-06/readiness-mobile-distant-detail.png); [Readiness selection](../apps/web/src/ReadinessPage.tsx#L221), [Actions selection](../apps/web/src/main.tsx#L3739), [provider selection](../apps/web/src/main.tsx#L3352).

**Fix:** Keep desktop list/detail layouts where they work. On narrow screens use one focused detail screen, a suitable sheet, or adjacent inline detail. Move focus to the new context, show Back, and restore selection, list position and focus on return.

**Acceptance:** Selecting any item immediately exposes its identity and next action. Keyboard users enter the detail context without traversing the remaining list. Back returns to the originating item. Screen-reader impact is inferred from focus/semantics; no assistive-technology session was performed.

### F08 · P2 · Signing-key rotation has no consequence confirmation

**Visible UI/source review only:** “Generate / rotate identity signing key” directly posts a replacement secret. The control does not distinguish creation from rotation, explain updating the website integration before confirmation, or disable repeated clicks while pending. **It was not clicked.**

**Evidence:** [Publish mobile](assets/backend-ui-ux-audit-2026-10-06/publish-mobile-layout.png); [button/handler](../apps/web/src/main.tsx#L4083), [secret replacement](../apps/api/server.ts#L1625).

**Fix:** Separate Create from Rotate, explain the affected integration, confirm existing-key replacement and disable while pending. Place under Developer integration.

**Acceptance:** Cancel sends no request; confirmed rotation sends one request and explains the required integration update. First-time creation remains straightforward.

### F09 · P2 · Team supports inviting staff but not removing access

**Observed/source review:** Owner member rows show identity and role without removal controls. The owner-only removal endpoint already exists. The page's “Manage staff access” task cannot be completed through the UI.

**Evidence:** [Read-only member rendering](../apps/web/src/main.tsx#L4242), [removal endpoint](../apps/api/server.ts#L793). No access was removed.

**Fix:** Provide an owner-only Remove access action for eligible members, confirming the person and workspace. Explain protected owner/self rows and role restrictions.

**Acceptance:** The owner can complete and cancel offboarding; successful removal refreshes the list; protected rows and unauthorized roles cannot invoke removal.

### F10 · P2 · Activity is impractical to investigate at moderate volume

**Observed:** With 49 failed jobs and 300 audit entries, audit history starts at y=7,731. The page reaches 37,586px on desktop and 38,732px on mobile. There is no section navigation, search, filter or pagination. Repeated job cards expose internal names/errors without useful source/time context.

**Evidence:** [Failures viewport](assets/backend-ui-ux-audit-2026-10-06/activity-failures.png), [history viewport](assets/backend-ui-ux-audit-2026-10-06/activity-history.png); [all jobs before history](../apps/web/src/main.tsx#L4461), [all audit events](../apps/web/src/main.tsx#L4499).

**Fix:** Separate unresolved operations, background work and audit history. Use searchable, filtered, paginated rows with timestamp, actor/source, action, related resource and outcome. Group repeated failures; disclose raw receipts within detail.

**Acceptance:** Each section is directly reachable with the same fixture. Users can find a change by actor/time/resource and identify the affected source before Retry without scanning all events.

### F11 · P2 · Test Lab gives half the workspace to navigation and buries Save/Run

**Observed:** One short suite item occupies a full half-width column. With only two turns, the desktop page is 2,908px tall; Save is around y=1,846 and Launch y=2,622. Expanded advanced controls produce about 4,097px desktop and 5,047px mobile.

**Evidence:** [Suite layout](assets/backend-ui-ux-audit-2026-10-06/test-lab-layout.png); [equal-width grid](../apps/web/src/quality.css#L16), [appended run setup](../apps/web/src/TestLabPage.tsx#L497).

**Fix:** Use compact suite navigation, a wide case editor, clear Cases / Run setup / Results views and a persistent save bar. Keep advanced assertions/fixtures disclosed.

**Acceptance:** Core case input/outcome and Save are readily reachable. Run setup shows the saved revision beside Launch. Mobile retains the same draft and save context across focused screens.

### F12 · P2 · FAQ management starts with competing creation forms

**Observed:** Whole-library generation, an always-open manual editor and another generation form all appear before “Your FAQs.” Even an empty inventory produces a 1,627px desktop and 2,461px mobile page.

**Evidence:** [Mobile FAQ page](assets/backend-ui-ux-audit-2026-10-06/faq-mobile-layout.png); [form ordering](../apps/web/src/main.tsx#L2925), [inventory placement](../apps/web/src/main.tsx#L3112).

**Fix:** Start with the inventory and review state. One Create FAQ action opens Write manually or Generate drafts. Generation should expose one coherent scope choice: selected sources or whole library.

**Acceptance:** Returning users see their FAQs first; each creation path presents one focused form. Existing capabilities remain available. Populated inventory scale still needs testing because this fixture's FAQ list was empty.

### F13 · P2 · Mobile Workflow defaults to its most complex editor

**Observed:** A new mobile session defaults to the graph with nine add-step controls, zoom/history/settings controls and a clipped canvas. At 80% zoom, connectors measure about 22.4 × 19.2px and outcome rows about 20px high. Guided steps is easier to read and operate and already exists.

**Evidence:** [Default graph](assets/backend-ui-ux-audit-2026-10-06/workflow-mobile-graph.png), [guided alternative](assets/backend-ui-ux-audit-2026-10-06/workflow-mobile-guided.png); [default mode](../apps/web/src/WorkflowPage.tsx#L148), [connector sizes](../apps/web/src/workflow.css#L152).

**Fix:** Default new mobile sessions to Guided steps while respecting saved preference. Make the advanced graph an explicit choice. Keep hit regions usable independently of zoom and make alternate connection controls obvious.

**Acceptance:** Users can select/configure/route a step without graph panning. Supported zoom levels retain usable interactions. Alternative controls and spacing exceptions must be evaluated before claiming a WCAG violation.

### F14 · P2 · Analytics drill-down loses the chosen reporting period on return

**Observed:** Set From to September 1, open a conversation, then use browser Back. From resets to September 6, the current default 30-day start, rather than retaining the selected range.

**Evidence:** Local reproduction screenshot (`.fieldkit/ui-ux-audit-2026-10-06/core-analytics-return.png`, local-only); [local-only filter state](../apps/web/src/AnalyticsPage.tsx#L6), [conversation navigation](../apps/web/src/AnalyticsPage.tsx#L311).

**Fix:** Put date/channel filters in the URL and preserve reporting context through drill-down and Back.

**Acceptance:** Returning, reloading and sharing a filtered analytics URL all retain its period/channel. A conversation can be investigated without reconstructing the cohort.

### F15 · P3 · Analytics does not yet support a clear investigation sequence

**Observed/design recommendation:** Six aggregate cards have no prior-period comparison, trend or direct metric drill-down. The latest-200 conversation list lacks search/paging and exposes raw status values such as `needs_staff`. The small fixture already yields a 3,132px desktop and 4,586px mobile page.

**Evidence:** [Analytics](assets/backend-ui-ux-audit-2026-10-06/analytics-desktop.png); [metric cards](../apps/web/src/AnalyticsPage.tsx#L106), [drill-down list](../apps/web/src/AnalyticsPage.tsx#L303).

**Fix:** Organize around “Is support improving?”, “Where are handoffs coming from?” and “Which cases explain this result?” Preserve denominator honesty. Add comparable periods and trends only where reliable historical data supports them; expose data gaps. Use human status labels and a searchable cohort table.

**Acceptance:** Each primary metric has a definition, eligible population and supported investigation path. A trend's granularity and comparison period are explicit. Unsupported historical data is shown as unavailable, never invented.

### F16 · P3 · Publish mixes live-channel management with advanced setup

**Observed:** The current-source page is 3,043px desktop and 3,831px mobile. Attachment settings precede Channels/Appearance navigation; email, three channel forms and integration keys follow in one sequence. Adjusting appearance requires passing unrelated setup.

**Evidence:** [Mobile Publish](assets/backend-ui-ux-audit-2026-10-06/publish-mobile-layout.png); [attachments before navigation](../apps/web/src/main.tsx#L3926), [stacked channel forms](../apps/web/src/main.tsx#L3954).

**Fix:** Start with channel status and Manage actions. Put Appearance beside Channels near the title. Open channel-specific attachment/email settings on demand; put service/signing keys under Developer integration.

**Acceptance:** Users can answer “What is live?” in the initial desktop view and reach Appearance immediately. Mobile users choose a setting without passing every unrelated form.

### F17 · P3 · Inbox ownership is hidden from normal scanning

**Observed/design recommendation:** Queue rows show status, urgency and channel, but not assignee. The selected thread requires opening Manage conversation to inspect Assigned to. This makes team ownership harder to determine during triage.

**Evidence:** [Current inbox](assets/backend-ui-ux-audit-2026-10-06/inbox-desktop.png); [row metadata](../apps/web/src/customer-ui.tsx#L133), [management disclosure](../apps/web/src/main.tsx#L1393).

**Fix:** Add one quiet read-only owner indicator in the row/thread header. Keep assignment editing in Manage; make the existing assignee filter easy to use for Mine/Unassigned. Avoid reintroducing many row badges.

**Acceptance:** Staff can identify ownership without opening each management panel. Confirm useful information density with real operators before expanding metadata further.

### F18 · P3 · Customers mobile Back loses keyboard focus

**Observed:** Open a customer on mobile, then choose “All customers.” The detail disappears and focus falls to the document body rather than returning to the selected customer row.

**Evidence:** [Back handler](../apps/web/src/CustomersPage.tsx#L139); live `document.activeElement` check returned `BODY` after activation.

**Fix:** Remember the originating row and restore focus and list position. Reuse the inbox return behavior.

**Acceptance:** Back consistently returns to the selected visible row, or the list heading if that row is no longer present after filtering.

### F19 · P3 · Action policy fields imply inactive limits are in use

**Observed:** Approval-only cards say “Human approval required” beside “100 automatic actions / day.” A cancellation editor also shows an automatic refund limit and currency. Raw `8900` requires understanding minor currency units.

**Evidence:** [Action configuration](assets/backend-ui-ux-audit-2026-10-06/actions-mixed-record.png); [unconditional summary](../apps/web/src/main.tsx#L3730), [policy fields](../apps/web/src/main.tsx#L3852).

**Fix:** Show only applicable active policy fields. Say “All actions require approval” for that policy; reveal automatic limits when enabled. For refund tools, show a human monetary amount and explain any storage conversion.

**Acceptance:** Cancellation/approval-only settings do not imply automated refunds are active. Switching policy preserves stored values without presenting inactive limits as current behavior.

### F20 · P3 · Needs attention has no visible selected-section treatment

**Observed:** Deadlines, My notifications and SLA policy remain visually identical when selected, although `aria-pressed` changes. Refresh looks like another peer section.

**Evidence:** [Section selection](assets/backend-ui-ux-audit-2026-10-06/sla-section-selection.png); [section controls](../apps/web/src/SlaPage.tsx#L32); computed colors/backgrounds/borders were identical.

**Fix:** Reuse the existing active-section styling, including a non-color cue; separate Refresh as a toolbar command. If converting to tabs, implement complete tab semantics and keyboard behavior.

**Acceptance:** Selected section is apparent visually and programmatically; Refresh cannot be mistaken for a section.

### F21 · P3 · Active sessions asks users to decode raw browser strings

**Observed:** Rows read “Other session” followed by a full Mozilla user-agent string. Current session is mixed among other rows; a sampled mobile page reaches 3,337px with the bulk sign-out action last.

**Evidence:** [Session rendering](../apps/web/src/ProfileSettings.tsx#L212); local `ops-settings-profile-desktop.png` and `ops-settings-profile-mobile.png`.

**Fix:** Present browser/platform, current-device badge and sign-in/last-active time. Keep raw user-agent evidence in Details. Put the current session first and Sign out other sessions near the section heading.

**Acceptance:** Users can recognize their device without decoding technical tokens. Unknown values use an honest fallback; underlying details remain available.

## Recommended UI structure

Keep the existing green/neutral palette, DM Sans body type and Manrope headings. The work is mainly in information architecture, state behavior and density; another font or a larger set of cards will not resolve it.

| Pattern | Recommended behavior | Apply first |
| --- | --- | --- |
| List and detail | Compact searchable list, named selected record, wide working area; one pane at a time on mobile | Actions, Connections, Readiness, Test Lab |
| Managed inventory | Inventory/review state first; one Create action opens a focused flow | FAQs, Actions, reusable components |
| Editor | Record identity + saved/unsaved state + persistent Save/Discard; advanced fields disclosed | Settings, Appearance, Test Lab, components |
| Operational table | Filter/search, meaningful columns, pagination, contextual details and recovery | Activity, Analytics drill-down |
| Settings overview | Status first, targeted Manage action, related settings together | Publish and integrations |
| Async state | Loading → loaded/empty/error; stale data clearly marked; useful Retry | Knowledge, Connections, SLA, Shadow |

For navigation, retain familiar destination names and existing links while testing a role-oriented structure: Support work (Inbox, Needs attention, Customers), Agent management (Knowledge, Workflow, Actions, Test Lab, Shadow), and Workspace (Channels/Publish, Connections, Team, Settings). Treat Analytics and Activity as investigation destinations; distinguish Setup onboarding from ongoing Readiness. This is a design hypothesis to validate, not a reason to reorganize every route immediately. A completed setup should emphasize the next operational action, and agents should continue to see only permitted controls.

Use consistent section tabs, spacing and action placement. Prefer a compact page header, a single clear primary action, quiet secondary commands and short help adjacent to the decision. Keep raw JSON, API configuration and browser strings in targeted advanced detail. State whether each action saves a draft, publishes, runs a test or changes a live integration.

## Accessibility and interaction checks

Preserve the working mobile navigation Escape/focus return, native article-preview dialog, workflow expanded-editor focus handling, graph keyboard move/Undo, form labels and date-range errors. Closed disclosure descendants were checked against the accessibility tree; apparent unnamed controls from a naive bounding-box scan were excluded as false positives. No document-wide horizontal overflow was observed in sampled primary states at the two tested widths; the graph intentionally has its own scroll area.

Use approximately 44px touch targets as a comfort goal. Do not label every smaller control a WCAG failure: WCAG 2.2 AA target-size minimum is 24 × 24 CSS pixels with spacing and other exceptions, including equivalent controls. [W3C target-size guidance](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html)

Validate text contrast at 4.5:1 for ordinary text and 3:1 for qualifying large text; separately verify focus and component boundaries. A limited rendered-text sample on Analytics found no sub-4.5 candidates, but this does not establish app-wide contrast conformance. [W3C contrast guidance](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html)

Verify accessible names, roles and states in the actual accessibility tree, especially custom navigation, selected records and asynchronous feedback. Include a real keyboard and screen-reader pass after implementation. [W3C name, role and value guidance](https://www.w3.org/WAI/WCAG22/Understanding/name-role-value.html)

## Implementation and validation plan

1. **Restore workflow trust.** Fix record identity and JSON editor state; add draft retention/exit protection and explicit run revision. Verify A→B switching, same-record reselection, invalid JSON, save failure and workspace isolation. Protect key rotation and implement permitted member removal with API authorization unchanged.
2. **Make state and navigation reliable.** Fix directly imported option styles, loading/error/empty distinctions, import lifecycle copy and mobile detail focus/return. Use fault-injected read errors and fresh hard loads, not only happy-path navigation.
3. **Reduce task clutter.** Restructure Test Lab, FAQs, Publish and Activity using the patterns above. Keep capabilities accessible on demand and retain familiar labels. Test at 390px, an intermediate tablet width and a wide desktop with populated fixtures.
4. **Improve investigation and consistency.** Persist analytics filters, provide coherent metric drill-downs, surface inbox ownership, restore customer-list focus and standardize selected states and session/policy copy.

Suggested usability validation after those changes: recruit representative support agents and workspace owners and observe these tasks without coaching. The criteria below are proposed release checks, not measurements already collected.

| Task | Success criterion |
| --- | --- |
| Find an unassigned conversation and prepare a reply | Participant identifies ownership and next action without opening multiple unrelated panels; draft survives checking customer context. |
| Edit two actions in sequence | Every editor field belongs to the selected action; the participant can name which action will be saved. |
| Change an exact test assertion, then run | Participant knows whether changes are saved and exactly which revision will run. |
| Draft an FAQ while consulting a source | Returning preserves all unsaved text without recovery work. |
| Open failed Readiness evidence on a phone | Selection immediately reveals evidence and remedy; Back restores the original place. |
| Investigate an audit event among 300 entries | Participant finds the relevant actor/resource/time using filters instead of scanning the entire page. |
| Identify live channels and change appearance | Participant reaches each directly and understands what Save affects. |
| Recover from a failed provider-status request | Participant recognizes unavailable status, uses Retry and does not infer credentials were removed. |

The audit itself changes documentation and preserves screenshot evidence. It does not apply the proposed product changes. Existing inbox implementation work in the checkout was retained.
