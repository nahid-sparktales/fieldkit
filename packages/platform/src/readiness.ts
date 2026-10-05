import { dedicatedProbe } from "./diagnostic-probes.js";
import { mkdir, open, unlink } from "node:fs/promises";
import { join } from "node:path";
import nodemailer from "nodemailer";
import { z } from "zod";
import type { Platform } from "./platform.js";
import { uid } from "./db.js";
import {
  requireAdmin,
  requireOwner,
  requireStaff,
  type Principal,
} from "./auth.js";
import { HttpError, requireValue } from "./config.js";
import { digest, token, tokenHash } from "./security.js";
import { Settings, DraftSchema } from "./contracts.js";
import { ModelProvider } from "./model-providers.js";
import { effectiveWorkflow } from "./channel-workflows.js";
import { usageContext } from "./usage-context.js";
import {
  Attestation,
  CheckControl,
  CheckEvidence,
  CheckRequest,
  ReadinessSettings,
  type EvidenceLevel,
  type CheckHealth,
  type CheckRisk,
} from "./readiness-contracts.js";

type Result = {
  level: z.infer<typeof EvidenceLevel>;
  health?: z.infer<typeof CheckHealth>;
  summary: string;
  facts?: Record<string, string | number | boolean | null>;
};
type Check = {
  id: string;
  title: string;
  operation: string;
  environment: string;
  risk: z.infer<typeof CheckRisk>;
  required: boolean;
  configured: boolean;
  prerequisite?: string;
  remedy: string;
  view: string;
  fingerprint: string;
  freshnessMinutes: number;
  timeoutMs: number;
  execute: (run: any) => Promise<Result>;
};
const VERSION = 1;
const verified = (level: string) =>
  [
    "access_verified",
    "read_verified",
    "dedicated_test_write_verified",
  ].includes(level);

export class Readiness {
  constructor(
    private app: Platform,
    private origin: "live" | "local_test" = "live",
  ) {}
  get db() {
    return this.app.db;
  }

  private async registry(ws: string): Promise<Check[]> {
    const db = this.db,
      app = this.app,
      c = db.config;
    const settings = Settings.parse(
      requireValue(
        await db.one("SELECT settings FROM workspaces WHERE id=$1", [ws]),
      ).settings,
    );
    const connections = await db.rows(
      "SELECT id,workspace_id,provider,revision,status,metadata FROM connections WHERE workspace_id=$1 ORDER BY provider",
      [ws],
    );
    const channels = await db.rows(
      "SELECT * FROM channels WHERE workspace_id=$1 ORDER BY kind",
      [ws],
    );
    const active = channels.some((ch) => ch.published);
    const checks: Check[] = [];
    const add = (
      check: Omit<Check, "fingerprint" | "freshnessMinutes" | "timeoutMs"> & {
        config: unknown;
        freshnessMinutes?: number;
        timeoutMs?: number;
      },
    ) => {
      const { config, ...rest } = check;
      checks.push({
        freshnessMinutes: 1440,
        timeoutMs: 50000,
        ...rest,
        fingerprint: digest({ version: VERSION, config }),
      });
    };
    add({
      id: "core",
      title: "Installation",
      operation: "Database, schema, worker and private volume",
      environment: "installation",
      risk: "local_read",
      required: true,
      configured: true,
      config: { data: c.FIELDKIT_DATA, schema: 17, url: c.FIELDKIT_URL },
      freshnessMinutes: 5,
      remedy:
        "Run migrations, start the worker, and grant the application access to its private data volume.",
      view: "activity",
      execute: async (): Promise<Result> => {
        const schema = Number(
          (await db.one("SELECT max(version) version FROM app_migrations"))
            ?.version ?? 0,
        );
        const worker = !!(await db.one(
          "SELECT 1 FROM worker_heartbeats WHERE last_seen>now()-interval '1 minute' LIMIT 1",
        ));
        await mkdir(c.FIELDKIT_DATA, { recursive: true });
        const path = join(c.FIELDKIT_DATA, `.diagnostic-${uid()}`);
        const file = await open(path, "wx", 0o600);
        try {
          await file.writeFile("FieldKit private volume check");
          await file.sync();
        } finally {
          await file.close();
          await unlink(path);
        }
        return {
          level: "read_verified",
          health: schema >= 17 && worker ? "current" : "blocked",
          summary:
            schema < 17
              ? "Application migrations are missing"
              : !worker
                ? "No recent worker heartbeat"
                : "Database, worker and private volume are available",
          facts: {
            schema,
            worker,
            writableVolume: true,
            node: process.versions.node,
          },
        };
      },
    });
    for (const purpose of ["response", "embedding"] as const) {
      const provider =
        purpose === "response"
          ? settings.responseProvider
          : settings.embeddingProvider;
      const model =
        purpose === "response" ? settings.model : settings.embeddingModel;
      const connection = connections.find(
        (x) => x.provider === provider && x.status === "connected",
      );
      const scope = {
        provider,
        model,
        connection,
        dimensions:
          purpose === "embedding" ? settings.embeddingDimensions : undefined,
      };
      const base = {
        environment: provider,
        required: active || !!connection,
        configured: !!connection,
        prerequisite: !connection ? `Connect ${provider} first` : undefined,
        remedy:
          "Review model credentials and the exact model ID in Connections and Settings.",
        view: "connections",
        config: scope,
      };
      add({
        ...base,
        id: `${purpose}_access`,
        title: `${purpose === "response" ? "Response" : "Embedding"} model access`,
        operation: `Read model availability: ${provider} / ${model}`,
        risk: "local_read",
        execute: async (): Promise<Result> => {
          const secret = app.connections.secret(
            await db.connection(ws, provider),
          );
          const payload =
            provider === "openai"
              ? await app.connections.json(
                  ws,
                  provider,
                  `/v1/models/${encodeURIComponent(model)}`,
                )
              : await app.connections.modelRequest(
                  provider,
                  secret.apiKey ?? "",
                  connection.metadata,
                  "/models",
                );
          const ids =
            typeof payload.id === "string"
              ? [payload.id]
              : z
                  .array(z.object({ id: z.string() }))
                  .parse(payload.data)
                  .map((x) => x.id);
          if (!ids.includes(model))
            throw new HttpError(
              409,
              "The selected model is not listed by this connection",
            );
          return {
            level: "access_verified",
            summary: "Exact model listed; generation has not been tested",
            facts: { provider, model },
          };
        },
      });
      add({
        ...base,
        required: false,
        id: `${purpose}_probe`,
        title: `${purpose === "response" ? "Structured answer" : "Embedding"} test`,
        operation: `${purpose === "response" ? "Generate one synthetic cited answer" : "Embed one fixed sentence"}: ${provider} / ${model}`,
        risk: "paid_model",
        timeoutMs: 55000,
        execute: async (run): Promise<Result> => {
          if (purpose === "embedding") {
            const vectors = await app.model.embed(ws, [
              "FieldKit diagnostic sentence.",
            ]);
            if (
              vectors.length !== 1 ||
              vectors[0].length !== settings.embeddingDimensions ||
              vectors[0].some((x) => !Number.isFinite(x))
            )
              throw new HttpError(
                502,
                "Embedding response has invalid dimensions or values",
              );
            return {
              level: "read_verified",
              summary: "Embedding dimensions and finite values verified",
              facts: { provider, model, dimensions: vectors[0].length },
            };
          }
          const output = DraftSchema.parse(
            await app.model.answer({
              workspaceId: ws,
              runId: run.id,
              provider,
              model,
              actions: [],
              account: null,
              messages: [
                {
                  role: "customer",
                  body: "What hours is the fictional diagnostic shop open?",
                },
              ],
              evidence: [
                {
                  id: "diagnostic-hours",
                  title: "Synthetic diagnostic fixture",
                  excerpt:
                    "The fictional diagnostic shop opens at 09:00 and closes at 17:00 UTC.",
                  version: 1,
                  sourceId: "diagnostic",
                  documentId: "diagnostic",
                },
              ],
              instructions:
                "This is a synthetic diagnostic. Answer only from the supplied passage and cite diagnostic-hours. No customer information is supplied.",
            }),
          );
          if (
            output.intent !== "answer" ||
            !output.answer.trim() ||
            !output.citationIds.includes("diagnostic-hours") ||
            output.citationIds.some((x) => x !== "diagnostic-hours")
          )
            throw new HttpError(
              502,
              "Structured answer did not cite the supplied synthetic evidence",
            );
          return {
            level: "read_verified",
            summary: "Structured response and supplied citation verified",
            facts: { provider, model, citationValidated: true },
          };
        },
      });
    }
    const smtp = {
      configured: !!c.SMTP_URL,
      prerequisite: !c.SMTP_URL ? "Configure SMTP transport first" : undefined,
      environment: "SMTP",
      config: { url: c.SMTP_URL, from: c.SMTP_FROM },
      view: "connections",
      remedy:
        "Review SMTP_URL, SMTP_FROM, sender authorization and transport connectivity.",
    };
    add({
      ...smtp,
      id: "smtp_access",
      title: "Email transport",
      operation: "Connect and authenticate without sending mail",
      risk: "local_read",
      required: active,
      execute: async (): Promise<Result> => {
        const transport = nodemailer.createTransport({
          url: c.SMTP_URL,
          connectionTimeout: 10000,
          greetingTimeout: 10000,
          socketTimeout: 15000,
        } as import("nodemailer/lib/smtp-transport/index.js").Options);
        try {
          await transport.verify();
        } finally {
          transport.close();
        }
        return {
          level: "access_verified",
          summary:
            "Transport authentication verified; no email sent and sender acceptance untested",
        };
      },
    });
    add({
      ...smtp,
      id: "smtp_acceptance",
      title: "Dedicated test email",
      operation:
        "Send one diagnostic email to the exact operator-provided test mailbox",
      risk: "test_email",
      required: false,
      execute: async (run): Promise<Result> => {
        await app.auth.send(
          run.request.testEmail,
          "FieldKit diagnostic email",
          `Dedicated readiness check ${run.id}. SMTP acceptance is not proof of inbox receipt. Record receipt separately in Readiness.`,
          { messageId: `<diagnostic-${run.id}@fieldkit.local>` },
        );
        return {
          level: "dedicated_test_write_verified",
          summary:
            "SMTP accepted the diagnostic message; inbox receipt is unconfirmed",
          facts: { providerAcceptance: true, inboxReceipt: false },
        };
      },
    });
    const inbound = connections.find(
      (x) => x.provider === "ticket_email" && x.status === "connected",
    );
    add({
      id: "postmark_roundtrip",
      title: "Inbound email round trip",
      operation:
        "Send one challenge email, then verify a reply through the authenticated inbound webhook",
      environment: "Postmark + SMTP",
      risk: "test_email",
      required: false,
      configured: !!inbound && !!c.SMTP_URL,
      config: { inbound, smtp: { url: c.SMTP_URL, from: c.SMTP_FROM } },
      prerequisite:
        !inbound || !c.SMTP_URL
          ? "Configure ticket email and SMTP first"
          : undefined,
      remedy:
        "Check the Postmark inbound stream, authenticated webhook and reply mailbox configuration. Reply from the dedicated mailbox within 30 minutes.",
      view: "connections",
      freshnessMinutes: 1440,
      execute: async (run): Promise<Result> => {
        const challenge = token(),
          [local, domain] = inbound.metadata.address.split("@");
        await db.pool.query(
          "INSERT INTO diagnostic_mail_challenges(workspace_id,run_id,token_hash,sender,expires_at) VALUES($1,$2,$3,$4,now()+interval '30 minutes')",
          [
            ws,
            run.id,
            tokenHash(challenge),
            run.request.testEmail.toLowerCase(),
          ],
        );
        await app.auth.send(
          run.request.testEmail,
          "FieldKit inbound email challenge",
          `Reply to this diagnostic email within 30 minutes. Check ${run.id}. Your reply verifies only this dedicated mailbox route; it does not create a customer ticket.`,
          {
            replyTo: `${local}+rd-${challenge}@${domain}`,
            messageId: `<diagnostic-${run.id}@fieldkit.local>`,
          },
        );
        return {
          level: "configured_untested",
          health: "degraded",
          summary:
            "SMTP accepted the challenge. Waiting for an authenticated reply from the dedicated mailbox.",
          facts: { smtpAccepted: true, inboundVerified: false },
        };
      },
    });
    const attachments = await db.one(
      "SELECT enabled,anonymous,revision FROM attachment_settings WHERE workspace_id=$1",
      [ws],
    );
    add({
      id: "scanner",
      title: "Private attachment scanner",
      operation: "Check ClamAV capability and loaded signature age",
      environment: "private scanner",
      risk: "local_read",
      required: !!attachments?.enabled,
      configured: !!c.FIELDKIT_CLAM_HOST,
      config: {
        host: c.FIELDKIT_CLAM_HOST,
        port: c.FIELDKIT_CLAM_PORT,
        maxAge: c.FIELDKIT_SCAN_MAX_AGE_HOURS,
        attachments,
      },
      freshnessMinutes: 5,
      timeoutMs: c.FIELDKIT_SCAN_TIMEOUT_MS + 1000,
      prerequisite: !c.FIELDKIT_CLAM_HOST
        ? "Configure the private scanner before allowing attachments"
        : undefined,
      remedy:
        "Start the optional scanner service, restrict its network and update its signature database.",
      view: "publish",
      execute: async (): Promise<Result> => {
        const info = await app.attachments.scanner.health();
        return {
          level: "read_verified",
          summary: "Private scanner is reachable with current signatures",
          facts: { engine: info.engine, signaturesAt: info.signaturesAt },
        };
      },
    });
    const sources = await db.rows(
      "SELECT id,kind,locator,revision,status,visibility,active FROM sources WHERE workspace_id=$1 ORDER BY id",
      [ws],
    );
    const actions = await db.rows(
      "SELECT id,name,revision,enabled,kind,config,policy FROM actions WHERE workspace_id=$1 ORDER BY id",
      [ws],
    );
    const versions = await db.rows(
      "SELECT version,channel FROM workflow_versions WHERE workspace_id=$1 ORDER BY version",
      [ws],
    );
    add({
      id: "knowledge",
      title: "Knowledge and workflow dependencies",
      operation:
        "Inspect approved sources and current channel workflow requirements",
      environment: "workspace",
      risk: "local_read",
      required: active,
      configured: true,
      config: {
        sources,
        actions,
        versions,
        channels,
        embeddingProvider: settings.embeddingProvider,
        embeddingModel: settings.embeddingModel,
        embeddingDimensions: settings.embeddingDimensions,
      },
      remedy:
        "Review Knowledge visibility, refresh failed sources, and fix Workflow validation issues.",
      view: "knowledge",
      freshnessMinutes: 60,
      execute: async (): Promise<Result> => {
        const approved = sources.filter(
          (x) =>
            x.active && x.status === "ready" && x.visibility === "customer",
        ).length;
        let problems = 0;
        for (const channel of channels.filter((ch) => ch.published)) {
          const workflow = await effectiveWorkflow(db, ws, channel.id);
          if (workflow)
            problems += (await app.workflows.problems(ws, workflow.definition))
              .length;
        }
        const embedding = await app.connections.embeddingConfig(ws);
        const missing = Number(
          (await db.one(
            "SELECT count(*) n FROM chunks k JOIN documents d ON d.id=k.document_id JOIN sources s ON s.id=d.source_id WHERE k.workspace_id=$1 AND d.active AND s.active AND s.visibility='customer' AND (k.embedding IS NULL OR k.embedding_model IS DISTINCT FROM $2)",
            [ws, embedding.key],
          ))!.n,
        );
        return {
          level: "read_verified",
          health:
            problems || missing
              ? "blocked"
              : !approved
                ? "degraded"
                : "current",
          summary: problems
            ? "Published workflow dependencies need attention"
            : missing
              ? "Approved knowledge needs current embeddings"
              : !approved
                ? "No customer-approved knowledge is ready"
                : "Approved knowledge and published workflow dependencies are usable",
          facts: {
            approvedSources: approved,
            workflowProblems: problems,
            missingEmbeddings: missing,
          },
        };
      },
    });
    // A required but absent connector is a visible blocker, not an omitted row.
    const requiredProviders = new Set<string>();
    for (const a of actions.filter((a) => a.enabled)) {
      if (a.kind.startsWith("stripe_"))
        requiredProviders.add(`stripe_${a.config.stripeMode ?? "test"}`);
      else if (a.config.credentialId)
        requiredProviders.add(`custom:${a.config.credentialId}`);
    }
    for (const source of sources.filter(
      (s) => s.active && ["google", "notion"].includes(s.kind),
    ))
      requiredProviders.add(source.kind);
    if (
      channels.some(
        (ch) =>
          ch.published &&
          (ch.kind === "zendesk" || ch.settings.handoff === "zendesk"),
      )
    )
      requiredProviders.add("zendesk");
    for (const provider of requiredProviders)
      if (!connections.some((c) => c.provider === provider))
        connections.push({
          provider,
          status: "missing",
          metadata: {},
          revision: 0,
        });
    for (const connection of connections.filter(
      (x) => !ModelProvider.safeParse(x.provider).success,
    )) {
      const provider: string = connection.provider;
      const enabledActions = actions.filter(
        (a) =>
          a.enabled &&
          ((provider === `stripe_${a.config.stripeMode ?? "test"}` &&
            a.kind.startsWith("stripe_")) ||
            provider === `custom:${a.config.credentialId}`),
      );
      const required =
        enabledActions.length > 0 ||
        (provider === "zendesk" &&
          channels.some(
            (ch) =>
              ch.published &&
              (ch.kind === "zendesk" || ch.settings.handoff === "zendesk"),
          )) ||
        (["notion", "google"].includes(provider) &&
          (await db.one(
            "SELECT 1 FROM sources WHERE workspace_id=$1 AND kind=$2 AND active LIMIT 1",
            [ws, provider],
          )));
      add({
        id: `connector:${provider}`,
        title: `${provider} capabilities`,
        operation:
          provider === "zendesk"
            ? "Read authenticated Zendesk user"
            : provider.startsWith("stripe_")
              ? "Read one customer-list page without storing customer data"
              : provider === "notion"
                ? "Read authorized integration identity and selected shared page blocks"
                : "Inspect connector configuration and local synchronization evidence",
        environment:
          provider === "stripe_test"
            ? "test"
            : provider === "stripe_live"
              ? "live"
              : provider,
        risk: "local_read",
        required: !!required,
        configured: connection.status === "connected",
        config: {
          connection,
          actions: enabledActions,
          sources: sources
            .filter((s) => s.active && s.kind === provider)
            .map((s) => ({
              id: s.id,
              locator: s.locator,
              revision: s.revision,
            })),
        },
        prerequisite:
          connection.status !== "connected"
            ? "Reconnect this provider"
            : undefined,
        remedy:
          "Review Connections, selected source permissions, action mappings and dedicated vendor verification in the verification guide.",
        view: "connections",
        execute: async (): Promise<Result> => {
          if (provider === "zendesk") {
            const data = await app.connections.json(
              ws,
              provider,
              "/api/v2/users/me.json",
            );
            z.object({
              user: z.object({ id: z.union([z.string(), z.number()]) }),
            }).parse(data);
            const syncs = Number(
              (await db.one(
                "SELECT count(*) n FROM conversations WHERE workspace_id=$1 AND external_id IS NOT NULL",
                [ws],
              ))!.n,
            );
            return {
              level: "read_verified",
              summary:
                "Authenticated user read verified; ticket writes and webhook delivery are separate capabilities",
              facts: {
                linkedTickets: syncs,
                writeVerified: false,
                authenticatedWebhookObserved: !!(await db.one(
                  "SELECT 1 FROM inbound_events WHERE workspace_id=$1 AND provider='zendesk' LIMIT 1",
                  [ws],
                )),
                ticketReadVerified: !!z
                  .object({ tickets: z.array(z.unknown()) })
                  .parse(
                    await app.connections.json(
                      ws,
                      provider,
                      "/api/v2/tickets.json?per_page=1",
                    ),
                  ),
                declaredScopes: String(
                  connection.metadata.scopes ??
                    "unknown; successful operations prove only their own access",
                ),
              },
            };
          }
          if (provider.startsWith("stripe_")) {
            z.object({ data: z.array(z.unknown()) }).parse(
              await app.connections.json(ws, provider, "/v1/customers?limit=1"),
            );
            return {
              level: "read_verified",
              summary:
                "Customer-list permission verified; refunds, cancellation and customer ownership remain unverified",
              facts: {
                mode: provider === "stripe_test" ? "test" : "live",
                enabledActions: enabledActions.length,
                writesVerified: false,
              },
            };
          }
          if (provider === "google") {
            const selected = sources.filter(
              (s) => s.active && s.kind === "google",
            );
            if (!selected.length)
              return {
                level: "configured_untested",
                health: "degraded",
                summary:
                  "Choose a Drive file with Google Picker before verifying its per-file read access.",
              };
            for (const source of selected.slice(0, 20)) {
              const file = z
                .object({
                  id: z.string(),
                  trashed: z.boolean().optional(),
                  capabilities: z
                    .object({ canDownload: z.boolean().optional() })
                    .optional(),
                })
                .parse(
                  await app.connections.json(
                    ws,
                    provider,
                    `/drive/v3/files/${encodeURIComponent(source.locator)}?fields=id,trashed,capabilities(canDownload)`,
                  ),
                );
              if (
                file.id !== source.locator ||
                file.trashed ||
                file.capabilities?.canDownload === false
              )
                throw new HttpError(
                  403,
                  "Selected Drive file is no longer readable",
                );
            }
            return {
              level: "read_verified",
              health: selected.length > 20 ? "degraded" : "current",
              summary:
                "Selected Drive file metadata access verified. Content extraction and indexing are reported in Knowledge; unselected files were not accessed.",
              facts: {
                filesChecked: Math.min(20, selected.length),
                filesRemaining: Math.max(0, selected.length - 20),
                declaredScopes: String(
                  connection.metadata.scopes ??
                    "unknown; per-file access was tested",
                ),
              },
            };
          }
          if (provider === "notion") {
            z.object({ object: z.literal("user") }).parse(
              await app.connections.json(ws, provider, "/v1/users/me"),
            );
            const selected = sources.filter(
              (s) => s.active && s.kind === "notion",
            );
            for (const source of selected.slice(0, 20))
              z.object({ results: z.array(z.unknown()) }).parse(
                await app.connections.json(
                  ws,
                  provider,
                  `/v1/blocks/${encodeURIComponent(source.locator)}/children?page_size=1`,
                ),
              );
            return {
              level: selected.length ? "read_verified" : "access_verified",
              health: selected.length > 20 ? "degraded" : "current",
              summary:
                "Integration identity and selected shared-page block access checked. Full extraction status remains in Knowledge.",
              facts: {
                pagesChecked: Math.min(20, selected.length),
                pagesRemaining: Math.max(0, selected.length - 20),
              },
            };
          }
          if (provider.startsWith("custom:")) {
            const unmapped = [];
            for (const a of enabledActions)
              if (
                !(await db.one(
                  "SELECT 1 FROM contacts WHERE workspace_id=$1 AND verified AND nullif(mappings->>$2,'') IS NOT NULL LIMIT 1",
                  [ws, a.config.mappingKey],
                ))
              )
                unmapped.push(a.id);
            return {
              level: "configured_untested",
              health: unmapped.length ? "blocked" : "degraded",
              summary: unmapped.length
                ? "An enabled action has no verified staff-reviewed customer mapping"
                : "Fixed action credentials are configured. Use a dedicated test contact and the explicit endpoint probe to verify the operation.",
              facts: {
                enabledActions: enabledActions.length,
                actionsWithoutMappings: unmapped.length,
              },
            };
          }
          return {
            level: "configured_untested",
            health: "degraded",
            summary:
              "Configuration present. This check does not exercise the provider operation; verify the selected resource separately.",
            facts: {
              enabledActions: enabledActions.length,
              writeVerified: false,
            },
          };
        },
      });
    }
    const probes = [
      {
        kind: "zendesk_note",
        provider: "zendesk",
        title: "Zendesk dedicated private note",
        operation:
          "Add exactly one private note to an unlinked ticket tagged fieldkit_diagnostic_test",
      },
      {
        kind: "stripe_refund",
        provider: "stripe_test",
        title: "Stripe dedicated test refund",
        operation:
          "Refund 1–100 minor units on the exact marked Stripe test charge",
      },
      {
        kind: "stripe_cancel",
        provider: "stripe_test",
        title: "Stripe dedicated test cancellation",
        operation:
          "Cancel the explicitly selected marked test subscription at period end",
      },
      ...actions
        .filter((a) => a.enabled && a.kind.startsWith("custom_"))
        .map((a) => ({
          kind: `custom:${a.id}`,
          provider: a.config.credentialId
            ? `custom:${a.config.credentialId}`
            : "custom",
          title: `Dedicated test: ${a.name}`,
          operation: `${a.kind === "custom_read" ? "Read" : "Write"} the configured fixed endpoint using a staff-mapped fieldkit-test- customer and schema-validated parameters`,
        })),
    ];
    for (const probe of probes) {
      const connection = connections.find((c) => c.provider === probe.provider),
        action = probe.kind.startsWith("custom:")
          ? actions.find((a) => a.id === probe.kind.slice(7))
          : null;
      if (!connection && !action) continue;
      add({
        id: `probe:${probe.kind}`,
        title: probe.title,
        operation: probe.operation,
        environment: "dedicated test resources only",
        risk: "test_write",
        required: false,
        configured: action
          ? !!action.config.diagnosticTest
          : connection?.status === "connected",
        config: { connection, action },
        prerequisite:
          action && !action.config.diagnosticTest
            ? "Enable dedicated test diagnostics for this fixed action endpoint first"
            : undefined,
        remedy:
          "Use dedicated test resources only. An uncertain result must be reconciled before any new write. Readiness does not authorize production actions.",
        view: "actions",
        execute: (run) =>
          dedicatedProbe(app, ws, probe.kind, run, false, () =>
            this.revalidateEffect(ws, run),
          ),
      });
    }
    const sla = await db.one(
      "SELECT revision,policy FROM sla_policies WHERE workspace_id=$1",
      [ws],
    );
    const activeExperiments = await db.rows(
      "SELECT id,config,status FROM shadow_experiments WHERE workspace_id=$1 AND status IN ('active','budget_exhausted') ORDER BY id",
      [ws],
    );
    if (sla?.policy.enabled)
      add({
        id: "sla_processing",
        title: "SLA processing",
        operation: "Inspect durable event backlog and timer reconciliation",
        environment: "workspace",
        risk: "local_read",
        required: true,
        configured: true,
        config: { revision: sla.revision },
        freshnessMinutes: 5,
        remedy: "Start the worker and inspect failed SLA jobs in Activity.",
        view: "needs attention",
        execute: async () => {
          const backlog = Number(
            (await db.one(
              "SELECT count(*) n FROM sla_observations WHERE workspace_id=$1 AND processed_at IS NULL AND at<now()-interval '5 minutes'",
              [ws],
            ))!.n,
          );
          return {
            level: "read_verified",
            health: backlog ? "blocked" : "current",
            summary: backlog
              ? "SLA observations are waiting more than five minutes"
              : "No overdue SLA observation backlog",
            facts: { delayedObservations: backlog },
          };
        },
      });
    if (activeExperiments.length)
      add({
        id: "shadow_processing",
        title: "Shadow comparisons",
        operation:
          "Inspect candidate dependencies, missing fixtures and experiment budgets",
        environment: "workspace",
        risk: "local_read",
        required: false,
        configured: true,
        config: activeExperiments,
        freshnessMinutes: 5,
        remedy:
          "Inspect Shadow & rollout. Refresh stale candidates, supply matching authorized read coverage, or review the experiment budget.",
        view: "shadow & rollout",
        execute: async () => {
          const bad = Number(
            (await db.one(
              "SELECT count(*) n FROM shadow_results r JOIN shadow_experiments e ON e.id=r.experiment_id WHERE e.workspace_id=$1 AND e.status='active' AND r.status IN ('blocked_missing_fixture','uncertain','budget_exhausted','failed')",
              [ws],
            ))!.n,
          );
          let stale = 0;
          for (const c of await db.rows(
            "SELECT c.* FROM shadow_candidates c JOIN shadow_experiments e ON e.candidate_id=c.id WHERE e.workspace_id=$1 AND e.status='active'",
            [ws],
          ))
            if (
              c.fingerprint !==
              (await app.shadow.dependencies(ws, c.channel_id)).fingerprint
            )
              stale++;
          return {
            level: "read_verified",
            health:
              bad ||
              stale ||
              activeExperiments.some((e) => e.status === "budget_exhausted")
                ? "degraded"
                : "current",
            summary:
              "Comparison issues remain separate from production text support",
            facts: {
              comparisonsNeedingReview: bad,
              staleCandidates: stale,
              exhaustedExperiments: activeExperiments.filter(
                (e) => e.status === "budget_exhausted",
              ).length,
            },
          };
        },
      });
    return checks;
  }

  async settings(p: Principal, raw?: unknown) {
    requireStaff(p);
    if (raw !== undefined) {
      requireOwner(p);
      const data = ReadinessSettings.parse(raw);
      await this.db.tx(async (q) => {
        await q.query(
          "INSERT INTO readiness_settings(workspace_id,strict,updated_by) VALUES($1,$2,$3) ON CONFLICT(workspace_id) DO UPDATE SET strict=$2,updated_by=$3,updated_at=now()",
          [p.workspaceId, data.strict, p.userId],
        );
        await this.db.event(q, p.workspaceId, "readiness.settings_updated", {
          strict: data.strict,
          actor: p.userId,
        });
      });
    }
    return (
      (await this.db.one(
        "SELECT strict,updated_at FROM readiness_settings WHERE workspace_id=$1",
        [p.workspaceId],
      )) ?? { strict: false }
    );
  }
  async dashboard(p: Principal) {
    requireStaff(p);
    return this.report(p.workspaceId);
  }
  async summary(p: Principal) {
    if (p.role === "service") {
      if (!p.scopes?.includes("diagnostics:read"))
        throw new HttpError(403, "This key requires diagnostics:read");
    } else requireStaff(p);
    const report = await this.report(p.workspaceId);
    return {
      evidenceOrigin: report.evidenceOrigin,
      blockers: report.blockers,
      checks: report.checks.map((c) => ({
        id: c.id,
        title: c.title,
        operation: c.operation,
        environment: c.environment,
        required: c.required,
        level: c.level,
        health: c.health,
        checkedAt: c.result?.finished_at ?? null,
      })),
    };
  }
  private async report(ws: string) {
    const registry = await this.registry(ws);
    const history = await this.db.rows(
      "SELECT DISTINCT ON(check_id) * FROM diagnostic_runs WHERE workspace_id=$1 ORDER BY check_id,created_at DESC",
      [ws],
    );
    const checks = registry.map(({ execute: _execute, ...check }) => {
      const result = history.find((r) => r.check_id === check.id);
      const stale =
        result &&
        ((result.evidence?.facts?.evidenceOrigin === "local_test" &&
          this.origin === "live") ||
          result.fingerprint !== check.fingerprint ||
          result.definition_version !== VERSION ||
          (result.finished_at &&
            Date.now() - new Date(result.finished_at).getTime() >
              check.freshnessMinutes * 60000));
      return {
        ...check,
        level:
          result?.evidence_level ??
          (check.configured ? "configured_untested" : "not_configured"),
        health: stale
          ? "stale"
          : (result?.health ?? (check.configured ? "degraded" : "blocked")),
        result: result ? this.publicResult(result) : null,
      };
    });
    const blockers = checks
      .filter(
        (ch) => ch.required && (ch.health !== "current" || !verified(ch.level)),
      )
      .map((ch) => ch.id);
    return {
      checks,
      evidenceOrigin: this.origin,
      blockers,
      settings: (await this.db.one(
        "SELECT strict FROM readiness_settings WHERE workspace_id=$1",
        [ws],
      )) ?? { strict: false },
      channels: await this.db.rows(
        "SELECT id,kind,published FROM channels WHERE workspace_id=$1 ORDER BY kind",
        [ws],
      ),
    };
  }
  private publicResult(row: any) {
    const { request: _request, request_hash: _hash, ...result } = row;
    return result;
  }
  async history(p: Principal, checkId: string) {
    requireStaff(p);
    return {
      runs: (
        await this.db.rows(
          "SELECT * FROM diagnostic_runs WHERE workspace_id=$1 AND check_id=$2 ORDER BY created_at DESC LIMIT 50",
          [p.workspaceId, checkId],
        )
      ).map((r) => this.publicResult(r)),
      attestations: await this.db.rows(
        "SELECT id,run_id,actor_id,note,created_at FROM diagnostic_attestations WHERE workspace_id=$1 AND check_id=$2 ORDER BY created_at DESC LIMIT 50",
        [p.workspaceId, checkId],
      ),
    };
  }
  async start(p: Principal, raw: unknown) {
    requireAdmin(p);
    const request = CheckRequest.parse(raw),
      registry = await this.registry(p.workspaceId);
    const selected = [...new Set(request.checkIds)].map((id) =>
      requireValue(
        registry.find((ch) => ch.id === id),
        400,
        "Unknown diagnostic",
      ),
    );
    if (
      selected.some((ch) => ch.risk !== "local_read") &&
      !request.authorizedEffects
    )
      throw new HttpError(
        400,
        "Explicitly authorize this exact effectful diagnostic",
      );
    if (
      selected.filter((ch) => ch.risk !== "local_read").length > 1 ||
      (selected.some((ch) => ch.risk !== "local_read") && selected.length > 1)
    )
      throw new HttpError(400, "Run effectful diagnostics individually");
    if (
      selected.some((ch) => ch.risk === "paid_model") &&
      request.tokenCap < 1000
    )
      throw new HttpError(
        400,
        "A paid diagnostic requires a token cap of at least 1000",
      );
    if (selected.some((ch) => ch.risk === "test_email") && !request.testEmail)
      throw new HttpError(400, "Enter the exact dedicated test mailbox");
    if (
      selected.some((ch) => ch.risk === "test_write") &&
      !request.testResource
    )
      throw new HttpError(
        400,
        "Choose exact dedicated test resources and parameters",
      );
    return this.db.tx(async (q) => {
      await q.query("SELECT id FROM workspaces WHERE id=$1 FOR UPDATE", [
        p.workspaceId,
      ]);
      const queued = Number(
        (await this.db.one(
          "SELECT count(*) n FROM diagnostic_runs WHERE workspace_id=$1 AND status IN ('queued','running')",
          [p.workspaceId],
          q,
        ))!.n,
      );
      const runs = [];
      for (const check of selected) {
        const hash = digest({ request, fingerprint: check.fingerprint });
        const prior = await this.db.one(
          "SELECT * FROM diagnostic_runs WHERE workspace_id=$1 AND request_key=$2 AND check_id=$3",
          [p.workspaceId, request.requestKey, check.id],
          q,
        );
        if (prior) {
          if (prior.request_hash !== hash)
            throw new HttpError(
              409,
              "Request identity already belongs to a different diagnostic configuration",
            );
          runs.push(this.publicResult(prior));
          continue;
        }
        if (queued + selected.length > 50)
          throw new HttpError(
            429,
            "Finish or cancel pending diagnostics first",
          );
        const id = uid();
        const row = await this.db.one(
          "INSERT INTO diagnostic_runs(id,workspace_id,check_id,definition_version,fingerprint,environment,actor_id,request_key,request_hash,risk,request,token_cap) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *",
          [
            id,
            p.workspaceId,
            check.id,
            VERSION,
            check.fingerprint,
            check.environment,
            p.userId,
            request.requestKey,
            hash,
            check.risk,
            request,
            request.tokenCap,
          ],
          q,
        );
        await this.db.enqueue(q, "diagnostic", {
          workspaceId: p.workspaceId,
          runId: id,
        });
        await this.db.event(q, p.workspaceId, "readiness.queued", {
          runId: id,
          checkId: check.id,
          actor: p.userId,
        });
        runs.push(this.publicResult(row));
      }
      return runs;
    });
  }
  async control(p: Principal, id: string, raw: unknown) {
    requireAdmin(p);
    const data = CheckControl.parse(raw);
    const row = requireValue(
      await this.db.one(
        "SELECT * FROM diagnostic_runs WHERE workspace_id=$1 AND id=$2",
        [p.workspaceId, id],
      ),
    );
    if (data.action === "reconcile") {
      if (row.risk !== "test_write" || row.health !== "uncertain")
        throw new HttpError(
          409,
          "Only uncertain dedicated writes require outcome reconciliation",
        );
      const check = (await this.registry(p.workspaceId)).find(
        (c) => c.id === row.check_id,
      );
      if (!check || check.fingerprint !== row.fingerprint)
        throw new HttpError(
          409,
          "Connection changed. Inspect the original provider manually before recording an attestation.",
        );
      const result = await dedicatedProbe(
        this.app,
        p.workspaceId,
        row.check_id.slice(6),
        row,
        true,
      );
      await this.db.pool.query(
        "UPDATE diagnostic_runs SET status='complete',health='current',evidence_level=$3,evidence=$4,finished_at=now() WHERE workspace_id=$1 AND id=$2 AND health='uncertain'",
        [
          p.workspaceId,
          id,
          result.level,
          { summary: result.summary, facts: result.facts },
        ],
      );
      await this.db.event(this.db.pool, p.workspaceId, "readiness.reconciled", {
        runId: id,
        actor: p.userId,
      });
      return { ok: true };
    }
    if (data.action === "retry") {
      if (row.risk === "test_write" && row.health === "uncertain")
        throw new HttpError(
          409,
          "Reconcile the original dedicated write; uncertain writes cannot be retried",
        );
      if (["running", "queued"].includes(row.status))
        throw new HttpError(409, "This diagnostic has not finished");
      if (row.health === "uncertain" && !data.acknowledgeUncertain)
        throw new HttpError(
          409,
          "The previous request may have completed. Acknowledge its uncertain cost or delivery before an explicit retry.",
        );
      return this.start(p, {
        ...row.request,
        checkIds: [row.check_id],
        requestKey: uid(),
      });
    }
    await this.db.pool.query(
      "UPDATE diagnostic_runs SET cancel_requested=true,status=CASE WHEN status='queued' THEN 'canceled' ELSE status END,health=CASE WHEN status='queued' THEN 'canceled' ELSE health END,finished_at=CASE WHEN status='queued' THEN now() ELSE finished_at END WHERE workspace_id=$1 AND id=$2 AND status IN ('queued','running')",
      [p.workspaceId, id],
    );
    return { ok: true };
  }
  async attest(p: Principal, checkId: string, raw: unknown) {
    requireAdmin(p);
    const data = Attestation.parse(raw),
      check = requireValue(
        (await this.registry(p.workspaceId)).find((ch) => ch.id === checkId),
      );
    if (data.runId)
      requireValue(
        await this.db.one(
          "SELECT id FROM diagnostic_runs WHERE workspace_id=$1 AND check_id=$2 AND id=$3",
          [p.workspaceId, checkId, data.runId],
        ),
      );
    await this.db.tx(async (q) => {
      await q.query(
        "INSERT INTO diagnostic_attestations(id,workspace_id,check_id,run_id,fingerprint,actor_id,note) VALUES($1,$2,$3,$4,$5,$6,$7)",
        [
          uid(),
          p.workspaceId,
          checkId,
          data.runId ?? null,
          check.fingerprint,
          p.userId,
          data.note,
        ],
      );
      await this.db.event(q, p.workspaceId, "readiness.manual_attestation", {
        checkId,
        actor: p.userId,
      });
    });
    return { level: "manual_attestation", changesAutomatedResult: false };
  }
  async receiveChallenge(ws: string, raw: unknown) {
    const envelope = z
      .object({ OriginalRecipient: z.string() })
      .passthrough()
      .safeParse(raw);
    if (
      !envelope.success ||
      !envelope.data.OriginalRecipient.split("@")[0]?.includes("+rd-")
    )
      return false;
    const data = z
      .object({
        OriginalRecipient: z.email(),
        FromFull: z.object({ Email: z.email() }),
        MessageID: z.string().min(1).max(200),
        Headers: z
          .array(z.object({ Name: z.string(), Value: z.string() }))
          .max(200)
          .default([]),
      })
      .parse(raw);
    const connection = await this.db.connection(ws, "ticket_email"),
      [local, domain] = connection.metadata.address.split("@"),
      [to, host] = data.OriginalRecipient.split("@");
    if (host.toLowerCase() !== domain || !to.startsWith(`${local}+rd-`))
      throw new HttpError(403, "Unknown diagnostic reply address");
    const challenge = requireValue(
      await this.db.one(
        "SELECT c.*,r.actor_id,r.fingerprint,r.check_id FROM diagnostic_mail_challenges c JOIN diagnostic_runs r ON r.id=c.run_id WHERE c.workspace_id=$1 AND c.token_hash=$2",
        [ws, tokenHash(to.slice(local.length + 4))],
      ),
      403,
      "Unknown diagnostic reply address",
    );
    if (
      challenge.sender !== data.FromFull.Email.toLowerCase() ||
      new Date(challenge.expires_at).getTime() < Date.now()
    )
      throw new HttpError(
        403,
        "Diagnostic reply expired or sender does not match",
      );
    const header = (name: string) =>
      data.Headers.filter((h) => h.Name.toLowerCase() === name)
        .map((h) => h.Value)
        .join(" ");
    if (
      /yes/i.test(header("x-spam-status")) ||
      (header("auto-submitted") &&
        header("auto-submitted").toLowerCase() !== "no") ||
      /bulk|list|junk/i.test(header("precedence"))
    )
      throw new HttpError(403, "Automatic or spam diagnostic reply rejected");
    const current = (await this.registry(ws)).find(
      (ch) => ch.id === challenge.check_id,
    );
    if (
      current?.fingerprint !== challenge.fingerprint ||
      !(await this.db.one(
        "SELECT 1 FROM memberships WHERE workspace_id=$1 AND user_id=$2 AND role IN ('owner','admin')",
        [ws, challenge.actor_id],
      ))
    )
      throw new HttpError(403, "Diagnostic authority changed");
    await this.db.tx(async (q) => {
      const run = await this.db.one(
        "SELECT cancel_requested,status FROM diagnostic_runs WHERE workspace_id=$1 AND id=$2 FOR UPDATE",
        [ws, challenge.run_id],
        q,
      );
      if (!run || run.cancel_requested || run.status === "canceled")
        throw new HttpError(403, "Diagnostic was canceled");
      const recorded = await this.db.one(
        "UPDATE diagnostic_mail_challenges SET received_at=now(),provider_id_hash=$3 WHERE workspace_id=$1 AND run_id=$2 AND received_at IS NULL RETURNING run_id",
        [ws, challenge.run_id, digest(data.MessageID)],
        q,
      );
      if (recorded) {
        await q.query(
          "UPDATE diagnostic_runs SET status='complete',health='current',evidence_level='read_verified',evidence=$3,finished_at=now() WHERE workspace_id=$1 AND id=$2",
          [
            ws,
            challenge.run_id,
            CheckEvidence.parse({
              summary:
                "Dedicated mailbox reply received through the authenticated Postmark handler",
              facts: {
                inboundVerified: true,
                smtpAccepted: true,
                evidenceOrigin: this.origin,
              },
            }),
          ],
        );
        await this.db.event(q, ws, "readiness.inbound_verified", {
          runId: challenge.run_id,
        });
      }
    });
    return true;
  }
  async assertPublication(ws: string) {
    if (
      await this.db.one(
        "SELECT 1 FROM attachment_settings WHERE workspace_id=$1 AND enabled",
        [ws],
      )
    )
      await this.app.attachments.scanner.health();

    if (
      !(await this.db.one(
        "SELECT 1 FROM readiness_settings WHERE workspace_id=$1 AND strict",
        [ws],
      ))
    )
      return;
    const dashboard = await this.dashboard({ workspaceId: ws, role: "owner" });
    const prospective = new Set([
      "core",
      "response_access",
      "embedding_access",
      "smtp_access",
      "knowledge",
    ]);
    if (
      dashboard.checks.some(
        (ch) =>
          (ch.required || prospective.has(ch.id)) &&
          (ch.health !== "current" || !verified(ch.level)),
      )
    )
      throw new HttpError(
        409,
        "Strict readiness blocks publication. Review Readiness and run current required checks.",
      );
  }
  async retain(ws: string, days: number) {
    await this.db.pool.query(
      "DELETE FROM diagnostic_mail_challenges WHERE workspace_id=$1 AND expires_at<now()-interval '1 day'",
      [ws],
    );
    await this.db.pool.query(
      "DELETE FROM diagnostic_attestations WHERE workspace_id=$1 AND created_at<now()-($2::int*interval '1 day')",
      [ws, days],
    );
    await this.db.pool.query(
      "UPDATE diagnostic_runs SET request='{}',evidence=jsonb_build_object('summary','Evidence removed by retention or source deletion; operation identity and accounting are retained'),remediation=NULL WHERE workspace_id=$1 AND request<>'{}' AND (created_at<now()-($2::int*interval '1 day') OR (request->'testResource'->>'contactId' IS NOT NULL AND NOT EXISTS(SELECT 1 FROM contacts c WHERE c.workspace_id=$1 AND c.id=diagnostic_runs.request->'testResource'->>'contactId'))) AND status NOT IN ('queued','running')",
      [ws, days],
    );
  }
  private async revalidateEffect(ws: string, run: any) {
    const current = await this.db.one(
      "SELECT r.status,r.cancel_requested,m.role FROM diagnostic_runs r LEFT JOIN memberships m ON m.workspace_id=r.workspace_id AND m.user_id=r.actor_id WHERE r.workspace_id=$1 AND r.id=$2",
      [ws, run.id],
    );
    const check = (await this.registry(ws)).find(
      (ch) => ch.id === run.check_id,
    );
    if (
      current?.status !== "running" ||
      current.cancel_requested ||
      !["owner", "admin"].includes(current.role) ||
      check?.fingerprint !== run.fingerprint
    )
      throw new HttpError(
        409,
        "Diagnostic effect authority changed before dispatch",
      );
    const intent = await this.db.one(
      "UPDATE diagnostic_runs SET effect_started_at=now() WHERE workspace_id=$1 AND id=$2 AND status='running' AND NOT cancel_requested RETURNING id",
      [ws, run.id],
    );
    if (!intent)
      throw new HttpError(409, "Diagnostic canceled before dispatch");
  }
  async advance(ws: string, id: string) {
    const connection = await this.db.pool.connect();
    try {
      const locked = (
        await connection.query(
          "SELECT pg_try_advisory_lock(hashtextextended($1,0)) locked",
          [`diagnostic:${id}`],
        )
      ).rows[0].locked;
      if (!locked) return;
      try {
        await this.execute(ws, id);
      } finally {
        await connection.query(
          "SELECT pg_advisory_unlock(hashtextextended($1,0))",
          [`diagnostic:${id}`],
        );
      }
    } finally {
      connection.release();
    }
  }
  private async execute(ws: string, id: string) {
    const row = await this.db.one(
      "SELECT * FROM diagnostic_runs WHERE workspace_id=$1 AND id=$2",
      [ws, id],
    );
    if (!row || !["queued", "running"].includes(row.status)) return;
    const finish = async (
      result: Result,
      status = "complete",
      remedy?: string,
    ) => {
      const evidence = CheckEvidence.parse({
        summary: result.summary,
        facts: { ...result.facts, evidenceOrigin: this.origin },
      });
      await this.db.tx(async (q) => {
        const current = await this.db.one(
          "SELECT * FROM diagnostic_runs WHERE workspace_id=$1 AND id=$2 FOR UPDATE",
          [ws, id],
          q,
        );
        // A fast authenticated mailbox reply may complete while SMTP returns.
        // Serialize with the inbound handler and preserve that stronger evidence.
        if (
          row.check_id === "postmark_roundtrip" &&
          current?.evidence_level === "read_verified"
        )
          return;
        await q.query(
          "UPDATE diagnostic_runs SET status=$3,health=$4,evidence_level=$5,evidence=$6,remediation=$7,finished_at=now() WHERE workspace_id=$1 AND id=$2",
          [
            ws,
            id,
            status,
            result.health ?? "current",
            result.level,
            evidence,
            remedy ?? null,
          ],
        );
        await this.db.event(q, ws, "readiness.completed", {
          runId: id,
          checkId: row.check_id,
          health: result.health ?? "current",
        });
      });
    };
    if (row.status === "running" && row.effect_started_at)
      return finish(
        {
          level: "configured_untested",
          health: "uncertain",
          summary:
            "Worker interrupted after request intent; outcome or token cost may be unknown. No automatic resend.",
        },
        "uncertain",
      );
    const check = (await this.registry(ws)).find(
      (ch) => ch.id === row.check_id,
    );
    const actor = await this.db.one(
      "SELECT role FROM memberships WHERE workspace_id=$1 AND user_id=$2",
      [ws, row.actor_id],
    );
    if (row.cancel_requested)
      return finish(
        {
          level: "configured_untested",
          health: "canceled",
          summary: "Canceled before execution",
        },
        "canceled",
      );
    if (
      !actor ||
      !["owner", "admin"].includes(actor.role) ||
      !check ||
      check.fingerprint !== row.fingerprint
    )
      return finish({
        level: "configured_untested",
        health: "stale",
        summary:
          "Initiating administrator or relevant configuration changed; start a new check",
      });
    if (!check.configured || check.prerequisite)
      return finish(
        {
          level: "not_configured",
          health: "blocked",
          summary: check.prerequisite ?? "Required configuration is missing",
        },
        "complete",
        check.remedy,
      );
    const claimed = await this.db.one(
      "UPDATE diagnostic_runs SET status='running',started_at=now(),effect_started_at=CASE WHEN risk IN ('paid_model','test_email') THEN now() ELSE NULL END WHERE workspace_id=$1 AND id=$2 AND status IN ('queued','running') AND NOT cancel_requested RETURNING id",
      [ws, id],
    );
    if (!claimed) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        usageContext.run(
          {
            purpose: "diagnostic",
            diagnosticId: id,
            settings: Settings.parse(
              requireValue(
                await this.db.one(
                  "SELECT settings FROM workspaces WHERE id=$1",
                  [ws],
                ),
              ).settings,
            ),
          },
          () => check.execute(row),
        ),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new HttpError(504, "Diagnostic deadline exceeded")),
            check.timeoutMs,
          );
        }),
      ]);
      if (
        check.id === "postmark_roundtrip" &&
        (await this.db.one(
          "SELECT 1 FROM diagnostic_mail_challenges WHERE workspace_id=$1 AND run_id=$2 AND received_at IS NOT NULL",
          [ws, id],
        ))
      ) {
        result.level = "read_verified";
        result.health = "current";
        result.summary =
          "Dedicated mailbox round trip verified through the authenticated inbound handler";
        result.facts = { smtpAccepted: true, inboundVerified: true };
      }
      const current = await this.db.one(
        "SELECT cancel_requested FROM diagnostic_runs WHERE workspace_id=$1 AND id=$2",
        [ws, id],
      );
      const changed =
        (await this.registry(ws)).find((ch) => ch.id === check.id)
          ?.fingerprint !== row.fingerprint;
      if (changed) result.health = "stale";
      if (current?.cancel_requested) {
        result.health = "canceled";
        result.summary +=
          ". Cancellation requested; completed external requests cannot be undone.";
      }
      const usage = await this.db.one(
        "SELECT count(*) n,coalesce(sum(input_tokens+output_tokens),0) tokens,coalesce(sum(reserved),0) reserved FROM usage WHERE workspace_id=$1 AND context_id=$2",
        [ws, id],
      );
      if (check.risk === "paid_model") {
        result.facts = {
          ...result.facts,
          reportedTokens: Number(usage?.tokens),
          unresolvedReservations: Number(usage?.reserved),
        };
        if (!Number(usage?.n) || Number(usage?.reserved)) {
          result.health = "degraded";
          result.summary += ". Provider token accounting is incomplete.";
        }
      }
      await finish(
        result,
        current?.cancel_requested ? "canceled" : "complete",
        result.health && result.health !== "current" ? check.remedy : undefined,
      );
    } catch (e) {
      const uncertain = !!(
        await this.db.one(
          "SELECT effect_started_at FROM diagnostic_runs WHERE workspace_id=$1 AND id=$2",
          [ws, id],
        )
      )?.effect_started_at;
      const code = e instanceof HttpError ? e.status : 502;
      // Never retain raw provider messages, transport configuration, tokens or customer payloads.
      await finish(
        {
          level: "configured_untested",
          health: uncertain ? "uncertain" : "failed",
          summary:
            code === 429
              ? "Provider rate limit or token cap reached; review usage before retrying"
              : code === 401 || code === 403
                ? "Access denied; reconnect or restore permissions"
                : code === 504
                  ? "Check timed out"
                  : "Check failed; review configuration and the exact operation before retrying",
          facts: { statusCode: code },
        },
        uncertain ? "uncertain" : "complete",
        check.remedy,
      );
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
