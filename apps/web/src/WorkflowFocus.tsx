import {
  useEffect,
  useId,
  useRef,
  type ReactNode,
  type RefObject,
} from "react";

// Keep the editor mounted so draft fields, selection, and undo history survive expansion.
export function WorkflowFocus({
  expanded,
  close,
  title,
  children,
  actions,
  triggerRef,
}: {
  expanded: boolean;
  close: () => void;
  title: string;
  children: ReactNode;
  actions: ReactNode;
  triggerRef: RefObject<HTMLButtonElement | null>;
}) {
  const ref = useRef<HTMLDivElement>(null),
    closeRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  useEffect(() => {
    if (!expanded) return;
    const panel = ref.current!;
    const trigger = triggerRef.current;
    const overflow = document.body.style.overflow;
    // Inert siblings at each level, including the shell navigation outside this page.
    const siblings: { element: HTMLElement; inert: boolean }[] = [];
    let branch: HTMLElement = panel;
    while (branch.parentElement) {
      for (const element of branch.parentElement.children) {
        if (element !== branch && element instanceof HTMLElement) {
          siblings.push({ element, inert: element.inert });
          element.inert = true;
        }
      }
      branch = branch.parentElement;
      if (branch === document.body) break;
    }
    document.body.style.overflow = "hidden";
    closeRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const controls = Array.from(
        panel.querySelectorAll<HTMLElement>(
          'button, input, select, textarea, a[href], summary, [tabindex="0"]',
        ),
      ).filter(
        (element) =>
          !element.matches(":disabled") &&
          element.getClientRects().length > 0 &&
          !element.closest("[hidden], [inert]"),
      );
      const first = controls[0],
        last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    panel.addEventListener("keydown", onKeyDown);
    return () => {
      panel.removeEventListener("keydown", onKeyDown);
      for (const { element, inert } of siblings) element.inert = inert;
      document.body.style.overflow = overflow;
      if (trigger?.isConnected) trigger.focus({ preventScroll: true });
    };
  }, [expanded, triggerRef]);
  return (
    <div
      ref={ref}
      className={`wf-stage${expanded ? " wf-stage-expanded" : ""}`}
      role={expanded ? "dialog" : undefined}
      aria-modal={expanded || undefined}
      aria-labelledby={expanded ? titleId : undefined}
      onKeyDown={(event) => {
        if (expanded && event.key === "Escape" && !event.defaultPrevented) {
          event.preventDefault();
          close();
        }
      }}
    >
      {expanded && (
        <header className="wf-focus-header">
          <div>
            <span className="eyebrow">WORKFLOW EDITOR</span>
            <h2 id={titleId}>{title}</h2>
          </div>
          <div className="button-row">
            {actions}
            <button ref={closeRef} onClick={close}>
              Close expanded editor
            </button>
          </div>
        </header>
      )}
      {children}
    </div>
  );
}
