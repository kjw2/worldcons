import type {
  CaseBackfillClaimedItem,
  CaseBackfillSnapshot,
} from "@/lib/backfill/types";
import {
  discoverSpainTcInventory,
  type SpainTcInventoryResult,
} from "@/lib/crawlee/spain-tribunal-constitucional-spider";
import { assertSpainSentenciaYearEnabled } from "@/lib/backfill/spain-scope";
import type { NormalizedArticle } from "@/lib/sources/types";

export interface CaseBackfillInventoryItem {
  stableItemKey: string;
  sourceRecordId: string | null;
  discoveredUrl: string;
  documentType: string;
  decisionDateHint: string | null;
  title: string | null;
}

export interface CaseBackfillInventoryResult {
  items: CaseBackfillInventoryItem[];
  coverageEvidence: Record<string, unknown>;
}

export interface CaseBackfillDiscoveryContext {
  signal: AbortSignal;
  checkpoint: () => Promise<void>;
  environment: Record<string, string | undefined>;
}

export interface CaseBackfillSourceStrategy {
  sourceKey: string;
  assertDiscoveryScope(
    snapshot: CaseBackfillSnapshot,
    environment: Record<string, string | undefined>,
  ): void;
  discover(
    snapshot: CaseBackfillSnapshot,
    context: CaseBackfillDiscoveryContext,
  ): Promise<CaseBackfillInventoryResult>;
  validate(
    normalized: NormalizedArticle,
    item: CaseBackfillClaimedItem,
    snapshot: CaseBackfillSnapshot,
  ): string[];
}

export interface CaseBackfillSourceStrategyDependencies {
  discoverSpainTcInventory?: typeof discoverSpainTcInventory;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pathValue(source: Record<string, unknown>, path: string) {
  let value: unknown = source;
  for (const segment of path.split(".")) {
    if (!isRecord(value) || !(segment in value)) return undefined;
    value = value[segment];
  }
  return value;
}

function stringAt(value: unknown, path: string) {
  const found = isRecord(value) ? pathValue(value, path) : undefined;
  return typeof found === "string" && found.trim() ? found.trim() : null;
}

function officialSpainUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "https:"
      && (url.hostname === "tribunalconstitucional.es" || url.hostname.endsWith(".tribunalconstitucional.es"));
  } catch {
    return false;
  }
}

function validateScopeDate(
  normalized: NormalizedArticle,
  snapshot: CaseBackfillSnapshot,
  errors: string[],
) {
  const decisionDate = stringAt(normalized.metadata, "decisionDate")
    ?? normalized.originalPublishedAt?.slice(0, 10)
    ?? null;
  if (!decisionDate || !/^\d{4}-\d{2}-\d{2}$/.test(decisionDate)) errors.push("decision_date_missing");
  if (decisionDate && snapshot.scopeFrom && decisionDate < snapshot.scopeFrom) errors.push("decision_date_before_scope");
  if (decisionDate && snapshot.scopeTo && decisionDate > snapshot.scopeTo) errors.push("decision_date_after_scope");
}

function assertAnnualScope(snapshot: CaseBackfillSnapshot) {
  if (
    !snapshot.scopeFrom
    || !snapshot.scopeTo
    || snapshot.scopeFrom.slice(0, 4) !== snapshot.scopeTo.slice(0, 4)
    || snapshot.scopeFrom.slice(5) !== "01-01"
    || snapshot.scopeTo.slice(5) !== "12-31"
  ) {
    throw new Error("case_backfill.discovery_scope_not_enabled");
  }
}

function spainStrategy(
  dependencies: CaseBackfillSourceStrategyDependencies,
): CaseBackfillSourceStrategy {
  return {
    sourceKey: "es-tribunal-constitucional",
    assertDiscoveryScope(snapshot, environment) {
      assertAnnualScope(snapshot);
      if (snapshot.documentType.toUpperCase() !== "SENTENCIA") {
        throw new Error("case_backfill.discovery_scope_not_enabled");
      }
      assertSpainSentenciaYearEnabled(Number(snapshot.scopeFrom?.slice(0, 4)), environment);
    },
    async discover(snapshot, context) {
      const inventory: SpainTcInventoryResult = await (
        dependencies.discoverSpainTcInventory ?? discoverSpainTcInventory
      )({
        year: Number(snapshot.scopeFrom?.slice(0, 4)),
        documentType: "SENTENCIA",
        signal: context.signal,
        checkpoint: context.checkpoint,
      });
      return inventory;
    },
    validate(normalized, item, snapshot) {
      const errors: string[] = [];
      if (normalized.sourceKey !== snapshot.sourceKey) errors.push("source_key_mismatch");
      if (!officialSpainUrl(normalized.canonicalUrl) || !officialSpainUrl(normalized.originalUrl)) {
        errors.push("authority_url_invalid");
      }
      if (normalized.contentType !== "decision") errors.push("document_type_mismatch");
      const resolutionType = stringAt(normalized.metadata, "resolutionType")?.toUpperCase();
      if (snapshot.documentType.toUpperCase() === "SENTENCIA" && resolutionType !== "SENTENCIA") {
        errors.push("resolution_type_mismatch");
      }
      validateScopeDate(normalized, snapshot, errors);
      const hjId = item.sourceRecordId;
      if (hjId && !normalized.canonicalUrl.match(new RegExp(`/Show/${hjId}(?:$|[/?#])`, "i"))) {
        errors.push("source_record_id_mismatch");
      }
      if (!normalized.originalTitle?.trim()) errors.push("official_title_missing");
      return errors;
    },
  };
}

export function loadCaseBackfillSourceStrategy(
  sourceKey: string,
  dependencies: CaseBackfillSourceStrategyDependencies = {},
) {
  if (sourceKey === "es-tribunal-constitucional") return spainStrategy(dependencies);
  throw new Error("case_backfill.source_not_enabled");
}

export function validateCaseWithSourceStrategy(
  normalized: NormalizedArticle,
  item: CaseBackfillClaimedItem,
  snapshot: CaseBackfillSnapshot,
  dependencies: CaseBackfillSourceStrategyDependencies = {},
) {
  return loadCaseBackfillSourceStrategy(snapshot.sourceKey, dependencies).validate(normalized, item, snapshot);
}
