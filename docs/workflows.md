# Visual agent workflows

Open **Workflow** in the staff sidebar. Owners and admins can edit and test; agents can view the graph and version history. Until you publish, the existing built-in support flow remains active. Fresh workspaces receive a suggested support template, not an automatically published customization.

## Build and publish

1. Select a step to edit its settings in the inspector. Add steps from the palette. Drag a step's heading to move it, or focus the heading and use arrow keys.
2. Connect an outcome button to another step's input. The outcome dropdowns in the inspector provide the same control with a keyboard. Use zoom and scrolling to navigate, and Undo/Redo to revise the layout or configuration.
3. Choose **Save draft**. Incomplete drafts can be saved; validation must pass before testing or publishing. A stale editor receives a conflict instead of overwriting another person's changes.
4. Run **Test workflow** with a sample question. Choose an anonymous visitor or an existing verified customer, plus the channel. The highlighted route and trace show each step's result, retrieved passages, and any proposed action. This uses your configured model and token budget and can read the selected customer's mapped provider account. It stops before any action execution, approval creation, message delivery, or ticket change.
5. Choose **Publish workflow**. New conversation turns use that version. The setup page's answer test also uses the published graph. Draft changes remain inactive until published.

Version history can restore an earlier definition into the editor. Save and publish it to create a new active version; old versions are never overwritten. Templates and JSON import/export support copying definitions, but referenced actions, knowledge sources, and staff must exist in the destination workspace. Exports contain settings and resource identifiers, not credentials.

## Available steps

| Step | Settings and behavior |
| --- | --- |
| Incoming conversation | Starts each customer turn from native portal, widget, Zendesk, or the authenticated support API. Conversation history persists between turns. |
| Customer account | Uses the conversation's verified customer identity. Optionally supplies name/email and purchases/subscriptions from mapped Stripe test/live accounts. Anonymous visitors receive no account context. |
| Search knowledge | Searches all approved knowledge and FAQs, or selected ready customer-approved sources, with a bounded passage count. Routes separately on evidence found, no evidence, or retrieval failure. Staff-only material is never available to customer answers. |
| Agent decision | Adds step instructions to workspace instructions, with an optional response-provider/model override. A provider override requires an explicit model ID; otherwise the step uses workspace defaults. Produces an answer, clarification, action proposal, or handoff. Later agent steps can review the prior unsent draft. Available actions come from the governed action step reachable on its route. |
| Condition | Branches on verified identity, a reviewed provider mapping, channel, or whether knowledge was found. Conditions inspect application state, not a customer's claims. |
| Governed action | Selects existing enabled actions from **Actions**. Always require approval, or honor each action's owner-configured policy. Provider ownership, input schemas, limits, exact approval hashes, idempotency, and uncertain-outcome recovery remain enforced. This step never grants new authority. |
| Reply to customer | Uses the grounded answer, clarification, or confirmed action result. Honors workspace reply mode, or always holds the response for staff review. |
| Human handoff | Pauses the agent, sets a customer-facing message, and optionally assigns staff and priority. Channel settings determine whether the destination is the native inbox or Zendesk. Staff must explicitly resume the agent. |

Create integrations in **Connections**, action definitions and policies in **Actions**, reviewed customer mappings and memberships in **Team**, and channel destinations in **Publish**. The editor's resource panel shows their current availability. Customer account selection in the tester is an admin preview only; production conversations always use their own verified identity.

## Execution and safety boundaries

Each published definition compiles into a real LangGraph with PostgreSQL checkpoints. A turn saves an immutable definition and version with its run. Action approval expands into durable interrupt, validation, and execution steps; a worker restart resumes that saved graph. The existing built-in graph remains available to finish older runs.

Publishing a different workflow invalidates pending approvals. Runs retain their saved graph, but an old workflow version cannot perform a new account action. Every turn still checks conversation revisions and human takeover, knowledge access, customer identity revisions, current action policy, and usage limits. An action proposal routed directly to a reply cannot claim success or execute without the governed action step.

This release supports directed graphs without loops: at most 24 steps, three model decisions, one account lookup, and one governed action per turn. All outcomes must have a destination and all steps must be reachable. Follow-up customer messages start new bounded turns with the conversation's persisted history. Arbitrary scripts, model-selected URLs, credentials in graphs, parallel actions, and execution bypasses are not supported.
