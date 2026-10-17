import { useState } from "react";
import { api, useLoad } from "./request.js";
import { useAction } from "./useAction.js";
import { Notice } from "./quality-ui.js";
import "./collaboration.css";
export function CollaborationPanel({
  ws,
  conversationId,
  onChanged,
}: {
  ws: string;
  conversationId: string;
  onChanged?: () => void;
}) {
  const l = useLoad(
      () => api(ws, `/conversations/${conversationId}/collaboration`),
      [ws, conversationId],
    ),
    a = useAction(),
    [email, setEmail] = useState(""),
    [organizationId, setOrganizationId] = useState<string | null>(null);
  const reload = () => {
    l.reload();
    onChanged?.();
  };
  const act = (fn: () => Promise<unknown>) =>
    void a.run(async () => {
      await fn();
      reload();
    });
  return (
    <section
      className="collaboration-panel"
      aria-label="Ticket participants and sharing"
    >
      <h3>People & sharing</h3>
      <Notice action={a} error={l.error} />
      {l.error && <button onClick={l.reload}>Try again</button>}
      {!l.data && !l.error && <p role="status">Loading people…</p>}
      {l.data && (
        <>
          <p>
            External participants receive individual email copies and can reply.
            They see only correspondence sent after they were added.
          </p>
          <ul className="collaboration-list">
            {l.data.participants.map((p: any) => (
              <li key={p.id}>
                <span>
                  <strong>{p.email}</strong>
                  <small>
                    {p.portal_contact_id
                      ? "Portal invitation accepted"
                      : "Email participant · portal invitation required"}
                  </small>
                </span>
                {l.data.canManage && (
                  <button
                    disabled={a.busy}
                    onClick={() => {
                      if (
                        confirm(
                          `Remove ${p.email}? Future notifications, replies and portal access will stop.`,
                        )
                      )
                        act(() =>
                          api(
                            ws,
                            `/conversations/${conversationId}/participants/${p.id}`,
                            undefined,
                            "DELETE",
                          ),
                        );
                    }}
                  >
                    Remove
                  </button>
                )}
              </li>
            ))}
          </ul>
          {!l.data.participants.length && (
            <p className="muted">
              Only the requester receives customer notifications.
            </p>
          )}
          {l.data.canManage && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (
                  confirm(
                    `Add ${email} to future public correspondence? Earlier messages stay private. A separate invitation lets them claim portal access.`,
                  )
                )
                  void a.run(async () => {
                    await api(
                      ws,
                      `/conversations/${conversationId}/participants`,
                      { email, confirmFutureOnly: true },
                    );
                    setEmail("");
                    reload();
                  });
              }}
            >
              <label>
                Participant email
                <input
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="colleague@company.com"
                />
              </label>
              <button disabled={a.busy || !email}>Add participant</button>
            </form>
          )}
          {!!l.data.suggestions?.length && l.data.canManage && (
            <details>
              <summary>Review addresses copied on incoming email</summary>
              <p>
                These untrusted addresses have no access until you approve them.
              </p>
              {l.data.suggestions.map((s: any) => (
                <p key={s.email}>
                  {s.email}{" "}
                  <button
                    disabled={a.busy}
                    onClick={() => {
                      if (
                        confirm(`Approve ${s.email} for future correspondence?`)
                      )
                        act(() =>
                          api(
                            ws,
                            `/conversations/${conversationId}/participants`,
                            { email: s.email, confirmFutureOnly: true },
                          ),
                        );
                    }}
                  >
                    Approve
                  </button>{" "}
                  <button
                    disabled={a.busy}
                    onClick={() =>
                      act(() =>
                        api(
                          ws,
                          `/conversations/${conversationId}/participant-suggestions/dismiss`,
                          { email: s.email },
                        ),
                      )
                    }
                  >
                    Dismiss
                  </button>
                </p>
              ))}
            </details>
          )}
          {!!l.data.invitations?.some(
            (i: any) =>
              ["failed", "unknown"].includes(i.status) &&
              !i.revoked_at &&
              !i.accepted_at,
          ) && (
            <details open>
              <summary>Invitation delivery needs attention</summary>
              {l.data.invitations
                .filter(
                  (i: any) =>
                    ["failed", "unknown"].includes(i.status) &&
                    !i.revoked_at &&
                    !i.accepted_at,
                )
                .map((i: any) => (
                  <p key={i.id}>
                    {i.email}: {i.error}{" "}
                    <button
                      disabled={a.busy}
                      onClick={() => {
                        if (
                          confirm(
                            "Check your mail provider before retrying. An uncertain delivery may produce a duplicate.",
                          )
                        )
                          act(() =>
                            api(
                              ws,
                              `/collaboration/invitations/${i.id}/retry`,
                              {},
                            ),
                          );
                      }}
                    >
                      Retry invitation
                    </button>
                  </p>
                ))}
            </details>
          )}
          {!!l.data.invitations?.some(
            (i: any) => i.status === "sent" && !i.revoked_at && !i.accepted_at,
          ) && (
            <details>
              <summary>Pending portal invitations</summary>
              {l.data.invitations
                .filter(
                  (i: any) =>
                    i.status === "sent" && !i.revoked_at && !i.accepted_at,
                )
                .map((i: any) => (
                  <p key={i.id}>
                    {i.email} · expires{" "}
                    {new Date(i.expires_at).toLocaleDateString()}{" "}
                    <button
                      disabled={a.busy}
                      onClick={() => {
                        if (
                          confirm(
                            "Send a new invitation and invalidate the previous acceptance link?",
                          )
                        )
                          act(() =>
                            api(
                              ws,
                              `/collaboration/invitations/${i.id}/resend`,
                              {},
                            ),
                          );
                      }}
                    >
                      Resend invitation
                    </button>
                  </p>
                ))}
            </details>
          )}
          <div className="collaboration-follow">
            <h4>Internal following</h4>
            <p>
              Following sends staff notifications without changing ticket access
              or assignment.
            </p>
            <button
              disabled={a.busy}
              onClick={() =>
                act(() =>
                  api(
                    ws,
                    `/conversations/${conversationId}/following`,
                    { following: !l.data.following, includeNotes: false },
                    "PUT",
                  ),
                )
              }
            >
              {l.data.following ? "Stop following" : "Follow ticket"}
            </button>
            {l.data.following && l.data.canReadNotes && (
              <label>
                <input
                  type="checkbox"
                  checked={!!l.data.includeNotes}
                  onChange={(e) =>
                    act(() =>
                      api(
                        ws,
                        `/conversations/${conversationId}/following`,
                        { following: true, includeNotes: e.target.checked },
                        "PUT",
                      ),
                    )
                  }
                />{" "}
                Include internal notes when permitted
              </label>
            )}
          </div>
          <details>
            <summary>
              Company sharing ·{" "}
              {l.data.sharing === "company"
                ? "Shared with managers"
                : "Private ticket"}
            </summary>
            <p>
              Company managers can read all public history and files, and reply.
              Regular members see their own tickets. This does not email every
              company member.
            </p>
            {l.data.organizations.length > 0 && (
              <>
                <label>
                  Customer organization
                  <select
                    value={(organizationId ?? l.data.organizationId) || ""}
                    onChange={(e) => setOrganizationId(e.target.value)}
                  >
                    <option value="">No organization</option>
                    {l.data.organizations.map((o: any) => (
                      <option key={o.id} value={o.id}>
                        {o.name}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  disabled={a.busy}
                  onClick={() => {
                    const id = organizationId ?? l.data.organizationId;
                    if (
                      id &&
                      confirm(
                        "Share the complete public history and files with verified managers of this organization?",
                      )
                    )
                      act(() =>
                        api(
                          ws,
                          `/conversations/${conversationId}/sharing`,
                          {
                            organizationId: id,
                            sharing: "company",
                            confirmHistory: true,
                          },
                          "PUT",
                        ),
                      );
                  }}
                >
                  Share with company managers
                </button>
                <button
                  disabled={a.busy}
                  onClick={() =>
                    act(() =>
                      api(
                        ws,
                        `/conversations/${conversationId}/sharing`,
                        {
                          organizationId:
                            (organizationId ?? l.data.organizationId) || null,
                          sharing: "private",
                        },
                        "PUT",
                      ),
                    )
                  }
                >
                  Keep private
                </button>
              </>
            )}
          </details>
        </>
      )}
    </section>
  );
}
