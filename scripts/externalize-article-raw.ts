import "dotenv/config";
import { postgresArticleRawExternalizationRepository } from "@/lib/article-raw/externalization-repository";
import {
  ARTICLE_RAW_EXTERNALIZATION_TABLES,
  runArticleRawExternalizationBatch,
  toSafeArticleRawExternalizationOutcome,
  type ArticleRawExternalizationTable,
} from "@/lib/article-raw/externalization";
import { articleRawBlobReadEnabled } from "@/lib/article-raw/flags";
import { acquireOperatorLock } from "@/lib/ops/operator-lock";
import { createOperatorArtifactBlobStore } from "@/lib/storage/operator-blob";

const SOURCE_KEY_PATTERN = /^[a-z][a-z0-9._-]{0,79}$/;

function argumentValue(name: string) {
  return process.argv.find((argument) => argument.startsWith(`--${name}=`))?.slice(name.length + 3);
}

function flag(name: string) {
  return process.argv.includes(`--${name}`);
}

function integerArgument(name: string, fallback: number, min: number, max: number) {
  const raw = argumentValue(name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`invalid_${name}`);
  return value;
}

function optionalUuid(name: string) {
  const value = argumentValue(name)?.trim();
  if (!value) return null;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error(`invalid_${name}`);
  }
  return value;
}

function tableArgument(): ArticleRawExternalizationTable {
  const value = argumentValue("table")?.trim() ?? "";
  if (!ARTICLE_RAW_EXTERNALIZATION_TABLES.includes(value as ArticleRawExternalizationTable)) {
    throw new Error("invalid_table");
  }
  return value as ArticleRawExternalizationTable;
}

function optionalSourceKey() {
  const value = argumentValue("source")?.trim();
  if (!value) return null;
  if (!SOURCE_KEY_PATTERN.test(value)) throw new Error("invalid_source");
  return value;
}

function safeActor() {
  const value = argumentValue("requested-by")?.trim() || "worldcons-unattended-operations";
  if (!/^[a-z0-9._:@-]{1,160}$/i.test(value)) throw new Error("invalid_requested-by");
  return value;
}

function output(value: Record<string, unknown>) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}
async function main() {
  const articleTable = tableArgument();
  const sourceKey = optionalSourceKey();
  const batchSize = integerArgument("batch-size", 25, 1, 100);
  const maxBatches = integerArgument("max-batches", 20, 1, 1000);
  const concurrency = integerArgument("concurrency", 1, 1, 8);
  const afterArticleRowId = optionalUuid("after");
  const actorId = safeActor();
  const execute = flag("execute");
  // Executing mutates article rows, so it is gated on an explicit acknowledgement
  // and the article raw blob read flag before the Blob store is created or any
  // batch runs. A dry run needs neither, and WRITE is never required.
  if (execute) {
    if (!flag("acknowledge-externalization")) {
      throw new Error("article_raw_externalization.acknowledge_required");
    }
    if (!articleRawBlobReadEnabled()) {
      throw new Error("article_raw_externalization.read_disabled");
    }
  }
  const lock = execute
    ? await acquireOperatorLock("article-raw-externalize-" + articleTable + "-" + (sourceKey ?? "all"))
    : null;
  try {
  const store = createOperatorArtifactBlobStore();

  output({
    event: "article_raw_externalization_planned",
    articleTable,
    sourceKey,
    batchSize,
    maxBatches,
    concurrency,
    afterArticleRowId,
    execute,
    actorId,
    inlineContentPreserved: true,
    publicCatalogWrites: 0,
    geminiCalls: 0,
  });

  let cursor = afterArticleRowId;
  let batches = 0;
  let scanned = 0;
  let externalized = 0;
  let idempotent = 0;
  let failed = 0;

  while (batches < maxBatches) {
    const result = await runArticleRawExternalizationBatch(
      { articleTable, sourceKey, batchSize, afterArticleRowId: cursor, actorId, execute, concurrency },
      { repository: postgresArticleRawExternalizationRepository, store },
    );
    batches += 1;
    scanned += result.scanned;
    externalized += result.externalized;
    idempotent += result.idempotent;
    failed += result.failed.length;
    output({
      event: "article_raw_externalization_batch",
      articleTable,
      sourceKey,
      batchNumber: batches,
      concurrency,
      scanned: result.scanned,
      externalized: result.externalized,
      idempotent: result.idempotent,
      failed: result.failed,
      outcomes: result.outcomes.map(toSafeArticleRawExternalizationOutcome),
      execute,
      inlineContentPreserved: true,
      publicCatalogWrites: 0,
      geminiCalls: 0,
    });
    if (result.scanned < batchSize || !result.lastArticleRowId) break;
    cursor = result.lastArticleRowId;
  }
  output({
    event: execute ? "article_raw_externalization_completed" : "article_raw_externalization_dry_run_completed",
    articleTable,
    sourceKey,
    batches,
    scanned,
    externalized,
    idempotent,
    failed,
    execute,
    inlineContentPreserved: true,
    publicCatalogWrites: 0,
    geminiCalls: 0,
  });
  return failed > 0 ? 1 : 0;
  } finally {
    await lock?.release();
  }
}

main().then((exitCode) => {
  process.exitCode = exitCode;
}).catch((error) => {
  output({
    event: "article_raw_externalization_failed",
    errorCode: error instanceof Error ? error.message.slice(0, 160) : "unknown_error",
    publicCatalogWrites: 0,
    geminiCalls: 0,
  });
  process.exitCode = 1;
});
