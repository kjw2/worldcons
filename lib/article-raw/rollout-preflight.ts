import fs from "node:fs";
import path from "node:path";
import type { ArticleRawExternalizationRepository } from "@/lib/article-raw/externalization";
import {
  articleRawBlobFlagErrors,
  articleRawBlobReadEnabled,
  articleRawBlobReadReady,
  articleRawBlobWriteEnabled,
} from "@/lib/article-raw/flags";
import type { ArticleRawReadinessAggregateRepository } from "@/lib/article-raw/readiness-repository";
import type { ArticleRawRestoreRepository } from "@/lib/article-raw/restore";

/**
 * M6F read-only article raw-text Blob rollout preflight.
 *
 * This module is the single static/env authority consulted before and after the M6A
 * through M6E migrations are applied. It is read-only and fail-closed: it performs
 * exactly three bounded reads per carrier table and never mutates anything.
 *
 *   - the M6D-A operator candidate read (limit 1) through the externalization
 *     candidate repository, for `articles` and `article_content_versions_p3`
 *   - the M6D-B aggregate readiness read through the readiness repository
 *   - the M6E restore candidate read (limit 1) through the restore repository
 *
 * Every probe goes through the existing repository authority; the module never
 * direct-queries `articles` / `article_content_versions_p3`, never calls a write
 * or attach/restore/clear RPC, never constructs a Blob store, and never reads,
 * writes, or deletes a Blob object. Any probe failure is captured as a sanitized
 * error code and turns the dependent gates off — there is no fallback path.
 *
 * The report exposes only booleans, counts, and sanitized error codes; it never
 * emits a storage ref, hash, size, source key, row id, raw payload, token, or URL.
 *
 * Env gates (all fail closed):
 *
 *   migrationSafe     both flags OFF, no flag errors, and every allowlisted
 *                     M6A..M6E migration file present on disk
 *   readEnableSafe    every DB probe/aggregate succeeded and no metadata
 *                     inconsistent rows are reported
 *   writeEnableSafe   readEnableSafe plus READ ready (the READ flag is on with no
 *                     flag errors)
 *   restoreCanarySafe every M6E restore probe succeeded and READ ready
 *   clearCanarySafe   always false with reason `runtime_readiness_sample_required`
 *                     because the M6D-B verified Blob sample and full ledger are
 *                     still required before any inline clear canary
 */

export const ARTICLE_RAW_PREFLIGHT_TABLES = ["articles", "article_content_versions_p3"] as const;
export type ArticleRawPreflightTable = (typeof ARTICLE_RAW_PREFLIGHT_TABLES)[number];

/** Candidate probes are bounded to a single row per table. */
export const ARTICLE_RAW_PREFLIGHT_PROBE_LIMIT = 1;

/** Hardcoded M6A..M6E migration allowlist; only missing names are reported. */
export const ARTICLE_RAW_PREFLIGHT_MIGRATIONS = [
  { phase: "M6A", file: "20260919130000_article_raw_blob_contract.sql" },
  { phase: "M6B", file: "20260919140000_article_raw_blob_externalization_backfill.sql" },
  { phase: "M6C", file: "20260919150000_article_raw_blob_inline_clear.sql" },
  { phase: "M6D-A", file: "20260919160000_article_raw_operator_read_authority.sql" },
  { phase: "M6D-B", file: "20260919170000_article_raw_readiness_observability.sql" },
  { phase: "M6E", file: "20260919180000_article_raw_blob_restore.sql" },
] as const;

export const ARTICLE_RAW_PREFLIGHT_CLEAR_CANARY_REASON = "runtime_readiness_sample_required";
export const ARTICLE_RAW_PREFLIGHT_PROBE_ERROR = "article_raw_rollout_preflight.probe_failed";

const ERROR_CODE_PATTERN = /^[a-z][a-z0-9._-]{0,159}$/;

/**
 * Sanitize any thrown value into a bounded error code. A recognized code-shaped
 * message is preserved; anything else (spaces, quotes, URLs, payloads) collapses to
 * the generic probe code so a raw database or transport message can never leak.
 */
export function articleRawPreflightErrorCode(error: unknown): string {
  const fromError = error instanceof Error ? error.message : null;
  const fromMessage = typeof (error as { message?: unknown } | null)?.message === "string"
    ? (error as { message: string }).message
    : null;
  const value = fromError ?? (typeof error === "string" ? error : fromMessage) ?? "";
  return ERROR_CODE_PATTERN.test(value) ? value : ARTICLE_RAW_PREFLIGHT_PROBE_ERROR;
}

export interface ArticleRawPreflightCandidateProbe {
  ok: boolean;
  count: number;
  errorCode: string | null;
}

export interface ArticleRawPreflightCandidateGroup {
  ok: boolean;
  probes: Record<ArticleRawPreflightTable, ArticleRawPreflightCandidateProbe>;
  errorCodes: string[];
}

export interface ArticleRawPreflightReadinessProbe {
  ok: boolean;
  totalRows: number;
  metadataInconsistentRows: number;
  errorCode: string | null;
}

export interface ArticleRawPreflightReadinessGroup {
  ok: boolean;
  probes: Record<ArticleRawPreflightTable, ArticleRawPreflightReadinessProbe>;
  totalRows: number;
  metadataInconsistentRows: number;
  errorCodes: string[];
}

export interface ArticleRawPreflightMigrationCheck {
  checked: number;
  present: number;
  missing: string[];
  phases: string[];
}

export interface ArticleRawPreflightGates {
  readEnabled: boolean;
  writeEnabled: boolean;
  flagErrors: string[];
  migrationFilesPresent: boolean;
  operatorProbesOk: boolean;
  readinessProbesOk: boolean;
  restoreProbesOk: boolean;
  metadataInconsistent: boolean;
  migrationSafe: boolean;
  readEnableSafe: boolean;
  writeEnableSafe: boolean;
  restoreCanarySafe: boolean;
  clearCanarySafe: false;
  clearCanaryBlockedReason: typeof ARTICLE_RAW_PREFLIGHT_CLEAR_CANARY_REASON;
}

export interface ArticleRawRolloutPreflightReport {
  event: "article_raw_rollout_preflight";
  readOnly: true;
  machineReadable: true;
  observedAt: string;
  tables: ArticleRawPreflightTable[];
  probeLimit: number;
  migrations: ArticleRawPreflightMigrationCheck;
  probes: {
    operatorCandidates: ArticleRawPreflightCandidateGroup;
    aggregateReadiness: ArticleRawPreflightReadinessGroup;
    restoreCandidates: ArticleRawPreflightCandidateGroup;
  };
  counts: {
    operatorCandidates: Record<ArticleRawPreflightTable, number>;
    restoreCandidates: Record<ArticleRawPreflightTable, number>;
    metadataInconsistentRows: number;
    totalRows: number;
  };
  gates: ArticleRawPreflightGates;
  errorCodes: string[];
  blobObjectsDeleted: 0;
  publicCatalogWrites: 0;
  geminiCalls: 0;
  storageRefsEmitted: 0;
  perRowPayloadsEmitted: 0;
}

export interface ArticleRawRolloutPreflightDependencies {
  operatorCandidates: Pick<
    ArticleRawExternalizationRepository,
    "listArticleRawExternalizationCandidates"
  >;
  aggregateReadiness: Pick<
    ArticleRawReadinessAggregateRepository,
    "readArticleRawReadiness"
  >;
  restoreCandidates: Pick<ArticleRawRestoreRepository, "listArticleRawRestoreCandidates">;
  environment?: Record<string, string | undefined>;
  now?: () => Date;
}

export interface ArticleRawRolloutPreflightInput {
  migrationRoot?: string;
}

function emptyCandidateProbe(): ArticleRawPreflightCandidateProbe {
  return { ok: false, count: 0, errorCode: null };
}

function emptyCandidateGroup(): ArticleRawPreflightCandidateGroup {
  return {
    ok: true,
    probes: {
      articles: emptyCandidateProbe(),
      article_content_versions_p3: emptyCandidateProbe(),
    },
    errorCodes: [],
  };
}

function emptyReadinessProbe(): ArticleRawPreflightReadinessProbe {
  return { ok: false, totalRows: 0, metadataInconsistentRows: 0, errorCode: null };
}

function emptyReadinessGroup(): ArticleRawPreflightReadinessGroup {
  return {
    ok: true,
    probes: {
      articles: emptyReadinessProbe(),
      article_content_versions_p3: emptyReadinessProbe(),
    },
    totalRows: 0,
    metadataInconsistentRows: 0,
    errorCodes: [],
  };
}

function candidateErrorCodes(group: ArticleRawPreflightCandidateGroup): string[] {
  return [...new Set(
    ARTICLE_RAW_PREFLIGHT_TABLES
      .map((table) => group.probes[table].errorCode)
      .filter((code): code is string => code !== null),
  )].sort();
}

function readinessErrorCodes(group: ArticleRawPreflightReadinessGroup): string[] {
  return [...new Set(
    ARTICLE_RAW_PREFLIGHT_TABLES
      .map((table) => group.probes[table].errorCode)
      .filter((code): code is string => code !== null),
  )].sort();
}

function checkMigrations(migrationRoot: string): ArticleRawPreflightMigrationCheck {
  const missing = ARTICLE_RAW_PREFLIGHT_MIGRATIONS
    .filter((migration) => !fs.existsSync(path.join(migrationRoot, migration.file)))
    .map((migration) => migration.file);
  return {
    checked: ARTICLE_RAW_PREFLIGHT_MIGRATIONS.length,
    present: ARTICLE_RAW_PREFLIGHT_MIGRATIONS.length - missing.length,
    missing,
    phases: ARTICLE_RAW_PREFLIGHT_MIGRATIONS.map((migration) => migration.phase),
  };
}

async function probeOperatorCandidates(
  repository: ArticleRawRolloutPreflightDependencies["operatorCandidates"],
): Promise<ArticleRawPreflightCandidateGroup> {
  const group = emptyCandidateGroup();
  for (const table of ARTICLE_RAW_PREFLIGHT_TABLES) {
    try {
      const candidates = await repository.listArticleRawExternalizationCandidates({
        articleTable: table,
        sourceKey: null,
        limit: ARTICLE_RAW_PREFLIGHT_PROBE_LIMIT,
        afterArticleRowId: null,
      });
      group.probes[table] = { ok: true, count: candidates.length, errorCode: null };
    } catch (error) {
      group.probes[table] = { ok: false, count: 0, errorCode: articleRawPreflightErrorCode(error) };
      group.ok = false;
    }
  }
  group.errorCodes = candidateErrorCodes(group);
  return group;
}

async function probeRestoreCandidates(
  repository: ArticleRawRolloutPreflightDependencies["restoreCandidates"],
): Promise<ArticleRawPreflightCandidateGroup> {
  const group = emptyCandidateGroup();
  for (const table of ARTICLE_RAW_PREFLIGHT_TABLES) {
    try {
      const candidates = await repository.listArticleRawRestoreCandidates({
        articleTable: table,
        sourceKey: null,
        limit: ARTICLE_RAW_PREFLIGHT_PROBE_LIMIT,
        afterArticleRowId: null,
      });
      group.probes[table] = { ok: true, count: candidates.length, errorCode: null };
    } catch (error) {
      group.probes[table] = { ok: false, count: 0, errorCode: articleRawPreflightErrorCode(error) };
      group.ok = false;
    }
  }
  group.errorCodes = candidateErrorCodes(group);
  return group;
}

async function probeAggregateReadiness(
  repository: ArticleRawRolloutPreflightDependencies["aggregateReadiness"],
): Promise<ArticleRawPreflightReadinessGroup> {
  const group = emptyReadinessGroup();
  let totalRows = 0;
  let metadataInconsistentRows = 0;
  for (const table of ARTICLE_RAW_PREFLIGHT_TABLES) {
    try {
      const aggregate = await repository.readArticleRawReadiness({
        articleTable: table,
        sourceKey: null,
      });
      group.probes[table] = {
        ok: true,
        totalRows: aggregate.totalRows,
        metadataInconsistentRows: aggregate.metadataInconsistent,
        errorCode: null,
      };
      totalRows += aggregate.totalRows;
      metadataInconsistentRows += aggregate.metadataInconsistent;
    } catch (error) {
      group.probes[table] = {
        ok: false,
        totalRows: 0,
        metadataInconsistentRows: 0,
        errorCode: articleRawPreflightErrorCode(error),
      };
      group.ok = false;
    }
  }
  group.totalRows = totalRows;
  group.metadataInconsistentRows = metadataInconsistentRows;
  group.errorCodes = readinessErrorCodes(group);
  return group;
}

export async function runArticleRawRolloutPreflight(
  input: ArticleRawRolloutPreflightInput,
  dependencies: ArticleRawRolloutPreflightDependencies,
): Promise<ArticleRawRolloutPreflightReport> {
  const environment = dependencies.environment ?? process.env;
  const observedAt = (dependencies.now ?? (() => new Date()))().toISOString();
  const migrationRoot = input.migrationRoot ?? path.join(process.cwd(), "supabase", "migrations");

  const operatorCandidates = await probeOperatorCandidates(dependencies.operatorCandidates);
  const aggregateReadiness = await probeAggregateReadiness(dependencies.aggregateReadiness);
  const restoreCandidates = await probeRestoreCandidates(dependencies.restoreCandidates);

  const migrations = checkMigrations(migrationRoot);
  const flagErrors = articleRawBlobFlagErrors(environment);
  const readEnabled = articleRawBlobReadEnabled(environment);
  const writeEnabled = articleRawBlobWriteEnabled(environment);
  const readReady = articleRawBlobReadReady(environment);

  const allProbesOk = operatorCandidates.ok && aggregateReadiness.ok && restoreCandidates.ok;
  const metadataInconsistent = aggregateReadiness.metadataInconsistentRows > 0;
  const migrationFilesPresent = migrations.missing.length === 0;

  const migrationSafe = !readEnabled
    && !writeEnabled
    && flagErrors.length === 0
    && migrationFilesPresent;
  const readEnableSafe = allProbesOk && !metadataInconsistent;
  const writeEnableSafe = readEnableSafe && readReady;
  const restoreCanarySafe = restoreCandidates.ok && readReady;

  const errorCodes = [...new Set([
    ...operatorCandidates.errorCodes,
    ...aggregateReadiness.errorCodes,
    ...restoreCandidates.errorCodes,
  ])].sort();

  return {
    event: "article_raw_rollout_preflight",
    readOnly: true,
    machineReadable: true,
    observedAt,
    tables: [...ARTICLE_RAW_PREFLIGHT_TABLES],
    probeLimit: ARTICLE_RAW_PREFLIGHT_PROBE_LIMIT,
    migrations,
    probes: {
      operatorCandidates,
      aggregateReadiness,
      restoreCandidates,
    },
    counts: {
      operatorCandidates: {
        articles: operatorCandidates.probes.articles.count,
        article_content_versions_p3: operatorCandidates.probes.article_content_versions_p3.count,
      },
      restoreCandidates: {
        articles: restoreCandidates.probes.articles.count,
        article_content_versions_p3: restoreCandidates.probes.article_content_versions_p3.count,
      },
      metadataInconsistentRows: aggregateReadiness.metadataInconsistentRows,
      totalRows: aggregateReadiness.totalRows,
    },
    gates: {
      readEnabled,
      writeEnabled,
      flagErrors,
      migrationFilesPresent,
      operatorProbesOk: operatorCandidates.ok,
      readinessProbesOk: aggregateReadiness.ok,
      restoreProbesOk: restoreCandidates.ok,
      metadataInconsistent,
      migrationSafe,
      readEnableSafe,
      writeEnableSafe,
      restoreCanarySafe,
      clearCanarySafe: false,
      clearCanaryBlockedReason: ARTICLE_RAW_PREFLIGHT_CLEAR_CANARY_REASON,
    },
    errorCodes,
    blobObjectsDeleted: 0,
    publicCatalogWrites: 0,
    geminiCalls: 0,
    storageRefsEmitted: 0,
    perRowPayloadsEmitted: 0,
  };
}
