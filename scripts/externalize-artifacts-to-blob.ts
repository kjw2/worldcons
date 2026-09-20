import "dotenv/config";
import { postgresCaseBackfillRepository } from "@/lib/backfill/repository";
import {
  runArtifactExternalizationBatch,
  safeArtifactExternalizationOutcomeProjection as safeProjection,
} from "@/lib/backfill/externalization";
import type { CaseBackfillArtifactExternalizationKind } from "@/lib/backfill/types";
import { acquireOperatorLock } from "@/lib/ops/operator-lock";
import { createOperatorArtifactBlobStore } from "@/lib/storage/operator-blob";

const KINDS: readonly CaseBackfillArtifactExternalizationKind[] = ["fetch", "normalization"];
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

function kindArgument(): CaseBackfillArtifactExternalizationKind {
  const value = argumentValue("kind")?.trim().toLowerCase() ?? "";
  if (!KINDS.includes(value as CaseBackfillArtifactExternalizationKind)) throw new Error("invalid_kind");
  return value as CaseBackfillArtifactExternalizationKind;
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
  const kind = kindArgument();
  const sourceKey = optionalSourceKey();
  const batchSize = integerArgument("batch-size", 25, 1, 100);
  const maxBatches = integerArgument("max-batches", 20, 1, 1000);
  const concurrency = integerArgument("concurrency", 1, 1, 8);
  const afterArtifactId = optionalUuid("after");
  const actorId = safeActor();
  const execute = flag("execute");
  const lock = execute
    ? await acquireOperatorLock("artifact-externalize-" + kind + "-" + (sourceKey ?? "all"))
    : null;
  try {
  const store = createOperatorArtifactBlobStore();

  output({
    event: "artifact_externalization_planned",
    kind,
    sourceKey,
    batchSize,
    maxBatches,
    concurrency,
    afterArtifactId,
    execute,
    actorId,
    inlineContentPreserved: true,
    publicCatalogWrites: 0,
    geminiCalls: 0,
  });

  let cursor = afterArtifactId;
  let batches = 0;
  let scanned = 0;
  let externalized = 0;
  let idempotent = 0;
  let failed = 0;

  while (batches < maxBatches) {
    const result = await runArtifactExternalizationBatch(
      { kind, sourceKey, batchSize, afterArtifactId: cursor, actorId, execute, concurrency },
      { repository: postgresCaseBackfillRepository, store },
    );
    batches += 1;
    scanned += result.scanned;
    externalized += result.externalized;
    idempotent += result.idempotent;
    failed += result.failed.length;
    output({
      event: "artifact_externalization_batch",
      kind,
      sourceKey,
      batchNumber: batches,
      concurrency,
      scanned: result.scanned,
      externalized: result.externalized,
      idempotent: result.idempotent,
      failed: result.failed,
      outcomes: result.outcomes.map(safeProjection),
      execute,
      inlineContentPreserved: true,
      publicCatalogWrites: 0,
      geminiCalls: 0,
    });
    if (result.scanned < batchSize || !result.lastArtifactId) break;
    cursor = result.lastArtifactId;
  }

  output({
    event: execute ? "artifact_externalization_completed" : "artifact_externalization_dry_run_completed",
    kind,
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
    event: "artifact_externalization_failed",
    errorCode: error instanceof Error ? error.message.slice(0, 160) : "unknown_error",
    publicCatalogWrites: 0,
    geminiCalls: 0,
  });
  process.exitCode = 1;
});
