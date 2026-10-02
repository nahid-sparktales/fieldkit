import {
  Children,
  cloneElement,
  isValidElement,
  useEffect,
  type ReactNode,
  type ReactElement,
} from "react";
import { api, useLoad } from "./request.js";
import type { useAction } from "./useAction.js";
import "./quality.css";
export type Row = Record<string, any>;
export function useQuality(ws: string, path: string) {
  const l = useLoad(() => api(ws, path), [ws, path]);
  useEffect(() => {
    const stream = new EventSource(`/v2/workspaces/${ws}/quality/events`);
    stream.onmessage = l.reload;
    return () => stream.close();
  }, [ws, path]);
  return l;
}
export function Notice({
  action,
  error,
}: {
  action: ReturnType<typeof useAction>;
  error?: string;
}) {
  return (
    <>
      <div role="alert">
        {(error || action.error) && (
          <p className="error">{error || action.error}</p>
        )}
      </div>
      <div role="status">
        {action.success && <p className="success">{action.success}</p>}
      </div>
    </>
  );
}
export function Field({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <label className="quality-field">
      <span>{label}</span>
      {Children.map(children, (child) =>
        isValidElement(child) &&
        ["input", "textarea", "select"].includes(String(child.type))
          ? cloneElement(child as ReactElement<{ "aria-label"?: string }>, {
              "aria-label": label,
            })
          : child,
      )}
    </label>
  );
}
export function Inspect({ title, value }: { title: string; value: unknown }) {
  return (
    <details>
      <summary>{title}</summary>
      <pre className="quality-json">{JSON.stringify(value, null, 2)}</pre>
    </details>
  );
}
export const link = (ws: string, view: string, extra = "") =>
  `/?workspace=${ws}&view=${encodeURIComponent(view)}${extra}`;
