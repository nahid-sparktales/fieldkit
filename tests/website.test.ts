import { test } from "node:test";
import assert from "node:assert/strict";
import {
  crawlWebsite,
  readWebPage,
  SITE_PAGE_LIMIT,
} from "../packages/platform/src/website.js";
import type { Fetcher } from "../packages/platform/src/security.js";
import { SourceInput } from "../packages/platform/src/contracts.js";

import { docsFixture } from "./website-fixture.js";

test("documentation crawl combines nested sitemaps and links, scopes URLs and honors robots/noindex", async () => {
  const f = docsFixture();
  const { pages, progress } = await crawlWebsite(f.origin + "/guide", f.fetch);
  assert.deepEqual(
    pages.map((p) => p.locator).sort(),
    ["/guide", "/guide/start", "/guide/unlinked"].map((p) => f.origin + p),
  );
  assert.equal(f.requests.filter((u) => u.includes("/guide/start")).length, 1);
  assert.ok(
    !f.requests.some((u) => /private|other-space|guidebook|\.pdf/.test(u)),
  );
  assert.equal(progress.skipped.length, 3);
  const home = pages.find((p) => p.locator.endsWith("/guide"))!;
  assert.equal(home.title, "Documentation home");
  assert.ok(!home.text.includes("Navigation noise"));
  assert.ok(!home.text.includes("Untrusted script"));
  assert.match(
    pages.find((p) => p.locator.endsWith("/start"))!.text,
    /application\.\nThen/,
  );
});

test("documentation crawl rejects unsafe redirects and page limits, and reports outages", async () => {
  for (const destination of [
    "https://127.0.0.1/admin",
    "https://evil.example/docs",
    "https://docs.example.test/elsewhere",
  ]) {
    const f = docsFixture();
    const fetch: Fetcher = (url, init) =>
      url.endsWith("/guide/start")
        ? Promise.resolve(
            new Response(null, {
              status: 302,
              headers: { Location: destination },
            }),
          )
        : f.fetch(url, init);
    await assert.rejects(
      crawlWebsite(f.origin + "/guide", fetch),
      /Private network|leaves the selected/,
    );
  }
  const f = docsFixture();
  f.routes.set("/maps/pages.xml", [
    "<urlset>" +
      Array.from(
        { length: SITE_PAGE_LIMIT },
        (_, i) => `<url><loc>${f.origin}/guide/page-${i}</loc></url>`,
      ).join("") +
      "</urlset>",
    200,
    "application/xml",
  ]);
  await assert.rejects(crawlWebsite(f.origin + "/guide", f.fetch), /500 pages/);
  f.routes.set("/maps/pages.xml", ["Unavailable", 503]);
  await assert.rejects(crawlWebsite(f.origin + "/guide", f.fetch), /503/);
});

test("single page remains the API default; whole-site imports are limited to websites", () => {
  assert.equal(
    SourceInput.parse({
      kind: "website",
      title: "Docs",
      locator: "https://docs.example.test",
    }).scope,
    "page",
  );
  assert.equal(
    SourceInput.safeParse({
      kind: "notion",
      title: "Docs",
      locator: "a".repeat(32),
      scope: "site",
    }).success,
    false,
  );
  assert.equal(
    readWebPage(
      "<main><h1>Title</h1><p>One paragraph.</p><p>Another paragraph.</p></main>",
      "https://docs.example.test",
    ).text,
    "Title\nOne paragraph.\nAnother paragraph.",
  );
});
test("GitBook subpath imports discover ancestor sitemaps even when origin robots redirects to a canonical host", async () => {
  const requests: string[] = [];
  const fetch: Fetcher = async (url) => {
    requests.push(url);
    if (url === "https://docs.example.test/robots.txt")
      return new Response(null, {
        status: 302,
        headers: { Location: "https://www.example.test/robots.txt" },
      });
    if (url === "https://www.example.test/robots.txt")
      return new Response("User-agent: *\nAllow: /", {
        headers: { "Content-Type": "text/plain" },
      });
    if (url === "https://docs.example.test/docs/sitemap.xml")
      return new Response(
        "<urlset><url><loc>https://docs.example.test/docs/guide/unlinked</loc></url><url><loc>https://www.example.test/marketing</loc></url></urlset>",
        { headers: { "Content-Type": "application/xml" } },
      );
    if (url.endsWith("sitemap.xml"))
      return new Response("Missing", { status: 404 });
    return new Response(
      "<main><h1>Docs page</h1><p>Readable documentation for this page.</p></main>",
      { headers: { "Content-Type": "text/html" } },
    );
  };
  const { pages } = await crawlWebsite(
    "https://docs.example.test/docs/guide",
    fetch,
  );
  assert.equal(pages.length, 2);
  assert.ok(requests.includes("https://docs.example.test/docs/sitemap.xml"));
  assert.ok(!requests.includes("https://www.example.test/marketing"));
});
