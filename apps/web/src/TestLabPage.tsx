import { useEffect, useId, useState } from "react";
import { confirmDiscardChanges, useUnsavedChanges } from "./unsaved-changes.js";
import { LoadingState } from "./ui.js";
import { api, useLoad } from "./request.js";
import { useAction } from "./useAction.js";
import { Field, Inspect, Notice, useQuality, type Row } from "./quality-ui.js";
import {
  SuiteInput,
  EvaluationInput,
} from "../../../packages/platform/src/quality-contracts.js";
import { MODEL_PROVIDERS } from "../../../packages/platform/src/model-providers.js";
function jsonObject(text: string): Row {
  const value = JSON.parse(text);
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Enter a JSON object with property names and values.");
  return value;
}
function jsonError(text: string) {
  try {
    jsonObject(text);
    return "";
  } catch {
    return "Enter a valid JSON object before saving.";
  }
}
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
  const [savedSuite, setSavedSuite] = useState<Row | null>(null),
    [jsonDrafts, setJsonDrafts] = useState<Record<string, string>>({}),
    [section, setSection] = useState<"cases" | "run" | "results">("cases");
  const dirty =
    !!suite &&
    (!suite.id ||
      JSON.stringify(suite) !== JSON.stringify(savedSuite) ||
      Object.keys(jsonDrafts).length > 0);
  const invalidJson = Object.values(jsonDrafts).some(
    (text) => !!jsonError(text),
  );
  useUnsavedChanges(dirty);
  useEffect(() => {
    setSuite(null);
    setSavedSuite(null);
    setJsonDrafts({});
    setCaseIndex(0);
    setJobId("");
    setSection("cases");
  }, [ws]);
  const editJson = (key: string, text: string) =>
    setJsonDrafts((old) => ({ ...old, [key]: text }));
  const importShadow = new URLSearchParams(location.search).get("importShadow");
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
  const select = (s: Row) => {
    setSuite(structuredClone(s));
    setSavedSuite(s.id ? structuredClone(s) : null);
    setCaseIndex(0);
    setJsonDrafts({});
    a.setError("");
    a.setSuccess("");
  };
  const chooseSuite = (s: Row) => {
    if (a.busy) return;
    if (s.id && s.id === suite?.id) return;
    if (
      dirty &&
      !confirmDiscardChanges("Discard unsaved changes to this test suite?")
    )
      return;
    select(s);
    setSection("cases");
  };
  useEffect(() => {
    const id = new URLSearchParams(location.search).get("suiteId");
    if (!suite && id && suites.data) {
      const found = suites.data.find((s: Row) => s.id === id);
      if (found) select(found);
    }
  }, [suites.data, suite?.id]);
  const suiteWithJson = (): Row => ({
    ...suite!,
    cases: suite!.cases.map((v: Row) => ({
      ...v,
      fixtures:
        jsonDrafts[`fixtures:${v.id}`] === undefined
          ? v.fixtures
          : jsonObject(jsonDrafts[`fixtures:${v.id}`]),
      turns: v.turns.map((t: Row, i: number) => {
        const text = jsonDrafts[`parameters:${v.id}:${i}`];
        if (text === undefined) return t;
        const parameters = jsonObject(text);
        return {
          ...t,
          expected: {
            ...t.expected,
            parameters: Object.keys(parameters).length ? parameters : undefined,
          },
        };
      }),
    })),
  });
  const saveSuite = () =>
    void a.run(async () => {
      const s = suiteWithJson();
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
      const selectedCase = s.cases[caseIndex]?.id;
      select(saved);
      setCaseIndex(
        Math.max(
          0,
          saved.cases.findIndex((v: Row) => v.id === selectedCase),
        ),
      );
      suites.reload();
    }, "Suite saved.");
  const removeTurn = (i: number) => {
    const prefix = `parameters:${c.id}:`;
    setJsonDrafts((old) =>
      Object.fromEntries(
        Object.entries(old).flatMap(([key, value]) => {
          if (!key.startsWith(prefix)) return [[key, value]];
          const index = Number(key.slice(prefix.length));
          return index === i
            ? []
            : [[`${prefix}${index > i ? index - 1 : index}`, value]];
        }),
      ),
    );
    updateCase({ turns: c.turns.filter((_: Row, j: number) => j !== i) });
  };
  return (
    <div className="quality-page test-lab-page">
      <header>
        <span className="eyebrow">REPEATABLE CUSTOMER SCENARIOS</span>
        <h1>Test Lab</h1>
        <a href={`/?workspace=${ws}&view=shadow%20%26%20rollout`}>
          Shadow comparisons and gradual rollout ↗
        </a>
        <p>
          Compare workflows and response models before publishing. Account and
          API reads use fixtures; proposed business actions stop for inspection.
          Model calls use your connected account.
        </p>
      </header>
      <nav className="test-lab-tabs" aria-label="Test Lab sections">
        {(
          [
            ["cases", "Cases"],
            ["run", "Run setup"],
            ["results", "Results"],
          ] as const
        )
          .filter(([value]) => admin || value !== "run")
          .map(([value, label]) => (
            <button
              key={value}
              aria-current={section === value ? "page" : undefined}
              onClick={() => setSection(value)}
            >
              {label}
            </button>
          ))}
      </nav>
      <Notice action={a} error={suites.error || runs.error} />
      {(importConversation || importGap || importShadow) && admin && (
        <section className="panel">
          <p>
            Review copied personal information and reference answers before
            saving this draft. Internal notes are excluded.
          </p>
          <button
            disabled={a.busy}
            onClick={() => {
              if (a.busy) return;
              void a.run(async () => {
                if (
                  dirty &&
                  !confirmDiscardChanges(
                    "Discard unsaved changes before importing a case?",
                  )
                )
                  return;
                const draft = await api(
                  ws,
                  importShadow
                    ? `/shadow/results/${importShadow}/case`
                    : importConversation
                      ? `/conversations/${importConversation}/test-case`
                      : `/knowledge/gaps/${importGap}/case`,
                );
                select({
                  name: "Imported regression",
                  revision: 0,
                  cases: [draft],
                });
              });
            }}
          >
            Import draft case
          </button>
        </section>
      )}
      <div className="test-lab-workspace" hidden={section === "results"}>
        <section className="panel test-lab-suites">
          <h2>Test suites</h2>
          <p className="muted">
            Group related customer scenarios so you can test them together.
          </p>
          {!suites.data && !suites.error && (
            <LoadingState label="Loading suites…" />
          )}
          {admin && (
            <button
              className="primary"
              disabled={a.busy}
              onClick={() =>
                chooseSuite({
                  name: "New suite",
                  revision: 0,
                  cases: [blank()],
                })
              }
            >
              New suite
            </button>
          )}
          {suites.data?.map((s: Row) => (
            <button
              className="quality-list-item"
              key={s.id}
              aria-pressed={suite?.id === s.id}
              disabled={a.busy}
              onClick={() => chooseSuite(s)}
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
        {!suite && (
          <section className="panel quality-onboarding">
            <span className="eyebrow">HOW IT WORKS</span>
            <h2>Confidence before you publish</h2>
            <ol>
              <li>
                <strong>Write a customer scenario</strong>
                <span>
                  Add a question, follow-ups, and what a good answer should do.
                </span>
              </li>
              <li>
                <strong>Run it with a token limit</strong>
                <span>
                  Use your workflow or compare two models. Connected model usage
                  is billed by your provider.
                </span>
              </li>
              <li>
                <strong>Review the evidence</strong>
                <span>
                  See answers, citations, rule checks, and optional AI
                  assessments side by side.
                </span>
              </li>
            </ol>
            <p className="muted">
              Tests use saved account and API fixtures. They never send customer
              replies or execute business actions.
            </p>
          </section>
        )}
        {suite && (
          <section className="panel quality-editor">
            <div className="test-lab-savebar">
              <div>
                <h2>{section === "run" ? "Run setup" : "Edit suite"}</h2>
                <p role="status">
                  {dirty
                    ? "Unsaved changes"
                    : `Saved · revision ${suite.revision}`}
                </p>
                {invalidJson && (
                  <p className="error">Fix the JSON fields before saving.</p>
                )}
              </div>
              {admin && (
                <div className="button-row">
                  {dirty && (
                    <button
                      disabled={a.busy}
                      onClick={() => {
                        if (
                          !confirmDiscardChanges(
                            "Discard unsaved changes to this test suite?",
                          )
                        )
                          return;
                        if (savedSuite) select(savedSuite);
                        else {
                          setSuite(null);
                          setJsonDrafts({});
                        }
                      }}
                    >
                      Discard changes
                    </button>
                  )}
                  <button
                    className="primary"
                    disabled={a.busy || !dirty}
                    onClick={saveSuite}
                  >
                    {a.busy ? "Saving…" : "Save suite"}
                  </button>
                </div>
              )}
            </div>
            <fieldset hidden={section !== "cases"} disabled={!admin || a.busy}>
              <Field label="Suite name">
                <input
                  value={suite.name}
                  onChange={(e) => setSuite({ ...suite, name: e.target.value })}
                />
              </Field>
              <Field label="Case">
                <select
                  value={caseIndex}
                  onChange={(e) => setCaseIndex(Number(e.target.value))}
                >
                  {suite.cases.map((v: Row, i: number) => (
                    <option key={v.id} value={i}>
                      {v.name}
                    </option>
                  ))}
                </select>
              </Field>
              {!c && (
                <p className="quality-empty">
                  No cases in this suite. Add a case to write a customer
                  scenario.
                </p>
              )}
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
                              key={`${c.id}:${i}`}
                              label="Exact action parameters"
                              value={
                                jsonDrafts[`parameters:${c.id}:${i}`] ??
                                JSON.stringify(
                                  t.expected.parameters ?? {},
                                  null,
                                  2,
                                )
                              }
                              onChange={(text) =>
                                editJson(`parameters:${c.id}:${i}`, text)
                              }
                            />
                          </details>
                          {c.turns.length > 1 && (
                            <button onClick={() => removeTurn(i)}>
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
                          value={
                            jsonDrafts[`fixtures:${c.id}`] ??
                            JSON.stringify(c.fixtures ?? {}, null, 2)
                          }
                          onChange={(e) =>
                            editJson(`fixtures:${c.id}`, e.target.value)
                          }
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
                  onClick={() => {
                    setSuite({ ...suite, cases: [...suite.cases, blank()] });
                    setCaseIndex(suite.cases.length);
                  }}
                >
                  Add case
                </button>
                <button
                  disabled={!c}
                  onClick={() => {
                    setSuite({
                      ...suite,
                      cases: suite.cases.filter(
                        (_: Row, i: number) => i !== caseIndex,
                      ),
                    });
                    setJsonDrafts((old) =>
                      Object.fromEntries(
                        Object.entries(old).filter(
                          ([key]) =>
                            key !== `fixtures:${c.id}` &&
                            !key.startsWith(`parameters:${c.id}:`),
                        ),
                      ),
                    );
                    setCaseIndex(Math.max(0, caseIndex - 1));
                  }}
                >
                  Remove case
                </button>
              </div>
            </fieldset>
            {admin && (
              <fieldset hidden={section !== "run"} disabled={a.busy}>
                <h3>Run saved cases</h3>
                <p>
                  Each run snapshots saved cases, workflow components, policies,
                  models, and knowledge versions.
                </p>
                <p className="test-lab-run-version" role="status">
                  {!suite.id
                    ? "Save this suite before running it."
                    : dirty
                      ? `Unsaved changes · save before running revision ${suite.revision}.`
                      : !suite.cases.length
                        ? "Add a case before running this suite."
                        : `Ready to run ${suite.name} · saved revision ${suite.revision}`}
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
                  disabled={
                    !suite.id || dirty || !suite.cases.length || invalidJson
                  }
                  onClick={() =>
                    void a.run(async () => {
                      if (
                        !suite.id ||
                        dirty ||
                        !suite.cases.length ||
                        invalidJson
                      )
                        return;
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
                      setSection("results");
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
      <section className="panel" hidden={section !== "results"}>
        <h2>Run history and comparisons</h2>
        {!runs.data && !runs.error && (
          <LoadingState label="Loading run history…" />
        )}
        {runs.data?.length === 0 && (
          <p className="muted">
            No test runs yet. Save a suite, then launch a run to start comparing
            results.
          </p>
        )}
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
      <div hidden={section !== "results"}>
        {jobId && <JobDetails key={jobId} ws={ws} id={jobId} admin={admin} />}
      </div>
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
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const errorId = useId();
  const error = jsonError(value);
  return (
    <Field label={label}>
      <textarea
        value={value}
        aria-invalid={!!error}
        aria-describedby={error ? errorId : undefined}
        onChange={(e) => onChange(e.target.value)}
      />
      <span id={errorId} role="alert">
        {error}
      </span>
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
