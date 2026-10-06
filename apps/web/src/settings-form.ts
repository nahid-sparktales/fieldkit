import { useCallback, useRef, useState } from "react";
import { confirmDiscardChanges, useUnsavedChanges } from "./unsaved-changes.js";

// Baselines live only in the mounted form. Passwords, files and credentials are
// never copied into a draft; switching workspaces mounts a fresh baseline.
type Control = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
const controls = (form: HTMLFormElement) =>
  Array.from(form.elements).filter(
    (element): element is Control =>
      (element instanceof HTMLInputElement ||
        element instanceof HTMLSelectElement ||
        element instanceof HTMLTextAreaElement) &&
      !!element.name &&
      !/password|secret|credential|apiKey/i.test(element.name) &&
      !(
        element instanceof HTMLInputElement &&
        ["password", "file", "hidden", "checkbox", "radio"].includes(
          element.type,
        )
      ),
  );
const values = (form: HTMLFormElement) =>
  Object.fromEntries(
    controls(form).map((element) => [element.name, element.value]),
  );

export function useSettingsForm(key: string) {
  const form = useRef<HTMLFormElement | null>(null);
  const baseline = useRef<Record<string, string>>({});
  const [dirty, setDirty] = useState(false);
  useUnsavedChanges(dirty);
  const ref = useCallback(
    (node: HTMLFormElement | null) => {
      form.current = node;
      if (node) {
        baseline.current = values(node);
        setDirty(false);
      }
    },
    [key],
  );
  const saved = () => {
    if (form.current) baseline.current = values(form.current);
    setDirty(false);
  };
  return {
    ref,
    dirty,
    saved,
    onChange: () => {
      if (form.current)
        setDirty(
          JSON.stringify(values(form.current)) !==
            JSON.stringify(baseline.current),
        );
    },
    discard: () => {
      if (
        !form.current ||
        !confirmDiscardChanges("Discard your unsaved changes in this section?")
      )
        return;
      for (const element of controls(form.current))
        element.value = baseline.current[element.name] ?? "";
      setDirty(false);
    },
  };
}
