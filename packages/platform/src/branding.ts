import {
  Appearance,
  AppearanceInput,
  type AppearanceView,
} from "./branding-contracts.js";
import { Settings } from "./contracts.js";
import { type Database } from "./db.js";
import { type Principal, requireAdmin } from "./auth.js";
import { HttpError, requireValue } from "./config.js";

// Accept raster images only. Check dimensions before a browser ever decodes them.
export function logoImage(data: string) {
  if (
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      data,
    )
  )
    throw new HttpError(400, "Invalid logo encoding");
  const bytes = Buffer.from(data, "base64");
  if (!bytes.length || bytes.length > 1024 * 1024)
    throw new HttpError(413, "Logo must be 1 MB or smaller");
  let mime = "",
    width = 0,
    height = 0;
  if (
    bytes.length >= 33 &&
    bytes
      .subarray(0, 8)
      .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
    bytes.toString("ascii", 12, 16) === "IHDR"
  ) {
    mime = "image/png";
    width = bytes.readUInt32BE(16);
    height = bytes.readUInt32BE(20);
  } else if (bytes.length > 12 && bytes[0] === 255 && bytes[1] === 216) {
    for (let i = 2; i + 9 < bytes.length; ) {
      if (bytes[i++] !== 255) break;
      while (bytes[i] === 255) i++;
      const marker = bytes[i++];
      if (marker === 0xd9 || marker === 0xda || i + 2 > bytes.length) break;
      const size = bytes.readUInt16BE(i);
      if (size < 2 || i + size > bytes.length) break;
      if ([0xc0, 0xc1, 0xc2].includes(marker) && size >= 8) {
        mime = "image/jpeg";
        height = bytes.readUInt16BE(i + 3);
        width = bytes.readUInt16BE(i + 5);
        break;
      }
      i += size;
    }
  } else if (
    bytes.length >= 30 &&
    bytes.toString("ascii", 0, 4) === "RIFF" &&
    bytes.toString("ascii", 8, 12) === "WEBP"
  ) {
    const format = bytes.toString("ascii", 12, 16);
    if (format === "VP8X" && !(bytes[20] & 2)) {
      width = 1 + bytes.readUIntLE(24, 3);
      height = 1 + bytes.readUIntLE(27, 3);
    } else if (
      format === "VP8 " &&
      bytes.toString("hex", 23, 26) === "9d012a"
    ) {
      width = bytes.readUInt16LE(26) & 0x3fff;
      height = bytes.readUInt16LE(28) & 0x3fff;
    } else if (format === "VP8L" && bytes[20] === 0x2f) {
      const bits = bytes.readUInt32LE(21);
      width = (bits & 0x3fff) + 1;
      height = ((bits >>> 14) & 0x3fff) + 1;
    }
    mime = "image/webp";
  }
  if (!mime || !width || !height || width > 2048 || height > 2048)
    throw new HttpError(
      400,
      "Use a PNG, JPEG, or static WebP logo up to 2048 × 2048 pixels",
    );
  return { bytes, mime };
}

export class Branding {
  constructor(private db: Database) {}
  async get(ws: string, publicUrl = false): Promise<AppearanceView> {
    const workspace = requireValue(
      await this.db.one("SELECT slug,settings FROM workspaces WHERE id=$1", [
        ws,
      ]),
    );
    const settings = Settings.parse(workspace.settings);
    const row = await this.db.one(
      "SELECT config,revision,logo IS NOT NULL AS has_logo FROM workspace_branding WHERE workspace_id=$1",
      [ws],
    );
    return {
      config: Appearance.parse(
        row?.config ?? {
          accentColor: settings.brandColor,
          greeting: settings.greeting.trim() || "How can we help?",
        },
      ),
      revision: row?.revision ?? 0,
      logoUrl: row?.has_logo
        ? `${publicUrl ? `/v2/public/${workspace.slug}` : `/v2/workspaces/${ws}`}/appearance/logo?v=${row.revision}`
        : null,
    };
  }
  async save(p: Principal, input: unknown) {
    requireAdmin(p);
    const data = AppearanceInput.parse(input);
    const logo = data.logo ? logoImage(data.logo.data) : null;
    await this.db.tx(async (q) => {
      await q.query("SELECT id FROM workspaces WHERE id=$1 FOR UPDATE", [
        p.workspaceId,
      ]);
      const old = await this.db.one(
        "SELECT revision FROM workspace_branding WHERE workspace_id=$1",
        [p.workspaceId],
        q,
      );
      if ((old?.revision ?? 0) !== data.revision)
        throw new HttpError(
          409,
          "Appearance changed in another editor. Reload the saved appearance before trying again.",
        );
      await q.query(
        `INSERT INTO workspace_branding(workspace_id,config,logo,logo_mime) VALUES($1,$2,$3,$4)
        ON CONFLICT(workspace_id) DO UPDATE SET config=excluded.config,revision=workspace_branding.revision+1,
        logo=CASE WHEN $5 THEN excluded.logo ELSE workspace_branding.logo END,
        logo_mime=CASE WHEN $5 THEN excluded.logo_mime ELSE workspace_branding.logo_mime END`,
        [
          p.workspaceId,
          data.config,
          logo?.bytes ?? null,
          logo?.mime ?? null,
          data.logo !== undefined,
        ],
      );
      await this.db.event(q, p.workspaceId, "appearance.updated", {
        userId: p.userId,
        logoChanged: data.logo !== undefined,
      });
    });
    return this.get(p.workspaceId);
  }
  async logo(ws: string) {
    return requireValue(
      await this.db.one(
        "SELECT logo,logo_mime FROM workspace_branding WHERE workspace_id=$1 AND logo IS NOT NULL",
        [ws],
      ),
      404,
      "Logo not found",
    );
  }
}
