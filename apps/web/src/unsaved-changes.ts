import { useEffect } from "react";

// Only tracks whether mounted editors are dirty; never stores their contents.
const dirtyEditors = new Set<object>();

export function confirmDiscardChanges(message?: string): boolean {
  return (
    (!message && dirtyEditors.size === 0) ||
    window.confirm(message ?? "Leave this page and discard unsaved changes?")
  );
}

export function useUnsavedChanges(dirty: boolean) {
  useEffect(() => {
    if (!dirty) return;
    const editor = {};
    dirtyEditors.add(editor);
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => {
      dirtyEditors.delete(editor);
      window.removeEventListener("beforeunload", warn);
    };
  }, [dirty]);
}
