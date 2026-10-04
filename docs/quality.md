# Test Lab, knowledge gaps, and analytics

## Test before publishing

Open **Test Lab**, create a suite, and add ordered customer messages. Optional checks cover the final outcome, visited steps, knowledge source citations, exact action parameters, and approval requirements. Reference answers help the separate AI reviewer. Save the suite before launching a run.

Every run requires a token cap. Compare one or two variants using the current draft or a published workflow version, with optional response provider/model and workflow JSON overrides. Leaving an override empty uses the current workspace draft. Cases, workflow definitions, expanded component versions, action policies, effective settings, and the knowledge catalog are snapshotted. Model overrides affect response nodes only; embeddings and the judge remain fixed across the comparison. Publishing is always a separate operation in Workflow.

Account and API reads use saved fixtures. Example:

```json
{
  "customer": {"verified": true, "mappings": {"stripe_test": "cus_fixture"}},
  "account": {"billing": [{"mode": "test", "charges": [], "subscriptions": []}]},
  "steps": {"service_status": {"output": {"status": "operational"}}},
  "dailyActionCount": 0
}
```

API outputs must satisfy their saved step schema. Customer reads still require a verified fixture and provider mapping. Missing fixtures visibly block the case. Python/JavaScript steps use the existing isolated runner; an unavailable runner blocks the case. The Test Lab never writes customer messages, approvals, deliveries, or business operations. It validates proposed actions, resource ownership, parameters, and approval limits and stops at that boundary. Ordinary Workflow previews retain their live read behavior.

Each turn persists before the next begins; generated replies appear in later turn context. Results retain answers, citations, step traces, proposed actions, errors, latency, provider-reported usage, and unresolved reservations. Three assessments are displayed independently:

- **Rule checks:** exact expectations. Failed checks stay failed regardless of AI scores.
- **AI quality assessment:** grounding, relevance, completeness, reference consistency, and explanations tied to supplied evidence.
- **Staff review:** append-only verdicts and explanations, including overrides, without removing original assessments.

Queued jobs recheck administrator membership, retained imports, and source versions. Knowledge changes invalidate unfinished comparisons. Cancel stops future batches; a provider call already in flight can still consume tokens. Interrupted attempts become uncertain and need an explicit, acknowledged retry. Completed turn outputs survive worker restart; a completed reply with an interrupted judge is reused when judging is retried.

Use **Create regression test** in the inbox, or **Create regression test / Retest after changes** in a gap. Imported drafts contain customer messages and candidate public reference answers, exclude internal notes, and require personal information review before saving. Delete unwanted references and personal details. Deleting the source conversation makes its imported case unavailable and removes dependent run transcripts.

## Review gaps

**Knowledge → Gaps** collects missing-evidence handoffs, negative feedback, and staff flags. Provider failures, identity issues, and intentional handoffs remain separate categories. Repeated occurrences are deduplicated and normalized matching questions are grouped. Staff can inspect affected conversations and citations, merge groups, dismiss with a reason, or track work in progress.

**Analyze now** reviews up to 20 new or changed groups with a mandatory token cap. The owner can enable nightly analysis at **02:00 UTC** with a daily cap. It is disabled on new installations. The daily cap, when configured, includes both manual and scheduled analysis within the workspace budget. No migration performs a paid backfill; an explicit bounded historical handoff scan is available.

Analysis proposes missing information, possible conflicts, topic grouping, and FAQ changes. Recommendations link to retained conversations and current approved knowledge. Unsupported suggestions remain requests for staff input. Supported suggestions can become private FAQ drafts through existing review and publication controls. Staff decide whether to merge suggested groups or resolve gaps after reviewing evidence and regression results. Approving an article never closes a gap automatically.

## Read outcomes accurately

**Analytics** starts with 30 days and supports date/channel filters and conversation drill-down. Conversation outcomes use a cohort created in the selected window and its retained history through now. Usage uses the selected call dates; a channel filter excludes calls with no conversation attribution.

Customer-confirmed resolution is measured only among conversations with a delivered AI reply. An additional denominator excludes conversations with staff replies, handoffs, or unknown delivery/outcome history. Later customer messages or negative feedback invalidate the current confirmation. Silence, a closed ticket, a completed run, and a good rating do not imply resolution.

Native feedback asks whether the issue was solved and separately offers good/bad experience ratings and comments. Customers send native feedback once per conversation after it closes. Exact retries return the existing submission; edits and additional submissions are rejected. The customer sees a receipt, and staff see the result and comment in Inbox → Feedback. “Still need help” reopens native conversations and opens the reply box, preserving human takeover. Existing feedback history is retained. Satisfaction reports the latest submitted rating per conversation and source; unrated conversations are shown and excluded from rating percentages. Native, modern Zendesk, and legacy Zendesk ratings are displayed separately. Zendesk scales/categories remain in the imported record and neutral responses are preserved.

Response times use delivered replies, never queued deliveries. Status transitions and handoff categories are recorded explicitly from this release; older missing history stays unknown. Production, preview, evaluation, judging, gap analysis, knowledge indexing, and staff assistance usage are attributed separately. Actual reported tokens and unresolved reservations are distinct; monetary estimates are not provided.

Zendesk imports only already-linked tickets, through ticket synchronization and hourly, resumable reconciliation. Both modern CSAT surveys and legacy ticket ratings are read-only. Edits and duplicate pages update existing rows. Missing permissions and rate limits are visible in Analytics. FieldKit never creates or changes a Zendesk survey. See Zendesk's [modern survey schema](https://developer.zendesk.com/api-reference/ticketing/ticket-management/csat_survey_responses/) and [legacy ratings](https://developer.zendesk.com/api-reference/ticketing/ticket-management/satisfaction_ratings/). A dedicated real account must pass before this integration is release-verified.

## Operations

Schema 9 is additive. Back up before upgrading; run the normal migrations, rebuild the web assets, and restart app and worker together. The existing PostgreSQL/pg-boss worker processes `quality` and `feedback-sync` jobs; no additional service or package is required. SSE progress uses the existing streaming proxy configuration.

The workspace retention period applies to run transcripts and feedback. Deleting retained conversations removes feedback and gap occurrences, clears derived recommendations, removes dependent analysis/evaluation jobs, and marks imported cases unavailable. Monthly token accounting is retained independently so deleting a transcript cannot reset a budget. Apply retention to backups separately.
