import { useEffect, useRef } from "react";
import { AttachmentCards } from "./Attachments.js";
type Row = Record<string, any>;
export function useConversationEvents(
  ws: string,
  id: string | undefined,
  reload: () => void,
  bearer?: string,
  customer = false,
) {
  const callback = useRef(reload);
  callback.current = reload;
  useEffect(() => {
    if (!id) return;
    const controller = new AbortController();
    let retry: ReturnType<typeof setTimeout>;
    let refresh: ReturnType<typeof setTimeout> | undefined;
    let lastId = "";
    const scheduleRefresh = () => {
      if (refresh || controller.signal.aborted) return;
      refresh = setTimeout(() => {
        refresh = undefined;
        callback.current();
      }, 150);
    };
    const connect = async () => {
      try {
        const res = await fetch(
          `/v2/workspaces/${ws}/conversations/${id}/events`,
          {
            signal: controller.signal,
            headers: {
              ...(lastId ? { "Last-Event-ID": lastId } : {}),
              ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
              ...(customer ? { "X-Fieldkit-Audience": "customer" } : {}),
            },
          },
        );
        if (!res.ok) {
          scheduleRefresh();
          if (res.status === 429 || res.status >= 500)
            retry = setTimeout(connect, 5000);
          return;
        }
        const reader = res.body!.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let index;
          while ((index = buffer.indexOf("\n\n")) >= 0) {
            const event = buffer.slice(0, index);
            buffer = buffer.slice(index + 2);
            const cursor = event.match(/^id: (\d+)$/m)?.[1];
            if (cursor) lastId = cursor;
            if (event.includes("data:")) scheduleRefresh();
          }
        }
      } catch {}
      if (!controller.signal.aborted) retry = setTimeout(connect, 2000);
    };
    void connect();
    return () => {
      controller.abort();
      clearTimeout(retry);
      clearTimeout(refresh);
    };
  }, [ws, id, bearer, customer]);
}
export function MessageList({
  messages,
  ws,
  bearer,
  customer = false,
}: {
  messages: Row[];
  ws?: string;
  bearer?: string;
  customer?: boolean;
}) {
  return (
    <>
      {messages.map((m) => (
        <article className={`message ${m.role}`} key={m.id}>
          <div>
            <strong>
              {m.role === "reminder"
                ? "Support follow-up"
                : m.role === "assistant"
                  ? "Navigated Support"
                  : m.role === "note"
                    ? `Internal note${m.author_name ? " · " + m.author_name : ""}`
                    : m.role === "staff"
                      ? "Support team"
                      : "Customer"}
            </strong>
            <time
              dateTime={m.created_at}
              title={new Date(m.created_at).toLocaleString()}
            >
              {new Date(m.created_at).toLocaleString([], {
                month: "short",
                day: "numeric",
                hour: "2-digit",
                minute: "2-digit",
              })}
            </time>
          </div>
          <p>{m.body}</p>
          {ws && !!m.attachments?.length && (
            <AttachmentCards
              ws={ws}
              files={m.attachments}
              bearer={bearer}
              customer={customer}
            />
          )}
          {m.citations?.length > 0 && (
            <details className="citations">
              <summary>
                {m.citations.length} source{m.citations.length === 1 ? "" : "s"}
              </summary>
              {m.citations.map((c: Row) => (
                <blockquote key={c.id}>
                  <strong>
                    {c.url ? (
                      <a href={c.url} target="_blank" rel="noreferrer">
                        {c.title} ↗
                      </a>
                    ) : (
                      c.title
                    )}{" "}
                    · v{c.version}
                  </strong>
                  <p>{c.excerpt}</p>
                </blockquote>
              ))}
            </details>
          )}
        </article>
      ))}
    </>
  );
}
