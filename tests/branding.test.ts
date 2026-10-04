import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createApp } from "../apps/api/server.js";
import { testConfig, resetDatabase, TestModel, workspace } from "./helpers.js";
import {
  Appearance,
  contrast,
  readableText,
} from "../packages/platform/src/branding-contracts.js";
import { logoImage } from "../packages/platform/src/branding.js";

const config = testConfig(4353);
let server: Awaited<ReturnType<typeof createApp>>;
let owner: { id: string; cookie: string },
  agent: { id: string; cookie: string },
  outsider: { id: string; cookie: string };
let w: Awaited<ReturnType<typeof workspace>>;
const password = "a-dedicated-test-password";
const logo = await readFile(new URL("./fixtures/logo.png", import.meta.url));
async function call(
  path: string,
  data?: unknown,
  cookie = "",
  method?: string,
) {
  return fetch(config.FIELDKIT_URL + path, {
    method: method ?? (data === undefined ? "GET" : "POST"),
    headers: {
      Origin: config.FIELDKIT_URL,
      "Content-Type": "application/json",
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
}
async function signIn(email: string, value = password) {
  const response = await call("/api/auth/sign-in/email", {
    email,
    password: value,
  });
  assert.equal(response.status, 200, await response.clone().text());
  return response.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
}
async function account(email: string) {
  const signup = await call("/api/auth/sign-up/email", {
    email,
    name: "Test account",
    password,
  });
  assert.equal(signup.status, 200);
  const { user } = (await signup.json()) as any;
  await server.app.db.pool.query(
    'UPDATE "user" SET "emailVerified"=true WHERE id=$1',
    [user.id],
  );
  return { id: user.id as string, cookie: await signIn(email) };
}
before(async () => {
  await resetDatabase(config.DATABASE_URL);
  server = await createApp(config, {
    migrate: true,
    model: new TestModel(),
    mailer: async () => {},
  });
  await new Promise<void>((resolve) =>
    server.server.listen(config.FIELDKIT_PORT, "127.0.0.1", resolve),
  );
  owner = await account("brand-owner@example.test");
  agent = await account("brand-agent@example.test");
  outsider = await account("brand-outsider@example.test");
  w = await workspace(server.app, owner.id);
  await server.app.db.pool.query(
    "INSERT INTO memberships VALUES($1,$2,'agent')",
    [w.ws.id, agent.id],
  );
});
after(async () => server.close());

test("appearance saves atomically, protects workspace access, and refuses stale edits", async () => {
  const path = `/v2/workspaces/${w.ws.id}/appearance`;
  const originalWorkspace = await server.app.db.one(
    "SELECT settings,revision FROM workspaces WHERE id=$1",
    [w.ws.id],
  );
  const initial = (await (
    await call(path, undefined, owner.cookie)
  ).json()) as any;
  assert.equal(initial.revision, 0);
  const data = {
    revision: 0,
    config: {
      ...initial.config,
      brandName: "Customer help",
      accentColor: "#fff100",
      heroColor: "#16223a",
      websiteUrl: "https://example.com",
      privacyUrl: "https://example.com/privacy",
    },
    logo: { data: logo.toString("base64") },
  };
  assert.equal((await call(path, data, agent.cookie, "PUT")).status, 403);
  assert.equal((await call(path, data, outsider.cookie, "PUT")).status, 403);
  assert.equal((await call(path, undefined, outsider.cookie)).status, 403);
  assert.equal((await call(path, data, "", "PUT")).status, 401);
  const saved = await call(path, data, owner.cookie, "PUT");
  assert.equal(saved.status, 200, await saved.clone().text());
  const result = (await saved.json()) as any;
  assert.equal(result.revision, 1);
  assert.ok(result.logoUrl);
  assert.equal((await call(path, data, owner.cookie, "PUT")).status, 409);
  const races = await Promise.all(
    ["First", "Second"].map((greeting) =>
      call(
        path,
        { revision: 1, config: { ...data.config, greeting } },
        owner.cookie,
        "PUT",
      ),
    ),
  );
  assert.deepEqual(races.map((r) => r.status).sort(), [200, 409]);
  assert.deepEqual((await server.app.branding.logo(w.ws.id)).logo, logo);
  assert.equal(
    (await server.app.db.one(
      "SELECT count(*)::int AS n FROM events WHERE workspace_id=$1 AND kind='appearance.updated'",
      [w.ws.id],
    ))!.n,
    2,
  );
  // Neither provider settings nor workflow policy revision changes for a visual edit.
  const current = await server.app.db.one(
    "SELECT settings,revision FROM workspaces WHERE id=$1",
    [w.ws.id],
  );
  assert.deepEqual(current!.settings, originalWorkspace!.settings);
  assert.equal(current!.revision, originalWorkspace!.revision);
});

test("only published channels expose branding and logos; removal and unpublishing take effect immediately", async () => {
  const path = `/v2/public/${w.ws.slug}`;
  const published = (await (await call(path)).json()) as any;
  assert.equal(published.name, "Customer help");
  assert.equal(published.brandColor, "#fff100");
  assert.ok(!JSON.stringify(published).includes("base64"));
  const response = await call(published.appearance.logoUrl);
  assert.equal(response.headers.get("content-type"), "image/png");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), logo);
  await server.app.db.pool.query(
    "UPDATE channels SET published=false WHERE workspace_id=$1",
    [w.ws.id],
  );
  assert.equal((await call(path)).status, 404);
  assert.equal((await call(published.appearance.logoUrl)).status, 404);
  assert.equal(
    (
      await call(
        `/v2/workspaces/${w.ws.id}/appearance/logo`,
        undefined,
        agent.cookie,
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await call(
        `/v2/workspaces/${w.ws.id}/appearance/logo`,
        undefined,
        owner.cookie,
      )
    ).status,
    200,
  );
  await server.app.db.pool.query(
    "UPDATE channels SET published=true WHERE workspace_id=$1 AND kind='widget'",
    [w.ws.id],
  );
  const widget = (await (await call(`${path}/widget/config`)).json()) as any;
  assert.equal(widget.name, published.name);
  assert.equal(widget.brandTextColor, "#000000");
  assert.equal((await call(widget.appearance.logoUrl)).status, 200);
  const current = await server.app.branding.get(w.ws.id);
  await server.app.branding.save(w.owner, {
    revision: current.revision,
    config: current.config,
    logo: null,
  });
  assert.equal((await call(widget.appearance.logoUrl)).status, 404);
  assert.equal((await server.app.branding.get(w.ws.id)).logoUrl, null);
});

test("branding rejects active content, unsafe links, invalid colors and oversized images", async () => {
  for (const link of [
    "javascript:alert(1)",
    "data:text/html,hello",
    "https://user:password@example.com",
    "http://example.com",
  ])
    assert.equal(Appearance.safeParse({ privacyUrl: link }).success, false);
  assert.equal(
    Appearance.safeParse({ accentColor: "red;display:none" }).success,
    false,
  );
  assert.throws(() =>
    logoImage(Buffer.from('<svg onload="alert(1)"></svg>').toString("base64")),
  );
  assert.throws(() => logoImage("%%%"));
  assert.throws(
    () => logoImage(Buffer.alloc(1024 * 1024 + 1).toString("base64")),
    /1 MB/,
  );
  const huge = Buffer.from(logo);
  huge.writeUInt32BE(50000, 16);
  assert.throws(() => logoImage(huge.toString("base64")), /2048/);
  assert.equal(logoImage(logo.toString("base64")).mime, "image/png");
  for (const color of [
    "#ffffff",
    "#000000",
    "#fff100",
    "#777777",
    "#146b57",
    "#b9c9ff",
  ])
    assert.ok(contrast(color, readableText(color)) >= 4.5);
  const before = await server.app.branding.get(w.ws.id);
  const response = await call(
    `/v2/workspaces/${w.ws.id}/appearance`,
    {
      revision: before.revision,
      config: before.config,
      logo: { data: Buffer.from("not an image").toString("base64") },
    },
    owner.cookie,
    "PUT",
  );
  assert.equal(response.status, 400);
  assert.deepEqual(await server.app.branding.get(w.ws.id), before);
});

test("workspace renaming keeps the public address and profile edits are self-only", async () => {
  const path = `/v2/workspaces/${w.ws.id}/profile`;
  assert.equal(
    (await call(path, { name: "Renamed workspace" }, agent.cookie, "PUT"))
      .status,
    403,
  );
  assert.equal(
    (
      await call(
        path,
        { name: "Renamed workspace", slug: "hijack" },
        owner.cookie,
        "PUT",
      )
    ).status,
    400,
  );
  assert.equal(
    (await call(path, { name: "Renamed workspace" }, owner.cookie, "PUT"))
      .status,
    200,
  );
  const updated = await server.app.db.one(
    "SELECT name,slug FROM workspaces WHERE id=$1",
    [w.ws.id],
  );
  assert.equal(updated!.slug, w.ws.slug);
  assert.equal(updated!.name, "Renamed workspace");
  await server.app.db.pool.query("UPDATE contacts SET user_id=$1 WHERE id=$2", [
    owner.id,
    w.contactId,
  ]);
  assert.equal(
    (
      await call(
        "/v2/profile",
        { name: "New name", id: outsider.id },
        owner.cookie,
        "PUT",
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await call(
        "/v2/profile",
        { name: "New name", email: "other@example.com" },
        owner.cookie,
        "PUT",
      )
    ).status,
    400,
  );
  assert.equal(
    (await call("/v2/profile", { name: "New name" }, "", "PUT")).status,
    401,
  );
  assert.equal(
    (await call("/v2/profile", { name: "New name" }, owner.cookie, "PUT"))
      .status,
    200,
  );
  const me = (await (
    await call("/v2/me", undefined, owner.cookie)
  ).json()) as any;
  assert.equal(me.user.name, "New name");
  assert.equal(me.user.email, "brand-owner@example.test");
  const contact = await server.app.db.one(
    "SELECT name,mappings FROM contacts WHERE id=$1",
    [w.contactId],
  );
  assert.equal(contact!.name, "New name");
  assert.equal(contact!.mappings.stripe_test, "cus_123");
  assert.equal(
    (await server.app.db.one('SELECT name FROM "user" WHERE id=$1', [
      outsider.id,
    ]))!.name,
    "Test account",
  );
});

test("password changes require the current password and other-session revocation preserves the current account", async () => {
  // Account setup deliberately consumed the sign-in burst limit in this isolated test database.
  await server.app.db.pool.query('DELETE FROM "rateLimit"');
  const otherCookie = await signIn("brand-owner@example.test");
  const sessions = (await (
    await call("/api/auth/list-sessions", undefined, owner.cookie)
  ).json()) as any[];
  assert.ok(sessions.length >= 2);
  assert.equal(
    (await call("/api/auth/revoke-other-sessions", {}, owner.cookie)).status,
    200,
  );
  assert.equal((await call("/v2/me", undefined, otherCookie)).status, 401);
  assert.equal((await call("/v2/me", undefined, outsider.cookie)).status, 200);
  const newPassword = "changed-dedicated-test-password";
  assert.notEqual(
    (
      await call(
        "/api/auth/change-password",
        { currentPassword: "incorrect", newPassword },
        owner.cookie,
      )
    ).status,
    200,
  );
  const changed = await call(
    "/api/auth/change-password",
    { currentPassword: password, newPassword, revokeOtherSessions: true },
    owner.cookie,
  );
  assert.equal(changed.status, 200, await changed.clone().text());
  assert.equal(
    (
      await call("/api/auth/sign-in/email", {
        email: "brand-owner@example.test",
        password,
      })
    ).status,
    401,
  );
  assert.ok(await signIn("brand-owner@example.test", newPassword));
});
