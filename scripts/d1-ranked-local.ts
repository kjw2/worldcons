import fs from "node:fs";
import process from "node:process";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { emitDatabaseDdl } from "@/lib/cloudflare/d1/ddl";
import { d1Schema } from "@/lib/cloudflare/d1/schema";
import type { D1RuntimeDatabase, D1RuntimePreparedStatement } from "@/lib/cloudflare/d1/runtime-binding";
import {
  buildSearchProjection,
  planSearchProjectionFullRebuild,
  type SearchArticleTagRow,
  type SearchBaseArticleRow,
  type SearchPublicationP3Row,
  type SearchTagRow,
  type SearchVersionP3Row,
} from "@/lib/cloudflare/search-projection";
import { runRankedSearchPage, type RankedSearchPageInput } from "@/lib/cloudflare/search-ranked";

/**
 * M7.3 local ranked-search operator CLI.
 *
 *   pnpm d1:ranked-local --fixture=corpus.json --query="1 BvR 2656/18" --count=exact
 *   pnpm d1:ranked-local --fixture=corpus.json --query= --limit=20 --tag=due-process --json
 *
 * Local and dry-run only: it materializes the projected corpus into an in-memory
 * `node:sqlite` database and runs the parameterized exact/latest/fulltext page.
 * It never contacts Cloudflare/D1/Supabase, never reads production credentials,
 * never performs a remote read/write and has no `--apply`. Semantic/hybrid are
 * deferred and fail closed. Supabase remains the sole search authority.
 */
interface CorpusFixture {
  publications?: SearchPublicationP3Row[];
  versions?: SearchVersionP3Row[];
  articles?: SearchBaseArticleRow[];
  tags?: SearchTagRow[];
  articleTags?: SearchArticleTagRow[];
}

function argValue(args: readonly string[], name: string): string | null {
  const prefix = `--${name}=`;
  for (const arg of args) if (arg.startsWith(prefix)) return arg.slice(prefix.length);
  return null;
}

function localBinding(db: DatabaseSync): D1RuntimeDatabase {
  return {
    prepare(sql: string): D1RuntimePreparedStatement {
      const statement = db.prepare(sql);
      let bound: SQLInputValue[] = [];
      const chain: D1RuntimePreparedStatement = {
        bind(...values: unknown[]) {
          bound = values as SQLInputValue[];
          return chain;
        },
        async all<T = Record<string, unknown>>() {
          try {
            return { success: true, results: statement.all(...bound) as unknown as T[] };
          } catch (error) {
            return { success: false, error: error instanceof Error ? error.message : String(error) };
          }
        },
      };
      return chain;
    },
  };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--apply")) {
    throw new Error("--apply is not available in M7.3: this CLI is local-only and never mutates a remote database");
  }
  const fixturePath = argValue(args, "fixture");
  if (fixturePath === null) {
    throw new Error("pass --fixture=<path> (local JSON projection fixture); refusing to guess a remote read");
  }

  const fixture = JSON.parse(fs.readFileSync(fixturePath, "utf8")) as CorpusFixture;
  const { documents, ftsDocuments } = buildSearchProjection({
    publications: fixture.publications ?? [],
    versions: fixture.versions ?? [],
    articles: fixture.articles ?? [],
    tags: fixture.tags ?? [],
    articleTags: fixture.articleTags ?? [],
  });

  const db = new DatabaseSync(":memory:");
  db.exec(emitDatabaseDdl("worldcons_search", d1Schema));
  for (const statement of planSearchProjectionFullRebuild(documents, ftsDocuments).statements) {
    db.prepare(statement.sql).run(...(statement.params as SQLInputValue[]));
  }

  const limitArg = argValue(args, "limit");
  const offsetArg = argValue(args, "offset");
  const input: RankedSearchPageInput = {
    query: argValue(args, "query") ?? "",
    mode: argValue(args, "mode"),
    limit: limitArg === null ? null : Number(limitArg),
    offset: offsetArg === null ? null : Number(offsetArg),
    source: argValue(args, "source"),
    jurisdiction: argValue(args, "jurisdiction"),
    contentType: argValue(args, "content-type"),
    language: argValue(args, "language"),
    tag: argValue(args, "tag"),
    range: argValue(args, "range"),
    count: argValue(args, "count"),
    referenceNow: argValue(args, "now") ?? new Date().toISOString(),
  };
  const page = await runRankedSearchPage({ binding: localBinding(db), input });

  if (args.includes("--json")) {
    process.stdout.write(`${JSON.stringify({ input, corpus: documents.length, page }, null, 2)}\n`);
    return;
  }
  console.log("WorldCons D1 ranked-search page (local, dry-run)");
  console.log(`  retrievalMode: ${page.retrievalMode}, total: ${page.total}, hasMore: ${page.hasMore}, totalIsExact: ${page.totalIsExact}`);
  for (const entry of page.entries) console.log(`    ${entry.id}${entry.score === undefined ? "" : `  ${entry.score}`}`);
}

main().catch((error: unknown) => {
  console.error(`d1-ranked-local failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});