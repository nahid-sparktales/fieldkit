# Teams, availability, and human routing

Human routing assigns work after a conversation needs a person. It does not run a
model, change an AI workflow, or decide which business actions are permitted.
The existing inbox, ticket history, permissions, SLA obligations, PostgreSQL, and
pg-boss remain the system of record.

## Implementation map and rollout

Migration 19 introduces the team identity/access foundation and
`conversations.team_id`. Migration 22 (`human-routing-schema.ts`) adds team policy,
multi-membership, availability/capacity, persisted queue entries, and assignment
provenance. `human-routing-contracts.ts` validates bounded settings; the
`HumanRouting` service implements both automatic and manual assignment.
`TeamsPage.tsx` supplies administration, the queue, workload, availability, and the
ticket assignment inspector. The existing API/platform wires these methods into
staff routes, events, and the `human-routing` worker. No new service or Redis is
required.

The upgrade is additive. Automatic routing starts **off**, team routing starts
off, and every staff member starts **Offline**, with a default limit of five
active human tickets. Existing assigned conversations are marked as manual
ownership. Migration and enablement do not reassign existing owners or enroll all
historical unassigned conversations.

1. Create active teams and add existing workspace staff. A person can belong to
   several teams. Team membership does not grant capabilities.
2. Set individual ticket limits under Workload and enable routing for the intended
   teams. Configure a default team, or let intake forms/support addresses choose it.
3. Optionally select an active overflow team and a wait of 1–10,080 minutes.
   Cross-workspace teams, self-references, and overflow cycles are rejected.
4. Enable workspace automatic routing. Staff deliberately select Available in
   the application. New human-handling events can now enter the queue.
5. Use **Requeue for automatic assignment** for an existing ticket you explicitly
   want to enroll. This releases its current manual owner and records the actor.

Disabling automatic routing stops new automatic claims and enrollment. It does
not clear assignments. Availability, queue records, and history remain available
for a later restart. Keep the additive tables when rolling back the application;
dropping them or restoring an old database is not a lossless disable procedure.

## Availability and capacity

Available, Away, and Offline are explicit user intent stored on the server.
Visible staff application pages refresh an Available agent's connectivity every
30 seconds. The default freshness limit is five minutes, configurable from one
to thirty minutes. Closing or losing the app connection makes Available expire;
expired agents are excluded from new automatic assignments. Heartbeats cannot
change Away or Offline. Reconnecting a visible app refreshes the existing
Available intent; a new membership is never implicitly made Available.

Capacity is the current count of assigned, unresolved conversations whose mode
is `human` **or** status is `needs_staff`. This count is shared across all teams:

| Conversation state                                | Uses capacity                  |
| ------------------------------------------------- | ------------------------------ |
| Open human-handled ticket                         | Yes                            |
| Needs staff, including an AI handoff              | Yes                            |
| Waiting for customer/SLA wait while human-handled | Yes                            |
| Awaiting approval while human-handled             | Yes                            |
| AI-only conversation                              | No                             |
| Resolved conversation                             | No                             |
| Reassigned conversation                           | Moves to the new owner's count |

Counts come directly from conversations inside the assignment transaction. No
separate increment/decrement counter can drift after a restart or failed job.
Lowering a limit does not remove existing work. Reopening retains an authorized
existing owner, even if the reopened ticket brings their count over their limit;
new automatic claims stop until that workload falls. An owner removed from the
workspace/team, disabled, or no longer authorized to receive the ticket is cleared
and the ticket is requeued. This reconciliation is retried by the persisted worker
and periodic sweep; it does not guess a replacement before eligibility checks.

## Queue ordering and assignment

Unresolved, unassigned human work enters one persisted queue row per ticket.
An intake/default team is resolved inside the workspace. AI-only work is skipped.
Repeated events retain the queue age and cannot duplicate assignment effects.

Tickets waiting six hours take precedence, oldest first. Remaining tickets are
ordered urgent, high, normal, low; the earliest existing active, unpaused SLA
deadline breaks priority ties, followed by queue age and ticket ID. The six-hour
threshold prevents a stream of new urgent tickets from indefinitely overtaking
old work. This uses existing business-hour SLA deadlines, not a second SLA clock.

Each team retains its round-robin cursor. Eligible staff must still be active
workspace members, belong to the team, hold ticket-read authority for the target
scope, have fresh Available status, and be below their total capacity. Assigned-only
roles may receive an assignment that then makes the ticket visible to them;
team-scoped roles must have current access to the destination team.

If no agent is eligible, the ticket stays queued with a concrete explanation:
Missing team, Team inactive, Team routing off, No team members, No authorized
members, No available members, or All available members at capacity. These states
are visible in the team queue and ticket inspector. A configured overflow moves
an unclaimed ticket after the wait, only to an active routing-enabled team in the
same workspace. A queue entry overflows once; it is not repeatedly bounced through
teams. Deliberate requeue begins a new queue wait.

Availability, capacity, team/member policy, ticket transitions, and deliberate
requeues enqueue durable retries. A minute sweep covers expiration, overflow,
permissions changes, interrupted workers, and queued records after restart.
Each drain scans the queued IDs in order so an unavailable team cannot block
other teams behind a page boundary. The UI shows the first 200 visible queue rows. Assignment and reason events use the existing conversation event stream.
They are staff-only and contain IDs/decision metadata, not customer message text.

## Manual assignment and permissions

Manual assignment is deliberate, so it does not require Available status. It
still requires a current, authorized workspace/team member and normal capacity.
A manually unassigned ticket stays unassigned rather than being immediately
reclaimed. Only explicit requeue releases manual ownership. Staff can see the
assignment source and explanation in the ticket inspector/history.

When human routing is enabled, a workflow's configured assignee is recorded as a
request in the assignment history; the team queue still chooses a currently
eligible person. It cannot override manual ownership or bypass availability and
capacity. With routing off, existing explicit workflow assignments continue,
with current membership and ticket authority rechecked before publication.

The same transaction method handles ordinary assignment and macro changes.
Macros stage a preview; committing a reply/note revalidates assignment with the
other changes and rolls the whole transaction back if any check fails.

| Capability                | Purpose                                                  |
| ------------------------- | -------------------------------------------------------- |
| `tickets:read`            | Read authorized queue rows/history; set own availability |
| `tickets:assign`          | Manual assignment or explicit requeue of visible tickets |
| `tickets:assign_override` | Explicit over-capacity assignment, with a reason         |
| `teams:manage`            | Create/archive teams and manage their memberships        |
| `routing:manage`          | Workspace/team routing policy and staff capacity limits  |

Capability and ticket visibility enforcement occurs in the API/service, not just
the UI. Routing configuration does not widen a saved view or grant customer
access. Capacity override is never inferred from an administrator's role: the
request must explicitly set the override and include a nonempty reason. The
decision is recorded even if the assignee was not actually over capacity.

## Concurrency contract

Assignment, availability/capacity, and routing administration acquire a
PostgreSQL transaction advisory lock keyed by workspace **before** conversation
row locks. Macro/control integration must use this same order. Automatic claims
then recheck the ticket, live membership/capabilities, team, presence, and workload
inside the transaction. The round-robin cursor, assignment, queue result, and
staff-only event commit together. Concurrent jobs or a manual assignment cannot
claim the same capacity independently. Recipient membership rows are locked
against concurrent deletion while deciding. Permission/membership administration
uses the shared workspace lock before mutating authority.

Event hooks run inside existing ticket transactions and only persist/enqueue
work; they never attempt to acquire the routing workspace lock after a ticket
lock. Workers lock conversation before queue row. Transport is at-least-once;
persisted ticket/queue state and conditional claims deduplicate its effects.

## API and local verification

Workspace routes are under `/v2/workspaces/:workspace`:

- `GET /routing`: authorized queues, teams, workload, current availability.
- `PUT /routing/settings`: workspace enablement, default team, freshness.
- `POST /routing/teams`: create/update team, member IDs and overflow policy.
- `PUT /routing/availability`: own Available/Away/Offline intent.
- `POST /routing/heartbeat`: own connectivity refresh; no intent change.
- `PUT /routing/agents/:user/capacity`: ticket limit from 1–200.
- `GET /conversations/:ticket/routing`: authorized decision history.
- `POST /conversations/:ticket/routing/assign`: manual assignment.
- `POST /conversations/:ticket/routing/requeue`: explicit ownership release.

`tests/human-routing.test.ts` uses synthetic workspaces and local PostgreSQL.
It covers default-off upgrades, repeat migrations, persisted round robin,
expiry/Away/Offline, shared capacity, parallel claims, manual races and override
denials, reopened ownership, removal, overflow cycles/tenant boundaries, queue
aging/SLA ordering, scope, and direct HTTP permission bypass attempts. Run it
only against a disposable database ending in `_test`:

```sh
TEST_DATABASE_URL=postgresql://…/isolated_routing_test npx tsx --test --test-concurrency=1 tests/human-routing.test.ts
```

The local tests do not email customers, use external identity providers, or
certify production deployment. Shift schedules, skill matching, forecasting,
and workforce planning are outside this implementation.

Team, routing-policy, and capacity administration require both the corresponding capability and all-workspace ticket visibility. Team-scoped and assigned-only roles cannot administer membership or routing, even when a custom role includes those capabilities. Every mutation refreshes live authority after taking the shared workspace lock, so a queued write cannot survive a preceding revocation.
