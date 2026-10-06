import { useEffect, useState } from "react";
import { api, useLoad } from "./request.js";
import { Field, Notice, type Row } from "./quality-ui.js";
import { useAction } from "./useAction.js";
import { LoadingState } from "./ui.js";
import { confirmDiscardChanges, useUnsavedChanges } from "./unsaved-changes.js";
import "./roles.css";

const scopeNames: Record<string, string> = {
  all: "All workspace tickets",
  team: "Own teams' tickets",
  assigned: "Assigned tickets only",
};
const capabilityName = (value: string) =>
  value
    .split(":")
    .map((v) => v.replaceAll("_", " "))
    .join(" · ");
export function StaffRolesEditor({ ws }: { ws: string }) {
  const l = useLoad(() => api(ws, "/staff-roles"), [ws]),
    a = useAction(),
    [selected, setSelected] = useState<string | null>(null),
    [saving, setSaving] = useState(false);
  const choose = (id: string) => {
    if (!saving && (id === selected || confirmDiscardChanges()))
      setSelected(id);
  };
  return (
    <section className="staff-roles">
      <header>
        <h2>Staff roles & permissions</h2>
        <p>
          Choose what staff can do and which tickets they can see. Changes
          require recent verification in Security and sign affected staff out.
        </p>
      </header>
      <Notice action={a} error={l.error} />
      {l.error && <button onClick={l.reload}>Retry staff roles</button>}
      {l.loading && !l.data && (
        <LoadingState label="Loading staff permissions…" />
      )}
      {l.data && (
        <>
          <details className="panel">
            <summary>Built-in roles</summary>
            <p>
              Owner access stays protected. Built-in roles cannot be edited;
              custom roles provide narrower permissions.
            </p>
            {Object.entries(l.data.builtins).map(([role, caps]) => (
              <details key={role}>
                <summary>
                  {role} · {(caps as string[]).length} capabilities
                </summary>
                <ul>
                  {(caps as string[]).map((cap) => (
                    <li key={cap}>{capabilityName(cap)}</li>
                  ))}
                </ul>
              </details>
            ))}
          </details>
          {l.data.permissions.roles && (
            <div className="role-editor-layout">
              <section className="panel">
                <h3>Custom roles</h3>
                <button disabled={saving} onClick={() => choose("new")}>
                  New custom role
                </button>
                {!l.data.roles.length && (
                  <p>
                    No custom roles. Existing staff keep their built-in
                    permissions.
                  </p>
                )}
                {l.data.roles.map((r: Row) => (
                  <button
                    className="role-choice"
                    key={r.id}
                    disabled={saving}
                    aria-pressed={selected === r.id}
                    onClick={() => choose(r.id)}
                  >
                    <strong>{r.name}</strong>
                    <small>
                      {scopeNames[r.ticket_scope]} · {r.member_count} members
                    </small>
                  </button>
                ))}
              </section>
              {selected ? (
                <RoleForm
                  key={selected}
                  ws={ws}
                  role={l.data.roles.find((r: Row) => r.id === selected)}
                  data={l.data}
                  onBusy={setSaving}
                  onSaved={() => {
                    setSelected(null);
                    l.reload();
                  }}
                />
              ) : (
                <section className="panel">
                  <h3>Choose a custom role</h3>
                  <p>
                    Review its ticket visibility and capability matrix, or
                    create a role for a specific responsibility.
                  </p>
                </section>
              )}
            </div>
          )}
          <section className="panel">
            <h3>Member access</h3>
            <p>
              Owners and your own membership cannot be changed here. Custom
              roles restrict capabilities within the selected base role. Legacy
              administrator and owner tools still require their matching base
              role; choosing a capability does not remove that requirement.
            </p>
            <div className="role-members">
              {l.data.members.map((member: Row) => (
                <MemberRole
                  key={member.user_id}
                  ws={ws}
                  member={member}
                  data={l.data}
                  onSaved={l.reload}
                />
              ))}
            </div>
          </section>
        </>
      )}
    </section>
  );
}
function RoleForm({
  ws,
  role,
  data,
  onBusy,
  onSaved,
}: {
  ws: string;
  role?: Row;
  data: Row;
  onBusy: (busy: boolean) => void;
  onSaved: () => void;
}) {
  const initial = {
    ...(role ? { id: role.id, revision: role.revision } : {}),
    name: role?.name ?? "",
    description: role?.description ?? "",
    capabilities: role?.capabilities ?? ([] as string[]),
    ticketScope: role?.ticket_scope ?? "assigned",
  };
  const [draft, setDraft] = useState(initial),
    a = useAction();
  useEffect(() => {
    onBusy(a.busy);
    return () => onBusy(false);
  }, [a.busy, onBusy]);
  useUnsavedChanges(JSON.stringify(draft) !== JSON.stringify(initial));
  const selfRole =
    data.members.find((m: Row) => m.user_id === data.self)?.custom_role_id ===
      role?.id && !!role;
  const groups = [
    ...new Set<string>(data.capabilities.map((c: string) => c.split(":")[0])),
  ];
  return (
    <form
      className="panel role-form"
      onSubmit={(e) => {
        e.preventDefault();
        void a.run(async () => {
          await api(ws, "/staff-roles", draft);
          onSaved();
        }, "Role saved");
      }}
    >
      <h3>{role ? "Edit role" : "New custom role"}</h3>
      <Notice action={a} />
      {selfRole && (
        <p className="callout">
          You cannot edit the role assigned to yourself. Ask another authorized
          administrator.
        </p>
      )}
      <fieldset disabled={a.busy || selfRole}>
        <Field label="Role name">
          <input
            required
            maxLength={80}
            value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
          />
        </Field>
        <Field label="Role description">
          <textarea
            maxLength={1000}
            value={draft.description}
            onChange={(e) =>
              setDraft({ ...draft, description: e.target.value })
            }
          />
        </Field>
        <Field label="Ticket visibility">
          <select
            value={draft.ticketScope}
            onChange={(e) =>
              setDraft({ ...draft, ticketScope: e.target.value })
            }
          >
            {Object.entries(scopeNames).map(([id, name]) => (
              <option
                key={id}
                value={id}
                disabled={
                  (id === "all" && data.ticketScope !== "all") ||
                  (id === "team" && data.ticketScope === "assigned")
                }
              >
                {name}
              </option>
            ))}
          </select>
        </Field>
        <p>
          Ticket read permission is also required. Shared views and team
          membership do not add capabilities.
        </p>
        <div className="capability-matrix">
          {groups.map((group) => (
            <fieldset key={group}>
              <legend>{group.replaceAll("_", " ")}</legend>
              {data.capabilities
                .filter((c: string) => c.startsWith(group + ":"))
                .map((cap: string) => (
                  <label key={cap}>
                    <input
                      type="checkbox"
                      checked={draft.capabilities.includes(cap)}
                      disabled={!data.delegable.includes(cap)}
                      onChange={(e) =>
                        setDraft({
                          ...draft,
                          capabilities: e.target.checked
                            ? [...draft.capabilities, cap]
                            : draft.capabilities.filter(
                                (v: string) => v !== cap,
                              ),
                        })
                      }
                    />
                    {capabilityName(cap)}
                    {!data.delegable.includes(cap) && (
                      <small> Not delegable</small>
                    )}
                  </label>
                ))}
            </fieldset>
          ))}
        </div>
        <div className="quality-actions">
          <button className="primary">
            {a.busy ? "Saving…" : "Save custom role"}
          </button>
          {role && (
            <button
              type="button"
              disabled={role.member_count > 0}
              onClick={() => {
                if (!window.confirm(`Delete the unused role “${role.name}”?`))
                  return;
                void a.run(async () => {
                  await api(ws, `/staff-roles/${role.id}`, undefined, "DELETE");
                  onSaved();
                }, "Role deleted");
              }}
            >
              Delete unused role
            </button>
          )}
        </div>
      </fieldset>
    </form>
  );
}
function MemberRole({
  ws,
  member,
  data,
  onSaved,
}: {
  ws: string;
  member: Row;
  data: Row;
  onSaved: () => void;
}) {
  const initial = member.custom_role_id
    ? `custom:${member.custom_role_id}`
    : member.role;
  const [choice, setChoice] = useState(initial),
    [baseRole, setBaseRole] = useState(
      member.role === "admin" ? "admin" : "agent",
    ),
    [disabled, setDisabled] = useState(member.disabled),
    a = useAction();
  useEffect(() => {
    setChoice(initial);
    setBaseRole(member.role === "admin" ? "admin" : "agent");
    setDisabled(member.disabled);
  }, [initial, member.disabled, member.role]);
  const fixed =
    member.role === "owner" ||
    member.user_id === data.self ||
    !data.permissions.members;
  const changed =
    choice !== initial ||
    disabled !== member.disabled ||
    (choice.startsWith("custom:") && baseRole !== member.role);
  useUnsavedChanges(changed);
  return (
    <form
      className="member-role"
      onSubmit={(e) => {
        e.preventDefault();
        if (
          !window.confirm(
            `Change access for ${member.name || member.email || member.user_id}? Their active sessions will be signed out.`,
          )
        )
          return;
        void a.run(async () => {
          await api(
            ws,
            `/staff-roles/members/${encodeURIComponent(member.user_id)}`,
            {
              role: choice.startsWith("custom:") ? baseRole : choice,
              customRoleId: choice.startsWith("custom:")
                ? choice.slice(7)
                : null,
              disabled,
            },
            "PUT",
          );
          onSaved();
        }, "Member access updated");
      }}
    >
      <div>
        <strong>{member.name || member.email || member.user_id}</strong>
        <small>
          {member.email}
          {member.user_id === data.self ? " · You" : ""}
        </small>
      </div>
      <fieldset disabled={a.busy || fixed}>
        <label>
          Role
          <select
            aria-label={`Role for ${member.name || member.email || member.user_id}`}
            value={choice}
            onChange={(e) => setChoice(e.target.value)}
          >
            {member.role === "owner" && (
              <option value="owner">Owner (protected)</option>
            )}
            <option value="admin">Administrator</option>
            <option value="agent">Agent</option>
            {data.roles.map((r: Row) => (
              <option key={r.id} value={`custom:${r.id}`}>
                {r.name}
              </option>
            ))}
          </select>
        </label>
        {choice.startsWith("custom:") && (
          <label>
            Base role
            <select
              aria-label={`Base role for ${member.name || member.email || member.user_id}`}
              value={baseRole}
              onChange={(e) => setBaseRole(e.target.value)}
            >
              <option value="agent">Agent</option>
              <option value="admin">Administrator</option>
            </select>
            <small>
              Legacy admin tools need Administrator plus the relevant custom
              permission.
            </small>
          </label>
        )}
        <label>
          <input
            type="checkbox"
            checked={disabled}
            onChange={(e) => setDisabled(e.target.checked)}
          />{" "}
          Disable staff access
        </label>
        <button disabled={!changed}>Update access</button>
      </fieldset>
      <Notice action={a} />
    </form>
  );
}
