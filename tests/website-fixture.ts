import assert from "node:assert/strict";
import type { Fetcher } from "../packages/platform/src/security.js";

export function docsFixture() {
  const origin = "https://docs.example.test";
  const requests: string[] = [];
  const routes = new Map<string, [string, number?, string?]>([
    [
      "/robots.txt",
      [
        "User-agent: *\nDisallow: /guide/private\nSitemap: https://docs.example.test/maps/index.xml",
        200,
        "text/plain",
      ],
    ],
    [
      "/maps/index.xml",
      [
        "<sitemapindex><sitemap><loc>https://docs.example.test/maps/pages.xml</loc></sitemap><sitemap><loc>https://evil.example/map.xml</loc></sitemap></sitemapindex>",
        200,
        "application/xml",
      ],
    ],
    [
      "/maps/pages.xml",
      [
        "<urlset><url><loc>https://docs.example.test/guide/unlinked</loc></url><url><loc>https://docs.example.test/other-space</loc></url><url><loc>https://127.0.0.1/admin</loc></url></urlset>",
        200,
        "application/xml",
      ],
    ],
    [
      "/guide",
      [
        '<html><body><nav>Navigation noise<a href="/guide/start#install">Start</a><a href="/guide/start/?utm_source=nav">Start again</a><a href="/guide/private">Private</a><a href="/guide/noindex">Hidden</a><a href="/guide/deleted">Deleted</a><a href="/guide/asset.pdf">PDF</a><a href="https://evil.example/steal">External</a><a href="/guidebook">Other book</a></nav><main><article><h1>Documentation home</h1><p>Welcome to the documentation site.</p></article></main><script>Untrusted script</script></body></html>',
      ],
    ],
    [
      "/guide/start",
      [
        '<main><article><h1>Getting started</h1><p>Install the application.</p><p>Then create your workspace.</p><a href="/guide">Home</a></article></main>',
      ],
    ],
    [
      "/guide/unlinked",
      [
        "<main><h1>GitBook page</h1><div>Configure your workspace here.</div><div>Save your settings.</div></main>",
      ],
    ],
    [
      "/guide/noindex",
      [
        '<meta name="robots" content="noindex"><main><h1>Hidden page</h1><p>Should not be indexed.</p></main>',
      ],
    ],
  ]);
  const fetch: Fetcher = async (url) => {
    requests.push(url);
    assert.equal(
      new URL(url).origin,
      origin,
      "must never fetch an external/private host",
    );
    const [text, status = 200, type = "text/html"] = routes.get(
      new URL(url).pathname,
    ) ?? ["Missing", 404];
    return new Response(text, { status, headers: { "Content-Type": type } });
  };
  return { origin, requests, routes, fetch };
}
