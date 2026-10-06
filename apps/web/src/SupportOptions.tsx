import { useEffect, useState } from "react";
import {
  supportMode,
  type SupportMode,
} from "../../../packages/platform/src/support-options.js";
import { api } from "./request.js";
import { useAction } from "./useAction.js";
import { useUnsavedChanges, confirmDiscardChanges } from "./unsaved-changes.js";
import "./content-workspace.css";
import { Notice, type Row } from "./quality-ui.js";

const choices: {
  value: SupportMode;
  title: string;
  description: string;
  icon: string;
}[] = [
  {
    value: "both",
    title: "Tickets & chatbot",
    description: "Email support plus a pop-up assistant.",
    icon: "✉ + ◌",
  },
  {
    value: "tickets",
    title: "Tickets only",
    description: "Customers send a request and receive replies by email.",
    icon: "✉",
  },
  {
    value: "chat",
    title: "Chatbot only",
    description: "A live assistant in the bottom-right corner.",
    icon: "◌",
  },
  {
    value: "none",
    title: "Neither",
    description: "A self-service help center with your articles.",
    icon: "☰",
  },
];

export function SupportOptions({
  ws,
  channels,
  owner,
  saved,
}: {
  ws: string;
  channels: Row[];
  owner: boolean;
  saved: () => void;
}) {
  const current = supportMode(channels as Parameters<typeof supportMode>[0]);
  const [mode, setMode] = useState<SupportMode>(current);
  const a = useAction();
  useUnsavedChanges(mode !== current);
  useEffect(() => setMode(current), [current]);
  const portalPublished = channels.some(
    (c) => c.kind === "portal" && c.published,
  );
  return (
    <section className="panel support-options">
      <span className="eyebrow">YOUR CUSTOMER EXPERIENCE</span>
      <h2>How can customers contact you?</h2>
      <p>
        Choose what to offer in your help center. The chatbot setting also
        controls your embedded website widget.
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void a.run(async () => {
            await api(ws, "/support-options", { mode }, "PUT");
            saved();
          }, "Support options saved.");
        }}
      >
        <fieldset disabled={!owner || a.busy} className="support-mode-options">
          <legend className="sr-only">Support options</legend>
          {choices.map((choice) => (
            <label key={choice.value}>
              <input
                type="radio"
                name="support-mode"
                value={choice.value}
                checked={mode === choice.value}
                onChange={() => {
                  setMode(choice.value);
                  a.setError("");
                  a.setSuccess("");
                }}
              />
              <span>
                <span className="support-option-icon" aria-hidden="true">
                  {choice.icon}
                </span>
                <strong>{choice.title}</strong>
                <small>{choice.description}</small>
              </span>
            </label>
          ))}
        </fieldset>
        <p className="muted">
          Existing ticket history and email replies stay available. Turning off
          chat removes the launcher and pauses automated replies in active
          chats.
        </p>
        {!portalPublished && (
          <p className="muted">
            Publish the support portal from All channels when you’re ready to
            make your help center available.
          </p>
        )}
        <p className="muted" role="status">
          {mode !== current ? "Unsaved changes" : "All changes saved"}
        </p>
        {owner ? (
          <div className="button-row">
            <button className="primary" disabled={a.busy || mode === current}>
              {a.busy ? "Saving…" : "Save support options"}
            </button>
            <button
              type="button"
              disabled={a.busy || mode === current}
              onClick={() => {
                if (confirmDiscardChanges("Discard unsaved support options?"))
                  setMode(current);
              }}
            >
              Discard changes
            </button>
          </div>
        ) : (
          <p className="muted">
            Only the workspace owner can change these options.
          </p>
        )}
        <Notice action={a} />
      </form>
    </section>
  );
}
