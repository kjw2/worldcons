import fs from "node:fs";
import process from "node:process";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { normalizeEmbeddingVector } from "@/lib/ai/embedding-vector";
import { emitDatabaseDdl } from "@/lib/cloudflare/d1/ddl";
import { d1Schema } from "@/lib/cloudflare/d1/schema";
import type { D1RuntimeDatabase, D1RuntimePreparedStatement } from "@/lib/cloudflare/d1/runtime-binding";
import {
  buildSearchProjection,
  planSearchProjectionFullRebuild,
  type SearchProjectionGate2Eligibility,
  type SearchPublicationP3Row,
  type SearchVersionP3Row,
} from "@/lib/cloudflare/search-projection";
import {
  buildVectorProjection,
  runVectorRankedSearchPage,
  type ArticleEmbeddingArtifactRow,
  type VectorizeIndexBinding,
  type VectorizeProjectionRecord,
  type VectorizeQueryOptions,
  type VectorizeQueryResult,
} from "@/lib/cloudflare/search-vector";
import type { RankedSearchPageInput } from "@/lib/cloudflare/search-ranked";

/**
 * M7.4 local hybrid/semantic operator CLI (fake in-memory vectors only).
 *
 *   pnpm d1:hybrid-local --fixture=corpus.json --query=constitution --limit=5
 *   pnpm d1:hybrid-local --fixture=corpus.json --query=constitution --mode=semantic --embedding-seed=3 --json
 *
 * Local and dry-run only: it materializes the D1 search projection into an
 * in-memory `node:sqlite` database, builds an in-memory fake Vectorize index from
 * the fixture's provenance-locked artifacts and runs the local orchestrator. It
 * never contacts Cloudflare/Vectorize/D1/Supabase, never reads production
 * credentials and has no `--apply`. The query embedding is a deterministic local
 * fake, not a Gemini call.
 */
interface VectorFixture {
  publications?: SearchPublicationP3Row[];
  versions?: SearchVersionP3Row[];
  artifacts?: ArticleEmbeddingArtifactRow[];
  gate2Eligibility?: SearchProjectionGate2Eligibility;
}

function argValue(args: readonly string[], name: string): string | null {
  const prefix = `--${name}=`;
  for (const arg of args) if (arg.startsWith(prefix)) return arg.slice(prefix.length);
  return null;
}

function seedVector(seed: number): number[] {
  let state = (Math.imul(seed, 0x9e3779b1) + 0x7f4a7c15) >>> 0;
  const raw: number[] = [];
  for (let index = 0; index < 1536; index += 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    raw.push(state / 4294967296 - 0.5);
  }
  return normalizeEmbeddingVector(raw, 1536);
}

function dot(left: readonly number[], right: readonly number[]): number {
  let sum = 0;
  for (let index = 0; index < left.length; index += 1) sum += left[index] * right[index];
  return sum;
}

function fakeVectorize(records: readonly VectorizeProjectionRecord[]): VectorizeIndexBinding {
  return {
    async query(vector: readonly number[], options: VectorizeQueryOptions): Promise<VectorizeQueryResult> {
      const filter = options.filter ?? null;
      const matches = records
        .filter((record) => {
          if (!filter) return true;
          const metadata = record.metadata as unknown as Record<string, unknown>;
          return Object.entries(filter).every(([key, condition]) => {
            const value = metadata[key];
            if (condition !== null && typeof condition === "object") {
              const gte = (condition as { $gte?: number }).$gte;
              return gte === undefined || (typeof value === "number" && value >= gte);
            }
            return value === condition;
          });
        })
        .map((record) => ({ id: record.id, score: dot(vector, record.values), metadata: record.metadata as unknown as Record<string, unknown> }))
        .sort((left, right) => (right.score !== left.score ? right.score - left.score : left.id < right.id ? -1 : 1));
      return { matches: matches.slice(0, options.topK), count: matches.length };
    },
  };
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
    throw new Error("--apply is not available in M7.4: this CLI is local-only and never mutates a remote database or index");
  }
  const fixturePath = argValue(args, "fixture");
  if (fixturePath === null) throw new Error("pass --fixture=<path> (local JSON projection fixture)");
  const fixture = JSON.parse(fs.readFileSync(fixturePath, "utf8")) as VectorFixture;

  const built = buildSearchProjection({
    publications: fixture.publications ?? [],
    versions: fixture.versions ?? [],
    gate2Eligibility: fixture.gate2Eligibility,
  });
  const db = new DatabaseSync(":memory:");
  db.exec(emitDatabaseDdl("worldcons_search", d1Schema));
  for (const statement of planSearchProjectionFullRebuild(built.documents, built.ftsDocuments).statements) {
    db.prepare(statement.sql).run(...(statement.params as SQLInputValue[]));
  }

  const projection = buildVectorProjection({
    publications: fixture.publications ?? [],
    versions: fixture.versions ?? [],
    artifacts: fixture.artifacts ?? [],
    gate2Eligibility: fixture.gate2Eligibility,
  });

  const limitArg = argValue(args, "limit");
  const offsetArg = argValue(args, "offset");
  const seedArg = argValue(args, "embedding-seed");
  const embedding = seedVector(seedArg === null ? 1 : Number(seedArg));
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
    embedding,
    referenceNow: argValue(args, "now") ?? new Date().toISOString(),
  };

  const page = await runVectorRankedSearchPage({ d1: localBinding(db), vector: fakeVectorize(projection.records), input });

  if (args.includes("--json")) {
    process.stdout.write(`${JSON.stringify({ input: { ...input, embedding: "<1536-d fake>" }, vectorRecords: projection.records.length, page }, null, 2)}\n`);
    return;
  }
  console.log("WorldCons D1 vector-ranked search (local, dry-run, fake vectors)");
  console.log(`  retrievalMode: ${page.retrievalMode}, total: ${page.total}, hasMore: ${page.hasMore}, totalIsExact: ${page.totalIsExact}`);
  for (const entry of page.entries) {
    console.log(`    ${entry.id}${entry.score === undefined ? "" : `  score=${entry.score}`}${entry.lexicalRank === undefined ? "" : ` lex=${entry.lexicalRank}`}${entry.semanticRank === undefined ? "" : ` sem=${entry.semanticRank}`}`);
  }
}

main().catch((error: unknown) => {
  console.error(`d1-hybrid-local failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
