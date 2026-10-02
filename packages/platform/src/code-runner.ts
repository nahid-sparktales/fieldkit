import type { Config } from "./config.js";
import { HttpError } from "./config.js";
export type CodeRequest = {
  language: "python" | "javascript";
  code: string;
  input: Record<string, unknown>;
};
export type CodeRunner = (
  request: CodeRequest,
) => Promise<{ output: unknown; logs: string }>;
export const codeRunner =
  (config: Config): CodeRunner =>
  async (input) => {
    if (!config.FIELDKIT_RUNNER_URL || config.FIELDKIT_RUNNER_TOKEN.length < 32)
      throw new HttpError(
        503,
        "Python/JavaScript runner is not configured. Enable the isolated runner on the installation server.",
      );
    const base = new URL(config.FIELDKIT_RUNNER_URL);
    if (
      !["http:", "https:"].includes(base.protocol) ||
      base.username ||
      base.password ||
      base.search ||
      base.hash
    )
      throw new Error("Invalid operator-configured runner URL");
    const response = await fetch(
      config.FIELDKIT_RUNNER_URL.replace(/\/+$/, "") + "/run",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.FIELDKIT_RUNNER_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(input),
        redirect: "error",
        signal: AbortSignal.timeout(15000),
      },
    );
    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    if (!reader) throw new Error("Runner returned no response");
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.length;
      if (bytes > 65536) {
        await reader.cancel();
        throw new Error("Runner response exceeds its limit");
      }
      chunks.push(value);
    }
    const result = JSON.parse(Buffer.concat(chunks).toString());
    if (!response.ok)
      throw new HttpError(502, result.error || "Code runner failed");
    return {
      output: result.output,
      logs: String(result.logs ?? "").slice(0, 8000),
    };
  };
