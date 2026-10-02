import asyncio
import contextlib
import inspect
import json
import sys

try:
    request = json.load(sys.stdin)
    namespace = {"__name__": "fieldkit_step"}
    with contextlib.redirect_stdout(sys.stderr):
        exec(compile(request["code"], "step.py", "exec"), namespace)
        output = namespace["run"](request["input"])
        if inspect.isawaitable(output):
            output = asyncio.run(output)
    if not isinstance(output, dict):
        raise ValueError("run(input) must return a JSON object")
    sys.stdout.write(json.dumps(output, allow_nan=False))
except Exception as error:
    sys.stderr.write(str(error))
    sys.exit(1)
