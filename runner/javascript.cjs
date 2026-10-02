const fs = require("node:fs");
(async () => {
  const { code, input } = JSON.parse(fs.readFileSync(0, "utf8"));
  const log = (...values) =>
    process.stderr.write(
      values
        .map((v) => (typeof v === "string" ? v : JSON.stringify(v)))
        .join(" ") + "\n",
    );
  console.log = console.info = console.warn = console.error = log;
  const execute = new (Object.getPrototypeOf(async function () {}).constructor)(
    "input",
    `${code}\nreturn await run(input);`,
  );
  const output = await execute(input);
  if (!output || typeof output !== "object" || Array.isArray(output))
    throw new Error("run(input) must return a JSON object");
  process.stdout.write(JSON.stringify(output));
})().catch((e) => {
  process.stderr.write(String(e.message));
  process.exitCode = 1;
});
