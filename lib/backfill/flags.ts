export const CASE_BACKFILL_ARTIFACT_BLOB_WRITE_FLAG = "CASE_BACKFILL_ARTIFACT_BLOB_WRITE_ENABLED";
export const CASE_BACKFILL_ARTIFACT_BLOB_READ_FLAG = "CASE_BACKFILL_ARTIFACT_BLOB_READ_ENABLED";

function explicitTrue(value?: string) {
  return value?.trim().toLowerCase() === "true";
}

export function caseBackfillArtifactBlobWriteEnabled(
  environment: Record<string, string | undefined> = process.env,
) {
  return explicitTrue(environment[CASE_BACKFILL_ARTIFACT_BLOB_WRITE_FLAG]);
}

export function caseBackfillArtifactBlobReadEnabled(
  environment: Record<string, string | undefined> = process.env,
) {
  return explicitTrue(environment[CASE_BACKFILL_ARTIFACT_BLOB_READ_FLAG]);
}

export function caseBackfillArtifactBlobFlagErrors(
  environment: Record<string, string | undefined> = process.env,
) {
  const errors: string[] = [];
  if (caseBackfillArtifactBlobWriteEnabled(environment) && !caseBackfillArtifactBlobReadEnabled(environment)) {
    errors.push(`${CASE_BACKFILL_ARTIFACT_BLOB_WRITE_FLAG} requires ${CASE_BACKFILL_ARTIFACT_BLOB_READ_FLAG}`);
  }
  return errors;
}

export function caseBackfillArtifactBlobWriteReady(
  environment: Record<string, string | undefined> = process.env,
) {
  return caseBackfillArtifactBlobWriteEnabled(environment)
    && caseBackfillArtifactBlobFlagErrors(environment).length === 0;
}

export function caseBackfillArtifactBlobReadReady(
  environment: Record<string, string | undefined> = process.env,
) {
  return caseBackfillArtifactBlobReadEnabled(environment)
    && caseBackfillArtifactBlobFlagErrors(environment).length === 0;
}
