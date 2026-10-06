import { useEffect, useRef, useState } from "react";
import { api, useLoad } from "./request.js";
import { useAction } from "./useAction.js";
import { Field, Inspect, Notice, link, type Row } from "./quality-ui.js";
import { LoadingState } from "./ui.js";
import "./readiness.css";

const words = (value: string) => value.replaceAll("_", " ");
export function ReadinessPage({ ws, role }: { ws: string; role: string }) {
  const l = useLoad(() => api(ws, "/readiness"), [ws]);
  const a = useAction(),
    [selected, setSelected] = useState(""),
    [email, setEmail] = useState(""),
    [cap, setCap] = useState(6000),
    [ack, setAck] = useState(false),
    [note, setNote] = useState(""),
    [resource, setResource] = useState<Record<string, string>>({
      parameters: "{}",
    });
  const admin = role === "owner" || role === "admin";
  const [compact, setCompact] = useState(
    () => matchMedia("(max-width: 1050px)").matches,
  );
  const detailHeading = useRef<HTMLHeadingElement>(null);
  const detailTrigger = useRef<HTMLElement | null>(null);
  const listScroll = useRef(0);
  useEffect(() => {
    const query = matchMedia("(max-width: 1050px)");
    const change = () => setCompact(query.matches);
    query.addEventListener("change", change);
    return () => query.removeEventListener("change", change);
  }, []);
  useEffect(() => {
    if (!selected || !compact) return;
    const frame = requestAnimationFrame(() => {
      detailHeading.current?.focus({ preventScroll: true });
      detailHeading.current
        ?.closest("section")
        ?.scrollIntoView({ block: "start" });
    });
    return () => cancelAnimationFrame(frame);
  }, [selected, compact]);
  const inspect = (id: string, trigger: HTMLElement) => {
    detailTrigger.current = trigger;
    listScroll.current = window.scrollY;
    setSelected(id);
    setAck(false);
    a.setError("");
    a.setSuccess("");
  };
  const backToChecks = () => {
    setSelected("");
    setAck(false);
    requestAnimationFrame(() => {
      window.scrollTo({ top: listScroll.current });
      detailTrigger.current?.focus({ preventScroll: true });
    });
  };
  const h = useLoad(
    () =>
      selected
        ? api(ws, `/readiness/checks/${encodeURIComponent(selected)}`)
        : Promise.resolve(null),
    [ws, selected],
  );
  const reload = useRef(l.reload);
  reload.current = l.reload;
  const pending = l.data?.checks.some(
    (ch: Row) =>
      ch.result?.status === "running" || ch.result?.status === "queued",
  );
  useEffect(() => {
    const events = new EventSource(`/v2/workspaces/${ws}/readiness/events`);
    events.onmessage = () => reload.current();
    return () => events.close();
  }, [ws]);
  const checks: Row[] = l.data?.checks ?? [];
  const chosen = checks.find((ch) => ch.id === selected);
  const run = (ids: string[], effect = false) =>
    a.run(async () => {
      await api(ws, "/readiness/runs", {
        requestKey: crypto.randomUUID(),
        checkIds: ids,
        authorizedEffects: effect,
        tokenCap: effect ? cap : 0,
        ...(effect && chosen?.risk === "test_write"
          ? {
              testResource: {
                dedicated: true,
                ...Object.fromEntries(
                  Object.entries(resource).filter(
                    ([k, v]) => k !== "parameters" && v,
                  ),
                ),
                ...(resource.amountMinor
                  ? { amountMinor: Number(resource.amountMinor) }
                  : {}),
                parameters: JSON.parse(resource.parameters || "{}"),
              },
            }
          : {}),
        ...(effect && chosen?.risk === "test_email"
          ? { testEmail: email }
          : {}),
      });
      l.reload();
      h.reload();
      setAck(false);
    }, "Checks queued. Results will appear here; this does not publish or enable anything.");
  return (
    <div
      className={`quality-page readiness-page ${selected ? "has-selection" : ""}`}
    >
      <header>
        <span className="eyebrow">OPERATIONAL EVIDENCE</span>
        <h1>Readiness</h1>
        <p>
          See what is configured, what has been verified, and what needs
          attention before serving customers.
        </p>
      </header>
      <Notice action={a} error={l.error} />
      {l.loading && !l.data && <LoadingState label="Loading readiness…" />}
      <div className="quality-actions">
        {admin && (
          <button
            className="primary"
            disabled={a.busy || !checks.length || pending}
            onClick={() =>
              run(
                checks
                  .filter(
                    (ch) =>
                      ch.risk === "local_read" &&
                      (ch.required || ch.configured),
                  )
                  .map((ch) => ch.id),
              )
            }
          >
            {a.busy ? "Queuing…" : "Run safe checks"}
          </button>
        )}
        <button
          disabled={l.loading}
          onClick={() => {
            l.reload();
            h.reload();
          }}
        >
          Refresh results
        </button>
      </div>
      <p className="muted">
        Safe checks inspect the installation and make read-only connector
        requests. Model generation and email sends each need a separate explicit
        test.
      </p>
      {l.data?.evidenceOrigin === "local_test" && (
        <p className="alert" role="status">
          Local test environment. Provider, mail, model or scanner adapters are
          test doubles. Results here are not live connector verification.
        </p>
      )}
      {l.data && (
        <>
          <section className="panel readiness-overview">
            <h2>
              {l.data.blockers.length
                ? `${l.data.blockers.length} required checks need attention`
                : "Required checks are current"}
            </h2>
            <p>
              These results apply to this workspace and these exact operations.
              They are not vendor certification.
            </p>
            <div className="readiness-channels">
              {l.data.channels.map((ch: Row) => (
                <span className="badge neutral" key={ch.id}>
                  {ch.kind}: {ch.published ? "published" : "unpublished"}
                </span>
              ))}
            </div>
            {!!l.data.blockers.length && (
              <ul>
                {checks
                  .filter((ch) => l.data.blockers.includes(ch.id))
                  .map((ch) => (
                    <li key={ch.id}>
                      <button
                        className="text-button"
                        aria-controls="readiness-diagnostic-details"
                        onClick={(event) => inspect(ch.id, event.currentTarget)}
                      >
                        {ch.title}
                      </button>{" "}
                      —{" "}
                      {ch.prerequisite ||
                        ch.result?.evidence?.summary ||
                        "Verification is needed"}{" "}
                      <a href={link(ws, ch.view)}>Fix in {ch.view} →</a>
                    </li>
                  ))}
              </ul>
            )}
            {role === "owner" && (
              <label className="check-label">
                <input
                  type="checkbox"
                  checked={l.data.settings.strict}
                  disabled={a.busy}
                  onChange={(e) =>
                    a.run(async () => {
                      await api(
                        ws,
                        "/readiness/settings",
                        { strict: e.target.checked },
                        "PUT",
                      );
                      l.reload();
                    }, "Publication policy updated.")
                  }
                />
                Require current verification before future channel publication
              </label>
            )}
            <small>
              Existing channels stay published. Manual attestations never bypass
              security checks.
            </small>
          </section>
          <div className="readiness-layout">
            <div className="readiness-checks">
              {checks.map((ch) => (
                <article
                  className={`panel readiness-check ${selected === ch.id ? "selected" : ""}`}
                  key={ch.id}
                >
                  <div>
                    <h2>{ch.title}</h2>
                    <span
                      className={`badge ${ch.health === "current" ? "good" : ["failed", "blocked"].includes(ch.health) ? "bad" : "warning"}`}
                    >
                      {words(ch.health)}
                    </span>
                  </div>
                  <p>{ch.operation}</p>
                  <p>
                    <strong>{words(ch.level)}</strong> · {ch.environment} ·{" "}
                    {ch.required ? "Required" : "Not required"}
                  </p>
                  <p className="muted">
                    {ch.result?.finished_at
                      ? `Checked ${new Date(ch.result.finished_at).toLocaleString()}`
                      : ch.result?.status === "queued"
                        ? "Waiting for worker"
                        : "No completed check"}
                  </p>
                  <button
                    aria-expanded={selected === ch.id}
                    aria-controls="readiness-diagnostic-details"
                    onClick={(event) => inspect(ch.id, event.currentTarget)}
                  >
                    Evidence and testing
                  </button>
                </article>
              ))}
            </div>
            <section
              className="panel readiness-details"
              id="readiness-diagnostic-details"
              aria-label="Diagnostic details"
            >
              {chosen ? (
                <>
                  <button className="readiness-back" onClick={backToChecks}>
                    ← Back to checks
                  </button>
                  <h2 ref={detailHeading} tabIndex={-1}>
                    {chosen.title}
                  </h2>
                  <p>{chosen.operation}</p>
                  <p>
                    <strong>Environment:</strong> {chosen.environment}
                  </p>
                  <p>{chosen.remedy}</p>
                  <a href={link(ws, chosen.view)}>Open {chosen.view} →</a>
                  {chosen.result && (
                    <Inspect title="Current evidence" value={chosen.result} />
                  )}
                  {admin && (
                    <form
                      onSubmit={(e) => {
                        e.preventDefault();
                        run([chosen.id], chosen.risk !== "local_read");
                      }}
                    >
                      <h3>
                        {chosen.risk === "local_read"
                          ? "Run this check"
                          : "Authorize a dedicated test"}
                      </h3>
                      {chosen.prerequisite && (
                        <p role="status">{chosen.prerequisite}</p>
                      )}
                      {chosen.risk === "paid_model" && (
                        <Field label="Maximum tokens for this check">
                          <input
                            type="number"
                            min="1000"
                            max="100000"
                            step="1000"
                            value={cap}
                            onChange={(e) => setCap(Number(e.target.value))}
                          />
                        </Field>
                      )}
                      {chosen.risk === "test_email" && (
                        <Field label="Dedicated test mailbox">
                          <input
                            type="email"
                            required
                            value={email}
                            onChange={(e) => setEmail(e.target.value)}
                            placeholder="Your test mailbox"
                          />
                        </Field>
                      )}
                      {chosen.risk === "test_write" && (
                        <fieldset>
                          <legend>Exact dedicated test resources</legend>
                          <p>
                            Only use resources created for testing. This test
                            does not create or change your action approval
                            policy.
                          </p>
                          {(chosen.id.includes("zendesk_note")
                            ? [["ticketId", "Unlinked Zendesk test ticket ID"]]
                            : chosen.id.includes("stripe_")
                              ? [
                                  [
                                    "customerId",
                                    "Marked Stripe test customer ID",
                                  ],
                                  ...(chosen.id.includes("refund")
                                    ? [
                                        ["chargeId", "Marked test charge ID"],
                                        [
                                          "amountMinor",
                                          "Refund amount in minor units (1–100)",
                                        ],
                                      ]
                                    : [
                                        [
                                          "subscriptionId",
                                          "Marked test subscription ID",
                                        ],
                                      ]),
                                ]
                              : [
                                  [
                                    "contactId",
                                    "Staff-mapped dedicated test contact ID",
                                  ],
                                ]
                          ).map(([key, label]) => (
                            <Field key={key} label={label}>
                              <input
                                required
                                type={key === "amountMinor" ? "number" : "text"}
                                min={key === "amountMinor" ? 1 : undefined}
                                max={key === "amountMinor" ? 100 : undefined}
                                value={resource[key] ?? ""}
                                onChange={(e) =>
                                  setResource({
                                    ...resource,
                                    [key]: e.target.value,
                                  })
                                }
                              />
                            </Field>
                          ))}
                          {chosen.id.startsWith("probe:custom:") && (
                            <Field label="Exact test parameters (JSON)">
                              <textarea
                                required
                                value={resource.parameters ?? "{}"}
                                onChange={(e) =>
                                  setResource({
                                    ...resource,
                                    parameters: e.target.value,
                                  })
                                }
                              />
                            </Field>
                          )}
                        </fieldset>
                      )}
                      {chosen.risk !== "local_read" && (
                        <label className="check-label">
                          <input
                            type="checkbox"
                            checked={ack}
                            onChange={(e) => setAck(e.target.checked)}
                            required
                          />
                          I authorize this exact{" "}
                          {chosen.risk === "paid_model"
                            ? "paid model call within the cap"
                            : chosen.risk === "test_write"
                              ? "operation on the dedicated test resources above"
                              : "email send to my dedicated mailbox"}
                          . This may incur usage or send a real message.
                        </label>
                      )}
                      <button
                        className="primary"
                        disabled={
                          a.busy ||
                          chosen.result?.status === "queued" ||
                          chosen.result?.status === "running" ||
                          !!chosen.prerequisite ||
                          (chosen.risk !== "local_read" && !ack)
                        }
                      >
                        Run{" "}
                        {chosen.risk === "local_read"
                          ? "check"
                          : "authorized test"}
                      </button>
                    </form>
                  )}
                  {admin &&
                    ["running", "queued"].includes(chosen.result?.status) && (
                      <button
                        disabled={a.busy}
                        onClick={() =>
                          a.run(async () => {
                            await api(
                              ws,
                              `/readiness/runs/${chosen.result.id}`,
                              { action: "cancel" },
                              "PATCH",
                            );
                            l.reload();
                          }, "Cancellation requested. In-flight requests may still complete.")
                        }
                      >
                        Cancel check
                      </button>
                    )}
                  {chosen.health === "uncertain" && (
                    <p className="alert">
                      The previous request may have completed. Check provider
                      delivery or usage before explicitly authorizing another
                      test. Navigated Support will not automatically resend it.
                    </p>
                  )}
                  {admin &&
                    chosen.health === "uncertain" &&
                    chosen.risk === "test_write" && (
                      <button
                        disabled={a.busy}
                        onClick={() =>
                          a.run(async () => {
                            await api(
                              ws,
                              `/readiness/runs/${chosen.result.id}`,
                              { action: "reconcile" },
                              "PATCH",
                            );
                            l.reload();
                            h.reload();
                          }, "Original outcome verified through provider reads. No second write was sent.")
                        }
                      >
                        Look up original outcome
                      </button>
                    )}
                  <h3>History</h3>
                  {h.error && <p role="alert">{h.error}</p>}
                  <button onClick={h.reload}>Refresh history</button>
                  {(h.data?.runs ?? []).map((r: Row) => (
                    <details key={r.id}>
                      <summary>
                        {new Date(r.created_at).toLocaleString()} ·{" "}
                        {words(r.health)} · {words(r.evidence_level)}
                      </summary>
                      <p>{r.evidence?.summary || "Check not completed"}</p>
                      <p>
                        Actor: {r.actor_id} · Check definition:{" "}
                        {r.definition_version}
                      </p>
                      <Inspect title="Evidence details" value={r.evidence} />
                    </details>
                  ))}
                  {admin && (
                    <form
                      onSubmit={(e) => {
                        e.preventDefault();
                        a.run(async () => {
                          await api(
                            ws,
                            `/readiness/checks/${encodeURIComponent(selected)}/attestations`,
                            {
                              note,
                              ...(chosen.result
                                ? { runId: chosen.result.id }
                                : {}),
                            },
                          );
                          setNote("");
                          h.reload();
                        }, "Manual attestation recorded separately from automated evidence.");
                      }}
                    >
                      <h3>Operator note or receipt confirmation</h3>
                      <Field label="Manual attestation">
                        <textarea
                          required
                          minLength={10}
                          maxLength={1500}
                          value={note}
                          onChange={(e) => setNote(e.target.value)}
                        />
                      </Field>
                      <button disabled={a.busy || note.trim().length < 10}>
                        Record manual attestation
                      </button>
                    </form>
                  )}
                  {(h.data?.attestations ?? []).map((r: Row) => (
                    <blockquote key={r.id}>
                      <strong>Manual attestation</strong>
                      <p>{r.note}</p>
                      <small>
                        {r.actor_id} · {new Date(r.created_at).toLocaleString()}
                      </small>
                    </blockquote>
                  ))}
                </>
              ) : (
                <>
                  <h2>Inspect a check</h2>
                  <p>
                    Select “Evidence and testing” to see its scope, remediation,
                    history and available tests.
                  </p>
                </>
              )}
            </section>
          </div>
        </>
      )}
    </div>
  );
}
