import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
const databasePassword = randomBytes(24).toString("hex");
const content = `POSTGRES_PASSWORD=${databasePassword}
DATABASE_URL=postgresql://fieldkit:${databasePassword}@localhost:5432/fieldkit
FIELDKIT_URL=http://localhost:4317
FIELDKIT_HOST=127.0.0.1
FIELDKIT_PORT=4317
FIELDKIT_DATA=.fieldkit/v2
FIELDKIT_ENCRYPTION_KEY=${randomBytes(32).toString("base64")}
BETTER_AUTH_SECRET=${randomBytes(32).toString("base64url")}
FIELDKIT_SETUP_TOKEN=${randomBytes(32).toString("base64url")}
# Configure SMTP before creating verified accounts or publishing support.
SMTP_URL=
SMTP_FROM=FieldKit <support@example.com>
`;
writeFileSync(".env", content, { flag: "wx", mode: 0o600 });
console.log(
  "Created .env with unique installation secrets. Configure PostgreSQL, public URL, and SMTP, then run npm run migrate.",
);
