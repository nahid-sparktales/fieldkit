import { useState, useEffect } from "react";
import { customerApi as api, useLoad } from "./request.js";
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
    setResolved(old ? String(old.resolved) : "");
    setRating(old?.rating ?? "");
    setComment(old?.comment ?? "");
  }, [l.data, message.id]);
  return (
    <form
      className="feedback-form compact-feedback"
      onSubmit={(e) => {
        e.preventDefault();
        if (!resolved) return;
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
      <div>
        <h3>Did this solve your issue?</h3>
        <p>Your conversation is closed. Let us know how it went.</p>
      </div>
      <fieldset className="feedback-choices">
        <legend className="sr-only">Issue resolution</legend>
        <label>
          <input
            type="radio"
            name="resolution"
            value="true"
            checked={resolved === "true"}
            onChange={() => setResolved("true")}
          />{" "}
          Yes, solved
        </label>
        <label>
          <input
            type="radio"
            name="resolution"
            value="false"
            checked={resolved === "false"}
            onChange={() => setResolved("false")}
          />{" "}
          No, I still need help
        </label>
      </fieldset>
      {resolved && (
        <>
          <details>
            <summary>Add an experience rating or comment (optional)</summary>
            <Field label="Experience (optional)">
              <select
                value={rating}
                onChange={(e) => setRating(e.target.value)}
              >
                <option value="">No rating</option>
                <option value="good">Good</option>
                <option value="bad">Bad</option>
              </select>
            </Field>
            <Field label="Comment (optional)">
              <textarea
                rows={2}
                maxLength={2000}
                value={comment}
                onChange={(e) => setComment(e.target.value)}
              />
            </Field>
          </details>
          {resolved === "false" && (
            <p>To get more help, reopen the conversation with a reply below.</p>
          )}
          <button disabled={a.busy}>
            {a.busy ? "Saving…" : "Save feedback"}
          </button>
        </>
      )}
      <Notice action={a} error={l.error} />
    </form>
  );
}
