import { useEffect, useRef } from "react";
// Tab-memory only: no persisted secrets or authorization checkboxes. Native form
// values survive page navigation; explicit effect consent must always be renewed.
const drafts = new Map<string, Record<string, string>>();
export function useFormDraft(key: string) {
  const ref = useRef<HTMLFormElement>(null);
  useEffect(() => {
    const form = ref.current;
    if (!form) return;
    const saved = drafts.get(key);
    for (const el of Array.from(form.elements))
      if (
        (el instanceof HTMLInputElement ||
          el instanceof HTMLSelectElement ||
          el instanceof HTMLTextAreaElement) &&
        el.name &&
        saved?.[el.name] !== undefined &&
        !(
          el instanceof HTMLInputElement &&
          ["checkbox", "password", "file", "hidden"].includes(el.type)
        )
      )
        el.value = saved[el.name];
    const save = () => {
      const data: Record<string, string> = {};
      for (const el of Array.from(form.elements))
        if (
          (el instanceof HTMLInputElement ||
            el instanceof HTMLSelectElement ||
            el instanceof HTMLTextAreaElement) &&
          el.name &&
          !(
            el instanceof HTMLInputElement &&
            ["checkbox", "password", "file", "hidden"].includes(el.type)
          )
        )
          data[el.name] = el.value;
      drafts.set(key, data);
    };
    form.addEventListener("input", save);
    form.addEventListener("change", save);
    return () => {
      save();
      form.removeEventListener("input", save);
      form.removeEventListener("change", save);
    };
  }, [key]);
  return ref;
}
