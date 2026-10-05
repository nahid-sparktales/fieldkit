import { config } from "../packages/platform/src/config.js";
import {
  ClamScanner,
  ScannerHealthError,
} from "../packages/platform/src/attachment-scanner.js";
if (!process.argv.includes("--live-scanner"))
  throw new Error(
    "Use --live-scanner to explicitly test the configured private scanner. No customer files are used.",
  );
const scanner = new ClamScanner(config());
try {
  const clean = await scanner.scan(
    Buffer.from("FieldKit scanner smoke test. Harmless synthetic text."),
  );
  // The standard harmless EICAR test string exercises actual signature detection.
  const eicar = Buffer.from(
    "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*",
  );
  const detected = await scanner.scan(eicar);
  if (!clean.clean || detected.clean)
    throw new Error(
      "Scanner failed clean-file or EICAR detection verification",
    );
  console.log(
    JSON.stringify({
      verified: "real private scanner",
      engine: clean.engine,
      signaturesAt: clean.signaturesAt,
      cleanAccepted: true,
      eicarBlocked: true,
    }),
  );
} catch (error) {
  // Only bounded daemon version metadata is logged, never files or credentials.
  console.error(
    JSON.stringify({
      verified: false,
      error:
        error instanceof Error ? error.message : "Scanner verification failed",
      ...(error instanceof ScannerHealthError
        ? error.diagnostics
        : {
            checkedAt: new Date().toISOString(),
            reason: "unavailable_or_scan_failed",
          }),
    }),
  );
  process.exitCode = 1;
}
