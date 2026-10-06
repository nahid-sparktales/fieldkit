import { useState } from "react";
import { api, useLoad } from "./request.js";
import { useAction } from "./useAction.js";
import { Field, Notice, type Row } from "./quality-ui.js";
import { confirmDiscardChanges, useUnsavedChanges } from "./unsaved-changes.js";

const blank = () => ({
  address: "",
  displayName: "",
  replyAddress: "",
  defaultTeamId: null as string | null,
  acknowledge: false,
  workflowEnabled: false,
  enabled: true,
});
export function TicketEmailSettings({ ws }: { ws: string }) {
  const l = useLoad(() => api(ws, "/ticket-email"), [ws]),
    a = useAction();
  const [secret, setSecret] = useState<Row | null>(null),
    [edit, setEdit] = useState<Row | null>(null),
    [saved, setSaved] = useState<Row | null>(null),
    [originalText, setOriginalText] = useState<Record<string, string>>({});
  const dirty = !!edit && JSON.stringify(edit) !== JSON.stringify(saved);
  useUnsavedChanges(dirty);
  const select = (row?: Row) => {
    if (
      dirty &&
      !confirmDiscardChanges("Discard unsaved support address changes?")
    )
      return;
    const next = row ? { ...row } : blank();
    setEdit(next);
    setSaved({ ...next });
    a.setError("");
    a.setSuccess("");
  };
  const stateLabel = (value: string) =>
    ({
      sent: "Provider accepted",
      unknown: "Delivery uncertain",
      quarantined: "Needs review",
      received: "Processed",
      retrying: "Retry scheduled",
    })[value] ?? value;
  return (
    <section className="panel ticket-email-settings">
      <div className="section-heading">
        <div>
          <span className="eyebrow">EMAIL TO TICKET</span>
          <h2>Email support</h2>
          <p>
            Receive customer requests in the existing inbox and reply from the
            normal composer.
          </p>
        </div>
        <span className="badge">
          {l.error
            ? "Status unavailable"
            : !l.data
              ? "Loading…"
              : l.data.configured
                ? "Inbound configured"
                : "Setup required"}
        </span>
      </div>
      <Notice action={a} error={l.error} />
      {l.error && (
        <div className="content-load-recovery">
          <p>
            Email settings could not be loaded. Unsaved address edits are kept.
          </p>
          <button onClick={l.reload}>Try again</button>
        </div>
      )}
      {l.data && !l.data.smtpConfigured && (
        <p role="alert">
          Configure the installation’s SMTP service before sending
          acknowledgements or staff replies.
        </p>
      )}
      <details open={!!l.data && !l.data.configured}>
        <summary>Postmark inbound connection</summary>
        <p>
          Route your support addresses to one Postmark inbound stream. Configure
          its webhook with this URL and HTTP Basic Auth credentials. Use HTTPS
          in production. These settings do not verify DNS or mailbox delivery.
        </p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (
              l.data?.configured &&
              !confirm(
                "Replace the webhook credentials and revoke existing private reply addresses? Update Postmark before using incoming email again.",
              )
            )
              return;
            const data = new FormData(e.currentTarget);
            void a.run(async () => {
              setSecret(
                await api(
                  ws,
                  "/ticket-email",
                  { address: data.get("address") },
                  "PUT",
                ),
              );
              l.reload();
            }, "Connection saved. Update Postmark with the credentials below.");
          }}
        >
          <Field label="Initial support address">
            <input
              key={l.data?.address}
              name="address"
              type="email"
              required
              maxLength={254}
              defaultValue={l.data?.address}
              placeholder="support@company.example"
            />
          </Field>
          <p className="muted">
            Use 1–20 characters before @, without a plus sign. You can add more
            support addresses below.
          </p>
          <button disabled={a.busy || !l.data || !!l.error} className="primary">
            {l.data?.configured
              ? "Replace webhook credentials"
              : "Connect inbound email"}
          </button>
        </form>
        <Field label="Webhook URL">
          <input value={l.data?.webhookUrl ?? ""} readOnly />
        </Field>
        {secret && (
          <div className="success" role="status">
            <strong>Copy this password now. It is shown once.</strong>
            <Field label="Webhook username">
              <input value={secret.username} readOnly />
            </Field>
            <Field label="Webhook password">
              <input
                type="password"
                value={secret.password}
                readOnly
                onFocus={(e) => e.target.select()}
              />
            </Field>
            <button onClick={() => setSecret(null)}>Hide credentials</button>
          </div>
        )}
        {l.data?.configured && (
          <button
            disabled={a.busy}
            onClick={() => {
              if (
                confirm(
                  "Disconnect incoming email and revoke private reply addresses? Existing tickets remain in the inbox; email-only customers will need a working email connection to reply.",
                )
              )
                void a.run(async () => {
                  await api(ws, "/ticket-email", undefined, "DELETE");
                  setSecret(null);
                  l.reload();
                }, "Inbound email disconnected.");
            }}
          >
            Disconnect inbound email
          </button>
        )}
      </details>
      {l.data?.configured && (
        <>
          <div className="section-heading">
            <div>
              <h3>Support addresses</h3>
              <p className="muted">
                Each address is explicitly mapped to this workspace’s Postmark
                connection. Disabling new intake preserves existing ticket
                replies.
              </p>
            </div>
            <button disabled={a.busy} onClick={() => select()}>
              Add support address
            </button>
          </div>
          {!l.data.addresses.length && (
            <p>No support addresses configured yet.</p>
          )}
          {l.data.addresses.map((row: Row) => (
            <div className="email-job" key={row.id}>
              <div>
                <strong>{row.displayName || row.address}</strong>
                <p>
                  {row.address} ·{" "}
                  {row.enabled ? "New tickets enabled" : "New tickets disabled"}
                </p>
                <small>
                  Replies from {row.replyAddress} ·{" "}
                  {row.acknowledge
                    ? "Acknowledgement on"
                    : "Acknowledgement off"}
                </small>
              </div>
              <button
                disabled={a.busy}
                onClick={() => select(row)}
                aria-label={`Edit support address ${row.address}`}
              >
                Edit
              </button>
            </div>
          ))}
          {edit && (
            <form
              className="panel"
              aria-label="Support address editor"
              onSubmit={(e) => {
                e.preventDefault();
                const { id, integrationId, ...data } = edit;
                void a.run(async () => {
                  await api(
                    ws,
                    `/ticket-email/addresses${id ? `/${id}` : ""}`,
                    data,
                    id ? "PUT" : "POST",
                  );
                  setEdit(null);
                  setSaved(null);
                  l.reload();
                }, "Support address saved.");
              }}
            >
              <h3>
                {edit.id ? "Edit support address" : "New support address"}
              </h3>
              <fieldset disabled={a.busy} className="content-fieldset">
                <Field label="Support address">
                  <input
                    type="email"
                    required
                    maxLength={254}
                    value={edit.address}
                    onChange={(e) =>
                      setEdit({ ...edit, address: e.target.value })
                    }
                  />
                </Field>
                <Field label="Display name">
                  <input
                    maxLength={200}
                    value={edit.displayName}
                    onChange={(e) =>
                      setEdit({ ...edit, displayName: e.target.value })
                    }
                    placeholder="Billing support"
                  />
                </Field>
                <Field label="Reply identity address">
                  <input
                    type="email"
                    required
                    maxLength={254}
                    value={edit.replyAddress}
                    onChange={(e) =>
                      setEdit({ ...edit, replyAddress: e.target.value })
                    }
                  />
                </Field>
                <p className="muted">
                  Configure this From address with your SMTP provider. Private
                  Reply-To addresses use the support address above.
                </p>
                <Field label="Default team">
                  <select
                    value={edit.defaultTeamId ?? ""}
                    onChange={(e) =>
                      setEdit({
                        ...edit,
                        defaultTeamId: e.target.value || null,
                      })
                    }
                  >
                    <option value="">Workspace routing default</option>
                    {l.data.teams.map((team: Row) => (
                      <option value={team.id} key={team.id}>
                        {team.name}
                      </option>
                    ))}
                  </select>
                </Field>
                <label className="check-label">
                  <input
                    type="checkbox"
                    checked={edit.enabled}
                    onChange={(e) =>
                      setEdit({ ...edit, enabled: e.target.checked })
                    }
                  />
                  Accept new email tickets
                </label>
                <label className="check-label">
                  <input
                    type="checkbox"
                    checked={edit.acknowledge}
                    onChange={(e) =>
                      setEdit({ ...edit, acknowledge: e.target.checked })
                    }
                  />
                  Send one acknowledgement for each new ticket
                </label>
                <label className="check-label">
                  <input
                    type="checkbox"
                    checked={edit.workflowEnabled}
                    onChange={(e) =>
                      setEdit({ ...edit, workflowEnabled: e.target.checked })
                    }
                  />
                  Start the published support workflow
                </label>
                <p className="muted">
                  Without a workflow, new requests go directly to human support.
                  Email sender addresses do not verify a portal account or
                  authorize protected actions. Required portal fields are
                  collected later.
                </p>
                <div className="button-row">
                  <button className="primary" disabled={!!edit.id && !dirty}>
                    Save support address
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      if (
                        !dirty ||
                        confirmDiscardChanges(
                          "Discard unsaved support address changes?",
                        )
                      ) {
                        setEdit(null);
                        setSaved(null);
                      }
                    }}
                  >
                    Cancel
                  </button>
                  <span role="status">
                    {dirty ? "Unsaved changes" : "No unsaved changes"}
                  </span>
                </div>
              </fieldset>
            </form>
          )}
        </>
      )}
      <details>
        <summary>Processing health & recovery</summary>
        <button onClick={l.reload} disabled={l.loading}>
          Refresh email status
        </button>
        <p className="muted">
          Recent 30 inbound and outbound records. Provider accepted means SMTP
          accepted the message, not final inbox delivery. Bounces remain visible
          in your SMTP provider. Unknown outcomes require checking there before
          retrying.
        </p>
        <h3>Incoming mail</h3>
        {l.data && !l.data.inbound.length && <p>No incoming mail yet.</p>}
        {l.data?.inbound.map((m: Row) => (
          <div className="email-job" key={m.id}>
            {m.conversation_id ? (
              <a
                href={`/?workspace=${ws}&view=inbox&conversation=${m.conversation_id}`}
              >
                Ticket #{m.conversation_id.slice(0, 8)}
              </a>
            ) : (
              <strong>Unprocessed email</strong>
            )}
            <strong>{stateLabel(m.status)}</strong>
            <small>
              {new Date(m.created_at).toLocaleString()} · {m.attempts} attempts
            </small>
            {m.error && <p role="status">{m.error}</p>}
            {l.data.canRetry &&
              m.replayable &&
              ["failed", "retrying", "quarantined"].includes(m.status) && (
                <button
                  disabled={a.busy}
                  onClick={() => {
                    if (
                      confirm(
                        "Recheck this email using the current recipient, sender and attachment rules? This never bypasses admission checks.",
                      )
                    )
                      void a.run(async () => {
                        await api(
                          ws,
                          `/ticket-email/inbound/${m.id}/retry`,
                          {},
                        );
                        l.reload();
                      }, "Email queued for rechecking.");
                  }}
                >
                  Recheck intake
                </button>
              )}
            <details>
              <summary>Attempt history</summary>
              {l.data.inboundAttempts
                .filter((attempt: Row) => attempt.event_id === m.id)
                .map((attempt: Row) => (
                  <p key={attempt.id}>
                    {new Date(attempt.created_at).toLocaleString()} ·{" "}
                    {stateLabel(attempt.status)}{" "}
                    {attempt.error && `· ${attempt.error}`}
                  </p>
                ))}
            </details>
            {m.replayable && (
              <details>
                <summary>Original message text</summary>
                <p className="muted">
                  Review text omitted by provider quote stripping. Sender
                  identity is unverified; headers, recipients and attachment
                  bytes are not displayed.
                </p>
                {originalText[m.id] === undefined ? (
                  <button
                    disabled={a.busy}
                    onClick={() =>
                      void a.run(async () => {
                        const source = await api(
                          ws,
                          `/ticket-email/inbound/${m.id}/source`,
                        );
                        setOriginalText((old) => ({
                          ...old,
                          [m.id]: source.text,
                        }));
                      })
                    }
                  >
                    Load original text
                  </button>
                ) : (
                  <pre
                    style={{
                      whiteSpace: "pre-wrap",
                      overflowWrap: "anywhere",
                      maxHeight: 320,
                      overflow: "auto",
                    }}
                  >
                    {originalText[m.id]}
                  </pre>
                )}
              </details>
            )}
          </div>
        ))}
        <h3>Outgoing mail</h3>
        {l.data && !l.data.outbound.length && (
          <p>No outgoing ticket emails yet.</p>
        )}
        {l.data?.outbound.map((m: Row) => (
          <div className="email-job" key={m.id}>
            <a
              href={`/?workspace=${ws}&view=inbox&conversation=${m.conversation_id}`}
            >
              Ticket #{m.conversation_id.slice(0, 8)}
            </a>
            <strong>{stateLabel(m.status)}</strong>
            <small>
              {m.kind === "acknowledgement"
                ? "Acknowledgement"
                : "Public reply"}{" "}
              · {m.attempts} attempts
            </small>
            {m.error && <p>{m.error}</p>}
            {l.data.canRetry && ["failed", "unknown"].includes(m.status) && (
              <button
                disabled={a.busy}
                onClick={() => {
                  if (
                    confirm(
                      "Check the provider first. Retrying an uncertain delivery can send a duplicate. Retry this email?",
                    )
                  )
                    void a.run(async () => {
                      await api(ws, `/ticket-email/${m.id}/retry`, {});
                      l.reload();
                    }, "Delivery queued.");
                }}
              >
                Retry email
              </button>
            )}
            <details>
              <summary>Attempt history</summary>
              {l.data.outboundAttempts
                .filter((attempt: Row) => attempt.email_id === m.id)
                .map((attempt: Row) => (
                  <p key={attempt.id}>
                    {new Date(attempt.created_at).toLocaleString()} ·{" "}
                    {stateLabel(attempt.status)}{" "}
                    {attempt.error && `· ${attempt.error}`}
                  </p>
                ))}
            </details>
          </div>
        ))}
      </details>
    </section>
  );
}
