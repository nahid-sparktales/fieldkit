import { readFile, writeFile, mkdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import * as cheerio from "cheerio";
import mammoth from "mammoth";
import type { Database } from "./db.js";
import { uid } from "./db.js";
import type { Connections } from "./connections.js";
import type { ModelPort } from "./model.js";
import { HttpError, requireValue } from "./config.js";
import { digest, externalURL } from "./security.js";
import type { Citation } from "./contracts.js";
import { crawlWebsite, type CrawlProgress, type WebPage } from "./website.js";

const MAX_BYTES = 20 * 1024 * 1024;
export function chunks(text: string): string[] {
  const clean = text
    .replace(/\r\n/g, "\n")
    .replace(/\u0000/g, "")
    .trim();
  const result: string[] = [];
  for (let offset = 0; offset < clean.length; offset += 2800)
    result.push(clean.slice(offset, offset + 3200));
  return result;
}
export async function extract(
  data: Buffer,
  name: string,
  mime = "",
): Promise<string> {
  if (data.length > MAX_BYTES)
    throw new HttpError(413, "Files are limited to 20 MB");
  const ext = name.toLowerCase().split(".").pop();
  let result: string;
  if (ext === "pdf" || mime === "application/pdf") {
    const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const loading = getDocument({
      data: new Uint8Array(data),
      useSystemFonts: true,
      disableFontFace: true,
    });
    const pdf = await loading.promise;
    try {
      if (pdf.numPages > 500) throw new Error("PDFs are limited to 500 pages");
      const pages: string[] = [];
      for (let n = 1; n <= pdf.numPages; n++) {
        const page = await pdf.getPage(n);
        const content = await page.getTextContent();
        pages.push(
          content.items.map((x) => ("str" in x ? x.str : "")).join(" "),
        );
        page.cleanup();
      }
      result = pages.join("\n\n");
    } finally {
      await loading.destroy();
    }
  } else if (ext === "docx" || mime.includes("wordprocessingml"))
    result = (await mammoth.extractRawText({ buffer: data })).value;
  else if (
    ["txt", "md", "csv"].includes(ext ?? "") ||
    mime.startsWith("text/plain")
  )
    result = data.toString("utf8");
  else
    throw new HttpError(415, "Supported files: PDF, DOCX, Markdown and text");
  result = result.replace(/\u0000/g, "").trim();
  if (result.length < 10)
    throw new HttpError(
      422,
      "No readable text found. Image-only PDFs need OCR before uploading.",
    );
  if (result.length > 1500000)
    throw new HttpError(413, "Extracted text exceeds 1.5 million characters");
  return result;
}
export class Knowledge {
  constructor(
    public db: Database,
    public connections: Connections,
    public model: ModelPort,
  ) {}
  async upload(ws: string, name: string, data: Buffer) {
    if (!/\.(pdf|docx|md|txt)$/i.test(name))
      throw new HttpError(415, "Upload PDF, DOCX, Markdown or text");
    if (data.length > MAX_BYTES)
      throw new HttpError(413, "Files are limited to 20 MB");
    const id = uid(),
      dir = join(this.db.config.FIELDKIT_DATA, "uploads", ws);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, id), data, { mode: 0o600, flag: "wx" });
    try {
      return await this.db.tx(async (q) => {
        await q.query(
          "INSERT INTO sources(id,workspace_id,kind,title,locator,metadata) VALUES($1,$2,'file',$3,$4,$5)",
          [id, ws, name, id, { filename: name, bytes: data.length }],
        );
        await this.db.enqueue(q, "ingest", { workspaceId: ws, sourceId: id });
        return { id, status: "queued" };
      });
    } catch (e) {
      await unlink(join(dir, id));
      throw e;
    }
  }
  validateLocator(kind: string, locator: string) {
    if (kind === "website") externalURL(locator);
    else if (kind === "notion" && !/^[a-f0-9-]{32,36}$/i.test(locator))
      throw new HttpError(400, "Use the selected Notion page ID");
    else if (kind === "google" && !/^[\w-]{10,200}$/.test(locator))
      throw new HttpError(400, "Use a file selected in Google Picker");
    else if (kind === "zendesk" && !/^\d{1,30}$/.test(locator))
      throw new HttpError(400, "Use the Zendesk help-center article ID");
  }
  async add(
    ws: string,
    input: {
      kind: string;
      title: string;
      locator: string;
      scope?: "page" | "site";
    },
  ) {
    this.validateLocator(input.kind, input.locator);
    const id = uid();
    return this.db.tx(async (q) => {
      await q.query(
        "INSERT INTO sources(id,workspace_id,kind,title,locator,metadata) VALUES($1,$2,$3,$4,$5,$6)",
        [
          id,
          ws,
          input.kind,
          input.title,
          input.locator,
          { scope: input.scope ?? "page" },
        ],
      );
      await this.db.enqueue(q, "ingest", { workspaceId: ws, sourceId: id });
      return { id, status: "queued" };
    });
  }
  async refresh(ws: string, id: string) {
    await this.db.tx(async (q) => {
      const r = await q.query(
        "UPDATE sources SET status='queued',active=true,revision=revision+1,error=null WHERE workspace_id=$1 AND id=$2 RETURNING id",
        [ws, id],
      );
      if (!r.rowCount) throw new HttpError(404, "Source not found");
      await this.db.enqueue(q, "ingest", { workspaceId: ws, sourceId: id });
    });
  }
  async remove(ws: string, id: string) {
    const row = await this.db.tx(async (q) => {
      const row = requireValue(
        await this.db.one(
          "DELETE FROM sources WHERE workspace_id=$1 AND id=$2 RETURNING *",
          [ws, id],
          q,
        ),
      );
      await this.db.event(q, ws, "knowledge.removed", { sourceId: id });
      return row;
    });
    if (row.kind === "file")
      await unlink(
        join(this.db.config.FIELDKIT_DATA, "uploads", ws, row.locator),
      ).catch(() => {});
  }
  private async load(source: any): Promise<string> {
    const ws = source.workspace_id;
    if (source.kind === "file")
      return extract(
        await readFile(
          join(this.db.config.FIELDKIT_DATA, "uploads", ws, source.locator),
        ),
        source.metadata.filename,
      );
    if (source.kind === "website") {
      let url = source.locator,
        response: Response | undefined;
      for (let i = 0; i < 4; i++) {
        response = await this.connections.fetch(url);
        if (response.status >= 300 && response.status < 400) {
          url = externalURL(
            new URL(response.headers.get("location") ?? "", url).toString(),
          ).toString();
          continue;
        }
        break;
      }
      if (!response?.ok) throw new Error("Website could not be retrieved");
      if (!(response.headers.get("content-type") ?? "").includes("text/html"))
        throw new Error("Website sources must return HTML");
      const $ = cheerio.load(await response.text());
      $("script,style,nav,footer,form,iframe,noscript,svg").remove();
      return ($("main").length ? $("main") : $("body"))
        .text()
        .replace(/[\t ]+/g, " ")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
    }
    if (source.kind === "notion") {
      const lines: string[] = [];
      let total = 0;
      const walk = async (id: string, depth: number) => {
        if (depth > 12)
          throw new Error("Notion page exceeds 12 levels of nested blocks");
        let cursor: string | undefined;
        do {
          const data = await this.connections.json(
            ws,
            "notion",
            `/v1/blocks/${encodeURIComponent(id)}/children?page_size=100${cursor ? "&start_cursor=" + encodeURIComponent(cursor) : ""}`,
          );
          for (const block of data.results) {
            if (++total > 5000)
              throw new Error("Notion page exceeds 5,000 blocks");
            const value = block[block.type];
            if (value?.rich_text)
              lines.push(
                value.rich_text
                  .map((v: any) => v.plain_text ?? v.text?.content ?? "")
                  .join(""),
              );
            if (block.type === "table_row")
              lines.push(
                (value.cells ?? [])
                  .map((cell: any[]) =>
                    cell
                      .map((v) => v.plain_text ?? v.text?.content ?? "")
                      .join(""),
                  )
                  .join(" | "),
              );
            if (block.has_children) await walk(block.id, depth + 1);
          }
          cursor = data.has_more ? data.next_cursor : undefined;
        } while (cursor);
      };
      await walk(source.locator, 0);
      return lines.join("\n");
    }
    if (source.kind === "google") {
      const file = await this.connections.json(
        ws,
        "google",
        `/drive/v3/files/${encodeURIComponent(source.locator)}?fields=id,name,mimeType,trashed,capabilities(canDownload)`,
      );
      if (file.trashed || file.capabilities?.canDownload === false)
        throw new HttpError(
          403,
          "Drive file was removed or download access was revoked",
        );
      const googleDoc =
          file.mimeType === "application/vnd.google-apps.document",
        sheet = file.mimeType === "application/vnd.google-apps.spreadsheet";
      const path =
        `/drive/v3/files/${encodeURIComponent(source.locator)}` +
        (googleDoc || sheet
          ? `/export?mimeType=${encodeURIComponent(sheet ? "text/csv" : "text/plain")}`
          : "?alt=media");
      const res = await this.connections.request(ws, "google", path);
      return extract(
        Buffer.from(await res.arrayBuffer()),
        googleDoc ? "document.txt" : sheet ? "sheet.csv" : file.name,
        googleDoc || sheet ? "text/plain" : file.mimeType,
      );
    }
    if (source.kind === "zendesk") {
      const data = await this.connections.json(
        ws,
        "zendesk",
        `/api/v2/help_center/articles/${source.locator}.json`,
      );
      if (data.article.draft) throw new Error("Zendesk article is a draft");
      const $ = cheerio.load(data.article.body ?? "");
      $("script,style").remove();
      return $.text();
    }
    throw new Error("Unsupported source");
  }
  async ingest(ws: string, id: string) {
    const lock = await this.db.pool.connect();
    const key = `knowledge:${ws}:${id}`;
    try {
      await lock.query("SELECT pg_advisory_lock(hashtextextended($1,0))", [
        key,
      ]);
      await this.ingestSource(ws, id);
    } finally {
      await lock.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [
        key,
      ]);
      lock.release();
    }
  }
  private async ingestSource(ws: string, id: string) {
    const source = await this.db.one(
      "SELECT * FROM sources WHERE workspace_id=$1 AND id=$2 AND active",
      [ws, id],
    );
    if (!source) return;
    await this.db.pool.query(
      "UPDATE sources SET status='processing',error=null,metadata=metadata-'crawl' WHERE id=$1",
      [id],
    );
    const deadline = Date.now() + 20 * 60_000;
    const report = async (progress: CrawlProgress) => {
      if (Date.now() > deadline)
        throw new Error(
          "Indexing exceeded twenty minutes. Import smaller documentation sections.",
        );
      const updated = await this.db.pool.query(
        "UPDATE sources SET metadata=jsonb_set(metadata,'{crawl}',$1::jsonb) WHERE id=$2 AND revision=$3 AND active",
        [JSON.stringify(progress), id, source.revision],
      );
      if (!updated.rowCount)
        throw new Error("Source changed during import; a new scan is required");
    };
    try {
      let pages: WebPage[], progress: CrawlProgress | undefined;
      if (source.kind === "website" && source.metadata.scope === "site") {
        ({ pages, progress } = await crawlWebsite(
          source.locator,
          this.connections.fetch,
          report,
        ));
        progress.phase = "indexing";
        await report(progress);
      } else {
        const text = (await this.load(source)).replace(/\u0000/g, "").trim();
        if (text.length < 10)
          throw new Error("Source contains no readable text");
        if (text.length > 1500000) throw new Error("Source is too large");
        pages = [{ locator: "", title: source.title, text }];
      }
      const previous = await this.db.rows(
        "SELECT DISTINCT ON (locator) * FROM documents WHERE workspace_id=$1 AND source_id=$2 ORDER BY locator,version DESC",
        [ws, id],
      );
      const prepared: {
        page: WebPage;
        hash: string;
        old: any;
        unchanged: boolean;
        texts: string[];
        vectors: number[][];
      }[] = [];
      for (const page of pages) {
        const hash = digest(page.text);
        const old = previous.find((d) => d.locator === page.locator);
        const unchanged = old?.hash === hash && old?.title === page.title;
        const texts = unchanged ? [] : chunks(page.text),
          vectors: number[][] = [];
        for (let i = 0; i < texts.length; i += 24) {
          if (Date.now() > deadline)
            throw new Error(
              "Indexing exceeded twenty minutes. Import smaller documentation sections.",
            );
          vectors.push(...(await this.model.embed(ws, texts.slice(i, i + 24))));
        }
        if (
          vectors.length !== texts.length ||
          vectors.some(
            (v) => v.length !== 1536 || v.some((n) => !Number.isFinite(n)),
          )
        )
          throw new Error("Embedding response has invalid dimensions");
        prepared.push({ page, hash, old, unchanged, texts, vectors });
        if (progress) {
          progress.indexed++;
          await report(progress);
        }
      }
      await this.db.tx(async (q) => {
        const current = await this.db.one(
          "SELECT revision,active FROM sources WHERE id=$1 FOR UPDATE",
          [id],
          q,
        );
        if (!current?.active || current.revision !== source.revision) return;
        await q.query("UPDATE documents SET active=false WHERE source_id=$1", [
          id,
        ]);
        for (const { page, hash, old, unchanged, texts, vectors } of prepared) {
          if (unchanged) {
            await q.query("UPDATE documents SET active=true WHERE id=$1", [
              old.id,
            ]);
            continue;
          }
          const version = (old?.version ?? 0) + 1,
            documentId = uid();
          await q.query(
            "INSERT INTO documents(id,workspace_id,source_id,version,title,body,hash,slug,locator) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",
            [
              documentId,
              ws,
              id,
              version,
              page.title,
              page.text,
              hash,
              `${page.title
                .toLowerCase()
                .replace(/[^a-z0-9]+/g, "-")
                .slice(
                  0,
                  60,
                )}-${id.slice(0, 8)}${page.locator ? "-" + digest(page.locator).slice(0, 8) : ""}`,
              page.locator,
            ],
          );
          for (let n = 0; n < texts.length; n++)
            await q.query(
              "INSERT INTO chunks(id,workspace_id,document_id,position,body,embedding,embedding_model) VALUES($1,$2,$3,$4,$5,$6::vector,$7)",
              [
                uid(),
                ws,
                documentId,
                n,
                texts[n],
                JSON.stringify(vectors[n]),
                "text-embedding-3-small",
              ],
            );
        }
        await q.query(
          "UPDATE documents SET published=false WHERE source_id=$1 AND NOT active",
          [id],
        );
        if (progress) {
          progress.phase = "complete";
          await q.query(
            "UPDATE sources SET metadata=jsonb_set(metadata,'{crawl}',$1::jsonb) WHERE id=$2",
            [JSON.stringify(progress), id],
          );
        }
        await q.query(
          "UPDATE sources SET status='ready',last_synced=now(),error=null WHERE id=$1",
          [id],
        );
        await this.db.event(q, ws, "knowledge.ready", {
          sourceId: id,
          pages: pages.length,
          chunks: prepared.reduce((n, p) => n + p.texts.length, 0),
        });
      });
    } catch (e) {
      await this.db.tx(async (q) => {
        const failed = await q.query(
          "UPDATE sources SET status='failed',error=$1 WHERE id=$2 AND revision=$3",
          [
            e instanceof Error ? e.message : "Ingestion failed",
            id,
            source.revision,
          ],
        );
        if (!failed.rowCount) return;
        await q.query(
          "UPDATE documents SET active=false,published=false WHERE source_id=$1",
          [id],
        );
        await this.db.event(q, ws, "knowledge.failed", { sourceId: id });
      });
      throw e;
    }
  }
  async retrieve(ws: string, query: string): Promise<Citation[]> {
    const [embedding] = await this.model.embed(ws, [query.slice(0, 6000)]);
    const rows = await this.db.rows(
      `SELECT c.id,c.document_id,d.source_id,d.title,d.version,c.body,
      COALESCE(NULLIF(d.locator,''),CASE WHEN s.kind='website' THEN s.locator END) url,
      (1-(c.embedding<=>$3::vector))+ts_rank_cd(c.search,websearch_to_tsquery('english',$2)) score
      FROM chunks c JOIN documents d ON d.id=c.document_id AND d.workspace_id=c.workspace_id JOIN sources s ON s.id=d.source_id AND s.workspace_id=d.workspace_id
      WHERE c.workspace_id=$1 AND d.active AND s.active AND s.status='ready' AND s.visibility='customer' AND c.embedding_model='text-embedding-3-small'
      ORDER BY score DESC LIMIT 8`,
      [ws, query, JSON.stringify(embedding)],
    );
    return rows.map((r) => ({
      id: r.id,
      documentId: r.document_id,
      sourceId: r.source_id,
      title: r.title,
      version: r.version,
      excerpt: r.body,
      ...(r.url ? { url: r.url } : {}),
    }));
  }
  async validEvidence(
    ws: string,
    evidence: Citation[],
    q?: import("./db.js").Queryable,
  ) {
    if (!evidence.length) return true;
    const rows = await this.db.rows(
      `SELECT c.id FROM chunks c JOIN documents d ON d.id=c.document_id JOIN sources s ON s.id=d.source_id WHERE c.workspace_id=$1 AND c.id=ANY($2::text[]) AND d.active AND s.active AND s.status='ready' AND s.visibility='customer' ${q ? "FOR SHARE OF d,s" : ""}`,
      [ws, evidence.map((e) => e.id)],
      q,
    );
    return rows.length === evidence.length;
  }
}
