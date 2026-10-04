import { useEffect, useRef, useState } from "react";
import { api } from "./request.js";
import { useAction } from "./useAction.js";

export function InboxReadControl({
  ws,
  id,
  state,
  active,
  onChange,
}: {
  ws: string;
  id: string;
  state?: { cursor: string; unread: boolean };
  active: boolean;
  onChange: () => void;
}) {
  const a = useAction();
  const [local, setLocal] = useState<typeof state>();
  const heldUnread = useRef(false),
    attempted = useRef("");
  const change = useRef(onChange);
  change.current = onChange;
  const current = local?.cursor === state?.cursor ? local : state;
  const update = (read: boolean) => {
    if (!state || a.busy) return;
    const cursor = state.cursor;
    attempted.current = cursor;
    void a.run(async () => {
      const result = await api(
        ws,
        `/conversations/${id}/read`,
        read ? { read, cursor } : { read },
        "PUT",
      );
      heldUnread.current = !read;
      setLocal({ cursor, unread: result.unread });
      change.current();
    });
  };
  const acknowledge = useRef(() => {});
  acknowledge.current = () => {
    if (
      active &&
      !document.hidden &&
      current?.unread &&
      !heldUnread.current &&
      attempted.current !== state?.cursor
    )
      update(true);
  };
  useEffect(() => {
    if (!active) {
      heldUnread.current = false;
      attempted.current = "";
    } else acknowledge.current();
  }, [active, state?.cursor, state?.unread, a.busy]);
  useEffect(() => {
    const visible = () => acknowledge.current();
    document.addEventListener("visibilitychange", visible);
    window.addEventListener("focus", visible);
    return () => {
      document.removeEventListener("visibilitychange", visible);
      window.removeEventListener("focus", visible);
    };
  }, []);
  return (
    <span className="inbox-read-control">
      <button
        disabled={!state || a.busy}
        onClick={() => update(Boolean(current?.unread))}
        title="Read status is personal and does not close the conversation"
      >
        {a.error
          ? "Retry read status"
          : current?.unread
            ? "Mark as read"
            : "Mark as unread"}
      </button>
      {a.error && <span role="alert">{a.error}</span>}
    </span>
  );
}
