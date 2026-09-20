import "dotenv/config";
import { postgresCaseBackfillRepository } from "@/lib/backfill/repository";
import { runArtifactReadiness } from "@/lib/backfill/artifact-readiness";
import { caseBackfillArtifactBlobReadReady } from "@/lib/backfill/flags";
import type { CaseBackfillArtifactExternalizationKind } from "@/lib/backfill/types";
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

function optionalKindArgument(): CaseBackfillArtifactExternalizationKind | null {
  const value = argumentValue("kind")?.trim().toLowerCase();
  if (!value) return null;
  if (!KINDS.includes(value as CaseBackfillArtifactExternalizationKind)) throw new Error("invalid_kind");
  return value as CaseBackfillArtifactExternalizationKind;
}

function optionalSourceKey() {
  const value = argumentValue("source")?.trim();
  if (!value) return null;
  if (!SOURCE_KEY_PATTERN.test(value)) throw new Error("invalid_source");
  return value;
}

function output(value: Record<string, unknown>) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

async function main() {
  const kind = optionalKindArgument();
  const sourceKey = optionalSourceKey();
  const batchSize = integerArgument("batch-size", 25, 1, 100);
  const maxBatches = integerArgument("max-batches", 50, 1, 1000);
  const verificationSampleSize = integerArgument("verify-sample", 0, 0, 100);
  const afterArtifactId = optionalUuid("after");
  const requireNewWriteReady = flag("require-new-write-ready");
  const requireInlineClearReady = flag("require-inline-clear-ready");

  if (afterArtifactId && !kind) throw new Error("after_requires_kind");
  // Blob verification is the only path that touches Blob storage. It is off by
  // default and additionally requires the Blob read flag, so a bare readiness run
  // never issues a single head/get.
  if (verificationSampleSize > 0 && !caseBackfillArtifactBlobReadReady(process.env)) {
    throw new Error("artifact_blob_read_not_ready");
  }

  const store = verificationSampleSize > 0 ? createOperatorArtifactBlobStore() : null;
  const report = await runArtifactReadiness(
    {
      kinds: kind ? [kind] : undefined,
      sourceKey,
      batchSize,
      maxBatches,
      verificationSampleSize,
      afterArtifactId,
    },
    { repository: postgresCaseBackfillRepository, store, environment: process.env },
  );

  output(report as unknown as Record<string, unknown>);
  if (requireInlineClearReady && !report.decisions.inlineClearReady) return 2;
  if (requireNewWriteReady && !report.decisions.newWriteReady) return 2;
  return report.gates.critical ? 1 : 0;
}

main().then((exitCode) => {
  process.exitCode = exitCode;
}).catch((error) => {
  output({
    event: "artifact_blob_readiness_failed",
    errorCode: error instanceof Error ? error.message.slice(0, 160) : "unknown_error",
    readOnly: true,
    blobObjectsDeleted: 0,
    publicCatalogWrites: 0,
    storageRefsEmitted: 0,
  });
  process.exitCode = 1;
});
