import {
  CASE_HISTORY_BOUNDARY,
  COUNTRY_HISTORY_EXPANSION_ORDER,
  HISTORICAL_GATE_MAX_YEAR,
  INCREMENTAL_INGESTION_OWNED_FROM_YEAR,
  isHistoricalGateYear,
  type CountryHistoryStage,
  type CountryHistoryStageStatus,
} from "@/lib/backfill/country-history-policy";
import {
  CASE_CATALOG_GERMANY_HISTORY_FLAG,
  GERMANY_BVERFG_APPROVED_CANARY_YEAR,
  GERMANY_BVERFG_HISTORY_START_YEAR,
  germanyBverfgExpansionGuard,
} from "@/lib/backfill/germany-scope";
import {
  CASE_CATALOG_FRANCE_HISTORY_FLAG,
  FRANCE_CONSEIL_HISTORY_START_YEAR,
  franceConseilDocumentType,
  franceConseilHistorySourcePolicyApproved,
} from "@/lib/backfill/france-scope";
import {
  CASE_CATALOG_SPAIN_HISTORY_FLAG,
  SPAIN_SENTENCIA_BASELINE_YEAR,
  SPAIN_SENTENCIA_SUPPORTED_YEARS,
  spainSentenciaHistorySourcePolicyApproved,
} from "@/lib/backfill/spain-scope";
import { constitutionAnnotatedCorpusDescriptor } from "@/lib/backfill/us-constitution-annotated";
import { caseCatalogPublicReadsEnabled, caseCatalogWriteEnabled } from "@/lib/case-catalog/flags";

/**
 * M5 rollout readiness/orchestration.
 *
 * This module is the single machine-readable answer to three questions before
 * any historical snapshot or run is created:
 *
 * 1. which country/year/document-type tranches exist and what approves them;
 * 2. whether an exact selection is authorized by an already-existing policy;
 * 3. which approval is still missing when it is not.
 *
 * It is deliberately read-only and pure: no database, no network, no AI. The
 * guards it reads are the same M4 per-country guards that the P1 worker and the
 * CLI already enforce, so M5 does not invent a new approval path. A tranche
 * stays blocked unless an existing immutable source policy explicitly
 * authorizes that exact year and document type.
 */

export type CaseBackfillRolloutErrorCode =
  | "case_backfill.incremental_year_not_historical"
  | "case_backfill.historical_scope_missing"
  | "case_backfill.historical_year_out_of_gate5_boundary"
  | "case_backfill.germany_year_not_supported"
  | "case_backfill.germany_expansion_not_approved"
  | "case_backfill.germany_history_disabled"
  | "case_backfill.france_year_not_supported"
  | "case_backfill.france_history_disabled"
  | "case_backfill.france_history_source_policy_not_approved"
  | "case_backfill.spain_year_not_supported"
  | "case_backfill.spain_history_disabled"
  | "case_backfill.spain_history_source_blocked"
  | "case_backfill.discovery_scope_not_enabled"
  | "us_conan.candidate_graph_not_verified_corpus";

export interface CaseBackfillRolloutSelectionInput {
  sourceKey: string;
  year: number;
  documentType: string;
}

export interface CaseBackfillRolloutSelectionDependencies {
  environment?: Record<string, string | undefined>;
  currentYear?: number;
  franceHistorySourcePolicyApproved?: boolean;
  spainHistorySourcePolicyApproved?: boolean;
}

export interface CaseBackfillRolloutSelection {
  sourceKey: string;
  country: string | null;
  year: number;
  documentType: string;
  normalizedDocumentType: string | null;
  trancheOrder: number | null;
  trancheStatus: CountryHistoryStageStatus | null;
  withinHistoricalBoundary: boolean;
  policyAuthorized: boolean;
  executionEnabled: boolean;
  allowed: boolean;
  errorCode: CaseBackfillRolloutErrorCode | null;
  blocking: string[];
}

export interface CaseBackfillTrancheReadiness {
  order: number;
  country: string;
  sourceKey: string;
  documentTypes: readonly string[];
  yearFrom: number;
  yearTo: number;
  status: CountryHistoryStageStatus;
  approvedYearFrom: number | null;
  approvedYearTo: number | null;
  approvedYears: readonly number[];
  policyVersion: string | null;
  policyReviewDueAt: string | null;
  policyAuthorized: boolean;
  executionEnabled: boolean;
  blocking: readonly string[];
}

export interface CaseBackfillRolloutApprovedSelection {
  sourceKey: string;
  country: string;
  year: number;
  documentType: string;
  policyVersion: string | null;
  policyReviewDueAt: string | null;
}

export interface CaseBackfillRolloutReadiness {
  event: "case_backfill_rollout_readiness";
  rule: typeof CASE_HISTORY_BOUNDARY.rule;
  historicalMaxYear: number;
  incrementalOwnedFromYear: number;
  currentYear: number;
  observedAt: string;
  machineReadable: true;
  catalogWriteEnabled: boolean;
  publicCatalogEnabled: boolean;
  geminiCalls: 0;
  tranches: CaseBackfillTrancheReadiness[];
  approvedSelectionCount: number;
  newlyAuthorizedSelectionCount: number;
  approvedSelections: CaseBackfillRolloutApprovedSelection[];
  m5ExpansionExecutionReady: boolean;
  nextApprovalRequired: {
    trancheOrder: number;
    country: string;
    sourceKey: string;
    documentTypes: readonly string[];
    status: CountryHistoryStageStatus;
    blocking: readonly string[];
  } | null;
}

export interface CaseBackfillRolloutPreflight {
  event: "case_backfill_rollout_preflight";
  selection: CaseBackfillRolloutSelection;
  allowed: boolean;
  errorCode: CaseBackfillRolloutErrorCode | null;
  blocking: string[];
  publicCatalogWrites: 0;
  geminiCalls: 0;
}

function explicitTrue(value?: string) {
  return value?.trim().toLowerCase() === "true";
}

function normalizeDocumentType(value: string) {
  return value.trim().toUpperCase();
}

/**
 * The pre-existing Germany 2024 canary is the baseline approval, not a new M5
 * expansion. It never counts toward `newlyAuthorizedSelectionCount` and never
 * makes `m5ExpansionExecutionReady` true by itself.
 */
function isPreExistingBaselineApproval(sourceKey: string, year: number) {
  return sourceKey === "de-bverfg" && year === GERMANY_BVERFG_APPROVED_CANARY_YEAR;
}

function matchTranche(sourceKey: string, year: number, documentType: string) {
  return COUNTRY_HISTORY_EXPANSION_ORDER.find((stage) => (
    stage.sourceKey === sourceKey
    && year >= stage.yearFrom
    && year <= stage.yearTo
    && stage.documentTypes.includes(documentType)
  )) ?? null;
}

function sourceYearBounds(sourceKey: string) {
  const stages = COUNTRY_HISTORY_EXPANSION_ORDER.filter((stage) => stage.sourceKey === sourceKey);
  if (stages.length === 0) return null;
  return {
    from: Math.min(...stages.map((stage) => stage.yearFrom)),
    to: Math.max(...stages.map((stage) => stage.yearTo)),
  };
}

function selection(
  input: CaseBackfillRolloutSelectionInput,
  tranche: CountryHistoryStage | null,
  override: Partial<CaseBackfillRolloutSelection>,
): CaseBackfillRolloutSelection {
  return {
    sourceKey: input.sourceKey,
    country: tranche?.country ?? null,
    year: input.year,
    documentType: input.documentType,
    normalizedDocumentType: normalizeDocumentType(input.documentType) || null,
    trancheOrder: tranche?.order ?? null,
    trancheStatus: tranche?.status ?? null,
    withinHistoricalBoundary: isHistoricalGateYear(input.year),
    policyAuthorized: false,
    executionEnabled: false,
    allowed: false,
    errorCode: null,
    blocking: [],
    ...override,
  };
}

/**
 * Resolve the exact rollout authorization for one country/year/document-type
 * selection using only the existing per-country policy guards.
 */
export function selectCaseBackfillRollout(
  input: CaseBackfillRolloutSelectionInput,
  dependencies: CaseBackfillRolloutSelectionDependencies = {},
): CaseBackfillRolloutSelection {
  const environment = dependencies.environment ?? process.env;
  const currentYear = dependencies.currentYear ?? new Date().getUTCFullYear();
  const documentType = normalizeDocumentType(input.documentType);
  const tranche = matchTranche(input.sourceKey, input.year, documentType);

  if (!Number.isInteger(input.year)) {
    return selection(input, tranche, {
      errorCode: "case_backfill.historical_scope_missing",
      blocking: ["historical_scope_missing"],
    });
  }
  if (!isHistoricalGateYear(input.year)) {
    return selection(input, tranche, {
      errorCode: "case_backfill.incremental_year_not_historical",
      blocking: ["incremental_year_owned_by_ingest"],
    });
  }
  if (input.year > currentYear) {
    return selection(input, tranche, {
      errorCode: "case_backfill.historical_year_out_of_gate5_boundary",
      blocking: ["historical_year_in_future"],
    });
  }
  if (!tranche) {
    const bounds = sourceYearBounds(input.sourceKey);
    const yearOutOfRange = bounds !== null && (input.year < bounds.from || input.year > bounds.to);
    const unsupportedError: CaseBackfillRolloutErrorCode = input.sourceKey === "de-bverfg" && yearOutOfRange
      ? "case_backfill.germany_year_not_supported"
      : input.sourceKey === "fr-conseil-constitutionnel" && yearOutOfRange
        ? "case_backfill.france_year_not_supported"
        : input.sourceKey === "es-tribunal-constitucional" && yearOutOfRange
          ? "case_backfill.spain_year_not_supported"
          : "case_backfill.discovery_scope_not_enabled";
    return selection(input, null, {
      errorCode: unsupportedError,
      blocking: [yearOutOfRange ? "year_out_of_rollout_range" : "document_type_not_in_rollout_tranche"],
    });
  }

  if (input.sourceKey === "de-bverfg") {
    if (documentType !== "DECISION") {
      return selection(input, tranche, {
        errorCode: "case_backfill.discovery_scope_not_enabled",
        blocking: ["germany_document_type_not_supported"],
      });
    }
    if (input.year < GERMANY_BVERFG_HISTORY_START_YEAR) {
      return selection(input, tranche, {
        errorCode: "case_backfill.germany_year_not_supported",
        blocking: ["germany_year_not_supported"],
      });
    }
    const guard = germanyBverfgExpansionGuard(input.year);
    if (!guard.allowed) {
      return selection(input, tranche, {
        policyAuthorized: false,
        executionEnabled: false,
        errorCode: "case_backfill.germany_expansion_not_approved",
        blocking: ["germany_expansion_not_approved"],
      });
    }
    const flagOn = explicitTrue(environment[CASE_CATALOG_GERMANY_HISTORY_FLAG]);
    return selection(input, tranche, {
      policyAuthorized: true,
      executionEnabled: flagOn,
      allowed: flagOn,
      errorCode: flagOn ? null : "case_backfill.germany_history_disabled",
      blocking: flagOn ? [] : ["germany_history_disabled"],
    });
  }

  if (input.sourceKey === "fr-conseil-constitutionnel") {
    if (input.year < FRANCE_CONSEIL_HISTORY_START_YEAR) {
      return selection(input, tranche, {
        errorCode: "case_backfill.france_year_not_supported",
        blocking: ["france_year_not_supported"],
      });
    }
    const approved = dependencies.franceHistorySourcePolicyApproved
      ?? franceConseilHistorySourcePolicyApproved();
    const concreteType = franceConseilDocumentType(documentType);
    if (tranche.order !== 2 || !concreteType) {
      // Only the owner-approved 2010-2024 QPC/DC tranche is authorized. Every
      // other France nature (L/LP/OTHER_CONSEIL_NATURE) stays deferred to a
      // later policy version and cannot open from the env flag alone.
      return selection(input, tranche, {
        policyAuthorized: false,
        executionEnabled: false,
        errorCode: "case_backfill.france_history_source_policy_not_approved",
        blocking: ["owner_source_policy_not_approved", "deferred_after_qpc_dc"],
      });
    }
    if (!approved) {
      return selection(input, tranche, {
        policyAuthorized: false,
        executionEnabled: false,
        errorCode: "case_backfill.france_history_source_policy_not_approved",
        blocking: ["owner_source_policy_not_approved"],
      });
    }
    const flagOn = explicitTrue(environment[CASE_CATALOG_FRANCE_HISTORY_FLAG]);
    return selection(input, tranche, {
      policyAuthorized: true,
      executionEnabled: flagOn,
      allowed: flagOn,
      errorCode: flagOn ? null : "case_backfill.france_history_disabled",
      blocking: flagOn ? [] : ["france_history_disabled"],
    });
  }

  if (input.sourceKey === "es-tribunal-constitucional") {
    if (documentType !== "SENTENCIA") {
      return selection(input, tranche, {
        errorCode: "case_backfill.discovery_scope_not_enabled",
        blocking: ["spain_document_type_not_supported"],
      });
    }
    if (!(SPAIN_SENTENCIA_SUPPORTED_YEARS as readonly number[]).includes(input.year)) {
      return selection(input, tranche, {
        errorCode: "case_backfill.spain_year_not_supported",
        blocking: ["spain_year_not_supported"],
      });
    }
    const approved = dependencies.spainHistorySourcePolicyApproved
      ?? spainSentenciaHistorySourcePolicyApproved();
    if (!approved) {
      return selection(input, tranche, {
        policyAuthorized: false,
        executionEnabled: false,
        errorCode: "case_backfill.spain_history_source_blocked",
        blocking: ["spain_hj_legal_robots_policy_blocked"],
      });
    }
    const flagRequired = input.year !== SPAIN_SENTENCIA_BASELINE_YEAR;
    const flagOn = explicitTrue(environment[CASE_CATALOG_SPAIN_HISTORY_FLAG]);
    const executionEnabled = !flagRequired || flagOn;
    return selection(input, tranche, {
      policyAuthorized: true,
      executionEnabled,
      allowed: executionEnabled,
      errorCode: executionEnabled ? null : "case_backfill.spain_history_disabled",
      blocking: executionEnabled ? [] : ["spain_history_disabled"],
    });
  }

  if (input.sourceKey === "us-constitution-annotated") {
    const descriptor = constitutionAnnotatedCorpusDescriptor();
    return selection(input, tranche, {
      policyAuthorized: descriptor.verifiedCorpus,
      executionEnabled: false,
      errorCode: descriptor.verifiedCorpus ? null : "us_conan.candidate_graph_not_verified_corpus",
      blocking: descriptor.verifiedCorpus ? [] : ["candidate_graph_is_not_verified_scotus_corpus"],
    });
  }

  return selection(input, tranche, {
    errorCode: "case_backfill.discovery_scope_not_enabled",
    blocking: ["source_not_enabled"],
  });
}

function approvedYearsForTranche(
  stage: CountryHistoryStage,
  dependencies: CaseBackfillRolloutSelectionDependencies,
): number[] {
  const newest = Math.min(
    dependencies.currentYear ?? new Date().getUTCFullYear(),
    HISTORICAL_GATE_MAX_YEAR,
  );
  if (stage.sourceKey === "de-bverfg") {
    const years: number[] = [];
    for (let year = stage.yearFrom; year <= Math.min(stage.yearTo, newest); year += 1) {
      if (germanyBverfgExpansionGuard(year).allowed) years.push(year);
    }
    return years;
  }
  if (stage.approvedYearFrom === null || stage.approvedYearTo === null) return [];
  const years: number[] = [];
  const from = Math.max(stage.yearFrom, stage.approvedYearFrom);
  const to = Math.min(stage.yearTo, stage.approvedYearTo, newest);
  for (let year = from; year <= to; year += 1) years.push(year);
  return years;
}

/**
 * Machine-readable tranche readiness for the whole Gate 5 historical scope.
 * Only the already-recorded Germany 2024 private-shadow canary is approved;
 * every other tranche is pending or blocked and stays fail-closed.
 */
export function caseBackfillRolloutReadiness(
  dependencies: CaseBackfillRolloutSelectionDependencies & { now?: () => Date } = {},
): CaseBackfillRolloutReadiness {
  const environment = dependencies.environment ?? process.env;
  const currentYear = dependencies.currentYear ?? new Date().getUTCFullYear();
  const observedAt = (dependencies.now ?? (() => new Date()))().toISOString();

  const tranches: CaseBackfillTrancheReadiness[] = COUNTRY_HISTORY_EXPANSION_ORDER.map((stage) => {
    const approvedYears = approvedYearsForTranche(stage, dependencies);
    const policyAuthorized = approvedYears.length > 0;
    const flagOn = stage.sourceKey === "de-bverfg"
      ? explicitTrue(environment[CASE_CATALOG_GERMANY_HISTORY_FLAG])
      : stage.sourceKey === "fr-conseil-constitutionnel"
        ? explicitTrue(environment[CASE_CATALOG_FRANCE_HISTORY_FLAG])
        : false;
    return {
      order: stage.order,
      country: stage.country,
      sourceKey: stage.sourceKey,
      documentTypes: [...stage.documentTypes],
      yearFrom: stage.yearFrom,
      yearTo: stage.yearTo,
      status: stage.status,
      approvedYearFrom: stage.approvedYearFrom,
      approvedYearTo: stage.approvedYearTo,
      approvedYears,
      policyVersion: stage.policyVersion,
      policyReviewDueAt: stage.policyReviewDueAt,
      policyAuthorized,
      executionEnabled: policyAuthorized && flagOn,
      blocking: [...stage.blocking],
    };
  });

  const approvedSelections: CaseBackfillRolloutApprovedSelection[] = tranches.flatMap((tranche) => (
    tranche.approvedYears.flatMap((year) => tranche.documentTypes.map((documentType) => ({
      sourceKey: tranche.sourceKey,
      country: tranche.country,
      year,
      documentType,
      policyVersion: tranche.policyVersion,
      policyReviewDueAt: tranche.policyReviewDueAt,
    })))
  ));
  const newlyAuthorizedSelectionCount = approvedSelections.filter((entry) => !(
    isPreExistingBaselineApproval(entry.sourceKey, entry.year)
  )).length;

  // Recorded policy approval and actual expansion execution readiness are
  // distinct. A newly authorized, non-baseline selection counts as M5-expansion
  // execution-ready only when its tranche is also executionEnabled, i.e. the
  // exact history flag is on. A recorded France approval alone is not readiness.
  const m5ExpansionExecutionReady = tranches.some((tranche) => (
    tranche.executionEnabled
    && tranche.approvedYears.some((year) => !isPreExistingBaselineApproval(tranche.sourceKey, year))
  ));

  const nextApprovalRequired = tranches.find((tranche) => (
    !tranche.policyAuthorized && tranche.status === "pending_owner_approval"
  )) ?? tranches.find((tranche) => !tranche.policyAuthorized) ?? null;

  return {
    event: "case_backfill_rollout_readiness",
    rule: CASE_HISTORY_BOUNDARY.rule,
    historicalMaxYear: HISTORICAL_GATE_MAX_YEAR,
    incrementalOwnedFromYear: INCREMENTAL_INGESTION_OWNED_FROM_YEAR,
    currentYear,
    observedAt,
    machineReadable: true,
    catalogWriteEnabled: caseCatalogWriteEnabled(environment),
    publicCatalogEnabled: caseCatalogPublicReadsEnabled(environment),
    geminiCalls: 0,
    tranches,
    approvedSelectionCount: approvedSelections.length,
    newlyAuthorizedSelectionCount,
    approvedSelections,
    m5ExpansionExecutionReady,
    nextApprovalRequired: nextApprovalRequired
      ? {
        trancheOrder: nextApprovalRequired.order,
        country: nextApprovalRequired.country,
        sourceKey: nextApprovalRequired.sourceKey,
        documentTypes: nextApprovalRequired.documentTypes,
        status: nextApprovalRequired.status,
        blocking: nextApprovalRequired.blocking,
      }
      : null,
  };
}

export function preflightCaseBackfillRollout(
  input: CaseBackfillRolloutSelectionInput,
  dependencies: CaseBackfillRolloutSelectionDependencies = {},
): CaseBackfillRolloutPreflight {
  const resolved = selectCaseBackfillRollout(input, dependencies);
  return {
    event: "case_backfill_rollout_preflight",
    selection: resolved,
    allowed: resolved.allowed,
    errorCode: resolved.errorCode,
    blocking: resolved.blocking,
    publicCatalogWrites: 0,
    geminiCalls: 0,
  };
}

/**
 * Fail-closed gate for CLI orchestration. Call it before opening a snapshot or
 * submitting a pass so an unapproved country/year/type never creates a run.
 */
export function assertCaseBackfillRolloutPreflight(
  input: CaseBackfillRolloutSelectionInput,
  dependencies: CaseBackfillRolloutSelectionDependencies = {},
): CaseBackfillRolloutPreflight {
  const preflight = preflightCaseBackfillRollout(input, dependencies);
  if (!preflight.allowed) {
    throw new Error(preflight.errorCode ?? "case_backfill.rollout_not_authorized");
  }
  return preflight;
}
