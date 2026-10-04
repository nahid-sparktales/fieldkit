import { z } from "zod";

export const SupportOptionsInput = z
  .object({
    mode: z.enum(["both", "tickets", "chat", "none"]),
  })
  .strict();
export type SupportMode = z.infer<typeof SupportOptionsInput>["mode"];

export function supportMode(
  channels: {
    kind: string;
    published: boolean;
    settings: Record<string, unknown>;
  }[],
): SupportMode {
  const tickets =
    channels.find((c) => c.kind === "portal")?.settings.ticketsEnabled !==
    false;
  const chat = channels.some((c) => c.kind === "widget" && c.published);
  return tickets ? (chat ? "both" : "tickets") : chat ? "chat" : "none";
}
