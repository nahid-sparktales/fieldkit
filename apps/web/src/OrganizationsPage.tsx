import { useState } from "react";
import { api, useLoad } from "./request.js";
import { useAction } from "./useAction.js";
import { Notice } from "./quality-ui.js";
import { useUnsavedChanges } from "./unsaved-changes.js";
import "./collaboration.css";
export function OrganizationsPage({ ws }: { ws: string }) {
  const l = useLoad(() => api(ws, "/organizations"), [ws]),
    a = useAction(),
    [selected, setSelected] = useState(""),
    [name, setName] = useState(""),
    [description, setDescription] = useState(""),
    [editing, setEditing] = useState(false);
  useUnsavedChanges(editing && (!!name || !!description));
  return (
    <main className="organizations-page">
      <header className="section-heading">
        <div>
          <span className="eyebrow">CUSTOMERS</span>
          <h1>Organizations</h1>
          <p>
            Group verified customers and share selected tickets with company
            managers.
          </p>
        </div>
        <button onClick={() => setEditing(true)}>New organization</button>
      </header>
      <Notice action={a} error={l.error} />
      {l.error && <button onClick={l.reload}>Try again</button>}
      {editing && (
        <form
          className="panel"
          onSubmit={(e) => {
            e.preventDefault();
            void a.run(async () => {
              const o = await api(ws, "/organizations", { name, description });
              setSelected(o.id);
              setName("");
              setDescription("");
              setEditing(false);
              l.reload();
            });
          }}
        >
          <label>
            Organization name
            <input
              required
              maxLength={150}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <label>
            Description
            <textarea
              maxLength={2000}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </label>
          <div className="button-row">
            <button disabled={a.busy}>Create organization</button>
            <button
              type="button"
              onClick={() => {
                if (
                  (!name && !description) ||
                  confirm("Discard this organization draft?")
                ) {
                  setEditing(false);
                  setName("");
                  setDescription("");
                }
              }}
            >
              Cancel
            </button>
          </div>
        </form>
      )}
      {l.loading && !l.data && <p role="status">Loading organizations…</p>}
      {l.data && !l.data.organizations.length && (
        <div className="panel">
          <h2>No organizations yet</h2>
          <p>
            Create an organization, invite verified members, then explicitly
            share individual tickets. Existing tickets stay private.
          </p>
        </div>
      )}
      <div className="organizations-workspace">
        <nav aria-label="Customer organizations">
          {l.data?.organizations.map((o: any) => (
            <button
              key={o.id}
              aria-current={selected === o.id ? "page" : undefined}
              onClick={() => setSelected(o.id)}
            >
              <strong>{o.name}</strong>
              <small>
                {o.active ? `${o.member_count} members` : "Archived"}
              </small>
            </button>
          ))}
        </nav>
        {selected ? (
          <OrganizationDetail
            key={`${ws}:${selected}`}
            ws={ws}
            id={selected}
            changed={l.reload}
          />
        ) : (
          !!l.data?.organizations.length && (
            <p>Select an organization to manage invitations and membership.</p>
          )
        )}
      </div>
    </main>
  );
}
function OrganizationDetail({
  ws,
  id,
  changed,
}: {
  ws: string;
  id: string;
  changed: () => void;
}) {
  const l = useLoad(() => api(ws, `/organizations/${id}`), [ws, id]),
    a = useAction(),
    [email, setEmail] = useState(""),
    [role, setRole] = useState("member");
  const reload = () => {
    l.reload();
    changed();
  };
  return (
    <section className="panel organization-detail">
      <Notice action={a} error={l.error} />
      {l.error && <button onClick={l.reload}>Try again</button>}
      {l.data && (
        <>
          <h2>{l.data.organization.name}</h2>
          <p>{l.data.organization.description}</p>
          <p>
            Managers can read and reply to tickets explicitly shared with this
            company. Members see only their own tickets.
          </p>
          <h3>Members</h3>
          <ul className="collaboration-list">
            {l.data.members.map((m: any) => (
              <li key={m.contact_id}>
                <span>
                  <strong>{m.name || m.email}</strong>
                  <small>
                    {m.email} · {m.role}
                  </small>
                </span>
                <button
                  disabled={a.busy}
                  onClick={() => {
                    if (confirm(`Revoke ${m.email}'s company access?`))
                      void a.run(async () => {
                        await api(
                          ws,
                          `/organizations/${id}/members/${m.contact_id}`,
                          undefined,
                          "DELETE",
                        );
                        reload();
                      });
                  }}
                >
                  Remove member
                </button>
              </li>
            ))}
          </ul>
          {!l.data.members.length && <p>No accepted memberships.</p>}
          {l.data.organization.active && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void a.run(async () => {
                  await api(ws, `/organizations/${id}/invitations`, {
                    email,
                    role,
                  });
                  setEmail("");
                  reload();
                });
              }}
            >
              <label>
                Email address
                <input
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
              </label>
              <label>
                Company role
                <select value={role} onChange={(e) => setRole(e.target.value)}>
                  <option value="member">Member — own tickets</option>
                  <option value="manager">
                    Manager — shared company tickets
                  </option>
                </select>
              </label>
              <button disabled={a.busy}>Send invitation</button>
            </form>
          )}
          <h3>Invitations</h3>
          <ul className="collaboration-list">
            {l.data.invitations.map((i: any) => (
              <li key={i.id}>
                <span>
                  {i.email}
                  <small>
                    {i.accepted_at
                      ? "Accepted"
                      : i.revoked_at
                        ? "Revoked"
                        : `${i.role} · ${i.status}`}{" "}
                    {i.error}
                  </small>
                </span>
                {["failed", "unknown"].includes(i.status) &&
                  !i.revoked_at &&
                  !i.accepted_at && (
                    <button
                      disabled={a.busy}
                      onClick={() => {
                        if (
                          confirm(
                            "Check your mail provider before retrying to avoid duplicate invitations.",
                          )
                        )
                          void a.run(async () => {
                            await api(
                              ws,
                              `/collaboration/invitations/${i.id}/retry`,
                              {},
                            );
                            reload();
                          });
                      }}
                    >
                      Retry
                    </button>
                  )}
                {i.status === "sent" && !i.revoked_at && !i.accepted_at && (
                  <button
                    disabled={a.busy}
                    onClick={() => {
                      if (
                        confirm(
                          "Send a new invitation and invalidate the previous acceptance link?",
                        )
                      )
                        void a.run(async () => {
                          await api(
                            ws,
                            `/collaboration/invitations/${i.id}/resend`,
                            {},
                          );
                          reload();
                        });
                    }}
                  >
                    Resend invitation
                  </button>
                )}
              </li>
            ))}
          </ul>
          <button
            disabled={a.busy}
            onClick={() => {
              if (
                confirm(
                  l.data.organization.active
                    ? "Archive this organization and revoke company ticket access?"
                    : "Restore this organization? Existing active memberships regain access to shared tickets.",
                )
              )
                void a.run(async () => {
                  const o = l.data.organization;
                  await api(
                    ws,
                    `/organizations/${id}`,
                    {
                      name: o.name,
                      description: o.description,
                      revision: o.revision,
                      active: !o.active,
                    },
                    "PUT",
                  );
                  reload();
                });
            }}
          >
            {l.data.organization.active
              ? "Archive organization"
              : "Restore organization"}
          </button>
        </>
      )}
    </section>
  );
}
