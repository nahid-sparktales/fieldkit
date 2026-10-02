import { z } from "zod";

export const Binding = z.discriminatedUnion("type", [
  z.object({ type: z.literal("value"), value: z.json() }).strict(),
  z
    .object({ type: z.literal("path"), path: z.string().min(1).max(240) })
    .strict(),
]);
export const Bindings = z.record(
  z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/),
  Binding,
);
export type ValueBindings = z.infer<typeof Bindings>;
export const OPERATORS = [
  "equals",
  "not_equals",
  "contains",
  "starts_with",
  "greater",
  "less",
  "exists",
  "is_true",
] as const;
export const EMPTY_SCHEMA = {
  type: "object",
  properties: {},
  additionalProperties: false,
};
export const JsonSchema = z.record(z.string(), z.unknown());
const forbidden = new Set(["__proto__", "prototype", "constructor"]);
export function validPath(path: string) {
  const parts = path.split(".");
  return (
    parts.length <= 12 &&
    [
      "customer",
      "account",
      "ticket",
      "message",
      "channel",
      "agent",
      "steps",
      "inputs",
      "action",
    ].includes(parts[0]) &&
    parts.every((p) => /^[a-zA-Z0-9_-]+$/.test(p) && !forbidden.has(p))
  );
}
export function valueAt(
  context: Record<string, unknown>,
  path: string,
): unknown {
  if (!validPath(path)) throw new Error(`Invalid workflow variable: ${path}`);
  let value: any = context;
  for (const part of path.split(".")) {
    if (
      value === null ||
      typeof value !== "object" ||
      !Object.hasOwn(value, part)
    )
      return undefined;
    value = value[part];
  }
  return value;
}
export function bindValues(
  bindings: ValueBindings,
  context: Record<string, unknown>,
) {
  const result: Record<string, unknown> = {};
  for (const [key, binding] of Object.entries(bindings)) {
    if (forbidden.has(key)) throw new Error("Reserved input name");
    const value =
      binding.type === "value" ? binding.value : valueAt(context, binding.path);
    if (value === undefined) throw new Error(`Missing workflow input: ${key}`);
    result[key] = value;
  }
  return boundedJson(result);
}
export function boundedJson(value: unknown, limit = 32768) {
  const json = JSON.stringify(value);
  if (json === undefined || new TextEncoder().encode(json).length > limit)
    throw new Error("Workflow result exceeds the size limit");
  return JSON.parse(json);
}
export function templatePaths(text: string) {
  const paths = [...text.matchAll(/{{\s*([^{}]+?)\s*}}/g)].map((m) =>
    m[1].trim(),
  );
  if (
    text.replace(/{{\s*([^{}]+?)\s*}}/g, "").includes("{{") ||
    paths.some((p) => !validPath(p))
  )
    throw new Error(
      "Use complete {{variable.path}} placeholders from workflow data",
    );
  return paths;
}
export function renderReply(text: string, context: Record<string, unknown>) {
  templatePaths(text);
  const result = text.replace(/{{\s*([^{}]+?)\s*}}/g, (_, path: string) => {
    const value = valueAt(context, path.trim());
    if (value === undefined || value === null)
      throw new Error(`Missing reply variable: ${path.trim()}`);
    if (!["string", "number", "boolean"].includes(typeof value))
      throw new Error(`Reply variable must be a simple value: ${path.trim()}`);
    return String(value);
  });
  if (!result.trim() || result.length > 12000)
    throw new Error("Reply must contain 1–12000 characters");
  return result;
}
export function matches(
  value: unknown,
  operator: (typeof OPERATORS)[number],
  expected: string,
) {
  let target: unknown = expected;
  try {
    target = JSON.parse(expected);
  } catch {
    /* Plain text comparisons are supported. */
  }
  switch (operator) {
    case "exists":
      return value !== undefined && value !== null;
    case "is_true":
      return value === true;
    case "equals":
      return (
        value !== undefined && JSON.stringify(value) === JSON.stringify(target)
      );
    case "not_equals":
      return (
        value !== undefined && JSON.stringify(value) !== JSON.stringify(target)
      );
    case "contains":
      return typeof value === "string"
        ? value.includes(expected)
        : Array.isArray(value) &&
            value.some((v) => JSON.stringify(v) === JSON.stringify(target));
    case "starts_with":
      return typeof value === "string" && value.startsWith(expected);
    case "greater":
      return (
        typeof value === "number" &&
        typeof target === "number" &&
        value > target
      );
    case "less":
      return (
        typeof value === "number" &&
        typeof target === "number" &&
        value < target
      );
  }
}
