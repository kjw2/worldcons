import { createD1ArticleReadRepository } from "@/lib/article-reads/d1-repository";
import type { SitemapArticleEntry } from "@/lib/article-reads/types";
import {
  setRuntimeD1Binding,
  type D1RuntimeDatabase,
  type D1RuntimePreparedStatement,
  type D1RuntimeResult,
} from "@/lib/cloudflare/d1/runtime-binding";

const BASE_URL = "https://worldcons.test";

interface LocalD1PreparedStatement {
  bind(...values: unknown[]): LocalD1PreparedStatement;
  all<T = Record<string, unknown>>(): Promise<D1RuntimeResult<T>>;
  run(): Promise<D1RuntimeResult>;
}

interface LocalD1Database {
  prepare(sql: string): LocalD1PreparedStatement;
  exec(sql: string): Promise<unknown>;
}

interface Env {
  WORLDCONS_CORE: LocalD1Database;
}

interface ReadStats {
  statements: number;
  rowsRead: number;
  rowsReadAvailable: boolean;
}

function instrumentD1(binding: LocalD1Database): { database: D1RuntimeDatabase; stats: ReadStats } {
  const stats: ReadStats = { statements: 0, rowsRead: 0, rowsReadAvailable: true };

  function record(result: D1RuntimeResult<unknown>) {
    const rowsRead = result.meta?.rows_read;
    if (typeof rowsRead === "number") stats.rowsRead += rowsRead;
    else stats.rowsReadAvailable = false;
  }

  function wrap(sql: string, statement: LocalD1PreparedStatement): D1RuntimePreparedStatement {
    return {
      bind(...values: unknown[]) {
        return wrap(sql, statement.bind(...values));
      },
      async all<T = Record<string, unknown>>() {
        stats.statements += 1;
        const result = await statement.all<T>();
        record(result as D1RuntimeResult<unknown>);
        return result;
      },
      async run() {
        stats.statements += 1;
        const runner = statement.run?.bind(statement);
        if (!runner) return { success: true };
        const result = await runner();
        record(result as D1RuntimeResult<unknown>);
        return result;
      },
    };
  }

  return {
    database: {
      prepare(sql: string) {
        return wrap(sql, binding.prepare(sql));
      },
    },
    stats,
  };
}

function xmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function sortedEntries(entries: readonly SitemapArticleEntry[]): SitemapArticleEntry[] {
  return [...entries].sort((left, right) => left.slug.localeCompare(right.slug));
}

function normalizedLines(entries: readonly SitemapArticleEntry[]): string[] {
  return entries.map((entry) => `${BASE_URL}/articles/${entry.slug}\t${entry.lastModified ?? ""}`);
}

async function sha256Hex(value: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function toXml(entries: readonly SitemapArticleEntry[]): string {
  const body = entries
    .map((entry) => {
      const lastmod = entry.lastModified ? `<lastmod>${xmlEscape(entry.lastModified)}</lastmod>` : "";
      return `<url><loc>${xmlEscape(`${BASE_URL}/articles/${entry.slug}`)}</loc>${lastmod}</url>`;
    })
    .join("");
  return `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${body}</urlset>`;
}

function flagValue(value: string | null): boolean {
  return value === "true" || value === "1";
}

async function seed(request: Request, env: Env): Promise<Response> {
  const sql = await request.text();
  if (!sql.trim()) return Response.json({ ok: false, error: "empty_seed" }, { status: 400 });
  const statements = sql
    .split(/;\s*(?:\r?\n|$)/)
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
  for (const statement of statements) await env.WORLDCONS_CORE.prepare(statement).run();
  return Response.json({ ok: true });
}

async function sitemap(url: URL, env: Env): Promise<Response> {
  const fastSitemap = flagValue(url.searchParams.get("fastSitemap"));
  const jsonGuard = flagValue(url.searchParams.get("jsonGuard"));
  if (jsonGuard) process.env.WORLDCONS_JSON_GUARD_BATCHING_ENABLED = "true";
  else delete process.env.WORLDCONS_JSON_GUARD_BATCHING_ENABLED;
  process.env.WORLDCONS_FAST_SITEMAP_ENABLED = fastSitemap ? "true" : "false";

  const { database, stats } = instrumentD1(env.WORLDCONS_CORE);
  setRuntimeD1Binding("worldcons_core", database);
  const startedAt = Date.now();
  const repository = createD1ArticleReadRepository({
    binding: database,
    fastSitemap,
    maxRows: 10_000,
  });

  try {
    const entries = sortedEntries(await repository.listPublicSitemapArticles());
    const xml = toXml(entries);
    const normalizedHash = await sha256Hex(normalizedLines(entries).join("\n"));
    return new Response(xml, {
      status: 200,
      headers: {
        "content-type": "application/xml; charset=utf-8",
        "x-worldcons-entry-count": String(entries.length),
        "x-worldcons-normalized-sha256": normalizedHash,
        "x-worldcons-statements": String(stats.statements),
        "x-worldcons-rows-read": String(stats.rowsRead),
        "x-worldcons-rows-read-available": String(stats.rowsReadAvailable),
        "x-worldcons-elapsed-ms": String(Date.now() - startedAt),
        "x-worldcons-fast-sitemap": String(fastSitemap),
        "x-worldcons-json-guard": String(jsonGuard),
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 200) : "unknown_error";
    return Response.json(
      { ok: false, error: message },
      {
        status: 500,
        headers: {
          "x-worldcons-statements": String(stats.statements),
          "x-worldcons-rows-read": String(stats.rowsRead),
          "x-worldcons-rows-read-available": String(stats.rowsReadAvailable),
          "x-worldcons-elapsed-ms": String(Date.now() - startedAt),
          "x-worldcons-fast-sitemap": String(fastSitemap),
          "x-worldcons-json-guard": String(jsonGuard),
        },
      },
    );
  }
}

const worker = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/__seed") return seed(request, env);
    if (request.method === "GET" && url.pathname === "/sitemap") return sitemap(url, env);
    if (request.method === "GET" && url.pathname === "/health") {
      return Response.json({ ok: Boolean(env.WORLDCONS_CORE) });
    }
    return new Response("not found", { status: 404 });
  },
};

export default worker;

