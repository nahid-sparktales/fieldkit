import { useState } from "react";
import { customerApi as api } from "./request.js";
import { useAction } from "./useAction.js";
import { FeedbackInput } from "../../../packages/platform/src/quality-contracts.js";
import { Field, Notice, type Row } from "./quality-ui.js";

export function ConversationFeedback({
  ws,
  id,
  message,
  feedback,
  bearer,
  external,
  onSubmitted,
  onRefresh,
}: {
  ws: string;
  id: string;
  message: Row;
  feedback?: Row;
  bearer?: string;
  external?: boolean;
  onSubmitted: (resolved: boolean) => void;
  onRefresh: () => void;
}) {
  const a = useAction();
  const [resolved, setResolved] = useState(""),
    [rating, setRating] = useState(""),
    [comment, setComment] = useState("");
  const [sent, setSent] = useState<Row | null>(null);
  const receipt = feedback ?? sent;
  if (receipt)
    return (
      <section
        className="compact-feedback feedback-receipt"
        aria-label="Your feedback"
      >
        <h3>Feedback sent</h3>
        <p role="status">
          Thank you. Your feedback has been sent to the support team.
        </p>
        <div
          className={`feedback-result ${receipt.resolved ? "positive" : "negative"}`}
        >
          {receipt.resolved
            ? "You marked this issue as solved."
            : "You said you still need help."}
          {receipt.rating && (
            <span>
              Experience: {receipt.rating === "good" ? "Good" : "Bad"}
            </span>
          )}
        </div>
        {receipt.comment && <blockquote>{receipt.comment}</blockquote>}
        <small>
          One feedback submission per conversation. You can still send replies.
        </small>
      </section>
    );
  return (
    <form
      className="feedback-form compact-feedback"
      onSubmit={(e) => {
        e.preventDefault();
        if (!resolved || a.busy) return;
        void a.run(async () => {
          try {
            const result = await api(
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
            setSent(result);
            onSubmitted(result.resolved);
          } catch (error) {
            onRefresh();
            throw error;
          }
        });
      }}
    >
      <h3>Did this solve your issue?</h3>
      <p>
        Your conversation is closed. Share your feedback once with the support
        team.
      </p>
      <fieldset className="feedback-choices" disabled={a.busy}>
        <legend className="sr-only">Issue resolution</legend>
        <label>
          <input
            type="radio"
            name={`resolution-${id}`}
            value="true"
            checked={resolved === "true"}
            onChange={() => setResolved("true")}
          />{" "}
          Yes, solved
        </label>
        <label>
          <input
            type="radio"
            name={`resolution-${id}`}
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
                disabled={a.busy}
                value={rating}
                onChange={(e) => setRating(e.target.value)}
              >
                <option value="">No rating</option>
                <option value="good">Good</option>
                <option value="bad">Bad</option>
              </select>
            </Field>
            <Field label="Feedback comment (optional)">
              <textarea
                disabled={a.busy}
                rows={2}
                maxLength={2000}
                value={comment}
                onChange={(e) => setComment(e.target.value)}
              />
            </Field>
            <p className="feedback-hint">
              This comment goes to the team as feedback. Send your support
              question in the reply box.
            </p>
          </details>
          {resolved === "false" && (
            <p>
              {external
                ? "The support team will see that you still need help. You can add a reply below."
                : "We’ll reopen your conversation so you can send more details."}
            </p>
          )}
          <button disabled={a.busy}>
            {a.busy ? "Sending…" : "Send feedback"}
          </button>
        </>
      )}
      <Notice action={a} />
    </form>
  );
}
