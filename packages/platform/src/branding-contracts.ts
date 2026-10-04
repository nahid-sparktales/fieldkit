import { z } from "zod";

const Color = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, "Use a six-digit hex color");
const PublicLink = z
  .string()
  .trim()
  .max(2000)
  .refine((value) => {
    if (!value) return true;
    try {
      const url = new URL(value);
      return url.protocol === "https:" && !url.username && !url.password;
    } catch {
      return false;
    }
  }, "Use an HTTPS address without credentials");

export const Appearance = z
  .object({
    brandName: z.string().trim().max(80).default(""),
    greeting: z.string().trim().min(1).max(200).default("How can we help?"),
    description: z
      .string()
      .trim()
      .max(500)
      .default(
        "Find an answer, start a conversation, or check in on a request.",
      ),
    accentColor: Color.default("#146b57"),
    backgroundColor: Color.default("#fcfdf9"),
    heroColor: Color.default("#eef4e8"),
    websiteUrl: PublicLink.default(""),
    privacyUrl: PublicLink.default(""),
    termsUrl: PublicLink.default(""),
    footerText: z.string().trim().max(200).default(""),
    showArticles: z.boolean().default(true),
  })
  .strict();
export type AppearanceConfig = z.infer<typeof Appearance>;
export const AppearanceInput = z
  .object({
    revision: z.number().int().min(0),
    config: Appearance,
    // Omitted keeps the current logo; null removes it. Bytes never appear in public JSON.
    logo: z
      .object({ data: z.string().max(1400000) })
      .strict()
      .nullable()
      .optional(),
  })
  .strict();
export type AppearanceView = {
  config: AppearanceConfig;
  revision: number;
  logoUrl: string | null;
};

function luminance(hex: string) {
  const rgb = [1, 3, 5].map((start) => {
    const value = parseInt(hex.slice(start, start + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
}
export function contrast(a: string, b: string) {
  const first = luminance(a),
    second = luminance(b);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}
export function readableText(background: string) {
  return contrast(background, "#ffffff") >= contrast(background, "#000000")
    ? "#ffffff"
    : "#000000";
}
