import {
  ARTICLE_RAW_BLOB_CONTRACT_VERSION,
  ARTICLE_RAW_BLOB_MAX_BYTES,
  articleRawBlobStorageRef,
  decodeArticleRawText,
} from "@/lib/article-raw/codec";
import type {
  ArticleRawExternalizationCandidate,
  ArticleRawExternalizationRepository,
} from "@/lib/article-raw/externalization";
import {
  articleRawBlobFlagErrors,
  articleRawBlobReadEnabled,
  articleRawBlobReadReady,
  articleRawBlobWriteEnabled,
  articleRawBlobWriteReady,
} from "@/lib/article-raw/flags";
import type {
  ArticleRawReadinessAggregate,
  ArticleRawReadinessAggregateRepository,
} from "@/lib/article-raw/readiness-repository";
import { sha256Hex, type ArtifactBlobStore } from "@/lib/storage/blob";

/**
 * M6D-B read-only operational readiness/observability for the article raw-text
 * private Blob lifecycle (M6A contract, M6B externalization, M6C inline clear,
 * M6D-A operator read authority).
 *
 * This module is read-only and aggregate-only. The default run calls exactly one
 * aggregate readiness RPC per selected table (`article_raw_readiness_v1`) and does
 * zero per-row and zero Blob reads: the aggregate function classifies presence,
 * metadata, ledger, and clearable counts inside the database, so service_role never
 * needs the restricted raw columns. The report exposes only counts and rollout
 * gates, never a storage ref, hash, size, contract string, source key, row id, or
 * payload, and it performs no mutation.
 *
 * Optional Blob verification is off by default. When requested, it reuses the
 * existing M6D-A operator read authority (`article_raw_operator_candidates_v1`)
 * through the externalization candidate repository, paged with the same bounded
 * `batchSize`/`maxBatches`, and selects only coherent, metadata-complete dual-copy
 * candidates (all five M6A columns present, the exact supported contract, a
 * content-addressed ref bound to the row's own source key and hash, a 64-hex hash,
 * and a bounded size). Each candidate is head/get verified for size and SHA-256,
 * decoded with the M6A codec, and required to reproduce the candidate's inline
 * `rawText`. It reports only aggregate { sampled, verified_ok, read_errors,
 * size_mismatches, hash_mismatches, invalid_documents, text_mismatches }.
 *
 * The global verification cap is bounded 0..100. To avoid starving the first table,
 * at least one candidate is attempted for every selected table with clearableRows > 0
 * when capacity permits, after which the remaining slots are filled round-robin. If
 * the cap is too small (or a clearable table has no coherent candidate) the gate
 * stays not-ready with an explicit unsampled-table blocking reason rather than
 * passing on a partial, order-dependent sample.
 *
 * Every selected table must return a usable, non-empty aggregate. A failed aggregate
 * read and an empty carrier (an all-zero aggregate, for example a source with no
 * article_content_versions_p3 rows) are both missing evidence: they are recorded in
 * `aggregateFailures` / `aggregateEmpty` and force `aggregateComplete` (and every
 * downstream readiness gate) closed with an explicit blocking reason, so a
 * `--table=all` run can never silently under-count a selected table that returned no
 * rows or reads.
 *
 * Both article raw Blob flags default to OFF. EXTERNALIZATION_READY,
 * APPLICATION_WRITE_READY, NEW_WRITE_READY (an alias of APPLICATION_WRITE_READY), and
 * INLINE_CLEAR_READY are purely derived decision gates; this module never flips a
 * flag and never clears inline raw_text. A real inline clear is rolled back only
 * through the dedicated M6E restore path (`pnpm restore:article-raw-inline`): the
 * `inlineRestore: "dedicated_restore_available"` marker records that restore exists,
 * while readiness itself stays read-only and never restores.
 */

export const ARTICLE_RAW_READINESS_TABLES = ["articles", "article_content_versions_p3"] as const;
export type ArticleRawReadinessTable = (typeof ARTICLE_RAW_READINESS_TABLES)[number];
export const ARTICLE_RAW_READINESS_MAX_BATCH_SIZE = 100;
export const ARTICLE_RAW_READINESS_MAX_BATCHES = 1000;
export const ARTICLE_RAW_READINESS_MAX_VERIFICATION_SAMPLE = 100;
export const ARTICLE_RAW_READINESS_INLINE_RESTORE = "dedicated_restore_available";

const SHA256_PATTERN = /^[0-9a-f]{64}$/;

/**
 * One aggregate readiness total for one article raw_text carrier. Every field is a
 * count (or an estimated byte total); none is a ref, hash, size, or payload.
 * `externalizedRows` is derived as dual-copy plus blob-only (which equals
 * `metadataCompleteRows`), so `ledgerCoveredRows` plus
 * `ledgerMissingOrConflictingRows` partitions the metadata-complete externalized
 * rows. `ledgerMissingOrConflictingRows` counts only metadata-complete rows missing
 * an exact ledger match; metadata-absent or metadata-inconsistent rows never count
 * as a ledger gap.
 */
export interface ArticleRawReadinessTotals {
  totalRows: number;
  inlinePresentRows: number;
  inlineMissingRows: number;
  metadataAbsentRows: number;
  metadataCompleteRows: number;
  metadataInconsistentRows: number;
  externalizedRows: number;
  dualCopyRows: number;
  blobOnlyRows: number;
  inlineOnlyRows: number;
  ledgerCoveredRows: number;
  ledgerMissingOrConflictingRows: number;
  clearableRows: number;
  inlineBytesEstimated: number;
}

export interface ArticleRawReadinessDependencies {
  repository: Pick<ArticleRawReadinessAggregateRepository, "readArticleRawReadiness">;
  candidates?: Pick<ArticleRawExternalizationRepository, "listArticleRawExternalizationCandidates"> | null;
  store?: ArtifactBlobStore | null;
  environment?: Record<string, string | undefined>;
  now?: () => Date;
}

export interface ArticleRawReadinessInput {
  tables?: readonly ArticleRawReadinessTable[];
  sourceKey?: string | null;
  batchSize: number;
  maxBatches: number;
  verificationSampleSize?: number;
}

export interface ArticleRawReadinessVerification {
  requested: boolean;
  sampleSize: number;
  candidatesConsidered: number;
  sampled: number;
  verifiedOk: number;
  readErrors: number;
  sizeMismatches: number;
  hashMismatches: number;
  invalidDocuments: number;
  textMismatches: number;
  sampledByTable: Record<ArticleRawReadinessTable, number>;
}

export interface ArticleRawReadinessGates {
  readEnabled: boolean;
  writeEnabled: boolean;
  writeWithoutRead: boolean;
  readFlagReady: boolean;
  writeFlagReady: boolean;
  flagErrors: string[];
  aggregateComplete: boolean;
  aggregateFailures: ArticleRawReadinessTable[];
  aggregateEmpty: ArticleRawReadinessTable[];
  metadataCritical: boolean;
  externalizationReady: boolean;
  applicationWriteReady: boolean;
  newWriteReady: boolean;
  verificationRequested: boolean;
  verificationReady: boolean;
  verificationTableCoverageReady: boolean;
  ledgerCoverageReady: boolean;
  inlineClearReady: boolean;
  critical: boolean;
  blocking: string[];
}

export interface ArticleRawReadinessReport {
  event: "article_raw_readiness";
  readOnly: true;
  machineReadable: true;
  observedAt: string;
  sourceKey: string | null;
  tables: ArticleRawReadinessTable[];
  contractVersion: string;
  writeFlagsDefaultOff: boolean;
  inlineRestore: typeof ARTICLE_RAW_READINESS_INLINE_RESTORE;
  articles: ArticleRawReadinessTotals;
  article_content_versions_p3: ArticleRawReadinessTotals;
  combined: ArticleRawReadinessTotals;
  verification: ArticleRawReadinessVerification;
  gates: ArticleRawReadinessGates;
  decisions: {
    externalizationReady: boolean;
    applicationWriteReady: boolean;
    newWriteReady: boolean;
    inlineClearReady: boolean;
  };
  blobObjectsDeleted: 0;
  publicCatalogWrites: 0;
  geminiCalls: 0;
  storageRefsEmitted: 0;
  perRowPayloadsEmitted: 0;
}

interface CoherentVerificationCandidate {
  table: ArticleRawReadinessTable;
  storageRef: string;
  expectedHash: string;
  expectedSize: number;
  rawText: string;
}

function nonEmptyText(value: string | null | undefined) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function boundedInteger(value: number, name: string, min: number, max: number) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`article_raw_readiness.invalid_${name}`);
  }
  return value;
}

function normalizeTables(tables?: readonly ArticleRawReadinessTable[]) {
  if (!tables || tables.length === 0) return [...ARTICLE_RAW_READINESS_TABLES];
  const seen = new Set<ArticleRawReadinessTable>();
  for (const table of tables) {
    if (!ARTICLE_RAW_READINESS_TABLES.includes(table)) throw new Error("article_raw_readiness.invalid_table");
    seen.add(table);
  }
  return ARTICLE_RAW_READINESS_TABLES.filter((table) => seen.has(table));
}

export function emptyArticleRawReadinessTotals(): ArticleRawReadinessTotals {
  return {
    totalRows: 0,
    inlinePresentRows: 0,
    inlineMissingRows: 0,
    metadataAbsentRows: 0,
    metadataCompleteRows: 0,
    metadataInconsistentRows: 0,
    externalizedRows: 0,
    dualCopyRows: 0,
    blobOnlyRows: 0,
    inlineOnlyRows: 0,
    ledgerCoveredRows: 0,
    ledgerMissingOrConflictingRows: 0,
    clearableRows: 0,
    inlineBytesEstimated: 0,
  };
}

/** Map the single aggregate RPC row into the report's count-only totals. */
export function articleRawReadinessTotalsFromAggregate(
  aggregate: ArticleRawReadinessAggregate,
): ArticleRawReadinessTotals {
  return {
    totalRows: aggregate.totalRows,
    inlinePresentRows: aggregate.inlinePresent,
    inlineMissingRows: aggregate.inlineMissing,
    metadataAbsentRows: aggregate.metadataAbsent,
    metadataCompleteRows: aggregate.metadataComplete,
    metadataInconsistentRows: aggregate.metadataInconsistent,
    externalizedRows: aggregate.dualCopy + aggregate.blobOnly,
    dualCopyRows: aggregate.dualCopy,
    blobOnlyRows: aggregate.blobOnly,
    inlineOnlyRows: aggregate.inlineOnly,
    ledgerCoveredRows: aggregate.exactLedgerCovered,
    ledgerMissingOrConflictingRows: aggregate.ledgerMissingOrConflicting,
    clearableRows: aggregate.clearableRows,
    inlineBytesEstimated: aggregate.inlineBlobBytesEstimated,
  };
}

function sumArticleRawReadinessTotals(
  articles: ArticleRawReadinessTotals,
  versions: ArticleRawReadinessTotals,
): ArticleRawReadinessTotals {
  return {
    totalRows: articles.totalRows + versions.totalRows,
    inlinePresentRows: articles.inlinePresentRows + versions.inlinePresentRows,
    inlineMissingRows: articles.inlineMissingRows + versions.inlineMissingRows,
    metadataAbsentRows: articles.metadataAbsentRows + versions.metadataAbsentRows,
    metadataCompleteRows: articles.metadataCompleteRows + versions.metadataCompleteRows,
    metadataInconsistentRows: articles.metadataInconsistentRows + versions.metadataInconsistentRows,
    externalizedRows: articles.externalizedRows + versions.externalizedRows,
    dualCopyRows: articles.dualCopyRows + versions.dualCopyRows,
    blobOnlyRows: articles.blobOnlyRows + versions.blobOnlyRows,
    inlineOnlyRows: articles.inlineOnlyRows + versions.inlineOnlyRows,
    ledgerCoveredRows: articles.ledgerCoveredRows + versions.ledgerCoveredRows,
    ledgerMissingOrConflictingRows:
      articles.ledgerMissingOrConflictingRows + versions.ledgerMissingOrConflictingRows,
    clearableRows: articles.clearableRows + versions.clearableRows,
    inlineBytesEstimated: articles.inlineBytesEstimated + versions.inlineBytesEstimated,
  };
}

/**
 * Select only coherent, metadata-complete dual-copy candidates. The M6D-A projection
 * returns inline raw_text plus the five M6A columns; anything that is not an exact,
 * content-addressed dual copy bound to the row's own source key is skipped rather
 * than verified.
 */
function coherentVerificationCandidate(
  candidate: ArticleRawExternalizationCandidate,
): CoherentVerificationCandidate | null {
  const rawText = candidate.rawText;
  if (typeof rawText !== "string") return null;
  const storageRef = nonEmptyText(candidate.rawTextStorageRef);
  const expectedHash = nonEmptyText(candidate.rawTextBlobHash);
  const contract = nonEmptyText(candidate.rawTextBlobContractVersion);
  const externalizedAt = nonEmptyText(candidate.rawTextExternalizedAt);
  const expectedSize = candidate.rawTextBlobSize;
  if (!storageRef || !expectedHash || !contract || !externalizedAt) return null;
  if (contract !== ARTICLE_RAW_BLOB_CONTRACT_VERSION) return null;
  if (!SHA256_PATTERN.test(expectedHash)) return null;
  if (typeof expectedSize !== "number" || !Number.isInteger(expectedSize)) return null;
  if (expectedSize < 0 || expectedSize > ARTICLE_RAW_BLOB_MAX_BYTES) return null;
  if (storageRef !== articleRawBlobStorageRef(candidate.sourceKey, expectedHash)) return null;
  return {
    table: candidate.articleTable,
    storageRef,
    expectedHash,
    expectedSize,
    rawText,
  };
}

function emptyVerification(requested: boolean, sampleSize: number): ArticleRawReadinessVerification {
  return {
    requested,
    sampleSize,
    candidatesConsidered: 0,
    sampled: 0,
    verifiedOk: 0,
    readErrors: 0,
    sizeMismatches: 0,
    hashMismatches: 0,
    invalidDocuments: 0,
    textMismatches: 0,
    sampledByTable: { articles: 0, article_content_versions_p3: 0 },
  };
}

/**
 * Page coherent dual-copy candidates for one table with the bounded
 * `batchSize`/`maxBatches` contract, stopping once `wanted` candidates are collected
 * or the candidate stream is exhausted. The keyset cursor advances on the row id so
 * every page is bounded and stable across reruns.
 */
async function collectCoherentCandidates(
  repository: Pick<ArticleRawExternalizationRepository, "listArticleRawExternalizationCandidates">,
  input: {
    table: ArticleRawReadinessTable;
    sourceKey: string | null;
    batchSize: number;
    maxBatches: number;
    wanted: number;
  },
): Promise<CoherentVerificationCandidate[]> {
  const collected: CoherentVerificationCandidate[] = [];
  let cursor: string | null = null;
  for (let batch = 0; batch < input.maxBatches && collected.length < input.wanted; batch += 1) {
    const candidates = await repository.listArticleRawExternalizationCandidates({
      articleTable: input.table,
      sourceKey: input.sourceKey,
      limit: input.batchSize,
      afterArticleRowId: cursor,
    });
    if (candidates.length === 0) break;
    for (const candidate of candidates) {
      const coherent = coherentVerificationCandidate(candidate);
      if (coherent) collected.push(coherent);
      if (collected.length >= input.wanted) break;
    }
    cursor = candidates[candidates.length - 1].articleRowId;
    if (candidates.length < input.batchSize) break;
  }
  return collected;
}

/**
 * Attempt each selected candidate: head size, get bytes, byteLength, SHA-256, decode,
 * then require the decoded text to reproduce the candidate's inline rawText. Every
 * outcome is counted in aggregate; only counts ever leave this function.
 */
async function runVerification(
  candidates: readonly CoherentVerificationCandidate[],
  store: ArtifactBlobStore,
  verification: ArticleRawReadinessVerification,
) {
  for (const candidate of candidates) {
    verification.sampled += 1;
    verification.sampledByTable[candidate.table] += 1;
    let headSize: number;
    try {
      headSize = (await store.head(candidate.storageRef)).size;
    } catch {
      verification.readErrors += 1;
      continue;
    }
    if (headSize !== candidate.expectedSize) {
      verification.sizeMismatches += 1;
      continue;
    }
    let bytes: Buffer;
    try {
      bytes = await store.get(candidate.storageRef);
    } catch {
      verification.readErrors += 1;
      continue;
    }
    if (bytes.byteLength !== candidate.expectedSize) {
      verification.sizeMismatches += 1;
      continue;
    }
    if (sha256Hex(bytes) !== candidate.expectedHash) {
      verification.hashMismatches += 1;
      continue;
    }
    let decoded: string;
    try {
      decoded = decodeArticleRawText(bytes);
    } catch {
      verification.invalidDocuments += 1;
      continue;
    }
    if (decoded !== candidate.rawText) {
      verification.textMismatches += 1;
      continue;
    }
    verification.verifiedOk += 1;
  }
}

async function verifyArticleRawReadinessSample(
  input: {
    tables: readonly ArticleRawReadinessTable[];
    clearableTables: readonly ArticleRawReadinessTable[];
    sourceKey: string | null;
    batchSize: number;
    maxBatches: number;
    sampleSize: number;
  },
  dependencies: {
    candidates: Pick<ArticleRawExternalizationRepository, "listArticleRawExternalizationCandidates">;
    store: ArtifactBlobStore;
  },
): Promise<ArticleRawReadinessVerification> {
  const verification = emptyVerification(true, input.sampleSize);
  const pool: Record<ArticleRawReadinessTable, CoherentVerificationCandidate[]> = {
    articles: [],
    article_content_versions_p3: [],
  };
  for (const table of input.tables) {
    pool[table] = await collectCoherentCandidates(dependencies.candidates, {
      table,
      sourceKey: input.sourceKey,
      batchSize: input.batchSize,
      maxBatches: input.maxBatches,
      wanted: input.sampleSize,
    });
    verification.candidatesConsidered += pool[table].length;
  }

  const attempts: CoherentVerificationCandidate[] = [];
  const cursor: Record<ArticleRawReadinessTable, number> = {
    articles: 0,
    article_content_versions_p3: 0,
  };
  // First pass: guarantee at least one attempt per selected clearable table so a
  // small cap can never starve a later table.
  for (const table of input.clearableTables) {
    if (attempts.length >= input.sampleSize) break;
    const candidate = pool[table][cursor[table]];
    if (candidate) {
      cursor[table] += 1;
      attempts.push(candidate);
    }
  }
  // Fill the remaining slots fairly across every selected table.
  let progressed = true;
  while (attempts.length < input.sampleSize && progressed) {
    progressed = false;
    for (const table of input.tables) {
      if (attempts.length >= input.sampleSize) break;
      const candidate = pool[table][cursor[table]];
      if (candidate) {
        cursor[table] += 1;
        attempts.push(candidate);
        progressed = true;
      }
    }
  }

  await runVerification(attempts, dependencies.store, verification);
  return verification;
}

function buildArticleRawReadinessGates(
  combined: ArticleRawReadinessTotals,
  verification: ArticleRawReadinessVerification,
  environment: Record<string, string | undefined>,
  aggregateFailures: readonly ArticleRawReadinessTable[],
  aggregateEmpty: readonly ArticleRawReadinessTable[],
  uncoveredClearableTables: readonly ArticleRawReadinessTable[],
): ArticleRawReadinessGates {
  const readEnabled = articleRawBlobReadEnabled(environment);
  const writeEnabled = articleRawBlobWriteEnabled(environment);
  const flagErrors = articleRawBlobFlagErrors(environment);
  const readFlagReady = articleRawBlobReadReady(environment);
  const writeFlagReady = articleRawBlobWriteReady(environment);

  // A selected table is only complete with a usable, non-empty aggregate. A failed
  // read and an empty carrier (all-zero aggregate, for example a source with no
  // article_content_versions_p3 rows) are both missing evidence: without this the
  // combined report silently under-counts the dropped table and still looks ready.
  const aggregateComplete = aggregateFailures.length === 0 && aggregateEmpty.length === 0;
  const metadataCritical = combined.metadataInconsistentRows > 0;

  const externalizationReady = readFlagReady && aggregateComplete && !metadataCritical;
  const applicationWriteReady = externalizationReady && writeFlagReady;

  const verificationClean = verification.requested
    && verification.sampled > 0
    && verification.readErrors === 0
    && verification.sizeMismatches === 0
    && verification.hashMismatches === 0
    && verification.invalidDocuments === 0
    && verification.textMismatches === 0;

  const verificationTableCoverageReady = uncoveredClearableTables.length === 0;
  const verificationReady = verificationClean && verificationTableCoverageReady;

  // Full ledger coverage of every metadata-complete externalized row: no complete row
  // may lack an exact ledger match. Metadata-absent/inconsistent rows never count.
  const ledgerCoverageReady = combined.ledgerMissingOrConflictingRows === 0;

  const inlineClearReady = applicationWriteReady && ledgerCoverageReady && verificationReady;
  const newWriteReady = applicationWriteReady;

  const critical = metadataCritical
    || verification.hashMismatches > 0
    || verification.sizeMismatches > 0
    || verification.invalidDocuments > 0
    || verification.textMismatches > 0;

  const blocking: string[] = [];
  if (!readEnabled) blocking.push("read_flag_disabled");
  if (!writeEnabled) blocking.push("write_flag_disabled");
  for (const error of flagErrors) blocking.push(error);
  if (aggregateFailures.length > 0) blocking.push("aggregate_read_failed");
  for (const table of aggregateEmpty) blocking.push(`aggregate_empty_${table}`);
  if (combined.metadataInconsistentRows > 0) blocking.push("metadata_inconsistent_rows");
  if (!verification.requested) blocking.push("verification_not_requested");
  else if (verification.sampled === 0) blocking.push("verification_sample_empty");
  if (verification.readErrors > 0) blocking.push("blob_read_errors");
  if (verification.sizeMismatches > 0) blocking.push("blob_size_mismatches");
  if (verification.hashMismatches > 0) blocking.push("blob_hash_mismatches");
  if (verification.invalidDocuments > 0) blocking.push("blob_invalid_documents");
  if (verification.textMismatches > 0) blocking.push("blob_text_mismatches");
  for (const table of uncoveredClearableTables) {
    blocking.push(`verification_clearable_table_unsampled_${table}`);
  }
  if (!ledgerCoverageReady) blocking.push("ledger_coverage_incomplete");

  return {
    readEnabled,
    writeEnabled,
    writeWithoutRead: writeEnabled && !readEnabled,
    readFlagReady,
    writeFlagReady,
    flagErrors,
    aggregateComplete,
    aggregateFailures: [...aggregateFailures],
    aggregateEmpty: [...aggregateEmpty],
    metadataCritical,
    externalizationReady,
    applicationWriteReady,
    newWriteReady,
    verificationRequested: verification.requested,
    verificationReady,
    verificationTableCoverageReady,
    ledgerCoverageReady,
    inlineClearReady,
    critical,
    blocking,
  };
}

export async function runArticleRawReadiness(
  input: ArticleRawReadinessInput,
  dependencies: ArticleRawReadinessDependencies,
): Promise<ArticleRawReadinessReport> {
  const tables = normalizeTables(input.tables);
  const batchSize = boundedInteger(input.batchSize, "batch_size", 1, ARTICLE_RAW_READINESS_MAX_BATCH_SIZE);
  const maxBatches = boundedInteger(input.maxBatches, "max_batches", 1, ARTICLE_RAW_READINESS_MAX_BATCHES);
  const verificationSampleSize = boundedInteger(
    input.verificationSampleSize ?? 0,
    "verification_sample_size",
    0,
    ARTICLE_RAW_READINESS_MAX_VERIFICATION_SAMPLE,
  );
  const sourceKey = input.sourceKey ?? null;
  const environment = dependencies.environment ?? process.env;
  const observedAt = (dependencies.now ?? (() => new Date()))().toISOString();

  const totalsByTable: Record<ArticleRawReadinessTable, ArticleRawReadinessTotals> = {
    articles: emptyArticleRawReadinessTotals(),
    article_content_versions_p3: emptyArticleRawReadinessTotals(),
  };
  const aggregateFailures: ArticleRawReadinessTable[] = [];

  // Default path: one aggregate RPC per selected table, no per-row and no Blob read.
  for (const table of tables) {
    try {
      const aggregate = await dependencies.repository.readArticleRawReadiness({
        articleTable: table,
        sourceKey,
      });
      totalsByTable[table] = articleRawReadinessTotalsFromAggregate(aggregate);
    } catch {
      aggregateFailures.push(table);
    }
  }

  let verification = emptyVerification(false, 0);
  if (verificationSampleSize > 0) {
    if (!dependencies.candidates) throw new Error("article_raw_readiness.candidates_required");
    if (!dependencies.store) throw new Error("article_raw_readiness.store_required");
    verification = await verifyArticleRawReadinessSample(
      {
        tables,
        clearableTables: tables.filter((table) => totalsByTable[table].clearableRows > 0),
        sourceKey,
        batchSize,
        maxBatches,
        sampleSize: verificationSampleSize,
      },
      { candidates: dependencies.candidates, store: dependencies.store },
    );
  }

  const articles = totalsByTable.articles;
  const versions = totalsByTable.article_content_versions_p3;
  const combined = sumArticleRawReadinessTotals(articles, versions);
  // A selected table whose aggregate succeeded but returned zero rows is an empty
  // carrier: it is tracked explicitly (never silently folded into the combined
  // totals as "complete") so readiness fails closed on missing evidence.
  const aggregateEmpty = tables.filter(
    (table) => !aggregateFailures.includes(table) && totalsByTable[table].totalRows === 0,
  );
  const uncoveredClearableTables = verification.requested
    ? tables.filter((table) => totalsByTable[table].clearableRows > 0 && verification.sampledByTable[table] === 0)
    : [];
  const gates = buildArticleRawReadinessGates(
    combined,
    verification,
    environment,
    aggregateFailures,
    aggregateEmpty,
    uncoveredClearableTables,
  );

  return {
    event: "article_raw_readiness",
    readOnly: true,
    machineReadable: true,
    observedAt,
    sourceKey,
    tables: [...tables],
    contractVersion: ARTICLE_RAW_BLOB_CONTRACT_VERSION,
    writeFlagsDefaultOff: !gates.readEnabled && !gates.writeEnabled,
    inlineRestore: ARTICLE_RAW_READINESS_INLINE_RESTORE,
    articles,
    article_content_versions_p3: versions,
    combined,
    verification,
    gates,
    decisions: {
      externalizationReady: gates.externalizationReady,
      applicationWriteReady: gates.applicationWriteReady,
      newWriteReady: gates.newWriteReady,
      inlineClearReady: gates.inlineClearReady,
    },
    blobObjectsDeleted: 0,
    publicCatalogWrites: 0,
    geminiCalls: 0,
    storageRefsEmitted: 0,
    perRowPayloadsEmitted: 0,
  };
}
