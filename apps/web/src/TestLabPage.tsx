import { useEffect, useState } from "react";
import { api, useLoad } from "./request.js";
import { useAction } from "./useAction.js";
import { Field, Inspect, Notice, useQuality, type Row } from "./quality-ui.js";
import {
  SuiteInput,
  EvaluationInput,
} from "../../../packages/platform/src/quality-contracts.js";
import { MODEL_PROVIDERS } from "../../../packages/platform/src/model-providers.js";
const blank = () => ({
  id: crypto.randomUUID(),
  name: "New case",
  turns: [{ question: "", expected: {} }],
  fixtures: {},
  channel: "portal",
});
export function TestLabPage({ ws, admin }: { ws: string; admin: boolean }) {
  const suites = useLoad(() => api(ws, "/evaluation/suites"), [ws]),
    runs = useQuality(ws, "/evaluation/runs"),
    workflow = useLoad(() => api(ws, "/workflow"), [ws]),
    a = useAction();
  const [suite, setSuite] = useState<Row | null>(null),
    [caseIndex, setCaseIndex] = useState(0),
    [jobId, setJobId] = useState("");
  const [cap, setCap] = useState("20000"),
    [compare, setCompare] = useState(false),
    [models, setModels] = useState(["", ""]),
    [providers, setProviders] = useState(["", ""]),
    [definitions, setDefinitions] = useState(["", ""]),
    [versions, setVersions] = useState(["draft", "draft"]),
    [judge, setJudge] = useState(true),
    [judgeModel, setJudgeModel] = useState(""),
    [judgeProvider, setJudgeProvider] = useState("");
  const [fixtureText, setFixtureText] = useState("{}");
  const importConversation = new URLSearchParams(location.search).get(
      "importConversation",
    ),
    importGap = new URLSearchParams(location.search).get("importGap");
  const c = suite?.cases[caseIndex];
  const updateCase = (patch: Row) =>
    setSuite((s) =>
      s
        ? {
            ...s,
            cases: s.cases.map((v: Row, i: number) =>
              i === caseIndex ? { ...v, ...patch } : v,
            ),
          }
        : s,
    );
  const select = (s: Row, i = 0) => {
    setSuite(structuredClone(s));
    setCaseIndex(i);
    setFixtureText(JSON.stringify(s.cases[i]?.fixtures ?? {}, null, 2));
    a.setError("");
    a.setSuccess("");
  };
  useEffect(() => {
    const id = new URLSearchParams(location.search).get("suiteId");
    if (!suite && id && suites.data) {
      const found = suites.data.find((s: Row) => s.id === id);
      if (found) select(found);
    }
  }, [suites.data, suite?.id]);
  const syncFixtures = (): Row | null => {
    if (!suite) return null;
    const value = {
      ...suite,
      cases: suite.cases.map((v: Row, i: number) =>
        i === caseIndex ? { ...v, fixtures: JSON.parse(fixtureText) } : v,
      ),
    };
    setSuite(value);
    return value;
  };
  const chooseCase = (i: number) =>
    void a.run(async () => {
      const s = syncFixtures();
      if (s) select(s, i);
    });
  return (
    <div className="quality-page">
      <header>
        <span className="eyebrow">REPEATABLE CUSTOMER SCENARIOS</span>
        <h1>Test Lab</h1>
        <p>
          Compare workflows and response models before publishing. Account and
          API reads use fixtures; proposed business actions stop for inspection.
          Model calls use your connected account.
        </p>
      </header>
      <Notice action={a} error={suites.error || runs.error} />
      {(importConversation || importGap) && admin && (
        <section className="panel">
          <p>
            Review copied personal information and reference answers before
            saving this draft. Internal notes are excluded.
          </p>
          <button
            disabled={a.busy}
            onClick={() =>
              void a.run(async () => {
                const draft = await api(
                  ws,
                  importConversation
                    ? `/conversations/${importConversation}/test-case`
                    : `/knowledge/gaps/${importGap}/case`,
                );
                select({
                  name: "Imported regression",
                  revision: 0,
                  cases: [draft],
                });
              })
            }
          >
            Import draft case
          </button>
        </section>
      )}
      <div className="quality-grid">
        <section className="panel">
          <h2>Suites</h2>
          {admin && (
            <button
              onClick={() =>
                select({ name: "New suite", revision: 0, cases: [blank()] })
              }
            >
              New suite
            </button>
          )}
          {suites.data?.map((s: Row) => (
            <button
              className="quality-list-item"
              key={s.id}
              onClick={() => select(s)}
            >
              {s.name}
              <small>
                {s.cases.length} cases · revision {s.revision}
              </small>
            </button>
          ))}
          {suites.data?.length === 0 && (
            <p>No suites yet. Start with a question customers commonly ask.</p>
          )}
        </section>
        {suite && (
          <section className="panel quality-editor">
            <h2>Edit suite</h2>
            <fieldset disabled={!admin || a.busy}>
              <Field label="Suite name">
                <input
                  value={suite.name}
                  onChange={(e) => setSuite({ ...suite, name: e.target.value })}
                />
              </Field>
              <Field label="Case">
                <select
                  value={caseIndex}
                  onChange={(e) => chooseCase(Number(e.target.value))}
                >
                  {suite.cases.map((v: Row, i: number) => (
                    <option key={v.id} value={i}>
                      {v.name}
                    </option>
                  ))}
                </select>
              </Field>
              {c?.unavailable ? (
                <p>
                  This case is unavailable because its source conversation was
                  deleted. Remove it or recreate it with reviewed test data.
                </p>
              ) : (
                c && (
                  <>
                    <Field label="Case name">
                      <input
                        value={c.name}
                        onChange={(e) => updateCase({ name: e.target.value })}
                      />
                    </Field>
                    <Field label="Channel">
                      <select
                        value={c.channel ?? "portal"}
                        onChange={(e) =>
                          updateCase({ channel: e.target.value })
                        }
                      >
                        {["portal", "widget", "zendesk"].map((v) => (
                          <option key={v}>{v}</option>
                        ))}
                      </select>
                    </Field>
                    {c.turns.map((t: Row, i: number) => {
                      const edit = (patch: Row) =>
                          updateCase({
                            turns: c.turns.map((v: Row, j: number) =>
                              j === i ? { ...v, ...patch } : v,
                            ),
                          }),
                        expected = (patch: Row) =>
                          edit({ expected: { ...t.expected, ...patch } });
                      return (
                        <div className="quality-turn" key={i}>
                          <h3>Turn {i + 1}</h3>
                          <Field label={`Customer message ${i + 1}`}>
                            <textarea
                              value={t.question}
                              onChange={(e) =>
                                edit({ question: e.target.value })
                              }
                            />
                          </Field>
                          <Field label={`Expected outcome ${i + 1}`}>
                            <select
                              value={t.expected.intent ?? ""}
                              onChange={(e) =>
                                expected({
                                  intent: e.target.value || undefined,
                                })
                              }
                            >
                              <option value="">Any outcome</option>
                              {["answer", "clarify", "action", "handoff"].map(
                                (v) => (
                                  <option key={v}>{v}</option>
                                ),
                              )}
                            </select>
                          </Field>
                          <Field label={`Reference answer ${i + 1}`}>
                            <textarea
                              value={t.expected.reference ?? ""}
                              onChange={(e) =>
                                expected({ reference: e.target.value })
                              }
                            />
                          </Field>
                          <details>
                            <summary>
                              Exact route, citation and action checks
                            </summary>
                            <Field label="Required step IDs (comma separated)">
                              <input
                                value={(t.expected.nodes ?? []).join(",")}
                                onChange={(e) =>
                                  expected({
                                    nodes: e.target.value
                                      .split(",")
                                      .map((s) => s.trim())
                                      .filter(Boolean),
                                  })
                                }
                              />
                            </Field>
                            <Field label="Required knowledge source IDs">
                              <input
                                value={(t.expected.sources ?? []).join(",")}
                                onChange={(e) =>
                                  expected({
                                    sources: e.target.value
                                      .split(",")
                                      .map((s) => s.trim())
                                      .filter(Boolean),
                                  })
                                }
                              />
                            </Field>
                            <Field label="Expected action name">
                              <input
                                value={t.expected.actionName ?? ""}
                                onChange={(e) =>
                                  expected({
                                    actionName: e.target.value || undefined,
                                  })
                                }
                              />
                            </Field>
                            <Field label="Approval requirement">
                              <select
                                value={
                                  t.expected.requiresApproval === undefined
                                    ? ""
                                    : String(t.expected.requiresApproval)
                                }
                                onChange={(e) =>
                                  expected({
                                    requiresApproval:
                                      e.target.value === ""
                                        ? undefined
                                        : e.target.value === "true",
                                  })
                                }
                              >
                                <option value="">No check</option>
                                <option value="true">Approval required</option>
                                <option value="false">
                                  Within automatic limits
                                </option>
                              </select>
                            </Field>
                            <JsonEditor
                              label="Exact action parameters"
                              value={t.expected.parameters ?? {}}
                              save={(v) =>
                                expected({
                                  parameters:
                                    v === null
                                      ? null
                                      : Object.keys(v).length
                                        ? v
                                        : undefined,
                                })
                              }
                            />
                          </details>
                          {c.turns.length > 1 && (
                            <button
                              onClick={() =>
                                updateCase({
                                  turns: c.turns.filter(
                                    (_: Row, j: number) => j !== i,
                                  ),
                                })
                              }
                            >
                              Remove turn {i + 1}
                            </button>
                          )}
                        </div>
                      );
                    })}
                    <button
                      disabled={c.turns.length >= 10}
                      onClick={() =>
                        updateCase({
                          turns: [...c.turns, { question: "", expected: {} }],
                        })
                      }
                    >
                      Add customer turn
                    </button>
                    <details>
                      <summary>Customer, account and API fixtures</summary>
                      <p>
                        API step outputs are keyed by step ID. Missing fixtures
                        block the test. Python and JavaScript use the configured
                        isolated runner.
                      </p>
                      <Field label="Fixtures JSON">
                        <textarea
                          rows={12}
                          spellCheck={false}
                          value={fixtureText}
                          onChange={(e) => setFixtureText(e.target.value)}
                        />
                      </Field>
                      <Inspect
                        title="Fixture example"
                        value={{
                          customer: {
                            verified: true,
                            mappings: { stripe_test: "cus_fixture" },
                          },
                          account: {
                            billing: [
                              { mode: "test", charges: [], subscriptions: [] },
                            ],
                          },
                          steps: {
                            status: { output: { status: "operational" } },
                          },
                          dailyActionCount: 0,
                        }}
                      />
                    </details>
                    {c.sourceConversationId && (
                      <label>
                        <input
                          type="checkbox"
                          checked={!!c.personalDataReviewed}
                          onChange={(e) =>
                            updateCase({
                              personalDataReviewed: e.target.checked,
                            })
                          }
                        />{" "}
                        I reviewed copied personal information and selected
                        reference answers.
                      </label>
                    )}
                  </>
                )
              )}
              <div className="button-row">
                <button
                  onClick={() =>
                    void a.run(async () => {
                      const s = syncFixtures();
                      if (s)
                        select(
                          { ...s, cases: [...s.cases, blank()] },
                          s.cases.length,
                        );
                    })
                  }
                >
                  Add case
                </button>
                <button
                  onClick={() =>
                    select({
                      ...suite,
                      cases: suite.cases.filter(
                        (_: Row, i: number) => i !== caseIndex,
                      ),
                    })
                  }
                >
                  Remove case
                </button>
                <button
                  className="primary"
                  onClick={() =>
                    void a.run(async () => {
                      const s = syncFixtures()!;
                      const value = SuiteInput.parse({
                        name: s.name,
                        revision: s.revision,
                        cases: s.cases,
                      });
                      const saved = await api(
                        ws,
                        `/evaluation/suites${s.id ? "/" + s.id : ""}`,
                        value,
                        s.id ? "PUT" : "POST",
                      );
                      select(saved);
                      suites.reload();
                    }, "Suite saved.")
                  }
                >
                  {a.busy ? "Saving…" : "Save suite"}
                </button>
              </div>
            </fieldset>
            {admin && suite.id && (
              <fieldset disabled={a.busy}>
                <h3>Run saved cases</h3>
                <p>
                  Each run snapshots the saved cases, expanded workflow
                  components, policies, models, and knowledge versions. Save
                  your edits before launching.
                </p>
                <Field label="Run token cap">
                  <input
                    type="number"
                    min="1000"
                    max="10000000"
                    value={cap}
                    onChange={(e) => setCap(e.target.value)}
                  />
                </Field>
                <label>
                  <input
                    type="checkbox"
                    checked={compare}
                    onChange={(e) => setCompare(e.target.checked)}
                  />{" "}
                  Compare two variants
                </label>
                {Array.from({ length: compare ? 2 : 1 }, (_, i) => (
                  <div key={i}>
                    <h4>Variant {i + 1}</h4>
                    <ModelChoice
                      label={`Response ${i + 1}`}
                      model={models[i]}
                      provider={providers[i]}
                      setModel={(v) =>
                        setModels(models.map((m, j) => (i === j ? v : m)))
                      }
                      setProvider={(v) =>
                        setProviders(providers.map((m, j) => (i === j ? v : m)))
                      }
                    />
                    <Field label={`Workflow ${i + 1}`}>
                      <select
                        value={versions[i]}
                        onChange={(e) => {
                          const version = e.target.value;
                          void a.run(async () => {
                            const value =
                              version === "draft"
                                ? ""
                                : JSON.stringify(
                                    (
                                      await api(
                                        ws,
                                        `/workflow/versions/${version}`,
                                      )
                                    ).definition,
                                    null,
                                    2,
                                  );
                            setDefinitions((d) =>
                              d.map((v, j) => (j === i ? value : v)),
                            );
                            setVersions((d) =>
                              d.map((v, j) => (j === i ? version : v)),
                            );
                          });
                        }}
                      >
                        <option value="draft">Current draft</option>
                        {workflow.data?.versions.map((v: Row) => (
                          <option key={v.version} value={String(v.version)}>
                            Published v{v.version} · {v.title}
                          </option>
                        ))}
                      </select>
                    </Field>
                    <details>
                      <summary>Workflow definition override</summary>
                      <Field label={`Workflow JSON ${i + 1}`}>
                        <textarea
                          placeholder="Empty uses the current draft"
                          value={definitions[i]}
                          onChange={(e) =>
                            setDefinitions(
                              definitions.map((v, j) =>
                                i === j ? e.target.value : v,
                              ),
                            )
                          }
                        />
                      </Field>
                    </details>
                  </div>
                ))}
                <label>
                  <input
                    type="checkbox"
                    checked={judge}
                    onChange={(e) => setJudge(e.target.checked)}
                  />{" "}
                  Include separate AI quality assessment
                </label>
                {judge && (
                  <ModelChoice
                    label="Judge"
                    model={judgeModel}
                    provider={judgeProvider}
                    setModel={setJudgeModel}
                    setProvider={setJudgeProvider}
                  />
                )}
                <p>
                  Embeddings and the judge stay fixed across variants. AI scores
                  never override failed rules.
                </p>
                <button
                  className="primary"
                  onClick={() =>
                    void a.run(async () => {
                      const run = EvaluationInput.parse({
                        suiteId: suite.id,
                        tokenCap: Number(cap),
                        variants: Array.from(
                          { length: compare ? 2 : 1 },
                          (_, i) => ({
                            name: `Variant ${i + 1}`,
                            model: models[i] || undefined,
                            provider: providers[i] || undefined,
                            definition: definitions[i]
                              ? JSON.parse(definitions[i])
                              : undefined,
                          }),
                        ),
                        judge: {
                          enabled: judge,
                          model: judgeModel || undefined,
                          provider: judgeProvider || undefined,
                        },
                      });
                      const saved = await api(ws, "/evaluation/runs", run);
                      setJobId(saved.id);
                      runs.reload();
                    }, "Test run queued.")
                  }
                >
                  Launch test run
                </button>
              </fieldset>
            )}
          </section>
        )}
      </div>
      <section className="panel">
        <h2>Run history and comparisons</h2>
        {runs.data?.length === 0 && <p>No test runs yet.</p>}
        {runs.data?.map((r: Row) => (
          <button
            className="quality-list-item"
            key={r.id}
            onClick={() => setJobId(r.id)}
          >
            {new Date(r.created_at).toLocaleString()} · {r.status}
            <small>
              {r.output.completed ?? 0} completed · {r.output.blocked ?? 0}{" "}
              blocked
            </small>
          </button>
        ))}
      </section>
      {jobId && <JobDetails key={jobId} ws={ws} id={jobId} admin={admin} />}
    </div>
  );
}
function ModelChoice({
  label,
  model,
  provider,
  setModel,
  setProvider,
}: {
  label: string;
  model: string;
  provider: string;
  setModel: (v: string) => void;
  setProvider: (v: string) => void;
}) {
  return (
    <div className="quality-grid">
      <Field label={`${label} provider`}>
        <select value={provider} onChange={(e) => setProvider(e.target.value)}>
          <option value="">Workspace provider</option>
          {Object.entries(MODEL_PROVIDERS).map(([id, v]) => (
            <option key={id} value={id}>
              {v.name}
            </option>
          ))}
        </select>
      </Field>
      <Field label={`${label} model`}>
        <input
          placeholder="Workspace model"
          value={model}
          onChange={(e) => setModel(e.target.value)}
        />
      </Field>
    </div>
  );
}
function JsonEditor({
  label,
  value,
  save,
}: {
  label: string;
  value: Row;
  save: (v: Row | null) => void;
}) {
  const [text, setText] = useState(JSON.stringify(value, null, 2)),
    [error, setError] = useState("");
  return (
    <Field label={label}>
      <textarea
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          try {
            save(JSON.parse(e.target.value));
            setError("");
          } catch {
            setError("Enter valid JSON before saving.");
            save(null);
          }
        }}
      />
      <span role="alert">{error}</span>
    </Field>
  );
}
export function JobDetails({
  ws,
  id,
  admin,
}: {
  ws: string;
  id: string;
  admin: boolean;
}) {
  const l = useQuality(ws, `/quality/jobs/${id}`),
    a = useAction(),
    [ack, setAck] = useState(false),
    [cap, setCap] = useState("");
  const job = l.data;
  return (
    <section className="panel">
      <h2>Run details</h2>
      <Notice action={a} error={l.error} />
      {job && (
        <>
          <p>
            <strong>{job.status}</strong> · cap {job.token_cap.toLocaleString()}{" "}
            tokens
          </p>
          {job.error && <p role="alert">{job.error}</p>}
          {job.knowledgeChanged && (
            <p role="alert">
              Knowledge changed. Create a fresh run before relying on this
              comparison.
            </p>
          )}
          <Inspect title="Immutable run snapshot" value={job.snapshot} />
          <Inspect
            title="Reported usage and unresolved reservations"
            value={job.usage}
          />
          {admin && ["queued", "running"].includes(job.status) && (
            <button
              disabled={a.busy}
              onClick={() =>
                void a.run(async () => {
                  await api(
                    ws,
                    `/quality/jobs/${id}`,
                    { action: "cancel" },
                    "PATCH",
                  );
                  l.reload();
                }, "Cancellation recorded.")
              }
            >
              Cancel run
            </button>
          )}
          {admin &&
            ["failed", "uncertain", "budget_exhausted"].includes(
              job.status,
            ) && (
              <div>
                <label>
                  <input
                    type="checkbox"
                    checked={ack}
                    onChange={(e) => setAck(e.target.checked)}
                  />{" "}
                  I understand retrying an uncertain attempt may incur another
                  model charge.
                </label>
                <Field label="Revised total token cap (optional)">
                  <input
                    type="number"
                    min="1000"
                    value={cap}
                    onChange={(e) => setCap(e.target.value)}
                  />
                </Field>
                <button
                  disabled={!ack || a.busy}
                  onClick={() =>
                    void a.run(async () => {
                      await api(
                        ws,
                        `/quality/jobs/${id}`,
                        {
                          action: "retry",
                          acknowledgeRetry: ack,
                          ...(cap ? { tokenCap: Number(cap) } : {}),
                        },
                        "PATCH",
                      );
                      l.reload();
                    }, "Unfinished work queued.")
                  }
                >
                  Retry unfinished work
                </button>
              </div>
            )}
          <div className="quality-results">
            {[...job.results]
              .sort(
                (a: Row, b: Row) =>
                  a.case_id.localeCompare(b.case_id) ||
                  a.turn - b.turn ||
                  a.variant - b.variant,
              )
              .map((r: Row) => (
                <Result
                  key={r.id}
                  ws={ws}
                  job={job}
                  result={r}
                  reload={l.reload}
                />
              ))}
          </div>
        </>
      )}
    </section>
  );
}
function Result({
  ws,
  job,
  result: r,
  reload,
}: {
  ws: string;
  job: Row;
  result: Row;
  reload: () => void;
}) {
  const a = useAction(),
    [verdict, setVerdict] = useState("needs_review"),
    [note, setNote] = useState("");
  return (
    <article className="quality-result">
      <h3>
        {job.snapshot.cases?.find((c: Row) => c.id === r.case_id)?.name} ·{" "}
        {job.snapshot.variants?.[r.variant]?.name} · turn {r.turn + 1}
      </h3>
      <p>
        {r.status}
        {r.duration_ms != null ? ` · ${r.duration_ms} ms` : ""}
      </p>
      {r.error && <p role="alert">{r.error}</p>}
      <p className="preserve-lines">{r.output?.answer}</p>
      <Inspect
        title="Citations, visited steps and proposed action"
        value={r.output}
      />
      <h4>Rule checks</h4>
      {r.rules?.length ? (
        r.rules.map((check: Row, i: number) => (
          <p key={i}>
            {check.passed ? "✓ Pass" : "✕ Fail"} · {check.name}
          </p>
        ))
      ) : (
        <p>Not assessed.</p>
      )}
      <h4>AI quality assessment</h4>
      {r.judge ? (
        <>
          <p>
            Grounding {r.judge.grounding}/5 · Relevance {r.judge.relevance}/5 ·
            Completeness {r.judge.completeness}/5
          </p>
          <p>{r.judge.explanation}</p>
          <p>Reference: {r.judge.referenceConsistency}</p>
        </>
      ) : (
        <p>Not assessed. Rules remain independent.</p>
      )}
      <h4>Staff review</h4>
      {r.reviews.map((v: Row, i: number) => (
        <p key={i}>
          {v.verdict} · {v.note}{" "}
          <small>{new Date(v.at).toLocaleString()}</small>
        </p>
      ))}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void a.run(async () => {
            await api(
              ws,
              `/evaluation/runs/${job.id}/results/${r.id}/reviews`,
              { verdict, note },
            );
            setNote("");
            reload();
          }, "Review recorded. Original results retained.");
        }}
      >
        <Field label="Review verdict">
          <select value={verdict} onChange={(e) => setVerdict(e.target.value)}>
            <option value="needs_review">Needs review</option>
            <option value="pass">Pass</option>
            <option value="fail">Fail</option>
          </select>
        </Field>
        <Field label="Review explanation">
          <textarea
            required
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </Field>
        <button disabled={a.busy}>Record staff review</button>
      </form>
      <Notice action={a} />
    </article>
  );
}
