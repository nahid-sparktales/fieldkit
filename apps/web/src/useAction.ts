import { useState } from "react";

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
        setError(e instanceof Error ? e.message : fallbackError);
      } finally {
        setBusy(false);
      }
    },
  };
}
