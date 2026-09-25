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
import { compareRankedIds, runSearchFtsQuery, type SearchFtsRange } from "@/lib/cloudflare/search-fts";

/**
 * M7.2 local FTS5 operator CLI.
 *
 *   pnpm d1:fts-local --fixture=corpus.json --query="first amendment" --limit=20
 *   pnpm d1:fts-local --fixture=corpus.json --query="amparo" --range=month --json
 *
 * Local and dry-run only: it materializes the projected corpus into an
 * in-memory `node:sqlite` database, runs the parameterized FTS5 query and prints
 * the ranked ids/scores. It never contacts Cloudflare/D1/Supabase, never reads
 * production credentials, never performs a remote read/write and has no
 * `--apply`. Supabase remains the sole search authority.
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
    throw new Error("--apply is not available in M7.2: this CLI is local-only and never mutates a remote database");
  }
  const fixturePath = argValue(args, "fixture");
  if (fixturePath === null) {
    throw new Error("pass --fixture=<path> (local JSON projection fixture); refusing to guess a remote read");
  }
  const query = argValue(args, "query") ?? "constitution";
  const limit = Number(argValue(args, "limit") ?? "50");
  const range = (argValue(args, "range") ?? "latest") as SearchFtsRange;
  const referenceNow = argValue(args, "now") ?? new Date().toISOString();

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

  const input = {
    query,
    limit,
    range,
    source: argValue(args, "source"),
    jurisdiction: argValue(args, "jurisdiction"),
    contentType: argValue(args, "content-type"),
    language: argValue(args, "language"),
    referenceNow,
  };
  const rows = await runSearchFtsQuery({ binding: localBinding(db), input });
  const expect = argValue(args, "expect");
  const parity = expect === null ? null : compareRankedIds(expect.split(","), rows.map((row) => row.article_id));

  if (args.includes("--json")) {
    process.stdout.write(`${JSON.stringify({ query, range, referenceNow, corpus: documents.length, rows, parity }, null, 2)}\n`);
    return;
  }
  console.log("WorldCons D1 FTS local query (local, dry-run)");
  console.log(`  query: ${query}, range: ${range}, limit: ${limit}, corpus: ${documents.length}`);
  for (const row of rows) console.log(`    ${row.article_id}  ${row.relevance_score}`);
  if (parity) console.log(`  parity: ${JSON.stringify(parity)}`);
}

main().catch((error: unknown) => {
  console.error(`d1-fts-local failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
