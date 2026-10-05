import { connect } from "node:net";
import type { Config } from "./config.js";
import { HttpError } from "./config.js";

export type ScanInfo = {
  engine: string;
  signaturesAt: string;
  scannedAt: string;
  clean: boolean;
};
export interface AttachmentScanner {
  health(): Promise<Omit<ScanInfo, "clean" | "scannedAt">>;
  scan(bytes: Buffer): Promise<ScanInfo>;
}
// The endpoint comes only from installation configuration, never a workspace or file.
// Clamd has no authentication: operators must keep this socket on a private network.
export class ClamScanner implements AttachmentScanner {
  constructor(
    private config: Config,
    private clock = () => Date.now(),
  ) {}
  private command(
    command: "VERSIONCOMMANDS" | "INSTREAM",
    bytes?: Buffer,
  ): Promise<string> {
    if (!this.config.FIELDKIT_CLAM_HOST)
      throw new HttpError(503, "The attachment scanner is not configured");
    return new Promise((resolve, reject) => {
      const socket = connect({
        host: this.config.FIELDKIT_CLAM_HOST,
        port: this.config.FIELDKIT_CLAM_PORT,
      });
      const timer = setTimeout(
        () => socket.destroy(new Error("Scanner timed out")),
        this.config.FIELDKIT_SCAN_TIMEOUT_MS,
      );
      let output = Buffer.alloc(0),
        complete = false;
      socket.on("connect", () => {
        socket.write(`z${command}\0`);
        if (bytes) {
          // Admission bounds the buffer. Writing bounded chunks avoids a second full copy.
          for (let offset = 0; offset < bytes.length; offset += 65536) {
            const chunk = bytes.subarray(offset, offset + 65536),
              length = Buffer.alloc(4);
            length.writeUInt32BE(chunk.length);
            socket.write(length);
            socket.write(chunk);
          }
          socket.write(Buffer.alloc(4));
        }
      });
      socket.on("data", (chunk) => {
        if (output.length + chunk.length > 4096) {
          socket.destroy(new Error("Invalid scanner response"));
          return;
        }
        output = Buffer.concat([output, chunk]);
      });
      socket.on("end", () => {
        if (!output.length || output.at(-1) !== 0) {
          reject(new HttpError(503, "Incomplete scanner response"));
          return;
        }
        complete = true;
        resolve(output.subarray(0, -1).toString("utf8"));
      });
      socket.on("error", () =>
        reject(
          new HttpError(
            503,
            "Scanner unavailable or timed out; file remains unavailable",
          ),
        ),
      );
      socket.on("close", () => {
        clearTimeout(timer);
        if (!complete)
          reject(
            new HttpError(
              503,
              "Scanner closed before returning a complete result",
            ),
          );
      });
    });
  }
  async health() {
    const value = await this.command("VERSIONCOMMANDS");
    const match = value.match(
      /^ClamAV ([^/\r\n]{1,60})\/(\d+)\/([^\r\n|]+)\| COMMANDS: (.+)$/,
    );
    if (!match || !match[4].split(/\s+/).includes("INSTREAM"))
      throw new HttpError(
        503,
        "Scanner version or streaming capability cannot be verified",
      );
    // ClamAV's ctime timestamp is emitted in the daemon timezone. The bundled
    // scanner is UTC; require an explicit offset from remote daemons or UTC here.
    const stamp = Date.parse(
      /[+-]\d{4}$|GMT|UTC/.test(match[3]) ? match[3] : `${match[3]} UTC`,
    );
    const age = this.clock() - stamp;
    if (
      !Number.isFinite(stamp) ||
      age < -300000 ||
      age > this.config.FIELDKIT_SCAN_MAX_AGE_HOURS * 3600000
    )
      throw new HttpError(
        503,
        "Scanner signature age is unknown or too old; update the scanner databases",
      );
    return {
      engine: `ClamAV ${match[1]} / database ${match[2]}`,
      signaturesAt: new Date(stamp).toISOString(),
    };
  }
  async scan(bytes: Buffer) {
    const info = await this.health();
    const response = await this.command("INSTREAM", bytes);
    if (
      response !== "stream: OK" &&
      !/^stream: [^\r\n\0]+ FOUND$/.test(response)
    )
      throw new HttpError(
        503,
        "Scanner returned an indeterminate result; file remains unavailable",
      );
    return {
      ...info,
      scannedAt: new Date(this.clock()).toISOString(),
      clean: response === "stream: OK",
    };
  }
}
