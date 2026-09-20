import "dotenv/config";
import { postgresArticleRawInlineClearRepository } from "@/lib/article-raw/inline-clear-repository";
import {
  ARTICLE_RAW_INLINE_CLEAR_TABLES,
  runArticleRawInlineClearBatch,
  toSafeArticleRawInlineClearOutcome,
  type ArticleRawInlineClearTable,
} from "@/lib/article-raw/inline-clear";
import { articleRawBlobReadEnabled } from "@/lib/article-raw/flags";
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

function tableArgument(): ArticleRawInlineClearTable {
  const value = argumentValue("table")?.trim() ?? "";
  if (!ARTICLE_RAW_INLINE_CLEAR_TABLES.includes(value as ArticleRawInlineClearTable)) {
    throw new Error("invalid_table");
  }
  return value as ArticleRawInlineClearTable;
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
  const afterArticleRowId = optionalUuid("after");
  const actorId = safeActor();
  const execute = flag("execute");
  // Executing drops the inline raw_text copy, so it is gated on an explicit
  // acknowledgement and the article raw blob read flag before the Blob store is
  // created or any batch runs. A dry run needs neither, and WRITE is never
  // required: this path only reads Blob objects and never writes or deletes one.
  if (execute) {
    if (!flag("acknowledge-inline-clear")) {
      throw new Error("article_raw_inline_clear.acknowledge_required");
    }
    if (!articleRawBlobReadEnabled()) {
      throw new Error("article_raw_inline_clear.read_disabled");
    }
  }
  const store = createOperatorArtifactBlobStore();

  output({
    event: "article_raw_inline_clear_planned",
    articleTable,
    sourceKey,
    batchSize,
    maxBatches,
    afterArticleRowId,
    execute,
    actorId,
    blobObjectsWritten: 0,
    blobObjectsDeleted: 0,
    publicCatalogWrites: 0,
    geminiCalls: 0,
  });

  let cursor = afterArticleRowId;
  let batches = 0;
  let scanned = 0;
  let cleared = 0;
  let idempotent = 0;
  let conflicts = 0;
  let notReady = 0;
  let failed = 0;

  while (batches < maxBatches) {
    const result = await runArticleRawInlineClearBatch(
      { articleTable, sourceKey, batchSize, afterArticleRowId: cursor, actorId, execute },
      { repository: postgresArticleRawInlineClearRepository, store },
    );
    batches += 1;
    scanned += result.scanned;
    cleared += result.cleared;
    idempotent += result.idempotent;
    conflicts += result.conflicts;
    notReady += result.notReady;
    failed += result.failed.length;
    output({
      event: "article_raw_inline_clear_batch",
      articleTable,
      sourceKey,
      batchNumber: batches,
      scanned: result.scanned,
      cleared: result.cleared,
      idempotent: result.idempotent,
      conflicts: result.conflicts,
      notReady: result.notReady,
      failed: result.failed,
      outcomes: result.outcomes.map(toSafeArticleRawInlineClearOutcome),
      execute,
      blobObjectsWritten: 0,
      blobObjectsDeleted: 0,
      publicCatalogWrites: 0,
      geminiCalls: 0,
    });
    if (result.scanned < batchSize || !result.lastArticleRowId) break;
    cursor = result.lastArticleRowId;
  }
  output({
    event: execute ? "article_raw_inline_clear_completed" : "article_raw_inline_clear_dry_run_completed",
    articleTable,
    sourceKey,
    batches,
    scanned,
    cleared,
    idempotent,
    conflicts,
    notReady,
    failed,
    execute,
    blobObjectsWritten: 0,
    blobObjectsDeleted: 0,
    publicCatalogWrites: 0,
    geminiCalls: 0,
  });
  return failed > 0 ? 1 : 0;
}

main().then((exitCode) => {
  process.exitCode = exitCode;
}).catch((error) => {
  output({
    event: "article_raw_inline_clear_failed",
    errorCode: error instanceof Error ? error.message.slice(0, 160) : "unknown_error",
    blobObjectsWritten: 0,
    blobObjectsDeleted: 0,
    publicCatalogWrites: 0,
    geminiCalls: 0,
  });
  process.exitCode = 1;
});
