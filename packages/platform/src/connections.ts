import { createHash } from "node:crypto";
import type { Database, Queryable } from "./db.js";
import { uid } from "./db.js";
import { HttpError, requireValue } from "./config.js";
import {
  seal,
  unseal,
  token,
  tokenHash,
  safeFetch,
  externalURL,
  type Fetcher,
} from "./security.js";

type Secret = {
  apiKey?: string;
  access_token?: string;
  refresh_token?: string;
  expires_at?: number;
  webhookSecret?: string;
  signingSecret?: string;
};
export class Connections {
  constructor(
    public db: Database,
    public fetch: Fetcher = safeFetch,
  ) {}
  secret(row: any): Secret {
    return unseal(
      this.db.config.FIELDKIT_ENCRYPTION_KEY,
      `${row.workspace_id}:${row.provider}`,
      row.secret,
    );
  }
  async save(
    ws: string,
    provider: string,
    secret: Secret,
    metadata: object,
    q: Queryable = this.db.pool,
  ) {
    return (
      await this.db.rows(
        `INSERT INTO connections(id,workspace_id,provider,status,secret,metadata) VALUES($1,$2,$3,'connected',$4,$5)
      ON CONFLICT(workspace_id,provider) DO UPDATE SET secret=excluded.secret,metadata=excluded.metadata,status='connected',revision=connections.revision+1,updated_at=now() RETURNING id,provider,status,metadata,revision`,
        [
          uid(),
          ws,
          provider,
          seal(
            this.db.config.FIELDKIT_ENCRYPTION_KEY,
            `${ws}:${provider}`,
            secret,
          ),
          metadata,
        ],
        q,
      )
    )[0];
  }
  async disconnect(ws: string, provider: string) {
    await this.db.tx(async (q) => {
      await q.query(
        "UPDATE connections SET status='disconnected',secret='',revision=revision+1 WHERE workspace_id=$1 AND provider=$2",
        [ws, provider],
      );
      const kinds: Record<string, string> = {
        google: "google",
        notion: "notion",
        zendesk: "zendesk",
      };
      if (kinds[provider]) {
        await q.query(
          "UPDATE sources SET active=false,status='disconnected',revision=revision+1 WHERE workspace_id=$1 AND kind=$2",
          [ws, kinds[provider]],
        );
        await q.query(
          "UPDATE documents SET active=false,published=false WHERE workspace_id=$1 AND source_id IN (SELECT id FROM sources WHERE workspace_id=$1 AND kind=$2)",
          [ws, kinds[provider]],
        );
      }
      await this.db.event(q, ws, "connection.disconnected", { provider });
    });
  }
  async connectKey(
    ws: string,
    provider: string,
    apiKey: string,
    metadata: Record<string, unknown> = {},
  ) {
    if (provider === "openai") {
      const res = await this.fetch(
        "https://api.openai.com/v1/models/" +
          encodeURIComponent(String(metadata.model ?? "gpt-5.4-mini")),
        { headers: { Authorization: `Bearer ${apiKey}` } },
      );
      if (!res.ok)
        throw new HttpError(
          400,
          "OpenAI credentials or selected model could not be validated",
        );
      const embedding = await this.fetch(
        "https://api.openai.com/v1/models/text-embedding-3-small",
        { headers: { Authorization: `Bearer ${apiKey}` } },
      );
      if (!embedding.ok)
        throw new HttpError(
          400,
          "OpenAI key needs access to text-embedding-3-small",
        );
    } else if (["stripe_test", "stripe_live"].includes(provider)) {
      if (!/^rk_(test|live)_/.test(apiKey))
        throw new HttpError(
          400,
          "Use a restricted key from the FieldKit Stripe App installation",
        );
      const res = await this.fetch(
        "https://api.stripe.com/v1/customers?limit=1",
        { headers: { Authorization: `Bearer ${apiKey}` } },
      );
      if (!res.ok)
        throw new HttpError(
          400,
          "Stripe key requires customer read permission",
        );
      const mode = apiKey.startsWith("rk_live_") ? "live" : "test";
      if (provider !== `stripe_${mode}`)
        throw new HttpError(
          400,
          "The key does not match the selected Stripe environment",
        );
      metadata = { mode };
    } else if (provider === "notion") {
      const res = await this.fetch("https://api.notion.com/v1/users/me", {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Notion-Version": "2026-03-11",
        },
      });
      if (!res.ok)
        throw new HttpError(400, "Notion connection could not be validated");
    } else if (!provider.startsWith("custom:"))
      throw new HttpError(400, "Unsupported key connection");
    return this.save(ws, provider, { apiKey }, metadata);
  }
  oauthConfig(provider: string, context: Record<string, string> = {}) {
    const c = this.db.config,
      callback = `${c.FIELDKIT_URL}/v2/oauth/${provider}/callback`;
    if (provider === "zendesk") {
      if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(context.subdomain ?? ""))
        throw new HttpError(400, "Enter your Zendesk subdomain");
      return {
        id: c.ZENDESK_CLIENT_ID,
        secret: c.ZENDESK_CLIENT_SECRET,
        callback,
        auth: `https://${context.subdomain}.zendesk.com/oauth/authorizations/new`,
        exchange: `https://${context.subdomain}.zendesk.com/oauth/tokens`,
        scope:
          "tickets:read tickets:write users:read organizations:read hc:read",
      };
    }
    if (provider === "google")
      return {
        id: c.GOOGLE_CLIENT_ID,
        secret: c.GOOGLE_CLIENT_SECRET,
        callback,
        auth: "https://accounts.google.com/o/oauth2/v2/auth",
        exchange: "https://oauth2.googleapis.com/token",
        scope: "https://www.googleapis.com/auth/drive.file",
      };
    if (provider === "notion")
      return {
        id: c.NOTION_CLIENT_ID,
        secret: c.NOTION_CLIENT_SECRET,
        callback,
        auth: "https://api.notion.com/v1/oauth/authorize",
        exchange: "https://api.notion.com/v1/oauth/token",
        scope: "",
      };
    throw new HttpError(400, "Unsupported OAuth provider");
  }
  async begin(
    ws: string,
    user: string,
    provider: string,
    context: Record<string, string>,
  ) {
    const c = this.oauthConfig(provider, context);
    if (!c.id || !c.secret)
      throw new HttpError(
        409,
        `Configure ${provider} OAuth application credentials on the server`,
      );
    const state = token(),
      verifier = token(),
      url = new URL(c.auth);
    const params: Record<string, string> = {
      client_id: c.id,
      redirect_uri: c.callback,
      response_type: "code",
      state,
    };
    if (c.scope) params.scope = c.scope;
    if (provider === "google")
      Object.assign(params, { access_type: "offline", prompt: "consent" });
    if (provider === "notion") params.owner = "user";
    else
      Object.assign(params, {
        code_challenge: createHash("sha256")
          .update(verifier)
          .digest("base64url"),
        code_challenge_method: "S256",
      });
    url.search = new URLSearchParams(params).toString();
    await this.db.pool.query(
      "INSERT INTO oauth_states VALUES($1,$2,$3,$4,$5,now()+interval '10 minutes')",
      [tokenHash(state), ws, user, provider, { ...context, verifier }],
    );
    return url.toString();
  }
  async finish(provider: string, user: string, state: string, code: string) {
    const row = requireValue(
      await this.db.one(
        "DELETE FROM oauth_states WHERE hash=$1 AND user_id=$2 AND provider=$3 AND expires_at>now() RETURNING *",
        [tokenHash(state), user, provider],
      ),
      400,
      "OAuth state expired or does not belong to this session",
    );
    const c = this.oauthConfig(provider, row.context),
      body: Record<string, string> = {
        grant_type: "authorization_code",
        code,
        redirect_uri: c.callback,
        client_id: c.id!,
        client_secret: c.secret!,
      };
    if (provider !== "notion") body.code_verifier = row.context.verifier;
    const response = await this.fetch(c.exchange, {
      method: "POST",
      headers: {
        "Content-Type":
          provider === "google"
            ? "application/x-www-form-urlencoded"
            : "application/json",
        ...(provider === "notion"
          ? {
              Authorization:
                "Basic " +
                Buffer.from(`${c.id}:${c.secret}`).toString("base64"),
            }
          : {}),
      },
      body:
        provider === "google"
          ? new URLSearchParams(body as Record<string, string>).toString()
          : JSON.stringify(body),
    });
    if (!response.ok)
      throw new HttpError(
        400,
        "The provider could not complete authorization. Reconnect to try again.",
      );
    const result = (await response.json()) as any;
    if (!result.access_token)
      throw new HttpError(400, "Provider did not return an access token");
    await this.save(
      row.workspace_id,
      provider,
      {
        access_token: result.access_token,
        refresh_token: result.refresh_token,
        expires_at: Date.now() + (result.expires_in ?? 1800) * 1000,
      },
      {
        ...(provider === "zendesk" ? { subdomain: row.context.subdomain } : {}),
        ...(provider === "notion" ? { workspace: result.workspace_name } : {}),
      },
    );
    return row.workspace_id as string;
  }
  async access(
    ws: string,
    provider: string,
    force = false,
  ): Promise<{ row: any; secret: Secret }> {
    const current = await this.db.connection(ws, provider),
      currentSecret = this.secret(current);
    if (
      !force &&
      (!currentSecret.refresh_token ||
        (currentSecret.expires_at ?? Infinity) >= Date.now() + 60000)
    )
      return { row: current, secret: currentSecret };
    return this.db.tx(async (q) => {
      const row = requireValue(
        await this.db.one(
          "SELECT * FROM connections WHERE workspace_id=$1 AND provider=$2 AND status='connected' FOR UPDATE",
          [ws, provider],
          q,
        ),
        409,
        `Connect ${provider} first`,
      );
      const secret = this.secret(row);
      if (
        secret.refresh_token &&
        (force || (secret.expires_at ?? Infinity) < Date.now() + 60000)
      ) {
        const c = this.oauthConfig(provider, row.metadata);
        const body = {
          grant_type: "refresh_token",
          refresh_token: secret.refresh_token,
          client_id: c.id,
          client_secret: c.secret,
        };
        const res = await this.fetch(c.exchange, {
          method: "POST",
          headers: {
            "Content-Type":
              provider === "google"
                ? "application/x-www-form-urlencoded"
                : "application/json",
            ...(provider === "notion"
              ? {
                  Authorization:
                    "Basic " +
                    Buffer.from(`${c.id}:${c.secret}`).toString("base64"),
                }
              : {}),
          },
          body:
            provider === "google"
              ? new URLSearchParams(body as Record<string, string>).toString()
              : JSON.stringify(body),
        });
        if (!res.ok)
          throw new HttpError(
            401,
            `Reconnect ${provider}: token refresh failed`,
          );
        const result = (await res.json()) as any;
        if (!result.access_token)
          throw new HttpError(401, "Missing refreshed token");
        Object.assign(secret, {
          access_token: result.access_token,
          refresh_token: result.refresh_token ?? secret.refresh_token,
          expires_at: Date.now() + (result.expires_in ?? 1800) * 1000,
        });
        // Refresh is credential maintenance, not a change to the approved connection identity.
        await q.query(
          "UPDATE connections SET secret=$1,updated_at=now() WHERE id=$2",
          [
            seal(
              this.db.config.FIELDKIT_ENCRYPTION_KEY,
              `${ws}:${provider}`,
              secret,
            ),
            row.id,
          ],
        );
      }
      return { row, secret };
    });
  }
  async request(
    ws: string,
    provider: string,
    path: string,
    init: Parameters<Fetcher>[1] = {},
  ) {
    let refresh = false;
    for (let attempt = 0; attempt < 4; attempt++) {
      const { row, secret } = await this.access(ws, provider, refresh);
      refresh = false;
      const root =
        provider === "zendesk"
          ? `https://${row.metadata.subdomain}.zendesk.com`
          : provider === "notion"
            ? "https://api.notion.com"
            : provider === "google"
              ? "https://www.googleapis.com"
              : ["stripe_test", "stripe_live"].includes(provider)
                ? "https://api.stripe.com"
                : "https://api.openai.com";
      if (!path.startsWith("/") || path.startsWith("//"))
        throw new Error("Provider paths must be relative");
      const res = await this.fetch(root + path, {
        ...init,
        headers: {
          Authorization: `Bearer ${secret.access_token ?? secret.apiKey}`,
          ...(provider === "notion" ? { "Notion-Version": "2026-03-11" } : {}),
          ...init.headers,
        },
      });
      if (res.status === 401 && secret.refresh_token && attempt === 0) {
        refresh = true;
        continue;
      }
      if (
        res.status === 429 &&
        (init.method ?? "GET") === "GET" &&
        attempt < 3
      ) {
        const header = res.headers.get("retry-after"),
          seconds = header ? Number(header) : 1;
        const delay = Number.isFinite(seconds)
          ? seconds * 1000
          : Date.parse(header!) - Date.now();
        if (delay >= 0 && delay <= 10000) {
          await new Promise((resolve) => setTimeout(resolve, delay));
          continue;
        }
      }
      if (!res.ok)
        throw new HttpError(
          res.status === 409
            ? 409
            : res.status === 429
              ? 429
              : res.status === 404
                ? 404
                : res.status === 403
                  ? 403
                  : res.status === 401
                    ? 401
                    : 502,
          `${provider} returned ${res.status}${res.status === 429 ? " (rate limited; retry later)" : ""}`,
        );
      return res;
    }
    throw new HttpError(401, `Reconnect ${provider}`);
  }
  async json(
    ws: string,
    provider: string,
    path: string,
    init: Parameters<Fetcher>[1] = {},
  ) {
    return (
      await this.request(ws, provider, path, init)
    ).json() as Promise<any>;
  }
}
