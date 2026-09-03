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
import {
  discoverFranceConseilInventory,
  parseFranceConseilDecisionDate,
} from "@/lib/crawlee/france-conseil-inventory";
import {
  discoverFranceDilaConstitInventory,
  type FranceDilaInventoryResult,
} from "@/lib/crawlee/france-dila-constit";
import {
  assertFranceConseilScopeEnabled,
  franceConseilDocumentType,
} from "@/lib/backfill/france-scope";
import type { CrawlerRequestGovernor } from "@/lib/crawler/types";

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
  expectedCount?: number | null;
  expectedCountBasis?: string | null;
}

export interface CaseBackfillDiscoveryContext {
  signal: AbortSignal;
  checkpoint: () => Promise<void>;
  environment: Record<string, string | undefined>;
  requestGovernor: CrawlerRequestGovernor;
}

export interface CaseBackfillSourceStrategy {
  sourceKey: string;
  defaultFetchContractVersion: string;
  defaultParserVersion: string;
  governedNetworkPhases: readonly ("discover" | "fetch")[];
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
  discoverFranceConseilInventory?: typeof discoverFranceConseilInventory;
  discoverFranceDilaConstitInventory?: typeof discoverFranceDilaConstitInventory;
  currentYear?: number;
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
  decisionDate: string | null,
  snapshot: CaseBackfillSnapshot,
  errors: string[],
) {
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
    defaultFetchContractVersion: "spain-hj-fetch-v1",
    defaultParserVersion: "spain-hj-normalize-v1",
    governedNetworkPhases: ["discover", "fetch"],
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
        requestGovernor: context.requestGovernor,
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
      const decisionDate = stringAt(normalized.metadata, "decisionDate")
        ?? normalized.originalPublishedAt?.slice(0, 10)
        ?? null;
      validateScopeDate(decisionDate, snapshot, errors);
      const hjId = item.sourceRecordId;
      if (hjId && !normalized.canonicalUrl.match(new RegExp(`/Show/${hjId}(?:$|[/?#])`, "i"))) {
        errors.push("source_record_id_mismatch");
      }
      if (!normalized.originalTitle?.trim()) errors.push("official_title_missing");
      return errors;
    },
  };
}

function officialFranceUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "https:"
      && url.hostname === "www.conseil-constitutionnel.fr"
      && /^\/decision\/\d{4}\/[^/]+\.(?:html?|htm)$/i.test(url.pathname);
  } catch {
    return false;
  }
}

function franceStrategy(
  dependencies: CaseBackfillSourceStrategyDependencies,
): CaseBackfillSourceStrategy {
  return {
    sourceKey: "fr-conseil-constitutionnel",
    defaultFetchContractVersion: "france-conseil-fetch-v1",
    defaultParserVersion: "france-conseil-normalize-v1",
    governedNetworkPhases: ["discover", "fetch"],
    assertDiscoveryScope(snapshot, environment) {
      assertAnnualScope(snapshot);
      const documentType = franceConseilDocumentType(snapshot.documentType);
      if (!documentType) throw new Error("case_backfill.discovery_scope_not_enabled");
      assertFranceConseilScopeEnabled(
        Number(snapshot.scopeFrom?.slice(0, 4)),
        documentType,
        environment,
        dependencies.currentYear,
      );
    },
    async discover(snapshot, context) {
      const documentType = franceConseilDocumentType(snapshot.documentType);
      if (!documentType) throw new Error("case_backfill.discovery_scope_not_enabled");
      const inventory: FranceDilaInventoryResult = await (
        dependencies.discoverFranceDilaConstitInventory ?? discoverFranceDilaConstitInventory
      )({
        year: Number(snapshot.scopeFrom?.slice(0, 4)),
        documentType,
        currentYear: dependencies.currentYear,
        signal: context.signal,
        checkpoint: context.checkpoint,
        requestGovernor: context.requestGovernor,
        discoverConseilInventory: dependencies.discoverFranceConseilInventory,
      });
      return inventory;
    },
    validate(normalized, item, snapshot) {
      const errors: string[] = [];
      if (normalized.sourceKey !== snapshot.sourceKey) errors.push("source_key_mismatch");
      if (!officialFranceUrl(normalized.canonicalUrl) || !officialFranceUrl(normalized.originalUrl)) {
        errors.push("authority_url_invalid");
      }
      if (normalized.contentType !== "decision") errors.push("document_type_mismatch");
      const title = normalized.originalTitle?.trim() ?? "";
      const requestedType = franceConseilDocumentType(snapshot.documentType);
      if (!requestedType || (requestedType === "QPC" ? !/\bQPC\b/i.test(title) : !/\bDC\b/i.test(title))) {
        errors.push("resolution_type_mismatch");
      }
      const decisionDate = normalized.originalPublishedAt?.slice(0, 10)
        ?? parseFranceConseilDecisionDate(title);
      validateScopeDate(decisionDate, snapshot, errors);
      const sourceRecordId = item.sourceRecordId;
      const escaped = sourceRecordId?.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if (escaped && !new RegExp(`/decision/\\d{4}/${escaped}\\.(?:html?|htm)$`, "i").test(normalized.canonicalUrl)) {
        errors.push("source_record_id_mismatch");
      }
      if (!title) errors.push("official_title_missing");
      return errors;
    },
  };
}

export function loadCaseBackfillSourceStrategy(
  sourceKey: string,
  dependencies: CaseBackfillSourceStrategyDependencies = {},
) {
  if (sourceKey === "es-tribunal-constitucional") return spainStrategy(dependencies);
  if (sourceKey === "fr-conseil-constitutionnel") return franceStrategy(dependencies);
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
