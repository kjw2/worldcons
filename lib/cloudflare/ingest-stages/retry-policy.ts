import type { IngestStage } from "./contracts";
import type { IngestStageJobRow } from "./repository";

/**
 * Retry classification for the staged pipeline.
 *
 * `ingest_stage_jobs.last_failure_retryable` is the authoritative signal for
 * failures recorded after migration `worldcons_ingest/0007` (1 = transient,
 * 0 = explicit terminal). Rows written before that migration keep NULL, so a
 * bounded, stage-aware code fallback is kept for legacy dead letters. Anything
 * not provably transient stays operator-only: the contract is "terminal
 * classification only for permanent errors; a transient error must stay
 * retryable".
 */

const LEGACY_RETRYABLE_CODES: Readonly<Record<IngestStage, ReadonlySet<string>>> = {
  discovery: new Set(["ingest_stage.discovery_failed"]),
  crawl: new Set([
    "crawler.transient",
    "crawler.http_429",
    "crawler.crawl_failed",
    "crawler.source_unavailable_transport",
    "crawler.source_unavailable_429",
  ]),
  normalize: new Set(["ingest_stage.normalize_retry"]),
  translate: new Set([
    "ingest_stage.translate_call_failed",
    "ingest_stage.translate_summary_write_cas_conflict",
    "ingest_stage.translate_summary_storage_transient",
    "ingest_stage.translate_failed",
  ]),
  "public-judgment": new Set(),
  publish: new Set([
    "ingest_stage.publish_call_failed",
    "ingest_stage.publish_failed",
    "e2e.staged_publication_failed",
  ]),
  search: new Set([
    "ingest_stage.search_call_failed",
    "ingest_stage.search_failed",
    "e2e.staged_search_verification_failed",
  ]),
};

const LEGACY_TRANSIENT_PATTERN = /^(?:crawler\.(?:http_5\d\d|source_unavailable_5\d\d)|ingest_stage\.[a-z-]+_(?:call_failed|retry))$/;

/**
 * True only for a dead-letter stage job whose last failure is provably
 * transient. A NULL legacy flag is recovered only for an explicitly known
 * retryable code; a terminal block (for example `crawler.official_404_unresolved`
 * or a public-judgment gate) is never auto-recovered.
 */
export function isRetryableStageDeadLetter(
  job: Pick<IngestStageJobRow, "stage" | "status" | "last_error_code" | "last_failure_retryable">,
): boolean {
  if (job.status !== "dead_letter") return false;
  if (job.last_failure_retryable === 1) return true;
  if (job.last_failure_retryable === 0) return false;
  const code = job.last_error_code ?? "";
  if (!code) return false;
  return LEGACY_RETRYABLE_CODES[job.stage]?.has(code) === true || LEGACY_TRANSIENT_PATTERN.test(code);
}

/** Exposed for tests and diagnostics; true only when the code itself is retryable. */
export function isLegacyRetryableStageCode(stage: IngestStage, code: string | null): boolean {
  if (!code) return false;
  return LEGACY_RETRYABLE_CODES[stage]?.has(code) === true || LEGACY_TRANSIENT_PATTERN.test(code);
}
