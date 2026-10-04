export const inboxStates = {
  human: { label: "Needs a person", tone: "bad", symbol: "!" },
  approval: { label: "Awaiting approval", tone: "warning", symbol: "◷" },
  agent: { label: "Agent active", tone: "info", symbol: "✦" },
  resolved: { label: "Resolved", tone: "good", symbol: "✓" },
} as const;
export type InboxState = keyof typeof inboxStates;
export function inboxState(c: {
  status: string;
  mode: string;
  approval_expires_at?: string | null;
}): InboxState {
  if (c.status === "resolved") return "resolved";
  // Taking over can invalidate an approval without changing the stored status.
  if (c.mode === "human" || c.status === "needs_staff") return "human";
  if (c.status === "waiting_approval") {
    if (c.approval_expires_at === null) return "human";
    if (
      c.approval_expires_at &&
      new Date(c.approval_expires_at).getTime() <= Date.now()
    )
      return "human";
    return "approval";
  }
  return "agent";
}
export function statusTone(value: string) {
  if (
    [
      "ready",
      "connected",
      "completed",
      "approved",
      "resolved",
      "delivered",
    ].includes(value)
  )
    return "good";
  if (
    [
      "failed",
      "unknown",
      "disconnected",
      "needs_staff",
      "human takeover",
      "urgent",
      "rejected",
    ].includes(value)
  )
    return "bad";
  if (
    ["waiting_approval", "pending", "high", "stale", "expired"].includes(value)
  )
    return "warning";
  if (["running", "queued", "processing", "agent active"].includes(value))
    return "info";
  return "neutral";
}
export function inboxTime(value: string, now = new Date()) {
  const date = new Date(value);
  if (date.toDateString() === now.toDateString())
    return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return date.toLocaleDateString([], {
    month: "short",
    day: "numeric",
    ...(date.getFullYear() !== now.getFullYear()
      ? { year: "numeric" as const }
      : {}),
  });
}
export function parameterLabel(value: string) {
  if (value === "amountMinor") return "Amount (minor units)";
  return value
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replaceAll("_", " ")
    .replace(/^./, (s) => s.toUpperCase())
    .replace(/\bId\b/g, "ID");
}

export function actionParameter(
  kind: string,
  key: string,
  value: unknown,
  parameters: Record<string, unknown>,
) {
  // Display only currencies with the known two-decimal Stripe charge convention.
  // Keep exact minor units visible; other/custom action parameters are never reinterpreted.
  const currency = String(parameters.currency ?? "");
  if (
    kind === "stripe_refund" &&
    key === "amountMinor" &&
    typeof value === "number" &&
    ["usd", "cad", "eur", "gbp", "aud", "nzd", "chf"].includes(currency)
  )
    return `${(value / 100).toFixed(2)} ${currency.toUpperCase()} (${value} minor units)`;
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}
