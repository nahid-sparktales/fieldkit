import { useState, useEffect } from "react";
import { api, useLoad } from "./request.js";
import { useAction } from "./useAction.js";
import { FeedbackInput } from "../../../packages/platform/src/quality-contracts.js";
import { Field, Notice, type Row } from "./quality-ui.js";
export function ConversationFeedback({
  ws,
  id,
  message,
  bearer,
}: {
  ws: string;
  id: string;
  message: Row;
  bearer?: string;
}) {
  const a = useAction(),
    l = useLoad(
      () =>
        api(ws, `/conversations/${id}/feedback`, undefined, undefined, bearer),
      [ws, id, message.id, bearer],
    );
  const [resolved, setResolved] = useState(""),
    [rating, setRating] = useState(""),
    [comment, setComment] = useState("");
  useEffect(() => {
    const old = l.data?.find(
      (v: Row) => v.message_id === message.id && v.source === "native",
    );
    if (old) {
      setResolved(String(old.resolved));
      setRating(old.rating ?? "");
      setComment(old.comment);
    }
  }, [l.data, message.id]);
  return (
    <form
      className="feedback-form"
      onSubmit={(e) => {
        e.preventDefault();
        void a.run(async () => {
          await api(
            ws,
            `/conversations/${id}/feedback`,
            FeedbackInput.parse({
              messageId: message.id,
              resolved: resolved === "true",
              rating: rating || null,
              comment,
            }),
            "PUT",
            bearer,
          );
          l.reload();
        }, "Thank you. Your feedback has been saved.");
      }}
    >
      <h3>Did this solve your issue?</h3>
      <Field label="Issue resolution">
        <select
          required
          value={resolved}
          onChange={(e) => setResolved(e.target.value)}
        >
          <option value="">Choose an answer</option>
          <option value="true">Yes, solved</option>
          <option value="false">No, I still need help</option>
        </select>
      </Field>
      <Field label="Experience (optional)">
        <select value={rating} onChange={(e) => setRating(e.target.value)}>
          <option value="">No rating</option>
          <option value="good">Good</option>
          <option value="bad">Bad</option>
        </select>
      </Field>
      <Field label="Comment (optional)">
        <textarea
          maxLength={2000}
          value={comment}
          onChange={(e) => setComment(e.target.value)}
        />
      </Field>
      <button disabled={a.busy}>{a.busy ? "Saving…" : "Save feedback"}</button>
      <Notice action={a} error={l.error} />
    </form>
  );
}
