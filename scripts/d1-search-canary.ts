import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { createWranglerD1Runner } from "@/lib/cloudflare/d1/remote/runner";
import { parseD1RemoteListJson } from "@/lib/cloudflare/d1/remote";
import type { SearchProjectionDocumentRow, SearchPublicationP3Row, SearchVersionP3Row } from "@/lib/cloudflare/search-projection";
import { planSearchProjectionIncrementalSync } from "@/lib/cloudflare/search-projection";
import { runVectorRankedSearchPage } from "@/lib/cloudflare/search-vector";
import type { ArticleEmbeddingArtifactRow } from "@/lib/cloudflare/search-vector";
import type { RankedSearchPageInput } from "@/lib/cloudflare/search-ranked";
import {
  SEARCH_CANARY_D1_DATABASE,
  SEARCH_CANARY_D1_SQL_STATEMENT_MAX_BYTES,
  SEARCH_CANARY_DEFAULT_THRESHOLDS,
  SEARCH_CANARY_MAX_ARTICLES_DEFAULT,
  SEARCH_CANARY_VECTOR_BATCH_SIZE,
  SEARCH_CANARY_VECTOR_INDEX,
  buildSearchCanaryCases,
  buildSearchCanaryProjectionPlan,
  buildSearchCanaryReport,
  buildSearchCanaryWritePlan,
  evaluateSearchCanaryCase,
  executeSearchCanaryWritePlan,
  planSearchCanaryProjectionExtension,
  planSearchCanaryVectorBootstrap,
  renderSearchCanaryMarkdown,
  resolveSearchCanaryOracleMode,
  searchCanaryErrorObservation,
  summarizeSearchCanaryExpansionIssues,
  summarizeSearchCanaryWritePlan,
  type SearchCanaryBlocker,
  type SearchCanaryCase,
  type SearchCanaryObservation,
  type SearchCanaryOracleDecision,
  type SearchCanaryWritePlan,
} from "@/lib/cloudflare/search-canary";
import { literalizeStatement } from "@/lib/cloudflare/search-canary/operator/literalize";
import { createRemoteD1Client } from "@/lib/cloudflare/search-canary/operator/remote-d1";
import { createVectorizeCli } from "@/lib/cloudflare/search-canary/operator/vectorize-cli";
import { createRemoteVectorIdBinding, createRemoteVectorizeBinding } from "@/lib/cloudflare/search-canary/operator/vectorize-binding";
import { createSupabaseCanaryReader } from "@/lib/cloudflare/search-canary/operator/supabase-read";
import {
  resolveSearchCanaryBindingTarget,
  resolveSearchCanaryWriter,
  runWorkerCanaryCases,
  type SearchCanaryWriterSelection,
} from "@/lib/cloudflare/search-canary/operator/parameterized-writer";

/**
 * M7.6 remote search canary operator CLI.
 *
 *   pnpm d1:search-canary                       # dry-run plan (default)
 *   pnpm d1:search-canary --apply --report      # bounded remote canary
 *   pnpm d1:search-canary --source=fixture --fixture=corpus.json
 *   pnpm d1:search-canary --apply --index-only
 *   pnpm d1:search-canary --apply --writer=worker
 *   pnpm d1:search-canary --apply --binding-canary --oracle
 *   pnpm d1:search-canary --apply --writer=local-dev --binding-canary
 *
 * `--writer=local-dev` (or WORLDCONS_SEARCH_CANARY_DEV_UNAUTH=true with
 * `--writer=auto`) drives a loopback `wrangler dev` origin with NO bearer token;
 * both the parameterized writes and `--binding-canary` use it. It fails closed
 * on any non-loopback or https endpoint and is never the default for the normal
 * worker/http modes.
 *
 * Dry-run by default: it plans the isolated canary index/metadata indexes and
 * projection and reads the current remote state, but performs no write. With
 * `--apply` it creates only the isolated, non-production canary resources, then
 * writes bounded projections through the parameterized writer (isolated Worker
 * D1 binding, or the D1 HTTP query API) and runs frozen canary cases against
 * them. `--binding-canary` additionally runs the same cases through the isolated
 * Worker's real bindings and records binding/runtime latency separately from
 * operator wall time.
 *
 * Supabase remains the sole production search/read authority. This CLI never
 * switches `SearchRepository`, never writes Supabase, never deletes a resource
 * and never touches an existing production Vectorize index or D1 database.
 */
const REPORT_DIR = path.join("artifacts", "cloudflare-m7");
const SCHEMA_PATH = path.join("d1", "worldcons_search", "0001_init.sql");
const VECTOR_SYNC_TIMEOUT_MS = 120_000;
const VECTOR_SYNC_POLL_MS = 1_000;
// Cloudflare D1's documented maximum SQL statement length (not file size). It is
// a diagnostic ceiling only now: M7.6 writes through the parameterized writer,
// so a large search_text is carried as a bound parameter and never enters the
// SQL statement text.
const D1_SQL_STATEMENT_MAX_BYTES = SEARCH_CANARY_D1_SQL_STATEMENT_MAX_BYTES;

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

interface CanaryProjectionPopulation {
  /** `search_documents` rows inserted by this run (0 for a true no-op). */
  insertedDocuments: number;
  /** Parameterized statements executed by this run (2 per inserted document). */
  executedStatements: number;
  /** The parameterized plan this run executed; empty for a no-op. */
  writePlan: SearchCanaryWritePlan;
}

function toCanaryDocumentRow(row: Record<string, unknown>): SearchProjectionDocumentRow {
  const articleId = row.article_id;
  if (typeof articleId !== "string" || articleId.length === 0) {
    throw new Error("canary search_documents row is missing a valid article_id");
  }
  return {
    article_id: articleId,
    checksum: typeof row.checksum === "string" ? row.checksum : null,
    projection_version: typeof row.projection_version === "number" ? row.projection_version : null,
  };
}

async function readCanaryDocumentRows(
  d1Client: ReturnType<typeof createRemoteD1Client>,
): Promise<SearchProjectionDocumentRow[]> {
  const envelope = await d1Client.queryRows(
    "select article_id, checksum, projection_version from search_documents order by article_id",
  );
  return envelope.rows.map((row) => toCanaryDocumentRow(row));
}

async function readCanaryFtsArticleIds(d1Client: ReturnType<typeof createRemoteD1Client>): Promise<string[]> {
  const envelope = await d1Client.queryRows("select article_id from search_fts order by article_id");
  return envelope.rows.map((row) => {
    const articleId = row.article_id;
    if (typeof articleId !== "string" || articleId.length === 0) {
      throw new Error("canary search_fts row is missing a valid article_id");
    }
    return articleId;
  });
}

/**
 * Safe append-only population/expansion for the isolated canary.
 *
 * The canary may be empty or hold a verified subset of the desired bounded
 * projection. This reads the materialized `search_documents`/`search_fts`
 * identity, fails closed on any remote-only id, overlap checksum/version
 * mismatch, duplicate identity or FTS divergence, then INSERTs only the ids
 * missing from both tables through the parameterized writer. It never issues
 * DELETE/UPDATE/REPLACE. After writing it re-reads and requires the final state
 * to equal the desired projection exactly; an already-exact canary is a no-op.
 */
async function populateCanarySearchProjection(
  d1Client: ReturnType<typeof createRemoteD1Client>,
  projection: ReturnType<typeof buildSearchCanaryProjectionPlan>,
  writer: SearchCanaryWriterSelection | null,
): Promise<CanaryProjectionPopulation> {
  const extension = planSearchCanaryProjectionExtension({
    documents: projection.documents,
    ftsDocuments: projection.ftsDocuments,
    currentDocuments: await readCanaryDocumentRows(d1Client),
    currentFtsArticleIds: await readCanaryFtsArticleIds(d1Client),
  });

  if (!extension.ok) {
    throw new Error(
      `canary database ${d1Client.database} is not an append-only subset of the desired projection ` +
        `(${summarizeSearchCanaryExpansionIssues(extension.issues)}); destructive rebuild is refused, choose a new --database name`,
    );
  }

  if (extension.noop) {
    return { insertedDocuments: 0, executedStatements: 0, writePlan: extension.plan };
  }

  if (writer === null) {
    throw new Error(
      `canary database ${d1Client.database} has ${extension.insertedDocuments} documents to insert but no ` +
        "parameterized writer is configured; set WORLDCONS_SEARCH_CANARY_WORKER_URL + WORLDCONS_SEARCH_CANARY_TOKEN, or " +
        "CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_API_TOKEN + WORLDCONS_SEARCH_CANARY_DATABASE_ID",
    );
  }

  // M7.6: execute the parameterized statements through the selected writer; the
  // authored `?` SQL plus bound params are sent separately, so a large
  // `search_text` never enters the SQL statement text and is never truncated.
  const result = await executeSearchCanaryWritePlan(extension.plan, writer.kind, writer.execute);

  const verification = planSearchCanaryProjectionExtension({
    documents: projection.documents,
    ftsDocuments: projection.ftsDocuments,
    currentDocuments: await readCanaryDocumentRows(d1Client),
    currentFtsArticleIds: await readCanaryFtsArticleIds(d1Client),
  });
  if (!verification.ok || !verification.noop) {
    throw new Error(
      `canary database ${d1Client.database} failed post-write verification against the desired projection ` +
        `(documents=${verification.currentDocumentCount}/${projection.documents.length}, ` +
        `fts=${verification.currentFtsCount}/${projection.ftsDocuments.length}, ` +
        `missing=${verification.missingDocumentIds.length}` +
        (verification.issues.length > 0 ? `, ${summarizeSearchCanaryExpansionIssues(verification.issues)}` : "") +
        ")",
    );
  }

  return { insertedDocuments: extension.insertedDocuments, executedStatements: result.executedStatements, writePlan: extension.plan };
}

/**
 * Plans the parameterized canary writes once, before any remote call. The literal
 * size fields are diagnostics only (what the legacy path would have produced);
 * they no longer gate an apply, because the parameterized writer carries the
 * values out of band.
 */
function planCanaryWrites(projection: ReturnType<typeof buildSearchCanaryProjectionPlan>): {
  writePlan: SearchCanaryWritePlan;
  literalOversized: number;
  literalMaxBytes: number;
} {
  const insertOnly = planSearchProjectionIncrementalSync([], projection.documents, projection.ftsDocuments);
  if (insertOnly.destructive) throw new Error("canary initial projection unexpectedly planned a destructive statement");
  const writePlan = buildSearchCanaryWritePlan(insertOnly.statements);
  const statementBytes = insertOnly.statements.map((statement) =>
    Buffer.byteLength(literalizeStatement(statement.sql, statement.params), "utf8"),
  );
  return {
    writePlan,
    literalOversized: statementBytes.filter((bytes) => bytes > D1_SQL_STATEMENT_MAX_BYTES).length,
    literalMaxBytes: statementBytes.length === 0 ? 0 : Math.max(...statementBytes),
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
  const bindingCanary = args.includes("--binding-canary");
  const writerRequested = argValue(args, "writer") ?? "auto";
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

  // M7.6 plans the parameterized writes once, before any remote call. The
  // literal-size fields below are diagnostics only: the old literalized path
  // would have exceeded D1's 100 KB statement ceiling, but the parameterized
  // writer carries the values out of band and never truncates source content.
  const writePlanInfo = planCanaryWrites(projection);
  const writer = resolveSearchCanaryWriter({ requested: writerRequested, env: process.env });
  if (writePlanInfo.literalOversized > 0) {
    blockers.push({
      code: "d1_sql_statement_limit",
      detail:
        `${writePlanInfo.literalOversized} canary INSERT statements would exceed the ${D1_SQL_STATEMENT_MAX_BYTES}-byte D1 SQL limit if ` +
        `literalized (maxBytes=${writePlanInfo.literalMaxBytes}); M7.6 sends them as bound parameters, so source content is not truncated`,
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
    writer: writer?.kind ?? ("none" as const),
    parameterizedStatements: 0,
    literalOversizedStatements: writePlanInfo.literalOversized,
  };
  // The parameterized plan the apply run actually executes (the append-only
  // missing subset, possibly empty). Null until an apply populates the canary, so
  // a dry-run still reports the full desired projection plan.
  let executedWritePlan: SearchCanaryWritePlan | null = null;

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
    const population = await populateCanarySearchProjection(d1Client, projection, writer);
    executedWritePlan = population.writePlan;
    remoteWrites.searchRowsInserted = population.insertedDocuments;
    remoteWrites.parameterizedStatements = population.executedStatements;
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
      for (const articleId of semanticVectorIds) {
        if (await reader.isProductionSemanticOracleEligible(articleId)) semanticOracleEligible.add(articleId);
      }
    }

    // M7.6 binding/runtime canary: the isolated Worker runs the same cases
    // through its real D1 + Vectorize bindings and reports per-case binding
    // latency, which is kept separate from operator wall time.
    const bindingByCaseId = new Map<string, Awaited<ReturnType<typeof runWorkerCanaryCases>>[number]>();
    if (bindingCanary) {
      let target: ReturnType<typeof resolveSearchCanaryBindingTarget> = null;
      try {
        target = resolveSearchCanaryBindingTarget({ requested: writerRequested, env: process.env });
      } catch (error) {
        blockers.push({
          code: "binding_canary_unavailable",
          detail: (error instanceof Error ? error.message : String(error)).slice(0, 200),
        });
      }
      if (target === null) {
        blockers.push({
          code: "binding_canary_unavailable",
          detail:
            "run with WORLDCONS_SEARCH_CANARY_WORKER_URL and WORLDCONS_SEARCH_CANARY_TOKEN set to measure binding latency, " +
            "or pass --writer=local-dev (or WORLDCONS_SEARCH_CANARY_DEV_UNAUTH=true) with a loopback http endpoint for the tokenless local-dev path",
        });
      } else {
        try {
          // Strip the query embedding: the Worker queries Vectorize by the
          // indexed vector id (the article id), so a 1536-float vector is never
          // serialized across the boundary.
          const workerCases = cases.map((caseDef) => ({
            id: caseDef.id,
            mode: caseDef.mode,
            query: caseDef.query,
            source: caseDef.source ?? null,
            jurisdiction: caseDef.jurisdiction ?? null,
            contentType: caseDef.contentType ?? null,
            language: caseDef.language ?? null,
            range: caseDef.range,
            limit: caseDef.limit,
            offset: caseDef.offset,
            count: caseDef.count,
            vectorId: caseDef.vectorId ?? null,
          }));
          const results = await runWorkerCanaryCases(
            {
              endpoint: target.endpoint,
              token: target.token,
              allowUnauthenticatedLocalhost: target.localDev,
            },
            workerCases,
          );
          for (const result of results) bindingByCaseId.set(result.caseId, result);
        } catch (error) {
          blockers.push({
            code: "binding_canary_unavailable",
            detail: (error instanceof Error ? error.message : String(error)).slice(0, 200),
          });
        }
      }
    }

    let drifted = 0;
    for (const caseDef of cases) {
      const vector = skipVector
        ? null
        : caseDef.vectorId
          ? createRemoteVectorIdBinding(cli, vectorIndex, caseDef.vectorId)
          : createRemoteVectorizeBinding(cli, vectorIndex);
      const artifactBacked = caseDef.vectorId !== null && caseDef.vectorId !== undefined;
      const decision = resolveSearchCanaryOracleMode({
        mode: caseDef.mode,
        productionOracleAvailable: reader !== null,
        productionSemanticEligible: artifactBacked && semanticOracleEligible.has(caseDef.vectorId as string),
        artifactBacked,
      });
      if (decision.drift) drifted += 1;
      const bindingResult = bindingByCaseId.get(caseDef.id) ?? null;
      observations.push(
        await runCase({
          d1Client,
          vector,
          reader,
          caseDef,
          canaryArticleIds,
          oracleDecision: decision,
          bindingLatencyMs: bindingResult?.latencyMs ?? null,
        }),
      );
    }
    if (drifted > 0) {
      blockers.push({
        code: "production_semantic_oracle_drift",
        detail:
          `${drifted} semantic/hybrid canary query articles have provenance-locked artifacts but NULL ` +
          "public_article_projection_p3.embedding; comparing against the artifact projection instead of the production RPC",
      });
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
    // Only the content-free summary ever reaches the report; the executable plan
    // (authored SQL + bound params) is used solely by the writer and is never
    // serialized or logged. After an apply the summary reflects the append-only
    // subset actually executed; a dry-run reports the full desired plan.
    writePlan: summarizeSearchCanaryWritePlan(executedWritePlan ?? writePlanInfo.writePlan),
    observations,
    thresholds: SEARCH_CANARY_DEFAULT_THRESHOLDS,
    blockers,
  });

  if (writeReport) {
    fs.mkdirSync(REPORT_DIR, { recursive: true });
    fs.writeFileSync(path.join(REPORT_DIR, "m7.6-search-canary-report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
    fs.writeFileSync(path.join(REPORT_DIR, "m7.6-search-canary-report.md"), renderSearchCanaryMarkdown(report), "utf8");
  }

  if (asJson) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    console.log(`WorldCons M7.6 search canary (${apply ? "apply" : "dry-run"})`);
    console.log(`  source: ${source}, maxArticles: ${maxArticles}, truncated: ${projection.truncated}`);
    console.log(`  projection: documents=${projection.changes.projectedDocuments}, vectors=${projection.changes.vectorRecords}, missing=${projection.changes.missingArtifacts}, stale=${projection.changes.staleArtifacts}`);
    console.log(`  vectorBootstrap: index ${vectorBootstrap.index.action}, metadata create=${vectorBootstrap.metadataIndexes.filter((entry) => entry.action === "create").length}`);
    console.log(`  writePlan: statements=${report.writePlan?.counts.statements ?? 0}, params=${report.writePlan?.counts.parameters ?? 0}, maxAuthoredSqlBytes=${report.writePlan?.counts.maxAuthoredSqlBytes ?? 0}, maxParamBytes=${report.writePlan?.counts.maxParamBytes ?? 0}, literalOversized=${writePlanInfo.literalOversized}, writer=${remoteWrites.writer}`);
    console.log(`  remoteWrites: indexCreated=${remoteWrites.indexCreated}, metadataCreated=${remoteWrites.metadataIndexesCreated.length}, vectorsUpserted=${remoteWrites.vectorsUpserted}, searchRowsInserted=${remoteWrites.searchRowsInserted}, parameterizedStatements=${remoteWrites.parameterizedStatements}, databaseCreated=${remoteWrites.databaseCreated}`);
    console.log(`  timings: operator p50=${report.timings.operator.p50Ms}ms/${report.timings.operator.samples} binding p50=${report.timings.binding.p50Ms}ms/${report.timings.binding.samples}`);
    console.log(`  oracle: production-rpc=${report.oracle.productionRpc} artifact-reference=${report.oracle.artifactReference} none=${report.oracle.none} drift=${report.oracle.drift}`);
    console.log(`  cases: ${cases.length}, observations: ${observations.length}, verdict: ${report.verdict}`);
    for (const mode of report.metrics.modes) {
      console.log(`    ${mode.mode}: cases=${mode.cases} compared=${mode.compared} pass=${mode.passed} mismatch=${mode.mismatched} oracle=${mode.oracleMatched}/${mode.oracleCompared} informational=${mode.oracleInformational} p50=${mode.latencyP50Ms}ms bindingP50=${mode.bindingLatencyP50Ms}ms`);
    }
    for (const blocker of report.blockers) console.log(`    blocker ${blocker.code}: ${blocker.detail}`);
    if (writeReport) console.log(`  wrote ${REPORT_DIR}`);
  }
}

async function runCase(params: {
  d1Client: ReturnType<typeof createRemoteD1Client>;
  vector: ReturnType<typeof createRemoteVectorizeBinding> | null;
  reader: ReturnType<typeof createSupabaseCanaryReader> | null;
  caseDef: SearchCanaryCase;
  canaryArticleIds: ReadonlySet<string>;
  oracleDecision: SearchCanaryOracleDecision;
  bindingLatencyMs: number | null;
}): Promise<SearchCanaryObservation> {
  const { d1Client, vector, reader, caseDef, canaryArticleIds, oracleDecision, bindingLatencyMs } = params;
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
    const oracle =
      reader !== null && oracleDecision.mode === "production-rpc"
        ? await reader.readOraclePage(caseDef, canaryArticleIds)
        : null;
    return evaluateSearchCanaryCase({
      case: caseDef,
      payload,
      latencyMs,
      bindingLatencyMs,
      rowReads: d1Client.stats.rowsRead - beforeRows,
      oracle,
      oracleMode: oracleDecision.mode,
      oracleDrift: oracleDecision.drift,
    });
  } catch (error) {
    const latencyMs = Date.now() - started;
    const message = error instanceof Error ? error.message : String(error);
    const code = typeof (error as { code?: unknown })?.code === "string" ? (error as { code: string }).code : "canary_error";
    const status = /timeout/i.test(message) ? "timeout" : "error";
    return searchCanaryErrorObservation({ case: caseDef, status, latencyMs, bindingLatencyMs, errorCode: code, detail: message.slice(0, 200) });
  }
}

main().catch((error) => {
  console.error(`d1-search-canary failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
