import { useEffect, useState } from "react";
import { api, useLoad } from "./request.js";
import { useAction } from "./useAction.js";
import { Field, Notice, link, type Row } from "./quality-ui.js";
import { LoadingState } from "./ui.js";
import { appLink } from "./customer-ui.js";
import { confirmDiscardChanges, useUnsavedChanges } from "./unsaved-changes.js";
import { routingReasons } from "../../../packages/platform/src/human-routing-contracts.js";
import "./teams.css";

const label = (member: Row) => member.name || member.email || member.user_id;
const effective = (member: Row, ttl: number) =>
  member.state === "available" &&
  (!member.heartbeat_at ||
    Date.now() - Date.parse(member.heartbeat_at) > ttl * 1000)
    ? "expired"
    : member.state;

/** Mount beside staff navigation so an open, visible app can refresh deliberate Available intent. */
export function AgentAvailabilityControl({ ws }: { ws: string }) {
  const l = useLoad(() => api(ws, "/routing"), [ws]),
    a = useAction();
  useEffect(() => {
    if (l.data?.self?.state !== "available") return;
    const heartbeat = () => {
      if (document.visibilityState === "visible")
        void api(ws, "/routing/heartbeat", {}).catch(() => {});
    };
    heartbeat();
    const timer = setInterval(heartbeat, 30000);
    document.addEventListener("visibilitychange", heartbeat);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", heartbeat);
    };
  }, [ws, l.data?.self?.state]);
  if (!l.data?.self) return null;
  return (
    <div className="agent-availability">
      <label>
        My availability
        <select
          aria-label="My availability"
          value={l.data.self.state}
          disabled={a.busy}
          onChange={(e) =>
            void a.run(async () => {
              await api(
                ws,
                "/routing/availability",
                { state: e.target.value },
                "PUT",
              );
              l.reload();
            }, "Availability updated")
          }
        >
          <option value="available">Available</option>
          <option value="away">Away</option>
          <option value="offline">Offline</option>
        </select>
      </label>
      <small>
        {l.data.self.workload} / {l.data.self.capacity} active human tickets
      </small>
      {a.error && <span role="alert">{a.error}</span>}
    </div>
  );
}

export function TeamsPage({ ws }: { ws: string }) {
  const l = useLoad(() => api(ws, "/routing"), [ws]),
    a = useAction();
  const [tab, setTab] = useState("queue"),
    [selected, setSelected] = useState<string | null>(null),
    [savingTeam, setSavingTeam] = useState(false);
  const select = (id: string) => {
    if (!savingTeam && (id === selected || confirmDiscardChanges()))
      setSelected(id);
  };
  return (
    <div className="quality-page teams-page">
      <header>
        <span className="eyebrow">HUMAN SUPPORT</span>
        <h1>Teams & routing</h1>
        <p>
          Send work to an available teammate, with clear ownership and room to
          respond.
        </p>
      </header>
      <Notice action={a} error={l.error} />
      {l.error && <button onClick={l.reload}>Try again</button>}
      {l.loading && !l.data && (
        <LoadingState label="Loading teams and queues…" />
      )}
      {l.data && (
        <>
          <div className="routing-status">
            <span>
              Automatic routing is{" "}
              <strong>{l.data.settings.enabled ? "on" : "off"}</strong>.{" "}
              {l.data.settings.enabled
                ? "Only new human-handling events and deliberately requeued tickets are enrolled."
                : "Tickets keep their current owners until you choose to enable routing."}
            </span>
            <button onClick={l.reload} disabled={l.loading}>
              Refresh queue
            </button>
          </div>
          <div
            className="quality-actions"
            role="group"
            aria-label="Team sections"
          >
            {[
              ["queue", "Human queue"],
              ["teams", "Teams"],
              ["capacity", "Workload"],
              ["settings", "Routing settings"],
            ]
              .filter(([id]) => id !== "settings" || l.data.permissions.routing)
              .map(([id, name]) => (
                <button
                  key={id}
                  aria-pressed={tab === id}
                  onClick={() => setTab(id)}
                >
                  {name}
                </button>
              ))}
          </div>
          <div hidden={tab !== "queue"} className="panel">
            <h2>Waiting for a person</h2>
            <p>
              Queue age, priority, and existing SLA deadlines determine
              assignment order. Tickets waiting six hours take precedence to
              prevent starvation.
            </p>
            {!l.data.queue.length ? (
              <p className="quality-empty">
                No visible tickets are waiting in the human queue.
              </p>
            ) : (
              <div className="routing-queue">
                {l.data.queue.map((c: Row) => (
                  <a
                    key={c.conversation_id}
                    href={link(
                      ws,
                      "inbox",
                      `&conversation=${c.conversation_id}`,
                    )}
                    onClick={appLink}
                  >
                    <div>
                      <strong>{c.subject}</strong>
                      <small>
                        {c.team_name || "No team selected"} · {c.priority}{" "}
                        priority{c.overflowed_at ? " · Overflow" : ""}
                      </small>
                    </div>
                    <div>
                      <span>{routingReasons[c.reason] || c.reason}</span>
                      <small>
                        Queued {new Date(c.entered_at).toLocaleString()}
                      </small>
                    </div>
                  </a>
                ))}
              </div>
            )}
          </div>
          <div hidden={tab !== "teams"} className="routing-team-layout">
            <section className="panel">
              <h2>Teams</h2>
              {l.data.permissions.teams && (
                <button disabled={savingTeam} onClick={() => select("new")}>
                  New team
                </button>
              )}
              {!l.data.teams.length && (
                <p>
                  No teams yet. Create a team, add members, then choose its
                  routing policy.
                </p>
              )}
              {l.data.teams.map((t: Row) => (
                <button
                  disabled={savingTeam}
                  className="routing-team-choice"
                  key={t.id}
                  aria-pressed={selected === t.id}
                  onClick={() => select(t.id)}
                >
                  <strong>{t.name}</strong>
                  <small>
                    {t.member_ids.length} members ·{" "}
                    {t.active
                      ? t.routing_enabled
                        ? "Routing on"
                        : "Routing off"
                      : "Archived"}
                  </small>
                </button>
              ))}
            </section>
            {selected ? (
              <TeamEditor
                key={selected}
                ws={ws}
                team={l.data.teams.find((t: Row) => t.id === selected)}
                data={l.data}
                onBusy={setSavingTeam}
                onSaved={() => {
                  setSelected(null);
                  l.reload();
                }}
              />
            ) : (
              <section className="panel">
                <h2>Choose a team</h2>
                <p>
                  Review its members, queue policy, and overflow destination.
                </p>
              </section>
            )}
          </div>
          <section hidden={tab !== "capacity"} className="panel">
            <h2>Workload across all teams</h2>
            <p>
              Unresolved tickets in human mode or needing staff consume
              capacity. Waiting tickets count; resolved tickets and AI-only work
              do not. Availability expires after{" "}
              {l.data.settings.availability_ttl_seconds / 60} minutes without a
              visible app heartbeat.
            </p>
            <div className="routing-capacity-list">
              {l.data.members.map((m: Row) => (
                <CapacityRow
                  key={m.user_id}
                  ws={ws}
                  member={m}
                  ttl={l.data.settings.availability_ttl_seconds}
                  editable={l.data.permissions.routing}
                  onSaved={l.reload}
                />
              ))}
            </div>
          </section>
          {l.data.permissions.routing && (
            <div hidden={tab !== "settings"}>
              <RoutingSettingsEditor ws={ws} data={l.data} onSaved={l.reload} />
            </div>
          )}
        </>
      )}
    </div>
  );
}
function TeamEditor({
  ws,
  team,
  data,
  onSaved,
  onBusy,
}: {
  ws: string;
  team?: Row;
  data: Row;
  onSaved: () => void;
  onBusy: (busy: boolean) => void;
}) {
  const initial = {
    ...(team ? { id: team.id } : {}),
    name: team?.name ?? "",
    description: team?.description ?? "",
    active: team?.active ?? true,
    routingEnabled: team?.routing_enabled ?? false,
    overflowTeamId: team?.overflow_team_id ?? null,
    overflowAfterMinutes: team?.overflow_after_minutes ?? 30,
    memberIds: team?.member_ids ?? [],
  };
  const [draft, setDraft] = useState(initial),
    a = useAction();
  useEffect(() => {
    onBusy(a.busy);
    return () => onBusy(false);
  }, [a.busy, onBusy]);
  const dirty = JSON.stringify(draft) !== JSON.stringify(initial);
  useUnsavedChanges(dirty);
  const set = (key: string, value: unknown) =>
    setDraft((d) => ({ ...d, [key]: value }));
  return (
    <form
      className="panel routing-team-editor"
      onSubmit={(e) => {
        e.preventDefault();
        void a.run(async () => {
          await api(ws, "/routing/teams", draft);
          onSaved();
        }, "Team saved");
      }}
    >
      <h2>{team ? "Team details" : "New team"}</h2>
      <Notice action={a} />
      <fieldset disabled={a.busy || !data.permissions.teams}>
        <Field label="Team name">
          <input
            required
            maxLength={100}
            value={draft.name}
            onChange={(e) => set("name", e.target.value)}
          />
        </Field>
        <Field label="Description">
          <textarea
            maxLength={1000}
            value={draft.description}
            onChange={(e) => set("description", e.target.value)}
          />
        </Field>
        <label>
          <input
            type="checkbox"
            checked={draft.active}
            onChange={(e) => set("active", e.target.checked)}
          />{" "}
          Active team
        </label>
        <fieldset>
          <legend>Members</legend>
          <p>
            Teammates may belong to more than one team. Membership alone does
            not grant ticket permissions.
          </p>
          {data.members.map((m: Row) => (
            <label className="routing-member" key={m.user_id}>
              <input
                type="checkbox"
                checked={draft.memberIds.includes(m.user_id)}
                onChange={(e) =>
                  set(
                    "memberIds",
                    e.target.checked
                      ? [...draft.memberIds, m.user_id]
                      : draft.memberIds.filter(
                          (id: string) => id !== m.user_id,
                        ),
                  )
                }
              />
              {label(m)}
            </label>
          ))}
        </fieldset>
        <fieldset disabled={!data.permissions.routing}>
          <legend>Queue policy</legend>
          <label>
            <input
              type="checkbox"
              checked={draft.routingEnabled}
              onChange={(e) => set("routingEnabled", e.target.checked)}
            />{" "}
            Allow automatic assignment for this team
          </label>
          <Field label="Overflow team">
            <select
              value={draft.overflowTeamId ?? ""}
              onChange={(e) => set("overflowTeamId", e.target.value || null)}
            >
              <option value="">Keep tickets in this queue</option>
              {data.teams
                .filter((t: Row) => t.id !== team?.id && t.active)
                .map((t: Row) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
            </select>
          </Field>
          {draft.overflowTeamId && (
            <Field label="Overflow after minutes">
              <input
                type="number"
                min={1}
                max={10080}
                required
                value={draft.overflowAfterMinutes}
                onChange={(e) =>
                  set("overflowAfterMinutes", Number(e.target.value))
                }
              />
            </Field>
          )}
        </fieldset>
        <button className="primary" type="submit">
          {a.busy ? "Saving…" : "Save team"}
        </button>
      </fieldset>
    </form>
  );
}
function RoutingSettingsEditor({
  ws,
  data,
  onSaved,
}: {
  ws: string;
  data: Row;
  onSaved: () => void;
}) {
  const initial = {
    enabled: data.settings.enabled,
    defaultTeamId: data.settings.default_team_id,
    availabilityTtlSeconds: data.settings.availability_ttl_seconds,
  };
  const [draft, setDraft] = useState(initial),
    a = useAction();
  useEffect(
    () => setDraft(initial),
    [
      data.settings.enabled,
      data.settings.default_team_id,
      data.settings.availability_ttl_seconds,
    ],
  );
  useUnsavedChanges(JSON.stringify(draft) !== JSON.stringify(initial));
  return (
    <form
      className="panel routing-team-editor"
      onSubmit={(e) => {
        e.preventDefault();
        if (
          draft.enabled &&
          !data.settings.enabled &&
          !window.confirm(
            "Enable automatic assignment for new human-handling events? Existing owners and historical unassigned tickets will stay unchanged.",
          )
        )
          return;
        void a.run(async () => {
          await api(ws, "/routing/settings", draft, "PUT");
          onSaved();
        }, "Routing settings saved");
      }}
    >
      <h2>Automatic routing</h2>
      <Notice action={a} />
      <fieldset disabled={a.busy}>
        <label>
          <input
            type="checkbox"
            checked={draft.enabled}
            onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })}
          />{" "}
          Enable automatic human assignment
        </label>
        <Field label="Default team">
          <select
            value={draft.defaultTeamId ?? ""}
            onChange={(e) =>
              setDraft({ ...draft, defaultTeamId: e.target.value || null })
            }
          >
            <option value="">No default — show Missing team</option>
            {data.teams
              .filter((t: Row) => t.active)
              .map((t: Row) => (
                <option value={t.id} key={t.id}>
                  {t.name}
                </option>
              ))}
          </select>
        </Field>
        <Field label="Availability freshness (seconds)">
          <input
            type="number"
            min={60}
            max={1800}
            required
            value={draft.availabilityTtlSeconds}
            onChange={(e) =>
              setDraft({
                ...draft,
                availabilityTtlSeconds: Number(e.target.value),
              })
            }
          />
        </Field>
        <p>
          Agents start Offline. Available is an explicit choice. Closing the app
          expires availability; heartbeats preserve Away and Offline.
        </p>
        <button className="primary">Save routing settings</button>
      </fieldset>
    </form>
  );
}
function CapacityRow({
  ws,
  member,
  ttl,
  editable,
  onSaved,
}: {
  ws: string;
  member: Row;
  ttl: number;
  editable: boolean;
  onSaved: () => void;
}) {
  const [capacity, setCapacity] = useState(member.capacity),
    a = useAction();
  useEffect(() => setCapacity(member.capacity), [member.capacity]);
  return (
    <form
      className="routing-capacity"
      onSubmit={(e) => {
        e.preventDefault();
        void a.run(async () => {
          await api(
            ws,
            `/routing/agents/${encodeURIComponent(member.user_id)}/capacity`,
            { capacity },
            "PUT",
          );
          onSaved();
        }, "Capacity saved");
      }}
    >
      <div>
        <strong>{label(member)}</strong>
        <small>
          {effective(member, ttl)} · {member.workload} active human tickets
        </small>
      </div>
      {editable ? (
        <>
          <label>
            Ticket limit
            <input
              aria-label={`Ticket limit for ${label(member)}`}
              type="number"
              min={1}
              max={200}
              required
              value={capacity}
              disabled={a.busy}
              onChange={(e) => setCapacity(Number(e.target.value))}
            />
          </label>
          <button disabled={a.busy || capacity === member.capacity}>
            Save limit
          </button>
        </>
      ) : (
        <span>Limit {member.capacity}</span>
      )}
      <Notice action={a} />
    </form>
  );
}

/** Existing inbox inspector integration; uses the same manual API as macros/control. */
export function RoutingAssignment({
  ws,
  conv,
  onChange,
}: {
  ws: string;
  conv: Row;
  onChange: () => void;
}) {
  const l = useLoad(() => api(ws, "/routing"), [ws]),
    h = useLoad(
      () => api(ws, `/conversations/${conv.id}/routing`),
      [ws, conv.id, conv.revision],
    ),
    a = useAction();
  const [teamId, setTeamId] = useState(conv.team_id ?? ""),
    [assignedTo, setAssignedTo] = useState(conv.assigned_to ?? ""),
    [override, setOverride] = useState(false),
    [reason, setReason] = useState("");
  useEffect(() => {
    setTeamId(conv.team_id ?? "");
    setAssignedTo(conv.assigned_to ?? "");
    setOverride(false);
    setReason("");
  }, [conv.id, conv.team_id, conv.assigned_to]);
  const changed =
    teamId !== (conv.team_id ?? "") || assignedTo !== (conv.assigned_to ?? "");
  useUnsavedChanges(changed);
  const team = l.data?.teams.find((t: Row) => t.id === teamId);
  return (
    <section className="routing-inspector">
      <h3>Human assignment</h3>
      <Notice action={a} error={l.error || h.error} />
      {l.data && (
        <>
          <p>
            {h.data?.queue && routingReasons[h.data.queue.reason]}
            {conv.assignment_source === "manual"
              ? " · Manual ownership is protected until explicitly requeued."
              : ""}
          </p>
          {l.data.permissions.assign && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void a.run(async () => {
                  await api(ws, `/conversations/${conv.id}/routing/assign`, {
                    teamId: teamId || null,
                    assignedTo: assignedTo || null,
                    overrideCapacity: override,
                    reason,
                  });
                  onChange();
                  h.reload();
                }, "Assignment saved");
              }}
            >
              <fieldset disabled={a.busy}>
                <Field label="Assign to team">
                  <select
                    value={teamId}
                    onChange={(e) => {
                      setTeamId(e.target.value);
                      setAssignedTo("");
                    }}
                  >
                    <option value="">No team</option>
                    {l.data.teams
                      .filter((t: Row) => t.active || t.id === teamId)
                      .map((t: Row) => (
                        <option value={t.id} key={t.id}>
                          {t.name}
                        </option>
                      ))}
                  </select>
                </Field>
                <Field label="Assign to teammate">
                  <select
                    value={assignedTo}
                    onChange={(e) => setAssignedTo(e.target.value)}
                  >
                    <option value="">Leave unassigned</option>
                    {l.data.members
                      .filter(
                        (m: Row) =>
                          !team || team.member_ids.includes(m.user_id),
                      )
                      .map((m: Row) => (
                        <option value={m.user_id} key={m.user_id}>
                          {label(m)} · {m.workload}/{m.capacity}
                        </option>
                      ))}
                  </select>
                </Field>
                {l.data.permissions.override && (
                  <>
                    <label>
                      <input
                        type="checkbox"
                        checked={override}
                        onChange={(e) => setOverride(e.target.checked)}
                      />{" "}
                      Override capacity for this assignment
                    </label>
                    {override && (
                      <Field label="Capacity override reason">
                        <input
                          required
                          maxLength={500}
                          value={reason}
                          onChange={(e) => setReason(e.target.value)}
                        />
                      </Field>
                    )}
                  </>
                )}
                <button disabled={!changed && !override}>
                  Save assignment
                </button>
                <button
                  type="button"
                  onClick={() => {
                    if (
                      !window.confirm(
                        "Release manual ownership and return this ticket to automatic routing?",
                      )
                    )
                      return;
                    void a.run(async () => {
                      await api(
                        ws,
                        `/conversations/${conv.id}/routing/requeue`,
                        {},
                      );
                      onChange();
                      h.reload();
                    }, "Ticket requeued");
                  }}
                >
                  Requeue for automatic assignment
                </button>
              </fieldset>
            </form>
          )}
          <details>
            <summary>Assignment history</summary>
            {!h.data?.history.length && <p>No routing decisions recorded.</p>}
            {h.data?.history.map((event: Row) => (
              <p key={event.id}>
                <strong>
                  {event.kind.replace("routing.", "").replaceAll("_", " ")}
                </strong>{" "}
                · {new Date(event.created_at).toLocaleString()}
                <br />
                {event.data.reason || event.data.source}
                {event.data.selectedAgent &&
                  ` · ${l.data.members.find((m: Row) => m.user_id === event.data.selectedAgent)?.name || event.data.selectedAgent}`}
                {event.data.overrideCapacity && " · Capacity override"}
              </p>
            ))}
          </details>
        </>
      )}
    </section>
  );
}
