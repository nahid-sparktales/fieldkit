// Requires the locally built Docker image. No host-code execution fallback.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { codeRunner } from "../packages/platform/src/code-runner.js";
import { testConfig } from "../tests/helpers.js";
const token = randomBytes(32).toString("hex"),
  port = 14319;
execFileSync("docker", ["image", "inspect", "fieldkit-runner:local"], {
  stdio: "ignore",
});
const server = spawn(process.execPath, ["runner/server.mjs"], {
  env: {
    ...process.env,
    FIELDKIT_RUNNER_PORT: String(port),
    FIELDKIT_RUNNER_TOKEN: token,
    FIELDKIT_TEST_SECRET: "must-not-enter-child",
  },
  stdio: ["ignore", "pipe", "inherit"],
});
const started = await Promise.race([
  once(server.stdout, "data"),
  once(server, "exit").then(() => {
    throw new Error("Runner exited before ready");
  }),
]);
assert.ok(started);
const config = {
  ...testConfig(),
  FIELDKIT_RUNNER_URL: `http://127.0.0.1:${port}`,
  FIELDKIT_RUNNER_TOKEN: token,
};
const run = codeRunner(config);
try {
  assert.equal(
    (await fetch(config.FIELDKIT_RUNNER_URL + "/health")).status,
    401,
  );
  const py = await run({
    language: "python",
    code: 'def run(input):\n    print("calculated")\n    return {"amount": input["amount"] * 2}',
    input: { amount: 21 },
  });
  assert.deepEqual(py.output, { amount: 42 });
  assert.match(py.logs, /calculated/);
  const js = await run({
    language: "javascript",
    code: 'async function run(input) { console.log("calculated"); return {amount: input.amount * 2}; }',
    input: { amount: 21 },
  });
  assert.deepEqual(js.output, { amount: 42 });
  assert.match(js.logs, /calculated/);
  const isolation = await run({
    language: "python",
    code: `import os, socket

def run(input):
    readonly = False
    try:
        open('/runner/escape', 'w').write('forbidden')
    except OSError:
        readonly = True
    network = False
    try:
        socket.create_connection(('1.1.1.1', 443), timeout=1).close()
        network = True
    except OSError:
        pass
    return {'uid': os.getuid(), 'readonly': readonly, 'network': network,
            'token': os.environ.get('FIELDKIT_RUNNER_TOKEN'),
            'secret': os.environ.get('FIELDKIT_TEST_SECRET'),
            'socket': os.path.exists('/var/run/docker.sock'), 'app': os.path.exists('/app/.env')}
`,
    input: {},
  });
  assert.deepEqual(isolation.output, {
    uid: 65534,
    readonly: true,
    network: false,
    token: null,
    secret: null,
    socket: false,
    app: false,
  });
  await assert.rejects(
    () =>
      run({
        language: "javascript",
        code: "function run() { return []; }",
        input: {},
      }),
    /JSON object/,
  );
  await assert.rejects(
    () =>
      run({
        language: "python",
        code: 'def run(input):\n    return {"value": "x" * 40000}',
        input: {},
      }),
    /32 KB/,
  );
  await assert.rejects(
    () =>
      run({
        language: "python",
        code: 'def run(input):\n    print("x" * 10000)\n    return {}',
        input: {},
      }),
    /8 KB/,
  );
  await assert.rejects(
    () =>
      run({
        language: "javascript",
        code: "function run() { while(true) {} }",
        input: {},
      }),
    /10-second/,
  );
  const containers = execFileSync(
    "docker",
    ["ps", "--filter", "name=fieldkit-step-", "--format", "{{.Names}}"],
    { encoding: "utf8" },
  ).trim();
  // Cleanup is asynchronous after the response, so allow its Docker CLI process to finish.
  if (containers) await new Promise((resolve) => setTimeout(resolve, 1000));
  assert.equal(
    execFileSync(
      "docker",
      ["ps", "--filter", "name=fieldkit-step-", "--format", "{{.Names}}"],
      { encoding: "utf8" },
    ).trim(),
    "",
  );
  console.log(
    "Real Docker runner verified: Python, JavaScript, authentication, isolation, limits, timeout, cleanup.",
  );
} finally {
  server.kill("SIGTERM");
  await once(server, "exit");
}
