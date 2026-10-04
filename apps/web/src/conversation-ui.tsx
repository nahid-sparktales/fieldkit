import { useEffect, useRef } from "react";
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
    const connect = async () => {
      try {
        const res = await fetch(
          `/v2/workspaces/${ws}/conversations/${id}/events`,
          {
            signal: controller.signal,
            headers: {
              ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
              ...(customer ? { "X-Fieldkit-Audience": "customer" } : {}),
            },
          },
        );
        if (!res.ok) {
          callback.current();
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
            if (event.includes("data:")) callback.current();
          }
        }
      } catch {}
      if (!controller.signal.aborted) retry = setTimeout(connect, 2000);
    };
    void connect();
    return () => {
      controller.abort();
      clearTimeout(retry);
    };
  }, [ws, id, bearer, customer]);
}
export function MessageList({ messages }: { messages: Row[] }) {
  return (
    <>
      {messages.map((m) => (
        <article className={`message ${m.role}`} key={m.id}>
          <div>
            <strong>
              {m.role === "assistant"
                ? "FieldKit"
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
