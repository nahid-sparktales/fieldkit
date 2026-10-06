# Staff/admin UI and UX fixes

Implemented October 6, 2026, following the [21-finding audit](backend-ui-ux-audit-2026-10-06.md). Existing inbox redesign work is preserved.

The interface now leads with the work to review, opens focused editors on demand, and makes unsaved changes and unavailable data explicit. The existing visual identity and permission checks remain in place.

| Finding | Implemented fix |
| --- | --- |
| F01 · Mixed Actions records | Controlled, independent selected-record drafts; named editor; guarded switching; saves use the selected record's values. |
| F02 · Stale Test Lab assertions | JSON text and validation are scoped to each case and turn, including invalid drafts. |
| F03 · Lost drafts | FAQ, Appearance and Settings preserve sibling-tab work. Test Lab and reusable components protect switching. Shared navigation/unload safeguards, explicit discard and save state protect unsaved work. Customer notes and account-link editors also protect record changes. Password contents are not persisted. |
| F04 · Running an unsaved test | Launch is blocked while dirty or invalid; Run setup names the saved revision. Pending saves block record switching. |
| F05 · False empty/error states | Knowledge, Connections, SLA and Shadow distinguish loading, failed, empty and stale data; Retry is available. Failed import progress no longer claims active discovery. |
| F06 · Unstyled support choices | Choice-card CSS loads directly with SupportOptions; fresh admin loads have distinct radio/title/description targets and visible selection. |
| F07 · Offscreen mobile details | Actions, Connections and Readiness open visible detail views, focus the new context and restore the originating control on Back. |
| F08 · Accidental key rotation | Creation and rotation are distinct. Rotation explains replacement, confirms intent, blocks repeat clicks while pending and explains updating the integration. |
| F09 · Missing offboarding | Owners can remove eligible staff with a named confirmation; owner/self protection and existing API authorization remain enforced. |
| F10 · Unmanageable Activity | Operations, Background work and Audit history sections; search, date/status/type filters, 20-record pages, source/actor/resource/time context and disclosed retrieval limits. Job metadata now includes the affected source. |
| F11 · Test Lab layout | Compact suite navigation, wide editor, Cases / Run setup / Results, persistent save controls and saved revision context. |
| F12 · FAQ clutter | Inventory first; Create FAQ opens focused manual or generated drafting, with one source-scope choice. Drafts survive switching modes. |
| F13 · Mobile graph friction | New mobile sessions default to Guided steps. Graph editing controls have comfortable targets at editing zoom; smaller zoom is explicitly an overview with settings alternatives. Saved preferences remain respected. |
| F14 · Lost Analytics filters | Date, channel, section, outcome, search, sort and page persist in the URL through drill-down, Back and reload. Invalid navigation values have safe defaults. |
| F15 · Weak analytics investigation | Adjacent-period comparisons, UTC conversation-volume chart with an exact-count table, handoff comparison, metric drill-down and searchable/sortable/paginated cohort rows with human-readable statuses. Clicking a metric clears conflicting detail filters. |
| F16 · Publish clutter | Channel-status overview; targeted channel management; separate Appearance and Developer integration views; email, support and attachment settings open on demand. |
| F17 · Hidden inbox ownership | Quiet assignee labels appear in conversation rows and the selected thread; assignment editing remains in management controls. |
| F18 · Customer return focus | Mobile Back restores the originating customer row or directory fallback, while protecting dirty editors. |
| F19 · Confusing action policy | Approval-only actions show approval-only summaries; automatic limits appear only when active, and refund fields only for refunds. Refund limits include a readable currency amount and unit explanation. |
| F20 · Invisible SLA selection | Persistent selected-section treatment with a non-color cue; Refresh is visually separate. |
| F21 · Technical session labels | Readable browser/platform names, current session first, timestamps, technical details disclosure and accessible bulk sign-out placement. |

## Verification

| Check | Result |
| --- | --- |
| `npm run typecheck` | Passed. |
| `npm run build` | Passed. |
| `npm test` | 177 tests passed; no failures or skips. |
| `npm run test:browser` | Complete onboarding/support journey and all four audit regression helpers passed on the final build (1.8 minutes). |
| Focused browser checks | Actions/Team, content, builder and operational checks passed; content route cleanup also passed three consecutive stress runs. |
| `git diff --check` | Passed. |

Targeted browser regression coverage is in [admin-audit-journey.ts](../tests/browser/admin-audit-journey.ts), [builder-audit-journey.ts](../tests/browser/builder-audit-journey.ts), [content-audit-journey.ts](../tests/browser/content-audit-journey.ts) and [operations-audit-journey.ts](../tests/browser/operations-audit-journey.ts). The existing onboarding-to-support browser journey runs these checks after its established workflows.

Checks cover wrong-record prevention, invalid JSON isolation, failed/pending saves, draft retention and cancellation, mobile focus/return, directly loaded option styling, read failures/recovery, confirmed administrative actions, filtering/pagination, URL persistence and document overflow. Dangerous or external actions in the new regression checks are intercepted; no live key rotation or real staff removal is used for testing. Analytics aggregation and comparison windows have backend regression coverage.

The final review also closed related recovery edge cases: cancelling browser Back retains the selected customer URL, pending Settings/account-link saves disable editable controls, profile refresh failures preserve existing form/password inputs, and impossible calendar dates in Analytics URLs are rejected.

Desktop/mobile screenshots were reviewed at 1440 × 1000 and 390 × 844. The API's existing Activity retrieval caps and Analytics latest-200 detail cap are explicitly disclosed; charts and aggregate metrics use the full selected cohort. Historical gaps remain labeled, and outcome comparisons describe retained history through now.

Representative completed layouts: [Actions desktop](assets/backend-ui-ux-fixes-2026-10-06/actions-desktop.png), [Actions mobile](assets/backend-ui-ux-fixes-2026-10-06/actions-mobile.png), [Publish overview](assets/backend-ui-ux-fixes-2026-10-06/publish-desktop.png), [Test Lab](assets/backend-ui-ux-fixes-2026-10-06/test-lab-desktop.png), [Analytics](assets/backend-ui-ux-fixes-2026-10-06/analytics-desktop.png), and [Readiness mobile](assets/backend-ui-ux-fixes-2026-10-06/readiness-mobile.png).

Validation uses synthetic local fixtures and mocked providers. This does not claim live-provider verification, production deployment or formal screen-reader/WCAG certification.
