import fs from "node:fs";
import process from "node:process";
import type { SearchPublicationP3Row, SearchVersionP3Row } from "@/lib/cloudflare/search-projection";
import {
  buildVectorProjection,
  planVectorFullProjection,
  planVectorIncrementalSync,
  vectorMutationPlanSummary,
  type ArticleEmbeddingArtifactRow,
  type VectorizeProjectionRecord,
} from "@/lib/cloudflare/search-vector";

/**
 * M7.4 local Vectorize projection/mutation-plan operator CLI.
 *
 *   pnpm d1:vector-local --fixture=corpus.json
 *   pnpm d1:vector-local --fixture=next.json --current=current.json --json
 *
 * Local and dry-run only: it builds the provenance-locked Vectorize projection
 * and a mutation PLAN from local JSON fixtures. It never contacts
 * Cloudflare/Vectorize/D1/Supabase, never reads production credentials, never
 * creates an index or metadata index and has no `--apply`. The safe summary
 * prints ids/counts/provenance only, never vector values.
 */
interface VectorFixture {
  publications?: SearchPublicationP3Row[];
  versions?: SearchVersionP3Row[];
  artifacts?: ArticleEmbeddingArtifactRow[];
}

function argValue(args: readonly string[], name: string): string | null {
  const prefix = `--${name}=`;
  for (const arg of args) if (arg.startsWith(prefix)) return arg.slice(prefix.length);
  return null;
}

function readFixture(filePath: string): VectorFixture {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as VectorFixture;
}

function projectionFor(fixture: VectorFixture) {
  return buildVectorProjection({
    publications: fixture.publications ?? [],
    versions: fixture.versions ?? [],
    artifacts: fixture.artifacts ?? [],
  });
}

function main(): void {
  const args = process.argv.slice(2);
  if (args.includes("--apply")) {
    throw new Error("--apply is not available in M7.4: this CLI is local-only and never mutates a remote Vectorize index");
  }
  const fixturePath = argValue(args, "fixture");
  if (fixturePath === null) throw new Error("pass --fixture=<path> (local JSON projection fixture)");

  const built = projectionFor(readFixture(fixturePath));
  const currentPath = argValue(args, "current");
  const current: VectorizeProjectionRecord[] | null = currentPath === null ? null : projectionFor(readFixture(currentPath)).records;
  const plan = current === null ? planVectorFullProjection(built.records) : planVectorIncrementalSync(current, built.records);
  const summary = vectorMutationPlanSummary(plan);

  const output = {
    manifest: built.manifest,
    omissions: built.omissions,
    plan: summary,
  };

  if (args.includes("--json")) {
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    return;
  }
  console.log("WorldCons Vectorize projection (local, dry-run)");
  console.log(`  records: ${built.manifest.recordCount}, missing: ${built.manifest.missingCount}, stale: ${built.manifest.staleCount}`);
  console.log(`  plan: ${summary.operation}, upserts: ${summary.upsertCount}, deletes: ${summary.deleteCount}, destructive: ${summary.destructive}`);
  for (const omission of built.omissions) console.log(`    omitted ${omission.articleId} (${omission.reason})`);
  for (const upsert of summary.upserts) console.log(`    upsert ${upsert.id} v=${upsert.articleVersionId} ${upsert.model}`);
  for (const id of summary.deletes) console.log(`    delete ${id}`);
}

try {
  main();
} catch (error: unknown) {
  console.error(`d1-vector-local failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
