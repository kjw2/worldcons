import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import {
  buildSearchProjection,
  planSearchProjectionFullRebuild,
  planSearchProjectionIncrementalSync,
  searchProjectionPlanSummary,
  verifySearchProjection,
  type SearchArticleTagRow,
  type SearchBaseArticleRow,
  type SearchProjectionDocument,
  type SearchProjectionDocumentRow,
  type SearchPublicationP3Row,
  type SearchTagRow,
  type SearchVersionP3Row,
} from "@/lib/cloudflare/search-projection";

/**
 * M7.1 local search projection operator CLI.
 *
 *   pnpm d1:search-projection --fixture=fixture.json
 *   pnpm d1:search-projection --fixture=fixture.json --command=plan --plan=full --json
 *   pnpm d1:search-projection --fixture=fixture.json --command=plan --plan=incremental
 *   pnpm d1:search-projection --fixture=fixture.json --command=verify
 *   pnpm d1:search-projection --empty --command=plan
 *
 * Local and dry-run only: it reads a local JSON fixture, builds the projection
 * and prints a parameterized plan or a text-free verification report. It never
 * contacts Cloudflare/D1/Supabase, never loads production credentials and never
 * executes the plan. There is no remote `--apply` in M7.1.
 */
const REPORT_PATH = path.join("artifacts", "cloudflare-m7", "d1-search-projection-report.json");

interface ProjectionFixture {
  publications?: SearchPublicationP3Row[];
  versions?: SearchVersionP3Row[];
  articles?: SearchBaseArticleRow[];
  tags?: SearchTagRow[];
  articleTags?: SearchArticleTagRow[];
  currentDocuments?: SearchProjectionDocument[];
  documentRows?: SearchProjectionDocumentRow[];
  ftsArticleIds?: string[];
}

function argValue(args: readonly string[], name: string): string | null {
  const prefix = `--${name}=`;
  for (const arg of args) if (arg.startsWith(prefix)) return arg.slice(prefix.length);
  return null;
}

function emptyFixture(): ProjectionFixture {
  return { publications: [], versions: [], articles: [], tags: [], articleTags: [] };
}

function loadFixture(args: readonly string[]): ProjectionFixture {
  if (args.includes("--empty")) return emptyFixture();
  const fixture = argValue(args, "fixture");
  if (fixture === null) {
    throw new Error("pass --fixture=<path> (local JSON) or --empty; refusing to guess a remote read");
  }
  const parsed = JSON.parse(fs.readFileSync(fixture, "utf8")) as ProjectionFixture;
  return parsed ?? emptyFixture();
}

function requireCurrentDocuments(fixture: ProjectionFixture): SearchProjectionDocument[] {
  if (!Array.isArray(fixture.currentDocuments)) {
    throw new Error("incremental planning requires currentDocuments[] in the fixture");
  }
  return fixture.currentDocuments;
}

function main(): void {
  const args = process.argv.slice(2);
  if (args.includes("--apply")) {
    throw new Error("--apply is not available in M7.1: remote application is deferred and this CLI is local-only");
  }
  const asJson = args.includes("--json");
  const command = argValue(args, "command") ?? "plan";
  const planKind = argValue(args, "plan") ?? "full";
  const fixture = loadFixture(args);

  const { documents, ftsDocuments, manifest } = buildSearchProjection({
    publications: fixture.publications ?? [],
    versions: fixture.versions ?? [],
    articles: fixture.articles ?? [],
    tags: fixture.tags ?? [],
    articleTags: fixture.articleTags ?? [],
  });

  if (command === "plan") {
    const plan =
      planKind === "incremental"
        ? planSearchProjectionIncrementalSync(requireCurrentDocuments(fixture), documents, ftsDocuments)
        : planSearchProjectionFullRebuild(documents, ftsDocuments);
    const summary = searchProjectionPlanSummary(plan);
    if (asJson) {
      process.stdout.write(`${JSON.stringify({ manifest, plan: summary }, null, 2)}\n`);
    } else if (args.includes("--report")) {
      fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
      fs.writeFileSync(REPORT_PATH, `${JSON.stringify({ manifest, plan: summary }, null, 2)}\n`, "utf8");
      console.log(`wrote ${REPORT_PATH}`);
    } else {
      console.log(`WorldCons D1 search projection plan (local, dry-run)`);
      console.log(`  selected published sources: ${manifest.documentCount}`);
      console.log(`  documents: ${manifest.documentCount}, manifest hash: ${manifest.hash}`);
      console.log(
        `  operation: ${summary.operation}, destructive: ${summary.destructive}, statements: ${summary.statementCount}, params: ${summary.paramCount}, noop: ${summary.noop}`,
      );
      console.log(
        `  changes: added ${summary.changes.added}, changed ${summary.changes.changed}, removed ${summary.changes.removed}, unchanged ${summary.changes.unchanged}`,
      );
      for (const statement of summary.statements) {
        console.log(`    [${statement.paramCount}] ${statement.sql}`);
      }
    }
    return;
  }

  if (command === "verify") {
    const report = verifySearchProjection({
      projected: documents,
      documents: fixture.documentRows,
      ftsArticleIds: fixture.ftsArticleIds,
    });
    if (asJson) {
      process.stdout.write(`${JSON.stringify({ manifest, verification: report }, null, 2)}\n`);
    } else {
      console.log(`WorldCons D1 search projection verification (local, dry-run)`);
      console.log(`  projected: ${report.projectedCount}, documents: ${report.documentCount}, fts: ${report.ftsCount}`);
      console.log(`  ok: ${report.ok}, hash: ${report.hash}`);
      for (const entry of report.issues) {
        console.log(`    ${entry.code} ${entry.articleId ?? "-"}`);
      }
    }
    return;
  }

  throw new Error(`unknown --command=${command} (expected plan or verify)`);
}

try {
  main();
} catch (error) {
  console.error(`d1-search-projection failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
