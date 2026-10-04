import {
  Children,
  cloneElement,
  isValidElement,
  useEffect,
  useId,
  useRef,
  type ReactNode,
  type ReactElement,
} from "react";

export function SettingsField({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <label className="appearance-field">
      <span id={id}>{label}</span>
      {Children.map(children, (child) =>
        isValidElement(child) &&
        ["input", "textarea", "select"].includes(String(child.type))
          ? cloneElement(child as ReactElement<{ "aria-labelledby": string }>, {
              "aria-labelledby": id,
            })
          : child,
      )}
    </label>
  );
}

export function LoadingState({ label = "Loading…" }: { label?: string }) {
  return (
    <div className="loading-state" role="status">
      <span className="loading-spinner" aria-hidden="true" />
      {label}
    </div>
  );
}

export function PreviewDialog({
  title,
  children,
  close,
}: {
  title: string;
  children: ReactNode;
  close: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const dialog = ref.current!;
    const trigger = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    dialog.showModal();
    document.body.style.overflow = "hidden";
    return () => {
      dialog.close();
      document.body.style.overflow = overflow;
      trigger?.focus();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className="preview-dialog"
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
    >
      <header>
        <h2 id={titleId}>{title}</h2>
        <button onClick={close} aria-label="Close preview" autoFocus>
          ×
        </button>
      </header>
      {children}
    </dialog>
  );
}
