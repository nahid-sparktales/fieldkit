import * as cheerio from "cheerio";
import robotsParser from "robots-parser";
import { externalURL, type Fetcher } from "./security.js";

const USER_AGENT = "FieldKitBot";
export const SITE_PAGE_LIMIT = 500;
export type WebPage = { locator: string; title: string; text: string };
export type CrawlProgress = {
  phase: "discovering" | "scanning" | "indexing" | "complete";
  discovered: number;
  scanned: number;
  indexed: number;
  skipped: { url: string; reason: string }[];
};

// Queries/fragments and trailing slashes are aliases for these static docs sites.
function pageURL(raw: string, base: string) {
  const u = new URL(raw, base);
  u.hash = "";
  u.search = "";
  externalURL(u.href);
  u.pathname =
    u.pathname.replace(/\/index\.html$/, "/").replace(/\/$/, "") || "/";
  return u;
}

export function readWebPage(html: string, locator: string): WebPage {
  const $ = cheerio.load(html);
  const title =
    $("h1").first().text().trim() || $("title").text().trim() || locator;
  $(
    "script,style,nav,footer,header,aside,form,iframe,noscript,svg,[aria-hidden='true']",
  ).remove();
  const body = $("article").first().length
    ? $("article").first()
    : $("main").first().length
      ? $("main").first()
      : $("body");
  body
    .find("p,div,section,li,pre,blockquote,h1,h2,h3,h4,h5,h6,tr,br")
    .before("\n");
  body.find("td,th").append(" | ");
  return {
    locator,
    title: title.slice(0, 200),
    text: body
      .text()
      .replace(/\u0000/g, "")
      .replace(/[\t ]+/g, " ")
      .replace(/\n\s*\n/g, "\n\n")
      .trim(),
  };
}

export async function crawlWebsite(
  locator: string,
  fetch: Fetcher,
  report: (progress: CrawlProgress) => Promise<void> = async () => {},
): Promise<{ pages: WebPage[]; progress: CrawlProgress }> {
  const root = pageURL(locator, locator);
  const prefix = root.pathname === "/" ? "/" : root.pathname + "/";
  const inScope = (u: URL) =>
    u.origin === root.origin &&
    (u.pathname === root.pathname || u.pathname.startsWith(prefix));
  const progress: CrawlProgress = {
    phase: "discovering",
    discovered: 0,
    scanned: 0,
    indexed: 0,
    skipped: [],
  };
  await report(progress);
  const pending = new Set<string>(),
    visited = new Set<string>(),
    pages = new Map<string, WebPage>();
  const deadline = Date.now() + 5 * 60_000;
  let bytes = 0,
    characters = 0;
  let robots: ReturnType<typeof robotsParser> | undefined;
  let delay = 100,
    lastRequest = 0;
  const get = async (raw: string, sitemap = false) => {
    let url = externalURL(raw);
    for (let redirects = 0; redirects < 5; redirects++) {
      if (Date.now() > deadline)
        throw new Error(
          "Documentation scan exceeded five minutes. Import a smaller documentation section.",
        );
      // robots.txt / sitemap redirects may use a canonical host, but every
      // documentation page and discovered sitemap remains scoped to the source.
      if (!sitemap && !inScope(pageURL(url.href, root.href)))
        throw new Error(
          `Redirect leaves the selected documentation site: ${url.href}`,
        );
      if (robots?.isAllowed(url.href, USER_AGENT) === false)
        throw new Error(`Crawling is disallowed by robots.txt: ${url.href}`);
      if (lastRequest + delay > deadline)
        throw new Error(
          "The site's crawl delay exceeds this scan's time limit. Import a smaller section.",
        );
      await new Promise((resolve) =>
        setTimeout(resolve, Math.max(0, lastRequest + delay - Date.now())),
      );
      lastRequest = Date.now();
      const response = await fetch(url.href, {
        headers: {
          "User-Agent": USER_AGENT,
          Accept: "text/html,application/xhtml+xml,application/xml,text/plain",
        },
        limit: 2 * 1024 * 1024,
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const next = response.headers.get("location");
        if (!next) throw new Error(`Missing redirect destination: ${url.href}`);
        const target = new URL(next, url);
        target.hash = "";
        url = externalURL(target.href);
        continue;
      }
      const text = await response.text();
      bytes += Buffer.byteLength(text);
      if (bytes > 50 * 1024 * 1024)
        throw new Error(
          "Documentation scan exceeds 50 MB. Import smaller documentation sections.",
        );
      return { response, text, url: url.href };
    }
    throw new Error(`Too many redirects: ${raw}`);
  };
  const robotURL = new URL("/robots.txt", root).href;
  const robotResponse = await get(robotURL, true);
  if (
    !robotResponse.response.ok &&
    ![404, 410].includes(robotResponse.response.status)
  )
    throw new Error(
      `Unable to check robots.txt (${robotResponse.response.status})`,
    );
  robots = robotsParser(
    robotURL,
    robotResponse.response.ok ? robotResponse.text : "",
  );
  delay = Math.max(delay, (robots.getCrawlDelay(USER_AGENT) ?? 0) * 1000);
  if (robots.isAllowed(root.href, USER_AGENT) === false)
    throw new Error("This documentation site disallows crawling in robots.txt");
  const add = (raw: string, base: string) => {
    let u: URL;
    try {
      u = pageURL(raw, base);
    } catch {
      return;
    }
    if (!inScope(u) || /\.(?!html?$)[a-z0-9]{1,8}$/i.test(u.pathname)) return;
    if (pending.has(u.href)) return;
    if (pending.size >= SITE_PAGE_LIMIT)
      throw new Error(
        `Documentation exceeds ${SITE_PAGE_LIMIT} pages. Import smaller documentation sections.`,
      );
    pending.add(u.href);
    progress.discovered = pending.size;
  };
  add(root.href, root.href);
  const sitemaps = new Set<string>();
  // GitBook can publish a docs site below /docs while the selected section is
  // deeper. Its sitemap then lives at /docs/sitemap.xml, not at the origin root.
  let directory = prefix;
  for (;;) {
    sitemaps.add(new URL(directory + "sitemap.xml", root).href);
    if (directory === "/") break;
    directory = directory.slice(0, directory.slice(0, -1).lastIndexOf("/") + 1);
  }
  for (const raw of robots.getSitemaps()) {
    const u = externalURL(raw);
    if (u.origin === root.origin) sitemaps.add(u.href);
  }
  for (const map of sitemaps) {
    if (sitemaps.size > 25)
      throw new Error(
        "Documentation exceeds 25 sitemaps. Import a smaller section.",
      );
    if (robots.isAllowed(map, USER_AGENT) === false) continue;
    const { response, text, url } = await get(map, true);
    if ([404, 410].includes(response.status)) continue;
    if (!response.ok)
      throw new Error(
        `Sitemap could not be retrieved (${response.status}): ${map}`,
      );
    const $ = cheerio.load(text, { xmlMode: true });
    $("sitemapindex > sitemap > loc").each((_, element) => {
      let u: URL;
      try {
        u = externalURL(new URL($(element).text().trim(), url).href);
      } catch {
        return;
      }
      if (u.origin === root.origin) sitemaps.add(u.href);
    });
    $("urlset > url > loc").each((_, element) =>
      add($(element).text().trim(), url),
    );
  }
  progress.phase = "scanning";
  await report(progress);
  for (const next of pending) {
    if (visited.has(next)) continue;
    visited.add(next);
    let reason = "";
    if (robots.isAllowed(next, USER_AGENT) === false)
      reason = "Disallowed by robots.txt";
    else {
      const { response, text, url } = await get(next);
      const actual = pageURL(url, root.href).href;
      visited.add(actual);
      if ([401, 403, 404, 410].includes(response.status))
        reason = `Unavailable (${response.status})`;
      else if (!response.ok)
        throw new Error(
          `Documentation page could not be retrieved (${response.status}): ${next}`,
        );
      else if (
        !/text\/html|application\/xhtml\+xml/i.test(
          response.headers.get("content-type") ?? "",
        )
      )
        reason = "Not an HTML page";
      else {
        const $ = cheerio.load(text);
        $("a[href]").each((_, element) => add($(element).attr("href")!, url));
        const directive = `${response.headers.get("x-robots-tag") ?? ""} ${$(
          "meta[name='robots'],meta[name='FieldKitBot']",
        )
          .map((_, el) => $(el).attr("content") ?? "")
          .get()
          .join(" ")}`;
        const page = readWebPage(text, actual);
        if (/\b(noindex|none)\b/i.test(directive))
          reason = "Page requests no indexing";
        else if (page.text.length < 10)
          reason = "No readable text (may require JavaScript or login)";
        else if (!pages.has(actual)) {
          characters += page.text.length;
          if (page.text.length > 1_500_000 || characters > 5_000_000)
            throw new Error(
              "Documentation text exceeds the size limit. Import smaller sections.",
            );
          pages.set(actual, page);
        }
      }
    }
    if (reason) progress.skipped.push({ url: next, reason });
    progress.scanned++;
    await report(progress);
  }
  if (!pages.size)
    throw new Error(
      "No readable documentation pages were found. Check the URL and public access.",
    );
  return { pages: [...pages.values()], progress };
}
