import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { createWranglerD1Runner } from "@/lib/cloudflare/d1/remote/runner";
import { parseD1RemoteListJson } from "@/lib/cloudflare/d1/remote";
import type { SearchPublicationP3Row, SearchVersionP3Row } from "@/lib/cloudflare/search-projection";
import { planSearchProjectionIncrementalSync } from "@/lib/cloudflare/search-projection";
import { runVectorRankedSearchPage } from "@/lib/cloudflare/search-vector";
import type { ArticleEmbeddingArtifactRow } from "@/lib/cloudflare/search-vector";
import type { RankedSearchPageInput } from "@/lib/cloudflare/search-ranked";
import {
  SEARCH_CANARY_D1_DATABASE,
  SEARCH_CANARY_DEFAULT_THRESHOLDS,
  SEARCH_CANARY_MAX_ARTICLES_DEFAULT,
  SEARCH_CANARY_VECTOR_BATCH_SIZE,
  SEARCH_CANARY_VECTOR_INDEX,
  buildSearchCanaryCases,
  buildSearchCanaryProjectionPlan,
  buildSearchCanaryReport,
  evaluateSearchCanaryCase,
  planSearchCanaryVectorBootstrap,
  renderSearchCanaryMarkdown,
  searchCanaryErrorObservation,
  type SearchCanaryBlocker,
  type SearchCanaryCase,
  type SearchCanaryObservation,
} from "@/lib/cloudflare/search-canary";
import { literalizeScript, literalizeStatement } from "@/lib/cloudflare/search-canary/operator/literalize";
import { createRemoteD1Client } from "@/lib/cloudflare/search-canary/operator/remote-d1";
import { createVectorizeCli } from "@/lib/cloudflare/search-canary/operator/vectorize-cli";
import { createRemoteVectorIdBinding, createRemoteVectorizeBinding } from "@/lib/cloudflare/search-canary/operator/vectorize-binding";
import { createSupabaseCanaryReader } from "@/lib/cloudflare/search-canary/operator/supabase-read";

/**
 * M7.5 remote search canary operator CLI.
 *
 *   pnpm d1:search-canary                       # dry-run plan (default)
 *   pnpm d1:search-canary --apply --report      # bounded remote canary
 *   pnpm d1:search-canary --source=fixture --fixture=corpus.json
 *   pnpm d1:search-canary --apply --index-only
 *
 * Dry-run by default: it plans the isolated canary index/metadata indexes and
 * projection and reads the current remote state, but performs no write. With
 * `--apply` it creates only the isolated, non-production canary resources, then
 * writes bounded projections and runs frozen canary cases against them.
 *
 * Supabase remains the sole production search/read authority. This CLI never
 * switches `SearchRepository`, never writes Supabase, never deletes a resource
 * and never touches an existing production Vectorize index or D1 database.
 */
const REPORT_DIR = path.join("artifacts", "cloudflare-m7");
const SCHEMA_PATH = path.join("d1", "worldcons_search", "0001_init.sql");
const VECTOR_SYNC_TIMEOUT_MS = 120_000;
const VECTOR_SYNC_POLL_MS = 1_000;
// Cloudflare D1's documented maximum SQL statement length (not file size).
const D1_SQL_STATEMENT_MAX_BYTES = 100_000;

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

interface FixtureSource {
  publications?: SearchPublicationP3Row[];
  versions?: SearchVersionP3Row[];
  articles?: { id: string; review_state?: string | null }[];
  artifacts?: ArticleEmbeddingArtifactRow[];
}

function loadFixture(filePath: string): FixtureSource {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as FixtureSource;
}

async function waitForVectorMutation(
  cli: ReturnType<typeof createVectorizeCli>,
  indexName: string,
  previousMutation: string | null,
  expectedMinimumCount: number,
): Promise<void> {
  const deadline = Date.now() + VECTOR_SYNC_TIMEOUT_MS;
  let observedCount = 0;
  let observedMutation: string | null = previousMutation;
  while (Date.now() <= deadline) {
    const info = await cli.getInfo(indexName);
    observedCount = info.vectorCount;
    observedMutation = info.processedUpToMutation;
    if (observedMutation !== null && observedMutation !== previousMutation && observedCount >= expectedMinimumCount) return;
    await new Promise<void>((resolve) => setTimeout(resolve, VECTOR_SYNC_POLL_MS));
  }
  throw new Error(
    `Vectorize canary index ${indexName} did not process the latest upsert within ${VECTOR_SYNC_TIMEOUT_MS}ms ` +
      `(previousMutation=${previousMutation ?? "none"}, observedMutation=${observedMutation ?? "none"}, observedCount=${observedCount})`,
  );
}

async function waitForMetadataIndexes(
  cli: ReturnType<typeof createVectorizeCli>,
  indexName: string,
  expected: readonly string[],
): Promise<string[]> {
  if (expected.length === 0) return cli.listMetadataIndexes(indexName);
  const deadline = Date.now() + VECTOR_SYNC_TIMEOUT_MS;
  let observed: string[] = [];
  while (Date.now() <= deadline) {
    observed = await cli.listMetadataIndexes(indexName);
    if (expected.every((propertyName) => observed.includes(propertyName))) return observed;
    await new Promise<void>((resolve) => setTimeout(resolve, VECTOR_SYNC_POLL_MS));
  }
  const missing = expected.filter((propertyName) => !observed.includes(propertyName));
  throw new Error(`Vectorize metadata indexes did not become ready within ${VECTOR_SYNC_TIMEOUT_MS}ms: ${missing.join(", ")}`);
}

async function populateCanarySearchProjection(
  d1Client: ReturnType<typeof createRemoteD1Client>,
  projection: ReturnType<typeof buildSearchCanaryProjectionPlan>,
): Promise<number> {
  const documentCount = await d1Client.countRows("search_documents");
  const ftsCount = await d1Client.countRows("search_fts");

  if (documentCount === 0 && ftsCount === 0) {
    const insertOnly = planSearchProjectionIncrementalSync([], projection.documents, projection.ftsDocuments);
    if (insertOnly.destructive) throw new Error("canary initial projection unexpectedly planned a destructive statement");
    await d1Client.executeScript(literalizeScript(insertOnly.statements));
    return projection.documents.length;
  }

  if (documentCount !== projection.documents.length || ftsCount !== projection.ftsDocuments.length) {
    throw new Error(
      `canary database ${d1Client.database} is non-empty and differs from the requested projection ` +
        `(documents=${documentCount}/${projection.documents.length}, fts=${ftsCount}/${projection.ftsDocuments.length}); ` +
        "destructive rebuild is refused, choose a new --database name",
    );
  }

  const existingDocuments = await d1Client.queryRows(
    "select article_id, checksum, projection_version from search_documents order by article_id",
  );
  const desiredDocuments = [...projection.documents]
    .sort((left, right) => left.article_id.localeCompare(right.article_id))
    .map((document) => ({
      article_id: document.article_id,
      checksum: document.checksum,
      projection_version: document.projection_version,
    }));
  if (JSON.stringify(existingDocuments.rows) !== JSON.stringify(desiredDocuments)) {
    throw new Error(
      `canary database ${d1Client.database} contains a different search_documents projection; ` +
        "destructive rebuild is refused, choose a new --database name",
    );
  }

  const existingFts = await d1Client.queryRows("select article_id from search_fts order by article_id");
  const desiredFts = [...projection.ftsDocuments]
    .map((document) => document.article_id)
    .sort((left, right) => left.localeCompare(right))
    .map((article_id) => ({ article_id }));
  if (JSON.stringify(existingFts.rows) !== JSON.stringify(desiredFts)) {
    throw new Error(
      `canary database ${d1Client.database} contains a different search_fts projection; ` +
        "destructive rebuild is refused, choose a new --database name",
    );
  }

  return 0;
}

function preflightD1CliProjection(projection: ReturnType<typeof buildSearchCanaryProjectionPlan>): {
  oversized: number;
  maxBytes: number;
} {
  const insertOnly = planSearchProjectionIncrementalSync([], projection.documents, projection.ftsDocuments);
  if (insertOnly.destructive) throw new Error("canary initial projection unexpectedly planned a destructive statement");
  const statementBytes = insertOnly.statements.map((statement) =>
    Buffer.byteLength(literalizeStatement(statement.sql, statement.params), "utf8"),
  );
  return {
    oversized: statementBytes.filter((bytes) => bytes > D1_SQL_STATEMENT_MAX_BYTES).length,
    maxBytes: statementBytes.length === 0 ? 0 : Math.max(...statementBytes),
  };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const asJson = args.includes("--json");
  const apply = args.includes("--apply");
  const writeReport = args.includes("--report");
  const indexOnly = args.includes("--index-only");
  const skipVector = args.includes("--skip-vector");
  const reuseVector = args.includes("--reuse-vector");
  const skipD1 = args.includes("--skip-d1");
  const runOracle = args.includes("--oracle");
  const maxArticles = positiveIntegerArg(args, "max-articles") ?? SEARCH_CANARY_MAX_ARTICLES_DEFAULT;
  const maxCasesPerMode = positiveIntegerArg(args, "max-cases-per-mode") ?? 2;
  const source = (argValue(args, "source") ?? "supabase") as "supabase" | "remote-d1" | "fixture";
  const vectorIndex = argValue(args, "index-name") ?? SEARCH_CANARY_VECTOR_INDEX;
  const database = argValue(args, "database") ?? SEARCH_CANARY_D1_DATABASE;
  const location = argValue(args, "location") ?? "apac";
  if (reuseVector && skipVector) throw new Error("--reuse-vector cannot be combined with --skip-vector");

  const wrangler = createWranglerD1Runner();
  const cli = createVectorizeCli(wrangler);

  const blockers: SearchCanaryBlocker[] = [
    { code: "metadata_high_cardinality_range", detail: "millisecond publishedEpoch range filters can reduce Vectorize accuracy on large indexes" },
  ];

  // --- Source rows ---------------------------------------------------------
  let sourceRows;
  if (source === "fixture") {
    const fixturePath = argValue(args, "fixture");
    if (fixturePath === null) throw new Error("--source=fixture requires --fixture=<path>");
    const fixture = loadFixture(fixturePath);
    sourceRows = {
      publications: fixture.publications ?? [],
      versions: fixture.versions ?? [],
      articles: fixture.articles ?? [],
      artifacts: fixture.artifacts ?? [],
      publishedCount: (fixture.publications ?? []).length,
    };
    blockers.push({ code: "production_oracle_unavailable", detail: "fixture source has no production oracle" });
  } else if (source === "remote-d1") {
    throw new Error("--source=remote-d1 is not supported: the D1 artifact table intentionally omits embedding values; use --source=supabase or --fixture");
  } else {
    sourceRows = await createSupabaseCanaryReader().readSources(maxArticles);
  }

  const projection = buildSearchCanaryProjectionPlan({
    publications: sourceRows.publications,
    versions: sourceRows.versions,
    articles: sourceRows.articles,
    artifacts: sourceRows.artifacts,
    maxArticles,
  });
  const d1Preflight = preflightD1CliProjection(projection);
  if (d1Preflight.oversized > 0) {
    blockers.push({
      code: "d1_sql_statement_limit",
      detail:
        `${d1Preflight.oversized} literalized canary INSERT statements exceed the ${D1_SQL_STATEMENT_MAX_BYTES}-byte D1 SQL limit ` +
        `(maxBytes=${d1Preflight.maxBytes}); source content is not truncated`,
    });
  }

  // --- Vectorize bootstrap plan (read-only) --------------------------------
  const existingIndex = await cli.getIndex(vectorIndex);
  const existingMetadataIndexes = existingIndex ? await cli.listMetadataIndexes(vectorIndex) : [];
  const vectorBootstrap = planSearchCanaryVectorBootstrap({
    indexName: vectorIndex,
    existingIndex: existingIndex ? { name: existingIndex.name, exists: true, dimensions: existingIndex.dimensions, metric: existingIndex.metric } : { name: vectorIndex, exists: false, dimensions: null, metric: null },
    existingMetadataIndexes,
  });
  blockers.push(...vectorBootstrap.blockers);

  const remoteWrites = {
    indexCreated: false,
    metadataIndexesCreated: [] as string[],
    vectorsUpserted: 0,
    searchRowsInserted: 0,
    databaseCreated: false,
  };

  if (apply && d1Preflight.oversized > 0) {
    throw new Error(
      `canary projection exceeds the D1 ${D1_SQL_STATEMENT_MAX_BYTES}-byte SQL statement limit ` +
        `(oversized=${d1Preflight.oversized}, maxBytes=${d1Preflight.maxBytes}); ` +
        "content is not truncated, reduce --max-articles for the CLI canary or implement parameterized remote writes",
    );
  }

  // --- Apply: isolated canary resources ------------------------------------
  if (apply && !skipVector && vectorBootstrap.ok) {
    if (vectorBootstrap.index.action === "create") {
      await cli.createIndex({ name: vectorIndex, dimensions: vectorBootstrap.index.dimensions, metric: "cosine" });
      remoteWrites.indexCreated = true;
    }
    const metadataToCreate = vectorBootstrap.metadataIndexes.filter((metadata) => metadata.action === "create");
    for (const metadata of metadataToCreate) {
      try {
        await cli.createMetadataIndex({ name: vectorIndex, propertyName: metadata.propertyName, type: metadata.type });
      } catch {
        // Metadata-index creation is enqueued asynchronously; tolerate an
        // already-enqueued or duplicate request and confirm below.
      }
    }
    const confirmedMetadata = await waitForMetadataIndexes(
      cli,
      vectorIndex,
      metadataToCreate.map((metadata) => metadata.propertyName),
    );
    remoteWrites.metadataIndexesCreated = metadataToCreate
      .map((metadata) => metadata.propertyName)
      .filter((propertyName) => confirmedMetadata.includes(propertyName));
  }

  if (apply && !indexOnly && !skipVector && vectorBootstrap.ok) {
    if (reuseVector) {
      const info = await cli.getInfo(vectorIndex);
      if (info.vectorCount < projection.records.length) {
        throw new Error(
          `--reuse-vector requires at least ${projection.records.length} indexed vectors in ${vectorIndex}; observed ${info.vectorCount}`,
        );
      }
    } else {
      for (let index = 0; index < projection.records.length; index += SEARCH_CANARY_VECTOR_BATCH_SIZE) {
        const batch = projection.records.slice(index, index + SEARCH_CANARY_VECTOR_BATCH_SIZE);
        const before = await cli.getInfo(vectorIndex);
        const upsert = await cli.upsert(
          vectorIndex,
          batch.map((record) => ({ id: record.id, values: record.values, metadata: record.metadata as unknown as Record<string, unknown> })),
        );
        remoteWrites.vectorsUpserted += upsert.count;
        await waitForVectorMutation(cli, vectorIndex, before.processedUpToMutation, Math.min(projection.records.length, index + batch.length));
      }
    }
  }

  let d1Client: ReturnType<typeof createRemoteD1Client> | null = null;
  if (apply && !indexOnly && !skipD1) {
    const listed = parseD1RemoteListJson(await wrangler(["d1", "list", "--json"]));
    const exists = listed.some((entry) => entry.name === database);
    if (!exists) {
      // Current Wrangler exposes no --json flag for `d1 create`; adding it can
      // crash the Windows CLI instead of returning a normal argument error.
      // The command's stdout is intentionally ignored and the database is
      // subsequently addressed by its validated canary name.
      await wrangler(["d1", "create", database, "--location", location]);
      remoteWrites.databaseCreated = true;
    }
    d1Client = createRemoteD1Client({ runner: wrangler, database });
    const schema = fs.readFileSync(SCHEMA_PATH, "utf8");
    await d1Client.executeScript(schema);
    remoteWrites.searchRowsInserted = await populateCanarySearchProjection(d1Client, projection);
  } else {
    blockers.push({
      code: "remote_search_projection_not_populated",
      detail: apply ? "run skipped (--index-only/--skip-d1)" : "dry-run only; pass --apply to populate the isolated canary search database",
    });
  }

  // --- Frozen canary cases -------------------------------------------------
  const cases = buildSearchCanaryCases({ documents: projection.documents, records: projection.records, maxCasesPerMode });
  const observations: SearchCanaryObservation[] = [];
  const canaryArticleIds = new Set(projection.documents.map((document) => document.article_id));

  if (d1Client !== null && !indexOnly) {
    const reader = runOracle ? createSupabaseCanaryReader() : null;
    if (reader === null) {
      blockers.push({ code: "production_oracle_unavailable", detail: "run with --oracle and a linked Supabase CLI to compare against the production RPC" });
    }
    const semanticOracleEligible = new Set<string>();
    if (reader !== null) {
      const semanticVectorIds = [...new Set(
        cases
          .filter((caseDef) => caseDef.mode !== "fulltext" && caseDef.vectorId)
          .map((caseDef) => caseDef.vectorId as string),
      )];
      let drifted = 0;
      for (const articleId of semanticVectorIds) {
        if (await reader.isProductionSemanticOracleEligible(articleId)) semanticOracleEligible.add(articleId);
        else drifted += 1;
      }
      if (drifted > 0) {
        blockers.push({
          code: "production_semantic_oracle_drift",
          detail:
            `${drifted} semantic/hybrid canary query articles have provenance-locked artifacts but NULL ` +
            "public_article_projection_p3.embedding; production RPC parity is skipped for those cases",
        });
      }
    }
    for (const caseDef of cases) {
      const vector = skipVector
        ? null
        : caseDef.vectorId
          ? createRemoteVectorIdBinding(cli, vectorIndex, caseDef.vectorId)
          : createRemoteVectorizeBinding(cli, vectorIndex);
      const oracleComparable =
        caseDef.mode === "fulltext" || caseDef.vectorId === null || caseDef.vectorId === undefined || semanticOracleEligible.has(caseDef.vectorId);
      observations.push(await runCase({ d1Client, vector, reader, caseDef, canaryArticleIds, oracleComparable }));
    }
  }

  // --- Evidence ------------------------------------------------------------
  const report = buildSearchCanaryReport({
    generatedAt: new Date().toISOString(),
    vectorIndex,
    database,
    source,
    projection,
    vectorBootstrap,
    remoteWrites,
    observations,
    thresholds: SEARCH_CANARY_DEFAULT_THRESHOLDS,
    blockers,
  });

  if (writeReport) {
    fs.mkdirSync(REPORT_DIR, { recursive: true });
    fs.writeFileSync(path.join(REPORT_DIR, "m7.5-search-canary-report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
    fs.writeFileSync(path.join(REPORT_DIR, "m7.5-search-canary-report.md"), renderSearchCanaryMarkdown(report), "utf8");
  }

  if (asJson) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    console.log(`WorldCons M7.5 search canary (${apply ? "apply" : "dry-run"})`);
    console.log(`  source: ${source}, maxArticles: ${maxArticles}, truncated: ${projection.truncated}`);
    console.log(`  projection: documents=${projection.changes.projectedDocuments}, vectors=${projection.changes.vectorRecords}, missing=${projection.changes.missingArtifacts}, stale=${projection.changes.staleArtifacts}`);
    console.log(`  vectorBootstrap: index ${vectorBootstrap.index.action}, metadata create=${vectorBootstrap.metadataIndexes.filter((entry) => entry.action === "create").length}`);
    console.log(`  remoteWrites: indexCreated=${remoteWrites.indexCreated}, metadataCreated=${remoteWrites.metadataIndexesCreated.length}, vectorsUpserted=${remoteWrites.vectorsUpserted}, searchRowsInserted=${remoteWrites.searchRowsInserted}, databaseCreated=${remoteWrites.databaseCreated}`);
    console.log(`  cases: ${cases.length}, observations: ${observations.length}, verdict: ${report.verdict}`);
    for (const mode of report.metrics.modes) {
      console.log(`    ${mode.mode}: cases=${mode.cases} compared=${mode.compared} pass=${mode.passed} mismatch=${mode.mismatched} oracle=${mode.oracleMatched}/${mode.oracleCompared} p50=${mode.latencyP50Ms}ms`);
    }
    for (const blocker of blockers) console.log(`    blocker ${blocker.code}: ${blocker.detail}`);
    if (writeReport) console.log(`  wrote ${REPORT_DIR}`);
  }
}

async function runCase(params: {
  d1Client: ReturnType<typeof createRemoteD1Client>;
  vector: ReturnType<typeof createRemoteVectorizeBinding> | null;
  reader: ReturnType<typeof createSupabaseCanaryReader> | null;
  caseDef: SearchCanaryCase;
  canaryArticleIds: ReadonlySet<string>;
  oracleComparable: boolean;
}): Promise<SearchCanaryObservation> {
  const { d1Client, vector, reader, caseDef, canaryArticleIds, oracleComparable } = params;
  const input: RankedSearchPageInput = {
    query: caseDef.query,
    mode: caseDef.mode,
    limit: caseDef.limit,
    offset: caseDef.offset,
    source: caseDef.source ?? null,
    jurisdiction: caseDef.jurisdiction ?? null,
    contentType: caseDef.contentType ?? null,
    language: caseDef.language ?? null,
    tag: null,
    range: caseDef.range ?? "latest",
    count: caseDef.count ?? "none",
    embedding: caseDef.embedding ?? null,
    referenceNow: new Date().toISOString(),
  };
  const beforeRows = d1Client.stats.rowsRead;
  const started = Date.now();
  try {
    const payload = await runVectorRankedSearchPage({ d1: d1Client.runtimeBinding(), vector, input });
    const latencyMs = Date.now() - started;
    const oracle = reader && oracleComparable ? await reader.readOraclePage(caseDef, canaryArticleIds) : null;
    return evaluateSearchCanaryCase({
      case: caseDef,
      payload,
      latencyMs,
      rowReads: d1Client.stats.rowsRead - beforeRows,
      oracle,
    });
  } catch (error) {
    const latencyMs = Date.now() - started;
    const message = error instanceof Error ? error.message : String(error);
    const code = typeof (error as { code?: unknown })?.code === "string" ? (error as { code: string }).code : "canary_error";
    const status = /timeout/i.test(message) ? "timeout" : "error";
    return searchCanaryErrorObservation({ case: caseDef, status, latencyMs, errorCode: code, detail: message.slice(0, 200) });
  }
}

main().catch((error) => {
  console.error(`d1-search-canary failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
