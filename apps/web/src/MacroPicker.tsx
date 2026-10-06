import { useState } from "react";
import { api, useLoad } from "./request.js";
import { useAction } from "./useAction.js";
import "./productivity.css";
export type MacroDraft = {
  id: string;
  revision: number;
  changes: Record<string, any>;
};
export function MacroPicker({
  ws,
  id,
  disabled = false,
  onApply,
}: {
  ws: string;
  id: string;
  disabled?: boolean;
  onApply: (draft: { body: string; note: boolean; macro: MacroDraft }) => void;
}) {
  const [open, setOpen] = useState(false),
    [search, setSearch] = useState(""),
    [preview, setPreview] = useState<any>(null),
    a = useAction();
  const l = useLoad(() => api(ws, "/macros"), [ws]);
  return (
    <div className="macro-picker">
      <button
        type="button"
        disabled={disabled}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        Use a macro
      </button>
      {open && (
        <div className="macro-picker-panel">
          <label>
            Find a macro
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search saved replies and actions…"
            />
          </label>
          {(l.error || a.error) && (
            <p className="alert" role="alert">
              {l.error || a.error}
              <button type="button" onClick={l.reload}>
                Refresh
              </button>
            </p>
          )}
          {!l.data && !l.error && <p role="status">Loading macros…</p>}
          <div className="macro-results">
            {l.data?.macros
              .filter((m: any) =>
                `${m.name} ${m.description}`
                  .toLowerCase()
                  .includes(search.toLowerCase()),
              )
              .map((m: any) => (
                <button
                  key={m.id}
                  type="button"
                  disabled={a.busy}
                  onClick={() =>
                    void a.run(async () =>
                      setPreview(
                        await api(
                          ws,
                          `/conversations/${id}/macros/${m.id}/preview`,
                          {},
                        ),
                      ),
                    )
                  }
                >
                  <strong>{m.name}</strong>
                  <small>
                    {m.note ? "Internal note" : "Public reply"} · {m.scope}
                  </small>
                </button>
              ))}
          </div>
          {l.data && !l.data.macros.length && (
            <p>No macros yet. Create one in Productivity → Macros.</p>
          )}
          {preview && (
            <section aria-label="Macro draft preview">
              <h4>Review the draft</h4>
              <textarea
                aria-label="Macro reply preview"
                value={preview.body}
                rows={6}
                maxLength={12000}
                onChange={(e) =>
                  setPreview({ ...preview, body: e.target.value })
                }
              />
              {preview.missing.length > 0 && (
                <p className="field-hint">
                  Fill in: {preview.missing.join(", ")}
                </p>
              )}
              <p>
                {preview.note
                  ? "This will prepare an internal note."
                  : "This will prepare a public reply."}
              </p>
              {Object.entries(preview.macro.changes).map(([key, value]) => (
                <label className="macro-change" key={key}>
                  <span>
                    {key}:{" "}
                    {typeof value === "object"
                      ? JSON.stringify(value)
                      : String(value ?? "Unassigned")}
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      const changes = { ...preview.macro.changes };
                      delete changes[key];
                      setPreview({
                        ...preview,
                        macro: { ...preview.macro, changes },
                      });
                    }}
                  >
                    Remove change
                  </button>
                </label>
              ))}
              <p className="field-hint">
                Nothing has been sent. You can edit the composer before using
                its Send or Save button.
              </p>
              <div className="button-row">
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => {
                    onApply(preview);
                    setPreview(null);
                    setOpen(false);
                  }}
                >
                  Use this draft
                </button>
                <button type="button" onClick={() => setPreview(null)}>
                  Cancel preview
                </button>
              </div>
            </section>
          )}
        </div>
      )}
    </div>
  );
}
export function MacroChanges({
  macro,
  onChange,
}: {
  macro: MacroDraft;
  onChange: (v: MacroDraft | undefined) => void;
}) {
  return (
    <div className="macro-staged">
      <strong>Changes staged with this response</strong>
      {Object.entries(macro.changes).map(([key, value]) => (
        <div key={key}>
          <span>
            {key}:{" "}
            {typeof value === "object"
              ? JSON.stringify(value)
              : String(value ?? "Unassigned")}
          </span>
          <button
            type="button"
            onClick={() => {
              const changes = { ...macro.changes };
              delete changes[key];
              onChange({ ...macro, changes });
            }}
          >
            Remove {key}
          </button>
        </div>
      ))}
      <button type="button" onClick={() => onChange(undefined)}>
        Remove macro changes
      </button>
      <p className="field-hint">
        Applied atomically when you explicitly send or save this response.
        Permissions are checked again then.
      </p>
    </div>
  );
}
