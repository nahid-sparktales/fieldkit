import { useEffect, useRef, useState } from "react";
import { api, useLoad } from "./request.js";
import { useAction } from "./useAction.js";
import { Field, Inspect, Notice, link, type Row } from "./quality-ui.js";
import { LoadingState } from "./ui.js";
import "./shadow.css";
import { useFormDraft } from "./form-draft.js";
import { MODEL_PROVIDERS } from "../../../packages/platform/src/model-providers.js";
const words = (s: string) => s.replaceAll("_", " ");
export function ShadowPage({ ws, role }: { ws: string; role: string }) {
  const l = useLoad(() => api(ws, "/shadow"), [ws]),
    a = useAction(),
    admin = ["owner", "admin"].includes(role);
  const candidateDraft = useFormDraft(`${ws}:candidate`);
  const [selected, setSelected] = useState(""),
    [filter, setFilter] = useState("all"),
    [loadedAt, setLoadedAt] = useState("");
  useEffect(() => {
    if (l.data) setLoadedAt(new Date().toLocaleTimeString());
  }, [l.data]);
  const [launch, setLaunch] = useState(""),
    [rollout, setRollout] = useState("");
  const detail = useLoad(
    () =>
      selected
        ? api(ws, `/shadow/experiments/${selected}`)
        : Promise.resolve(null),
    [ws, selected],
  );
  const reload = useRef(() => {
    l.reload();
    detail.reload();
  });
  reload.current = () => {
    l.reload();
    detail.reload();
  };
  useEffect(() => {
    const source = new EventSource(`/v2/workspaces/${ws}/shadow/events`);
    source.onmessage = () => reload.current();
    return () => source.close();
  }, [ws]);
  const control = (id: string) =>
    a.run(async () => {
      await api(ws, `/shadow/experiments/${id}`, { action: "stop" }, "PATCH");
      reload.current();
    }, "Shadow experiment stopped. In-flight model charges remain recorded.");
  return (
    <div className="quality-page shadow-page">
      <header>
        <span className="eyebrow">TEST, OBSERVE, THEN RELEASE</span>
        <h1>Shadow & rollout</h1>
        <p>
          Compare a candidate with real conversation history before allowing it
          to send replies. Shadow evaluations have no customer-visible effects.
        </p>
        <a href={link(ws, "test lab")}>Test Lab scenarios ↗</a> ·{" "}
        <a href={link(ws, "workflow")}>Workflow editor ↗</a>
      </header>
      <Notice action={a} error={l.error || detail.error} />
      {l.error && (
        <div className="load-recovery">
          <p>
            {l.data
              ? `Showing results loaded at ${loadedAt}. The latest update failed.`
              : "Experiments and rollout status could not be loaded. Try again to see their current status."}
          </p>
          <button disabled={l.loading} onClick={l.reload}>
            Try again
          </button>
        </div>
      )}
      {l.loading && !l.data && <LoadingState label="Loading experiments…" />}
      {admin && (
        <details className="panel" hidden={!l.data}>
          <summary>Create an immutable candidate</summary>
          <p>
            Save your workflow draft first. This snapshots the graph,
            components, model settings, policies and approved knowledge. It does
            not publish the workflow.
          </p>
          <form
            ref={candidateDraft}
            className="shadow-form"
            onSubmit={(e) => {
              e.preventDefault();
              const form = e.currentTarget,
                values = new FormData(form);
              const draftChannel = String(values.get("draftChannel"));
              void a.run(async () => {
                const draft = await api(
                  ws,
                  `/workflow?channel=${draftChannel}`,
                );
                await api(ws, "/shadow/candidates", {
                  name: values.get("name"),
                  channel: values.get("channel"),
                  draftChannel,
                  revision: draft.revision,
                  ...(values.get("model")
                    ? { model: values.get("model") }
                    : {}),
                  ...(values.get("provider")
                    ? { provider: values.get("provider") }
                    : {}),
                });
                form.reset();
                l.reload();
              }, "Candidate created without changing the published workflow.");
            }}
          >
            <Field label="Candidate name">
              <input required maxLength={100} name="name" />
            </Field>
            <Field label="Target channel">
              <select name="channel" defaultValue="portal">
                <option value="portal">Tickets</option>
                <option value="widget">Chatbot</option>
                <option value="zendesk">Zendesk</option>
              </select>
            </Field>
            <Field label="Saved workflow draft">
              <select name="draftChannel" defaultValue="default">
                <option value="default">Workspace default</option>
                <option value="portal">Tickets override</option>
                <option value="widget">Chatbot override</option>
                <option value="zendesk">Zendesk override</option>
              </select>
            </Field>
            <Field label="Candidate response provider">
              <select name="provider" defaultValue="">
                <option value="">Use saved workflow settings</option>
                {Object.entries(MODEL_PROVIDERS).map(([id, provider]) => (
                  <option key={id} value={id}>
                    {provider.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Candidate response model (optional)">
              <input
                name="model"
                maxLength={200}
                placeholder="Use saved workflow settings"
              />
            </Field>
            <p className="subtle">
              Overrides apply to candidate response steps only. Connect the
              provider first. Retrieval and the optional judge keep their
              baseline settings.
            </p>
            <button disabled={a.busy} className="primary">
              Snapshot candidate
            </button>
          </form>
        </details>
      )}
      {l.data && (
        <>
          <section className="panel">
            <h2>Candidates</h2>
            {!l.data?.candidates.length && (
              <p>No candidates yet. Save a workflow and snapshot it here.</p>
            )}
            {l.data?.candidates.map((c: Row) => (
              <article className="shadow-list-row" key={c.id}>
                <div>
                  <strong>{c.name}</strong>
                  <p>
                    {c.snapshot.channel} · Immutable v{c.workflow_version} ·{" "}
                    {c.stale
                      ? "Stale dependencies — create a new candidate"
                      : "Current dependencies"}
                  </p>
                </div>
                {admin && (
                  <button
                    disabled={c.stale || a.busy}
                    onClick={() => setLaunch(launch === c.id ? "" : c.id)}
                  >
                    Configure shadow test
                  </button>
                )}
                {launch === c.id && (
                  <ShadowLaunch
                    ws={ws}
                    candidate={c}
                    onDone={() => {
                      setLaunch("");
                      l.reload();
                    }}
                  />
                )}
              </article>
            ))}
          </section>
          <section className="panel">
            <h2>Shadow experiments</h2>
            {!l.data?.experiments.length && (
              <p>
                Sampling is off. Starting an experiment requires an explicit
                token budget.
              </p>
            )}
            {l.data?.experiments.map((e: Row) => (
              <article className="shadow-list-row" key={e.id}>
                <div>
                  <strong>{e.name}</strong>
                  <p>
                    {words(e.status)} · {e.config.samplePercent}% sample · Ends{" "}
                    {new Date(e.ends_at).toLocaleString()}
                  </p>
                  <p>
                    {Object.entries(e.counts ?? {})
                      .map(([state, count]) => `${count} ${words(state)}`)
                      .join(" · ") || "No new traffic yet"}
                  </p>
                  <small>
                    {e.tokens} reported tokens · {e.reserved} unresolved
                    reservations{e.reason ? ` · ${e.reason}` : ""}
                  </small>
                </div>
                <div className="quality-actions">
                  <button
                    aria-pressed={selected === e.id}
                    onClick={() => setSelected(e.id)}
                  >
                    Inspect comparisons
                  </button>
                  {admin && e.status === "active" && (
                    <button
                      className="danger-button"
                      disabled={a.busy}
                      onClick={() => control(e.id)}
                    >
                      Stop shadow test
                    </button>
                  )}
                  {admin && (
                    <button
                      onClick={() => setRollout(rollout === e.id ? "" : e.id)}
                    >
                      Review live rollout
                    </button>
                  )}
                </div>
                {rollout === e.id && (
                  <CanaryLaunch
                    ws={ws}
                    experiment={e}
                    onDone={() => {
                      setRollout("");
                      l.reload();
                    }}
                  />
                )}
              </article>
            ))}
          </section>
          {detail.data && (
            <section className="panel" aria-label="Shadow comparisons">
              <h2>Comparisons</h2>
              <p>{detail.data.interpretation}</p>
              {detail.data.stale && (
                <p className="error">
                  Dependencies changed. Outputs are hidden and this evidence
                  cannot authorize rollout.
                </p>
              )}
              <Field label="Comparison status">
                <select
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                >
                  {[
                    "all",
                    "completed",
                    "blocked_missing_fixture",
                    "blocked",
                    "failed",
                    "uncertain",
                    "canceled",
                    "excluded",
                    "missing_baseline",
                    "queued",
                    "waiting_baseline",
                    "budget_exhausted",
                  ].map((v) => (
                    <option key={v} value={v}>
                      {words(v)}
                    </option>
                  ))}
                </select>
              </Field>
              {detail.data.results
                .filter((r: Row) => filter === "all" || r.status === filter)
                .map((r: Row) => (
                  <Comparison
                    key={r.id}
                    ws={ws}
                    result={r}
                    admin={admin}
                    reload={() => reload.current()}
                  />
                ))}
            </section>
          )}
          <section className="panel">
            <h2>Live rollouts</h2>
            <p>
              Only new eligible conversations are sampled. Existing assignments
              keep their version. The kill switch revokes unsent candidate work;
              requests already sent retain their original reconciliation rules.
            </p>
            {!l.data?.rollouts.length && (
              <p>No live rollout has been enabled.</p>
            )}
            {l.data?.rollouts.map((r: Row) => (
              <LiveRollout
                key={r.id}
                ws={ws}
                row={r}
                admin={admin}
                reload={l.reload}
              />
            ))}
          </section>
        </>
      )}
    </div>
  );
}
function ShadowLaunch({
  ws,
  candidate,
  onDone,
}: {
  ws: string;
  candidate: Row;
  onDone: () => void;
}) {
  const a = useAction(),
    draftRef = useFormDraft(`${ws}:shadow:${candidate.id}`);
  return (
    <form
      ref={draftRef}
      className="shadow-launch"
      onSubmit={(e) => {
        e.preventDefault();
        const d = new FormData(e.currentTarget);
        void a.run(async () => {
          await api(ws, "/shadow/experiments", {
            candidateId: candidate.id,
            samplePercent: Number(d.get("percent")),
            hours: Number(d.get("hours")),
            maxSamples: Number(d.get("samples")),
            concurrency: Number(d.get("concurrency")),
            perRunTokenCap: Number(d.get("perRun")),
            tokenCap: Number(d.get("total")),
            productionReserve: Number(d.get("reserve")),
            verifiedOnly: d.get("verified") === "on",
            judge: d.get("judge") === "on",
            authorizedPaid: true,
            requestKey: crypto.randomUUID(),
          });
          onDone();
        });
      }}
    >
      <h3>Shadow test budget and sampling</h3>
      <Notice action={a} />
      <div className="shadow-form">
        {[
          ["percent", "Sample of new turns (%)", 10, 1, 100],
          ["hours", "Maximum duration (hours)", 24, 1, 168],
          ["samples", "Maximum sampled turns", 100, 1, 10000],
          ["concurrency", "Concurrent shadow evaluations", 1, 1, 2],
          ["perRun", "Token cap per comparison", 20000, 1000, 100000],
          ["total", "Total experiment token cap", 100000, 1000, 10000000],
          ["reserve", "Tokens reserved for production", 50000, 10000, 10000000],
        ].map(([key, label, value, min, max]) => (
          <Field key={String(key)} label={String(label)}>
            <input
              name={String(key)}
              type="number"
              defaultValue={Number(value)}
              min={Number(min)}
              max={Number(max)}
              required
            />
          </Field>
        ))}
      </div>
      <label className="check-label">
        <input type="checkbox" name="verified" defaultChecked />
        Only verified customers
      </label>
      <label className="check-label">
        <input type="checkbox" name="judge" />
        Add AI quality assessment using the candidate’s response model (shares
        the cap)
      </label>
      <label className="check-label">
        <input type="checkbox" required />I authorize model charges within these
        limits. Sampling starts with new turns only.
      </label>
      <button className="primary" disabled={a.busy}>
        Start shadow test
      </button>
    </form>
  );
}
function Comparison({
  ws,
  result: r,
  admin,
  reload,
}: {
  ws: string;
  result: Row;
  admin: boolean;
  reload: () => void;
}) {
  const a = useAction(),
    reviewDraft = useFormDraft(`${ws}:review:${r.id}`);
  return (
    <details className="shadow-comparison">
      <summary>
        {words(r.status)} · {new Date(r.created_at).toLocaleString()} ·{" "}
        {r.source_revision} turn revision
      </summary>
      <Notice action={a} />
      {r.error && <p className="error">{r.error}</p>}
      <p>
        <a href={link(ws, "inbox", `&conversation=${r.conversation_id}`)}>
          Source conversation ↗
        </a>{" "}
        ·{" "}
        <a href={link(ws, "test lab", `&importShadow=${r.id}`)}>
          Create reviewed regression draft ↗
        </a>
      </p>
      <div className="shadow-answers">
        <section>
          <h3>Actual baseline</h3>
          <p>{r.baseline?.answer || "No delivered baseline response"}</p>
          <small>Production execution: {r.baseline_ms ?? "unknown"} ms</small>
          <Inspect title="Baseline evidence and steps" value={r.baseline} />
        </section>
        <section>
          <h3>Candidate (never sent)</h3>
          <p>{r.output?.answer || "No completed candidate answer"}</p>
          <small>
            Shadow execution: {r.execution_ms ?? "unknown"} ms · Queue wait:{" "}
            {r.started_at
              ? new Date(r.started_at).getTime() -
                new Date(r.created_at).getTime()
              : "unknown"}{" "}
            ms
          </small>
          <Inspect
            title="Candidate citations, steps and proposed action"
            value={r.output}
          />
        </section>
      </div>
      <h3>Rule checks</h3>
      {r.rules?.map((rule: Row) => (
        <p key={rule.name}>
          {rule.passed ? "✓ Passed" : "✕ Failed"} · {rule.name}
          {rule.hard ? " (required)" : ""}
        </p>
      ))}
      {!r.rules && <p>No completed rule checks.</p>}
      <h3>AI quality assessment</h3>
      {r.judge ? (
        <Inspect title="Evidence-based advisory assessment" value={r.judge} />
      ) : (
        <p>Not run. AI judgments do not override rule failures.</p>
      )}
      <Inspect
        title="Model usage and unresolved reservations"
        value={r.usage ?? []}
      />
      <h3>Staff review</h3>
      {r.reviews.map((v: Row, i: number) => (
        <p key={i}>
          {words(v.verdict)} · {v.note} · {new Date(v.at).toLocaleString()}
        </p>
      ))}
      {r.status === "completed" && (
        <form
          ref={reviewDraft}
          onSubmit={(e) => {
            e.preventDefault();
            const form = e.currentTarget,
              d = new FormData(form);
            void a.run(async () => {
              await api(ws, `/shadow/results/${r.id}/review`, {
                verdict: d.get("verdict"),
                note: d.get("note"),
              });
              form.reset();
              reload();
            }, "Review recorded; original assessments retained.");
          }}
        >
          <Field label="Verdict">
            <select name="verdict">
              <option value="needs_review">Needs review</option>
              <option value="pass">Pass</option>
              <option value="fail">Fail</option>
            </select>
          </Field>
          <Field label="Review notes">
            <textarea required maxLength={2000} name="note" />
          </Field>
          <button disabled={a.busy}>Record staff review</button>
        </form>
      )}
      {admin &&
        ["failed", "uncertain", "blocked_missing_fixture"].includes(
          r.status,
        ) && (
          <button
            disabled={a.busy}
            onClick={() => {
              if (
                confirm(
                  "Retry this comparison? An interrupted model request may already have been charged. The original reservation stays visible.",
                )
              )
                void a.run(async () => {
                  await api(
                    ws,
                    `/shadow/experiments/${r.experiment_id}`,
                    {
                      action: "retry",
                      resultId: r.id,
                      acknowledgeUncertain: true,
                    },
                    "PATCH",
                  );
                  reload();
                });
            }}
          >
            Explicitly retry unfinished comparison
          </button>
        )}
    </details>
  );
}
function CanaryLaunch({
  ws,
  experiment,
  onDone,
}: {
  ws: string;
  experiment: Row;
  onDone: () => void;
}) {
  const a = useAction(),
    draftRef = useFormDraft(`${ws}:canary:${experiment.id}`);
  return (
    <form
      ref={draftRef}
      className="shadow-launch"
      onSubmit={(e) => {
        e.preventDefault();
        const d = new FormData(e.currentTarget);
        void a.run(async () => {
          await api(ws, "/rollouts", {
            experimentId: experiment.id,
            percent: Number(d.get("percent")),
            hours: Number(d.get("hours")),
            tokenCap: Number(d.get("cap")),
            reviewThreshold: Number(d.get("threshold")),
            maxFailures: Number(d.get("failures")),
            authorizedLiveEffects: true,
            decision: d.get("decision"),
            requestKey: crypto.randomUUID(),
          });
          onDone();
        });
      }}
    >
      <h3>Enable a limited live rollout</h3>
      <p className="callout">
        This sends real customer replies and can propose governed business
        actions. Existing reply reviews, action approvals and limits still
        apply. Any failed required rule prevents launch.
      </p>
      <Notice action={a} />
      <div className="shadow-form">
        <Field label="New conversations assigned to candidate">
          <select name="percent">
            {[1, 5, 10, 25, 50].map((v) => (
              <option key={v} value={v}>
                {v}%
              </option>
            ))}
          </select>
        </Field>
        {[
          ["hours", "Maximum rollout hours", 24, 1, 168],
          ["cap", "Candidate token cap", 100000, 1000, 10000000],
          [
            "threshold",
            "Required passing staff-reviewed comparisons",
            5,
            1,
            1000,
          ],
          ["failures", "Stop after handoff/stale failures", 1, 1, 100],
        ].map(([key, label, value, min, max]) => (
          <Field key={String(key)} label={String(label)}>
            <input
              required
              type="number"
              name={String(key)}
              defaultValue={Number(value)}
              min={Number(min)}
              max={Number(max)}
            />
          </Field>
        ))}
      </div>
      <Field label="Release decision">
        <textarea name="decision" required minLength={10} maxLength={2000} />
      </Field>
      <label className="check-label">
        <input type="checkbox" required />I reviewed the evidence and authorize
        real replies and existing governed actions for this limited rollout.
      </label>
      <button className="primary" disabled={a.busy}>
        Enable live rollout
      </button>
    </form>
  );
}
function LiveRollout({
  ws,
  row: r,
  admin,
  reload,
}: {
  ws: string;
  row: Row;
  admin: boolean;
  reload: () => void;
}) {
  const a = useAction(),
    [reason, setReason] = useState(""),
    [percent, setPercent] = useState(r.percent);
  const update = (action: string, extra = {}) =>
    a.run(async () => {
      await api(ws, `/rollouts/${r.id}`, { action, reason, ...extra }, "PATCH");
      reload();
    }, "Rollout updated.");
  return (
    <article className="shadow-list-row">
      <div>
        <h3>{r.name}</h3>
        <p>
          {r.status} · {r.percent}% · {r.assigned} candidate conversations ·{" "}
          {r.tokens} tokens
        </p>
        <p>{r.reason || r.decision}</p>
        <small>Ends {new Date(r.ends_at).toLocaleString()}</small>
      </div>
      <Notice action={a} />
      {admin && r.status === "active" && (
        <div className="shadow-launch">
          <Field label="Reason for rollout change">
            <input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              required
            />
          </Field>
          <div className="quality-actions">
            <button
              className="danger-button"
              disabled={a.busy || !reason.trim()}
              onClick={() => update("stop")}
            >
              Stop rollout now
            </button>
            <select
              aria-label="Increase rollout percentage"
              value={percent}
              onChange={(e) => setPercent(Number(e.target.value))}
            >
              {[1, 5, 10, 25, 50]
                .filter((v) => v >= r.percent)
                .map((v) => (
                  <option key={v} value={v}>
                    {v}% of new conversations
                  </option>
                ))}
            </select>
            <button
              disabled={a.busy || !reason.trim() || percent <= r.percent}
              onClick={() => update("increase", { percent })}
            >
              Increase for new conversations
            </button>
            <button
              disabled={a.busy || !reason.trim()}
              onClick={() => {
                if (
                  confirm(
                    "Promote through normal workflow publication? The saved draft must exactly match this candidate and will become the published workflow.",
                  )
                )
                  void a.run(async () => {
                    const list = await api(ws, "/shadow"),
                      candidate = list.candidates.find(
                        (c: Row) => c.id === r.candidate_id,
                      ),
                      draft = await api(
                        ws,
                        `/workflow?channel=${candidate.draft_channel}`,
                      );
                    await api(
                      ws,
                      `/rollouts/${r.id}`,
                      {
                        action: "promote",
                        reason,
                        draftRevision: draft.revision,
                      },
                      "PATCH",
                    );
                    reload();
                  });
              }}
            >
              Review and publish to everyone
            </button>
          </div>
        </div>
      )}
    </article>
  );
}
