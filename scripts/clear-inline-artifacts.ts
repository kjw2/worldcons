import "dotenv/config";
import { postgresCaseBackfillRepository } from "@/lib/backfill/repository";
import { runArtifactInlineClearBatch } from "@/lib/backfill/inline-clear";
import type { CaseBackfillArtifactExternalizationKind } from "@/lib/backfill/types";
import { createOperatorArtifactBlobStore } from "@/lib/storage/operator-blob";
import { caseBackfillArtifactBlobReadReady } from "@/lib/backfill/flags";

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
  const afterArtifactId = optionalUuid("after");
  const actorId = safeActor();
  const execute = flag("execute");
  const acknowledgedIrreversible = flag("acknowledge-irreversible");
  const blobReadReady = caseBackfillArtifactBlobReadReady(process.env);

  // Inline clear drops the database copy of an artifact payload and cannot be
  // undone, so execute requires both the explicit --execute switch and an explicit
  // irreversible acknowledgement, and the Blob read flag must be ready so every
  // object is verified before the DB is mutated.
  if (execute && !acknowledgedIrreversible) throw new Error("execute_requires_acknowledge_irreversible");
  if (execute && !blobReadReady) throw new Error("artifact_blob_read_not_ready");

  const store = createOperatorArtifactBlobStore();

  output({
    event: "artifact_inline_clear_planned",
    kind,
    sourceKey,
    batchSize,
    maxBatches,
    afterArtifactId,
    execute,
    acknowledgedIrreversible,
    blobReadReady,
    actorId,
    blobObjectsDeleted: 0,
    publicCatalogWrites: 0,
  });

  let cursor = afterArtifactId;
  let batches = 0;
  let scanned = 0;
  let cleared = 0;
  let idempotent = 0;
  let failed = 0;

  while (batches < maxBatches) {
    const result = await runArtifactInlineClearBatch(
      { kind, sourceKey, batchSize, afterArtifactId: cursor, actorId, execute },
      { repository: postgresCaseBackfillRepository, store },
    );
    batches += 1;
    scanned += result.scanned;
    cleared += result.cleared;
    idempotent += result.idempotent;
    failed += result.failed.length;
    output({
      event: "artifact_inline_clear_batch",
      kind,
      sourceKey,
      batchNumber: batches,
      scanned: result.scanned,
      cleared: result.cleared,
      idempotent: result.idempotent,
      failed: result.failed,
      outcomes: result.outcomes,
      execute,
      blobObjectsDeleted: 0,
      publicCatalogWrites: 0,
    });
    if (result.scanned < batchSize || !result.lastArtifactId) break;
    cursor = result.lastArtifactId;
  }

  output({
    event: execute ? "artifact_inline_clear_completed" : "artifact_inline_clear_dry_run_completed",
    kind,
    sourceKey,
    batches,
    scanned,
    cleared,
    idempotent,
    failed,
    execute,
    acknowledgedIrreversible,
    blobObjectsDeleted: 0,
    publicCatalogWrites: 0,
  });
  return failed > 0 ? 1 : 0;
}

main().then((exitCode) => {
  process.exitCode = exitCode;
}).catch((error) => {
  output({
    event: "artifact_inline_clear_failed",
    errorCode: error instanceof Error ? error.message.slice(0, 160) : "unknown_error",
    blobObjectsDeleted: 0,
    publicCatalogWrites: 0,
  });
  process.exitCode = 1;
});
