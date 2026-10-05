# Custom replies, steps, and subflows

Open **Workflow**. Owners and admins can configure these features. Start with an exact reply or template; neither needs a model connection. Model usage occurs only when a route reaches knowledge embeddings or an Agent decision.

## Replies and variables

Select **Reply to customer → Reply content**:

- **AI answer or confirmed action receipt:** the existing grounded answer or governed action result.
- **Exact reply:** send the entered text, with no model call or substitution.
- **Reply template:** substitute explicit values, for example `Hi {{customer.name}}, your ticket is {{ticket.id}}.`

All modes honor workspace review settings, or **Always require staff review**. Replies are plain text. Missing variables, objects in a placeholder, changed identity, and an unexecuted action proposal cause handoff. A template cannot assert completion of a pending action in place of its approval/execution step.

| Variable                                                     | Available data                                                                                                                                                                                              |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `customer.id`, `.name`, `.email`, `.verified`                | The conversation's verified customer. Anonymous users have only `verified: false`.                                                                                                                          |
| `account.customer`, `account.billing`                        | Data selected by an earlier Customer account step. Billing is an array of mapped Stripe account summaries; for example `account.billing.0.charges.0.amountMinor`. Missing mappings produce no account data. |
| `ticket.id`, `.subject`, `.category`, `.priority`, `.status` | Current conversation metadata.                                                                                                                                                                              |
| `message.text`, `channel.kind`                               | Latest customer message and portal/widget/Zendesk channel. Message content is untrusted; never use it to establish ownership.                                                                               |
| `agent.intent`, `.answer`                                    | An earlier model decision, if present.                                                                                                                                                                      |
| `steps.STEP_ID.output.FIELD`, `steps.STEP_ID.status`         | A completed custom step or subflow in the current graph scope.                                                                                                                                              |
| `inputs.FIELD`                                               | Mapped inputs inside a reusable subflow.                                                                                                                                                                    |
| `action.reference`, `action.result.FIELD`                    | A confirmed governed action receipt.                                                                                                                                                                        |

Use the variable suggestions in the inspector or enter a nested path. The step ID appears beside its output fields. Input mappings accept a workflow variable or a fixed JSON value. Conditions support equality, inequality, contains, starts-with, numeric greater/less, existence, and true. Numbers must be actual JSON numbers. Missing data never satisfies a comparison except the existence check returning false.

## Reusable library

Expand **Reusable steps and subflows** above the canvas. Every save creates an immutable version. Add a **Custom step** or **Subflow** to the canvas, choose a saved component, map its inputs, and connect both `done` and `failed` outcomes. Test, save the main draft, then publish.

Updating a component does not update any workflow automatically. Select **Use latest component version**, then test and republish. Publishing snapshots the complete nested graph and code. Archiving removes a component from new selections; published snapshots keep running until replaced. Exports refer to workspace-local component IDs and versions; recreate the library in another workspace before importing such a graph.

Outputs are private by default. Explicitly approve **Allow this step’s output in customer replies and AI answers** to use a code/API result in a reply template or as cited model evidence. Subflow inputs retain their source visibility; passing private output through an input does not make it usable in a template. Owners/admins are responsible for approving a component's output contract. Never put credentials in source code, fixed inputs, public URLs, or return values.

**Load recent step runs** shows the latest 30 custom executions, outputs, logs, and failures to staff. Completed results are stored independently of graph checkpoints and reused after recovery. Pure code/read steps may repeat after a crash before their result was recorded; they must have no external write effects. Results follow their parent conversation's retention/deletion lifecycle.

## Python and JavaScript

Create a Python or JavaScript step, define input/output JSON schemas, and implement `run(input)` returning a JSON object:

```python
def run(input):
    print("Checked refund eligibility")
    return {"eligible": input["ageDays"] <= 30}
```

```javascript
async function run(input) {
  return { eligible: input.ageDays <= 30 };
}
```

Schemas are closed objects with `additionalProperties: false`. The editor supplies an example; change both the code and schemas for your use case. **Test this step** runs the current draft against the supplied JSON. Code has Python/Node standard libraries, no network, application files, provider credentials, or Docker socket. Use a customer API read for data retrieval and a Governed action for writes. Arbitrary shell steps, package installation, filesystem persistence, and model-generated code execution are not provided.

### Enable the optional runner

The default installation can use templates, conditions, API steps, and subflows without a runner. Code steps fail visibly until the operator configures one. On the self-hosted Docker server, set in `.env`:

```dotenv
FIELDKIT_RUNNER_URL=http://runner:4319
FIELDKIT_RUNNER_TOKEN=REPLACE_WITH_A_RANDOM_SECRET_OF_AT_LEAST_32_CHARACTERS
```

`npm run setup` generates a random token for new installations. Existing operators can generate one with `openssl rand -hex 32`. Then run:

```sh
docker compose --profile code up -d --build
```

The runner service is internal and authenticated. It needs the host Docker socket to launch disposable containers; treat it as an installation-operator service with host-level Docker authority. Do not publish its port. For stronger separation, run it on a dedicated Docker host with a protected HTTPS endpoint and the same operator-managed token. Docker containers share the host kernel; this is resource isolation, not a claim of VM-strength isolation for mutually hostile tenants.

Each code execution runs non-root in a new container with a read-only root, no network/capabilities, no-new-privileges, a 16 MB temporary filesystem, 128 MB memory, half a CPU, and at most 32 processes. Execution is capped at 10 seconds, inputs at 16 KB, outputs at 32 KB, and logs at 8 KB. The runner accepts two concurrent executions; excess work follows the step's failure route. The runtime image must already exist (`--pull=never`). To customize standard libraries, operators can build and select a fixed `FIELDKIT_CODE_IMAGE` on the runner; workspace users cannot choose images or container flags.

Verify actual execution on a Docker-enabled machine:

```sh
docker build -f runner/Dockerfile -t fieldkit-runner:local .
npm run test:runner
```

## API steps

- **Public JSON endpoint (GET):** a fixed public HTTPS URL returning a JSON object. No credentials or request parameters are sent; inputs are not substituted into the URL. It works for anonymous visitors, for example a service-status endpoint. DNS and response limits apply, private-network destinations and redirects are blocked.
- **Existing customer read action:** choose an enabled `custom_read` from **Actions**. The editor copies its schemas. Map the action's parameters, and choose a verified test customer with the required reviewed provider mapping. Navigated Support sends the existing action envelope with its server-derived identity, authentication, and stable operation ID. The endpoint must implement a read even though the envelope is sent by POST. Writes cannot be selected here.

Read authority is checked again before using a result, publishing a reply, executing a later governed action, or delivering a queued Zendesk reply. Revoked mappings, disabled actions, changed policies, and changed credentials invalidate the result.

## Subflows

Choose **New subflow**, name it, and define its input/output schemas. The same canvas edits its steps. Use `inputs.FIELD` to consume the caller's mappings. Add **Return from subflow**, choose `done` or `failed`, and map returned fields. The caller can read `steps.SUBFLOW_ID.output.FIELD` and route on the selected outcome. **Reply** or **Human handoff** inside a subflow ends the entire customer turn instead of returning to the caller.

Test with **Subflow test input JSON**, then **Save subflow version**. Your main draft is preserved while editing the library. Reusable graphs may contain knowledge, model decisions with branch-specific instructions, verified account lookups, existing governed actions, and other subflows. The combined graph enforces the same approval and identity checks.

The editor allows 24 nodes per graph, up to three nested subflow levels, and at most 96 expanded runtime nodes. Across the whole turn the limits remain three model decisions, one account lookup, one governed action, and eight code/API steps. Graphs are acyclic; recursion and missing outcomes are rejected before publication.
