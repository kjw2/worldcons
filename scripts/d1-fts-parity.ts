import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { emitDatabaseDdl } from "@/lib/cloudflare/d1/ddl";
import { d1Schema } from "@/lib/cloudflare/d1/schema";
import type { D1RuntimeDatabase, D1RuntimePreparedStatement } from "@/lib/cloudflare/d1/runtime-binding";
import {
  createSupabaseLinkedQueryRunner,
  parseSupabaseLinkedRows,
  type SupabaseLinkedQueryRunner,
} from "@/lib/cloudflare/d1/convert/supabase-linked-source";
import { renderSqlLiteral } from "@/lib/cloudflare/d1/import/literal";
import {
  buildSearchProjection,
  planSearchProjectionFullRebuild,
  type SearchBaseArticleRow,
  type SearchPublicationP3Row,
  type SearchVersionP3Row,
} from "@/lib/cloudflare/search-projection";
import { compareRankedIds, runSearchFtsQuery, type SearchFtsRange } from "@/lib/cloudflare/search-fts";
import { runRankedSearchPage } from "@/lib/cloudflare/search-ranked";
import {
  buildFtsParityReport,
  evaluateRankPolicyCase,
  rankCorpusHash,
  renderFtsParityMarkdown,
  resolveFrozenStrictTarget,
  selectRepresentativeCorpus,
  summarizeRankPolicy,
  type FtsParityReport,
  type FtsParitySourceScopeSummary,
  type RankPolicyCaseInput,
  type RankPolicyThresholds,
} from "@/lib/cloudflare/search-rank-policy";
import {
  PRODUCTION_PROJECTION_CEILING,
  assertFullProjectionScope,
  assertProductionScopeLargeEnough,
  evaluateFtsProjectionScope,
  readFtsSourcePager,
  readProductionProjectionIds,
  restrictToProductionIds,
} from "./d1-fts-source-pager";

/**
 * M7.7-B read-only D1 FTS5 vs production Postgres fulltext parity harness.
 *
 *   pnpm d1:fts-parity --dry-run
 *   pnpm d1:fts-parity --report
 *   pnpm d1:fts-parity --source=fixture --fixture=corpus.json --json
 *   pnpm d1:fts-parity --report --min-overlap-at-k=0.5
 *
 * It reads the FULL published source authority through the dedicated read-only
 * FTS source pager (`./d1-fts-source-pager`, no embeddings, stable `article_id`
 * cursor), restricts it to the full `public_article_projection_p3` id set,
 * materializes the same rows into an in-memory `node:sqlite` database through
 * the M7.1/M7.2 D1 projection + FTS5 path, queries the production
 * `public_fulltext_ranked_ids_v1` RPC read-only over that like-for-like id
 * window, and reduces the frozen representative corpus into the M7.7-B rank
 * policy state. Rank evaluation fails closed unless the local projected
 * article-id set exactly equals the production projection id set. It never
 * mutates Supabase, never writes to D1/Vectorize and has no `--apply`.
 *
 * The generic lexical categories stay `insufficient_evidence` unless an
 * operator deliberately passes an independently chosen threshold; M7.7-B
 * supplies none.
 */
const REPORT_DIR = path.join("artifacts", "cloudflare-m7");
const REPORT_JSON = "m7.7-fts-parity-report.json";
const REPORT_MD = "m7.7-fts-parity-report.md";
/** The production fulltext RPC oracle window before like-for-like filtering. */
const ORACLE_WINDOW = 100;

interface FixtureSource {
  publications?: SearchPublicationP3Row[];
  versions?: SearchVersionP3Row[];
  articles?: SearchBaseArticleRow[];
}

function argValue(args: readonly string[], name: string): string | null {
  const prefix = `--${name}=`;
  for (const arg of args) if (arg.startsWith(prefix)) return arg.slice(prefix.length);
  return null;
}

function positiveIntegerArg(args: readonly string[], name: string): number | null {
  const raw = argValue(args, name);
  if (raw === null) return null;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`--${name} must be a positive integer`);
  return value;
}

function unitIntervalArg(args: readonly string[], name: string): number | undefined {
  const raw = argValue(args, name);
  if (raw === null) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`--${name} must be a number between 0 and 1`);
  }
  return value;
}

function thresholdsArg(args: readonly string[]): RankPolicyThresholds | null {
  const thresholds: RankPolicyThresholds = {};
  const overlap = unitIntervalArg(args, "min-overlap-at-k");
  if (overlap !== undefined) thresholds.minOverlapAtKMacro = overlap;
  const prefix = unitIntervalArg(args, "min-prefix-macro");
  if (prefix !== undefined) thresholds.minPrefixMatchMacro = prefix;
  const exactOrder = unitIntervalArg(args, "min-exact-order-macro");
  if (exactOrder !== undefined) thresholds.minExactOrderMacro = exactOrder;
  const sameSet = unitIntervalArg(args, "min-same-set-macro");
  if (sameSet !== undefined) thresholds.minSameSetMacro = sameSet;
  return Object.keys(thresholds).length === 0 ? null : thresholds;
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

/** Builds one read-only `public_fulltext_ranked_ids_v1` oracle call. */
function buildOracleSql(input: {
  query: string;
  limit: number;
  source: string | null;
  jurisdiction: string | null;
  contentType: string | null;
  language: string | null;
  range: SearchFtsRange;
}): string {
  const args: string[] = [
    `p_query => ${renderSqlLiteral(input.query)}`,
    `p_limit => ${renderSqlLiteral(input.limit)}`,
  ];
  if (input.source !== null) args.push(`p_source => ${renderSqlLiteral(input.source)}`);
  if (input.jurisdiction !== null) args.push(`p_jurisdiction => ${renderSqlLiteral(input.jurisdiction)}`);
  if (input.contentType !== null) args.push(`p_content_type => ${renderSqlLiteral(input.contentType)}`);
  if (input.language !== null) args.push(`p_language => ${renderSqlLiteral(input.language)}`);
  args.push(`p_range => ${renderSqlLiteral(input.range)}`);
  return `select article_id, relevance_score from public_fulltext_ranked_ids_v1(${args.join(", ")})`;
}

interface OracleRead {
  ids: string[];
  compared: boolean;
}

async function readOracle(
  query: SupabaseLinkedQueryRunner,
  input: Parameters<typeof buildOracleSql>[0],
  allowedIds: ReadonlySet<string>,
): Promise<OracleRead> {
  const rows = parseSupabaseLinkedRows(await query(buildOracleSql({ ...input, limit: ORACLE_WINDOW })));
  const ids: string[] = [];
  for (const row of rows) {
    const id = row.article_id;
    if (typeof id !== "string" || id.length === 0) continue;
    if (!allowedIds.has(id)) continue;
    ids.push(id);
    if (ids.length >= input.limit) break;
  }
  return { ids, compared: true };
}

/**
 * Exact-case is a distinct M7.3 branch, not an FTS5 ranking case. Query the
 * production ranked-page authority so exact-case detection takes precedence
 * over the requested fulltext mode, matching the local ranked reader.
 */
function buildExactCaseOracleSql(input: Parameters<typeof buildOracleSql>[0]): string {
  const args: string[] = [
    `p_query => ${renderSqlLiteral(input.query)}`,
    `p_mode => 'fulltext'`,
    `p_limit => ${renderSqlLiteral(input.limit)}`,
    `p_offset => 0`,
    `p_range => ${renderSqlLiteral(input.range)}`,
    `p_count => 'none'`,
  ];
  if (input.source !== null) args.push(`p_source => ${renderSqlLiteral(input.source)}`);
  if (input.jurisdiction !== null) args.push(`p_jurisdiction => ${renderSqlLiteral(input.jurisdiction)}`);
  if (input.contentType !== null) args.push(`p_content_type => ${renderSqlLiteral(input.contentType)}`);
  if (input.language !== null) args.push(`p_language => ${renderSqlLiteral(input.language)}`);
  return `select public.worldcons_ranked_search_page_v1(${args.join(", ")}) as page`;
}

async function readExactCaseOracle(
  query: SupabaseLinkedQueryRunner,
  input: Parameters<typeof buildOracleSql>[0],
  allowedIds: ReadonlySet<string>,
): Promise<OracleRead> {
  const rows = parseSupabaseLinkedRows(await query(buildExactCaseOracleSql(input)));
  const page = rows[0]?.page;
  if (typeof page !== "object" || page === null || Array.isArray(page)) {
    throw new Error("exact-case oracle RPC did not return a page object");
  }
  const record = page as Record<string, unknown>;
  if (record.retrievalMode !== "exact-case") {
    throw new Error("exact-case oracle did not select the exact-case branch");
  }
  const entries = Array.isArray(record.entries) ? record.entries : [];
  const ids: string[] = [];
  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
    const id = (entry as Record<string, unknown>).id;
    if (typeof id !== "string" || id.length === 0 || !allowedIds.has(id)) continue;
    ids.push(id);
    if (ids.length >= input.limit) break;
  }
  return { ids, compared: true };
}

function printDryRun(corpusHash: string, cases: ReturnType<typeof selectRepresentativeCorpus>): void {
  console.log("WorldCons M7.7-B FTS parity (dry-run, read-only)");
  console.log(`  corpusHash: ${corpusHash}`);
  console.log(`  corpusCases: ${cases.length}`);
  const byCategory = new Map<string, number>();
  for (const caseDef of cases) byCategory.set(caseDef.category, (byCategory.get(caseDef.category) ?? 0) + 1);
  for (const [category, count] of byCategory) console.log(`    ${category}: ${count}`);
  console.log("  dry-run: no Supabase query executed, no artifact written");
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--apply")) {
    throw new Error("--apply is not available: the M7.7-B FTS parity harness is read-only by construction");
  }
  const dryRun = args.includes("--dry-run");
  const asJson = args.includes("--json");
  const writeReport = args.includes("--report");
  const skipOracle = args.includes("--skip-oracle");
  const source = (argValue(args, "source") ?? "supabase") as "supabase" | "fixture";
  const requestedMaxArticles = positiveIntegerArg(args, "max-articles");
  const referenceNow = argValue(args, "now") ?? new Date().toISOString();
  const thresholds = thresholdsArg(args);

  const corpus = selectRepresentativeCorpus();
  if (dryRun) {
    printDryRun(rankCorpusHash(corpus), corpus);
    return;
  }

  // --- Source rows ---------------------------------------------------------
  let publications: SearchPublicationP3Row[];
  let versions: SearchVersionP3Row[];
  let articles: SearchBaseArticleRow[];
  let runner: SupabaseLinkedQueryRunner | null = null;
  let allowedIds: ReadonlySet<string> | null = null;
  let productionProjectionIds: number | null = null;
  let sourceScope: FtsParitySourceScopeSummary | null = null;
  let sourceRowsFetched = 0;
  let maxArticles = requestedMaxArticles ?? 100;

  if (source === "fixture") {
    const fixturePath = argValue(args, "fixture");
    if (fixturePath === null) throw new Error("--source=fixture requires --fixture=<path>");
    const fixture = JSON.parse(fs.readFileSync(fixturePath, "utf8")) as FixtureSource;
    publications = fixture.publications ?? [];
    versions = fixture.versions ?? [];
    articles = fixture.articles ?? [];
  } else if (source === "supabase") {
    // Full like-for-like production scope: read the whole projection id set
    // first, then page ALL published authority rows (read-only, no embeddings)
    // and restrict them to exactly those ids.
    runner = createSupabaseLinkedQueryRunner();
    const productionIds = await readProductionProjectionIds(runner, PRODUCTION_PROJECTION_CEILING);
    assertProductionScopeLargeEnough(productionIds.size, requestedMaxArticles ?? productionIds.size);
    maxArticles = requestedMaxArticles ?? productionIds.size;
    allowedIds = productionIds;
    productionProjectionIds = productionIds.size;
    const paged = await readFtsSourcePager(runner);
    sourceRowsFetched = paged.sourceRowsFetched;
    const restricted = restrictToProductionIds(paged.published, productionIds);
    publications = restricted.publications;
    versions = restricted.versions;
    articles = restricted.articles;
  } else {
    throw new Error("--source must be supabase or fixture");
  }

  const built = buildSearchProjection({ publications, versions, articles });

  // Fail closed BEFORE any rank evaluation unless the local projected article-id
  // set is exactly the production projection id set.
  if (source === "supabase" && allowedIds !== null) {
    const localArticleIds = new Set(built.documents.map((document) => document.article_id));
    sourceScope = evaluateFtsProjectionScope({
      productionProjectionIds: allowedIds,
      localArticleIds,
      sourceRowsFetched,
    });
    assertFullProjectionScope(sourceScope);
  }

  // --- Local D1 FTS5 corpus ------------------------------------------------
  const db = new DatabaseSync(":memory:");
  db.exec(emitDatabaseDdl("worldcons_search", d1Schema));
  for (const statement of planSearchProjectionFullRebuild(built.documents, built.ftsDocuments).statements) {
    db.prepare(statement.sql).run(...(statement.params as SQLInputValue[]));
  }
  const binding = localBinding(db);

  // --- Evaluate the frozen corpus -----------------------------------------
  const caseInputs: RankPolicyCaseInput[] = [];
  const errors: string[] = [];
  const oracleAvailable = source === "supabase" && !skipOracle;

  for (const caseDef of corpus) {
    let observedIds: string[] = [];
    let localError = false;
    try {
      if (caseDef.invariant === "exact-case") {
        const page = await runRankedSearchPage({
          binding,
          input: {
            query: caseDef.query,
            mode: "fulltext",
            limit: caseDef.limit,
            offset: 0,
            source: caseDef.filters.source,
            jurisdiction: caseDef.filters.jurisdiction,
            contentType: caseDef.filters.contentType,
            language: caseDef.filters.language,
            range: caseDef.filters.range,
            count: "none",
            referenceNow,
          },
        });
        if (page.retrievalMode !== "exact-case") throw new Error("local ranked reader did not select exact-case");
        observedIds = page.entries.map((entry) => entry.id);
      } else {
        const rows = await runSearchFtsQuery({
          binding,
          input: {
            query: caseDef.query,
            limit: caseDef.limit,
            range: caseDef.filters.range,
            source: caseDef.filters.source,
            jurisdiction: caseDef.filters.jurisdiction,
            contentType: caseDef.filters.contentType,
            language: caseDef.filters.language,
            referenceNow,
          },
        });
        observedIds = rows.map((row) => row.article_id);
      }
    } catch {
      localError = true;
    }

    let oracleIds: string[] = [];
    let oracleCompared = false;
    let oracleError = false;
    if (oracleAvailable && runner !== null && allowedIds !== null && !localError) {
      try {
        const read = await (caseDef.invariant === "exact-case" ? readExactCaseOracle : readOracle)(
          runner,
          {
            query: caseDef.query,
            limit: caseDef.limit,
            source: caseDef.filters.source,
            jurisdiction: caseDef.filters.jurisdiction,
            contentType: caseDef.filters.contentType,
            language: caseDef.filters.language,
            range: caseDef.filters.range,
          },
          allowedIds,
        );
        oracleIds = read.ids;
        oracleCompared = read.compared;
      } catch {
        oracleError = true;
      }
    }

    const target =
      caseDef.invariant === "informational"
        ? null
        : resolveFrozenStrictTarget(caseDef, {
            documents: built.documents,
            ftsDocuments: built.ftsDocuments,
          });
    const errored = localError || oracleError;
    if (errored) errors.push(caseDef.id);
    const metrics =
      caseDef.invariant !== "exact-case" && oracleCompared && oracleIds.length > 0
        ? compareRankedIds(oracleIds, observedIds, { k: caseDef.k })
        : null;

    caseInputs.push({
      case: caseDef,
      observedIds,
      oracleIds,
      oracleCompared: errored ? false : oracleCompared,
      metrics: errored ? null : metrics,
      // An errored strict case must never be a silent pass: mark it unresolved.
      target: errored ? null : target,
    });
  }

  const policy = summarizeRankPolicy({
    corpusHash: rankCorpusHash(corpus),
    cases: corpus,
    outcomes: caseInputs.map((caseInput) => evaluateRankPolicyCase(caseInput)),
    thresholds,
  });

  const report: FtsParityReport = buildFtsParityReport({
    generatedAt: new Date().toISOString(),
    source,
    maxArticles,
    truncated: false,
    projection: {
      sourceRows: built.documents.length,
      documents: built.documents.length,
      productionProjectionIds,
    },
    sourceScope,
    oracleAvailable,
    errors,
    policy,
  });

  if (writeReport) {
    fs.mkdirSync(REPORT_DIR, { recursive: true });
    fs.writeFileSync(path.join(REPORT_DIR, REPORT_JSON), `${JSON.stringify(report, null, 2)}\n`, "utf8");
    fs.writeFileSync(path.join(REPORT_DIR, REPORT_MD), renderFtsParityMarkdown(report), "utf8");
  }

  if (asJson) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }

  console.log("WorldCons M7.7-B FTS parity (read-only)");
  console.log(`  source: ${source}, maxArticles: ${maxArticles}, oracleAvailable: ${oracleAvailable}`);
  console.log(`  corpusHash: ${report.corpusHash}, cases: ${report.corpusCases}`);
  console.log(`  projection: sourceRows=${report.projection.sourceRows}, documents=${report.projection.documents}, productionProjectionIds=${report.projection.productionProjectionIds ?? "n/a"}`);
  if (report.sourceScope) {
    console.log(
      `  sourceScope: productionProjectionIds=${report.sourceScope.productionProjectionIds}, sourceRowsFetched=${report.sourceScope.sourceRowsFetched}, localDocuments=${report.sourceScope.localDocuments}, missingIds=${report.sourceScope.missingIds}, extraIds=${report.sourceScope.extraIds}, scopeValid=${report.sourceScope.scopeValid}`,
    );
  }
  console.log(`  state: ${report.policy.state}`);
  console.log(
    `  strict: ${report.policy.strict.passed}/${report.policy.strict.cases} pass, failed=${report.policy.strict.failed}, notApplicable=${report.policy.strict.notApplicable}`,
  );
  console.log(
    `  aggregate: compared=${report.policy.aggregate.compared}, overlapAtKMacro=${report.policy.aggregate.overlapAtKMacro.toFixed(4)}, prefixMacro=${report.policy.aggregate.prefixMatchMacro.toFixed(4)}, exactOrderMacro=${report.policy.aggregate.exactOrderMacro.toFixed(4)}, sameSetMacro=${report.policy.aggregate.sameSetMacro.toFixed(4)}`,
  );
  for (const category of report.policy.categories) {
    if (category.cases === 0) continue;
    console.log(`    ${category.category}: cases=${category.cases} strict=${category.strictPassed}/${category.strictCases} compared=${category.compared} state=${category.thresholdState}`);
  }
  for (const blocker of report.policy.blockers) console.log(`    blocker ${blocker.code}: ${blocker.detail}`);
  if (errors.length > 0) console.log(`    errors: ${errors.join(", ")}`);
  if (writeReport) console.log(`  wrote ${REPORT_DIR}`);
}

main().catch((error: unknown) => {
  console.error(`d1-fts-parity failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
