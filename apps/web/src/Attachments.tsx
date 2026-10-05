import { useEffect, useRef, useState } from "react";
import { api, useLoad } from "./request.js";
import { useAction } from "./useAction.js";
import { Notice, type Row } from "./quality-ui.js";
import "./attachments.css";

export const attachmentIds = (files: Row[] = []) =>
  files
    .filter((f) => f.id && !f.uploading && !f.uploadError)
    .map((f) => f.id as string);
export const attachmentsPending = (files: Row[] = []) =>
  files.some((f) => f.uploading || f.uploadError);
export function AttachmentPicker({
  ws,
  conversationId,
  channelId,
  privateNote = false,
  bearer,
  customer = false,
  files,
  onChange,
  disabled = false,
}: {
  ws: string;
  conversationId?: string;
  channelId?: string;
  privateNote?: boolean;
  bearer?: string;
  customer?: boolean;
  files: Row[];
  onChange: (files: Row[]) => void;
  disabled?: boolean;
}) {
  const settings = useLoad(
    () =>
      api(ws, "/attachments/settings", undefined, undefined, bearer, customer),
    [ws, bearer, customer],
  );
  const latest = useRef(files);
  latest.current = files;
  const requests = useRef(new Map<string, XMLHttpRequest>()),
    selected = useRef(new Map<string, File>());
  const change = (fn: (rows: Row[]) => Row[]) => {
    latest.current = fn(latest.current);
    onChange(latest.current);
  };
  const [error, setError] = useState("");
  useEffect(
    () => () => {
      for (const xhr of requests.current.values()) xhr.abort();
    },
    [],
  );
  async function upload(file: File, key: string) {
    selected.current.set(key, file);
    setError("");
    change((rows) =>
      rows.some((r) => r.key === key)
        ? rows.map((r) =>
            r.key === key ? { ...r, uploading: true, uploadError: "" } : r,
          )
        : [...rows, { key, name: file.name, uploading: true, progress: 0 }],
    );
    try {
      const row = await api(
        ws,
        "/attachments",
        {
          ...(conversationId ? { conversationId } : { channelId }),
          name: file.name,
          size: file.size,
          mime: file.type || "application/octet-stream",
          private: privateNote,
          requestKey: key,
        },
        undefined,
        bearer,
        customer,
      );
      if (!latest.current.some((r) => r.key === key)) {
        await api(
          ws,
          `/attachments/${row.id}`,
          { action: "cancel" },
          "PATCH",
          bearer,
          customer,
        );
        return;
      }
      change((rows) =>
        rows.map((r) =>
          r.key === key ? { ...r, ...row, uploading: true } : r,
        ),
      );
      if (row.status !== "uploading") {
        change((rows) =>
          rows.map((r) =>
            r.key === key
              ? { ...r, ...row, uploading: false, progress: 100 }
              : r,
          ),
        );
        return;
      }
      await new Promise<void>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        requests.current.set(key, xhr);
        xhr.open("PUT", `/v2/workspaces/${ws}/attachments/${row.id}/content`);
        xhr.setRequestHeader("Content-Type", "application/octet-stream");
        if (bearer) xhr.setRequestHeader("Authorization", `Bearer ${bearer}`);
        if (customer) xhr.setRequestHeader("X-Fieldkit-Audience", "customer");
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable)
            change((rows) =>
              rows.map((r) =>
                r.key === key
                  ? { ...r, progress: Math.round((e.loaded / e.total) * 100) }
                  : r,
              ),
            );
        };
        xhr.onload = () => {
          let result: Row;
          try {
            result = JSON.parse(xhr.responseText);
          } catch {
            reject(
              new Error(
                "Upload response could not be read. Retry to check its status.",
              ),
            );
            return;
          }
          if (xhr.status >= 200 && xhr.status < 300) {
            change((rows) =>
              rows.map((r) =>
                r.key === key
                  ? { ...r, ...result, uploading: false, progress: 100 }
                  : r,
              ),
            );
            resolve();
          } else reject(new Error(result.error || "File upload failed"));
        };
        xhr.onerror = () =>
          reject(new Error("Upload interrupted. Retry or remove the file."));
        xhr.onabort = () => reject(new Error("Upload canceled"));
        xhr.send(file);
      });
    } catch (e) {
      change((rows) =>
        rows.map((r) =>
          r.key === key
            ? { ...r, uploading: false, uploadError: (e as Error).message }
            : r,
        ),
      );
    } finally {
      requests.current.delete(key);
    }
  }
  if (!settings.data?.allowed) return null;
  return (
    <details
      className="attachment-picker"
      open={files.length ? true : undefined}
    >
      <summary>
        Attach files{privateNote ? " to internal note" : ""}
        {files.length ? ` (${files.length})` : ""}
      </summary>
      <p>
        PNG, JPEG, PDF or text logs · up to{" "}
        {Math.round(settings.data.limits.fileBytes / 1024 / 1024)} MB each.
        Files are scanned privately; the AI does not inspect them.
      </p>
      <label>
        Choose files
        <input
          type="file"
          multiple
          accept=".png,.jpg,.jpeg,.pdf,.txt,.log"
          disabled={disabled || files.some((f) => f.uploading)}
          onChange={(e) => {
            const selectedFiles = Array.from(e.target.files ?? []);
            e.target.value = "";
            if (
              files.length + selectedFiles.length >
              settings.data.limits.count
            ) {
              setError(
                `Attach at most ${settings.data.limits.count} files per message`,
              );
              return;
            }
            void (async () => {
              for (const file of selectedFiles)
                await upload(file, crypto.randomUUID());
            })();
          }}
        />
      </label>
      {error && <p role="alert">{error}</p>}
      <ul>
        {files.map((f) => (
          <li key={f.key || f.id}>
            <strong>{f.name}</strong>
            {f.uploading ? (
              <>
                <progress
                  max={100}
                  value={f.progress || 0}
                  aria-label={`Uploading ${f.name}`}
                />
                <span>{f.progress || 0}% uploaded</span>
              </>
            ) : (
              <span>
                {f.uploadError ||
                  f.error ||
                  (f.status === "available"
                    ? "Scan complete"
                    : "Uploaded · scanning before access")}
              </span>
            )}
            {f.uploadError && selected.current.has(f.key) && (
              <button
                type="button"
                disabled={disabled}
                onClick={() => upload(selected.current.get(f.key)!, f.key)}
              >
                Retry upload
              </button>
            )}
            <button
              type="button"
              disabled={disabled}
              onClick={async () => {
                requests.current.get(f.key)?.abort();
                if (f.id)
                  try {
                    await api(
                      ws,
                      `/attachments/${f.id}`,
                      { action: "cancel" },
                      "PATCH",
                      bearer,
                      customer,
                    );
                  } catch (e) {
                    setError((e as Error).message);
                    return;
                  }
                change((rows) =>
                  rows.filter((r) => r !== f && r.key !== f.key),
                );
                selected.current.delete(f.key);
              }}
            >
              {f.uploading ? "Cancel upload" : "Remove file"}
            </button>
          </li>
        ))}
      </ul>
    </details>
  );
}
export function AttachmentCards({
  ws,
  files,
  bearer,
  customer = false,
}: {
  ws: string;
  files: Row[];
  bearer?: string;
  customer?: boolean;
}) {
  const a = useAction(),
    [preview, setPreview] = useState<{
      id: string;
      text?: string;
      url?: string;
    }>();
  useEffect(
    () => () => {
      if (preview?.url) URL.revokeObjectURL(preview.url);
    },
    [preview?.url],
  );
  async function fetchFile(file: Row, inline = false) {
    const res = await fetch(
      `/v2/workspaces/${ws}/attachments/${file.id}/content${inline ? "?preview=true" : ""}`,
      {
        headers: {
          ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
          ...(customer ? { "X-Fieldkit-Audience": "customer" } : {}),
        },
      },
    );
    if (!res.ok)
      throw new Error((await res.json()).error || "File unavailable");
    if (inline) {
      if (file.mime === "text/plain")
        setPreview({ id: file.id, text: await res.text() });
      else
        setPreview({ id: file.id, url: URL.createObjectURL(await res.blob()) });
    } else {
      const url = URL.createObjectURL(await res.blob()),
        anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = file.name;
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
  }
  return (
    <div className="attachment-cards">
      <Notice action={a} />
      {files.map((file) => (
        <article key={file.id} className="attachment-card">
          <strong>{file.name}</strong>
          <span>
            {Math.ceil(file.bytes / 1024)} KB ·{" "}
            {file.visibility === "staff"
              ? "Internal note file"
              : "Conversation file"}
          </span>
          <p>
            {file.status === "available"
              ? `No malware detected by ${file.scan?.engine} at ${new Date(file.scan?.scannedAt).toLocaleString()}`
              : file.error || file.status.replaceAll("_", " ")}
          </p>
          <small>AI has not inspected this file.</small>
          {file.status === "available" && (
            <div>
              <button
                type="button"
                disabled={a.busy}
                onClick={() => a.run(() => fetchFile(file))}
              >
                Download
              </button>
              {!customer && file.mime !== "application/pdf" && (
                <button
                  type="button"
                  disabled={a.busy}
                  onClick={() => a.run(() => fetchFile(file, true))}
                >
                  Preview
                </button>
              )}
            </div>
          )}
          {file.status === "scan_failed" && (
            <button
              type="button"
              disabled={a.busy}
              onClick={() =>
                a.run(async () => {
                  await api(
                    ws,
                    `/attachments/${file.id}`,
                    { action: "retry" },
                    "PATCH",
                    bearer,
                    customer,
                  );
                }, "Scan queued. The file remains unavailable until scanning succeeds.")
              }
            >
              Retry scan
            </button>
          )}
          {preview && preview.id === file.id && (
            <div className="attachment-preview">
              {preview.url ? (
                <img
                  src={preview.url}
                  alt={`Preview of ${file.name}`}
                  loading="lazy"
                />
              ) : (
                <pre>{preview.text}</pre>
              )}
              <button type="button" onClick={() => setPreview(undefined)}>
                Close preview
              </button>
            </div>
          )}
        </article>
      ))}
    </div>
  );
}
export function AttachmentSettingsPanel({
  ws,
  owner,
}: {
  ws: string;
  owner: boolean;
}) {
  const l = useLoad(() => api(ws, "/attachments/settings"), [ws]),
    a = useAction();
  const [settings, setSettings] = useState<Row | null>(null);
  useEffect(() => {
    if (l.data) setSettings(l.data);
  }, [l.data]);
  return (
    <section className="panel">
      <h2>Customer attachments</h2>
      <p>
        Private uploads for native tickets, chat and internal notes. A working
        private ClamAV scanner is required. Files never enter AI or shared
        knowledge automatically.
      </p>
      <Notice action={a} error={l.error} />
      {settings && (
        <>
          {[
            ["enabled", "Allow attachments"],
            ["anonymous", "Allow anonymous chat uploads (stricter limits)"],
          ].map(([key, label]) => (
            <label className="check-label" key={key}>
              <input
                type="checkbox"
                checked={settings[key]}
                disabled={
                  !owner || a.busy || (key === "anonymous" && !settings.enabled)
                }
                onChange={(e) => {
                  const next = { ...settings, [key]: e.target.checked };
                  setSettings(next);
                  void a.run(async () => {
                    try {
                      const result = await api(
                        ws,
                        "/attachments/settings",
                        { enabled: next.enabled, anonymous: next.anonymous },
                        "PUT",
                      );
                      setSettings(result);
                    } catch (error) {
                      setSettings(settings);
                      throw error;
                    }
                  }, "Attachment settings updated.");
                }}
              />
              {label}
            </label>
          ))}
          <p>
            Up to {settings.limits.count} files per message. Zendesk binary
            forwarding is not supported. Outgoing emails link to the portal.
          </p>
        </>
      )}
    </section>
  );
}
