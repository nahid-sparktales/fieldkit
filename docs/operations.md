# Installation and operations

## Server setup

Use Docker Compose on a single Linux server, PostgreSQL 17 with pgvector, a persistent upload volume, a stable HTTPS origin, and working SMTP. `node scripts/setup.ts` creates unique secrets and refuses to overwrite an existing `.env`. Do not reuse the example values. Keep `.env` mode 0600 and back it up encrypted outside the repository.

`docker compose up --build -d` starts PostgreSQL, runs migrations, then starts the app and worker. The app binds only to loopback on the host; expose it through a TLS proxy. For Caddy on the same host:

```caddyfile
support.example.com {
  reverse_proxy 127.0.0.1:4317 {
    flush_interval -1
  }
}
```

Set `FIELDKIT_URL=https://support.example.com` before startup. Use the same origin for authentication and OAuth callbacks. Configure proxy request limits at least 29 MiB for the default inbound attachment envelope, disable response buffering for SSE, and allow long-lived connections. Authentication rate limits use the socket peer address; when proxied, this is conservatively shared at the proxy address. Configure additional per-client rate limiting at the trusted edge. Untrusted forwarded IP headers are not accepted as identity.

SMTP is mandatory for verification, recovery, invitations, and channel publication. Use an authorized sender with your provider's domain authentication. Test actual inbox delivery before inviting customers. The first workspace requires the setup token; later workspaces require an existing owner. There are no seeded users or demo passwords.

## Health and recovery

- `/v2/health`: database connectivity and application version.
- `/v2/readiness`: fresh worker heartbeat in addition to database access.
- `docker compose logs app worker`: structured application/job errors; do not publish customer logs.
- **Activity**: failed jobs, delivery failures, pending/unknown operations, and audit events. Retry a failed job after fixing its cause. Retry of a sent/unknown effect performs reconciliation rather than a second write.

pg-boss records jobs durably and leases them. Restarting a worker preserves queued work and LangGraph checkpoints. An interrupted external call may already have committed; leave it unknown until provider lookup proves the result. Policy or identity changes can intentionally block old approvals. Read-only reconciliation uses the stored original operation contract and remains available after those changes. Never manually reset a financial operation to prepared just to get it to run again.

## Backup and restore

Back up the database, uploads, and matching encryption/auth secrets as one recovery set. Pause app and worker so messages and files remain consistent:

```sh
mkdir -p backups
chmod 700 backups
docker compose stop app worker
docker compose exec -T postgres pg_dump -U fieldkit -d fieldkit -Fc > backups/database.dump
docker compose run --rm --no-deps --user root --entrypoint tar app -C /data -czf - . > backups/uploads.tar.gz
docker compose start app worker
```

Copy `.env` to an encrypted secret backup separately. Move backups to encrypted off-server storage. Apply your retention policy to backups too; deleting a record does not erase older snapshots.

Restore into an isolated installation using the same application revision and matching `.env`. Keep it inaccessible to customers and block provider writes during verification. Start only PostgreSQL, create an empty `fieldkit` database, then:

```sh
docker compose exec -T postgres pg_restore -U fieldkit -d fieldkit --no-owner < backups/database.dump
docker compose run --rm --no-deps --user root --entrypoint sh app -c 'tar -xzf - -C /data && chown -R node:node /data' < backups/uploads.tar.gz
```

Start the restored app/worker only after confirming database counts, upload files, credentials, and network isolation. Check historical conversations, citations, a waiting approval, and an unknown operation's read-only lookup. Do not run both restored and original workers against the same live providers. The automated recovery tests cover fresh-process approval continuation; they do not replace a production restore drill.

## Encryption and credential rotation

Provider credentials can be replaced in Connections; this changes their revision and invalidates old proposals. OAuth refresh alone preserves the connection identity/revision. Service tokens expire after at most 90 days; issue a replacement and revoke the old credential. Widget signing-key rotation invalidates old assertions. Rotate the Better Auth secret during a maintenance window; users must sign in again.

To rotate the encryption key, stop app/worker, take a full backup, and generate a new 32-byte base64 key into a protected file. With the existing key still configured, run:

```sh
npm run rotate-key -- /secure/path/new-key
```

The script re-encrypts all connected credentials in one database transaction without displaying them. After it succeeds, replace `FIELDKIT_ENCRYPTION_KEY` in `.env` with that file's contents and restart both services. If updating `.env` fails after the transaction, keep services stopped until the new key is configured. Keep old keys only with backups that still need them. A lost encryption key cannot be recovered from the database.

For containers, mount the protected key file read-only into a one-off app container and run the same script with the container path. Do not place it in an image layer or command-line argument.

## Retention, deletion, upgrades

Workspace settings control retention for resolved conversations (default 90 days). Maintenance deletes their messages and queues checkpoint cleanup. Unresolved operations prevent deletion. Administrators can explicitly delete a conversation through the authenticated API; the same outcome guard applies. Removing a knowledge source immediately removes it from retrieval/publication and deletes its local upload. Historical citations remain part of conversation history until that history is removed. Provider records are not deleted by local retention.

Before upgrading, stop writes, back up, pull the intended commit, rebuild, run migrations, and restart. Graph version mismatches fail visibly; never automatically replay a saved run under incompatible workflow code. The original demo database, sessions, and approvals are not migrated. Keep demo data and v2 installation data in separate directories and databases.

## Optional operational controls

Read [the operational controls guide](operational-controls.md) before enabling attachments, SLA reminders or live rollout. Private scanning uses the optional `attachments` Compose profile and 4 GiB scanner memory. Startup completes a signature update before loading the daemon; failed updates block startup. The daemon checks for subsequent on-disk changes every 60 seconds. Loaded signatures must still pass the unchanged 48-hour default freshness limit before every scan. Remote shutdown is disabled. Default inbound attachment envelopes need a proxy allowance of at least 29 MiB; direct upload limits remain separately enforced by the app. Readiness checks are cached workspace diagnostics, separate from `/v2/health` and `/v2/readiness`. Upgrade requires the app and worker on the same schema-18 build; rollback uses a complete pre-upgrade backup, not table deletion.

## Launch hardening and delivery performance

Schema 18 adds indexes for workspace event cursors and conversation message ordering. Back up and stop app/worker before upgrading, then run migrations and restart both on the same build. Index creation can take time on a large database; reserve a maintenance window. Existing data and workflow versions are retained. No migration runs model calls or publishes channels.

`npm run build` writes precompressed Brotli/gzip representations beside static assets. The API streams files, negotiates compression, supports HEAD/ETag revalidation, and caches hashed `/assets/` files for one year. HTML, logos, and `widget.js` require revalidation. Private API/download responses are not included in public asset caching. Preserve `Content-Encoding`, `Vary`, and `Cache-Control` at the proxy; do not compress a response twice.

Production pages restrict scripts and connections with a Content Security Policy. Google Picker origins are included only when `GOOGLE_PICKER_KEY` is configured; keep the Google browser key restricted as described in [integrations](integrations.md). Inline styles remain necessary for branding and graph positioning; browser schema validation runs without dynamic-code probing, so scripts do not need `unsafe-eval`. Vite development uses a reduced policy for its refresh script/socket. HTTPS installations send HSTS for this host, without opting other subdomains into it.

Event streams are limited to **8 per actor/workspace and 128 per application process**. They poll once per second, recheck access, stop reading when a client falls behind, and reconnect after five minutes. A `429` includes `Retry-After: 5`; close unused tabs if the actor limit is reached. Configure proxy connection/rate limits as well: these bounds are not a claim of load-tested capacity. See the [cursor contract](api.md#event-stream-cursors-and-limits).
