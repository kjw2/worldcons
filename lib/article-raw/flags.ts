export const ARTICLE_RAW_BLOB_WRITE_ENABLED = "ARTICLE_RAW_BLOB_WRITE_ENABLED";
export const ARTICLE_RAW_BLOB_READ_ENABLED = "ARTICLE_RAW_BLOB_READ_ENABLED";

function explicitTrue(value?: string) {
  return value?.trim().toLowerCase() === "true";
}

export function articleRawBlobWriteEnabled(
  environment: Record<string, string | undefined> = process.env,
) {
  return explicitTrue(environment[ARTICLE_RAW_BLOB_WRITE_ENABLED]);
}

export function articleRawBlobReadEnabled(
  environment: Record<string, string | undefined> = process.env,
) {
  return explicitTrue(environment[ARTICLE_RAW_BLOB_READ_ENABLED]);
}

export function articleRawBlobFlagErrors(
  environment: Record<string, string | undefined> = process.env,
) {
  const errors: string[] = [];
  if (articleRawBlobWriteEnabled(environment) && !articleRawBlobReadEnabled(environment)) {
    errors.push(`${ARTICLE_RAW_BLOB_WRITE_ENABLED} requires ${ARTICLE_RAW_BLOB_READ_ENABLED}`);
  }
  return errors;
}

export function articleRawBlobWriteReady(
  environment: Record<string, string | undefined> = process.env,
) {
  return articleRawBlobWriteEnabled(environment)
    && articleRawBlobFlagErrors(environment).length === 0;
}

export function articleRawBlobReadReady(
  environment: Record<string, string | undefined> = process.env,
) {
  return articleRawBlobReadEnabled(environment)
    && articleRawBlobFlagErrors(environment).length === 0;
}
