import { useState } from "react";
import { api, useLoad } from "./request.js";
import { useAction } from "./useAction.js";
import { Field, Notice, type Row } from "./quality-ui.js";
export function TicketEmailSettings({ ws }: { ws: string }) {
  const l = useLoad(() => api(ws, "/ticket-email"), [ws]),
    a = useAction(),
    [secret, setSecret] = useState<Row | null>(null);
  return (
    <section className="panel ticket-email-settings">
      <div className="section-heading">
        <div>
          <span className="eyebrow">TICKET NOTIFICATIONS & REPLIES</span>
          <h2>Email support</h2>
          <p>
            Public ticket replies are emailed through your installation’s SMTP
            service. Connect inbound email so customers can reply directly.
          </p>
        </div>
        <span className="badge">
          {l.error
            ? "Status unavailable"
            : !l.data
              ? "Loading status…"
              : l.data.configured
                ? "Replies connected"
                : "Portal replies"}
        </span>
      </div>
      {l.error && (
        <div className="content-load-recovery">
          <p>
            {l.data
              ? "Showing the last loaded email settings."
              : "Email reply settings could not be loaded."}
          </p>
          <button onClick={l.reload}>Try again</button>
        </div>
      )}
      <details>
        <summary>Set up direct email replies</summary>
        <p>
          Use a Postmark inbound address or a domain routed to Postmark.
          Configure its inbound webhook with the URL and Basic Auth credentials
          below. Use HTTPS in production.
        </p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const d = new FormData(e.currentTarget);
            void a.run(async () => {
              setSecret(
                await api(
                  ws,
                  "/ticket-email",
                  { address: d.get("address") },
                  "PUT",
                ),
              );
              l.reload();
            }, "Connection saved. Add the credentials below to your Postmark inbound webhook.");
          }}
        >
          <Field label="Inbound email address">
            <input
              key={l.data?.address}
              type="email"
              name="address"
              required
              placeholder="support@inbound.example.com"
              defaultValue={l.data?.address}
            />
          </Field>
          <p className="muted">
            Saving replaces webhook credentials and revokes old reply addresses.
            Existing emails can still be answered through the portal link.
          </p>
          <button className="primary" disabled={a.busy || !l.data || !!l.error}>
            {l.data?.configured
              ? "Replace email connection"
              : "Connect inbound email"}
          </button>
        </form>
        <Field label="Webhook URL">
          <input readOnly value={l.data?.webhookUrl ?? ""} />
        </Field>
        {secret && (
          <div className="success">
            <strong>
              Copy these credentials now. The password is shown once.
            </strong>
            <Field label="Webhook username">
              <input readOnly value={secret.username} />
            </Field>
            <Field label="Webhook password">
              <input readOnly value={secret.password} />
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
                  "Disconnect incoming email replies? Customers can continue replying through the portal.",
                )
              )
                void a.run(async () => {
                  await api(ws, "/ticket-email", undefined, "DELETE");
                  setSecret(null);
                  l.reload();
                });
            }}
          >
            Disconnect email replies
          </button>
        )}
        <p>
          Reply addresses are private, customer-specific credentials. Incoming
          mail must match the verified customer. Automated mail, mismatched
          senders are rejected and listed below. If attachments are enabled,
          permitted files are quarantined and scanned. A rejected file does not
          discard valid reply text; its status is shown in the ticket.
        </p>
      </details>
      <Notice action={a} error={l.error} />
      <details>
        <summary>Recent email delivery & recovery</summary>
        <button onClick={l.reload}>Refresh email status</button>
        <p className="muted">
          “Sent” means SMTP accepted the message. Check your mail provider for
          bounces. An unknown outcome requires checking the provider before
          retrying.
        </p>
        {!l.data?.outbound.length && <p>No ticket reply emails yet.</p>}
        {l.data?.outbound.map((m: Row) => (
          <div className="email-job" key={m.id}>
            <a
              href={`/?workspace=${ws}&view=inbox&conversation=${m.conversation_id}`}
            >
              Ticket #{m.conversation_id.slice(0, 8)}
            </a>
            <strong>{m.status}</strong>
            <small>{m.error}</small>
            {["failed", "unknown"].includes(m.status) && (
              <button
                disabled={a.busy}
                onClick={() => {
                  if (
                    confirm(
                      "Check your provider first. Retrying may send a duplicate email. Retry this message?",
                    )
                  )
                    void a.run(async () => {
                      await api(ws, `/ticket-email/${m.id}/retry`, {});
                      l.reload();
                    });
                }}
              >
                Retry email
              </button>
            )}
          </div>
        ))}
        {!!l.data?.inbound.length && <h3>Incoming replies</h3>}
        {l.data?.inbound.map((m: Row) => (
          <div className="email-job" key={m.provider_id}>
            <a
              href={`/?workspace=${ws}&view=inbox&conversation=${m.conversation_id}`}
            >
              Ticket #{m.conversation_id.slice(0, 8)}
            </a>
            <strong>{m.status}</strong>
            <small>{m.error}</small>
          </div>
        ))}
      </details>
    </section>
  );
}
