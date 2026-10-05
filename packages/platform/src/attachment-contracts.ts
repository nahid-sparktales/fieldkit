import { z } from "zod";
export const AttachmentSettings = z
  .object({
    enabled: z.boolean().default(false),
    anonymous: z.boolean().default(false),
  })
  .strict();
export const AttachmentInput = z
  .object({
    conversationId: z.string().max(200).optional(),
    channelId: z.string().max(200).optional(),
    name: z.string().min(1).max(250),
    size: z.number().int().min(1),
    mime: z.string().max(100).default("application/octet-stream"),
    private: z.boolean().default(false),
    requestKey: z.string().min(8).max(200),
  })
  .strict()
  .refine(
    (x) => !!x.conversationId || !!x.channelId,
    "Choose a conversation or channel for the upload",
  );
export const AttachmentState = z.enum([
  "uploading",
  "quarantined",
  "scanning",
  "available",
  "blocked",
  "scan_failed",
  "canceled",
  "deleted",
]);
