import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { randomUUID, timingSafeEqual } from "node:crypto";
const token = process.env.FIELDKIT_RUNNER_TOKEN ?? "";
if (token.length < 32)
  throw new Error(
    "Configure FIELDKIT_RUNNER_TOKEN with at least 32 characters",
  );
const image = process.env.FIELDKIT_CODE_IMAGE ?? "fieldkit-runner:local";
const port = Number(process.env.FIELDKIT_RUNNER_PORT ?? 4319);
let active = 0;
function reply(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}
const server = createServer(async (req, res) => {
  const supplied = Buffer.from(
    (req.headers.authorization ?? "").replace(/^Bearer /, ""),
  );
  if (
    supplied.length !== Buffer.byteLength(token) ||
    !timingSafeEqual(supplied, Buffer.from(token))
  )
    return reply(res, 401, { error: "Unauthorized" });
  if (req.url === "/health" && req.method === "GET")
    return reply(res, 200, { ready: true, active });
  if (req.url !== "/run" || req.method !== "POST")
    return reply(res, 404, { error: "Not found" });
  if (active >= 2)
    return reply(res, 429, { error: "Code runner is busy; retry later" });
  active++;
  const name = `fieldkit-step-${randomUUID()}`;
  let child, timer;
  try {
    let raw = "";
    req.setEncoding("utf8");
    for await (const chunk of req) {
      raw += chunk;
      if (Buffer.byteLength(raw) > 98304)
        throw new Error("Request exceeds size limit");
    }
    const input = JSON.parse(raw);
    if (
      !["python", "javascript"].includes(input.language) ||
      typeof input.code !== "string" ||
      input.code.length > 20000 ||
      !input.input ||
      typeof input.input !== "object" ||
      Array.isArray(input.input)
    )
      throw new Error("Invalid code request");
    if (Buffer.byteLength(JSON.stringify(input.input)) > 16384)
      throw new Error("Code input exceeds 16 KB");
    let stdout = "",
      stderr = "";
    const command =
      input.language === "python"
        ? ["python3", "-I", "/runner/python.py"]
        : ["node", "/runner/javascript.cjs"];
    child = spawn(
      "docker",
      [
        "run",
        "--pull=never",
        "--rm",
        "-i",
        "--name",
        name,
        "--network=none",
        "--read-only",
        "--cap-drop=ALL",
        "--security-opt=no-new-privileges",
        "--pids-limit=32",
        "--memory=128m",
        "--memory-swap=128m",
        "--cpus=0.5",
        "--user=65534:65534",
        "--tmpfs=/tmp:rw,noexec,nosuid,size=16m",
        image,
        // The container also has a deadline if this broker is interrupted.
        "timeout",
        "-s",
        "KILL",
        "10",
        ...command,
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    const code = await new Promise((resolve, reject) => {
      timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error("Code step exceeded its 10-second limit"));
      }, 10000);
      child.on("error", reject);
      child.on("close", resolve);
      child.stdout.on("data", (c) => {
        stdout += c;
        if (Buffer.byteLength(stdout) > 32768) {
          child.kill("SIGKILL");
          reject(new Error("Code output exceeds 32 KB"));
        }
      });
      child.stderr.on("data", (c) => {
        stderr += c;
        if (Buffer.byteLength(stderr) > 8192) {
          child.kill("SIGKILL");
          reject(new Error("Code logs exceed 8 KB"));
        }
      });
      child.stdin.on("error", () => {});
      child.stdin.end(JSON.stringify({ code: input.code, input: input.input }));
    });
    if (code !== 0)
      throw new Error(stderr.trim().slice(0, 2000) || "Code process failed");
    const output = JSON.parse(stdout);
    if (!output || typeof output !== "object" || Array.isArray(output))
      throw new Error("Code must return a JSON object");
    reply(res, 200, { output, logs: stderr.slice(0, 8000) });
  } catch (error) {
    reply(res, 400, { error: error.message });
  } finally {
    clearTimeout(timer);
    if (child && child.exitCode === null) child.kill("SIGKILL");
    if (child) {
      const cleanup = spawn("docker", ["rm", "-f", name], { stdio: "ignore" });
      cleanup.on("error", () => {});
    }
    active--;
  }
});
server.requestTimeout = 15000;
server.listen(port, "0.0.0.0", () =>
  console.log(JSON.stringify({ event: "runner.ready", port })),
);
