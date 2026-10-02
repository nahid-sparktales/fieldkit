import { useState } from "react";
import { LoadingState } from "./ui.js";
import { api, useLoad } from "./request.js";
import { useAction } from "./useAction.js";
import {
  Field,
  Inspect,
  Notice,
  useQuality,
  link,
  type Row,
} from "./quality-ui.js";
import { JobDetails } from "./TestLabPage.js";
import {
  QualitySettings,
  AnalysisInput,
  GapUpdate,
} from "../../../packages/platform/src/quality-contracts.js";
export function KnowledgeGapsPage({
  ws,
  admin,
  owner,
}: {
  ws: string;
  admin: boolean;
  owner: boolean;
}) {
  const l = useQuality(ws, "/knowledge/gaps"),
    settings = useLoad(() => api(ws, "/quality/settings"), [ws]),
    jobs = useQuality(ws, "/knowledge/analysis"),
    a = useAction();
  const [selected, setSelected] = useState(
      new URLSearchParams(location.search).get("gap") ?? "",
    ),
    [status, setStatus] = useState("all"),
    [cap, setCap] = useState("20000"),
    [job, setJob] = useState("");
  return (
    <div className="quality-page">
      <h2>Knowledge gaps</h2>
      <p>
        Review unanswered questions and customer feedback. Identity issues,
        provider outages, and deliberate handoffs are classified separately from
        missing documentation.
      </p>
      <Notice action={a} error={l.error || settings.error || jobs.error} />
      <Field label="Gap status">
        <select value={status} onChange={(e) => setStatus(e.target.value)}>
          {["all", "open", "in_progress", "resolved", "dismissed"].map((v) => (
            <option key={v} value={v}>
              {v.replace("_", " ")}
            </option>
          ))}
        </select>
      </Field>
      <div
        className={selected ? "quality-grid" : "quality-grid quality-single"}
      >
        <section className="panel">
          <h3>Question groups</h3>
          {!l.data && !l.error && (
            <LoadingState label="Loading knowledge gaps…" />
          )}
          {l.data?.length > 0 &&
            !l.data.some(
              (g: Row) => status === "all" || g.status === status,
            ) && (
              <p className="muted">
                No gaps with this status. Choose another filter to see your
                question groups.
              </p>
            )}
          {l.data
            ?.filter((g: Row) => status === "all" || g.status === status)
            .map((g: Row) => (
              <button
                className="quality-list-item"
                key={g.id}
                aria-pressed={selected === g.id}
                onClick={() => setSelected(g.id)}
              >
                {g.title}
                <small>
                  {g.occurrences} occurrences ·{" "}
                  {g.category.replaceAll("_", " ")} ·{" "}
                  {g.status.replace("_", " ")}
                  {g.last_occurrence
                    ? ` · ${new Date(g.last_occurrence).toLocaleDateString()}`
                    : ""}
                </small>
              </button>
            ))}
          {l.data?.length === 0 && (
            <p>
              No questions need review yet. Gaps appear when the agent lacks
              evidence or a customer leaves negative feedback. You can also flag
              a conversation in the inbox.
            </p>
          )}
          {selected && (
            <button onClick={() => setSelected("")}>Clear selection</button>
          )}
        </section>
        {selected && (
          <GapDetails
            key={selected}
            ws={ws}
            id={selected}
            admin={admin}
            groups={l.data ?? []}
            reload={l.reload}
          />
        )}
      </div>
      {admin && (
        <section className="panel">
          <h3>Analyze new evidence</h3>
          <p>
            Analyze up to 20 new or changed groups. Suggestions remain private
            and require review; publishing knowledge never resolves a gap
            automatically.
          </p>
          <Field label="Analysis token cap">
            <input
              type="number"
              min="1000"
              value={cap}
              onChange={(e) => setCap(e.target.value)}
            />
          </Field>
          <button
            className="primary"
            disabled={a.busy}
            onClick={() =>
              void a.run(async () => {
                const run = await api(
                  ws,
                  "/knowledge/analysis",
                  AnalysisInput.parse({
                    tokenCap: Number(cap),
                    ...(selected ? { gapIds: [selected] } : {}),
                  }),
                );
                setJob(run.id);
                jobs.reload();
              }, "Analysis queued.")
            }
          >
            Analyze now{selected ? " (selected gap)" : ""}
          </button>
        </section>
      )}
      {owner && settings.data && (
        <AnalysisSchedule
          key={`${settings.data.nightly}:${settings.data.daily_token_cap}`}
          ws={ws}
          settings={settings.data}
          reload={settings.reload}
        />
      )}
      {admin && (
        <details className="panel">
          <summary>Scan retained historical handoffs</summary>
          <p>
            This explicit scan records candidates from up to 100 handoffs in the
            past 30 days. It makes no model calls.
          </p>
          <button
            disabled={a.busy}
            onClick={() =>
              void a.run(async () => {
                await api(ws, "/knowledge/gap-scan", { days: 30, limit: 100 });
                l.reload();
              }, "Historical scan finished.")
            }
          >
            Scan last 30 days
          </button>
        </details>
      )}
      <section className="panel">
        <h3>Analysis history</h3>
        {jobs.data?.length === 0 && (
          <p className="muted">
            No analysis runs yet. Analyze new evidence above when you have
            questions to review.
          </p>
        )}
        {jobs.data?.map((j: Row) => (
          <button
            className="quality-list-item"
            key={j.id}
            onClick={() => setJob(j.id)}
          >
            {new Date(j.created_at).toLocaleString()} · {j.status}
          </button>
        ))}
      </section>
      {job && <JobDetails key={job} ws={ws} id={job} admin={admin} />}
    </div>
  );
}
function AnalysisSchedule({
  ws,
  settings,
  reload,
}: {
  ws: string;
  settings: Row;
  reload: () => void;
}) {
  const a = useAction(),
    [enabled, setEnabled] = useState(settings.nightly),
    [cap, setCap] = useState(String(settings.daily_token_cap));
  return (
    <details className="panel">
      <summary>Nightly analysis · {enabled ? "enabled" : "disabled"}</summary>
      <p>
        Runs at 02:00 UTC. The daily cap covers manual and scheduled analysis
        when set, and remains within the workspace budget.
      </p>
      <label>
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
        />{" "}
        Enable nightly analysis
      </label>
      <Field label="Daily analysis token cap">
        <input
          type="number"
          min="0"
          value={cap}
          onChange={(e) => setCap(e.target.value)}
        />
      </Field>
      <button
        disabled={a.busy}
        onClick={() =>
          void a.run(async () => {
            await api(
              ws,
              "/quality/settings",
              QualitySettings.parse({
                nightly: enabled,
                dailyTokenCap: Number(cap),
              }),
              "PUT",
            );
            reload();
          }, "Analysis settings saved.")
        }
      >
        Save analysis settings
      </button>
      <Notice action={a} />
    </details>
  );
}
function GapDetails({
  ws,
  id,
  admin,
  groups,
  reload,
}: {
  ws: string;
  id: string;
  admin: boolean;
  groups: Row[];
  reload: () => void;
}) {
  const l = useQuality(ws, `/knowledge/gaps/${id}`),
    a = useAction(),
    [status, setStatus] = useState("in_progress"),
    [reason, setReason] = useState(""),
    [target, setTarget] = useState("");
  const g = l.data;
  return (
    <section className="panel">
      <Notice action={a} error={l.error} />
      {g && (
        <>
          <h3>{g.title}</h3>
          <p>
            {g.status.replace("_", " ")} · {g.category.replaceAll("_", " ")}
          </p>
          {g.reason && <p>{g.reason}</p>}
          <h4>Supporting conversations</h4>
          {g.occurrences.map((o: Row) => (
            <div className="quality-turn" key={o.id}>
              <a href={link(ws, "inbox", `&conversation=${o.conversation_id}`)}>
                {o.subject}
              </a>
              <p>{o.question}</p>
              <small>
                {o.reason} · {new Date(o.created_at).toLocaleString()}
              </small>
              <Inspect title="Cited sources" value={o.citations} />
              <Inspect title="Customer feedback" value={o.feedback} />
            </div>
          ))}
          <a className="button" href={link(ws, "test lab", `&importGap=${id}`)}>
            Create regression test / Retest after changes
          </a>
          {g.regressionSuites?.map((s: Row) => (
            <p key={s.id}>
              <a href={link(ws, "test lab", `&suiteId=${s.id}`)}>
                Retest saved suite: {s.name}
              </a>
            </p>
          ))}
          {g.recommendation && (
            <>
              <h4>Analysis recommendation</h4>
              <p>{g.recommendation.explanation}</p>
              {g.recommendation.missingInformation?.map(
                (v: string, i: number) => (
                  <p key={i}>{v}</p>
                ),
              )}
              {g.recommendation.needsStaffInput && (
                <p>
                  Staff input required: conversation claims do not establish
                  company policy.
                </p>
              )}
              <Inspect
                title="Suggested FAQ and supporting evidence"
                value={g.recommendation}
              />
              {admin &&
                !g.recommendation.needsStaffInput &&
                !g.recommendation.unavailable && (
                  <button
                    disabled={a.busy}
                    onClick={() =>
                      void a.run(async () => {
                        await api(ws, `/knowledge/gaps/${id}/draft`, {});
                        l.reload();
                      }, "Private FAQ draft saved. Review it under Knowledge → FAQs.")
                    }
                  >
                    Create private FAQ draft
                  </button>
                )}
            </>
          )}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void a.run(async () => {
                await api(
                  ws,
                  `/knowledge/gaps/${id}`,
                  GapUpdate.parse({ status, reason }),
                  "PATCH",
                );
                l.reload();
                reload();
                setReason("");
              }, "Gap updated.");
            }}
          >
            <Field label="New gap status">
              <select
                value={status}
                onChange={(e) => setStatus(e.target.value)}
              >
                {["open", "in_progress", "resolved", "dismissed"].map((v) => (
                  <option key={v} value={v}>
                    {v.replace("_", " ")}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Evidence or dismissal reason">
              <textarea
                required={status === "resolved" || status === "dismissed"}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
            </Field>
            <button disabled={a.busy}>Update gap</button>
          </form>
          <details>
            <summary>Merge into another group</summary>
            <Field label="Destination group">
              <select
                value={target}
                onChange={(e) => setTarget(e.target.value)}
              >
                <option value="">Choose a group</option>
                {groups
                  .filter((g) => g.id !== id)
                  .map((g) => (
                    <option key={g.id} value={g.id}>
                      {g.title}
                    </option>
                  ))}
              </select>
            </Field>
            <button
              disabled={!target || a.busy}
              onClick={() =>
                void a.run(async () => {
                  await api(ws, `/knowledge/gaps/${id}/merge`, {
                    targetId: target,
                  });
                  reload();
                  l.reload();
                }, "Groups merged.")
              }
            >
              Merge groups
            </button>
          </details>
        </>
      )}
    </section>
  );
}
