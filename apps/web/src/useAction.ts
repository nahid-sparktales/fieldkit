import { useState } from "react";
import { ZodError } from "zod";

export function useAction(fallbackError = "Something went wrong") {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [success, setSuccess] = useState("");
  return {
    busy,
    error,
    success,
    setError,
    setSuccess,
    run: async (fn: () => Promise<void>, message = "") => {
      setBusy(true);
      setError("");
      setSuccess("");
      try {
        await fn();
        setSuccess(message);
      } catch (e) {
        setError(
          e instanceof ZodError
            ? e.issues
                .slice(0, 3)
                .map((issue) => {
                  const field = issue.path
                    .map((part) =>
                      typeof part === "number"
                        ? String(part + 1)
                        : String(part)
                            .replace(/([a-z])([A-Z])/g, "$1 $2")
                            .replaceAll("_", " "),
                    )
                    .join(" → ");
                  return `${field ? field + ": " : ""}${issue.message}`;
                })
                .join(". ")
            : e instanceof SyntaxError
              ? "Check the JSON formatting. Use double quotes around property names and remove trailing commas."
              : e instanceof Error
                ? e.message
                : fallbackError,
        );
      } finally {
        setBusy(false);
      }
    },
  };
}
